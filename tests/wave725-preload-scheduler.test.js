// W725 — Predictive preloading scheduler tests.
//
// Atomic items pinned (matches the W725 implementation):
//
//   1) recordQuery + predictByTimeBucket: seed 20 queries in hour=9
//      (namespace='coding') and 20 in hour=14 (namespace='writing'),
//      assert predictByTimeBucket({hour: 9, recent_history}) ranks
//      'coding' first.
//   2) predictNextNamespace: seed transitions [A,B,A,B,A,C], assert
//      predictNextNamespace({recent_history, current_namespace:'A'})
//      ranks 'B' above 'C'.
//   3) predictByTimeBucket with empty history -> [].
//   4) predictNextNamespace with unseen current_namespace -> [].
//   5) schedulePreload merges both signals: when time-bucket and Markov
//      agree, reason is 'both' and score is higher than either alone.
//   6) Tenant fence: recordQuery({tenant:'A',...}) and
//      recordQuery({tenant:'B',...}) write to separate files; tenant A's
//      reader MUST NOT see tenant B's data.
//   7) Persistence: writes appear in
//      ${KOLM_DATA_DIR}/tenants/<tenant>/preload-history.jsonl
//   8) PRELOAD_SCHEDULER_VERSION === 'w725-v1'
//   9) Bench: spawn `node bench/wave725-cold-vs-warm-bench.js --json
//      --queries 30`, parse stdout JSON, assert savings_ms > 0 and
//      savings_pct > 0.
//  10) Anti-brittleness: regex `wave(7\d\d)` count threshold instead of
//      explicit-array sibling check.
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing fields
// (version, top-K shape, reason tags, persistence paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PRELOAD_SCHEDULER_VERSION,
  recordQuery,
  predictByTimeBucket,
  predictNextNamespace,
  schedulePreload,
  _readHistoryFile,
  _historyFile,
} from '../src/preload-scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_PATH = path.join(__dirname, '..', 'bench', 'wave725-cold-vs-warm-bench.js');
const TESTS_DIR = __dirname;

// Per-test scratch dir under os.tmpdir + 8 random hex bytes. Cleaned in
// after() blocks (one per test); see _withFreshDir helper.
function freshDir() {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kolm-w725-' + crypto.randomBytes(8).toString('hex') + '-'),
  );
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// Build a UTC-anchored timestamp at hour H on day D of 2026-05.
function utcTs(day, hour, minute = 0) {
  return Date.UTC(2026, 4, day, hour, minute, 0);
}

// =============================================================================
// 1) recordQuery + predictByTimeBucket: hour-9 coding vs hour-14 writing
// =============================================================================

test('W725 #1 — predictByTimeBucket ranks the bucket-frequent namespace first', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  // Seed 20 morning-coding queries at hour=9 across days 1..20.
  for (let d = 1; d <= 20; d += 1) {
    recordQuery({ tenant: 'w725_t1', namespace: 'coding', timestamp: utcTs(d, 9, d) });
  }
  // Seed 20 afternoon-writing queries at hour=14 across days 1..20.
  for (let d = 1; d <= 20; d += 1) {
    recordQuery({ tenant: 'w725_t1', namespace: 'writing', timestamp: utcTs(d, 14, d) });
  }
  const history = _readHistoryFile('w725_t1');
  assert.equal(history.length, 40, 'history must contain all 40 seeded queries');

  const morningPred = predictByTimeBucket({ hour: 9, recent_history: history });
  assert.ok(morningPred.length >= 1, 'hour=9 should produce at least one prediction');
  assert.equal(morningPred[0].namespace, 'coding',
    'morning bucket should rank coding first');
  // Coding queries are the only thing in bucket 9 -> score = 1.0.
  assert.equal(morningPred[0].score, 1);
  assert.equal(morningPred[0].count, 20);

  const afternoonPred = predictByTimeBucket({ hour: 14, recent_history: history });
  assert.ok(afternoonPred.length >= 1, 'hour=14 should produce at least one prediction');
  assert.equal(afternoonPred[0].namespace, 'writing',
    'afternoon bucket should rank writing first');
});

// =============================================================================
// 2) predictNextNamespace transitions A->B 2x, B->A 2x, A->C 1x
// =============================================================================

test('W725 #2 — predictNextNamespace ranks higher-transition target first', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  // Build the literal history [A, B, A, B, A, C] across consecutive minutes
  // so the chronological-sort step has unambiguous ordering.
  const seq = ['A', 'B', 'A', 'B', 'A', 'C'];
  const recent_history = seq.map((ns, i) => ({
    namespace: ns, timestamp: utcTs(1, 9, i),
  }));

  // From the docstring: A->B 2x, A->C 1x; B->A 2x.
  const fromA = predictNextNamespace({ recent_history, current_namespace: 'A' });
  assert.ok(fromA.length >= 2, 'A should have at least two transition targets');
  assert.equal(fromA[0].namespace, 'B', 'A should rank B first (count=2)');
  // C must appear below B but be present (count=1).
  const cRow = fromA.find((p) => p.namespace === 'C');
  assert.ok(cRow, 'A->C should appear in the prediction list');
  assert.ok(fromA[0].count > cRow.count, 'B count must exceed C count');

  // From B, the only transition is back to A.
  const fromB = predictNextNamespace({ recent_history, current_namespace: 'B' });
  assert.equal(fromB.length, 1);
  assert.equal(fromB[0].namespace, 'A');
});

// =============================================================================
// 3) predictByTimeBucket empty history -> []
// =============================================================================

test('W725 #3 — predictByTimeBucket returns [] on empty history', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  assert.deepEqual(predictByTimeBucket({ hour: 9, recent_history: [] }), []);
  assert.deepEqual(predictByTimeBucket({ hour: 9, recent_history: null }), []);
  assert.deepEqual(predictByTimeBucket({ hour: 9 }), []);
  // Bad hour also returns [].
  assert.deepEqual(predictByTimeBucket({ hour: -1, recent_history: [{ namespace: 'x', timestamp: 1 }] }), []);
  assert.deepEqual(predictByTimeBucket({ hour: 24, recent_history: [{ namespace: 'x', timestamp: 1 }] }), []);
});

// =============================================================================
// 4) predictNextNamespace unseen current_namespace -> []
// =============================================================================

test('W725 #4 — predictNextNamespace returns [] for unseen current_namespace', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  const recent_history = [
    { namespace: 'A', timestamp: utcTs(1, 9, 0) },
    { namespace: 'B', timestamp: utcTs(1, 9, 1) },
  ];
  // 'Z' is never a from-position -> empty.
  assert.deepEqual(predictNextNamespace({ recent_history, current_namespace: 'Z' }), []);
  // Missing current_namespace -> empty.
  assert.deepEqual(predictNextNamespace({ recent_history }), []);
  // Empty history -> empty.
  assert.deepEqual(predictNextNamespace({ recent_history: [], current_namespace: 'A' }), []);
});

// =============================================================================
// 5) schedulePreload composition: both-signal score > single-signal score
// =============================================================================

test('W725 #5 — schedulePreload merges signals; reason=both has highest score', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  // Construct a history where the time-bucket signal AND the Markov signal
  // both pick `target_ns` at hour 9 from current `source_ns`.
  //
  // Time-bucket: seed many queries to `target_ns` at hour 9 so it dominates
  // bucket 9.
  // Markov: seed several source_ns -> target_ns transitions so target_ns
  // dominates as the next-step from source_ns.
  const history = [];
  // 10 strict (source_ns -> target_ns) pairs at hour 9 — both signals agree
  // on target_ns.
  for (let d = 1; d <= 10; d += 1) {
    history.push({ namespace: 'source_ns', timestamp: utcTs(d, 9, 0) });
    history.push({ namespace: 'target_ns', timestamp: utcTs(d, 9, 1) });
  }
  // Add a distractor namespace that's only present via Markov (not time-9
  // bucket) so we can verify the composition mechanic is symmetric.
  for (let d = 1; d <= 3; d += 1) {
    history.push({ namespace: 'source_ns', timestamp: utcTs(d, 14, 0) });
    history.push({ namespace: 'markov_only', timestamp: utcTs(d, 14, 1) });
  }
  // Add a distractor that's only time-bucket-9 frequent but unreachable from
  // source_ns via the Markov chain.
  for (let d = 1; d <= 4; d += 1) {
    history.push({ namespace: 'time_only', timestamp: utcTs(d, 9, 30) });
  }

  // Pin now_ts to a UTC hour-9 timestamp.
  const now_ts = utcTs(15, 9, 0);
  const preds = schedulePreload({ now_ts, recent_history: history, current_namespace: 'source_ns' });
  assert.ok(preds.length > 0, 'schedulePreload must return at least one candidate');

  // The candidate for target_ns must exist AND carry reason 'both'.
  const target = preds.find((p) => p.namespace === 'target_ns');
  assert.ok(target, 'target_ns must appear in composed predictions');
  assert.equal(target.reason, 'both',
    'target_ns is in BOTH the time bucket and the Markov chain -> reason should be both');

  // Find a single-signal sibling. If both distractors made the top-3, either
  // qualifies; otherwise we synthesize a representative single-signal score
  // and assert the invariant directly.
  const markovOnly = preds.find((p) => p.namespace === 'markov_only');
  const timeOnly = preds.find((p) => p.namespace === 'time_only');

  // Pin the load-bearing invariant: target.score = time_score + markov_score
  // with BOTH components strictly positive, so target.score is strictly
  // greater than EITHER component alone (which is what `both` means).
  assert.ok(target.time_score > 0, 'reason=both requires time_score > 0');
  assert.ok(target.markov_score > 0, 'reason=both requires markov_score > 0');
  assert.ok(target.score > target.time_score,
    'composed score must strictly exceed the time-only component');
  assert.ok(target.score > target.markov_score,
    'composed score must strictly exceed the markov-only component');

  // If a single-signal sibling made the top-3, its reason must NOT be 'both'.
  if (markovOnly) {
    assert.equal(markovOnly.reason, 'markov');
    assert.equal(markovOnly.time_score, 0);
    assert.ok(markovOnly.markov_score > 0);
  }
  if (timeOnly) {
    assert.equal(timeOnly.reason, 'time_bucket');
    assert.equal(timeOnly.markov_score, 0);
    assert.ok(timeOnly.time_score > 0);
  }
});

// =============================================================================
// 6) Tenant fence: separate files, no cross-tenant leakage
// =============================================================================

test('W725 #6 — tenant fence: separate files; tenant A cannot read tenant B', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  recordQuery({ tenant: 'tenantA', namespace: 'x', timestamp: utcTs(1, 9, 0) });
  recordQuery({ tenant: 'tenantA', namespace: 'x', timestamp: utcTs(1, 9, 1) });
  recordQuery({ tenant: 'tenantB', namespace: 'y', timestamp: utcTs(1, 9, 0) });
  recordQuery({ tenant: 'tenantB', namespace: 'y', timestamp: utcTs(1, 9, 1) });

  // Files MUST be different paths under different tenant directories.
  const fileA = _historyFile('tenantA');
  const fileB = _historyFile('tenantB');
  assert.notEqual(fileA, fileB);
  assert.ok(fileA.includes(path.join('tenants', 'tenantA')));
  assert.ok(fileB.includes(path.join('tenants', 'tenantB')));

  // Tenant A's view contains ONLY namespace 'x'.
  const histA = _readHistoryFile('tenantA');
  assert.equal(histA.length, 2);
  for (const row of histA) {
    assert.equal(row.namespace, 'x', 'tenantA history must not contain tenantB rows');
  }
  // Tenant B's view contains ONLY namespace 'y'.
  const histB = _readHistoryFile('tenantB');
  assert.equal(histB.length, 2);
  for (const row of histB) {
    assert.equal(row.namespace, 'y', 'tenantB history must not contain tenantA rows');
  }

  // Predictions surface only same-tenant data.
  const predA = predictByTimeBucket({ hour: 9, recent_history: histA });
  assert.equal(predA[0].namespace, 'x');
  const predB = predictByTimeBucket({ hour: 9, recent_history: histB });
  assert.equal(predB[0].namespace, 'y');

  // Defense-in-depth: tenant param missing throws synchronously, not
  // silently defaulted to a shared file.
  assert.throws(() => recordQuery({ namespace: 'leak', timestamp: utcTs(1, 9, 0) }),
    /tenant/i,
    'recordQuery without tenant must throw');
  assert.throws(() => recordQuery({ tenant: '', namespace: 'leak', timestamp: utcTs(1, 9, 0) }),
    /tenant/i,
    'recordQuery with empty tenant must throw');
  // Path traversal must throw, not silently rewrite the path.
  assert.throws(() => recordQuery({ tenant: '../etc', namespace: 'leak', timestamp: utcTs(1, 9, 0) }),
    /tenant/i,
    'recordQuery with traversal tenant must throw');
});

// =============================================================================
// 7) Persistence path: ${KOLM_DATA_DIR}/tenants/<tenant>/preload-history.jsonl
// =============================================================================

test('W725 #7 — persistence: history written to ${KOLM_DATA_DIR}/tenants/<tenant>/preload-history.jsonl', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  recordQuery({ tenant: 'pers_t', namespace: 'ns_a', timestamp: utcTs(1, 9, 0) });
  recordQuery({ tenant: 'pers_t', namespace: 'ns_b', timestamp: utcTs(1, 9, 1) });

  const expectedPath = path.join(
    process.env.KOLM_DATA_DIR, 'tenants', 'pers_t', 'preload-history.jsonl',
  );
  assert.ok(fs.existsSync(expectedPath),
    'history file must exist at the documented path: ' + expectedPath);

  // The path returned by _historyFile must resolve to the same absolute
  // path as the documented layout (modulo OS path-separator normalization).
  assert.equal(path.resolve(_historyFile('pers_t')), path.resolve(expectedPath));

  // File contents are valid JSONL — one row per query, in insertion order.
  const lines = fs.readFileSync(expectedPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const r0 = JSON.parse(lines[0]);
  const r1 = JSON.parse(lines[1]);
  assert.equal(r0.namespace, 'ns_a');
  assert.equal(r1.namespace, 'ns_b');
  assert.ok(Number.isFinite(r0.timestamp));
  assert.ok(Number.isFinite(r1.timestamp));
});

// =============================================================================
// 8) PRELOAD_SCHEDULER_VERSION
// =============================================================================

test('W725 #8 — PRELOAD_SCHEDULER_VERSION is w725-v1', () => {
  assert.equal(PRELOAD_SCHEDULER_VERSION, 'w725-v1');
});

// =============================================================================
// 9) Bench: savings_ms > 0 and savings_pct > 0
// =============================================================================

test('W725 #9 — bench cold vs warm produces positive savings', (t) => {
  const tmp = freshDir();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  const r = spawnSync(process.execPath, [
    BENCH_PATH, '--json', '--queries', '30',
  ], { encoding: 'utf8', timeout: 30_000 });

  assert.equal(r.status, 0,
    `bench should exit 0; got status=${r.status} stderr=${(r.stderr || '').slice(0, 400)}`);

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope on stdout; stdout=${stdout.slice(0, 400)}`);
  const report = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));

  assert.equal(report.ok, true);
  assert.equal(report.scheduler_version, 'w725-v1');
  assert.equal(report.queries, 30);
  assert.ok(report.savings_ms > 0, `expected savings_ms > 0, got ${report.savings_ms}`);
  assert.ok(report.savings_pct > 0, `expected savings_pct > 0, got ${report.savings_pct}`);
  assert.ok(report.cold_total_ms > report.warm_total_ms,
    'cold total must exceed warm total when predictor produces savings');
  assert.ok(report.namespace_hit_rate >= 0 && report.namespace_hit_rate <= 1,
    `namespace_hit_rate must be in [0,1], got ${report.namespace_hit_rate}`);
});

// =============================================================================
// 10) Anti-brittleness: regex + threshold sibling check
// =============================================================================

test('W725 #10 — sibling-wave count check uses regex + threshold (anti-brittleness)', () => {
  // Discover sibling W7xx test files via regex on the tests directory.
  // This deliberately AVOIDS an explicit-array assertion ("the family
  // members are exactly [wave720, wave721, ...]") so adding the next
  // wave does not require a coordinated test-rev (W604 trap class).
  const re = /^wave(7\d\d)-.*\.test\.js$/;
  const dir = TESTS_DIR;
  const entries = fs.readdirSync(dir);
  const family = entries.filter((name) => re.test(name));
  // After W725 we have at least W720, W721, W722, W725 -> 4 family members.
  assert.ok(family.length >= 4,
    `expected at least 4 wave7xx test files, found ${family.length}: ${family.join(',')}`);
  // Include this wave itself in the family.
  assert.ok(family.includes('wave725-preload-scheduler.test.js'),
    'this test file must appear in its own wave-family scan');
});
