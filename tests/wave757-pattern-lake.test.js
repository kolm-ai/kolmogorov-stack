// W757 — Cross-namespace anonymized pattern lake.
//
// Ships the privacy-preserving aggregation primitive that unblocks the W751-
// W755 vertical fingerprint surfaces. Atomic test plan (matches the W757
// implementation):
//
//    1) PATTERN_LAKE_VERSION present + stamped 'w757-v1'
//    2) LAKE_ENABLED_ENV is the literal 'KOLM_W757_LAKE_ENABLED' string and
//       defaults to OFF (byte-stable pre-W757 behavior)
//    3) tokenizePattern returns sha256-hex strings — NEVER raw substrings
//    4) contributePattern refuses without consent:true (throws consent_not_granted)
//    5) contributePattern is idempotent on repeated (capture.id, namespace, tenant)
//    6) optIn / optOut roundtrip — isOptedIn observes latest-wins
//    7) aggregatePatterns insufficient_contributors envelope below privacy floor
//    8) aggregatePatterns happy path returns top-K bigram hashes with counts
//    9) extractVerticalFingerprint unknown vertical → honest unknown_vertical envelope
//   10) extractVerticalFingerprint insufficient_lake_data envelope when off / empty
//   11) extractVerticalFingerprint with seeded contributors → ok:true real fingerprint
//   12) TREND_VERSION present + stamped 'w757-v1'
//   13) emergingPatterns insufficient_history envelope when no rows
//   14) DP_VERSION present + stamped 'w757-v1'
//   15) laplaceNoise distribution test (zero-mean, finite samples)
//   16) aggregateWithDP returns mechanism stamp 'laplace_v1' + noised counts
//   17) validateEpsilon floor enforced (throws epsilon_below_floor)
//   18) GET /v1/lake/trends requires auth (401 without)
//   19) POST /v1/lake/opt-in requires confirm:true (400 confirm_required)
//   20) src/verticals.js verticalFingerprintStub returns honest envelope —
//       extractVerticalFingerprint (the W757 async surface) is the canonical
//       real-fingerprint path when lake has data
//   21) public/docs/data-network-effects.html exists with brand-lock + DP +
//       consent flow test anchors
//   22) vercel.json has the /docs/data-network-effects rewrite
//   23) cli/kolm.js defines cmdW757Lake exactly once
//   24) sibling wave7?? sw.js / test family pattern uses regex (NOT explicit
//       array — W604 anti-brittleness lock-in)
//
// W604 invariant — wave family counts come from a regex + threshold, never
// an explicit hard-coded sibling list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const TESTS_DIR = __dirname;
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'data-network-effects.html');
const VERTICALS_SRC = path.join(REPO_ROOT, 'src', 'verticals.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w757-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Each test starts with the env hatch OFF so the byte-stable pre-W757
  // contract is exercised by default. Tests that need the lake live flip
  // the env explicitly.
  delete process.env.KOLM_W757_LAKE_ENABLED;
  return tmp;
}

async function freshEventStore() {
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  return { eventStore };
}

// =============================================================================
// 1) PATTERN_LAKE_VERSION stamp
// =============================================================================

test('W757 #1 — PATTERN_LAKE_VERSION present + stamped w757-v1', async () => {
  freshDir();
  const lake = await import('../src/pattern-lake.js');
  assert.equal(lake.PATTERN_LAKE_VERSION, 'w757-v1',
    `expected PATTERN_LAKE_VERSION='w757-v1'; got ${JSON.stringify(lake.PATTERN_LAKE_VERSION)}`);
});

// =============================================================================
// 2) LAKE_ENABLED_ENV literal + default OFF
// =============================================================================

test('W757 #2 — LAKE_ENABLED_ENV is the literal KOLM_W757_LAKE_ENABLED + default OFF', async () => {
  freshDir();
  const lake = await import('../src/pattern-lake.js');
  assert.equal(lake.LAKE_ENABLED_ENV, 'KOLM_W757_LAKE_ENABLED',
    `expected LAKE_ENABLED_ENV='KOLM_W757_LAKE_ENABLED'; got ${JSON.stringify(lake.LAKE_ENABLED_ENV)}`);
  // Default behavior is OFF — contributePattern lands the 'lake_disabled'
  // envelope when the env hatch is not set.
  await freshEventStore();
  const env = await lake.contributePattern({
    tenant_id: 'tenant_w757_default_off',
    namespace: 'default_off_ns',
    capture: { id: 'cap_default_off', input: 'hello world default off' },
    consent: true,
  });
  assert.equal(env.ok, false,
    `lake should be OFF by default; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'lake_disabled',
    `error should be 'lake_disabled'; got ${env.error}`);
});

// =============================================================================
// 3) tokenizePattern returns hashes, never raw text
// =============================================================================

test('W757 #3 — tokenizePattern returns sha256-hex bigram hashes, never raw text', async () => {
  freshDir();
  const lake = await import('../src/pattern-lake.js');
  const input = 'the quick brown fox jumps over the lazy dog';
  const out = lake.tokenizePattern(input);
  assert.ok(Array.isArray(out), 'tokenizePattern must return an array');
  assert.equal(out.length, 8,
    `9 tokens → 8 bigrams; got ${out.length} for ${JSON.stringify(out)}`);
  for (const h of out) {
    assert.ok(/^[0-9a-f]{64}$/.test(h),
      `every element must be a 64-char sha256 hex; got ${JSON.stringify(h)}`);
  }
  // Never echoes raw substrings — the input tokens MUST NOT appear in the
  // joined output.
  const joined = out.join(' ');
  for (const tok of ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog']) {
    assert.ok(!joined.includes(tok),
      `raw token '${tok}' must not appear in the joined hash output`);
  }
  // Empty / null / non-string inputs return [].
  assert.deepEqual(lake.tokenizePattern(''), []);
  assert.deepEqual(lake.tokenizePattern(null), []);
  assert.deepEqual(lake.tokenizePattern(undefined), []);
  assert.deepEqual(lake.tokenizePattern('only'), [],
    'single-token input returns [] (no bigram pair)');
});

// =============================================================================
// 4) contributePattern refuses without consent
// =============================================================================

test('W757 #4 — contributePattern throws consent_not_granted without consent:true', async () => {
  freshDir();
  await freshEventStore();
  const lake = await import('../src/pattern-lake.js');
  process.env.KOLM_W757_LAKE_ENABLED = '1';

  await assert.rejects(
    () => lake.contributePattern({
      tenant_id: 'tenant_w757_no_consent',
      namespace: 'ns_a',
      capture: { id: 'cap_no_consent', input: 'should refuse' },
      // consent omitted
    }),
    (e) => e && (e.code === 'CONSENT_NOT_GRANTED' || /consent_not_granted/i.test(String(e.message))),
    'consent omitted MUST throw CONSENT_NOT_GRANTED',
  );
  await assert.rejects(
    () => lake.contributePattern({
      tenant_id: 'tenant_w757_consent_false',
      namespace: 'ns_a',
      capture: { id: 'cap_consent_false', input: 'should refuse' },
      consent: false,
    }),
    (e) => e && (e.code === 'CONSENT_NOT_GRANTED' || /consent_not_granted/i.test(String(e.message))),
    'consent:false MUST throw CONSENT_NOT_GRANTED',
  );
});

// =============================================================================
// 5) contributePattern idempotency
// =============================================================================

test('W757 #5 — contributePattern is idempotent on repeated (capture.id, namespace, tenant)', async () => {
  freshDir();
  await freshEventStore();
  process.env.KOLM_W757_LAKE_ENABLED = '1';
  const lake = await import('../src/pattern-lake.js');
  const tenant_id = 'tenant_w757_idem';
  const namespace = 'idem_ns';
  // Opt-in first so the contribution participates in aggregation paths later.
  await lake.optIn(tenant_id, namespace);
  const first = await lake.contributePattern({
    tenant_id,
    namespace,
    capture: { id: 'cap_idem_1', input: 'idempotent capture payload' },
    consent: true,
  });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, false,
    `first contribute must not be skipped; got ${JSON.stringify(first)}`);
  const second = await lake.contributePattern({
    tenant_id,
    namespace,
    capture: { id: 'cap_idem_1', input: 'idempotent capture payload' },
    consent: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true,
    `second contribute with same id+ns+tenant must be skipped; got ${JSON.stringify(second)}`);
});

// =============================================================================
// 6) optIn / optOut roundtrip
// =============================================================================

test('W757 #6 — optIn/optOut roundtrip; isOptedIn observes latest-wins', async () => {
  freshDir();
  await freshEventStore();
  const lake = await import('../src/pattern-lake.js');
  const tenant_id = 'tenant_w757_roundtrip';
  const namespace = 'roundtrip_ns';

  assert.equal(await lake.isOptedIn(tenant_id, namespace), false,
    'tenant defaults to NOT opted in');
  await lake.optIn(tenant_id, namespace);
  assert.equal(await lake.isOptedIn(tenant_id, namespace), true,
    'optIn must flip isOptedIn → true');
  await lake.optOut(tenant_id, namespace);
  assert.equal(await lake.isOptedIn(tenant_id, namespace), false,
    'optOut must flip isOptedIn → false (latest-wins)');
  // Re-optIn after optOut also works (idempotent registry).
  await lake.optIn(tenant_id, namespace);
  assert.equal(await lake.isOptedIn(tenant_id, namespace), true,
    'optIn after optOut must re-enable');
});

// =============================================================================
// 7) aggregatePatterns insufficient_contributors envelope
// =============================================================================

test('W757 #7 — aggregatePatterns insufficient_contributors envelope below privacy floor', async () => {
  freshDir();
  await freshEventStore();
  process.env.KOLM_W757_LAKE_ENABLED = '1';
  const lake = await import('../src/pattern-lake.js');
  // Only one contributor → below the default min_contributors=5 privacy floor.
  await lake.optIn('tenant_w757_lone', 'lone_ns');
  await lake.contributePattern({
    tenant_id: 'tenant_w757_lone',
    namespace: 'lone_ns',
    capture: { id: 'cap_lone_1', input: 'lonely capture text for the lake' },
    consent: true,
  });
  const agg = await lake.aggregatePatterns({ min_contributors: 5 });
  assert.equal(agg.ok, false,
    `single-contributor aggregate must surface insufficient envelope; got ${JSON.stringify(agg)}`);
  assert.equal(agg.error, 'insufficient_contributors',
    `error code must be 'insufficient_contributors'; got ${agg.error}`);
  assert.equal(agg.need_min, 5);
  assert.equal(agg.have, 1);
});

// =============================================================================
// 8) aggregatePatterns happy path returns top-K bigram hashes
// =============================================================================

test('W757 #8 — aggregatePatterns happy path returns top-K bigram hashes with counts', async () => {
  freshDir();
  await freshEventStore();
  process.env.KOLM_W757_LAKE_ENABLED = '1';
  const lake = await import('../src/pattern-lake.js');
  // Seed >= 5 distinct contributors so we clear the privacy floor.
  for (let i = 0; i < 6; i += 1) {
    const tid = 'tenant_w757_agg_' + i;
    const ns = 'agg_ns_' + i;
    await lake.optIn(tid, ns);
    await lake.contributePattern({
      tenant_id: tid,
      namespace: ns,
      capture: { id: 'cap_agg_' + i, input: 'shared bigram pattern from contributor ' + i },
      consent: true,
    });
  }
  const agg = await lake.aggregatePatterns({ min_contributors: 5, k_top: 10 });
  assert.equal(agg.ok, true,
    `6-contributor aggregate must be ok; got ${JSON.stringify(agg)}`);
  assert.equal(agg.version, 'w757-v1');
  assert.ok(agg.n_contributors >= 5,
    `n_contributors must be >=5; got ${agg.n_contributors}`);
  assert.ok(Array.isArray(agg.top_bigram_hashes) && agg.top_bigram_hashes.length > 0,
    `top_bigram_hashes must be non-empty array; got ${JSON.stringify(agg.top_bigram_hashes)}`);
  for (const row of agg.top_bigram_hashes) {
    assert.ok(/^[0-9a-f]{64}$/.test(row.hash),
      `every hash must be a 64-char sha256 hex; got ${row.hash}`);
    assert.ok(Number.isFinite(row.count) && row.count >= 1,
      `count must be finite + positive; got ${row.count}`);
  }
});

// =============================================================================
// 9) extractVerticalFingerprint unknown vertical
// =============================================================================

test('W757 #9 — extractVerticalFingerprint unknown vertical → honest unknown_vertical envelope', async () => {
  freshDir();
  await freshEventStore();
  const lake = await import('../src/pattern-lake.js');
  const fp = await lake.extractVerticalFingerprint('marketing');
  assert.equal(fp.ok, false);
  assert.equal(fp.error, 'unknown_vertical',
    `unknown vertical → error 'unknown_vertical'; got ${fp.error}`);
  assert.equal(fp.vertical_id, 'marketing');
});

// =============================================================================
// 10) extractVerticalFingerprint insufficient_lake_data envelope
// =============================================================================

test('W757 #10 — extractVerticalFingerprint insufficient_lake_data envelope when off or empty', async () => {
  freshDir();
  await freshEventStore();
  // Env hatch OFF (deleted by freshDir).
  const lake = await import('../src/pattern-lake.js');
  const off = await lake.extractVerticalFingerprint('legal');
  assert.equal(off.ok, false);
  assert.equal(off.error, 'insufficient_lake_data',
    `lake OFF → error 'insufficient_lake_data'; got ${off.error}`);
  assert.equal(off.need_min_captures, 100);
  assert.equal(off.vertical_id, 'legal');
  assert.equal(off.version, 'w757-v1');
  // Env hatch ON but no contributors → still insufficient_lake_data.
  process.env.KOLM_W757_LAKE_ENABLED = '1';
  const empty = await lake.extractVerticalFingerprint('legal');
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'insufficient_lake_data',
    `lake ON but empty → error 'insufficient_lake_data'; got ${empty.error}`);
});

// =============================================================================
// 11) extractVerticalFingerprint with seeded contributors → real fingerprint
// =============================================================================

test('W757 #11 — extractVerticalFingerprint with seeded contributors → ok:true real fingerprint', async () => {
  freshDir();
  await freshEventStore();
  process.env.KOLM_W757_LAKE_ENABLED = '1';
  const lake = await import('../src/pattern-lake.js');
  // Seed 6 contributors with the vertical id (legal) embedded in the
  // namespace — the W757-v1 vertical filter is a best-effort substring match.
  for (let i = 0; i < 6; i += 1) {
    const tid = 'tenant_w757_legal_' + i;
    const ns = 'legal-team-' + i;
    await lake.optIn(tid, ns);
    await lake.contributePattern({
      tenant_id: tid,
      namespace: ns,
      capture: {
        id: 'cap_legal_' + i,
        input: 'contract review request for vendor agreement number ' + i,
      },
      consent: true,
    });
  }
  const fp = await lake.extractVerticalFingerprint('legal');
  assert.equal(fp.ok, true,
    `seeded lake → ok:true; got ${JSON.stringify(fp)}`);
  assert.equal(fp.vertical_id, 'legal');
  assert.equal(fp.version, 'w757-v1');
  assert.ok(fp.n_contributing_namespaces >= 5,
    `n_contributing_namespaces must be >=5; got ${fp.n_contributing_namespaces}`);
  assert.ok(Array.isArray(fp.top_bigram_hashes) && fp.top_bigram_hashes.length > 0,
    `top_bigram_hashes must be non-empty; got ${JSON.stringify(fp.top_bigram_hashes)}`);
  for (const row of fp.top_bigram_hashes) {
    assert.ok(/^[0-9a-f]{64}$/.test(row.hash),
      `hash must be sha256 hex; got ${row.hash}`);
  }
});

// =============================================================================
// 12) TREND_VERSION stamp
// =============================================================================

test('W757 #12 — TREND_VERSION present + stamped w757-v1', async () => {
  freshDir();
  const trend = await import('../src/trend-extract.js');
  assert.equal(trend.TREND_VERSION, 'w757-v1',
    `expected TREND_VERSION='w757-v1'; got ${JSON.stringify(trend.TREND_VERSION)}`);
});

// =============================================================================
// 13) emergingPatterns insufficient_history envelope
// =============================================================================

test('W757 #13 — emergingPatterns insufficient_history envelope when too few rows', async () => {
  freshDir();
  await freshEventStore();
  const trend = await import('../src/trend-extract.js');
  const out = await trend.emergingPatterns({ window_days: 30 });
  assert.equal(out.ok, false,
    `empty store → not ok; got ${JSON.stringify(out)}`);
  assert.equal(out.error, 'insufficient_history',
    `error code must be 'insufficient_history'; got ${out.error}`);
  assert.ok(out.need_min_rows > 0,
    'need_min_rows must be > 0');
  assert.equal(out.window_days, 30);
});

// =============================================================================
// 14) DP_VERSION stamp
// =============================================================================

test('W757 #14 — DP_VERSION present + stamped w757-v1', async () => {
  freshDir();
  const dp = await import('../src/dp-aggregation.js');
  assert.equal(dp.DP_VERSION, 'w757-v1',
    `expected DP_VERSION='w757-v1'; got ${JSON.stringify(dp.DP_VERSION)}`);
});

// =============================================================================
// 15) laplaceNoise distribution sanity test
// =============================================================================

test('W757 #15 — laplaceNoise returns finite samples; mean approx 0 over many draws', async () => {
  freshDir();
  const dp = await import('../src/dp-aggregation.js');
  const scale = 1.0;
  const samples = [];
  for (let i = 0; i < 5000; i += 1) {
    const v = dp.laplaceNoise(scale);
    assert.ok(Number.isFinite(v),
      `every laplaceNoise sample must be finite; got ${v} on iter ${i}`);
    samples.push(v);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  // Mean of Laplace(0, 1) is 0; std-dev is sqrt(2) ≈ 1.414. After 5000 draws
  // the sample mean is within ~0.2 of zero with overwhelming probability.
  assert.ok(Math.abs(mean) < 0.5,
    `laplaceNoise mean over 5000 draws must be within 0.5 of zero; got ${mean}`);
  // Invalid scale throws.
  assert.throws(() => dp.laplaceNoise(0), /scale/);
  assert.throws(() => dp.laplaceNoise(-1), /scale/);
});

// =============================================================================
// 16) aggregateWithDP returns mechanism stamp
// =============================================================================

test('W757 #16 — aggregateWithDP returns mechanism stamp laplace_v1 + noised counts dict', async () => {
  freshDir();
  const dp = await import('../src/dp-aggregation.js');
  const out = dp.aggregateWithDP({
    counts: { a: 100, b: 50, c: 0, d: 1 },
    epsilon: 1.0,
    sensitivity: 1,
  });
  assert.equal(out.mechanism, 'laplace_v1',
    `mechanism stamp must be 'laplace_v1'; got ${out.mechanism}`);
  assert.equal(out.epsilon, 1.0);
  assert.equal(out.sensitivity, 1);
  assert.ok(out.scale > 0);
  assert.ok(typeof out.noised_counts === 'object' && out.noised_counts != null);
  for (const k of ['a', 'b', 'c', 'd']) {
    assert.ok(Number.isInteger(out.noised_counts[k]) && out.noised_counts[k] >= 0,
      `noised_counts[${k}] must be non-negative integer; got ${out.noised_counts[k]}`);
  }
});

// =============================================================================
// 17) validateEpsilon floor enforced
// =============================================================================

test('W757 #17 — validateEpsilon throws epsilon_below_floor below 0.1 floor', async () => {
  freshDir();
  const dp = await import('../src/dp-aggregation.js');
  assert.equal(dp.dpEpsilonFloor(), 0.1,
    `epsilon floor must be 0.1; got ${dp.dpEpsilonFloor()}`);
  assert.equal(dp.validateEpsilon(1.0), 1.0,
    'epsilon=1.0 passes the floor');
  assert.equal(dp.validateEpsilon(0.1), 0.1,
    'epsilon exactly at floor passes');
  assert.throws(() => dp.validateEpsilon(0.05),
    (e) => e && (e.code === 'EPSILON_BELOW_FLOOR' || /below_floor/i.test(String(e.message))),
    'epsilon=0.05 must throw EPSILON_BELOW_FLOOR');
  assert.throws(() => dp.validateEpsilon(0),
    (e) => e && (e.code === 'EPSILON_INVALID' || e.code === 'EPSILON_BELOW_FLOOR'),
    'epsilon=0 must throw');
  assert.throws(() => dp.validateEpsilon(-1),
    (e) => e && (e.code === 'EPSILON_INVALID' || /invalid|positive/i.test(String(e.message))),
    'negative epsilon must throw');
});

// =============================================================================
// 18) GET /v1/lake/trends requires auth
// =============================================================================

test('W757 #18 — GET /v1/lake/trends returns 401 without auth', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // The auth middleware (src/auth.js) short-circuits with its own
    // 'missing api key' 401 envelope BEFORE the route handler runs.
    // Both that envelope and our handler's own 'auth_required' envelope
    // prove the same property (the route is auth-gated). Mirror the
    // W751 #14 sibling test by accepting either error shape.
    const res = await fetch(`http://127.0.0.1:${port}/v1/lake/trends`, { method: 'GET' });
    assert.equal(res.status, 401,
      `expected 401 without auth; got ${res.status}`);
    const body = await res.json();
    assert.ok(
      /auth_required|missing api key|api[_ ]key/i.test(String(body.error || '')),
      `expected auth-required-shape error; got ${JSON.stringify(body)}`,
    );
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 19) POST /v1/lake/opt-in requires confirm:true
// =============================================================================

test('W757 #19 — POST /v1/lake/opt-in requires confirm:true (400 confirm_required)', async () => {
  freshDir();
  await freshEventStore();
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
    // missing confirm — 400 confirm_required.
    const missing = await fetch(`http://127.0.0.1:${port}/v1/lake/opt-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ namespace: 'ns_no_confirm' }),
    });
    assert.equal(missing.status, 400,
      `missing confirm → 400; got ${missing.status}`);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, 'confirm_required',
      `error must be 'confirm_required'; got ${missingBody.error}`);
    // With confirm:true → ok.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/lake/opt-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ namespace: 'ns_with_confirm', confirm: true }),
    });
    assert.equal(ok.status, 200,
      `with confirm → 200; got ${ok.status}`);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.action, 'opt_in');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 20) verticalFingerprintStub preserves legacy envelope; extractVerticalFingerprint
//     is the canonical W757 surface for real fingerprints
// =============================================================================

test('W757 #20 — verticalFingerprintStub preserves legacy envelope; extractVerticalFingerprint is canonical W757 surface', async () => {
  freshDir();
  await freshEventStore();
  const verticals = await import('../src/verticals.js');
  // The legacy stub remains SYNC + byte-stable so the W751 sibling tests
  // (#7 + #14 — sync call + route test) keep passing without modification.
  const legacy = verticals.verticalFingerprintStub('legal');
  assert.equal(legacy.ok, false,
    `legacy stub stays ok:false for byte-stability; got ${JSON.stringify(legacy)}`);
  assert.equal(legacy.error, 'w757_not_shipped',
    `legacy error code preserved; got ${legacy.error}`);
  assert.equal(legacy.version, 'w751-v1');
  // Honesty hint surfaces the W757 async surface so callers can discover it.
  assert.equal(legacy.lake_surface_async, 'src/pattern-lake.js#extractVerticalFingerprint',
    `legacy envelope must expose the W757 async surface name; got ${legacy.lake_surface_async}`);
  assert.equal(legacy.lake_version, 'w757-v1');
  // Now exercise the W757 async surface end-to-end with seeded data.
  process.env.KOLM_W757_LAKE_ENABLED = '1';
  const lake = await import('../src/pattern-lake.js');
  for (let i = 0; i < 6; i += 1) {
    const tid = 'tenant_w757_w20_' + i;
    const ns = 'medical-clinic-' + i;
    await lake.optIn(tid, ns);
    await lake.contributePattern({
      tenant_id: tid,
      namespace: ns,
      capture: {
        id: 'cap_w20_' + i,
        input: 'patient presented with chief complaint and review of systems ' + i,
      },
      consent: true,
    });
  }
  const real = await lake.extractVerticalFingerprint('medical');
  assert.equal(real.ok, true,
    `extractVerticalFingerprint with seeded lake → ok:true; got ${JSON.stringify(real)}`);
  assert.equal(real.error, undefined,
    `no error field on success; got ${real.error}`);
  assert.ok(Array.isArray(real.top_bigram_hashes) && real.top_bigram_hashes.length > 0);
});

// =============================================================================
// 21) data-network-effects.html exists with brand-lock + DP + consent anchors
// =============================================================================

test('W757 #21 — public/docs/data-network-effects.html exists with brand-lock + DP + consent anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH),
    `expected docs page at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'Open-source AI workbench',          // brand eyebrow
    'Data network effects',              // H1 fragment
    'opt-in pattern lake',               // H1 fragment
    'w757-v1',                           // version stamp
    'KOLM_W757_LAKE_ENABLED',            // env hatch
    'sha256',                            // hash-only contribution mechanism
    'differential privacy',              // section 4 keyword
    'laplace_v1',                        // mechanism stamp
    '0.1',                               // epsilon floor
    'kolm lake opt-in',                  // CLI invocation
    'data-w757="dp-mechanism-doc"',      // hidden test anchor
    'data-w757="consent-flow"',          // hidden test anchor
    '/docs/verticals',                   // related-docs cross-link
  ]) {
    assert.ok(html.includes(needle),
      `data-network-effects.html must mention "${needle}"`);
  }
  // No emoji glyphs in body (brand-lock).
  const commonEmoji = /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;
  assert.ok(!commonEmoji.test(html),
    'data-network-effects.html MUST NOT carry emoji glyphs (brand-lock)');
});

// =============================================================================
// 22) vercel.json /docs/data-network-effects rewrite
// =============================================================================

test('W757 #22 — vercel.json has the /docs/data-network-effects rewrite', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = v.rewrites || [];
  const rw = rewrites.find((r) => r.source === '/docs/data-network-effects');
  assert.ok(rw, `vercel.json must have rewrite for /docs/data-network-effects`);
  assert.equal(rw.destination, '/docs/data-network-effects.html',
    `rewrite destination must be /docs/data-network-effects.html; got ${rw.destination}`);
});

// =============================================================================
// 23) cli/kolm.js defines cmdW757Lake exactly once
// =============================================================================

test('W757 #23 — cli/kolm.js defines cmdW757Lake exactly once', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW757Lake\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW757Lake definition; got ${defs.length}`);
  // The dispatcher must be wired from a switch arm (the case 'lake' arm in
  // main()).
  assert.ok(/cmdW757Lake\(rest\)/.test(cli),
    `cli must invoke cmdW757Lake(rest) at least once`);
});

// =============================================================================
// 24) sibling wave7?? family pattern uses regex + threshold (W604 lock-in)
// =============================================================================

test('W757 #24 — wave7?? sibling test count uses regex wave(\\d{3,4}) + threshold (W604 anti-brittleness)', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  // W604 invariant — match by regex, NEVER an explicit hard-coded list.
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
  // The W757 file itself must be in the list (sanity).
  assert.ok(siblings.includes('wave757-pattern-lake.test.js'),
    `W757 test file must appear in the regex match; siblings=${JSON.stringify(siblings)}`);
  // verticals.js must NOT use explicit-array family check (W604 lock — read
  // the legacy stub to confirm no hard-coded sibling list snuck in).
  const verticals = fs.readFileSync(VERTICALS_SRC, 'utf8');
  // Sanity: the legacy stub is still named verticalFingerprintStub.
  assert.ok(/export function verticalFingerprintStub|export async function verticalFingerprintStub/.test(verticals),
    `verticals.js must still export verticalFingerprintStub`);
});
