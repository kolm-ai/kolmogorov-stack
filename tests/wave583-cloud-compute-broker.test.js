// @public-routes-only
// Wave 583 - cloud compute broker.
// Locks the "no local GPU but I still need train/distill/compile" product
// contract. The broker must recommend configured compute/storage paths without
// spending money or leaking secrets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  cloudComputeBrokerCatalog,
  planCloudCompute,
} from '../src/cloud-compute-broker.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W583 #1 - broker catalog covers local, SSH, rented GPU, managed training, customer cloud, and edge', () => {
  const catalog = cloudComputeBrokerCatalog();
  assert.equal(catalog.secret_values_included, false);
  const ids = new Set(catalog.lanes.map((lane) => lane.id));
  for (const id of ['local-cuda', 'local-cpu', 'remote-ssh', 'runpod-gpu', 'modal-gpu', 'lambda-gpu', 'together-finetune', 'aws-sagemaker', 'cloudflare-workers-r2']) {
    assert.ok(ids.has(id), `missing broker lane ${id}`);
  }
  assert.ok(catalog.workloads.includes('distill'));
  assert.ok(catalog.privacy_modes.includes('airgap'));
});

test('W583 #2 - no-local-GPU training can select configured rented GPU plus R2 storage', () => {
  const env = {
    KOLM_RUNPOD_TOKEN: 'runpod-secret',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET: 'kolm-artifacts',
  };
  const plan = planCloudCompute({
    workload: 'train',
    privacy: 'standard',
    params_b: 7,
    rows: 2000,
    no_local_gpu: true,
    dataset: 'seeds.jsonl',
    base_model: 'Qwen/Qwen2.5-7B-Instruct',
  }, env);
  assert.equal(plan.ok, true);
  assert.equal(plan.storage.cloud_ok, true);
  assert.equal(plan.recommendation.id, 'runpod-gpu');
  assert.equal(plan.recommendation.state, 'ready');
  assert.match(plan.recommendation.run_command, /kolm cloud train train-job --backend runpod/);
  assert.doesNotMatch(JSON.stringify(plan), /runpod-secret|r2-secret/);
});

test('W583 #3 - regulated work prefers user-owned SSH when available', () => {
  const env = {
    KOLM_REMOTE_SSH_HOST: 'gpu.internal',
    KOLM_REMOTE_SSH_USER: 'kolm',
    KOLM_S3_ENDPOINT: 'https://minio.internal',
    KOLM_S3_BUCKET: 'kolm-artifacts',
    KOLM_S3_ACCESS_KEY_ID: 'minio-access',
    KOLM_S3_SECRET_ACCESS_KEY: 'minio-secret',
    KOLM_RUNPOD_TOKEN: 'runpod-secret',
  };
  const plan = planCloudCompute({
    workload: 'distill',
    privacy: 'regulated',
    params_b: 13,
    rows: 5000,
    no_local_gpu: true,
  }, env);
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'remote-ssh');
  assert.equal(plan.recommendation.execution, 'self_hosted');
  assert.match(plan.recommendation.run_command, /kolm remote plan training/);
  assert.doesNotMatch(JSON.stringify(plan), /minio-secret|runpod-secret/);
});

test('W583 #4 - airgap with no local GPU refuses fake managed-cloud success', () => {
  const plan = planCloudCompute({
    workload: 'train',
    privacy: 'airgap',
    params_b: 7,
    rows: 1000,
    no_local_gpu: true,
  }, {});
  assert.equal(plan.ok, false);
  assert.notEqual(plan.recommendation.id, 'runpod-gpu');
  assert.equal(plan.ranked.find((r) => r.id === 'runpod-gpu').feasible, false);
  assert.ok(plan.ranked.find((r) => r.id === 'runpod-gpu').blockers.includes('privacy_mode_airgap_not_allowed'));
  assert.equal(plan.ranked.find((r) => r.id === 'local-cpu').run_command, null);
});

test('W583 #5 - Cloudflare edge serve plan uses deploy-plan only when storage is configured', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_TOKEN: 'cf-secret',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET: 'kolm-artifacts',
  };
  const plan = planCloudCompute({ workload: 'serve', params_b: 1, artifact: 'phi-redactor' }, env);
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'cloudflare-workers-r2');
  assert.match(plan.recommendation.run_command, /kolm cloud deploy-plan --target cloudflare-workers --artifact phi-redactor --json/);
  assert.doesNotMatch(JSON.stringify(plan), /cf-secret|r2-secret/);
});

test('W583 #6 - API exposes catalog and planning envelopes without secrets', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = await fetch(base + '/v1/cloud/broker/catalog');
  assert.equal(catalog.status, 200);
  const catalogBody = await catalog.json();
  assert.ok(catalogBody.lanes.some((lane) => lane.id === 'runpod-gpu'));
  const planned = await fetch(base + '/v1/cloud/broker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workload: 'train', params_b: 7, no_local_gpu: true }),
  });
  assert.equal(planned.status, 200);
  const body = await planned.json();
  assert.equal(body.secret_values_included, false);
  assert.ok(body.recommendation);
});

test('W583 #7 - CLI/script and package gates expose broker verification', () => {
  const r = spawnSync(process.execPath, [
    'scripts/cloud-compute-broker.mjs',
    '--simulate', 'runpod-r2',
    '--workload', 'train',
    '--params-b', '7',
    '--rows', '2000',
    '--no-local-gpu',
    '--summary',
    '--require-ready',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /recommendation=runpod-gpu/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:cloud-broker'], /cloud-compute-broker\.mjs/);
  assert.match(pkg.scripts['verify:depth'], /verify:cloud-broker|cloud-compute-broker\.mjs/);
});
