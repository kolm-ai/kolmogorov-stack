// Wave 584: distillation strategy planner must be executable from module,
// script, and authenticated API without launching training or leaking secrets.

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

test('W584 #1 - strategy catalog covers data, no-train, supervised, distill, preference, online, and serving families', () => {
  const catalog = distillStrategyCatalog();
  assert.equal(catalog.spec, 'kolm-distill-strategy/1');
  const families = new Set(catalog.strategies.map((s) => s.family));
  for (const family of ['data', 'no-train', 'supervised', 'distill', 'preference', 'online', 'serving']) {
    assert.ok(families.has(family), `missing family ${family}`);
  }
  assert.ok(catalog.strategies.some((s) => s.id === 'kd_softmax' && s.teacher_required));
});

test('W584 #2 - cold-start synthetic-only workload refuses fake train readiness and asks for real pairs', () => {
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

test('W584 #3 - teacher-backed generation workload chooses executable distill path', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    namespace: 'support-copilot',
    real_pairs: 1500,
    holdout_pairs: 300,
    base_model: 'Qwen/Qwen2.5-7B-Instruct',
  }, { ANTHROPIC_API_KEY: 'secret-value' });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'kd_softmax');
  assert.match(plan.recommendation.command, /kolm distill --namespace support-copilot/);
  assert.equal(plan.secret_values_included, false);
  assert.doesNotMatch(JSON.stringify(plan), /secret-value/);
});

test('W584 #4 - API exposes authenticated catalog and planner envelopes', async (t) => {
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

test('W584 #5 - script and package gates expose distill strategy verification', () => {
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

test('W584 #6 - CLI exposes direct distill strategy planning and catalog output', () => {
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
  assert.equal(plan.recommendation.id, 'kd_softmax');
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
