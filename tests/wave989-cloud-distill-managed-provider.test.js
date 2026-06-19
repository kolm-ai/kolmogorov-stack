// W989 - cloud-distill managed provider lane.
//
// This closes the local orchestration gap between "queued honestly" and
// "operator bridge configured": cloud-distill can now submit a real async job
// to a configured managed provider endpoint, persist the provider handle, and
// keep idempotent replay from double-spending.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getCloudBackendStatus,
  getJobStatus,
  submitJob,
  MANAGED_DISTILL_PROVIDERS,
  _resetForTests,
} from '../src/cloud-distill.js';
import {
  getSchedulerJob,
  _resetSchedulerForTests,
} from '../src/compute-scheduler.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function freshEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w989-cloud-distill-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  process.env.KOLM_ENV = 'test';
  for (const key of [
    'KOLM_COMPUTE_SCHEDULER_DIR',
    'KOLM_CLOUD_DISTILL_ENDPOINT',
    'KOLM_TRAINER_BRIDGE_URL',
    'KOLM_TRAINER_BRIDGE_TOKEN',
    'REM_LABS_BRIDGE_URL',
    'REM_LABS_BRIDGE_TOKEN',
    'KOLM_MANAGED_DISTILL_PROVIDER',
    'KOLM_CLOUD_DISTILL_PROVIDER',
    'KOLM_RUNPOD_TOKEN',
    'RUNPOD_API_KEY',
    'KOLM_RUNPOD_DISTILL_ENDPOINT_ID',
    'KOLM_RUNPOD_ENDPOINT_ID',
    'RUNPOD_ENDPOINT_ID',
    'KOLM_MODAL_TOKEN',
    'MODAL_TOKEN_ID',
    'KOLM_MODAL_DISTILL_URL',
    'KOLM_TOGETHER_TOKEN',
    'TOGETHER_API_KEY',
    'PUBLIC_BASE',
    'KOLM_PUBLIC_BASE',
  ]) {
    delete process.env[key];
  }
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  _resetSchedulerForTests();
  _resetForTests();
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
}

test('W989 provider catalog is explicit and default cloud-distill state remains no_pool_configured', async (t) => {
  freshEnv(t);
  assert.deepEqual(MANAGED_DISTILL_PROVIDERS, ['runpod', 'modal', 'together']);

  const status = getCloudBackendStatus();
  assert.equal(status.status, 'no_pool_configured');
  assert.equal(status.managed_provider, undefined);

  const submitted = await submitJob({
    tenant: 'tenant_default',
    namespace: 'support',
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.cloud_backend_status, 'no_pool_configured');
  assert.equal(submitted.managed_provider, null);
  assert.equal(submitted.provider_job_id, null);
});

test('W989 configured provider fails closed when provider credentials are incomplete', async (t) => {
  freshEnv(t);
  process.env.KOLM_MANAGED_DISTILL_PROVIDER = 'runpod';

  const status = getCloudBackendStatus();
  assert.equal(status.status, 'unreachable');
  assert.equal(status.managed_provider, 'runpod');
  assert.deepEqual(status.missing_env, ['KOLM_RUNPOD_TOKEN', 'KOLM_RUNPOD_DISTILL_ENDPOINT_ID']);
  assert.equal(JSON.stringify(status).includes('secret'), false);

  const submitted = await submitJob({
    tenant: 'tenant_missing_provider',
    namespace: 'support',
  });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error, 'managed_provider_not_configured');
  assert.equal(submitted.managed_provider, 'runpod');
  assert.deepEqual(submitted.missing_env, ['KOLM_RUNPOD_TOKEN', 'KOLM_RUNPOD_DISTILL_ENDPOINT_ID']);
});

test('W989 runpod managed provider submission persists provider handle and is idempotent', async (t) => {
  freshEnv(t);
  process.env.KOLM_MANAGED_DISTILL_PROVIDER = 'runpod';
  process.env.KOLM_RUNPOD_TOKEN = 'runpod-secret';
  process.env.KOLM_RUNPOD_DISTILL_ENDPOINT_ID = 'rp-endpoint-7';
  process.env.PUBLIC_BASE = 'https://cloud.example.test';

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(url, 'https://api.runpod.ai/v2/rp-endpoint-7/run');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer runpod-secret');
    const payload = JSON.parse(init.body);
    assert.equal(payload.input.source, 'cloud-distill');
    assert.equal(payload.input.tenant, 'tenant_provider');
    assert.equal(payload.input.namespace, 'support');
    assert.equal(payload.input.recipe_id, 'recipe-frontier');
    assert.equal(payload.input.launch_spec.provider, 'runpod');
    assert.match(payload.input.launch_spec_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(payload).includes('runpod-secret'), false);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'rp-job-123', status: 'IN_QUEUE' }),
    };
  };

  const submitted = await submitJob({
    tenant: 'tenant_provider',
    namespace: 'support',
    capture_window: '30d',
    recipe_id: 'recipe-frontier',
    student: 'Qwen/Qwen3-8B',
    student_params_b: 8,
    idempotency_key: 'provider-once',
    billing_token: 'billing-secret',
    fetchImpl,
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.cloud_backend_status, 'reachable_via_provider');
  assert.equal(submitted.managed_provider, 'runpod');
  assert.equal(submitted.provider_job_id, 'rp-job-123');
  assert.equal(submitted.poll_url, 'https://api.runpod.ai/v2/rp-endpoint-7/status/rp-job-123');
  assert.match(submitted.managed_provider_launch_spec_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(submitted).includes('runpod-secret'), false);
  assert.equal(JSON.stringify(submitted).includes('billing-secret'), false);
  assert.equal(calls.length, 1);

  const status = getJobStatus({ tenant: 'tenant_provider', job_id: submitted.job_id });
  assert.equal(status.ok, true);
  assert.equal(status.managed_provider, 'runpod');
  assert.equal(status.provider_job_id, 'rp-job-123');
  assert.equal(status.poll_url, submitted.poll_url);

  const scheduler = getSchedulerJob({
    tenant: 'tenant_provider',
    job_id: submitted.scheduler_job_id,
  });
  assert.equal(scheduler.ok, true);
  assert.equal(scheduler.job.family, 'cloud-distill');
  assert.equal(scheduler.job.lane, 'managed-distill-provider-runpod');
  assert.equal(scheduler.job.payload.managed_provider, 'runpod');
  assert.equal(scheduler.job.payload.managed_provider_launch_spec_hash, submitted.managed_provider_launch_spec_hash);
  assert.equal(scheduler.job.lineage.cloud_distill_job_id, submitted.job_id);
  assert.equal(JSON.stringify(scheduler.job).includes('runpod-secret'), false);
  assert.equal(JSON.stringify(scheduler.job).includes('billing-secret'), false);

  const replay = await submitJob({
    tenant: 'tenant_provider',
    namespace: 'support',
    idempotency_key: 'provider-once',
    fetchImpl: async () => {
      throw new Error('idempotent replay must not resubmit provider job');
    },
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.job_id, submitted.job_id);
  assert.equal(replay.provider_job_id, 'rp-job-123');
  assert.equal(replay.poll_url, submitted.poll_url);
  assert.equal(calls.length, 1);
});

test('W989 router and CLI expose managed-provider submit knobs', () => {
  const router = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  const marker = "r.post('/v1/cloud/distill/submit'";
  const idx = router.indexOf(marker);
  assert.ok(idx > 0, 'cloud distill submit route must exist');
  const slice = router.slice(idx, idx + 2600);
  assert.match(slice, /managed_provider/);
  assert.match(slice, /student_params_b/);
  assert.match(slice, /corpus_url/);
  assert.match(slice, /training_file_id/);

  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  const cliIdx = cli.indexOf("if (sub === 'distill')");
  assert.ok(cliIdx > 0, 'cloud distill CLI branch must exist');
  const cliSlice = cli.slice(cliIdx, cliIdx + 5200);
  assert.match(cliSlice, /--provider runpod\|modal\|together/);
  assert.match(cliSlice, /managed_provider/);
  assert.match(cliSlice, /provider_job_id/);
  assert.match(cliSlice, /launch_spec_hash/);
});
