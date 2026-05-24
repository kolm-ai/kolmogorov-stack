// W812 — Failure-Mode Visualization tests.
//
// Atomic items pinned (one contract per test):
//
//   1) FAILURE_MODES_VERSION matches /^w812-/ (no explicit-array family check;
//      W604 standing directive).
//   2) _bucketLength returns short / medium / long correctly.
//   3) _firstWord lowercases + strips punctuation; empty input → '_'.
//   4) _clusterKey is deterministic for identical events and varies on prompt.
//   5) _clusterId is a stable short hash (starts with 'cl_').
//   6) _vendorClass collapses provider strings → kolm / frontier / open / unknown.
//   7) _isStudent recognizes vendor='kolm', artifact_id, workflow_id ^art_*.
//   8) clusterCaptures honest envelope when missing tenant_id.
//   9) clusterCaptures honest envelope when no events (no_captures_to_cluster).
//  10) clusterCaptures groups events into clusters with stable shape.
//  11) clusterCaptures tenant fence rejects foreign-tenant rows.
//  12) clusterCaptures computes kscore_delta = teacher_mean - student_mean.
//  13) topRegressions filters clusters by min_delta and returns regressions[].
//  14) clusterSamples returns cluster_not_found honest envelope when missing.
//  15) clusterSamples pairs student + teacher events by request_hash.
//  16) emitClusterFailureSignals writes events W720 detector will pick up.
//  17) CLI `kolm failure-modes --json` exits 0 with stable envelope shape.
//
// Anti-brittleness:
//   - Version contract is regex, not equality.
//   - Cluster_id is asserted by shape (prefix + length) not literal value.
//   - No wave812 family-array check.
//
// K-Score seeding note:
//   The canonical event-schema.canonicalize() drops `k_score`, `meta`, `eval`
//   fields. To exercise K-Score-driven cluster math we set
//   KOLM_EVENT_STORE_DRIVER='jsonl' and write raw lines to events.jsonl
//   so the event-store's _jsonlAll() returns them with k_score intact (the
//   JSONL fallback never re-canonicalizes on read — see src/event-store.js
//   line 308). For status='error' / feedback-prefix paths we use the
//   canonical appendEvent path (matches W720 #3 fixture pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w812-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  return tmp;
}

async function _loadMods() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const fm = await import('../src/failure-modes.js');
  const schema = await import('../src/event-schema.js');
  return { es, fm, schema };
}

// Write a JSONL events file directly so k_score / vendor survive the read
// path (canonicalize() would strip them otherwise).
function _seedJsonl(rows) {
  const file = path.join(process.env.KOLM_DATA_DIR, 'events', 'events.jsonl');
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, text, 'utf8');
}

function _row(overrides = {}) {
  const id = 'evt_w812_' + Math.random().toString(36).slice(2, 10);
  const base = {
    event_id: id,
    tenant_id: 'tenant_w812',
    namespace: 'ns_w812',
    created_at: new Date().toISOString(),
    schema_version: 1,
    provider: 'openai',
    vendor: 'openai',
    model: 'gpt-4o-mini',
    prompt_redacted: 'summarize this for me please',
    response_redacted: 'here is your summary',
    status: 'ok',
    request_hash: 'req_' + id.slice(-6),
    prompt_tokens: 10,
    completion_tokens: 5,
    tokens_in: 10,
    tokens_out: 5,
    estimated_cost_usd: 0.0001,
    latency_ms: 100,
  };
  const merged = Object.assign(base, overrides);
  // The canonical event-schema canonicalize() drops top-level k_score (it is
  // not in EVENT_FIELDS). To round-trip K-Score through the event-store, the
  // failure-modes._readKScore reader falls back to parsing JSON-encoded
  // feedback. We mirror that contract at the seed side: when a test passes
  // overrides.k_score we encode it into feedback as {"k_score":<n>}. We also
  // keep the top-level k_score for any reader that looks at the raw line
  // before canonicalize fires (none today, but future-proof).
  if (Number.isFinite(Number(merged.k_score)) && (merged.feedback == null || typeof merged.feedback !== 'string' || merged.feedback[0] !== '{')) {
    merged.feedback = JSON.stringify({ k_score: Number(merged.k_score) });
  }
  return merged;
}

// =============================================================================
// 1) Version constant
// =============================================================================

test('W812 #1 — FAILURE_MODES_VERSION matches /^w812-/', async () => {
  freshDir();
  const { fm } = await _loadMods();
  assert.equal(typeof fm.FAILURE_MODES_VERSION, 'string', 'version is a string');
  assert.ok(/^w812-/.test(fm.FAILURE_MODES_VERSION),
    'FAILURE_MODES_VERSION starts with w812-; got ' + fm.FAILURE_MODES_VERSION);
});

// =============================================================================
// 2) _bucketLength short / medium / long
// =============================================================================

test('W812 #2 — _bucketLength buckets short / medium / long', async () => {
  freshDir();
  const { fm } = await _loadMods();
  assert.equal(fm._bucketLength_for_test('a'.repeat(50)), 'short');
  assert.equal(fm._bucketLength_for_test('a'.repeat(127)), 'short');
  assert.equal(fm._bucketLength_for_test('a'.repeat(128)), 'medium');
  assert.equal(fm._bucketLength_for_test('a'.repeat(300)), 'medium');
  assert.equal(fm._bucketLength_for_test('a'.repeat(511)), 'medium');
  assert.equal(fm._bucketLength_for_test('a'.repeat(512)), 'long');
  assert.equal(fm._bucketLength_for_test('a'.repeat(5000)), 'long');
  // Null/undefined safe.
  assert.equal(fm._bucketLength_for_test(null), 'short');
  assert.equal(fm._bucketLength_for_test(undefined), 'short');
  assert.equal(fm._bucketLength_for_test(''), 'short');
});

// =============================================================================
// 3) _firstWord lowercases + strips punctuation
// =============================================================================

test('W812 #3 — _firstWord lowercases + strips punctuation', async () => {
  freshDir();
  const { fm } = await _loadMods();
  assert.equal(fm._firstWord_for_test('Hello world'), 'hello');
  assert.equal(fm._firstWord_for_test('Help!'), 'help');
  assert.equal(fm._firstWord_for_test('Help.'), 'help');
  assert.equal(fm._firstWord_for_test('SUMMARIZE this'), 'summarize');
  // 'help!' and 'help.' must collide.
  assert.equal(fm._firstWord_for_test('help!'), fm._firstWord_for_test('help.'));
  // Empty / null safety.
  assert.equal(fm._firstWord_for_test(''), '_');
  assert.equal(fm._firstWord_for_test(null), '_');
  assert.equal(fm._firstWord_for_test(undefined), '_');
  // Punctuation-only token still resolves deterministically (to '_').
  assert.equal(fm._firstWord_for_test('???'), '_');
});

// =============================================================================
// 4) _clusterKey is deterministic
// =============================================================================

test('W812 #4 — _clusterKey is deterministic and varies on prompt content', async () => {
  freshDir();
  const { fm } = await _loadMods();
  const a = { prompt_redacted: 'summarize this article', vendor: 'openai' };
  const b = { prompt_redacted: 'summarize this article', vendor: 'anthropic' };
  // Same prompt → same key (vendor not part of key — cluster splits student/teacher
  // INSIDE the cluster, not across clusters).
  assert.equal(fm._clusterKey_for_test(a), fm._clusterKey_for_test(b));
  // Different first word → different key.
  const c = { prompt_redacted: 'translate this paragraph' };
  assert.notEqual(fm._clusterKey_for_test(a), fm._clusterKey_for_test(c));
  // Different length bucket → different key (same first word).
  const d = { prompt_redacted: 'summarize ' + 'x'.repeat(600) };
  assert.notEqual(fm._clusterKey_for_test(a), fm._clusterKey_for_test(d));
  // Stable across calls.
  assert.equal(fm._clusterKey_for_test(a), fm._clusterKey_for_test({ prompt_redacted: 'summarize this article', vendor: 'openai' }));
});

// =============================================================================
// 5) _clusterId is a stable short hash
// =============================================================================

test('W812 #5 — _clusterId is stable short hash starting with cl_', async () => {
  freshDir();
  const { fm } = await _loadMods();
  const id1 = fm._clusterId_for_test('summarize:short');
  const id2 = fm._clusterId_for_test('summarize:short');
  const id3 = fm._clusterId_for_test('translate:short');
  assert.equal(id1, id2, 'same key → same id');
  assert.notEqual(id1, id3, 'different key → different id');
  assert.ok(/^cl_[0-9a-f]{12}$/.test(id1), 'cluster_id matches cl_<12 hex>; got ' + id1);
});

// =============================================================================
// 6) _vendorClass mapping
// =============================================================================

test('W812 #6 — _vendorClass collapses provider → kolm/frontier/open/unknown', async () => {
  freshDir();
  const { fm } = await _loadMods();
  assert.equal(fm._vendorClass_for_test({ vendor: 'kolm' }), 'kolm');
  assert.equal(fm._vendorClass_for_test({ vendor: 'kolm-runtime' }), 'kolm');
  assert.equal(fm._vendorClass_for_test({ vendor: 'anthropic' }), 'frontier');
  assert.equal(fm._vendorClass_for_test({ vendor: 'openai' }), 'frontier');
  assert.equal(fm._vendorClass_for_test({ vendor: 'google' }), 'frontier');
  assert.equal(fm._vendorClass_for_test({ vendor: 'openrouter' }), 'open');
  assert.equal(fm._vendorClass_for_test({ vendor: 'ollama' }), 'open');
  assert.equal(fm._vendorClass_for_test({ vendor: 'vllm' }), 'open');
  // provider-only field (no vendor) still resolves.
  assert.equal(fm._vendorClass_for_test({ provider: 'anthropic' }), 'frontier');
  // Unknown / empty.
  assert.equal(fm._vendorClass_for_test({ vendor: 'mystery' }), 'unknown');
  assert.equal(fm._vendorClass_for_test({}), 'unknown');
  // Case-insensitive.
  assert.equal(fm._vendorClass_for_test({ vendor: 'OpenAI' }), 'frontier');
});

// =============================================================================
// 7) _isStudent recognizes student events
// =============================================================================

test('W812 #7 — _isStudent recognizes vendor=kolm / artifact_id / workflow_id art_*', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // vendor='kolm' → student.
  assert.equal(fm._isStudent_for_test({ vendor: 'kolm' }), true);
  // artifact_id stamped → student.
  assert.equal(fm._isStudent_for_test({ vendor: 'openai', artifact_id: 'art_123' }), true);
  // workflow_id ^art_ → student.
  assert.equal(fm._isStudent_for_test({ vendor: 'openai', workflow_id: 'art_456' }), true);
  assert.equal(fm._isStudent_for_test({ vendor: 'openai', workflow_id: 'ART_x' }), true);
  // meta.artifact_id → student.
  assert.equal(fm._isStudent_for_test({ vendor: 'openai', meta: { artifact_id: 'art_x' } }), true);
  // teacher / no markers → NOT student.
  assert.equal(fm._isStudent_for_test({ vendor: 'openai' }), false);
  assert.equal(fm._isStudent_for_test({ vendor: 'anthropic' }), false);
  assert.equal(fm._isStudent_for_test({}), false);
  assert.equal(fm._isStudent_for_test(null), false);
});

// =============================================================================
// 8) clusterCaptures honest envelope when missing tenant_id
// =============================================================================

test('W812 #8 — clusterCaptures honest envelope when missing tenant_id', async () => {
  freshDir();
  const { fm } = await _loadMods();
  const r = await fm.clusterCaptures({});
  assert.equal(r.ok, false, 'expected ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'missing_tenant_id');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint is human-actionable');
  assert.ok(/^w812-/.test(r.version), 'version stamped; got ' + r.version);
});

// =============================================================================
// 9) clusterCaptures honest envelope when no events
// =============================================================================

test('W812 #9 — clusterCaptures honest envelope when no events (no_captures_to_cluster)', async () => {
  freshDir();
  const { fm } = await _loadMods();
  const r = await fm.clusterCaptures({
    tenant_id: 'tenant_w812_empty',
    namespace: 'ns_w812_empty',
    window_days: 7,
  });
  assert.equal(r.ok, false, 'expected ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'no_captures_to_cluster');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint is human-actionable');
  assert.ok(/^w812-/.test(r.version), 'version stamped');
});

// =============================================================================
// 10) clusterCaptures groups events with stable shape
// =============================================================================

test('W812 #10 — clusterCaptures groups events into clusters with stable shape', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // Seed 4 'summarize' (short, teacher) + 4 'summarize' (short, student) + 2 'translate' (short).
  const tenant = 'tenant_w812_grp';
  const ns = 'ns_w812_grp';
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push(_row({ tenant_id: tenant, namespace: ns, vendor: 'openai',
      prompt_redacted: 'summarize this article ' + i, request_hash: 'h_sum_' + i }));
  }
  for (let i = 0; i < 4; i++) {
    rows.push(_row({ tenant_id: tenant, namespace: ns, vendor: 'kolm', artifact_id: 'art_w812',
      prompt_redacted: 'summarize this article ' + i, request_hash: 'h_sum_' + i }));
  }
  for (let i = 0; i < 2; i++) {
    rows.push(_row({ tenant_id: tenant, namespace: ns, vendor: 'anthropic',
      prompt_redacted: 'translate this line ' + i, request_hash: 'h_tr_' + i }));
  }
  _seedJsonl(rows);
  const r = await fm.clusterCaptures({
    tenant_id: tenant,
    namespace: ns,
    window_days: 7,
    min_samples: 2,
  });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r).slice(0, 600));
  assert.ok(Array.isArray(r.clusters), 'clusters is an array');
  assert.ok(r.clusters.length >= 2, 'expected at least 2 clusters (summarize + translate); got ' + r.clusters.length);
  // Stable shape on every cluster row.
  for (const c of r.clusters) {
    assert.ok(typeof c.cluster_id === 'string' && /^cl_/.test(c.cluster_id), 'cluster_id present');
    assert.ok(typeof c.key === 'string' && c.key.length > 0, 'key non-empty');
    assert.ok(typeof c.topic_seed === 'string', 'topic_seed present');
    assert.ok(['short', 'medium', 'long'].includes(c.length_bucket), 'length_bucket enum');
    assert.ok(Number.isFinite(c.sample_count), 'sample_count finite');
    assert.ok(Number.isFinite(c.student_count), 'student_count finite');
    assert.ok(Number.isFinite(c.teacher_count), 'teacher_count finite');
    assert.ok('student_kscore_mean' in c, 'student_kscore_mean key');
    assert.ok('teacher_kscore_mean' in c, 'teacher_kscore_mean key');
    assert.ok('kscore_delta' in c, 'kscore_delta key');
    assert.ok(c.vendors && typeof c.vendors === 'object', 'vendors map present');
  }
  // The summarize cluster should have student + teacher counts.
  const sumCluster = r.clusters.find((c) => c.topic_seed === 'summarize');
  assert.ok(sumCluster, 'summarize cluster present');
  assert.equal(sumCluster.student_count, 4, 'student_count 4');
  assert.equal(sumCluster.teacher_count, 4, 'teacher_count 4');
  assert.equal(sumCluster.sample_count, 8, 'sample_count 8');
});

// =============================================================================
// 11) clusterCaptures tenant fence
// =============================================================================

test('W812 #11 — clusterCaptures tenant fence rejects foreign-tenant rows', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // Seed same namespace + topic across two tenants.
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push(_row({ tenant_id: 'tenant_w812_a', namespace: 'ns_fence',
      prompt_redacted: 'classify this item ' + i, request_hash: 'a_' + i }));
  }
  for (let i = 0; i < 7; i++) {
    rows.push(_row({ tenant_id: 'tenant_w812_b', namespace: 'ns_fence',
      prompt_redacted: 'classify this item ' + i, request_hash: 'b_' + i }));
  }
  _seedJsonl(rows);
  const r = await fm.clusterCaptures({
    tenant_id: 'tenant_w812_a',
    namespace: 'ns_fence',
    window_days: 7,
    min_samples: 2,
  });
  assert.equal(r.ok, true, 'expected ok:true');
  // Total events scanned should be tenant_a's 3 only.
  assert.equal(r.totals.events_scanned, 3,
    'tenant fence at row level — expected 3 events scanned for tenant_a; got ' + r.totals.events_scanned);
  // All clusters must only count tenant_a's rows.
  const total = r.clusters.reduce((s, c) => s + c.sample_count, 0);
  assert.equal(total, 3, 'cluster row totals should sum to tenant_a count');
});

// =============================================================================
// 12) clusterCaptures K-Score delta math
// =============================================================================

test('W812 #12 — clusterCaptures computes kscore_delta = teacher_mean - student_mean', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // Teacher cluster K-Scores: 0.90, 0.92 (mean = 0.91)
  // Student cluster K-Scores: 0.50, 0.60 (mean = 0.55)
  // Expected delta: 0.91 - 0.55 = 0.36
  const rows = [
    _row({ tenant_id: 'tenant_w812_k', namespace: 'ns_k', vendor: 'openai',
      prompt_redacted: 'summarize this please', request_hash: 'k_1', k_score: 0.90 }),
    _row({ tenant_id: 'tenant_w812_k', namespace: 'ns_k', vendor: 'openai',
      prompt_redacted: 'summarize this please', request_hash: 'k_2', k_score: 0.92 }),
    _row({ tenant_id: 'tenant_w812_k', namespace: 'ns_k', vendor: 'kolm', artifact_id: 'art_k',
      prompt_redacted: 'summarize this please', request_hash: 'k_1', k_score: 0.50 }),
    _row({ tenant_id: 'tenant_w812_k', namespace: 'ns_k', vendor: 'kolm', artifact_id: 'art_k',
      prompt_redacted: 'summarize this please', request_hash: 'k_2', k_score: 0.60 }),
  ];
  _seedJsonl(rows);
  const r = await fm.clusterCaptures({
    tenant_id: 'tenant_w812_k',
    namespace: 'ns_k',
    window_days: 7,
    min_samples: 2,
  });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r).slice(0, 400));
  assert.ok(r.clusters.length >= 1, 'expected ≥1 cluster');
  const c = r.clusters[0];
  assert.equal(c.topic_seed, 'summarize', 'topic_seed = summarize');
  assert.ok(Math.abs(c.teacher_kscore_mean - 0.91) < 1e-6, 'teacher_mean ≈ 0.91; got ' + c.teacher_kscore_mean);
  assert.ok(Math.abs(c.student_kscore_mean - 0.55) < 1e-6, 'student_mean ≈ 0.55; got ' + c.student_kscore_mean);
  assert.ok(Math.abs(c.kscore_delta - 0.36) < 1e-3, 'kscore_delta ≈ 0.36; got ' + c.kscore_delta);
});

// =============================================================================
// 13) topRegressions filters by min_delta
// =============================================================================

test('W812 #13 — topRegressions filters clusters by min_delta', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // Two clusters: one with delta 0.36 (big regression), one with delta 0.02 (noise).
  const rows = [
    // Big regression cluster (summarize, delta 0.36).
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'openai',
      prompt_redacted: 'summarize doc', request_hash: 'r1a', k_score: 0.91 }),
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'kolm', artifact_id: 'art_r',
      prompt_redacted: 'summarize doc', request_hash: 'r1a', k_score: 0.55 }),
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'openai',
      prompt_redacted: 'summarize doc', request_hash: 'r1b', k_score: 0.91 }),
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'kolm', artifact_id: 'art_r',
      prompt_redacted: 'summarize doc', request_hash: 'r1b', k_score: 0.55 }),
    // Noise cluster (translate, delta 0.02).
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'openai',
      prompt_redacted: 'translate phrase', request_hash: 'r2a', k_score: 0.80 }),
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'kolm', artifact_id: 'art_r',
      prompt_redacted: 'translate phrase', request_hash: 'r2a', k_score: 0.78 }),
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'openai',
      prompt_redacted: 'translate phrase', request_hash: 'r2b', k_score: 0.80 }),
    _row({ tenant_id: 'tenant_w812_r', namespace: 'ns_r', vendor: 'kolm', artifact_id: 'art_r',
      prompt_redacted: 'translate phrase', request_hash: 'r2b', k_score: 0.78 }),
  ];
  _seedJsonl(rows);
  // min_delta 0.05 → only the summarize cluster survives.
  const r = await fm.topRegressions({
    tenant_id: 'tenant_w812_r',
    namespace: 'ns_r',
    window_days: 7,
    min_delta: 0.05,
    min_samples: 2,
  });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.regressions), 'regressions is an array');
  assert.equal(r.regressions.length, 1, 'expected 1 regression above 0.05; got ' + r.regressions.length);
  assert.equal(r.regressions[0].topic_seed, 'summarize');
  assert.equal(r.totals.regressions_count, 1);
  // Lowering min_delta should surface both.
  const r2 = await fm.topRegressions({
    tenant_id: 'tenant_w812_r',
    namespace: 'ns_r',
    window_days: 7,
    min_delta: 0.01,
    min_samples: 2,
  });
  assert.equal(r2.regressions.length, 2, 'min_delta=0.01 surfaces both regressions');
});

// =============================================================================
// 14) clusterSamples honest envelope when cluster not found
// =============================================================================

test('W812 #14 — clusterSamples returns cluster_not_found honest envelope when missing', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // Seed one row so clusterCaptures() doesn't bail with no_captures_to_cluster.
  _seedJsonl([
    _row({ tenant_id: 'tenant_w812_s', namespace: 'ns_s', prompt_redacted: 'summarize this please' }),
    _row({ tenant_id: 'tenant_w812_s', namespace: 'ns_s', prompt_redacted: 'summarize this please',
      vendor: 'kolm', artifact_id: 'art_s' }),
  ]);
  const r = await fm.clusterSamples({
    cluster_id: 'cl_deadbeefcafe',  // does not match any real cluster
    tenant_id: 'tenant_w812_s',
    namespace: 'ns_s',
    window_days: 7,
  });
  assert.equal(r.ok, false, 'expected ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'cluster_not_found');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint is human-actionable');
  assert.ok(/^w812-/.test(r.version), 'version stamped');
  // Missing cluster_id case.
  const r2 = await fm.clusterSamples({ tenant_id: 'tenant_w812_s', namespace: 'ns_s' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'missing_cluster_id');
});

// =============================================================================
// 15) clusterSamples pairs student+teacher rows by request_hash
// =============================================================================

test('W812 #15 — clusterSamples pairs student + teacher events by request_hash', async () => {
  freshDir();
  const { fm } = await _loadMods();
  // 3 paired captures: same prompt + same request_hash, both sides present.
  const tenant = 'tenant_w812_pair';
  const ns = 'ns_pair';
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push(_row({
      tenant_id: tenant, namespace: ns, vendor: 'openai',
      prompt_redacted: 'classify this sentence', response_redacted: 'TEACHER reply ' + i,
      request_hash: 'pair_' + i, k_score: 0.9,
    }));
    rows.push(_row({
      tenant_id: tenant, namespace: ns, vendor: 'kolm', artifact_id: 'art_p',
      prompt_redacted: 'classify this sentence', response_redacted: 'STUDENT reply ' + i,
      request_hash: 'pair_' + i, k_score: 0.5,
    }));
  }
  _seedJsonl(rows);
  // Find the cluster_id by running clusterCaptures first.
  const env = await fm.clusterCaptures({ tenant_id: tenant, namespace: ns, window_days: 7, min_samples: 2 });
  assert.equal(env.ok, true);
  assert.ok(env.clusters.length >= 1, 'expected ≥1 cluster');
  const cid = env.clusters[0].cluster_id;
  const s = await fm.clusterSamples({
    cluster_id: cid, tenant_id: tenant, namespace: ns, window_days: 7,
  });
  assert.equal(s.ok, true, 'expected samples envelope ok:true; got ' + JSON.stringify(s).slice(0, 300));
  assert.equal(s.cluster_id, cid);
  assert.ok(Array.isArray(s.samples), 'samples is array');
  assert.ok(s.samples.length >= 1, 'at least 1 sample');
  // Every sample with both sides should expose student_response AND teacher_response.
  const both = s.samples.find((x) => x.student_response && x.teacher_response);
  assert.ok(both, 'at least one sample has both sides paired');
  assert.ok(/STUDENT reply/.test(both.student_response), 'student_response routed to student column');
  assert.ok(/TEACHER reply/.test(both.teacher_response), 'teacher_response routed to teacher column');
  assert.ok(Number.isFinite(both.student_kscore) || both.student_kscore == null, 'student_kscore key present');
  assert.ok(Number.isFinite(both.teacher_kscore) || both.teacher_kscore == null, 'teacher_kscore key present');
});

// =============================================================================
// 16) emitClusterFailureSignals writes events W720 picks up
// =============================================================================

test('W812 #16 — emitClusterFailureSignals writes events W720 detector picks up', async () => {
  freshDir();
  const { fm, es } = await _loadMods();
  // Seed a regression cluster (student trails teacher by >0.05).
  const tenant = 'tenant_w812_emit';
  const ns = 'ns_emit';
  const rows = [
    _row({ tenant_id: tenant, namespace: ns, vendor: 'openai',
      prompt_redacted: 'summarize this brief', request_hash: 'em_1', k_score: 0.91 }),
    _row({ tenant_id: tenant, namespace: ns, vendor: 'kolm', artifact_id: 'art_em',
      prompt_redacted: 'summarize this brief', request_hash: 'em_1', k_score: 0.45 }),
    _row({ tenant_id: tenant, namespace: ns, vendor: 'openai',
      prompt_redacted: 'summarize this brief', request_hash: 'em_2', k_score: 0.91 }),
    _row({ tenant_id: tenant, namespace: ns, vendor: 'kolm', artifact_id: 'art_em',
      prompt_redacted: 'summarize this brief', request_hash: 'em_2', k_score: 0.45 }),
  ];
  _seedJsonl(rows);
  const r = await fm.emitClusterFailureSignals({
    tenant_id: tenant, namespace: ns, min_delta: 0.05, top: 5,
  });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r).slice(0, 400));
  assert.ok(Array.isArray(r.emitted), 'emitted is an array');
  assert.equal(r.emitted.length, 1, 'expected 1 signal emitted for 1 regression');
  // Verify the signal landed in the event-store. listEvents reads from
  // both jsonl rows we wrote AND the appendEvent rows that emitter
  // produced. We grep for the synthetic request_hash prefix.
  const events = await es.listEvents({ tenant_id: tenant, namespace: ns, limit: 100, order: 'desc' });
  const signalRows = events.filter((e) => e.request_hash && /^w812-failmode-/.test(e.request_hash));
  assert.ok(signalRows.length >= 1, 'at least one w812-failmode-* row landed in event-store');
  // The signal row must satisfy W720 _isFailureEvent: status='error' or
  // feedback starts with negative prefix (fail/thumb_down/reject/etc.).
  const sig = signalRows[0];
  const triggers720 = (sig.status === 'error')
    || (typeof sig.feedback === 'string' && /^fail/i.test(sig.feedback));
  assert.ok(triggers720, 'signal row must trigger W720 _isFailureEvent; got status=' + sig.status + ' feedback=' + sig.feedback);
});

// =============================================================================
// 17) CLI `kolm failure-modes --json` exits 0 with stable envelope
// =============================================================================

test('W812 #17 — CLI `kolm failure-modes --json` exits 0 with stable envelope shape', () => {
  const tmp = freshDir();
  // Seed a cluster the CLI will surface.
  const rows = [
    _row({ tenant_id: 'tenant_w812_cli', namespace: 'ns_cli', vendor: 'openai',
      prompt_redacted: 'summarize doc', request_hash: 'cli_1', k_score: 0.9 }),
    _row({ tenant_id: 'tenant_w812_cli', namespace: 'ns_cli', vendor: 'kolm', artifact_id: 'art_cli',
      prompt_redacted: 'summarize doc', request_hash: 'cli_1', k_score: 0.5 }),
    _row({ tenant_id: 'tenant_w812_cli', namespace: 'ns_cli', vendor: 'openai',
      prompt_redacted: 'summarize doc', request_hash: 'cli_2', k_score: 0.9 }),
    _row({ tenant_id: 'tenant_w812_cli', namespace: 'ns_cli', vendor: 'kolm', artifact_id: 'art_cli',
      prompt_redacted: 'summarize doc', request_hash: 'cli_2', k_score: 0.5 }),
  ];
  _seedJsonl(rows);
  // Spawn the CLI subprocess in the same env so it sees the JSONL file.
  const env = {
    ...process.env,
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: process.env.KOLM_HOME,
    KOLM_ENV: 'test',
    KOLM_EVENT_STORE_DRIVER: 'jsonl',
  };
  const res = spawnSync(process.execPath, [
    CLI_PATH, 'failure-modes',
    '--json',
    '--tenant', 'tenant_w812_cli',
    '--namespace', 'ns_cli',
    '--window-days', '7',
  ], { env, encoding: 'utf8' });
  assert.equal(res.status, 0,
    'CLI exited non-zero. stdout=' + (res.stdout || '').slice(0, 600) + ' stderr=' + (res.stderr || '').slice(0, 600));
  let parsed;
  try { parsed = JSON.parse(res.stdout); }
  catch (e) {
    assert.fail('CLI output not JSON: ' + (res.stdout || '').slice(0, 600));
  }
  assert.equal(parsed.ok, true, 'CLI envelope ok:true');
  assert.ok(Array.isArray(parsed.clusters), 'clusters present');
  assert.ok(parsed.clusters.length >= 1, 'at least 1 cluster surfaced');
  assert.ok(/^w812-/.test(parsed.version), 'version starts with w812-');
  assert.ok(parsed.totals && Number.isFinite(parsed.totals.events_scanned), 'totals.events_scanned finite');
});
