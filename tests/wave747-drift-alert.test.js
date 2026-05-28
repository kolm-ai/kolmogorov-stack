// W747 — Distribution-shift live alerter (drift-alert).
//
// Atomic items pinned (matches the W747 implementation):
//
//   1) DRIFT_ALERT_VERSION present + stamped 'w747-v1'
//   2) tokenizeForDistribution is deterministic
//   3) buildDistributionSketch respects top_k AND keeps _other + _total + _top_k
//   4) buildDistributionSketch _total == sum of raw counts (top-K + _other)
//   5) klDivergence(P, P) returns 0 (identity)
//   6) klDivergence never returns NaN/Infinity thanks to smoothing
//   7) klDivergence is monotonic (larger structural divergence → larger kl)
//   8) compareSketches: jsd is symmetric (P,Q == Q,P)
//   9) compareSketches: top_diverging_tokens are sorted by |Δp| desc
//  10) generateShiftSuggestion: returns actionable strings w/ percentage + token + "Capture"
//  11) shouldAlert: true iff jsd >= threshold
//  12) recordSketchSnapshot + latestSnapshots roundtrip + tenant-fence
//  13) registerWebhook upserts (no duplicates for same url)
//  14) registerDriftWarning + consumeDriftWarning are one-shot semantics
//  15) POST /v1/drift-alert/snapshot 401 without auth; 200 with envelope on auth
//  16) GET /v1/drift-alert/:namespace returns honest missing-snapshot envelope
//  17) GET /v1/drift-alert/:namespace returns alert+suggestions when JSD crosses threshold
//  18) Webhook fires (mock fetch) with kolm_alert:'distribution_shift' body
//  19) W709 tie-in: when alert fires, consumeDriftWarning returns the warning
//      (proves the registerDriftWarning call inside the route ran). Honest
//      fallback: if drift-alert-store fails to import, routing path still works.
//  20) public/account/drift-alert.html has brand-lock + JSD pill + suggestion render
//  21) public/docs/drift-alert.html has brand-lock + KL/JSD math + W709 note
//  22) vercel.json has both /docs/drift-alert + /account/drift-alert rewrites
//  23) cli/kolm.js defines cmdW747DriftAlert exactly once + wired from case 'drift-alert'
//  24) wave747 sibling test count uses wave(\d{3,4}) regex + threshold
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DRIFT_ALERT_VERSION,
  DEFAULTS as DRIFT_DEFAULTS,
  tokenizeForDistribution,
  buildDistributionSketch,
  klDivergence,
  compareSketches,
  generateShiftSuggestion,
  shouldAlert,
} from '../src/drift-alert.js';

import {
  recordSketchSnapshot,
  latestSnapshots,
  registerWebhook,
  listWebhooks,
  registerDriftWarning,
  consumeDriftWarning,
  peekDriftWarning,
  _resetForTests as resetDriftStore,
} from '../src/drift-alert-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'drift-alert.html');
const ACCT_PATH = path.join(REPO_ROOT, 'public', 'account', 'drift-alert.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const ROUTING_EVENTS_PATH = path.join(REPO_ROOT, 'src', 'routing-events.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w747-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  try { resetDriftStore(); } catch (_) {} // deliberate: cleanup
  return tmp;
}

// =============================================================================
// 1) DRIFT_ALERT_VERSION present + stamped 'w747-v1'
// =============================================================================

test('W747 #1 — DRIFT_ALERT_VERSION present + stamped w747-v1', () => {
  freshDir();
  assert.equal(DRIFT_ALERT_VERSION, 'w747-v1',
    `expected DRIFT_ALERT_VERSION='w747-v1'; got ${JSON.stringify(DRIFT_ALERT_VERSION)}`);
  assert.ok(DRIFT_DEFAULTS && Number.isFinite(DRIFT_DEFAULTS.JSD_THRESHOLD),
    `DEFAULTS.JSD_THRESHOLD must be a finite number; got ${DRIFT_DEFAULTS && DRIFT_DEFAULTS.JSD_THRESHOLD}`);
  assert.equal(DRIFT_DEFAULTS.JSD_THRESHOLD, 0.15,
    `spec mandates default JSD threshold 0.15; got ${DRIFT_DEFAULTS.JSD_THRESHOLD}`);
});

// =============================================================================
// 2) tokenizeForDistribution is deterministic
// =============================================================================

test('W747 #2 — tokenizeForDistribution is deterministic + lowercase + word-split', () => {
  freshDir();
  const a = tokenizeForDistribution('Refund My Order Please');
  const b = tokenizeForDistribution('Refund My Order Please');
  assert.deepEqual(a, b, 'same input must produce same token sequence');
  // Lowercase + word-split: should produce lowercased monograms among others.
  assert.ok(a.includes('refund'), `monogram 'refund' missing; got ${JSON.stringify(a.slice(0, 8))}`);
  assert.ok(a.includes('order'),  `monogram 'order' missing; got ${JSON.stringify(a.slice(0, 8))}`);
  // Punctuation does not leak into tokens.
  const c = tokenizeForDistribution('hello, world!');
  for (const t of c) {
    assert.ok(!/[,.!?]/.test(t),
      `tokens MUST NOT contain punctuation; got ${JSON.stringify(t)}`);
  }
  // Empty/nullish inputs do not throw + return [].
  assert.deepEqual(tokenizeForDistribution(null), []);
  assert.deepEqual(tokenizeForDistribution(''), []);
});

// =============================================================================
// 3) buildDistributionSketch respects top_k + meta keys
// =============================================================================

test('W747 #3 — buildDistributionSketch respects top_k AND keeps _other + _total + _top_k', () => {
  freshDir();
  const samples = [
    'apple apple apple banana',
    'banana cherry',
    'cherry cherry dragonfruit elderberry',
  ];
  const sk = buildDistributionSketch(samples, { top_k: 2 });
  assert.equal(sk._top_k, 2, `expected _top_k=2; got ${sk._top_k}`);
  assert.ok(typeof sk._other === 'number', `_other must be number; got ${typeof sk._other}`);
  assert.ok(typeof sk._total === 'number', `_total must be number; got ${typeof sk._total}`);
  // Only the top-2 monograms ("apple" + "cherry" at count 3) plus _other/_total/_top_k.
  // (Strictly: the n-gram mix can include bigrams too — count the unique non-meta keys.)
  const nonMetaKeys = Object.keys(sk).filter((k) => k !== '_other' && k !== '_total' && k !== '_top_k');
  assert.equal(nonMetaKeys.length, 2,
    `expected exactly 2 non-meta keys at top_k=2; got ${nonMetaKeys.length}: ${nonMetaKeys}`);
});

// =============================================================================
// 4) buildDistributionSketch _total == sum of raw counts (top-K + _other)
// =============================================================================

test('W747 #4 — _total equals top-K counts + _other', () => {
  freshDir();
  const samples = ['the quick brown fox', 'the lazy dog'];
  const sk = buildDistributionSketch(samples, { top_k: 3 });
  let sum = 0;
  for (const k of Object.keys(sk)) {
    if (k === '_total' || k === '_top_k') continue;
    sum += Number(sk[k]);
  }
  assert.equal(sum, sk._total,
    `_total (${sk._total}) must equal sum of top-K + _other (${sum})`);
});

// =============================================================================
// 5) klDivergence(P, P) returns 0
// =============================================================================

test('W747 #5 — klDivergence(P, P) returns 0', () => {
  freshDir();
  const p = buildDistributionSketch(['alpha beta gamma', 'alpha alpha beta'], { top_k: 50 });
  const kl = klDivergence(p, p);
  // With smoothing the smoothed mass is identical for both sides, so KL is 0
  // mathematically and well within floating-point noise.
  assert.ok(kl < 1e-9, `KL(P,P) must be ~0; got ${kl}`);
});

// =============================================================================
// 6) klDivergence never returns NaN/Infinity (smoothing contract)
// =============================================================================

test('W747 #6 — klDivergence never returns NaN/Infinity', () => {
  freshDir();
  // P has tokens that Q does not (disjoint supports) — a classic divide-by-zero
  // trap that smoothing must prevent.
  const p = buildDistributionSketch(['only training tokens here'], { top_k: 50 });
  const q = buildDistributionSketch(['totally different prod corpus'], { top_k: 50 });
  const kl1 = klDivergence(p, q);
  const kl2 = klDivergence(q, p);
  assert.ok(Number.isFinite(kl1) && Number.isFinite(kl2),
    `KL must be finite under disjoint supports; got KL(p,q)=${kl1}, KL(q,p)=${kl2}`);
  assert.ok(kl1 >= 0 && kl2 >= 0,
    `KL must be non-negative; got KL(p,q)=${kl1}, KL(q,p)=${kl2}`);
  // Empty/garbage inputs do not throw.
  assert.equal(klDivergence(null, null), 0);
  assert.equal(klDivergence({}, {}), 0);
});

// =============================================================================
// 7) klDivergence is monotonic (larger structural divergence → larger kl)
// =============================================================================

test('W747 #7 — klDivergence grows monotonically with structural divergence', () => {
  freshDir();
  const train = buildDistributionSketch(
    ['billing question about plan', 'billing plan upgrade', 'billing late fee'],
    { top_k: 100 },
  );
  // close: same domain, slightly different vocabulary
  const close = buildDistributionSketch(
    ['billing question about plan', 'billing plan price'],
    { top_k: 100 },
  );
  // far: entirely unrelated tokens
  const far = buildDistributionSketch(
    ['refund return shipping address change pickup label'],
    { top_k: 100 },
  );
  const klClose = klDivergence(train, close);
  const klFar = klDivergence(train, far);
  assert.ok(klFar > klClose,
    `KL must be monotonic: KL(train, far)=${klFar} should be > KL(train, close)=${klClose}`);
});

// =============================================================================
// 8) compareSketches: jsd is symmetric (P,Q == Q,P)
// =============================================================================

test('W747 #8 — compareSketches: jsd is symmetric (P,Q == Q,P)', () => {
  freshDir();
  const p = buildDistributionSketch(['a a a b b c'], { top_k: 50 });
  const q = buildDistributionSketch(['a b c c c d d'], { top_k: 50 });
  const cmpPQ = compareSketches(p, q);
  const cmpQP = compareSketches(q, p);
  // JSD is symmetric to within numerical noise.
  assert.ok(Math.abs(cmpPQ.jsd - cmpQP.jsd) < 1e-9,
    `JSD must be symmetric; got |JSD(P,Q) - JSD(Q,P)| = ${Math.abs(cmpPQ.jsd - cmpQP.jsd)}`);
});

// =============================================================================
// 9) compareSketches: top_diverging_tokens sorted by |Δp| desc
// =============================================================================

test('W747 #9 — compareSketches: top_diverging_tokens sorted by |Δp| desc', () => {
  freshDir();
  const train = buildDistributionSketch(
    ['common common common common rare'],
    { top_k: 200 },
  );
  const prod = buildDistributionSketch(
    ['rare rare rare rare common spike spike spike'],
    { top_k: 200 },
  );
  const cmp = compareSketches(train, prod);
  assert.ok(Array.isArray(cmp.top_diverging_tokens) && cmp.top_diverging_tokens.length > 0,
    `top_diverging_tokens must be a non-empty array; got ${JSON.stringify(cmp.top_diverging_tokens)}`);
  // Sorted by absolute |p_train - p_prod| desc.
  let prev = Infinity;
  for (const t of cmp.top_diverging_tokens) {
    const d = Math.abs(Number(t.p_train) - Number(t.p_prod));
    assert.ok(d <= prev + 1e-12,
      `top_diverging_tokens not sorted by |Δp| desc; row ${JSON.stringify(t)} has Δ=${d}, prev=${prev}`);
    prev = d;
  }
});

// =============================================================================
// 10) generateShiftSuggestion: returns actionable string w/ percentage + token + "Capture"
// =============================================================================

test('W747 #10 — generateShiftSuggestion returns actionable strings w/ %, token, "Capture"', () => {
  freshDir();
  const train = buildDistributionSketch(
    ['hello world hello world hello world hello world'],
    { top_k: 50 },
  );
  // Prod is heavily skewed toward "refund" — a token NOT in training.
  const prod = buildDistributionSketch(
    ['refund refund refund refund refund refund refund refund hello'],
    { top_k: 50 },
  );
  const cmp = compareSketches(train, prod);
  const sugs = generateShiftSuggestion(cmp, { top_n: 3 });
  assert.ok(Array.isArray(sugs) && sugs.length >= 1,
    `expected at least 1 suggestion when prod heavily skews; got ${JSON.stringify(sugs)}`);
  // Each suggestion must contain a % number AND the token AND the "Capture" verb.
  for (const s of sugs) {
    assert.ok(/%/.test(s), `suggestion must contain a percentage; got ${JSON.stringify(s)}`);
    assert.ok(/Capture/.test(s), `suggestion must contain the verb 'Capture'; got ${JSON.stringify(s)}`);
    assert.ok(/"[^"]+"/.test(s), `suggestion must quote a token; got ${JSON.stringify(s)}`);
  }
  // At least one of the suggestions should call out "refund" — the dominant
  // production token absent from training.
  assert.ok(sugs.some((s) => s.includes('"refund"')),
    `at least one suggestion should call out "refund"; got ${JSON.stringify(sugs)}`);
});

// =============================================================================
// 11) shouldAlert: true iff jsd >= threshold
// =============================================================================

test('W747 #11 — shouldAlert true iff jsd >= threshold', () => {
  freshDir();
  assert.equal(shouldAlert({ jsd: 0.20 }, { jsd_threshold: 0.15 }), true);
  assert.equal(shouldAlert({ jsd: 0.15 }, { jsd_threshold: 0.15 }), true,
    'shouldAlert must fire on equality');
  assert.equal(shouldAlert({ jsd: 0.14 }, { jsd_threshold: 0.15 }), false);
  // Default threshold (0.15).
  assert.equal(shouldAlert({ jsd: 0.16 }), true);
  assert.equal(shouldAlert({ jsd: 0.05 }), false);
  // Garbage input never throws + never alerts.
  assert.equal(shouldAlert(null), false);
  assert.equal(shouldAlert({}), false);
  assert.equal(shouldAlert({ jsd: 'NaN' }), false);
});

// =============================================================================
// 12) recordSketchSnapshot + latestSnapshots roundtrip + tenant-fence
// =============================================================================

test('W747 #12 — recordSketchSnapshot + latestSnapshots roundtrip + tenant-fence', () => {
  freshDir();
  const sketchA = buildDistributionSketch(['alpha alpha beta'], { top_k: 10 });
  const sketchB = buildDistributionSketch(['gamma delta'], { top_k: 10 });
  recordSketchSnapshot({ tenant_id: 'tenant_a', namespace: 'ns1', kind: 'training', sketch: sketchA });
  recordSketchSnapshot({ tenant_id: 'tenant_a', namespace: 'ns1', kind: 'production', sketch: sketchB });
  // Other tenant — different sketch under SAME namespace key.
  recordSketchSnapshot({ tenant_id: 'tenant_b', namespace: 'ns1', kind: 'training', sketch: sketchB });

  const snapsA = latestSnapshots('tenant_a', 'ns1');
  assert.ok(snapsA.training && snapsA.production, 'expected both training + production for tenant_a');
  assert.deepEqual(snapsA.training.sketch, sketchA, 'training sketch should round-trip exactly');
  assert.deepEqual(snapsA.production.sketch, sketchB, 'production sketch should round-trip exactly');
  // Tenant-fence — tenant_b sees only its row, never tenant_a's.
  const snapsB = latestSnapshots('tenant_b', 'ns1');
  assert.ok(snapsB.training, 'tenant_b should see its own training snapshot');
  assert.deepEqual(snapsB.training.sketch, sketchB,
    'tenant_b training should be its OWN sketch, not tenant_a leak');
  assert.equal(snapsB.production, null,
    'tenant_b should NOT see tenant_a production snapshot');
  // Invalid kind → throws.
  assert.throws(
    () => recordSketchSnapshot({ tenant_id: 'tenant_a', namespace: 'ns1', kind: 'evil', sketch: sketchA }),
    /invalid_kind|kind must be one of/,
  );
});

// =============================================================================
// 13) registerWebhook upserts (no duplicates for same url)
// =============================================================================

test('W747 #13 — registerWebhook upserts; second register for same url UPDATES', () => {
  freshDir();
  const url = 'https://hooks.example.com/kolm-drift';
  registerWebhook({ tenant_id: 't1', namespace: 'ns', webhook_url: url, jsd_threshold: 0.15 });
  registerWebhook({ tenant_id: 't1', namespace: 'ns', webhook_url: url, jsd_threshold: 0.10 });
  const list = listWebhooks('t1', 'ns');
  assert.equal(list.length, 1,
    `same url registered twice MUST be one row (upsert); got ${list.length}`);
  assert.equal(list[0].jsd_threshold, 0.10,
    `second register must UPDATE threshold to 0.10; got ${list[0].jsd_threshold}`);
  // A different url is a separate row.
  registerWebhook({ tenant_id: 't1', namespace: 'ns', webhook_url: 'https://other.example.com/h' });
  assert.equal(listWebhooks('t1', 'ns').length, 2);
  // Bad URL → throws.
  assert.throws(
    () => registerWebhook({ tenant_id: 't1', namespace: 'ns', webhook_url: 'ftp://nope' }),
    /invalid_webhook_url|must be an absolute http/,
  );
  // Tenant fence on listWebhooks.
  assert.equal(listWebhooks('t2', 'ns').length, 0);
});

// =============================================================================
// 14) registerDriftWarning + consumeDriftWarning are one-shot semantics
// =============================================================================

test('W747 #14 — registerDriftWarning + consumeDriftWarning are one-shot', () => {
  freshDir();
  // Nothing pending → consume returns null.
  assert.equal(consumeDriftWarning('t1', 'ns'), null);
  // Register, peek, consume, consume again.
  registerDriftWarning('t1', 'ns', { jsd: 0.4 });
  const peek = peekDriftWarning('t1', 'ns');
  assert.ok(peek && peek.jsd === 0.4, `peek must return the registered warning; got ${JSON.stringify(peek)}`);
  // peek does NOT clear.
  const consumed = consumeDriftWarning('t1', 'ns');
  assert.ok(consumed && consumed.jsd === 0.4, `consume must return the warning; got ${JSON.stringify(consumed)}`);
  // Consume again → null (one-shot).
  assert.equal(consumeDriftWarning('t1', 'ns'), null,
    'consume must be one-shot: a second consume returns null');
  // Tenant fence on warnings.
  registerDriftWarning('t1', 'nsX', { jsd: 0.99 });
  assert.equal(consumeDriftWarning('t2', 'nsX'), null,
    'tenant_b must NOT consume tenant_a warning');
  assert.ok(consumeDriftWarning('t1', 'nsX'),
    'tenant_a should still consume its own warning');
});

// =============================================================================
// 15) POST /v1/drift-alert/snapshot 401 without auth; 200 with envelope on auth
// =============================================================================

test('W747 #15 — POST /v1/drift-alert/snapshot 401 without auth; 200 with envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'billing', kind: 'training' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);

    // Inject some capture events under tenant + namespace so the snapshot has content.
    for (let i = 0; i < 5; i++) {
      await eventStore.appendEvent({
        tenant_id: t.id,
        namespace: 'billing',
        provider: 'test',
        model_id: 'test-model',
        prompt_redacted: 'i need a refund please ' + i,
        response_redacted: 'sure, ill refund order ' + i,
        latency_ms: 100,
        tokens_in: 5,
        tokens_out: 5,
        cost_micro_usd: 1,
      });
    }

    // Auth + snapshot training.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'billing', kind: 'training', samples_count: 50 }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.version, 'w747-v1');
    assert.equal(env.kind, 'training');
    assert.equal(env.namespace, 'billing');
    assert.ok(typeof env.sketch_total === 'number');

    // Invalid kind → 400.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'billing', kind: 'evil' }),
    });
    assert.equal(bad.status, 400);
    const badEnv = await bad.json();
    assert.equal(badEnv.error, 'invalid_kind');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) GET /v1/drift-alert/:namespace returns honest missing-snapshot envelope
// =============================================================================

test('W747 #16 — GET /v1/drift-alert/:namespace honest envelope when snapshots missing', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/nosnap`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200,
      `must be 200 (envelope says missing); got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, true);
    assert.equal(env.alert, false);
    assert.deepEqual(env.suggestions, []);
    assert.equal(env.compare, null,
      `compare must be null when snapshots missing; got ${JSON.stringify(env.compare)}`);
    assert.ok(/missing|no_snapshots/.test(String(env.reason || '')),
      `reason should mention missing snapshots; got ${JSON.stringify(env.reason)}`);
    assert.ok(typeof env.hint === 'string' && env.hint.includes('/v1/drift-alert/snapshot'),
      `hint should point to /v1/drift-alert/snapshot; got ${JSON.stringify(env.hint)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) GET /v1/drift-alert/:namespace returns alert+suggestions when JSD crosses threshold
// =============================================================================

test('W747 #17 — GET /v1/drift-alert/:namespace returns alert+suggestions when JSD crosses threshold', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  // Bypass route entirely and write known-divergent sketches via store.
  const ns = 'wave747-alert-ns';
  const trainingSketch = buildDistributionSketch(
    ['hello world hello world hello world hello world hello world'],
    { top_k: 200 },
  );
  const productionSketch = buildDistributionSketch(
    ['refund refund refund refund refund refund refund refund refund refund refund'],
    { top_k: 200 },
  );
  recordSketchSnapshot({ tenant_id: t.id, namespace: ns, kind: 'training', sketch: trainingSketch });
  recordSketchSnapshot({ tenant_id: t.id, namespace: ns, kind: 'production', sketch: productionSketch });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/${ns}`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200);
    const env = await res.json();
    assert.equal(env.ok, true);
    assert.equal(env.alert, true,
      `expected alert:true when training+production are disjoint; got ${JSON.stringify(env)}`);
    assert.ok(env.compare && env.compare.jsd >= 0.15,
      `expected JSD >= 0.15 on disjoint vocabularies; got ${env.compare && env.compare.jsd}`);
    assert.ok(Array.isArray(env.suggestions) && env.suggestions.length >= 1,
      `expected suggestions when alert fires; got ${JSON.stringify(env.suggestions)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) Webhook fires (mock fetch) with kolm_alert:'distribution_shift' body
// =============================================================================

test('W747 #18 — webhook fires with kolm_alert:distribution_shift body when alert', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  // Stand up a tiny webhook receiver server.
  const recvApp = express();
  recvApp.use(express.json({ limit: '1mb' }));
  let received = null;
  let resolveRecv = null;
  const recvPromise = new Promise((resolve) => { resolveRecv = resolve; });
  recvApp.post('/hook', (req, res) => {
    received = req.body;
    res.json({ ok: true });
    if (resolveRecv) resolveRecv(received);
  });
  const recvSrv = await new Promise((resolve) => {
    const s = http.createServer(recvApp).listen(0, '127.0.0.1', () => resolve(s));
  });
  const recvUrl = `http://127.0.0.1:${recvSrv.address().port}/hook`;

  // Main app + router.
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  // Set up snapshots that produce an alert + register the webhook.
  const ns = 'wave747-webhook-ns';
  const trainingSketch = buildDistributionSketch(
    ['hello world hello world hello world hello world hello world'],
    { top_k: 200 },
  );
  const productionSketch = buildDistributionSketch(
    ['refund refund refund refund refund refund refund refund refund'],
    { top_k: 200 },
  );
  recordSketchSnapshot({ tenant_id: t.id, namespace: ns, kind: 'training', sketch: trainingSketch });
  recordSketchSnapshot({ tenant_id: t.id, namespace: ns, kind: 'production', sketch: productionSketch });
  registerWebhook({ tenant_id: t.id, namespace: ns, webhook_url: recvUrl, jsd_threshold: 0.10 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/${ns}`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200);
    const env = await res.json();
    assert.equal(env.alert, true, `alert must fire so webhook is invoked; got ${JSON.stringify(env)}`);
    // Wait up to 2s for the fire-and-forget webhook to land.
    await Promise.race([
      recvPromise,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    assert.ok(received,
      `webhook receiver should have been invoked; received=${JSON.stringify(received)}`);
    assert.equal(received.kolm_alert, 'distribution_shift',
      `webhook body MUST have kolm_alert:'distribution_shift'; got ${JSON.stringify(received)}`);
    assert.equal(received.namespace, ns);
    assert.ok(typeof received.jsd === 'number');
    assert.ok(Array.isArray(received.top_diverging));
    assert.ok(Array.isArray(received.suggestions));
    assert.ok(typeof received.ts === 'string');
  } finally {
    await new Promise(r => srv.close(r));
    await new Promise(r => recvSrv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) W709 tie-in: when alert fires, the drift_warning is registered so the
//     next routing decision can consume it. Plus the routing-events module
//     has an explicit honest-fallback try/catch around the consume call so
//     a missing drift-alert-store does not crash routing.
// =============================================================================

test('W747 #19 — W709 tie-in: route registers drift_warning consumeable by routing-events', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const ns = 'wave747-w709-ns';
  const trainingSketch = buildDistributionSketch(
    ['hello world hello world hello world hello world hello world'],
    { top_k: 200 },
  );
  const productionSketch = buildDistributionSketch(
    ['refund refund refund refund refund refund refund refund refund'],
    { top_k: 200 },
  );
  recordSketchSnapshot({ tenant_id: t.id, namespace: ns, kind: 'training', sketch: trainingSketch });
  recordSketchSnapshot({ tenant_id: t.id, namespace: ns, kind: 'production', sketch: productionSketch });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // Nothing pending pre-call.
    assert.equal(peekDriftWarning(t.id, ns), null,
      'no warning should be pending before the route runs');
    const res = await fetch(`http://127.0.0.1:${port}/v1/drift-alert/${ns}`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200);
    const env = await res.json();
    assert.equal(env.alert, true);
    // The route should have stashed a pending warning via registerDriftWarning.
    const pending = peekDriftWarning(t.id, ns);
    assert.ok(pending, `expected a pending warning after alert; got ${JSON.stringify(pending)}`);
    assert.ok(Number.isFinite(Number(pending.jsd)), `pending warning should carry jsd; got ${JSON.stringify(pending)}`);
    // Consume + verify one-shot.
    const consumed = consumeDriftWarning(t.id, ns);
    assert.ok(consumed && Math.abs(consumed.jsd - pending.jsd) < 1e-12);
    assert.equal(consumeDriftWarning(t.id, ns), null,
      'second consume must be null (one-shot)');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }

  // Honest fallback proof: src/routing-events.js MUST wrap the consume call in
  // a try/catch so a missing/broken drift-alert-store cannot crash routing.
  const re = fs.readFileSync(ROUTING_EVENTS_PATH, 'utf8');
  assert.ok(re.includes('consumeDriftWarning'),
    `routing-events.js must reference consumeDriftWarning (W709 tie-in)`);
  // Robust check: find the FUNCTION CALL (consumeDriftWarning followed by `(`)
  // and ensure it sits inside a try/catch block — i.e. nearest preceding `try {`
  // exists AND nearest following `catch (` exists. The "consumeDriftWarning"
  // substring also appears in comments; we restrict to the call site by
  // searching for "consumeDriftWarning(".
  const consumeCallIdx = re.indexOf('consumeDriftWarning(');
  assert.ok(consumeCallIdx >= 0,
    `expected an actual consumeDriftWarning(...) call site in routing-events.js`);
  const tryIdx = re.lastIndexOf('try {', consumeCallIdx);
  const catchIdx = re.indexOf('catch (', consumeCallIdx);
  assert.ok(tryIdx >= 0 && consumeCallIdx > tryIdx && catchIdx > consumeCallIdx,
    `consumeDriftWarning(...) call must be wrapped in try/catch (honest fallback); ` +
    `tryIdx=${tryIdx}, consumeCallIdx=${consumeCallIdx}, catchIdx=${catchIdx}`);
});

// =============================================================================
// 20) public/account/drift-alert.html has brand-lock + JSD pill + suggestion render
// =============================================================================

test('W747 #20 — public/account/drift-alert.html exists with brand-lock + JSD pill', () => {
  freshDir();
  assert.ok(fs.existsSync(ACCT_PATH), `expected account page at ${ACCT_PATH}`);
  const html = fs.readFileSync(ACCT_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-foot',                                   // footer shell (W902 unified ks-footer -> ks-foot, commit fe519704)
    'Open-source AI workbench',                  // W747 eyebrow brand lock
    'Frontier AI on your own infrastructure',    // W747 H1 brand lock
    '/v1/drift-alert',                           // fetch surface
    'jsd',                                       // JSD label / pill
    'top_diverging',                             // diverging tokens table
    'suggestion',                                // suggestion render
    'webhook',                                   // webhook config form
  ]) {
    assert.ok(html.includes(needle),
      `account/drift-alert.html must mention "${needle}"`);
  }
});

// =============================================================================
// 21) public/docs/drift-alert.html has brand-lock + KL/JSD math + W709 note
// =============================================================================

test('W747 #21 — public/docs/drift-alert.html exists with brand-lock + math + W709 note', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-foot',                                   // footer shell (W902 unified ks-footer -> ks-foot, commit fe519704)
    'Open-source AI workbench',                  // W747 eyebrow brand lock
    'Frontier AI on your own infrastructure',    // W747 H1 brand lock
    'w747-v1',                                   // version stamp
    'KL',                                        // math: KL divergence
    'Jensen-Shannon',                            // math: JSD
    'webhook',                                   // webhook schema
    'kolm_alert',                                // webhook payload key
    'distribution_shift',                        // webhook payload value
    'routing-decision tie-in',                   // W709 routing tie-in note (commit 3a57dd4f scrubbed the internal "W709" wave-tag from public copy; section heading + id="w709" anchor remain)
    'drift_warning',                             // tie-in field
    '/v1/drift-alert',                           // API surface
  ]) {
    assert.ok(html.includes(needle),
      `docs/drift-alert.html must mention "${needle}"`);
  }
});

// =============================================================================
// 22) vercel.json has both /docs/drift-alert + /account/drift-alert rewrites
// =============================================================================

test('W747 #22 — vercel.json contains /docs/drift-alert + /account/drift-alert rewrites', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = (v.rewrites || []);
  const docRewrite = rewrites.find((r) => r.source === '/docs/drift-alert');
  assert.ok(docRewrite, '/docs/drift-alert rewrite must exist in vercel.json');
  assert.equal(docRewrite.destination, '/docs/drift-alert.html');
  const acctRewrite = rewrites.find((r) => r.source === '/account/drift-alert');
  assert.ok(acctRewrite, '/account/drift-alert rewrite must exist in vercel.json');
  assert.equal(acctRewrite.destination, '/account/drift-alert.html');
});

// =============================================================================
// 23) cli/kolm.js defines cmdW747DriftAlert exactly once + wired from case 'drift-alert'
// =============================================================================

test('W747 #23 — cli/kolm.js defines cmdW747DriftAlert dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW747DriftAlert\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW747DriftAlert dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]drift-alert['"]/.test(cli),
    `cli must have a case 'drift-alert' arm`);
  assert.ok(cli.includes('cmdW747DriftAlert(rest)'),
    `cmdW747DriftAlert must be invoked with the rest args`);
});

// =============================================================================
// 24) wave747 sibling test count uses wave(\d{3,4}) regex + threshold
// =============================================================================

test('W747 #24 — wave747 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
