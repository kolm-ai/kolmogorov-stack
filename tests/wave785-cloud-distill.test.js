// W785 - Managed-distill cloud expansion.
//
// Atomic items pinned (matches the W785 implementation):
//
//   1)  CLOUD_DISTILL_VERSION matches /^w785-/ + CLOUD_DISTILL_STATES frozen
//   2)  CLOUD_METER_RATES exports numeric training_per_gpu_hour_usd map
//   3)  submitJob returns {ok, job_id, state:'queued', cloud_backend_status, meter_initial}
//   4)  submitJob honesty contract: cloud_backend_status='no_pool_configured' when env unset
//   5)  submitJob honesty contract: cloud_backend_status='simulated' when endpoint=simulated://
//   6)  submitJob rejects unknown gpu_sku + unknown vram_tier
//   7)  getJobStatus tenant fence (foreign tenant returns not_found, never reveals)
//   8)  cancelJob transitions queued -> cancelled; invalid_transition on terminal
//   9)  listJobs empty case + tenant fence
//   10) listJobs status filter + invalid_status_filter envelope
//   11) meterRun computes cost = (gpu_seconds/3600) * rate; writes ledger='training'
//   12) meterRun rejects invalid_gpu_seconds + not_found
//   13) readMeter sums per-job rows; tenant-fenced
//   14) advanceJobState test seam transitions queued -> running -> succeeded
//   15) HTTP routes auth-gated (401 without auth) - all 5 routes
//   16) HTTP E2E: submit -> status -> list -> cancel via real router
//   17) Router file wires 5 routes + version stamps match /^w785-/
//
// W604 anti-brittleness: version regex /^w785-/, never literal equality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cloudDistill from '../src/cloud-distill.js';
import * as auth from '../src/auth.js';
import * as kolmStore from '../src/store.js';
import * as eventStore from '../src/event-store.js';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w785-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  // Always wipe the W785 ledgers before each test (they're append-only).
  if (cloudDistill._resetForTests) cloudDistill._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  if (eventStore._resetForTests) eventStore._resetForTests();
  // Clear the honesty env so test 4 sees no_pool_configured by default.
  delete process.env.KOLM_CLOUD_DISTILL_ENDPOINT;
  return tmp;
}

async function buildApp() {
  const tmpdir = freshDir();
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

// =============================================================================
// 1) Version + state set frozen
// =============================================================================

test('W785 #1 - CLOUD_DISTILL_VERSION matches /^w785-/ + CLOUD_DISTILL_STATES frozen', () => {
  assert.match(cloudDistill.CLOUD_DISTILL_VERSION, /^w785-/);
  assert.ok(Object.isFrozen(cloudDistill.CLOUD_DISTILL_STATES));
  assert.deepEqual(Array.from(cloudDistill.CLOUD_DISTILL_STATES),
    ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
  assert.ok(Object.isFrozen(cloudDistill.CLOUD_BACKEND_STATUSES));
  assert.equal(typeof cloudDistill.submitJob, 'function');
  assert.equal(typeof cloudDistill.getJobStatus, 'function');
  assert.equal(typeof cloudDistill.cancelJob, 'function');
  assert.equal(typeof cloudDistill.listJobs, 'function');
  assert.equal(typeof cloudDistill.meterRun, 'function');
  assert.equal(typeof cloudDistill.readMeter, 'function');
  assert.equal(typeof cloudDistill.advanceJobState, 'function');
});

// =============================================================================
// 2) CLOUD_METER_RATES is a numeric map (training-meter separation)
// =============================================================================

test('W785 #2 - CLOUD_METER_RATES exports numeric training_per_gpu_hour_usd map', () => {
  const rates = cloudDistill.CLOUD_METER_RATES;
  assert.ok(rates && typeof rates === 'object', 'CLOUD_METER_RATES must be exported');
  assert.ok(Object.isFrozen(rates), 'CLOUD_METER_RATES must be frozen');
  assert.ok(rates.training_per_gpu_hour_usd, 'must expose training_per_gpu_hour_usd');
  assert.ok(Object.isFrozen(rates.training_per_gpu_hour_usd));
  // Every value in the rate map must be a positive finite number.
  for (const [sku, price] of Object.entries(rates.training_per_gpu_hour_usd)) {
    assert.equal(typeof price, 'number', `${sku} price must be a number`);
    assert.ok(Number.isFinite(price) && price > 0, `${sku} price must be > 0 (got ${price})`);
  }
  // Spec calls out the SEPARATE inference meter; ensure it is documented as separate.
  assert.equal(rates.unit_training, 'gpu_hour');
  assert.equal(rates.unit_inference, '1k_tokens');
  // VRAM multipliers are also numeric.
  for (const [tier, mult] of Object.entries(rates.vram_tier_multiplier)) {
    assert.equal(typeof mult, 'number', `${tier} multiplier must be a number`);
    assert.ok(mult >= 1, `${tier} multiplier must be >= 1 (got ${mult})`);
  }
});

// =============================================================================
// 3) submitJob shape
// =============================================================================

test('W785 #3 - submitJob returns {ok, job_id, state:queued, cloud_backend_status, meter_initial}', () => {
  freshDir();
  const out = cloudDistill.submitJob({
    tenant: 'tenant_w785_3',
    namespace: 'support',
    capture_window: '7d',
    recipe_id: 'support-distill-v1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'queued');
  assert.ok(out.job_id && typeof out.job_id === 'string', 'job_id must be a non-empty string');
  assert.match(out.job_id, /^cdj_/, 'job_id must use cdj_ prefix');
  assert.equal(typeof out.cloud_backend_status, 'string');
  assert.ok(out.meter_initial, 'meter_initial reservation row must be returned');
  assert.equal(out.meter_initial.kind, 'training_reservation');
  assert.equal(out.meter_initial.cost_usd, 0);
  assert.match(out.version, /^w785-/);
});

// =============================================================================
// 4) Honesty contract - no pool configured
// =============================================================================

test('W785 #4 - submitJob returns cloud_backend_status=no_pool_configured when env unset', () => {
  freshDir();
  delete process.env.KOLM_CLOUD_DISTILL_ENDPOINT;
  const out = cloudDistill.submitJob({
    tenant: 'tenant_w785_4', namespace: 'ns',
  });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'queued');
  assert.equal(out.cloud_backend_status, 'no_pool_configured',
    'when no backend env, status must be no_pool_configured (NEVER simulate a real run)');
  assert.equal(out.cloud_backend_endpoint, null);

  // Even on getJobStatus the honesty contract holds.
  const st = cloudDistill.getJobStatus({ tenant: 'tenant_w785_4', job_id: out.job_id });
  assert.equal(st.ok, true);
  assert.equal(st.state, 'queued');
  assert.equal(st.cloud_backend_status, 'no_pool_configured');
});

// =============================================================================
// 5) Honesty - simulated endpoint
// =============================================================================

test('W785 #5 - submitJob returns cloud_backend_status=simulated for simulated:// endpoint', () => {
  freshDir();
  process.env.KOLM_CLOUD_DISTILL_ENDPOINT = 'simulated://localhost';
  try {
    const out = cloudDistill.submitJob({ tenant: 'tenant_w785_5', namespace: 'n' });
    assert.equal(out.ok, true);
    assert.equal(out.cloud_backend_status, 'simulated');
    assert.equal(out.cloud_backend_endpoint, 'simulated://localhost');
  } finally {
    delete process.env.KOLM_CLOUD_DISTILL_ENDPOINT;
  }
});

// =============================================================================
// 6) Validation - unknown SKU + unknown VRAM tier
// =============================================================================

test('W785 #6 - submitJob rejects unknown gpu_sku + unknown vram_tier', () => {
  freshDir();
  let out = cloudDistill.submitJob({
    tenant: 't', namespace: 'n', gpu_sku: 'BANANA-12GB',
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unknown_gpu_sku');
  assert.ok(Array.isArray(out.supported) && out.supported.length > 0);

  out = cloudDistill.submitJob({
    tenant: 't', namespace: 'n', gpu_sku: 'H100-80GB', vram_tier: '99x',
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unknown_vram_tier');

  // Missing tenant -> tenant_required
  out = cloudDistill.submitJob({ namespace: 'n' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tenant_required');
});

// =============================================================================
// 7) Tenant fence (W411 defense-in-depth)
// =============================================================================

test('W785 #7 - getJobStatus tenant fence: foreign tenant returns not_found (never reveals)', () => {
  freshDir();
  const A = cloudDistill.submitJob({ tenant: 'tenant_w785_7_A', namespace: 'ns' });
  // Foreign tenant lookup must NOT reveal the job exists - must return not_found,
  // not "wrong tenant" or a partial row.
  const peek = cloudDistill.getJobStatus({
    tenant: 'tenant_w785_7_B',  // wrong tenant
    job_id: A.job_id,
  });
  assert.equal(peek.ok, false, 'foreign tenant must be denied');
  assert.equal(peek.error, 'not_found',
    'foreign tenant lookup must return not_found (not a leak like wrong_tenant)');

  // Correct tenant can read.
  const own = cloudDistill.getJobStatus({
    tenant: 'tenant_w785_7_A',
    job_id: A.job_id,
  });
  assert.equal(own.ok, true);
  assert.equal(own.job_id, A.job_id);
});

// =============================================================================
// 8) Cancellation lifecycle
// =============================================================================

test('W785 #8 - cancelJob queued -> cancelled; invalid_transition on terminal', () => {
  freshDir();
  const j = cloudDistill.submitJob({ tenant: 't_w785_8', namespace: 'n' });
  const c1 = cloudDistill.cancelJob({ tenant: 't_w785_8', job_id: j.job_id, reason: 'duplicate' });
  assert.equal(c1.ok, true);
  assert.equal(c1.state, 'cancelled');

  const st = cloudDistill.getJobStatus({ tenant: 't_w785_8', job_id: j.job_id });
  assert.equal(st.state, 'cancelled');

  // Double-cancel is invalid_transition.
  const c2 = cloudDistill.cancelJob({ tenant: 't_w785_8', job_id: j.job_id });
  assert.equal(c2.ok, false);
  assert.equal(c2.error, 'invalid_transition');
  assert.equal(c2.current_state, 'cancelled');

  // Unknown job -> not_found.
  const nf = cloudDistill.cancelJob({ tenant: 't_w785_8', job_id: 'cdj_nope' });
  assert.equal(nf.ok, false);
  assert.equal(nf.error, 'not_found');
});

// =============================================================================
// 9) listJobs - empty + tenant fence
// =============================================================================

test('W785 #9 - listJobs empty case + tenant fence', () => {
  freshDir();
  // Empty tenant returns ok:true count:0.
  const empty = cloudDistill.listJobs({ tenant: 'tenant_w785_9_empty' });
  assert.equal(empty.ok, true);
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.jobs, []);

  // Submit two for A, one for B.
  cloudDistill.submitJob({ tenant: 't_w785_9_A', namespace: 'n1' });
  cloudDistill.submitJob({ tenant: 't_w785_9_A', namespace: 'n2' });
  cloudDistill.submitJob({ tenant: 't_w785_9_B', namespace: 'n3' });

  const A = cloudDistill.listJobs({ tenant: 't_w785_9_A' });
  assert.equal(A.count, 2);
  for (const j of A.jobs) {
    assert.equal(j.tenant_id, 't_w785_9_A', 'foreign tenant_id leaked into list');
  }

  const B = cloudDistill.listJobs({ tenant: 't_w785_9_B' });
  assert.equal(B.count, 1);
  assert.equal(B.jobs[0].namespace, 'n3');
});

// =============================================================================
// 10) Status filter + bad filter envelope
// =============================================================================

test('W785 #10 - listJobs status filter narrows + invalid_status_filter envelope', () => {
  freshDir();
  const j1 = cloudDistill.submitJob({ tenant: 't_w785_10', namespace: 'n' });
  const j2 = cloudDistill.submitJob({ tenant: 't_w785_10', namespace: 'n' });
  cloudDistill.cancelJob({ tenant: 't_w785_10', job_id: j1.job_id });

  const queued = cloudDistill.listJobs({ tenant: 't_w785_10', status: 'queued' });
  assert.equal(queued.count, 1);
  assert.equal(queued.jobs[0].job_id, j2.job_id);

  const cancelled = cloudDistill.listJobs({ tenant: 't_w785_10', status: 'cancelled' });
  assert.equal(cancelled.count, 1);
  assert.equal(cancelled.jobs[0].job_id, j1.job_id);

  // Bogus status filter -> honest envelope.
  const bad = cloudDistill.listJobs({ tenant: 't_w785_10', status: 'banana' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_status_filter');
  assert.deepEqual(Array.from(bad.supported),
    ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
});

// =============================================================================
// 11) meterRun cost math + ledger label
// =============================================================================

test('W785 #11 - meterRun computes cost = (gpu_seconds/3600)*rate; ledger=training', () => {
  freshDir();
  const j = cloudDistill.submitJob({
    tenant: 't_w785_11', namespace: 'n', gpu_sku: 'H100-80GB', vram_tier: '1x',
  });
  // H100-80GB at 1x: rate = 1.99 * 1.00 = 1.99
  const expectedRate = 1.99;
  const out = cloudDistill.meterRun({
    tenant: 't_w785_11', job_id: j.job_id, gpu_seconds: 3600, vram_gb: 78,
  });
  assert.equal(out.ok, true);
  // 3600s = 1 hour, cost should equal the per-gpu-hour rate.
  assert.ok(Math.abs(out.cost_usd - expectedRate) < 1e-9,
    `cost should be ~${expectedRate} (got ${out.cost_usd})`);
  assert.equal(out.unit, 'gpu_hour');
  assert.equal(out.ledger, 'training',
    'ledger MUST be "training" - separate from inference');
  assert.match(out.version, /^w785-/);

  // Half-hour at the same rate.
  const half = cloudDistill.meterRun({
    tenant: 't_w785_11', job_id: j.job_id, gpu_seconds: 1800,
  });
  assert.ok(Math.abs(half.cost_usd - expectedRate / 2) < 1e-9);
});

// =============================================================================
// 12) meterRun validation
// =============================================================================

test('W785 #12 - meterRun rejects invalid_gpu_seconds + not_found', () => {
  freshDir();
  let out = cloudDistill.meterRun({ tenant: 't', job_id: 'x', gpu_seconds: 'banana' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_gpu_seconds');

  out = cloudDistill.meterRun({ tenant: 't', job_id: 'x', gpu_seconds: -5 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_gpu_seconds');

  out = cloudDistill.meterRun({ tenant: 't_real', job_id: 'cdj_nope', gpu_seconds: 100 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
});

// =============================================================================
// 13) readMeter aggregates per-job rows; tenant-fenced
// =============================================================================

test('W785 #13 - readMeter sums per-job rows + tenant-fenced', () => {
  freshDir();
  const j = cloudDistill.submitJob({ tenant: 't_w785_13_A', namespace: 'n' });
  cloudDistill.meterRun({ tenant: 't_w785_13_A', job_id: j.job_id, gpu_seconds: 1200 });
  cloudDistill.meterRun({ tenant: 't_w785_13_A', job_id: j.job_id, gpu_seconds: 600 });
  const read = cloudDistill.readMeter({ tenant: 't_w785_13_A', job_id: j.job_id });
  assert.equal(read.ok, true);
  assert.equal(read.total_gpu_seconds, 1800);
  // Foreign tenant - tenant fence returns 0 totals (no rows visible).
  const peek = cloudDistill.readMeter({ tenant: 't_w785_13_B', job_id: j.job_id });
  assert.equal(peek.ok, true, 'readMeter for foreign tenant must not throw');
  assert.equal(peek.total_gpu_seconds, 0, 'foreign tenant must see 0 rows');
  assert.equal(peek.total_cost_usd, 0);
});

// =============================================================================
// 14) advanceJobState test seam
// =============================================================================

test('W785 #14 - advanceJobState transitions queued -> running -> succeeded', () => {
  freshDir();
  const j = cloudDistill.submitJob({ tenant: 't_w785_14', namespace: 'n' });
  let st = cloudDistill.getJobStatus({ tenant: 't_w785_14', job_id: j.job_id });
  assert.equal(st.state, 'queued');

  cloudDistill.advanceJobState({ tenant: 't_w785_14', job_id: j.job_id, state: 'running' });
  st = cloudDistill.getJobStatus({ tenant: 't_w785_14', job_id: j.job_id });
  assert.equal(st.state, 'running');
  assert.ok(st.started_at, 'started_at must be populated on transition to running');

  cloudDistill.advanceJobState({
    tenant: 't_w785_14', job_id: j.job_id, state: 'succeeded',
    artifact_url: 'https://artifacts.kolm.ai/test.kolm',
  });
  st = cloudDistill.getJobStatus({ tenant: 't_w785_14', job_id: j.job_id });
  assert.equal(st.state, 'succeeded');
  assert.equal(st.artifact_url, 'https://artifacts.kolm.ai/test.kolm');
  assert.ok(st.finished_at, 'finished_at must be populated on terminal state');

  // Bad next state -> honest envelope.
  const bad = cloudDistill.advanceJobState({ tenant: 't_w785_14', job_id: j.job_id, state: 'banana' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_state');
});

// =============================================================================
// 15) HTTP routes auth-gated
// =============================================================================

test('W785 #15 - all 5 cloud-distill routes are auth-gated (401 without auth)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const routes = [
      { method: 'POST',   url: '/v1/cloud/distill/submit', body: {} },
      { method: 'GET',    url: '/v1/cloud/distill' },
      { method: 'GET',    url: '/v1/cloud/distill/cdj_x' },
      { method: 'DELETE', url: '/v1/cloud/distill/cdj_x' },
      { method: 'GET',    url: '/v1/cloud/distill/meter/cdj_x' },
    ];
    for (const r of routes) {
      const opts = { method: r.method };
      if (r.body) {
        opts.headers = { 'content-type': 'application/json' };
        opts.body = JSON.stringify(r.body);
      }
      const res = await fetch(base + r.url, opts);
      assert.equal(res.status, 401,
        r.method + ' ' + r.url + ' must 401 without auth (got: ' + res.status + ')');
    }
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 16) E2E via HTTP
// =============================================================================

test('W785 #16 - HTTP E2E: submit -> status -> list -> cancel via real router', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${tenant.api_key}`,
    };

    // 1) submit
    const r1 = await fetch(`${base}/v1/cloud/distill/submit`, {
      method: 'POST', headers,
      body: JSON.stringify({
        namespace: 'e2e-ns',
        capture_window: '7d',
        recipe_id: 'r1',
        gpu_sku: 'H100-80GB',
        vram_tier: '1x',
      }),
    });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.ok, true);
    assert.equal(b1.state, 'queued');
    // Honesty surface visible on the wire.
    assert.equal(typeof b1.cloud_backend_status, 'string');
    const job_id = b1.job_id;

    // 2) status
    const r2 = await fetch(`${base}/v1/cloud/distill/${job_id}`, { headers });
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.state, 'queued');
    assert.equal(b2.namespace, 'e2e-ns');

    // 3) list
    const r3 = await fetch(`${base}/v1/cloud/distill`, { headers });
    assert.equal(r3.status, 200);
    const b3 = await r3.json();
    assert.equal(b3.ok, true);
    assert.ok(b3.jobs.find((j) => j.job_id === job_id), 'submitted job must appear in list');

    // 4) meter (zero so far - only the reservation row)
    const r4 = await fetch(`${base}/v1/cloud/distill/meter/${job_id}`, { headers });
    assert.equal(r4.status, 200);
    const b4 = await r4.json();
    assert.equal(b4.ok, true);
    assert.equal(b4.ledger, 'training');
    assert.equal(b4.total_gpu_seconds, 0);

    // 5) cancel
    const r5 = await fetch(`${base}/v1/cloud/distill/${job_id}`, {
      method: 'DELETE', headers,
      body: JSON.stringify({ reason: 'e2e test cleanup' }),
    });
    assert.equal(r5.status, 200);
    const b5 = await r5.json();
    assert.equal(b5.ok, true);
    assert.equal(b5.state, 'cancelled');

    // 6) double-cancel returns 400 invalid_transition
    const r6 = await fetch(`${base}/v1/cloud/distill/${job_id}`, {
      method: 'DELETE', headers, body: JSON.stringify({}),
    });
    assert.equal(r6.status, 400);
    const b6 = await r6.json();
    assert.equal(b6.error, 'invalid_transition');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 17) Router file wires all 5 routes + version stamps
// =============================================================================

test('W785 #17 - router.js wires all 5 /v1/cloud/distill routes + version stamps match /^w785-/', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.post\(['"]\/v1\/cloud\/distill\/submit['"]/);
  assert.match(router, /r\.get\(['"]\/v1\/cloud\/distill['"]/);
  assert.match(router, /r\.get\(['"]\/v1\/cloud\/distill\/meter\/:job_id['"]/);
  assert.match(router, /r\.get\(['"]\/v1\/cloud\/distill\/:job_id['"]/);
  assert.match(router, /r\.delete\(['"]\/v1\/cloud\/distill\/:job_id['"]/);
  // version stamps land on every error envelope.
  assert.match(router, /version:\s*['"]w785-/, 'router must emit w785 version stamps');
});

// =============================================================================
// 18) sw.js bumped to wave785+ (W604 anti-brittleness pattern)
// =============================================================================

test('W785 #18 - public/sw.js cache name includes wave785+ (regex match, threshold gate)', () => {
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  const matches = Array.from(sw.matchAll(/wave(\d{3,4})/g));
  assert.ok(matches.length > 0, 'sw.js must reference at least one wave tag');
  const maxWave = matches.reduce((m, x) => Math.max(m, Number(x[1])), 0);
  assert.ok(maxWave >= 785, `sw.js wave tag must be >=785 (got max ${maxWave})`);
});

// =============================================================================
// 19) cloud.html landing page exists with W785 content markers
// =============================================================================

test('W785 #19 - public/cloud.html exists + carries managed-distill landing copy', () => {
  const p = path.join(REPO_ROOT, 'public', 'cloud.html');
  assert.ok(fs.existsSync(p), 'public/cloud.html must exist');
  const html = fs.readFileSync(p, 'utf8');
  assert.match(html, /Bring your captures/i, 'must carry the W785-3 positioning copy');
  assert.match(html, /kolm cloud distill submit/, 'must show the CLI verb');
  assert.match(html, /gpu-hour|gpu-hr/i, 'must surface training meter unit');
  assert.match(html, /no_pool_configured/, 'must explain the honesty contract');
});
