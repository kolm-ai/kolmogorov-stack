import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { buildStrategyCatalog, planBuildStrategy } from '../src/build-strategy-brain.js';
import { buildRouter } from '../src/router.js';
import { provisionAnonTenant } from '../src/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PACKAGE = path.join(ROOT, 'package.json');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

const READY_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  KOLM_RUNPOD_TOKEN: 'rp_test',
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'r2_access',
  R2_SECRET_ACCESS_KEY: 'r2_secret',
  R2_BUCKET: 'kolm-artifacts'
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cli(args = []) {
  return JSON.parse(execFileSync(process.execPath, ['scripts/build-strategy-brain.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  }));
}

function kolmCliJson(args = [], env = {}) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, KOLM_NO_INTERACTIVE: '1' },
    encoding: 'utf8'
  }));
}

function kolmCliText(args = [], env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, KOLM_NO_INTERACTIVE: '1' },
    encoding: 'utf8'
  });
}

test('W597 #1 - catalog exposes the shared CLI/API/account/TUI contract', () => {
  const catalog = buildStrategyCatalog();
  assert.equal(catalog.spec, 'kolm-build-strategy-brain/1');
  assert.match(catalog.surfaces.cli, /kolm build plan/);
  assert.match(catalog.surfaces.api, /\/v1\/build\/strategy/);
  assert.match(catalog.surfaces.account, /\/account\/builds/);
  assert.match(catalog.surfaces.tui, /builds/);
  assert.ok(catalog.action_families.includes('training'));
  assert.ok(catalog.action_families.includes('compute'));
  assert.ok(catalog.action_families.includes('quantization'));
});

test('W597 #2 - low-data workload is stopped before fake training', () => {
  const plan = planBuildStrategy({
    task: 'generation',
    namespace: 'thin-demo',
    real_pairs: 8,
    holdout_pairs: 1,
    synthetic_pairs: 30,
    privacy: 'standard'
  }, READY_ENV);
  assert.equal(plan.spec, 'kolm-build-strategy-brain/1');
  assert.equal(plan.secret_values_included, false);
  assert.equal(plan.evidence_chain.data_sufficiency.train_ready, false);
  assert.ok(['collect_more_real_pairs', 'do_not_train_yet', 'prompt_rag_rule_cache_first'].includes(plan.recommendation.id));
  assert.ok(plan.ranked.some((row) => row.id === 'distill_or_train' && row.blockers.includes('data_not_train_ready')));
  assert.ok(plan.next_actions.some((row) => /label next/.test(row.value || '')));
});

test('W597 #3 - no-local-GPU train request gets a cloud compute path without secrets', () => {
  const plan = planBuildStrategy({
    task: 'generation',
    namespace: 'support-agent',
    real_pairs: 1500,
    holdout_pairs: 300,
    privacy: 'standard',
    no_local_gpu: true,
    params_b: 7,
    context_tokens: 8192
  }, READY_ENV);
  const cloud = plan.component_plans.cloud.recommendation;
  assert.equal(plan.secret_values_included, false);
  assert.equal(plan.component_plans.cloud.storage.secret_values_included, false);
  assert.equal(cloud.id, 'runpod-gpu');
  assert.equal(cloud.state, 'ready');
  assert.ok(plan.ranked.some((row) => row.id === 'cloud_compute_plan' && row.feasible));
  assert.ok(plan.next_actions.some((row) => /kolm cloud train/.test(row.value || '')));
  assert.ok(!JSON.stringify(plan).includes('sk-ant-test'));
  assert.ok(!JSON.stringify(plan).includes('r2_secret'));
});

test('W597 #4 - airgap policy blocks provider routing but keeps local/collect/compile options', () => {
  const plan = planBuildStrategy({
    task: 'redaction',
    namespace: 'airgap-redactor',
    real_pairs: 120,
    holdout_pairs: 30,
    privacy: 'airgap',
    existing_artifact: true,
    device: 'cpu-16gb',
    runtime: 'gguf'
  }, READY_ENV);
  const providerRoute = plan.ranked.find((row) => row.id === 'provider_route_fallback');
  assert.equal(providerRoute.feasible, false);
  assert.ok(providerRoute.blockers.includes('airgap_blocks_external_provider_route'));
  assert.ok(plan.ranked.some((row) => row.id === 'compile_signed_artifact' && row.feasible));
  assert.ok(plan.ranked.some((row) => row.id === 'run_existing_artifact_locally' && row.feasible));
});

test('W597 #5 - quantization plan is included for runtime/device fit', () => {
  const plan = planBuildStrategy({
    task: 'extraction',
    namespace: 'claims-extractor',
    real_pairs: 900,
    holdout_pairs: 200,
    calibration_rows: 256,
    privacy: 'standard',
    existing_artifact: true,
    device: 'rtx-4090-24gb',
    runtime: 'cuda',
    params_b: 7,
    target_latency_ms: 80
  }, READY_ENV);
  assert.ok(plan.component_plans.quantization.recommendation.primary.method);
  assert.equal(plan.evidence_chain.quantization_method, plan.component_plans.quantization.recommendation.primary.method);
  assert.ok(plan.ranked.some((row) => row.id === 'quantize_runtime_target' && row.feasible));
  assert.ok(plan.evidence_chain.proof_requirements.includes('artifact_signature'));
});

test('W597 #6 - script emits JSON plan and package scripts lock in the gate', () => {
  const out = cli(['--task', 'extraction', '--rows', '600', '--holdout-pairs', '150', '--existing-artifact']);
  assert.equal(out.spec, 'kolm-build-strategy-brain/1');
  assert.ok(out.recommendation.id);
  assert.equal(out.secret_values_included, false);

  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:build-strategy'], /build-strategy-brain\.mjs --catalog/);
  assert.match(pkg.scripts['verify:build-strategy'], /wave597-build-strategy-brain\.test\.js/);
  assert.match(pkg.scripts['verify:depth'], /verify:build-strategy/);
});

test('W597 #7 - authenticated API exposes build strategy catalog and planner envelopes', async (t) => {
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

  const catalog = await fetch(base + '/v1/build/strategy/catalog', { headers });
  assert.equal(catalog.status, 200);
  const catalogBody = await catalog.json();
  assert.equal(catalogBody.ok, true);
  assert.equal(catalogBody.surface, 'capture-data-eval-training');
  assert.equal(catalogBody.data.catalog.spec, 'kolm-build-strategy-brain/1');

  const planned = await fetch(base + '/v1/build/strategy', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      task: 'extraction',
      namespace: 'claims',
      real_pairs: 600,
      holdout_pairs: 120,
      existing_artifact: true,
      privacy: 'standard'
    }),
  });
  assert.equal(planned.status, 200);
  const planBody = await planned.json();
  assert.equal(planBody.ok, true);
  assert.equal(planBody.readiness.status, 'implemented');
  assert.equal(planBody.data.plan.spec, 'kolm-build-strategy-brain/1');
  assert.ok(planBody.data.plan.recommendation);
  assert.equal(planBody.data.plan.secret_values_included, false);
  assert.ok(planBody.next_actions.length >= 1);
});

test('W597 #8 - real CLI build plan delegates to the shared strategy brain', () => {
  const out = kolmCliJson([
    'build', 'plan',
    '--task', 'generation',
    '--rows', '1500',
    '--holdout-pairs', '300',
    '--no-local-gpu',
    '--params-b', '7',
    '--context-tokens', '8192',
    '--json',
  ], READY_ENV);
  assert.equal(out.spec, 'kolm-build-strategy-brain/1');
  assert.equal(out.secret_values_included, false);
  assert.equal(out.component_plans.cloud.recommendation.id, 'runpod-gpu');
  assert.ok(out.next_actions.some((row) => /kolm cloud train/.test(row.value || '')));
  assert.ok(!JSON.stringify(out).includes('sk-ant-test'));
  assert.ok(!JSON.stringify(out).includes('r2_secret'));
});

test('W597 #9 - CLI build plan text is honest and does not print undefined fields', () => {
  const text = kolmCliText([
    'build', 'plan',
    '--task', 'extraction',
    '--rows', '600',
    '--holdout-pairs', '120',
    '--summary',
  ], {});
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /build plan: \w+ \(actionable\)/);
  assert.match(text, /providers=none compute=local-cuda:needs_configuration quant=\w+/);

  const help = kolmCliText(['build', 'plan', '--help']);
  assert.match(help, /zero_retention/);
  assert.doesNotMatch(help, /byoc/);
});
