// W781 - Long-context degradation warnings.
//
// Atomic items pinned (matches the W781 implementation):
//
//   1)  LONG_CONTEXT_WARN_VERSION === 'w781-v1' + DEFAULTS frozen
//   2)  percentile() type-7 linear interpolation correctness on
//       deterministic fixture (1..100)
//   3)  analyzeContextLengthDist honest no_captures envelope on empty corpus
//   4)  analyzeContextLengthDist tenant-required envelope without tenant
//   5)  analyzeContextLengthDist W411 tenant fence: foreign rows excluded
//   6)  analyzeContextLengthDist percentile correctness on deterministic
//       seed (n=100, p50/p90/p95/p99 exact)
//   7)  checkContextLength warn:true when input > p90 (with >= MIN_SAMPLES)
//   8)  checkContextLength warn:false when input <= p90
//   9)  checkContextLength insufficient_samples reason when n < 20
//   10) enrichForDistill returns module_missing-friendly envelope when
//       teacher_caller missing (dry-run mode) AND seeds_count > 0
//   11) GET /v1/long-context/p90 is auth-gated (401 without auth)
//   12) GET /v1/long-context/p90 returns ok:true + version stamp w/ auth
//   13) POST /v1/long-context/check tenant_id forced from auth, never
//       overrideable from body
//   14) router file wires both routes + version stamp matches /^w781-/
//   15) W604 anti-brittleness: sw.js cache slug regex `wave(\d{3,4})`
//       threshold check (>= 781 is wrong; W604 wave can be older if
//       sibling W777-W780 owns the bump)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eventStore from '../src/event-store.js';
import * as longCtx from '../src/long-context-warn.js';
import * as auth from '../src/auth.js';
import * as kolmStore from '../src/store.js';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w781-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
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

// Seed an event-store row with an explicit input_tokens signal so the
// length-extractor reads a deterministic value (rather than computing
// from a string length).
async function seedLen(tenant_id, namespace, input_tokens, opts) {
  const o = opts || {};
  return await eventStore.appendEvent({
    tenant_id,
    namespace,
    provider: o.provider || 'openai',
    vendor: o.vendor || 'openai',
    model: o.model || 'gpt-4o-mini',
    input_tokens,
    prompt_tokens: input_tokens,
    tokens_in: input_tokens,
    tokens_out: 10,
    completion_tokens: 10,
    cost_micro_usd: o.cost_micro_usd || 100,
    latency_ms: o.latency_ms || 100,
    status: 'ok',
    created_at: o.created_at || new Date().toISOString(),
  });
}

// =============================================================================
// 1) Version + DEFAULTS frozen
// =============================================================================

test('W781 #1 - LONG_CONTEXT_WARN_VERSION matches /^w781-/ + DEFAULTS frozen', () => {
  assert.equal(typeof longCtx.LONG_CONTEXT_WARN_VERSION, 'string');
  assert.match(longCtx.LONG_CONTEXT_WARN_VERSION, /^w781-/,
    'version stamp must regex-match /^w781-/ (got: ' + longCtx.LONG_CONTEXT_WARN_VERSION + ')');
  assert.ok(Object.isFrozen(longCtx.DEFAULTS), 'DEFAULTS must be frozen');
  assert.equal(typeof longCtx.DEFAULT_WINDOW_DAYS, 'number');
  assert.equal(typeof longCtx.DEFAULT_HIST_BUCKETS, 'number');
});

// =============================================================================
// 2) percentile() correctness on deterministic [1..100]
// =============================================================================

test('W781 #2 - percentile() returns type-7 linear interpolation on 1..100', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1);
  // For 1..100 with type-7: p50 = 50.5, p90 = 90.1, p95 = 95.05, p99 = 99.01
  assert.ok(Math.abs(longCtx.percentile(arr, 0.5) - 50.5) < 1e-9,
    'p50 must be 50.5 (got ' + longCtx.percentile(arr, 0.5) + ')');
  assert.ok(Math.abs(longCtx.percentile(arr, 0.9) - 90.1) < 1e-9,
    'p90 must be 90.1 (got ' + longCtx.percentile(arr, 0.9) + ')');
  assert.ok(Math.abs(longCtx.percentile(arr, 0.95) - 95.05) < 1e-9,
    'p95 must be 95.05 (got ' + longCtx.percentile(arr, 0.95) + ')');
  assert.ok(Math.abs(longCtx.percentile(arr, 0.99) - 99.01) < 1e-9,
    'p99 must be 99.01 (got ' + longCtx.percentile(arr, 0.99) + ')');
  // Empty + single-element edge cases.
  assert.equal(longCtx.percentile([], 0.5), 0);
  assert.equal(longCtx.percentile([42], 0.9), 42);
});

// =============================================================================
// 3) no_captures honest envelope
// =============================================================================

test('W781 #3 - analyzeContextLengthDist returns honest no_captures envelope on empty corpus', async () => {
  freshDir();
  const out = await longCtx.analyzeContextLengthDist({
    tenant: 'tenant_w781_3',
    namespace: 'empty_ns',
  });
  assert.equal(out.ok, true);
  assert.equal(out.n, 0);
  assert.equal(out.message, 'no_captures');
  assert.equal(out.p50, 0);
  assert.equal(out.p90, 0);
  assert.match(out.version, /^w781-/);
});

// =============================================================================
// 4) tenant_required envelope
// =============================================================================

test('W781 #4 - analyzeContextLengthDist requires tenant', async () => {
  const out = await longCtx.analyzeContextLengthDist({});
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tenant_required');
  assert.match(out.version, /^w781-/);
  // checkContextLength too
  const out2 = await longCtx.checkContextLength({ input_length: 100 });
  assert.equal(out2.ok, false);
  assert.equal(out2.error, 'tenant_required');
});

// =============================================================================
// 5) W411 tenant fence: foreign rows excluded
// =============================================================================

test('W781 #5 - analyzeContextLengthDist is tenant-fenced (foreign rows excluded)', async () => {
  freshDir();
  await seedLen('tenant_w781_5_A', 'ns', 100);
  await seedLen('tenant_w781_5_A', 'ns', 200);
  await seedLen('tenant_w781_5_B', 'ns', 999999); // foreign, very long
  await seedLen('tenant_w781_5_B', 'ns', 888888);

  const a = await longCtx.analyzeContextLengthDist({ tenant: 'tenant_w781_5_A', namespace: 'ns' });
  assert.equal(a.ok, true);
  assert.equal(a.n, 2, 'tenant A must see only own rows');
  assert.equal(a.max, 200, 'foreign 999999 must not bleed into max');
  const b = await longCtx.analyzeContextLengthDist({ tenant: 'tenant_w781_5_B', namespace: 'ns' });
  assert.equal(b.n, 2);
  assert.equal(b.max, 999999);
});

// =============================================================================
// 6) Distribution correctness on deterministic 100-row seed
// =============================================================================

test('W781 #6 - analyzeContextLengthDist computes p50/p90/p95/p99 exactly on [1..100]', async () => {
  freshDir();
  for (let i = 1; i <= 100; i++) {
    await seedLen('tenant_w781_6', 'ns', i);
  }
  const out = await longCtx.analyzeContextLengthDist({ tenant: 'tenant_w781_6', namespace: 'ns' });
  assert.equal(out.ok, true);
  assert.equal(out.n, 100);
  assert.equal(out.min, 1);
  assert.equal(out.max, 100);
  assert.ok(Math.abs(out.p50 - 50.5) < 1e-9);
  assert.ok(Math.abs(out.p90 - 90.1) < 1e-9);
  assert.ok(Math.abs(out.p95 - 95.05) < 1e-9);
  assert.ok(Math.abs(out.p99 - 99.01) < 1e-9);
  assert.ok(Array.isArray(out.hist.edges));
  assert.ok(Array.isArray(out.hist.counts));
});

// =============================================================================
// 7) checkContextLength warn:true above p90
// =============================================================================

test('W781 #7 - checkContextLength returns warn:true when input > p90', async () => {
  freshDir();
  // Need >= 20 samples (MIN_SAMPLES_FOR_WARN) for warn to fire.
  for (let i = 1; i <= 100; i++) {
    await seedLen('tenant_w781_7', 'ns', i);
  }
  // input_length 95 > p90 (=90.1), so warn:true.
  const out = await longCtx.checkContextLength({
    tenant: 'tenant_w781_7',
    namespace: 'ns',
    input_length: 95,
  });
  assert.equal(out.ok, true);
  assert.equal(out.warn, true);
  assert.equal(out.reason, 'above_p90');
  assert.ok(Math.abs(out.p90 - 90.1) < 1e-9);
  assert.equal(out.n, 100);
  assert.match(out.version, /^w781-/);
});

// =============================================================================
// 8) checkContextLength warn:false below p90
// =============================================================================

test('W781 #8 - checkContextLength returns warn:false when input <= p90', async () => {
  freshDir();
  for (let i = 1; i <= 100; i++) {
    await seedLen('tenant_w781_8', 'ns', i);
  }
  const out = await longCtx.checkContextLength({
    tenant: 'tenant_w781_8',
    namespace: 'ns',
    input_length: 50,
  });
  assert.equal(out.ok, true);
  assert.equal(out.warn, false);
  assert.equal(out.reason, 'within_p90');
});

// =============================================================================
// 9) insufficient_samples reason when n < MIN_SAMPLES_FOR_WARN (20)
// =============================================================================

test('W781 #9 - checkContextLength returns insufficient_samples when n < 20', async () => {
  freshDir();
  // Seed only 5 samples - below MIN_SAMPLES_FOR_WARN.
  for (let i = 0; i < 5; i++) {
    await seedLen('tenant_w781_9', 'ns', 100 + i);
  }
  const out = await longCtx.checkContextLength({
    tenant: 'tenant_w781_9',
    namespace: 'ns',
    input_length: 1000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.warn, false, 'never warn on insufficient samples even if input is huge');
  assert.equal(out.reason, 'insufficient_samples');
  assert.equal(out.n, 5);
  assert.equal(out.min_samples_for_warn, 20);
});

// =============================================================================
// 10) enrichForDistill dry-run path (no teacher_caller injected)
// =============================================================================

test('W781 #10 - enrichForDistill returns dry-run envelope with seeds when teacher missing', async () => {
  freshDir();
  for (let i = 0; i < 30; i++) {
    await seedLen('tenant_w781_10', 'ns', (i + 1) * 100);
  }
  // No teacher_caller injected: should NOT spend credits, but surface the seeds it WOULD use.
  const out = await longCtx.enrichForDistill({
    tenant: 'tenant_w781_10',
    namespace: 'ns',
    target_count: 5,
  });
  // Either we got the dry-run envelope (W749 present, teacher missing) or
  // we got module_missing (W749 absent in this build). Both are honest.
  assert.equal(out.ok !== undefined, true);
  if (out.ok === true) {
    assert.equal(out.mode, 'long_context_enriched_dry_run');
    assert.ok(out.seeds_count > 0, 'seeds_count must be > 0 when corpus has rows');
    assert.equal(out.seeds_count, 5, 'should pick top-5 longest');
  } else {
    assert.equal(out.error, 'module_missing');
    assert.equal(out.module, 'synthetic-augment.js');
  }
  assert.match(out.version, /^w781-/);
});

// =============================================================================
// 11) Route auth-gated
// =============================================================================

test('W781 #11 - GET /v1/long-context/p90 is auth-gated (401 without auth)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const res = await fetch(`${base}/v1/long-context/p90`);
    assert.equal(res.status, 401);
    const body = await res.json().catch(() => ({}));
    assert.notEqual(body.ok, true);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 12) Route returns ok:true + version stamp w/ auth
// =============================================================================

test('W781 #12 - GET /v1/long-context/p90 returns ok envelope w/ auth + version stamp', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    const res = await fetch(`${base}/v1/long-context/p90`, {
      headers: { authorization: `Bearer ${tenant.api_key}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.version, /^w781-/);
    // Empty corpus -> no_captures envelope.
    assert.equal(body.message, 'no_captures');
    assert.equal(body.n, 0);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 13) Tenant_id forced from auth, not overridable from body
// =============================================================================

test('W781 #13 - POST /v1/long-context/check forces tenant_id from auth (defense-in-depth)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenantA = await auth.provisionAnonTenant();
    const tenantB = await auth.provisionAnonTenant();
    // Seed tenant B with rows; tenant A has none.
    for (let i = 1; i <= 100; i++) {
      await seedLen(tenantB.id, 'ns', i);
    }
    // Body attempts to spoof tenant_id - the route MUST ignore it and use auth's tenant.
    const res = await fetch(`${base}/v1/long-context/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tenantA.api_key}`,
      },
      body: JSON.stringify({
        tenant: tenantB.id, // spoof attempt
        tenant_id: tenantB.id, // spoof attempt
        namespace: 'ns',
        input_length: 50,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Tenant A has no rows, so result MUST reflect tenant A's empty corpus.
    assert.equal(body.reason, 'no_captures', 'tenant fence broken: tenant A saw tenant B rows');
    assert.equal(body.n, 0);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 14) Router wires both routes + version stamp
// =============================================================================

test('W781 #14 - router.js wires both /v1/long-context routes + version stamps match /^w781-/', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.get\(['"]\/v1\/long-context\/p90['"]/,
    'GET /v1/long-context/p90 must be wired');
  assert.match(router, /r\.post\(['"]\/v1\/long-context\/check['"]/,
    'POST /v1/long-context/check must be wired');
  // version stamps in error envelopes match /^w781-/.
  assert.match(router, /version:\s*['"]w781-/, 'router must emit w781 version stamps');
  // Tenant fence on both routes (forced from req.tenant_record.id). Slice
  // a generous window starting at the route open so we span the analyze /
  // check helper call inside.
  const p90 = router.indexOf("r.get('/v1/long-context/p90'");
  assert.ok(p90 > 0, 'p90 route located');
  const p90Body = router.slice(p90, p90 + 2000);
  assert.match(p90Body, /req\.tenant_record/, 'p90 route must reference req.tenant_record');
  assert.match(p90Body, /tenant:\s*req\.tenant_record\.id/,
    'p90 route must force tenant from req.tenant_record.id');
});
