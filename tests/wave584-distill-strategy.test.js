// Wave 584 - distillation strategy oracle.
// Locks the behavior-selection layer above raw train/distill commands:
// no fake teacher plans, no synthetic-only production training, and explicit
// objective choice for KD, rejection sampling, preference, and on-policy paths.

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

test('W584 #1 - catalog covers no-train, supervised, KD, preference, on-policy, and serving strategies', () => {
  const catalog = distillStrategyCatalog();
  const ids = new Set(catalog.strategies.map((s) => s.id));
  for (const id of ['collect_more_real_pairs', 'rule_or_cache_first', 'small_classifier', 'lora_sft', 'kd_top_k', 'kd_softmax', 'rejection_sampling', 'preference_optimization', 'onpolicy_distill', 'speculative_decoding_train']) {
    assert.ok(ids.has(id), `missing strategy ${id}`);
  }
  assert.ok(catalog.tasks.includes('generation'));
  assert.ok(catalog.privacy_modes.includes('airgap'));
});

test('W584 #2 - generation with enough reviewed data and teacher chooses softmax KD', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teacher_agreement: 0.85,
    privacy: 'standard',
  }, { ANTHROPIC_API_KEY: 'secret' });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'kd_softmax');
  assert.match(plan.recommendation.command, /kolm distill --namespace default/);
  assert.doesNotMatch(JSON.stringify(plan), /sk-|secret-key|ANTHROPIC_API_KEY_VALUE/);
});

test('W584 #3 - synthetic-only data refuses production distillation and asks for real pairs', () => {
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

test('W584 #4 - airgap privacy blocks external teacher KD and keeps local-safe strategies feasible', () => {
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

test('W584 #5 - preference pairs beat generic SFT when enough rankings exist', () => {
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

test('W584 #6 - API exposes distill strategy planning without auth-only side effects', async (t) => {
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
  assert.equal(body.data.plan.recommendation.id, 'kd_softmax');
});

test('W584 #7 - CLI/script and package gates expose strategy verification', () => {
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
  assert.match(r.stdout, /recommendation=kd_softmax/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:distill-strategy'], /distill-strategy\.mjs/);
  assert.match(pkg.scripts['verify:depth'], /distill-strategy\.mjs/);
});
