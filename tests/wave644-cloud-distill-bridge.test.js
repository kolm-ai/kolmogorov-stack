// W644 - cloud-distill trainer bridge fallback.
//
// If Kolm-hosted fleet config is absent but an operator-managed trainer bridge
// is configured, cloud-distill should submit real work to that bridge and expose
// the bridge poll URL. The critical "no Kolm-hosted fleet" gap remains honest,
// but BYO remote trainer operators no longer get stranded in no_pool_configured.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  getCloudBackendStatus,
  getJobStatus,
  submitJob,
  _resetForTests,
} from '../src/cloud-distill.js';
import {
  getSchedulerJob,
  _resetSchedulerForTests,
} from '../src/compute-scheduler.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function freshEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w644-cloud-distill-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  process.env.KOLM_ENV = 'test';
  delete process.env.KOLM_COMPUTE_SCHEDULER_DIR;
  delete process.env.KOLM_CLOUD_DISTILL_ENDPOINT;
  delete process.env.KOLM_TRAINER_BRIDGE_URL;
  delete process.env.KOLM_TRAINER_BRIDGE_TOKEN;
  delete process.env.REM_LABS_BRIDGE_URL;
  delete process.env.REM_LABS_BRIDGE_TOKEN;
  delete process.env.PUBLIC_BASE;
  delete process.env.KOLM_PUBLIC_BASE;
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  _resetSchedulerForTests();
  _resetForTests();
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
  return tmp;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function startBridge(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _raw: raw }; }
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const response = await handler({ req, body, calls });
    res.statusCode = response.status || 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response.body || {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    try { server.close(); } catch (_) {}
  });
  const address = server.address();
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test('W644 defaults remain honest no_pool_configured when no pool or bridge exists', async (t) => {
  freshEnv(t);
  const status = getCloudBackendStatus();
  assert.equal(status.status, 'no_pool_configured');
  assert.equal(status.endpoint, null);

  const submitted = await submitJob({
    tenant: 'tenant_default',
    namespace: 'support',
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.cloud_backend_status, 'no_pool_configured');
  assert.equal(submitted.bridge_source, null);
  assert.equal(submitted.poll_url, null);
});

test('W644 configured trainer bridge requires a token before queueing work', async (t) => {
  freshEnv(t);
  process.env.KOLM_TRAINER_BRIDGE_URL = 'http://127.0.0.1:9';

  const status = getCloudBackendStatus();
  assert.equal(status.status, 'unreachable');
  assert.equal(status.bridge_source, 'remote_trainer');

  const submitted = await submitJob({
    tenant: 'tenant_missing_token',
    namespace: 'support',
  });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error, 'trainer_bridge_token_missing');
  assert.equal(submitted.cloud_backend_status, 'unreachable');
});

test('W644 cloud-distill posts jobs to a configured trainer bridge and surfaces poll metadata', async (t) => {
  freshEnv(t);
  process.env.PUBLIC_BASE = 'https://cloud.example.test';
  const bridge = await startBridge(t, async ({ req, body }) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/distill');
    assert.equal(req.headers.authorization, 'Bearer bridge-secret');
    assert.equal(body.source, 'cloud-distill');
    assert.equal(body.tenant, 'tenant_bridge');
    assert.equal(body.namespace, 'support');
    assert.match(body.cloud_distill_job_id, /^cdj_/);
    assert.match(body.scheduler_job_id, /^csj_/);
    assert.equal(body.callback_url, `https://cloud.example.test/v1/cloud/distill/${encodeURIComponent(body.cloud_distill_job_id)}`);
    assert.equal(JSON.stringify(body).includes('bridge-secret'), false);
    return {
      body: {
        ok: true,
        job_id: 'remote-123',
        status_url: 'https://trainer.example.test/jobs/remote-123',
      },
    };
  });
  process.env.KOLM_TRAINER_BRIDGE_URL = bridge.url;
  process.env.KOLM_TRAINER_BRIDGE_TOKEN = 'bridge-secret';

  const submitted = await submitJob({
    tenant: 'tenant_bridge',
    namespace: 'support',
    capture_window: '30d',
    recipe_id: 'recipe-frontier',
    idempotency_key: 'bridge-once',
    billing_token: 'billing-secret',
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.cloud_backend_status, 'reachable_via_bridge');
  assert.equal(submitted.bridge_source, 'remote_trainer');
  assert.equal(submitted.bridge_job_id, 'remote-123');
  assert.equal(submitted.poll_url, 'https://trainer.example.test/jobs/remote-123');
  assert.equal(JSON.stringify(submitted).includes('bridge-secret'), false);
  assert.equal(JSON.stringify(submitted).includes('billing-secret'), false);
  assert.equal(bridge.calls.length, 1);

  const status = getJobStatus({ tenant: 'tenant_bridge', job_id: submitted.job_id });
  assert.equal(status.ok, true);
  assert.equal(status.bridge_job_id, 'remote-123');
  assert.equal(status.poll_url, 'https://trainer.example.test/jobs/remote-123');
  assert.equal(status.cloud_backend_status, 'reachable_via_bridge');

  const scheduler = getSchedulerJob({
    tenant: 'tenant_bridge',
    job_id: submitted.scheduler_job_id,
  });
  assert.equal(scheduler.ok, true);
  assert.equal(scheduler.job.family, 'cloud-distill');
  assert.equal(scheduler.job.lane, 'managed-distill-trainer-bridge');
  assert.equal(scheduler.job.payload.cloud_backend_status, 'reachable_via_bridge');
  assert.equal(scheduler.job.lineage.cloud_distill_job_id, submitted.job_id);
  assert.equal(JSON.stringify(scheduler.job).includes('bridge-secret'), false);
  assert.equal(JSON.stringify(scheduler.job).includes('billing-secret'), false);

  const replay = await submitJob({
    tenant: 'tenant_bridge',
    namespace: 'support',
    idempotency_key: 'bridge-once',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.job_id, submitted.job_id);
  assert.equal(replay.bridge_job_id, 'remote-123');
  assert.equal(replay.poll_url, 'https://trainer.example.test/jobs/remote-123');
  assert.equal(bridge.calls.length, 1, 'idempotent replay must not resubmit to the external trainer bridge');
});

test('W644 router awaits async cloud-distill submission', () => {
  const router = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
  const marker = "r.post('/v1/cloud/distill/submit'";
  const idx = router.indexOf(marker);
  assert.ok(idx > 0, 'cloud distill submit route must exist');
  const slice = router.slice(idx, idx + 2500);
  assert.match(slice, /const env = await mod\.submitJob/);
  assert.match(slice, /idempotency-key/);
});
