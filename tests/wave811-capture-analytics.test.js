// W811 — capture analytics dashboard tests.
//
// Atomic items pinned (12 tests, regex+threshold checks per W604):
//
//   1) CAPTURE_ANALYTICS_VERSION matches /^w811-/ (W604 anti-brittleness)
//   2) fingerprintPrompt + cosineSparse + clusterGapScore math correctness
//   3) clusterCaptures groups same-task prompts into ONE cluster
//   4) clusterCaptures separates distinctly different prompts into >1 clusters
//   5) clusterCaptures honest empty: zero rows → {clusters:[], total_n:0}
//   6) clusterCaptures overflow: when row-count > MAX_CLUSTERS, surface overflow_n
//   7) kscoreBreakdown returns {status:'no_samples'} for clusters with no kscore
//   8) kscoreBreakdown computes mean/p50/p95 when rows carry kscore
//   9) idrStalenessGauge returns gauge=1 + status='no_recent_captures' on empty
//  10) idrStalenessGauge returns gauge in [0,1] with correct ratio math
//  11) clustersToCsv emits stable header + one row per cluster
//  12) analyzeNamespace honest envelope when tenant_id missing
//  13) analyzeNamespace honest envelope when namespace missing
//  14) analyzeNamespace honest envelope when no captures for (tenant, ns)
//  15) analyzeNamespace tenant fence — foreign-tenant rows must NEVER cross
//  16) analyzeNamespace emits per-cluster gap_signal events into event-store (W811-7)
//  17) analyzeNamespaceCsv top-level call returns {ok:true, csv:'...'}
//  18) CLI `kolm captures analytics --namespace <ns> --json` returns stable envelope
//
// W604 anti-brittleness: every version assertion uses regex /^w811-/ instead
// of literal equality so a v1.x bump in the same wave does not force a
// coordinated test-rev. Wave-family checks use regex /wave\d{3,4}/ + a
// numeric threshold, never an explicit-array family list.
//
// Sibling-wave safety: this file imports ONLY W811 modules (capture-analytics)
// + the shared store + event-store + capture-stats it depends on. It does NOT
// touch W720 / W807 / W808 / W809 / W810 modules or call into them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

// =============================================================================
// Per-test isolation — same pattern as wave808-capture-poisoning.test.js.
// =============================================================================
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w811-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  // Force JSON store driver so tests are deterministic across machines.
  process.env.KOLM_STORE_DRIVER = 'json';
  // Force JSONL event-store driver so we can read events back without
  // depending on optional node:sqlite.
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// One-time module references — never cache-bust (see wave808 comment for why).
let _anaMod = null, _storeMod = null, _eventStoreMod = null;
async function _loadMods() {
  if (!_anaMod) _anaMod = await import('../src/capture-analytics.js');
  if (!_storeMod) _storeMod = await import('../src/store.js');
  if (!_eventStoreMod) _eventStoreMod = await import('../src/event-store.js');
  try { _storeMod.reset(); } catch (_) {} // deliberate: cleanup
  try { _eventStoreMod._resetForTests(); } catch (_) {} // deliberate: cleanup
  return { anaMod: _anaMod, storeMod: _storeMod, eventStoreMod: _eventStoreMod };
}

// Seed `count` similar-topic captures (so clustering collapses them) into the
// observations table under (tenant_id, namespace). Each row carries a
// distinct prompt suffix so token counts vary but the topic stays the same.
function _seedSimilar(storeMod, { tenant_id, namespace, count = 6, topic = 'invoice', kscore = null }) {
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    storeMod.insert('observations', {
      event_id: 'obs_w811_' + tenant_id + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
      id: 'obs_w811_' + tenant_id + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
      tenant_id,
      tenant: tenant_id,
      namespace,
      corpus_namespace: namespace,
      prompt: 'extract ' + topic + ' totals from PDF page ' + i,
      response: 'parsed ' + topic + ' total: $' + (100 + i * 17),
      latency_ms: 100,
      kscore: kscore != null ? kscore : undefined,
      created_at: new Date(base - (count - i) * 1000).toISOString(),
    });
  }
}

// Seed `count` distinctly-different prompts so clustering yields > 1 buckets.
function _seedDistinct(storeMod, { tenant_id, namespace, count = 5 }) {
  const topics = [
    'translate French paragraph into English with preserved tone',
    'summarize quarterly financial report into three bullet points',
    'classify customer email by intent: refund, support, or sales',
    'generate Python unit tests for a sorting algorithm',
    'identify named entities in medical discharge summary',
  ];
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length];
    storeMod.insert('observations', {
      event_id: 'obs_w811_dist_' + tenant_id + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
      tenant_id,
      tenant: tenant_id,
      namespace,
      corpus_namespace: namespace,
      prompt: topic + ' #' + i,
      response: 'response #' + i,
      latency_ms: 100,
      created_at: new Date(base - (count - i) * 1000).toISOString(),
    });
  }
}

// =============================================================================
// 1) CAPTURE_ANALYTICS_VERSION matches /^w811-/
// =============================================================================
test('W811 #1 — CAPTURE_ANALYTICS_VERSION matches /^w811-/ (W604 anti-brittleness)', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  assert.ok(/^w811-/.test(anaMod.CAPTURE_ANALYTICS_VERSION),
    `CAPTURE_ANALYTICS_VERSION matches /^w811-/; got ${anaMod.CAPTURE_ANALYTICS_VERSION}`);
  assert.equal(typeof anaMod.CLUSTER_SIM_THRESHOLD, 'number');
  assert.ok(anaMod.MAX_CLUSTERS >= 4, `MAX_CLUSTERS >= 4 for sensible dashboard; got ${anaMod.MAX_CLUSTERS}`);
  assert.equal(typeof anaMod.GAP_SIGNAL_EVENT_KIND, 'string');
  assert.ok(/w811/.test(anaMod.GAP_SIGNAL_EVENT_KIND),
    `GAP_SIGNAL_EVENT_KIND embeds wave tag; got ${anaMod.GAP_SIGNAL_EVENT_KIND}`);
});

// =============================================================================
// 2) Pure-math primitives — fingerprintPrompt + cosineSparse + clusterGapScore
// =============================================================================
test('W811 #2 — fingerprintPrompt / cosineSparse / clusterGapScore math correctness', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  // fingerprintPrompt: identical strings → identical fingerprints
  const fpA = anaMod.fingerprintPrompt('parse invoice totals');
  const fpB = anaMod.fingerprintPrompt('parse invoice totals');
  assert.deepEqual(fpA, fpB, 'same input yields same fingerprint');
  // empty string → empty object
  assert.deepEqual(anaMod.fingerprintPrompt(''), {}, 'empty prompt yields empty fp');
  assert.deepEqual(anaMod.fingerprintPrompt(null), {}, 'null prompt yields empty fp');
  // cosineSparse: identical → 1.0, disjoint → 0, partial → in (0,1)
  assert.equal(anaMod.cosineSparse({}, {}), 0, 'two empties cosine is 0 (not NaN)');
  assert.equal(anaMod.cosineSparse(fpA, fpB), 1, 'identical fps cosine is 1');
  const fpC = anaMod.fingerprintPrompt('completely different sentence about weather');
  const simAC = anaMod.cosineSparse(fpA, fpC);
  assert.ok(simAC >= 0 && simAC < 0.3, `disjoint topics cosine in [0,0.3); got ${simAC}`);
  // clusterGapScore: a small cluster with a low kscore in a stale namespace should
  // produce a near-1 gap.
  const big = { n: 100 };
  const small = { n: 1 };
  const lowKs = { kscore: 0.2 };
  const highKs = { kscore: 0.95 };
  const gapBigHi = anaMod.clusterGapScore(big, highKs, 100, 0);
  const gapSmallLow = anaMod.clusterGapScore(small, lowKs, 100, 1);
  assert.ok(gapBigHi >= 0 && gapBigHi <= 1, `gap in [0,1]; got ${gapBigHi}`);
  assert.ok(gapSmallLow >= 0 && gapSmallLow <= 1, `gap in [0,1]; got ${gapSmallLow}`);
  assert.ok(gapSmallLow > gapBigHi, `small+low+stale > big+high+fresh; got ${gapSmallLow} vs ${gapBigHi}`);
});

// =============================================================================
// 3) clusterCaptures groups same-task prompts into ONE cluster
// =============================================================================
test('W811 #3 — clusterCaptures groups same-task prompts into one cluster', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const captures = [];
  for (let i = 0; i < 10; i++) {
    captures.push({
      event_id: 'e' + i,
      prompt: 'extract invoice totals from PDF page ' + i,
    });
  }
  const { clusters, total_n, overflow_n } = anaMod.clusterCaptures(captures);
  assert.equal(total_n, 10);
  assert.equal(overflow_n, 0);
  assert.equal(clusters.length, 1, `same topic ⇒ one cluster; got ${clusters.length}`);
  assert.equal(clusters[0].n, 10, `cluster n = 10; got ${clusters[0].n}`);
  // top_tokens should mention "invoice" or "totals" or "extract"
  const top = clusters[0].top_tokens.join(' ');
  assert.ok(/invoice|totals|extract/.test(top), `top_tokens reflect topic; got ${top}`);
});

// =============================================================================
// 4) clusterCaptures separates distinctly different prompts
// =============================================================================
test('W811 #4 — clusterCaptures separates distinctly different prompts into >1 clusters', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const captures = [
    { event_id: 'a1', prompt: 'translate French paragraph into English' },
    { event_id: 'a2', prompt: 'translate French paragraph into English with tone preserved' },
    { event_id: 'b1', prompt: 'summarize quarterly financial report into bullets' },
    { event_id: 'b2', prompt: 'summarize quarterly financial report executive bullets' },
    { event_id: 'c1', prompt: 'classify customer email by refund or support intent' },
  ];
  const { clusters } = anaMod.clusterCaptures(captures);
  assert.ok(clusters.length >= 2, `distinct topics yield >= 2 clusters; got ${clusters.length}`);
  // Every cluster_id must match the documented schema 'cl_<hash>_<tokens>'.
  for (const c of clusters) {
    assert.ok(/^cl_[0-9a-f]{8}_/.test(c.cluster_id), `cluster_id schema; got ${c.cluster_id}`);
  }
});

// =============================================================================
// 5) Honest empty input
// =============================================================================
test('W811 #5 — clusterCaptures honest empty: zero rows → clusters:[], total_n:0', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const out = anaMod.clusterCaptures([]);
  assert.equal(out.total_n, 0);
  assert.equal(out.overflow_n, 0);
  assert.deepEqual(out.clusters, []);
  assert.ok(/^w811-/.test(out.version));
});

// =============================================================================
// 6) Overflow contract — MAX_CLUSTERS cap with overflow_n surfaced
// =============================================================================
test('W811 #6 — clusterCaptures respects max_clusters and surfaces overflow_n honestly', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const captures = [];
  for (let i = 0; i < 20; i++) {
    captures.push({ event_id: 'e' + i, prompt: 'unique-topic-' + i + ' some context' });
  }
  const { clusters, overflow_n, total_n } = anaMod.clusterCaptures(captures, { max_clusters: 5 });
  assert.equal(total_n, 20);
  assert.ok(clusters.length <= 5, `cluster cap honored; got ${clusters.length}`);
  assert.ok(overflow_n >= 0, `overflow_n is non-negative; got ${overflow_n}`);
  // Sum of cluster.n + overflow_n must equal total_n (no row lost / fabricated).
  let sum = overflow_n;
  for (const c of clusters) sum += c.n;
  assert.equal(sum, total_n, `cluster ns + overflow = total; got ${sum} vs ${total_n}`);
});

// =============================================================================
// 7) kscoreBreakdown honest empty per cluster
// =============================================================================
test('W811 #7 — kscoreBreakdown returns no_samples for clusters with no kscore rows', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const captures = [
    { event_id: 'e1', prompt: 'translate French into English' },
    { event_id: 'e2', prompt: 'translate French into English again' },
  ];
  const { clusters } = anaMod.clusterCaptures(captures);
  const { breakdown } = anaMod.kscoreBreakdown(clusters, captures);
  assert.equal(breakdown.length, clusters.length);
  for (const b of breakdown) {
    assert.equal(b.status, 'no_samples');
    assert.equal(b.kscore, null, `null (not 0) when missing; got ${b.kscore}`);
    assert.equal(b.n_samples, 0);
  }
});

// =============================================================================
// 8) kscoreBreakdown computes mean/p50/p95 when scores present
// =============================================================================
test('W811 #8 — kscoreBreakdown computes mean/p50/p95 when rows carry kscore', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const captures = [];
  const ks = [0.50, 0.60, 0.70, 0.80, 0.90];
  for (let i = 0; i < ks.length; i++) {
    captures.push({
      event_id: 'e' + i,
      prompt: 'translate French paragraph into English ' + i,
      kscore: ks[i],
    });
  }
  const { clusters } = anaMod.clusterCaptures(captures);
  const { breakdown } = anaMod.kscoreBreakdown(clusters, captures);
  // One cluster (same topic), n_samples=5.
  const b = breakdown[0];
  assert.equal(b.n_samples, 5);
  assert.equal(b.status, 'ok');
  assert.ok(Math.abs(b.kscore - 0.70) < 0.01, `mean ≈ 0.70; got ${b.kscore}`);
  assert.ok(b.p50 >= 0.5 && b.p50 <= 0.9, `p50 in range; got ${b.p50}`);
  assert.ok(b.p95 >= 0.7 && b.p95 <= 0.9, `p95 in range; got ${b.p95}`);
});

// =============================================================================
// 9) idrStalenessGauge no-data honesty
// =============================================================================
test('W811 #9 — idrStalenessGauge: zero comparison rows → gauge=1 + status:no_recent_captures', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const out = anaMod.idrStalenessGauge([]);
  assert.equal(out.gauge, 1.0);
  assert.equal(out.status, 'no_recent_captures');
  assert.equal(out.recent_n, 0);
  assert.equal(out.comparison_n, 0);
  // Old-timestamp row (90d ago) should still produce status='no_recent_captures'
  // when the comparison window is 30d (so the row is past the window).
  const old = [{ created_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString() }];
  const out2 = anaMod.idrStalenessGauge(old);
  assert.equal(out2.status, 'no_recent_captures', 'rows older than 30d don\'t count');
});

// =============================================================================
// 10) idrStalenessGauge ratio math
// =============================================================================
test('W811 #10 — idrStalenessGauge: ratio math + gauge in [0,1]', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const now = Date.now();
  // 4 rows: 2 within last 7d, 2 older but within 30d
  const rows = [
    { created_at: new Date(now - 1 * 24 * 3600 * 1000).toISOString() }, // 1d (recent)
    { created_at: new Date(now - 3 * 24 * 3600 * 1000).toISOString() }, // 3d (recent)
    { created_at: new Date(now - 15 * 24 * 3600 * 1000).toISOString() }, // 15d (comparison only)
    { created_at: new Date(now - 25 * 24 * 3600 * 1000).toISOString() }, // 25d (comparison only)
  ];
  const out = anaMod.idrStalenessGauge(rows, { now_ms: now });
  assert.equal(out.recent_n, 2);
  assert.equal(out.comparison_n, 4);
  assert.equal(out.status, 'ok');
  assert.ok(out.gauge >= 0 && out.gauge <= 1, `gauge in [0,1]; got ${out.gauge}`);
  // 1 - 2/4 = 0.5
  assert.ok(Math.abs(out.gauge - 0.5) < 0.0001, `gauge ≈ 0.5; got ${out.gauge}`);
});

// =============================================================================
// 11) clustersToCsv header + row count
// =============================================================================
test('W811 #11 — clustersToCsv emits stable header + one row per cluster', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const captures = [
    { event_id: 'a1', prompt: 'translate French paragraph', kscore: 0.8 },
    { event_id: 'a2', prompt: 'translate French paragraph again', kscore: 0.9 },
    { event_id: 'b1', prompt: 'summarize quarterly report bullets' },
  ];
  const { clusters } = anaMod.clusterCaptures(captures);
  const { breakdown } = anaMod.kscoreBreakdown(clusters, captures);
  const csv = anaMod.clustersToCsv(clusters, breakdown);
  const lines = csv.trim().split('\n');
  // Header + one row per cluster.
  assert.equal(lines.length, 1 + clusters.length);
  // Header columns are documented + stable.
  const header = lines[0];
  for (const col of ['cluster_id', 'n', 'top_tokens', 'n_kscore_samples', 'kscore_mean']) {
    assert.ok(header.includes(col), `header includes ${col}; got ${header}`);
  }
  // Quoted-field-with-comma handling: synthesize a cluster whose top_tokens contain a comma.
  const tricky = anaMod.clustersToCsv(
    [{ cluster_id: 'cl_test_x', n: 1, top_tokens: ['a,b', 'c'], example_prompts: ['hello, world'] }],
    [{ cluster_id: 'cl_test_x', n_samples: 0, status: 'no_samples' }],
  );
  assert.ok(tricky.includes('"a,b c"') || tricky.includes('"hello, world"'),
    `CSV escapes commas; got ${tricky}`);
});

// =============================================================================
// 12) analyzeNamespace honest envelope when tenant_id missing
// =============================================================================
test('W811 #12 — analyzeNamespace returns honest envelope when tenant_id missing', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const out = await anaMod.analyzeNamespace({ namespace: 'foo' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'missing_tenant_id');
  assert.ok(/^w811-/.test(out.version));
});

// =============================================================================
// 13) analyzeNamespace honest envelope when namespace missing
// =============================================================================
test('W811 #13 — analyzeNamespace returns honest envelope when namespace missing', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const out = await anaMod.analyzeNamespace({ tenant_id: 'tenant_w811_n' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'missing_namespace');
});

// =============================================================================
// 14) analyzeNamespace honest empty for (tenant, namespace) with no captures
// =============================================================================
test('W811 #14 — analyzeNamespace returns no_captures when nothing in store', async () => {
  freshDir();
  const { anaMod } = await _loadMods();
  const out = await anaMod.analyzeNamespace({
    tenant_id: 'tenant_w811_empty',
    namespace: 'ns_empty',
    emit_gap_signal: false,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_captures');
  assert.ok(typeof out.hint === 'string' && out.hint.length > 0);
});

// =============================================================================
// 15) Tenant-fence — foreign-tenant rows must NEVER cross the boundary
// =============================================================================
test('W811 #15 — analyzeNamespace tenant fence: foreign rows do not show up', async () => {
  freshDir();
  const { anaMod, storeMod } = await _loadMods();
  // Tenant A has 6 invoice captures
  _seedSimilar(storeMod, { tenant_id: 'tenant_w811_a', namespace: 'shared_ns', count: 6, topic: 'invoice' });
  // Tenant B has 6 completely different captures in the SAME namespace string
  _seedSimilar(storeMod, { tenant_id: 'tenant_w811_b', namespace: 'shared_ns', count: 6, topic: 'medical' });
  const a = await anaMod.analyzeNamespace({
    tenant_id: 'tenant_w811_a', namespace: 'shared_ns', emit_gap_signal: false,
  });
  assert.equal(a.ok, true);
  assert.equal(a.total_n, 6, `tenant A only sees their 6 rows; got ${a.total_n}`);
  // None of the example_prompts should mention 'medical'.
  for (const c of a.clusters) {
    for (const ex of (c.example_prompts || [])) {
      assert.ok(!/medical/.test(ex), `tenant A must not see tenant B prompts; got: ${ex}`);
    }
  }
});

// =============================================================================
// 16) Gap-signal events are emitted into the event-store (W811-7)
// =============================================================================
test('W811 #16 — analyzeNamespace emits per-cluster gap_signal events (W811-7)', async () => {
  freshDir();
  const { anaMod, storeMod, eventStoreMod } = await _loadMods();
  _seedSimilar(storeMod, { tenant_id: 'tenant_w811_gap', namespace: 'ns_gap', count: 8, topic: 'invoice' });
  _seedDistinct(storeMod, { tenant_id: 'tenant_w811_gap', namespace: 'ns_gap', count: 5 });
  const out = await anaMod.analyzeNamespace({
    tenant_id: 'tenant_w811_gap',
    namespace: 'ns_gap',
    emit_gap_signal: true,
  });
  assert.equal(out.ok, true);
  assert.ok(out.gap_signals_emitted >= 1, `at least one gap_signal event emitted; got ${out.gap_signals_emitted}`);
  // Read back from the event-store and verify the canonical kind.
  const events = await eventStoreMod.listEvents({
    tenant_id: 'tenant_w811_gap',
    namespace: 'ns_gap',
    limit: 100,
  });
  const gap = events.filter((e) => e.model === anaMod.GAP_SIGNAL_EVENT_KIND);
  assert.ok(gap.length >= 1, `gap_signal events readable from store; got ${gap.length}`);
  for (const e of gap) {
    assert.equal(e.tenant_id, 'tenant_w811_gap', 'event carries the right tenant');
    assert.ok(/^cl_/.test(e.request_hash), `cluster_id stamped on request_hash; got ${e.request_hash}`);
    // Payload survives the canonical-event round-trip via the `feedback`
    // field prefix-encoding (see GAP_SIGNAL_FEEDBACK_PREFIX comment).
    assert.ok(typeof e.feedback === 'string'
      && e.feedback.startsWith(anaMod.GAP_SIGNAL_FEEDBACK_PREFIX),
      `feedback carries gap_signal prefix; got ${e.feedback}`);
    const parsed = anaMod.parseGapSignal(e);
    assert.ok(parsed && typeof parsed === 'object',
      `parseGapSignal round-trips; got ${parsed}`);
    assert.ok(/^w811-/.test(parsed.version));
    assert.ok(typeof parsed.gap_score === 'number'
      && parsed.gap_score >= 0 && parsed.gap_score <= 1,
      `gap_score in [0,1]; got ${parsed.gap_score}`);
  }
});

// =============================================================================
// 17) analyzeNamespaceCsv top-level call
// =============================================================================
test('W811 #17 — analyzeNamespaceCsv returns {ok:true, csv:string}', async () => {
  freshDir();
  const { anaMod, storeMod } = await _loadMods();
  _seedSimilar(storeMod, { tenant_id: 'tenant_w811_csv', namespace: 'ns_csv', count: 5, topic: 'translate' });
  const out = await anaMod.analyzeNamespaceCsv({
    tenant_id: 'tenant_w811_csv',
    namespace: 'ns_csv',
  });
  assert.equal(out.ok, true);
  assert.ok(typeof out.csv === 'string' && out.csv.length > 0);
  // Header sanity.
  assert.ok(/cluster_id/.test(out.csv));
  assert.ok(/^w811-/.test(out.version));
});

// =============================================================================
// 18) CLI `kolm captures analytics --namespace <ns> --json`
// =============================================================================
test('W811 #18 — CLI kolm captures analytics --json returns stable envelope', async () => {
  const tmp = freshDir();
  // Seed a few captures so the CLI returns ok:true (not no_captures).
  const { storeMod } = await _loadMods();
  _seedSimilar(storeMod, { tenant_id: 'local', namespace: 'ns_cli_811', count: 6, topic: 'invoice' });

  const env = {
    ...process.env,
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_ENV: 'test',
    KOLM_STORE_DRIVER: 'json',
    KOLM_EVENT_STORE_DRIVER: 'jsonl',
  };
  const result = spawnSync(process.execPath, [
    CLI_PATH, 'captures', 'analytics',
    '--namespace', 'ns_cli_811',
    '--tenant', 'local',
    '--json',
  ], { env, encoding: 'utf8' });
  // CLI must NOT crash. Honesty contract: exit 0 with ok:true OR exit 3 with ok:false.
  assert.ok([0, 3].includes(result.status),
    `CLI exit code in {0,3}; got ${result.status} stderr=${result.stderr}`);
  const out = (result.stdout || '').trim();
  assert.ok(out.startsWith('{'), `CLI emits JSON envelope; got: ${out.slice(0, 200)}`);
  let env_;
  try { env_ = JSON.parse(out); } catch (e) {
    assert.fail('CLI JSON envelope must parse; got: ' + out.slice(0, 200));
  }
  assert.ok(/^w811-/.test(env_.version), `envelope carries w811 version; got ${env_.version}`);
});
