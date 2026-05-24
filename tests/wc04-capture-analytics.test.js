// WC04 — test coverage close-out for src/capture-analytics.js.
//
// Previously: 732 LOC. The W811 sibling test (wave811-capture-analytics.test.js)
// pins the integrated cluster + KS-breakdown + IDR + CSV + gap-signal flows
// end-to-end through analyzeNamespace(). This WC04 file is complementary —
// it pins the *unit-level* public export surface (pure helpers, CSV escape
// mechanics, gap-signal parse round-trip, exported tunables, edge boundaries)
// so future refactors of the pure-math layer don't silently regress before
// the integrated suite picks it up.
//
// Pattern: small atomic node:test cases, one assertion family per test, with
// the WC04-ca #N <description> naming convention. No mocking; we touch the
// public API + the documented __internals seam. Per-file tmp KOLM_DATA_DIR
// so any store/event-store side effects stay isolated.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPTURE_ANALYTICS_VERSION,
  CLUSTER_SIM_THRESHOLD,
  MAX_CLUSTERS,
  MAX_ROWS_PER_CALL,
  IDR_RECENT_WINDOW_MS,
  IDR_COMPARISON_WINDOW_MS,
  GAP_SIGNAL_EVENT_KIND,
  GAP_SIGNAL_FEEDBACK_PREFIX,
  fingerprintPrompt,
  cosineSparse,
  clusterCaptures,
  kscoreBreakdown,
  idrStalenessGauge,
  clustersToCsv,
  clusterGapScore,
  parseGapSignal,
  analyzeNamespace,
  analyzeNamespaceCsv,
  __internals,
} from '../src/capture-analytics.js';

// One tmp KOLM_DATA_DIR for the whole file — none of the tests below write
// to the store, but analyzeNamespace lazy-loads findByTenant which may
// stat the data dir; this keeps the environment hermetic per WC04 norms.
before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc04-ca-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
});

// =============================================================================
// 1 — exported tunables shape (version regex + numeric bounds)
// =============================================================================
test('WC04-ca #1 exported version + tunables have sane shape', () => {
  assert.ok(/^w811-/.test(CAPTURE_ANALYTICS_VERSION),
    `CAPTURE_ANALYTICS_VERSION matches /^w811-/; got ${CAPTURE_ANALYTICS_VERSION}`);
  assert.equal(typeof CLUSTER_SIM_THRESHOLD, 'number');
  assert.ok(CLUSTER_SIM_THRESHOLD > 0 && CLUSTER_SIM_THRESHOLD < 1);
  assert.ok(Number.isInteger(MAX_CLUSTERS) && MAX_CLUSTERS >= 4);
  assert.ok(Number.isInteger(MAX_ROWS_PER_CALL) && MAX_ROWS_PER_CALL >= 100);
  assert.ok(IDR_RECENT_WINDOW_MS > 0);
  assert.ok(IDR_COMPARISON_WINDOW_MS > IDR_RECENT_WINDOW_MS,
    'comparison window must be longer than recent window for ratio < 1');
  assert.equal(typeof GAP_SIGNAL_EVENT_KIND, 'string');
  assert.equal(GAP_SIGNAL_FEEDBACK_PREFIX, 'w811_gap_signal:');
});

// =============================================================================
// 2 — fingerprintPrompt edge inputs
// =============================================================================
test('WC04-ca #2 fingerprintPrompt returns {} on empty/whitespace/non-letter input', () => {
  assert.deepEqual(fingerprintPrompt(''), {});
  assert.deepEqual(fingerprintPrompt('   \t\n'), {});
  assert.deepEqual(fingerprintPrompt('!!! ??? ...'), {});
  assert.deepEqual(fingerprintPrompt(null), {});
  assert.deepEqual(fingerprintPrompt(undefined), {});
});

// =============================================================================
// 3 — fingerprintPrompt l1-normalization invariant
// =============================================================================
test('WC04-ca #3 fingerprintPrompt weights sum to 1.0 (l1-normalized)', () => {
  const fp = fingerprintPrompt('the quick brown fox jumps over the lazy dog');
  const total = Object.values(fp).reduce((s, v) => s + v, 0);
  // Floating-point slack; sum should be 1.0 within 1e-9.
  assert.ok(Math.abs(total - 1.0) < 1e-9, `l1 sum ≈ 1; got ${total}`);
  // Single-token prompts still produce a non-empty fp (unigram only, bigram skipped).
  const fpOne = fingerprintPrompt('hello');
  assert.ok(Object.keys(fpOne).length >= 1, 'single-token prompt fingerprints');
});

// =============================================================================
// 4 — cosineSparse boundary semantics (never NaN)
// =============================================================================
test('WC04-ca #4 cosineSparse handles empty + null + identical inputs without NaN', () => {
  assert.equal(cosineSparse(null, {}), 0);
  assert.equal(cosineSparse({}, null), 0);
  assert.equal(cosineSparse({}, { 'u:x': 1 }), 0);
  assert.equal(cosineSparse({ 'u:x': 1 }, {}), 0);
  // Identical sparse vectors cosine to 1 within floating-point slack.
  const v = { 'u:a': 0.5, 'u:b': 0.5 };
  const ident = cosineSparse(v, v);
  assert.ok(Math.abs(ident - 1) < 1e-9, `identical → 1 within fp slack; got ${ident}`);
  // Disjoint vectors cosine to 0.
  assert.equal(cosineSparse({ 'u:a': 1 }, { 'u:b': 1 }), 0);
});

// =============================================================================
// 5 — clusterCaptures honest-empty contract
// =============================================================================
test('WC04-ca #5 clusterCaptures honest empty: zero/missing input', () => {
  const r1 = clusterCaptures([]);
  assert.deepEqual(r1.clusters, []);
  assert.equal(r1.total_n, 0);
  assert.equal(r1.overflow_n, 0);
  assert.equal(r1.version, CAPTURE_ANALYTICS_VERSION);
  // Non-array input still produces an honest envelope (no throw).
  const r2 = clusterCaptures(null);
  assert.equal(r2.total_n, 0);
  assert.deepEqual(r2.clusters, []);
});

// =============================================================================
// 6 — clusterCaptures buckets empty-prompt rows into overflow_n
// =============================================================================
test('WC04-ca #6 clusterCaptures: prompts with no tokenizable text → overflow_n', () => {
  const r = clusterCaptures([
    { event_id: 'e1', prompt: '' },
    { event_id: 'e2', prompt: '   ' },
    { event_id: 'e3', prompt: '!!!' },
  ]);
  assert.equal(r.clusters.length, 0, 'no clusters when no fingerprintable prompts');
  assert.equal(r.overflow_n, 3, 'all three rows shed to overflow');
  assert.equal(r.total_n, 3);
});

// =============================================================================
// 7 — clusterCaptures accepts opts.max_clusters override
// =============================================================================
test('WC04-ca #7 clusterCaptures honors opts.max_clusters cap', () => {
  // Five distinctly different prompts, cap at 2 → 2 clusters + 3 overflow.
  const captures = [
    { event_id: 'a', prompt: 'translate this paragraph into french' },
    { event_id: 'b', prompt: 'summarize quarterly earnings report' },
    { event_id: 'c', prompt: 'classify email by customer intent' },
    { event_id: 'd', prompt: 'identify named entities in clinical notes' },
    { event_id: 'e', prompt: 'generate python tests for bubble sort' },
  ];
  const r = clusterCaptures(captures, { max_clusters: 2 });
  assert.equal(r.clusters.length, 2, 'cluster count capped at 2');
  assert.ok(r.overflow_n >= 1, 'remaining rows shed to overflow');
  assert.equal(r.total_n, 5);
});

// =============================================================================
// 8 — kscoreBreakdown empty path
// =============================================================================
test('WC04-ca #8 kscoreBreakdown returns empty breakdown for empty clusters', () => {
  const r = kscoreBreakdown([], [{ event_id: 'x', kscore: 0.9 }]);
  assert.deepEqual(r.breakdown, []);
  assert.equal(r.version, CAPTURE_ANALYTICS_VERSION);
});

// =============================================================================
// 9 — kscoreBreakdown surfaces 'no_samples' for KS-free clusters
// =============================================================================
test('WC04-ca #9 kscoreBreakdown: cluster with no kscored rows → status no_samples', () => {
  const cluster = { cluster_id: 'cl_test', n: 2, top_tokens: [], example_prompts: [], _ids: ['e1', 'e2'] };
  const captures = [{ event_id: 'e1', prompt: 'x' }, { event_id: 'e2', prompt: 'y' }];
  const r = kscoreBreakdown([cluster], captures);
  assert.equal(r.breakdown.length, 1);
  assert.equal(r.breakdown[0].n_samples, 0);
  assert.equal(r.breakdown[0].kscore, null);
  assert.equal(r.breakdown[0].status, 'no_samples');
});

// =============================================================================
// 10 — kscoreBreakdown reads nested feedback.bakeoff.kscore
// =============================================================================
test('WC04-ca #10 kscoreBreakdown picks up nested feedback.bakeoff.kscore source', () => {
  const cluster = { cluster_id: 'cl_x', n: 3, top_tokens: [], example_prompts: [], _ids: ['e1', 'e2', 'e3'] };
  const captures = [
    { event_id: 'e1', feedback: { bakeoff: { kscore: 0.20 } } },
    { event_id: 'e2', feedback: { bakeoff: { kscore: 0.50 } } },
    { event_id: 'e3', feedback: { bakeoff: { kscore: 0.80 } } },
  ];
  const r = kscoreBreakdown([cluster], captures);
  assert.equal(r.breakdown[0].n_samples, 3);
  assert.equal(r.breakdown[0].status, 'ok');
  assert.ok(r.breakdown[0].kscore > 0.4 && r.breakdown[0].kscore < 0.6,
    `mean ks ≈ 0.5; got ${r.breakdown[0].kscore}`);
});

// =============================================================================
// 11 — idrStalenessGauge no-comparison-rows envelope
// =============================================================================
test('WC04-ca #11 idrStalenessGauge: zero rows → gauge=1.0 + no_recent_captures', () => {
  const r = idrStalenessGauge([]);
  assert.equal(r.gauge, 1.0);
  assert.equal(r.recent_n, 0);
  assert.equal(r.comparison_n, 0);
  assert.equal(r.status, 'no_recent_captures');
  // Rows entirely outside the comparison window also yield no_recent_captures.
  const ancient = [{ created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString() }];
  const r2 = idrStalenessGauge(ancient);
  assert.equal(r2.status, 'no_recent_captures');
});

// =============================================================================
// 12 — idrStalenessGauge: all-recent → gauge=0; none-recent → gauge=1
// =============================================================================
test('WC04-ca #12 idrStalenessGauge ratio math at both boundary cases', () => {
  const now = 1_700_000_000_000;
  // All five rows fall inside the recent window (1 hour ago).
  const allRecent = Array.from({ length: 5 }, (_, i) => ({
    created_at: new Date(now - 60 * 60 * 1000 - i * 1000).toISOString(),
  }));
  const rAll = idrStalenessGauge(allRecent, { now_ms: now });
  assert.equal(rAll.status, 'ok');
  assert.equal(rAll.gauge, 0, 'all-recent → gauge=0');
  // Five rows in comparison window, none in recent window (e.g. 20 days ago).
  const noneRecent = Array.from({ length: 5 }, (_, i) => ({
    created_at: new Date(now - 20 * 24 * 60 * 60 * 1000 - i * 1000).toISOString(),
  }));
  const rNone = idrStalenessGauge(noneRecent, { now_ms: now });
  assert.equal(rNone.status, 'ok');
  assert.equal(rNone.gauge, 1, 'comparison-only → gauge=1');
});

// =============================================================================
// 13 — idrStalenessGauge ignores future timestamps + missing ts
// =============================================================================
test('WC04-ca #13 idrStalenessGauge skips future + tsless rows safely', () => {
  const now = 1_700_000_000_000;
  const rows = [
    { created_at: new Date(now + 1_000_000).toISOString() }, // future, skip
    { /* no ts */ },                                          // skip
    { created_at: new Date(now - 1000).toISOString() },      // recent
  ];
  const r = idrStalenessGauge(rows, { now_ms: now });
  // Only one row counted in both windows → ratio 1/1 → gauge 0.
  assert.equal(r.recent_n, 1);
  assert.equal(r.comparison_n, 1);
  assert.equal(r.gauge, 0);
});

// =============================================================================
// 14 — clustersToCsv: header row + empty-cluster body
// =============================================================================
test('WC04-ca #14 clustersToCsv emits stable header even with empty clusters', () => {
  const csv = clustersToCsv([], []);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1, 'header-only when no clusters');
  const header = lines[0].split(',');
  assert.ok(header.includes('cluster_id'));
  assert.ok(header.includes('n'));
  assert.ok(header.includes('top_tokens'));
  assert.ok(header.includes('kscore_mean'));
  assert.ok(header.includes('example_prompt_1'));
});

// =============================================================================
// 15 — clustersToCsv: row count + cluster_id join
// =============================================================================
test('WC04-ca #15 clustersToCsv emits one row per cluster, joined by cluster_id', () => {
  const clusters = [
    { cluster_id: 'cl_A', n: 3, top_tokens: ['alpha', 'beta'], example_prompts: ['alpha beta gamma'] },
    { cluster_id: 'cl_B', n: 1, top_tokens: ['lone'], example_prompts: ['lone token only'] },
  ];
  const breakdown = [
    { cluster_id: 'cl_A', n_samples: 2, kscore: 0.7, p50: 0.7, p95: 0.9, status: 'ok' },
  ];
  const csv = clustersToCsv(clusters, breakdown);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3, '1 header + 2 cluster rows');
  // cl_A picks up the breakdown KS; cl_B falls back to no_samples.
  assert.ok(lines[1].includes('cl_A'));
  assert.ok(lines[1].includes('0.7'));
  assert.ok(lines[2].includes('cl_B'));
  assert.ok(lines[2].includes('no_samples'));
});

// =============================================================================
// 16 — clustersToCsv: escaping quotes / commas / newlines
// =============================================================================
test('WC04-ca #16 clustersToCsv escapes commas, quotes, and newlines in fields', () => {
  const clusters = [{
    cluster_id: 'cl_esc',
    n: 1,
    top_tokens: ['t1'],
    example_prompts: ['has, comma and "quotes" and\nnewline'],
  }];
  const csv = clustersToCsv(clusters, []);
  const dataLine = csv.trim().split('\n')[1] || '';
  // Comma + quote + newline forces the example field to be wrapped in quotes
  // with inner quotes doubled.
  assert.ok(dataLine.includes('""quotes""'), 'inner quotes doubled');
  // The wrapping quotes preserve the embedded comma so the CSV remains parseable.
  assert.ok(/"has, comma/.test(dataLine), 'comma is quoted not split');
});

// =============================================================================
// 17 — clusterGapScore: bounded [0,1] for hostile inputs
// =============================================================================
test('WC04-ca #17 clusterGapScore clamps gap into [0,1] for adversarial inputs', () => {
  // null cluster → 0
  assert.equal(clusterGapScore(null, null, 0, 0), 0);
  // n=0 → 0 short-circuit
  assert.equal(clusterGapScore({ n: 0 }, null, 100, 1), 0);
  // Unknown KS (no breakdown) gives the documented 0.5 fallback under stale=0.
  const g1 = clusterGapScore({ n: 1 }, null, 1, 0);
  assert.ok(g1 >= 0 && g1 <= 1, `gap in [0,1]; got ${g1}`);
  assert.equal(g1, 0.5, 'unknown ks under stale=0 → exactly 0.5');
  // Garbage staleness (NaN-style) coerces to 0 not NaN.
  const g2 = clusterGapScore({ n: 5 }, { kscore: 0.5 }, 10, 'not-a-number');
  assert.ok(Number.isFinite(g2));
  assert.ok(g2 >= 0 && g2 <= 1);
});

// =============================================================================
// 18 — parseGapSignal round-trips the documented feedback prefix
// =============================================================================
test('WC04-ca #18 parseGapSignal round-trips + rejects non-W811 feedback rows', () => {
  const payload = { cluster_id: 'cl_round', cluster_n: 9, gap_score: 0.42 };
  const ev = { feedback: GAP_SIGNAL_FEEDBACK_PREFIX + JSON.stringify(payload) };
  const back = parseGapSignal(ev);
  assert.equal(back.cluster_id, 'cl_round');
  assert.equal(back.cluster_n, 9);
  assert.equal(back.gap_score, 0.42);
  // Non-prefixed feedback rejected.
  assert.equal(parseGapSignal({ feedback: 'some other marker' }), null);
  // Missing feedback rejected.
  assert.equal(parseGapSignal({}), null);
  assert.equal(parseGapSignal(null), null);
  // Malformed JSON suffix rejected without throwing.
  assert.equal(parseGapSignal({ feedback: GAP_SIGNAL_FEEDBACK_PREFIX + '{not-json' }), null);
});

// =============================================================================
// 19 — analyzeNamespace honest-error envelopes (missing tenant / namespace)
// =============================================================================
test('WC04-ca #19 analyzeNamespace returns honest error envelope on missing args', async () => {
  const noTenant = await analyzeNamespace({ namespace: 'ns' });
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'missing_tenant_id');
  assert.equal(noTenant.version, CAPTURE_ANALYTICS_VERSION);
  assert.equal(typeof noTenant.hint, 'string');

  const noNs = await analyzeNamespace({ tenant_id: 'tenant_wc04' });
  assert.equal(noNs.ok, false);
  assert.equal(noNs.error, 'missing_namespace');
  assert.equal(noNs.version, CAPTURE_ANALYTICS_VERSION);

  // analyzeNamespaceCsv inherits the same honest envelope shape.
  const noTenantCsv = await analyzeNamespaceCsv({ namespace: 'ns' });
  assert.equal(noTenantCsv.ok, false);
  assert.equal(noTenantCsv.error, 'missing_tenant_id');
});

// =============================================================================
// 20 — __internals helpers: _toText / _kscoreFor / _ts / _csvField
// =============================================================================
test('WC04-ca #20 __internals helpers handle edge inputs honestly', () => {
  // _toText: null/undefined → '', object → JSON
  assert.equal(__internals._toText(null), '');
  assert.equal(__internals._toText(undefined), '');
  assert.equal(__internals._toText('plain'), 'plain');
  assert.equal(__internals._toText({ a: 1 }), '{"a":1}');

  // _kscoreFor: null → null; direct kscore → number; nested feedback path; 0 is honest
  assert.equal(__internals._kscoreFor(null), null);
  assert.equal(__internals._kscoreFor({ kscore: 0.42 }), 0.42);
  assert.equal(__internals._kscoreFor({ k_score: 0.7 }), 0.7);
  assert.equal(__internals._kscoreFor({ feedback: { kscore: 0.3 } }), 0.3);
  assert.equal(__internals._kscoreFor({ feedback: { bakeoff: { kscore: 0.9 } } }), 0.9);
  assert.equal(__internals._kscoreFor({}), null);
  // Non-numeric kscore field → null, never coerced.
  assert.equal(__internals._kscoreFor({ kscore: 'high' }), null);

  // _ts: created_at iso → ms; time_ms → ms; ts → ms; nothing → null
  const ms = __internals._ts({ created_at: '2026-01-01T00:00:00Z' });
  assert.ok(Number.isFinite(ms) && ms > 0);
  assert.equal(__internals._ts({ time_ms: 123 }), 123);
  assert.equal(__internals._ts({ ts: 456 }), 456);
  assert.equal(__internals._ts({}), null);
  assert.equal(__internals._ts(null), null);

  // _csvField: nullish → empty; quoted on comma/quote/newline; doubled inner quotes
  assert.equal(__internals._csvField(null), '');
  assert.equal(__internals._csvField(undefined), '');
  assert.equal(__internals._csvField('plain'), 'plain');
  assert.equal(__internals._csvField('a,b'), '"a,b"');
  assert.equal(__internals._csvField('he said "hi"'), '"he said ""hi"""');
  assert.equal(__internals._csvField('line1\nline2'), '"line1\nline2"');
});
