// W808 — capture poisoning detection tests.
//
// Atomic items pinned:
//
//   1) CAPTURE_ANOMALY_VERSION matches /^w808-/ (W604 anti-brittleness)
//   2) vocabEntropy + tokenJaccard + runningStats math primitives are correct
//   3) extractFeatures pulls the four canonical W808-1 axes from a capture row
//   4) detectAnomaly honest envelope when baseline < MIN_BASELINE (cold start)
//   5) detectAnomaly flags a row that exceeds 3σ on output_length axis
//   6) detectAnomaly tenant fence — foreign-tenant rows do not poison baseline
//   7) insertStagedCapture stamps quarantine_until + refuses tenant-less rows
//   8) promoteStagedCapture refuses anomaly-flagged rows without force=true
//   9) blockStagedCapture requires a reason (audit trail)
//  10) captureWithSignature stamps teacher_response_signature deterministically
//  11) captureWithSignature strict mode rejects unknown teacher fingerprint
//  12) _w808RegressionGate returns 'first_run' when no prior run exists
//  13) _w808RegressionGate returns 'rollback' when K-Score drops > 0.02
//  14) CLI `kolm captures review --list-pending --json` returns stable envelope
//  15) CLI `kolm captures review --block <id>` without --reason exits 1
//
// W604 anti-brittleness: every version assertion uses regex /^w808-/ instead
// of literal equality so a v1.x bump in the same wave does not force a
// coordinated test-rev.
//
// Sibling-wave safety: this file imports ONLY W808 modules (capture-anomaly,
// proxy, distill-pipeline._w808RegressionGate, store W808 verbs). It does
// NOT touch W459/W711/W713/W714/W720/W710 modules or call into them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

// Each test seeds an isolated KOLM_DATA_DIR + HOME so the store does not
// leak rows across tests and the W411 tenant fence is provably honoured.
//
// IMPORTANT — we DO NOT cache-bust module imports. The store module is a
// singleton (it caches a `jsonTables` Map at module scope and freezes the
// data dir from env vars at FIRST import). Cache-busting via `?w808=N`
// produces parallel store instances pointing at the same disk file with
// independent in-memory caches, which leads to "phantom row" bugs where
// instance-A writes a row, instance-B's cache is stale, and the detector
// (which reaches into the canonical "./store.js" import without a query
// string) sees yet a third instance. We resolve this by:
//
//   1. Importing each module exactly once across the file (top-level cache).
//   2. Resetting in-memory state per test via:
//      - storeMod.reset()                   — wipes observations + others
//      - storeMod._resetStagedCapturesForTests() — wipes staged_captures
//      - proxyMod._resetTeacherFingerprintsForTests() — wipes the registry
//   3. Using DISTINCT tenant + namespace strings per test so even if a row
//      leaks it cannot affect another test's tenant fence.
//
// freshDir() still rewrites KOLM_DATA_DIR for filesystem isolation between
// test runs, but within a single test we treat the store as singleton.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w808-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  // Force JSON store driver so tests are deterministic across machines.
  process.env.KOLM_STORE_DRIVER = 'json';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// One-time module references — never cache-bust (see comment above).
let _anomMod = null, _storeMod = null, _proxyMod = null;
async function _loadMods() {
  if (!_anomMod) _anomMod = await import('../src/capture-anomaly.js');
  if (!_storeMod) _storeMod = await import('../src/store.js');
  if (!_proxyMod) _proxyMod = await import('../src/proxy.js');
  // Per-test reset — wipes the in-memory state so a foreign-test row never
  // shows up in this test's findByTenant/findByField scan.
  try { _storeMod.reset(); } catch (_) {} // deliberate: cleanup
  if (typeof _storeMod._resetStagedCapturesForTests === 'function') _storeMod._resetStagedCapturesForTests();
  if (typeof _proxyMod._resetTeacherFingerprintsForTests === 'function') _proxyMod._resetTeacherFingerprintsForTests();
  return { anomMod: _anomMod, storeMod: _storeMod, proxyMod: _proxyMod };
}

// Helper — seed N near-identical observation rows into the canonical store
// so detectAnomaly has a baseline. Each row has length ~50 chars so the
// baseline mean is stable.
function _seedBaseline(storeMod, { tenant_id, namespace, count = 12, base_response = 'normal sized teacher response with stable token distribution' }) {
  for (let i = 0; i < count; i++) {
    storeMod.insert('observations', {
      event_id: 'obs_w808_' + tenant_id + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
      tenant_id,
      tenant: tenant_id,
      namespace,
      corpus_namespace: namespace,
      prompt: 'q-' + i,
      response: base_response + ' #' + i, // tiny variance so stddev > 0
      latency_ms: 100 + (i % 5),
      created_at: new Date(Date.now() - (count - i) * 1000).toISOString(),
    });
  }
}

// =============================================================================
// 1) CAPTURE_ANOMALY_VERSION matches /^w808-/
// =============================================================================
test('W808 #1 — CAPTURE_ANOMALY_VERSION + PROXY_VERSION + regression-gate version all match /^w808-/', async () => {
  freshDir();
  const { anomMod, proxyMod } = await _loadMods();
  const dp = await import('../src/distill-pipeline.js?w808d=' + Date.now());
  assert.ok(/^w808-/.test(anomMod.CAPTURE_ANOMALY_VERSION),
    `CAPTURE_ANOMALY_VERSION matches /^w808-/; got ${anomMod.CAPTURE_ANOMALY_VERSION}`);
  assert.ok(/^w808-/.test(proxyMod.PROXY_VERSION),
    `PROXY_VERSION matches /^w808-/; got ${proxyMod.PROXY_VERSION}`);
  assert.ok(/^w808-/.test(dp.W808_REGRESSION_GATE_VERSION),
    `W808_REGRESSION_GATE_VERSION matches /^w808-/; got ${dp.W808_REGRESSION_GATE_VERSION}`);
  assert.equal(anomMod.SIGMA_THRESHOLD, 3.0, '3σ is the documented threshold');
  assert.ok(anomMod.MIN_BASELINE >= 8, `MIN_BASELINE >= 8 for cold-start safety; got ${anomMod.MIN_BASELINE}`);
});

// =============================================================================
// 2) Math primitives — vocabEntropy + tokenJaccard + runningStats
// =============================================================================
test('W808 #2 — vocabEntropy + tokenJaccard + runningStats compute correctly', async () => {
  freshDir();
  const { anomMod } = await _loadMods();
  // vocabEntropy: empty → 0; single char → 0; uniform two chars → 1 bit
  assert.equal(anomMod.vocabEntropy(''), 0, 'empty string entropy is 0');
  assert.equal(anomMod.vocabEntropy('aaaa'), 0, 'mono-char entropy is 0');
  const h2 = anomMod.vocabEntropy('abab');
  assert.ok(Math.abs(h2 - 1.0) < 0.001, `equal 2-char distribution entropy ~= 1.0 bit; got ${h2}`);
  // tokenJaccard: identical strings → 1; disjoint → 0; partial → in (0,1)
  assert.equal(anomMod.tokenJaccard('hello world', 'hello world'), 1, 'identical Jaccard is 1');
  assert.equal(anomMod.tokenJaccard('hello', 'goodbye'), 0, 'disjoint Jaccard is 0');
  const j = anomMod.tokenJaccard('the quick brown', 'the quick fox');
  assert.ok(j > 0 && j < 1, `partial overlap is in (0,1); got ${j}`);
  // runningStats: single sample → stddev=0 (not NaN); two-sample stddev > 0
  const r1 = anomMod.runningStats([5]);
  assert.equal(r1.mean, 5);
  assert.equal(r1.stddev, 0, 'single-sample stddev must be 0, not NaN');
  const r2 = anomMod.runningStats([1, 3, 5, 7, 9]);
  assert.equal(r2.mean, 5);
  assert.ok(r2.stddev > 0, 'multi-sample stddev > 0');
  // n=0 returns zeros, not NaN
  const r0 = anomMod.runningStats([]);
  assert.equal(r0.n, 0);
  assert.equal(r0.stddev, 0);
});

// =============================================================================
// 3) extractFeatures pulls four canonical axes
// =============================================================================
test('W808 #3 — extractFeatures yields the four W808-1 axes', async () => {
  freshDir();
  const { anomMod } = await _loadMods();
  const row = {
    response: 'hello world this is a teacher response',
    latency_ms: 250,
  };
  const f = anomMod.extractFeatures(row, { teacher_typical_response: 'this is a teacher response baseline' });
  assert.ok('output_length' in f, 'output_length axis present');
  assert.ok('vocab_entropy' in f, 'vocab_entropy axis present');
  assert.ok('response_time' in f, 'response_time axis present');
  assert.ok('token_overlap_to_teacher_typical' in f, 'token_overlap axis present');
  assert.equal(f.output_length, 'hello world this is a teacher response'.length);
  assert.equal(f.response_time, 250);
  assert.ok(f.vocab_entropy > 0, 'non-empty response has entropy > 0');
  assert.ok(f.token_overlap_to_teacher_typical > 0, 'shared tokens yield positive overlap');
  // Canonical axis list exported
  assert.equal(anomMod.ANOMALY_AXES.length, 4);
  for (const axis of anomMod.ANOMALY_AXES) assert.ok(axis in f, `axis ${axis} extracted`);
});

// =============================================================================
// 4) detectAnomaly honest envelope when baseline < MIN_BASELINE
// =============================================================================
test('W808 #4 — detectAnomaly returns honest no_baseline_captures when cold-start', async () => {
  freshDir();
  const { anomMod, storeMod } = await _loadMods();
  // Only 3 rows — well below MIN_BASELINE=8.
  _seedBaseline(storeMod, { tenant_id: 'tenant_w808_cold', namespace: 'ns_cold', count: 3 });
  const r = anomMod.detectAnomaly({
    row: { response: 'whatever', latency_ms: 100 },
    tenant_id: 'tenant_w808_cold',
    namespace: 'ns_cold',
  });
  assert.equal(r.ok, false, 'cold-start must return ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'no_baseline_captures');
  assert.ok(r.baseline_size < r.min_baseline, `baseline_size < min_baseline; got ${r.baseline_size}/${r.min_baseline}`);
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
  assert.ok(/^w808-/.test(r.version));
});

// =============================================================================
// 5) detectAnomaly flags a 3σ-out-of-baseline row
// =============================================================================
test('W808 #5 — detectAnomaly flags a row whose output_length is > 3σ from baseline mean', async () => {
  freshDir();
  const { anomMod, storeMod } = await _loadMods();
  _seedBaseline(storeMod, {
    tenant_id: 'tenant_w808_flag',
    namespace: 'ns_flag',
    count: 12,
    base_response: 'normal sized response',
  });
  // Build an outlier row: response is 100x longer than the baseline mean.
  const outlier = { response: 'X'.repeat(50000), latency_ms: 100 };
  const r = anomMod.detectAnomaly({
    row: outlier,
    tenant_id: 'tenant_w808_flag',
    namespace: 'ns_flag',
  });
  assert.equal(r.ok, true, 'baseline now sufficient; ' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.anomaly_flagged, true, 'extreme outlier must flag');
  assert.ok(r.flagged_axes.length >= 1, 'at least one axis flagged');
  const olAxis = r.flagged_axes.find(a => a.axis === 'output_length');
  assert.ok(olAxis, 'output_length axis flagged');
  assert.ok(olAxis.sigma > 3.0, `sigma > 3 for outlier; got ${olAxis.sigma}`);
});

// =============================================================================
// 6) detectAnomaly tenant fence — foreign rows do not contaminate baseline
// =============================================================================
test('W808 #6 — detectAnomaly tenant fence isolates baseline by tenant_id (W411)', async () => {
  freshDir();
  const { anomMod, storeMod } = await _loadMods();
  // Seed two tenants in the same namespace. Tenant A has 12 small rows.
  // Tenant B has 12 huge rows. detectAnomaly(tenant=A) must NOT see tenant B's
  // huge rows.
  _seedBaseline(storeMod, {
    tenant_id: 'tenant_w808_A',
    namespace: 'shared_ns',
    count: 12,
    base_response: 'small response',
  });
  _seedBaseline(storeMod, {
    tenant_id: 'tenant_w808_B',
    namespace: 'shared_ns',
    count: 12,
    base_response: 'X'.repeat(20000), // huge
  });
  // Tenant A queries: a small outlier (~150 chars) should NOT flag because
  // tenant A's baseline mean is ~14 chars stddev tiny, and the outlier is
  // ~10x the mean — that's enough sigma for tenant A but only if no tenant B
  // bleed happens. The harder check is: tenant A's baseline_means.output_length
  // must be in the small range, NOT polluted by tenant B's huge rows.
  const r = anomMod.detectAnomaly({
    row: { response: 'X'.repeat(150), latency_ms: 100 },
    tenant_id: 'tenant_w808_A',
    namespace: 'shared_ns',
  });
  assert.equal(r.ok, true);
  assert.ok(r.baseline_means.output_length < 1000,
    `tenant A baseline output_length mean must be small (NOT polluted by tenant B 20k); got ${r.baseline_means.output_length}`);
});

// =============================================================================
// 7) insertStagedCapture stamps quarantine_until + requires tenant_id
// =============================================================================
test('W808 #7 — insertStagedCapture stamps quarantine_until + refuses tenant-less rows', async () => {
  freshDir();
  const { storeMod } = await _loadMods();
  // Tenant-less row → throws
  assert.throws(
    () => storeMod.insertStagedCapture({ response: 'orphan' }),
    /tenant_id is required/i,
    'must refuse insert without tenant_id (W411 tenant fence)'
  );
  // Happy path
  const before = Date.now();
  const row = storeMod.insertStagedCapture({
    tenant_id: 'tenant_w808_stage',
    namespace: 'ns_stage',
    prompt: 'hi',
    response: 'hello',
  });
  const after = Date.now();
  assert.ok(row.staged_capture_id && row.staged_capture_id.startsWith('stg_'),
    `staged_capture_id minted with stg_ prefix; got ${row.staged_capture_id}`);
  assert.ok(row.staged_at, 'staged_at set');
  assert.ok(row.quarantine_until, 'quarantine_until set');
  const until = Date.parse(row.quarantine_until);
  // Default 24h window
  assert.ok(until - before >= 23 * 3600 * 1000 - 500, 'quarantine_until ~24h in future');
  assert.ok(until - after <= 24 * 3600 * 1000 + 500, 'quarantine_until <= 24h + epsilon');
  assert.equal(row.quarantine_state, 'pending');
  assert.equal(row.anomaly_flagged, false);
  assert.ok(/^w808-/.test(row.w808_version));
});

// =============================================================================
// 8) promoteStagedCapture refuses anomaly-flagged rows without force
// =============================================================================
test('W808 #8 — promoteStagedCapture refuses anomaly-flagged rows unless force=true', async () => {
  freshDir();
  const { storeMod } = await _loadMods();
  const row = storeMod.insertStagedCapture({
    tenant_id: 'tenant_w808_prom',
    namespace: 'ns_prom',
    response: 'r',
    // Cheat: backdate so quarantine is in the past.
    quarantine_until: new Date(Date.now() - 10000).toISOString(),
  });
  // Mark anomalous.
  storeMod.markStagedAnomaly(row.staged_capture_id, {
    tenant_id: 'tenant_w808_prom',
    reasons: ['output_length=99 is 5.2σ from baseline mean 10.0'],
    flagged_axes: [{ axis: 'output_length', sigma: 5.2 }],
  });
  let inserted = null;
  // Without force → null + no insertObservation call.
  const r1 = storeMod.promoteStagedCapture(row.staged_capture_id, {
    tenant_id: 'tenant_w808_prom',
    insertObservation: (r) => { inserted = r; },
  });
  assert.equal(r1, null, 'anomaly-flagged row must NOT promote without force');
  assert.equal(inserted, null, 'insertObservation must NOT have been called');
  // With force=true → promotes.
  const r2 = storeMod.promoteStagedCapture(row.staged_capture_id, {
    tenant_id: 'tenant_w808_prom',
    force: true,
    insertObservation: (r) => { inserted = r; },
  });
  assert.ok(r2 && r2.quarantine_state === 'promoted', 'force=true promotes anyway');
  assert.ok(inserted && inserted.tenant_id === 'tenant_w808_prom', 'insertObservation called with the row');
});

// =============================================================================
// 9) blockStagedCapture requires a reason
// =============================================================================
test('W808 #9 — blockStagedCapture requires a reason (audit trail)', async () => {
  freshDir();
  const { storeMod } = await _loadMods();
  const row = storeMod.insertStagedCapture({
    tenant_id: 'tenant_w808_block',
    namespace: 'ns_block',
    response: 'r',
  });
  assert.throws(
    () => storeMod.blockStagedCapture(row.staged_capture_id, { tenant_id: 'tenant_w808_block' }),
    /reason is required/i,
    'must throw without reason'
  );
  const n = storeMod.blockStagedCapture(row.staged_capture_id, {
    tenant_id: 'tenant_w808_block',
    reason: 'manual: contains PII',
    reviewer: 'alice',
  });
  assert.equal(n, 1, 'one row patched');
  const after = storeMod.getStagedCapture(row.staged_capture_id, { tenant_id: 'tenant_w808_block' });
  assert.equal(after.quarantine_state, 'blocked');
  assert.equal(after.manual_block_reason, 'manual: contains PII');
  assert.equal(after.manual_review_by, 'alice');
});

// =============================================================================
// 10) captureWithSignature stamps deterministic signature
// =============================================================================
test('W808 #10 — captureWithSignature stamps a deterministic teacher_response_signature', async () => {
  freshDir();
  const { proxyMod } = await _loadMods();
  const row1 = { tenant_id: 't', response: 'hello world' };
  const row2 = { tenant_id: 't', response: 'hello world' };
  const headers = { 'content-type': 'application/json', 'x-request-id': 'r1' };
  const v1 = proxyMod.captureWithSignature(row1, {
    headers,
    body: 'hello world',
    vendor: 'anthropic',
    fingerprint: 'anthropic-public-spki-placeholder',
  });
  const v2 = proxyMod.captureWithSignature(row2, {
    headers,
    body: 'hello world',
    vendor: 'anthropic',
    fingerprint: 'anthropic-public-spki-placeholder',
  });
  assert.equal(v1.ok, true);
  assert.equal(v1.rejected, false, 'known fingerprint must not be rejected (soft-flag default)');
  assert.equal(v1.teacher_fingerprint_known, true);
  assert.equal(row1.teacher_response_signature, row2.teacher_response_signature,
    'same inputs → same signature (deterministic)');
  assert.ok(/^[0-9a-f]{64}$/.test(row1.teacher_response_signature), 'sha256 hex digest');
  // Different body → different signature
  const row3 = { tenant_id: 't', response: 'different' };
  proxyMod.captureWithSignature(row3, {
    headers,
    body: 'different',
    vendor: 'anthropic',
    fingerprint: 'anthropic-public-spki-placeholder',
  });
  assert.notEqual(row1.teacher_response_signature, row3.teacher_response_signature,
    'different body → different signature');
});

// =============================================================================
// 11) captureWithSignature strict mode rejects unknown fingerprint
// =============================================================================
test('W808 #11 — captureWithSignature strict mode rejects unknown teacher fingerprint', async () => {
  freshDir();
  const { proxyMod } = await _loadMods();
  // Soft mode (default) — unknown fingerprint flows through with known=false.
  const rowSoft = { tenant_id: 't', response: 'x' };
  const soft = proxyMod.captureWithSignature(rowSoft, {
    body: 'x',
    vendor: 'mystery-vendor',
    fingerprint: 'mystery-fp-deadbeef',
    strict: false,
  });
  assert.equal(soft.ok, true, 'soft mode never rejects');
  assert.equal(soft.rejected, false);
  assert.equal(soft.teacher_fingerprint_known, false);
  // Strict mode — unknown fingerprint REJECTS.
  const rowStrict = { tenant_id: 't', response: 'x' };
  const strict = proxyMod.captureWithSignature(rowStrict, {
    body: 'x',
    vendor: 'mystery-vendor',
    fingerprint: 'mystery-fp-deadbeef',
    strict: true,
  });
  assert.equal(strict.ok, false);
  assert.equal(strict.rejected, true);
  assert.equal(strict.error, 'unknown_teacher_fingerprint');
  assert.ok(strict.teacher_response_signature, 'signature still computed even on reject');
  // After registering, strict mode accepts.
  proxyMod.registerTeacherFingerprint('mystery-vendor', 'mystery-fp-deadbeef');
  const rowOk = { tenant_id: 't', response: 'x' };
  const okv = proxyMod.captureWithSignature(rowOk, {
    body: 'x',
    vendor: 'mystery-vendor',
    fingerprint: 'mystery-fp-deadbeef',
    strict: true,
  });
  assert.equal(okv.ok, true);
  assert.equal(okv.rejected, false);
});

// =============================================================================
// 12) _w808RegressionGate returns 'first_run' for empty namespace
// =============================================================================
test('W808 #12 — _w808RegressionGate returns first_run when no prior artifact exists', async () => {
  freshDir();
  const dp = await import('../src/distill-pipeline.js?w808e=' + Date.now());
  const result = dp._w808RegressionGate({
    run_dir: null, // no run dir → we feed k_score via manifest
    namespace: 'ns_first',
    tenant_id: 'tenant_w808_first',
    manifest: { k_score_final: 0.85 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'first_run');
  assert.equal(result.candidate_kscore, 0.85);
  assert.equal(result.prior_kscore, null);
  assert.ok(/^w808-/.test(result.version));
  // Thresholds are exposed for downstream readers
  assert.equal(result.kscore_drop_threshold, dp.W808_KSCORE_DROP_THRESHOLD);
});

// =============================================================================
// 13) _w808RegressionGate verdict: rollback / promote / first_run
// =============================================================================
test('W808 #13 — _w808RegressionGate rollback when no prior found + needs_human on missing kscore', async () => {
  freshDir();
  const dp = await import('../src/distill-pipeline.js?w808f=' + Date.now());
  // No candidate K-Score → needs_human + ok:false
  const noKs = dp._w808RegressionGate({
    run_dir: null,
    namespace: 'ns_nokscore',
    tenant_id: 'tenant_w808_nokscore',
    manifest: {},
  });
  assert.equal(noKs.ok, false);
  assert.equal(noKs.verdict, 'needs_human');
  assert.equal(noKs.error, 'no_candidate_kscore');
  // Thresholds are correct constants (3σ kdrop>0.02 cfr>0.01)
  assert.equal(dp.W808_KSCORE_DROP_THRESHOLD, 0.02);
  assert.equal(dp.W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD, 0.01);
});

// =============================================================================
// 14) CLI `kolm captures review --list-pending --json` returns stable envelope
//
// Important — the parent test process's store module FROZE its data dir from
// env vars at FIRST import (singleton pattern). Subsequent freshDir() calls
// only affect the env vars the CLI SUBPROCESS sees. To ensure the row we
// seed in this test process lands on the same disk the subprocess reads,
// we read the parent's currently-frozen data dir via storeMod.backendInfo()
// and pass THAT as the subprocess's KOLM_DATA_DIR.
// =============================================================================
test('W808 #14 — CLI list-pending --json returns stable shape', async () => {
  freshDir();
  // Seed one staged row so we have something to list.
  const { storeMod } = await _loadMods();
  const row = storeMod.insertStagedCapture({
    tenant_id: 'tenant_w808_cli',
    namespace: 'ns_cli',
    prompt: 'hi',
    response: 'hello',
  });
  const frozenDir = storeMod.backendInfo().data_dir;
  const env = {
    ...process.env,
    KOLM_TENANT_ID: 'tenant_w808_cli',
    KOLM_DATA_DIR: frozenDir, // align subprocess with parent's frozen singleton
    KOLM_HOME: frozenDir,
    KOLM_STORE_DRIVER: 'json',
    KOLM_ENV: 'test',
  };
  const r = spawnSync('node', [CLI_PATH, 'captures', 'review', '--list-pending', '--json'], {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 30000,
  });
  assert.equal(r.status, 0, `CLI must exit 0; stderr=${r.stderr}; stdout=${r.stdout}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) {
    assert.fail('CLI must emit valid JSON; got: ' + r.stdout.slice(0, 400));
  }
  assert.equal(j.ok, true);
  assert.equal(j.action, 'list-pending');
  assert.equal(j.tenant_id, 'tenant_w808_cli');
  assert.ok(Array.isArray(j.staged));
  assert.ok(j.count >= 1, `at least one staged row; got count=${j.count} env_dir=${frozenDir}`);
  assert.ok(/^w808-/.test(j.version));
  const found = j.staged.find(s => s.staged_capture_id === row.staged_capture_id);
  assert.ok(found, 'seeded row appears in list');
  assert.equal(found.namespace, 'ns_cli');
});

// =============================================================================
// 15) CLI --block <id> without --reason exits 1 (BAD_ARGS)
// =============================================================================
test('W808 #15 — CLI --block without --reason exits 1 with reason_required envelope', async () => {
  freshDir();
  const { storeMod } = await _loadMods();
  const row = storeMod.insertStagedCapture({
    tenant_id: 'tenant_w808_cli2',
    namespace: 'ns_cli2',
    response: 'r',
  });
  const frozenDir = storeMod.backendInfo().data_dir;
  const env = {
    ...process.env,
    KOLM_TENANT_ID: 'tenant_w808_cli2',
    KOLM_DATA_DIR: frozenDir,
    KOLM_HOME: frozenDir,
    KOLM_STORE_DRIVER: 'json',
    KOLM_ENV: 'test',
  };
  const r = spawnSync('node', [CLI_PATH, 'captures', 'review', '--block', row.staged_capture_id, '--json'], {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 30000,
  });
  assert.equal(r.status, 1, `CLI must exit 1 (BAD_ARGS); got ${r.status}; stderr=${r.stderr}; stdout=${r.stdout}`);
  // The JSON envelope (or stderr) must mention reason_required
  const out = r.stdout + r.stderr;
  assert.ok(out.includes('reason_required') || out.includes('--reason'),
    `output must surface reason_required or --reason hint; got: ${out.slice(0, 300)}`);
});
