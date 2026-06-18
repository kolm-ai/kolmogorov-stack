// W584 — consolidated from .test.js + -contract.test.js by WC03 dedup pass. Pins distillStrategyCatalog + planDistillStrategy public surface.
// Wave 584 - distillation strategy oracle.
// Locks the behavior-selection layer above raw train/distill commands:
// no fake teacher plans, no synthetic-only production training, explicit
// objective choice for KD, rejection sampling, preference, and on-policy paths,
// and ensures the planner is executable from module, script, CLI, and API
// without launching training or leaking secrets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  distillStrategyCatalog,
  planDistillStrategy,
} from '../src/distill-strategy.js';
import { buildRouter } from '../src/router.js';
import { provisionAnonTenant } from '../src/auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

test('W584 #1 - catalog covers no-train, supervised, KD, preference, on-policy, and serving strategies', () => {
  const catalog = distillStrategyCatalog();
  const ids = new Set(catalog.strategies.map((s) => s.id));
  for (const id of [
    'collect_more_real_pairs',
    'rule_or_cache_first',
    'small_classifier',
    'lora_sft',
    'kd_top_k',
    'kd_softmax',
    'rejection_sampling',
    'ropd',
    'gad',
    'gkd_onpolicy',
    'distillm2',
    'moe_to_dense_distill',
    'reverse_kl_minillm',
    'cot_distill',
    'preference_optimization',
    'onpolicy_distill',
    'speculative_decoding_train',
  ]) {
    assert.ok(ids.has(id), `missing strategy ${id}`);
  }
  assert.ok(catalog.tasks.includes('generation'));
  assert.ok(catalog.tasks.includes('reasoning'));
  assert.ok(catalog.privacy_modes.includes('airgap'));
});

test('W584 #2 - catalog exposes spec id, family coverage, and teacher_required flag on KD softmax', () => {
  const catalog = distillStrategyCatalog();
  assert.equal(catalog.spec, 'kolm-distill-strategy/1');
  const families = new Set(catalog.strategies.map((s) => s.family));
  for (const family of ['data', 'no-train', 'supervised', 'distill', 'preference', 'online', 'serving', 'reasoning']) {
    assert.ok(families.has(family), `missing family ${family}`);
  }
  assert.ok(catalog.strategies.some((s) => s.id === 'kd_softmax' && s.teacher_required && s.requires_teacher_logits));
  assert.ok(catalog.strategies.some((s) => s.id === 'ropd' && s.teacher_required && !s.requires_teacher_logits));
  assert.ok(catalog.strategies.some((s) => s.id === 'gad' && s.teacher_required && !s.requires_teacher_logits));
  const moe = catalog.strategies.find((s) => s.id === 'moe_to_dense_distill');
  assert.equal(moe.execution_status, 'worker_ready_structural_collapse');
  assert.equal(moe.requires_moe, true);
  assert.ok(moe.references.some((r) => /moe-to-dense/i.test(r.name)));
});

test('W584 #3 - API-teacher generation chooses black-box GAD instead of logit KD', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teacher_agreement: 0.85,
    privacy: 'standard',
  }, { ANTHROPIC_API_KEY: 'secret' });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'gad');
  assert.match(plan.recommendation.command, /kolm distill onpolicy --gad --namespace default/);
  assert.equal(plan.ranked.find((r) => r.id === 'kd_softmax').feasible, false);
  assert.ok(plan.ranked.find((r) => r.id === 'kd_softmax').blockers.includes('teacher_logits_required'));
  assert.doesNotMatch(JSON.stringify(plan), /sk-|secret-key|ANTHROPIC_API_KEY_VALUE/);
});

test('W584 #4 - teacher-backed generation honors caller namespace and gates secret values from output', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    namespace: 'support-copilot',
    real_pairs: 1500,
    holdout_pairs: 300,
    base_model: 'Qwen/Qwen2.5-7B-Instruct',
  }, { ANTHROPIC_API_KEY: 'secret-value' });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'gad');
  assert.match(plan.recommendation.command, /kolm distill onpolicy --gad --namespace support-copilot/);
  assert.equal(plan.secret_values_included, false);
  assert.doesNotMatch(JSON.stringify(plan), /secret-value/);
});

test('W584 #5 - synthetic-only data refuses production distillation and asks for real pairs', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 0,
    synthetic_pairs: 1000,
    holdout_pairs: 200,
  }, { ANTHROPIC_API_KEY: 'secret' });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'collect_more_real_pairs');
  assert.equal(plan.ranked.find((r) => r.id === 'kd_softmax').feasible, false);
  assert.ok(plan.ranked.find((r) => r.id === 'kd_softmax').blockers.includes('synthetic_only_not_trainable'));
  assert.ok(plan.next_actions.some((a) => a.kind === 'collect'));
});

test('W584 #6 - cold-start synthetic-only workload emits null command and label-next action hint', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 0,
    synthetic_pairs: 500,
    holdout_pairs: 0,
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'collect_more_real_pairs');
  assert.equal(plan.recommendation.command, null);
  assert.ok(plan.next_actions.some((a) => /label next/.test(a.value)));
  assert.ok(plan.ranked.some((r) => r.blockers.includes('synthetic_only_not_trainable')));
});

test('W584 #7 - airgap privacy blocks external teacher KD and keeps local-safe strategies feasible', () => {
  const plan = planDistillStrategy({
    task: 'extraction',
    real_pairs: 800,
    holdout_pairs: 160,
    privacy: 'airgap',
  }, { ANTHROPIC_API_KEY: 'secret' });
  assert.equal(plan.ok, true);
  assert.notEqual(plan.recommendation.family, 'distill');
  assert.equal(plan.ranked.find((r) => r.id === 'kd_top_k').feasible, false);
  assert.ok(plan.ranked.find((r) => r.id === 'kd_top_k').blockers.includes('privacy_mode_airgap_not_allowed'));
});

test('W584 #8 - preference pairs beat generic SFT when enough rankings exist', () => {
  const plan = planDistillStrategy({
    task: 'chat',
    real_pairs: 600,
    holdout_pairs: 120,
    preference_pairs: 120,
    privacy: 'regulated',
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'preference_optimization');
  assert.match(plan.recommendation.command, /kolm distill preference/);
});

test('W584 #9 - API exposes distill strategy planning without auth-only side effects', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 1000 });
  const headers = { authorization: 'Bearer ' + tenant.api_key };
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = await fetch(base + '/v1/distill/strategy/catalog', { headers });
  assert.equal(catalog.status, 200);
  assert.ok((await catalog.json()).data.catalog.strategies.some((s) => s.id === 'rejection_sampling'));
  const planned = await fetch(base + '/v1/distill/strategy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ task: 'generation', real_pairs: 1500, holdout_pairs: 300, teachers: ['anthropic'] }),
  });
  assert.equal(planned.status, 200);
  const body = await planned.json();
  assert.equal(body.data.plan.secret_values_included, false);
  assert.equal(body.data.plan.recommendation.id, 'gad');
});

test('W584 #10 - API exposes authenticated catalog and planner envelopes with surface + readiness metadata', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer ' + tenant.api_key };

  const catalog = await fetch(base + '/v1/distill/strategy/catalog', { headers });
  assert.equal(catalog.status, 200);
  const catalogBody = await catalog.json();
  assert.equal(catalogBody.ok, true);
  assert.equal(catalogBody.surface, 'capture-data-eval-training');
  assert.ok(catalogBody.data.catalog.strategies.some((s) => s.id === 'lora_sft'));

  const planned = await fetch(base + '/v1/distill/strategy', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      task: 'extraction',
      namespace: 'claims',
      real_pairs: 600,
      holdout_pairs: 120,
      teachers: ['local'],
    }),
  });
  assert.equal(planned.status, 200);
  const planBody = await planned.json();
  assert.equal(planBody.ok, true);
  assert.equal(planBody.readiness.status, 'implemented');
  assert.ok(planBody.data.plan.recommendation);
  assert.ok(planBody.next_actions.length >= 1);
});

test('W584 #11 - CLI/script and package gates expose strategy verification', () => {
  const r = spawnSync(process.execPath, [
    'scripts/distill-strategy.mjs',
    '--simulate', 'anthropic',
    '--task', 'generation',
    '--real-pairs', '1500',
    '--holdout-pairs', '300',
    '--summary',
    '--require-ready',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /recommendation=gad/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:distill-strategy'], /distill-strategy\.mjs/);
  assert.match(pkg.scripts['verify:depth'], /npm run verify:distill-strategy/);
});

test('W584 #12 - CLI exposes direct distill strategy planning and catalog output', () => {
  const planned = spawnSync(process.execPath, [
    CLI,
    'distill',
    'strategy',
    '--simulate',
    'anthropic',
    '--task',
    'generation',
    '--real-pairs',
    '1500',
    '--holdout-pairs',
    '300',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'gad');
  assert.equal(plan.secret_values_included, false);

  const catalog = spawnSync(process.execPath, [CLI, 'distill', 'strategy', '--catalog', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(catalog.status, 0, catalog.stderr || catalog.stdout);
  const body = JSON.parse(catalog.stdout);
  assert.equal(body.spec, 'kolm-distill-strategy/1');
  assert.ok(body.strategies.some((s) => s.id === 'preference_optimization'));
});

test('W584 #13 - local teacher access keeps GKD and logit objectives selectable', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teachers: ['local:qwen'],
    teacher_local: true,
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.profile.teacher_access.has_teacher_logits, true);
  assert.equal(plan.recommendation.id, 'gkd_onpolicy');
  assert.equal(plan.ranked.find((r) => r.id === 'kd_softmax').feasible, true);
  assert.equal(plan.ranked.find((r) => r.id === 'distillm2').feasible, true);
  assert.match(plan.recommendation.command, /kolm distill onpolicy train/);
});

test('W584 #14 - reasoning workloads prefer trace distillation when captures are sufficient', () => {
  const plan = planDistillStrategy({
    task: 'reasoning',
    real_pairs: 600,
    holdout_pairs: 120,
    privacy: 'regulated',
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'cot_distill');
  assert.match(plan.recommendation.command, /reasoning-trace-loss-weight/);
});

test('W584 #15 - local MoE teacher routes to the MoE-to-dense worker-ready strategy', () => {
  const plan = planDistillStrategy({
    task: 'reasoning',
    namespace: 'moe-laptop',
    real_pairs: 2000,
    holdout_pairs: 400,
    teachers: ['local:Qwen/Qwen3-30B-A3B-MoE'],
    teacher_local: true,
    teacher_model: 'Qwen/Qwen3-30B-A3B-MoE',
    base_model: 'Qwen/Qwen3-8B',
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.profile.moe.teacher_is_moe, true);
  assert.equal(plan.profile.moe.teacher_family, 'qwen3-moe-a3b');
  assert.equal(plan.recommendation.id, 'moe_to_dense_distill');
  assert.equal(plan.recommendation.execution_status, 'worker_ready_structural_collapse');
  assert.match(plan.recommendation.command, /kolm distill moe-to-dense/);
  assert.match(plan.recommendation.command, /--checkpoint <moe-checkpoint>/);
  assert.doesNotMatch(plan.recommendation.command, /--plan-only/);
});

test('W584 #16 - text-only MoE signal does not bypass the local-logit requirement', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 2000,
    holdout_pairs: 400,
    teachers: ['openrouter:qwen3-moe'],
    teacher_model: 'Qwen/Qwen3-30B-A3B-MoE',
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'gad');
  const row = plan.ranked.find((r) => r.id === 'moe_to_dense_distill');
  assert.equal(row.feasible, false);
  assert.ok(row.blockers.includes('teacher_logits_required'));
});

test('W584 #17 - strategy script accepts MoE flags and emits the MoE-to-dense plan', () => {
  const r = spawnSync(process.execPath, [
    'scripts/distill-strategy.mjs',
    '--simulate', 'local',
    '--task', 'reasoning',
    '--teacher-is-moe',
    '--teacher-model', 'Qwen/Qwen3-30B-A3B-MoE',
    '--real-pairs', '2000',
    '--holdout-pairs', '400',
    '--summary',
    '--require-ready',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /recommendation=moe_to_dense_distill/);
  assert.match(r.stdout, /moe-to-dense/);
});
