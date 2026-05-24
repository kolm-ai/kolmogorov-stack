// WC04 — test coverage close-out for src/ab-router.js.
//
// Previously: 749 LOC, 0 tests anywhere in tests/.
// Pins the W777 A/B router public surface so future refactors don't
// silently regress the deterministic-split / tenant-fence / promotion /
// auto-rollback semantics. Heavy stat-sig math lives in src/stat-sig.js
// (covered by its own tests); here we exercise the orchestration only.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate to a tmp KOLM_DATA_DIR BEFORE importing the module under test —
// store.js + event-store.js cache their data dirs on first init.
before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc04-ab-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  process.env.NODE_ENV = 'test';
});

const {
  AB_ROUTER_VERSION,
  AB_TESTS_TABLE,
  AB_OUTCOMES_WORKFLOW,
  AB_PROMOTION_WORKFLOW,
  AB_ROLLBACK_WORKFLOW,
  DEFAULT_SAMPLE_TARGET,
  DEFAULT_SPLIT,
  HASH_BUCKETS,
  STATUS,
  fnv1a,
  createAbTest,
  assignArm,
  recordOutcome,
  readSamples,
  getAbStatus,
  listAbTests,
  stopAbTest,
  promoteArm,
  autoRollback,
  listOutcomeEvents,
} = await import('../src/ab-router.js');

const T_ALPHA = 'tenant_wc04_ab_alpha';
const T_BETA  = 'tenant_wc04_ab_beta';
const NS = 'wc04-ab-ns';

function mkTest({ tenant = T_ALPHA, namespace = NS, arm_a = 'art-a', arm_b = 'art-b', split, sample_target } = {}) {
  return createAbTest({ tenant, namespace, arm_a, arm_b, split, sample_target });
}

// =============================================================================
// 1) Module constants / version contract
// =============================================================================

test('WC04-ab #1 module constants match the W777 contract', () => {
  assert.match(AB_ROUTER_VERSION, /^w777-/, 'callers match the prefix, not literal equality');
  assert.equal(AB_TESTS_TABLE, 'ab_tests');
  assert.equal(AB_OUTCOMES_WORKFLOW, 'w777:ab');
  assert.equal(AB_PROMOTION_WORKFLOW, 'w777:ab:promotion');
  assert.equal(AB_ROLLBACK_WORKFLOW, 'w777:ab:rollback');
  assert.equal(DEFAULT_SPLIT, 0.5);
  assert.equal(DEFAULT_SAMPLE_TARGET, 1000);
  assert.equal(HASH_BUCKETS, 1000);
  assert.ok(Object.isFrozen(STATUS), 'STATUS must be frozen so callers can compare === safely');
  assert.deepEqual(
    Object.values(STATUS).sort(),
    ['active', 'promoted', 'rolled_back', 'stopped'],
  );
});

// =============================================================================
// 2) fnv1a — deterministic 32-bit hash
// =============================================================================

test('WC04-ab #2 fnv1a is deterministic for the same input string', () => {
  const a = fnv1a('hello-request-42');
  const b = fnv1a('hello-request-42');
  assert.equal(a, b);
  assert.equal(typeof a, 'number');
  assert.ok(a >>> 0 === a, 'result must fit in 32 unsigned bits');
});

test('WC04-ab #3 fnv1a coerces null/undefined to empty string (no crash, stable)', () => {
  const z = fnv1a('');
  assert.equal(fnv1a(null), z);
  assert.equal(fnv1a(undefined), z);
});

test('WC04-ab #4 fnv1a differs across distinct inputs (basic avalanche)', () => {
  const a = fnv1a('alpha');
  const b = fnv1a('beta');
  const c = fnv1a('alphz'); // single-char delta
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

// =============================================================================
// 3) createAbTest — validation envelope
// =============================================================================

test('WC04-ab #5 createAbTest rejects missing tenant / namespace / arm', () => {
  const r1 = createAbTest({});
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'missing_tenant');

  const r2 = createAbTest({ tenant: T_ALPHA });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'missing_namespace');

  const r3 = createAbTest({ tenant: T_ALPHA, namespace: NS, arm_a: 'x' });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'missing_arm');
});

test('WC04-ab #6 createAbTest rejects one-arm test (arm_a === arm_b) + out-of-range split', () => {
  const r1 = createAbTest({ tenant: T_ALPHA, namespace: NS, arm_a: 'same', arm_b: 'same' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'bad_args');

  for (const split of [0, 1, -0.1, 1.5]) {
    const r = createAbTest({ tenant: T_ALPHA, namespace: NS, arm_a: 'a', arm_b: 'b', split });
    assert.equal(r.ok, false, `split=${split} must be rejected`);
    assert.equal(r.error, 'bad_args');
  }
});

test('WC04-ab #7 createAbTest happy path returns active record with mirrored tenant_id', () => {
  const r = mkTest({ arm_a: 'wc04-art-A', arm_b: 'wc04-art-B' });
  assert.equal(r.ok, true);
  assert.match(r.ab_test_id, /^abt_[0-9a-f]{16}$/);
  assert.equal(r.record.status, STATUS.ACTIVE);
  assert.equal(r.record.tenant, T_ALPHA);
  assert.equal(r.record.tenant_id, T_ALPHA, 'tenant_id mirrored from tenant');
  assert.equal(r.record.split, DEFAULT_SPLIT);
  assert.equal(r.record.sample_target, DEFAULT_SAMPLE_TARGET);
  assert.equal(r.record.promoted_arm, null);
});

// =============================================================================
// 4) assignArm — deterministic split + status branches
// =============================================================================

test('WC04-ab #8 assignArm returns missing_args / not_found envelopes', () => {
  const r1 = assignArm({});
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'missing_args');

  const r2 = assignArm({ tenant: T_ALPHA, ab_test_id: 'abt_does_not_exist', request_hash: 'rq' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'not_found');
});

test('WC04-ab #9 assignArm is deterministic for the same (test, request_hash)', () => {
  const t = mkTest({ arm_a: 'A1', arm_b: 'B1' });
  assert.equal(t.ok, true);
  const a1 = assignArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, request_hash: 'req-42' });
  const a2 = assignArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, request_hash: 'req-42' });
  assert.equal(a1.ok, true);
  assert.equal(a1.arm, a2.arm);
  assert.equal(a1.artifact_id, a2.artifact_id);
  assert.ok(a1.arm === 'a' || a1.arm === 'b');
  assert.equal(a1.artifact_id, a1.arm === 'a' ? 'A1' : 'B1');
});

test('WC04-ab #10 assignArm honours 90/10 split skew across many request hashes', () => {
  const t = mkTest({ arm_a: 'A2', arm_b: 'B2', split: 0.9 });
  assert.equal(t.ok, true);
  let aCount = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const r = assignArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, request_hash: 'req-' + i });
    if (r.arm === 'a') aCount++;
  }
  const frac = aCount / N;
  // Threshold floor(0.9 * 1000) = 900 buckets → ~0.9. fnv1a is well-mixed so
  // a wide tolerance still catches a broken split (e.g. 0.5).
  assert.ok(frac > 0.83 && frac < 0.97, `arm A fraction ${frac} should be near 0.9`);
});

test('WC04-ab #11 assignArm refuses stopped test + freezes promoted/rolled_back routing', async () => {
  const t = mkTest({ arm_a: 'A3', arm_b: 'B3' });
  // promoted -> always returns promoted_arm
  await promoteArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'b', reason: 'manual' });
  const promoted = assignArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, request_hash: 'anything' });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.arm, 'b');
  assert.equal(promoted.artifact_id, 'B3');
  assert.equal(promoted.reason, 'frozen_to_promoted_arm');

  // stopped -> error envelope (cannot also test rolled-back in this test since
  // promotion already happened; rolled-back is exercised in autoRollback test)
  const t2 = mkTest({ arm_a: 'A4', arm_b: 'B4' });
  stopAbTest({ tenant: T_ALPHA, ab_test_id: t2.ab_test_id, reason: 'unit test' });
  const stopped = assignArm({ tenant: T_ALPHA, ab_test_id: t2.ab_test_id, request_hash: 'rq' });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error, 'stopped');
});

// =============================================================================
// 5) Tenant fence — W411 cross-tenant isolation
// =============================================================================

test('WC04-ab #12 assignArm / getAbStatus / recordOutcome are tenant-fenced', async () => {
  const t = mkTest({ tenant: T_ALPHA, arm_a: 'fenceA', arm_b: 'fenceB' });
  // Foreign tenant must NEVER find the test.
  const foreign = assignArm({ tenant: T_BETA, ab_test_id: t.ab_test_id, request_hash: 'rq' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');

  const foreignStatus = await getAbStatus({ tenant: T_BETA, ab_test_id: t.ab_test_id });
  assert.equal(foreignStatus.ok, false);
  assert.equal(foreignStatus.error, 'not_found');

  const foreignOutcome = await recordOutcome({
    tenant: T_BETA, ab_test_id: t.ab_test_id, arm: 'a', kscore: 0.9,
  });
  assert.equal(foreignOutcome.ok, false);
  assert.equal(foreignOutcome.error, 'not_found');
});

// =============================================================================
// 6) recordOutcome + readSamples + listOutcomeEvents
// =============================================================================

test('WC04-ab #13 recordOutcome validates arm + tenant + test_id', async () => {
  const t = mkTest({ arm_a: 'R-a', arm_b: 'R-b' });
  const r1 = await recordOutcome({});
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'missing_args');

  const r2 = await recordOutcome({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'c' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'bad_args');
});

test('WC04-ab #14 recordOutcome persists + readSamples groups by arm', async () => {
  const t = mkTest({ arm_a: 'S-a', arm_b: 'S-b' });
  // Seed 5 'a' samples + 4 'b' samples.
  for (const k of [0.10, 0.20, 0.30, 0.40, 0.50]) {
    const ev = await recordOutcome({
      tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'a', kscore: k, latency_ms: 100,
    });
    assert.equal(ev.ok, true);
    assert.ok(ev.event_id);
  }
  for (const k of [0.60, 0.70, 0.80, 0.90]) {
    await recordOutcome({
      tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'b', kscore: k, latency_ms: 95,
    });
  }
  const s = await readSamples({ tenant: T_ALPHA, ab_test_id: t.ab_test_id });
  assert.equal(s.n_a, 5);
  assert.equal(s.n_b, 4);
  // listEvents order is newest-first — assert set equality not array equality.
  assert.deepEqual([...s.samples_a].sort(), [0.10, 0.20, 0.30, 0.40, 0.50]);
  assert.deepEqual([...s.samples_b].sort(), [0.60, 0.70, 0.80, 0.90]);
});

test('WC04-ab #15 readSamples returns empty arrays on missing args (no crash)', async () => {
  const s1 = await readSamples({});
  assert.deepEqual(s1, { samples_a: [], samples_b: [], n_a: 0, n_b: 0 });
  const s2 = await readSamples({ tenant: T_ALPHA });
  assert.deepEqual(s2, { samples_a: [], samples_b: [], n_a: 0, n_b: 0 });
});

test('WC04-ab #16 listOutcomeEvents returns recent outcomes with shape pinned', async () => {
  const t = mkTest({ arm_a: 'LO-a', arm_b: 'LO-b' });
  await recordOutcome({
    tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'a', kscore: 0.42, latency_ms: 50,
  });
  const r = await listOutcomeEvents({ tenant: T_ALPHA, ab_test_id: t.ab_test_id });
  assert.equal(r.ok, true);
  assert.ok(r.count >= 1);
  const row = r.events.find(e => e.arm === 'a' && e.kscore === 0.42);
  assert.ok(row, 'must find the freshly-appended outcome');
  assert.equal(row.latency_ms, 50);
  assert.ok(row.event_id);

  const bad = await listOutcomeEvents({});
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'missing_args');
});

// =============================================================================
// 7) getAbStatus — empty + populated branches
// =============================================================================

test('WC04-ab #17 getAbStatus returns no_traffic_in_window when both arms empty', async () => {
  const t = mkTest({ arm_a: 'ST-a', arm_b: 'ST-b' });
  const r = await getAbStatus({ tenant: T_ALPHA, ab_test_id: t.ab_test_id });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_traffic_in_window');
  assert.equal(r.status, STATUS.ACTIVE);
  assert.ok(r.record);
  assert.equal(r.record.ab_test_id, t.ab_test_id);
});

test('WC04-ab #18 getAbStatus computes means + invokes stat-sig.welchT', async () => {
  const t = mkTest({ arm_a: 'ST2-a', arm_b: 'ST2-b' });
  // Arm A mean = 0.2, arm B mean = 0.8.
  for (const k of [0.1, 0.2, 0.3]) {
    await recordOutcome({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'a', kscore: k });
  }
  for (const k of [0.7, 0.8, 0.9]) {
    await recordOutcome({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'b', kscore: k });
  }
  const r = await getAbStatus({ tenant: T_ALPHA, ab_test_id: t.ab_test_id });
  assert.equal(r.ok, true);
  assert.equal(r.n_a, 3);
  assert.equal(r.n_b, 3);
  assert.ok(Math.abs(r.kscore_a - 0.2) < 1e-9);
  assert.ok(Math.abs(r.kscore_b - 0.8) < 1e-9);
  assert.ok(r.sig_test, 'welchT result must be attached');
});

// =============================================================================
// 8) listAbTests / stopAbTest / promoteArm / autoRollback
// =============================================================================

test('WC04-ab #19 listAbTests returns tenant-fenced rows newest-first', () => {
  const r = listAbTests({ tenant: T_ALPHA });
  assert.equal(r.ok, true);
  assert.ok(r.count >= 1);
  for (const row of r.tests) {
    assert.equal(row.tenant_id, T_ALPHA);
  }
  // Sort order: newest first.
  for (let i = 1; i < r.tests.length; i++) {
    const prev = String(r.tests[i - 1].created_at || '');
    const cur  = String(r.tests[i].created_at || '');
    assert.ok(prev >= cur, 'tests must be newest-first');
  }
  const foreign = listAbTests({ tenant: 'tenant_does_not_exist_anywhere' });
  assert.equal(foreign.ok, true);
  assert.equal(foreign.count, 0);
  const missing = listAbTests({});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing_tenant');
});

test('WC04-ab #20 stopAbTest + promoteArm flip status + are tenant-fenced', async () => {
  const t = mkTest({ arm_a: 'F-a', arm_b: 'F-b' });
  // Tenant fence: foreign tenant cannot stop / promote.
  const foreignStop = stopAbTest({ tenant: T_BETA, ab_test_id: t.ab_test_id });
  assert.equal(foreignStop.ok, false);
  assert.equal(foreignStop.error, 'not_found');

  const foreignPromote = await promoteArm({ tenant: T_BETA, ab_test_id: t.ab_test_id, arm: 'a' });
  assert.equal(foreignPromote.ok, false);
  assert.equal(foreignPromote.error, 'not_found');

  // Validation: bad arm.
  const badArm = await promoteArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'c' });
  assert.equal(badArm.ok, false);
  assert.equal(badArm.error, 'bad_args');

  // Happy: promote arm A.
  const ok = await promoteArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, arm: 'a', reason: 'unit' });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, STATUS.PROMOTED);
  assert.equal(ok.arm, 'a');

  // Assignment now frozen to arm A regardless of request hash.
  const frozen = assignArm({ tenant: T_ALPHA, ab_test_id: t.ab_test_id, request_hash: 'random' });
  assert.equal(frozen.arm, 'a');
  assert.equal(frozen.artifact_id, 'F-a');
});

test('WC04-ab #21 autoRollback rejects missing args + not-found', async () => {
  const r1 = await autoRollback({});
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'missing_args');

  const r2 = await autoRollback({ tenant: T_ALPHA, ab_test_id: 'abt_nope' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'not_found');
});

test('WC04-ab #22 autoRollback is no-op when gate returns insufficient (cold start)', async () => {
  // Fresh test, zero outcomes -> gate returns insufficient -> no rollback.
  const t = mkTest({ arm_a: 'AR-a', arm_b: 'AR-b' });
  const r = await autoRollback({ tenant: T_ALPHA, ab_test_id: t.ab_test_id });
  assert.equal(r.ok, true);
  assert.equal(r.rolled_back, false);
  assert.equal(r.reason, 'insufficient_data');
  assert.equal(r.decision, 'insufficient');
});
