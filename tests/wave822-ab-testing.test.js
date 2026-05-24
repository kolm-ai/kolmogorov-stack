// W822 - A/B testing infrastructure tests.
//
// Coverage map (>= 12 tests):
//   #1  Module exports + version regex
//   #2  setSplit happy path persists jsonl row at ~/.kolm/ab-tests/<ns>.jsonl
//   #3  setSplit validation envelopes (missing_tenant / bad_namespace / bad_args)
//   #4  setSplit idempotency_key short-circuits a duplicate write
//   #5  pickVariant: same request_id -> same variant 100 times (stable)
//   #6  pickVariant: 50/50 split is roughly balanced over 1000 hashes
//   #7  pickVariant honest envelope when no config exists
//   #8  significance.chiSquared on 3x3 contingency table matches a known p-value
//   #9  significance.bootstrap returns ci_low<=mean_diff<=ci_high shape
//  #10  ab-promote.decide -> 'promote' when k_score uplift + low p
//  #11  ab-promote.decide -> 'rollback' on fallback_rate regression
//  #12  ab-promote.decide -> 'rollback' on p95 latency regression
//  #13  ab-promote.decide -> 'hold' on insufficient_samples
//  #14  ab-metrics.aggregate groups feedback events by variant
//  #15  ab-metrics.deltas computes per-axis B-A diffs
//  #16  Route POST /v1/ab/configure requires auth (401 without tenant_record)
//  #17  Route POST /v1/ab/configure -> GET /v1/ab/status round-trip
//  #18  Route POST /v1/ab/feedback persists event + reports self_improvement
//  #19  Route POST /v1/ab/feedback fans into the W720 queue when wired
//  #20  Route GET /v1/ab/metrics returns 404 honest envelope on empty window

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w822-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'ab-tests'), { recursive: true });
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

async function _loadMods() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const store = await import('../src/store.js');
  if (typeof store._resetForTests === 'function') store._resetForTests();
  const ab = await import('../src/ab-router.js');
  const abm = await import('../src/ab-metrics.js');
  const sig = await import('../src/significance.js');
  const abp = await import('../src/ab-promote.js');
  const abr = await import('../src/ab-routes.js');
  return { es, store, ab, abm, sig, abp, abr };
}

// =============================================================================
// #1 - Module exports + version regex
// =============================================================================

test('W822 #1 - module exports + version regex', async () => {
  freshDir();
  const { ab, abm, sig, abp, abr } = await _loadMods();
  assert.ok(/^w822-/.test(ab.W822_AB_VERSION));
  assert.ok(/^w822-/.test(abm.AB_METRICS_VERSION));
  assert.ok(/^w822-/.test(sig.SIGNIFICANCE_VERSION));
  assert.ok(/^w822-/.test(abp.AB_PROMOTE_VERSION));
  assert.ok(/^w822-/.test(abr.AB_ROUTES_VERSION));
  for (const fn of ['setSplit', 'getSplit', 'pickVariant', 'listSplits']) {
    assert.equal(typeof ab[fn], 'function', fn + ' must be exported');
  }
  for (const fn of ['aggregate', 'deltas']) {
    assert.equal(typeof abm[fn], 'function', fn + ' must be exported');
  }
  for (const fn of ['chiSquared', 'bootstrap']) {
    assert.equal(typeof sig[fn], 'function', fn + ' must be exported');
  }
  for (const fn of ['decide', 'evaluate']) {
    assert.equal(typeof abp[fn], 'function', fn + ' must be exported');
  }
  assert.equal(typeof abr.registerAbRoutes, 'function');
});

// =============================================================================
// #2 - setSplit happy path persists jsonl row
// =============================================================================

test('W822 #2 - setSplit persists jsonl row at ~/.kolm/ab-tests/<namespace>.jsonl', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const r = ab.setSplit({
    tenant: 'tenant_w822_a',
    namespace: 'ns_split',
    version_a: 'artifact_v1',
    version_b: 'artifact_v2',
    split: 0.5,
  });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.config.tenant, 'tenant_w822_a');
  assert.equal(r.config.version_a, 'artifact_v1');
  assert.ok(r.config.started_at);
  const expectedFile = path.join(process.env.KOLM_DATA_DIR, 'ab-tests', 'ns_split.jsonl');
  assert.ok(fs.existsSync(expectedFile), 'jsonl file must exist at ' + expectedFile);
  const text = fs.readFileSync(expectedFile, 'utf8');
  assert.ok(text.includes('artifact_v2'));
});

// =============================================================================
// #3 - setSplit validation envelopes
// =============================================================================

test('W822 #3 - setSplit validation honest envelopes', async () => {
  freshDir();
  const { ab } = await _loadMods();
  let r = ab.setSplit({ namespace: 'n', version_a: 'a', version_b: 'b' });
  assert.equal(r.ok, false); assert.equal(r.error, 'missing_tenant');
  r = ab.setSplit({ tenant: 't', namespace: '../escape', version_a: 'a', version_b: 'b' });
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_namespace');
  r = ab.setSplit({ tenant: 't', namespace: 'n', version_a: 'same', version_b: 'same' });
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_args');
  r = ab.setSplit({ tenant: 't', namespace: 'n', version_a: 'a', version_b: 'b', split: -0.1 });
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_args');
});

// =============================================================================
// #4 - setSplit idempotency_key short-circuits a duplicate write
// =============================================================================

test('W822 #4 - setSplit with same idempotency_key returns idempotent_hit', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const args = { tenant: 't_idem', namespace: 'ns_idem', version_a: 'a', version_b: 'b', split: 0.5, idempotency_key: 'idem_42' };
  const r1 = ab.setSplit(args);
  assert.equal(r1.ok, true);
  assert.ok(!r1.idempotent_hit);
  const r2 = ab.setSplit(args);
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent_hit, true, 'second call with same idempotency_key must short-circuit');
  // File should have exactly one row.
  const file = path.join(process.env.KOLM_DATA_DIR, 'ab-tests', 'ns_idem.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).length;
  assert.equal(rows, 1, 'jsonl must have exactly one row for an idempotent re-call');
});

// =============================================================================
// #5 - pickVariant stability: same request_id -> same variant 100 times
// =============================================================================

test('W822 #5 - pickVariant is stable: same request_id -> same variant 100 times', async () => {
  freshDir();
  const { ab } = await _loadMods();
  ab.setSplit({ tenant: 'tenant_stable', namespace: 'ns_stable', version_a: 'a', version_b: 'b', split: 0.5 });
  const first = ab.pickVariant({ tenant: 'tenant_stable', namespace: 'ns_stable', request_id: 'req_42' });
  assert.equal(first.ok, true);
  for (let i = 0; i < 100; i++) {
    const r = ab.pickVariant({ tenant: 'tenant_stable', namespace: 'ns_stable', request_id: 'req_42' });
    assert.equal(r.ok, true);
    assert.equal(r.variant, first.variant, 'iteration ' + i + ' drifted from initial variant');
  }
});

// =============================================================================
// #6 - pickVariant 50/50 split is roughly balanced
// =============================================================================

test('W822 #6 - pickVariant 50/50 split is roughly balanced over 1000 distinct request_ids', async () => {
  freshDir();
  const { ab } = await _loadMods();
  ab.setSplit({ tenant: 'tenant_50', namespace: 'ns_50', version_a: 'a', version_b: 'b', split: 0.5 });
  let countA = 0, countB = 0;
  for (let i = 0; i < 1000; i++) {
    const r = ab.pickVariant({ tenant: 'tenant_50', namespace: 'ns_50', request_id: 'rid_' + i });
    assert.equal(r.ok, true);
    if (r.variant === 'a') countA++; else countB++;
  }
  assert.equal(countA + countB, 1000);
  assert.ok(countA > 350 && countA < 650, 'variant a out of slack: ' + countA);
  assert.ok(countB > 350 && countB < 650, 'variant b out of slack: ' + countB);
});

// =============================================================================
// #7 - pickVariant honest envelope when no config exists
// =============================================================================

test('W822 #7 - pickVariant honest envelope when no config exists', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const r = ab.pickVariant({ tenant: 't', namespace: 'none', request_id: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_active_config');
});

// =============================================================================
// #8 - chiSquared on 3x3 contingency table matches a known p-value
// =============================================================================
//
// Standard textbook example: independence test on
//   observed = [[10,10,20], [20,20,40], [30,30,60]]
//   expected = identical because rows + cols are proportional.
// chi2 should be 0 and p_value 1. A different observed should give a positive
// chi2 with a finite p_value. We assert the (3x3) df = 4 and the closed-form
// match against a known calculation:
//
// observed = [[10, 30], [20, 20]]  (2x2)
// row sums  = [40, 40], col sums = [30, 50], grand = 80
// expected  = [[15, 25], [15, 25]]
// chi2      = (10-15)^2/15 + (30-25)^2/25 + (20-15)^2/15 + (20-25)^2/25
//           = 25/15 + 25/25 + 25/15 + 25/25
//           = 1.6667 + 1.0 + 1.6667 + 1.0 = 5.3333
// df = 1   ->  p = 2 * (1 - Phi(sqrt(5.3333))) = 2 * (1 - Phi(2.3094))
// Phi(2.3094) ≈ 0.98955   -> p ≈ 0.0209

test('W822 #8 - chiSquared 2x2 + 3x3 contingency table p-values are well-formed', async () => {
  freshDir();
  const { sig } = await _loadMods();
  // 2x2 closed-form example.
  const r2 = sig.chiSquared(
    [[10, 30], [20, 20]],
    [[15, 25], [15, 25]],
  );
  assert.equal(r2.df, 1);
  assert.ok(Math.abs(r2.chi2 - 5.3333) < 0.01, 'chi2 must be ~5.33; got ' + r2.chi2);
  // Closed-form: p = 2 * (1 - Phi(sqrt(chi2))) ≈ 0.0209
  assert.ok(r2.p_value > 0.005 && r2.p_value < 0.05,
    'p_value should be ~0.021 within wide tolerance; got ' + r2.p_value);

  // 3x3: proportional rows -> chi2 = 0, p = 1, df = 4.
  const r3 = sig.chiSquared(
    [[10, 10, 20], [20, 20, 40], [30, 30, 60]],
    [[10, 10, 20], [20, 20, 40], [30, 30, 60]],
  );
  assert.equal(r3.df, 4);
  assert.equal(r3.chi2, 0);
  assert.ok(Math.abs(r3.p_value - 1.0) < 0.001, 'p_value must be ~1 for perfect fit; got ' + r3.p_value);

  // Zero-cell handling -> honest envelope.
  const rz = sig.chiSquared([1, 2, 3], [1, 0, 3]);
  assert.equal(rz.zero_cells, true);
  assert.equal(rz.p_value, 1);
});

// =============================================================================
// #9 - bootstrap returns finite CI bracketing mean_diff
// =============================================================================

test('W822 #9 - bootstrap returns CI shape and a sensible p_value', async () => {
  freshDir();
  const { sig } = await _loadMods();
  // arr_b is clearly higher than arr_a -> mean_diff > 0, p_value should be small.
  const arr_a = Array.from({ length: 50 }, (_, i) => 0.5 + 0.001 * i);
  const arr_b = Array.from({ length: 50 }, (_, i) => 0.7 + 0.001 * i);
  const r = sig.bootstrap({ arr_a, arr_b, n_iters: 500, statistic: 'mean', seed: 42 });
  assert.ok(Number.isFinite(r.mean_diff));
  assert.ok(r.mean_diff > 0.15 && r.mean_diff < 0.25, 'mean_diff out of expected range: ' + r.mean_diff);
  assert.ok(Number.isFinite(r.ci_low));
  assert.ok(Number.isFinite(r.ci_high));
  assert.ok(r.ci_low <= r.mean_diff && r.mean_diff <= r.ci_high,
    'CI must bracket mean_diff: low=' + r.ci_low + ' diff=' + r.mean_diff + ' high=' + r.ci_high);
  assert.ok(r.p_value < 0.05, 'clearly-different samples should have p < 0.05; got ' + r.p_value);
  // Empty-input honest envelope.
  const r2 = sig.bootstrap({ arr_a: [], arr_b: [1, 2, 3] });
  assert.equal(r2.ci_low, null);
  assert.equal(r2.p_value, 1);
});

// =============================================================================
// #10 - ab-promote.decide -> 'promote' when uplift + low p
// =============================================================================

test('W822 #10 - decide promotes on k_score uplift + significant p', async () => {
  freshDir();
  const { abp } = await _loadMods();
  const metrics = {
    a: { count: 50, k_score: 0.70, latency_p50: 100, latency_p95: 200, fallback_rate: 0.02, thumbs_up: 30, thumbs_down: 5 },
    b: { count: 50, k_score: 0.85, latency_p50: 105, latency_p95: 210, fallback_rate: 0.02, thumbs_up: 45, thumbs_down: 1 },
  };
  // Provide clearly different sample distributions so the bootstrap p < 0.05.
  const arr_a = Array.from({ length: 50 }, () => 0.70 + (Math.random() * 0.02 - 0.01));
  const arr_b = Array.from({ length: 50 }, () => 0.85 + (Math.random() * 0.02 - 0.01));
  const out = abp.decide({
    metrics,
    k_score_samples_a: arr_a,
    k_score_samples_b: arr_b,
    seed: 7,
  });
  assert.equal(out.decision, 'promote', 'expected promote; got ' + JSON.stringify(out).slice(0, 400));
  assert.equal(out.reason, 'k_score_uplift_significant');
});

// =============================================================================
// #11 - decide -> 'rollback' on fallback regression
// =============================================================================

test('W822 #11 - decide rolls back on fallback_rate regression', async () => {
  freshDir();
  const { abp } = await _loadMods();
  const metrics = {
    a: { count: 100, k_score: 0.80, latency_p50: 100, latency_p95: 200, fallback_rate: 0.01, thumbs_up: 30, thumbs_down: 5 },
    b: { count: 100, k_score: 0.85, latency_p50: 100, latency_p95: 200, fallback_rate: 0.10, thumbs_up: 30, thumbs_down: 30 },
  };
  const out = abp.decide({ metrics });
  assert.equal(out.decision, 'rollback');
  assert.equal(out.reason, 'fallback_regression');
});

// =============================================================================
// #12 - decide -> 'rollback' on p95 latency regression
// =============================================================================

test('W822 #12 - decide rolls back on p95 latency regression >25%', async () => {
  freshDir();
  const { abp } = await _loadMods();
  const metrics = {
    a: { count: 100, k_score: 0.80, latency_p50: 100, latency_p95: 200, fallback_rate: 0.02, thumbs_up: 30, thumbs_down: 5 },
    b: { count: 100, k_score: 0.82, latency_p50: 110, latency_p95: 260, fallback_rate: 0.02, thumbs_up: 30, thumbs_down: 5 },
  };
  const out = abp.decide({ metrics });
  assert.equal(out.decision, 'rollback');
  assert.equal(out.reason, 'latency_p95_regression');
});

// =============================================================================
// #13 - decide -> 'hold' on insufficient_samples
// =============================================================================

test('W822 #13 - decide holds on insufficient_samples', async () => {
  freshDir();
  const { abp } = await _loadMods();
  const metrics = {
    a: { count: 10, k_score: 0.80, latency_p50: 100, latency_p95: 200, fallback_rate: 0.02, thumbs_up: 5, thumbs_down: 0 },
    b: { count: 10, k_score: 0.95, latency_p50: 100, latency_p95: 200, fallback_rate: 0.02, thumbs_up: 9, thumbs_down: 0 },
  };
  const out = abp.decide({ metrics });
  assert.equal(out.decision, 'hold');
  assert.equal(out.reason, 'insufficient_samples');
});

// =============================================================================
// #14 - ab-metrics.aggregate groups feedback events by variant
// =============================================================================

test('W822 #14 - ab-metrics.aggregate groups events by variant', async () => {
  freshDir();
  const { es, abm } = await _loadMods();
  const tenant_id = 'tenant_w822_metrics';
  const namespace = 'ns_metrics';
  // Seed 10 events for each variant via appendEvent + w822_ab_feedback payload.
  for (let i = 0; i < 10; i++) {
    await es.appendEvent({
      tenant_id,
      namespace,
      workflow_id: 'w822:ab:feedback',
      model: 'ab_variant:a',
      status: i < 9 ? 'ok' : 'error',     // 1/10 = 10% fallback rate
      latency_ms: 100 + i,
      feedback: JSON.stringify({ kind: 'w822_ab_feedback', variant: 'a', k_score: 0.7 + i * 0.001, thumb: i < 8 ? 'up' : 'down' }),
    });
    await es.appendEvent({
      tenant_id,
      namespace,
      workflow_id: 'w822:ab:feedback',
      model: 'ab_variant:b',
      status: 'ok',
      latency_ms: 90 + i,
      feedback: JSON.stringify({ kind: 'w822_ab_feedback', variant: 'b', k_score: 0.85 + i * 0.001, thumb: 'up' }),
    });
  }
  const out = await abm.aggregate({ tenant_id, namespace });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.equal(out.metrics.a.count, 10);
  assert.equal(out.metrics.b.count, 10);
  assert.ok(Math.abs(out.metrics.a.fallback_rate - 0.1) < 0.001);
  assert.equal(out.metrics.b.fallback_rate, 0);
  assert.ok(out.metrics.b.k_score > out.metrics.a.k_score, 'b k_score should beat a');
});

// =============================================================================
// #15 - ab-metrics.deltas computes per-axis B-A diffs
// =============================================================================

test('W822 #15 - ab-metrics.deltas computes per-axis B-A diffs', async () => {
  freshDir();
  const { abm } = await _loadMods();
  const m = {
    a: { count: 50, k_score: 0.7, latency_p50: 100, latency_p95: 200, fallback_rate: 0.05, thumbs_up: 20, thumbs_down: 5 },
    b: { count: 50, k_score: 0.85, latency_p50: 120, latency_p95: 250, fallback_rate: 0.08, thumbs_up: 30, thumbs_down: 2 },
  };
  const d = abm.deltas(m);
  assert.ok(Math.abs(d.k_score_delta - 0.15) < 1e-6);
  assert.equal(d.latency_p50_delta, 20);
  assert.equal(d.latency_p95_delta, 50);
  assert.ok(Math.abs(d.latency_p95_pct_delta - 0.25) < 1e-6);
  assert.ok(Math.abs(d.fallback_rate_delta - 0.03) < 1e-6);
  assert.equal(d.thumbs_up_delta, 10);
  assert.equal(d.thumbs_down_delta, -3);
});

// =============================================================================
// Route tests -- mount registerAbRoutes onto a fresh express() so we don't
// require buildRouter() (which loads dozens of unrelated modules).
// =============================================================================

async function buildApp({ tenantId = null, selfImpEnqueueRef = null } = {}) {
  freshDir();
  // Reset modules so the new KOLM_DATA_DIR + KOLM_EVENT_STORE_DRIVER take effect.
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const express = (await import('express')).default;
  const bodyParser = (await import('body-parser')).default;
  const { registerAbRoutes } = await import('../src/ab-routes.js');
  const app = express();
  app.use(bodyParser.json({ limit: '2mb' }));
  // Stub auth: stamp req.tenant_record when caller passes Authorization: Bearer t_*
  const authMiddleware = (req, _res, next) => {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (m) req.tenant_record = { id: tenantId || m[1] };
    next();
  };
  const deps = { authMiddleware };
  if (selfImpEnqueueRef) {
    deps.selfImprovement = { enqueue: selfImpEnqueueRef };
  }
  registerAbRoutes(app, deps);
  const http = await import('node:http');
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  return { app, srv, base: 'http://127.0.0.1:' + port };
}

async function _close(srv) {
  return new Promise(r => srv.close(r));
}

// =============================================================================
// #16 - Route requires auth (401 without Authorization header)
// =============================================================================

test('W822 #16 - POST /v1/ab/configure requires auth (401 without tenant)', async () => {
  const { srv, base } = await buildApp();
  try {
    const res = await fetch(base + '/v1/ab/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'n', version_a: 'a', version_b: 'b' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unauthorized');
  } finally { await _close(srv); }
});

// =============================================================================
// #17 - configure -> status round-trip
// =============================================================================

test('W822 #17 - POST /v1/ab/configure -> GET /v1/ab/status round-trip', async () => {
  const { srv, base } = await buildApp({ tenantId: 'tenant_round' });
  try {
    const r1 = await fetch(base + '/v1/ab/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tk_x' },
      body: JSON.stringify({ namespace: 'roundtrip', version_a: 'v1', version_b: 'v2', split: 0.5 }),
    });
    assert.equal(r1.status, 201);
    const b1 = await r1.json();
    assert.equal(b1.ok, true);
    assert.equal(b1.config.namespace, 'roundtrip');

    const r2 = await fetch(base + '/v1/ab/status?namespace=roundtrip', {
      headers: { authorization: 'Bearer tk_x' },
    });
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.ok, true);
    assert.equal(b2.config.version_a, 'v1');
    assert.equal(b2.config.version_b, 'v2');
  } finally { await _close(srv); }
});

// =============================================================================
// #18 - feedback persists event + reports self_improvement
// =============================================================================

test('W822 #18 - POST /v1/ab/feedback persists event and reports self_improvement', async () => {
  const { srv, base } = await buildApp({ tenantId: 'tenant_fb' });
  try {
    const res = await fetch(base + '/v1/ab/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tk_z' },
      body: JSON.stringify({
        namespace: 'ns_fb',
        variant: 'a',
        request_id: 'req_fb_1',
        k_score: 0.82,
        latency_ms: 150,
        thumb: 'up',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.event_id);
    assert.ok(body.self_improvement === 'tagged_for_detection' || body.self_improvement === 'enqueued');
  } finally { await _close(srv); }
});

// =============================================================================
// #19 - feedback fans into the W720 queue when wired
// =============================================================================

test('W822 #19 - POST /v1/ab/feedback fans into self-improvement queue when enqueue is wired', async () => {
  const enqueued = [];
  const enqueueFn = async (row) => { enqueued.push(row); };
  const { srv, base } = await buildApp({ tenantId: 'tenant_fb2', selfImpEnqueueRef: enqueueFn });
  try {
    const res = await fetch(base + '/v1/ab/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tk_w' },
      body: JSON.stringify({
        namespace: 'ns_fb2',
        variant: 'b',
        request_id: 'req_fb_2',
        k_score: 0.60,
        thumb: 'down',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.self_improvement, 'enqueued');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].kind, 'ab_feedback');
    assert.equal(enqueued[0].variant, 'b');
    assert.equal(enqueued[0].thumb, 'down');
    assert.equal(enqueued[0].source, 'w822');
  } finally { await _close(srv); }
});

// =============================================================================
// #20 - metrics returns 404 honest envelope on empty window
// =============================================================================

test('W822 #20 - GET /v1/ab/metrics returns honest 404 when no events match', async () => {
  const { srv, base } = await buildApp({ tenantId: 'tenant_empty' });
  try {
    const res = await fetch(base + '/v1/ab/metrics?namespace=nope', {
      headers: { authorization: 'Bearer tk_empty' },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error === 'no_route_telemetry' || body.error === 'no_ab_tagged_events');
  } finally { await _close(srv); }
});
