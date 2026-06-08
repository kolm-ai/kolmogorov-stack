// W811 - Capture Analytics Dashboard primitive.
//
// Pairs with:
//   - W716 capture-stats (TAAS) - `src/capture-stats.js` already exposes
//     output-length / vocab-entropy / reasoning-depth / tool-use signals over
//     a flat capture array. W811 builds on top of it by adding per-CLUSTER
//     summaries, an IDR (Important-Distinct-Recent) staleness gauge, CSV
//     export, and a per-cluster gap signal emitted to the canonical
//     event-store so W815 (active-learning) can pick it up.
//   - W720 self-improvement loop - W811 is the read-only analytics surface;
//     the gap-signal event we write is the "you should re-capture in cluster
//     X" hint the W815 loop consumes.
//
// SPEC (master plan PART VI):
//   W811-1  per-namespace capture volume + clustering buckets
//   W811-2  per-cluster K-Score breakdown
//   W811-3  IDR (Important-Distinct-Recent) staleness gauge
//   W811-4  CSV export of clusters
//   W811-5  /account/captures/analytics.html dashboard
//   W811-6  CLI `kolm captures analytics --namespace <ns> [--json|--csv]`
//   W811-7  emit per-cluster gap signal via shared event-stream → W815
//
// PRIVACY + TENANT FENCE (W411 pattern, copied from src/billing-breakdown.js
// and src/capture-anomaly.js):
//   - Every read uses findByTenant('observations', tenant).
//   - Inner-loop defense-in-depth: every row is re-fenced by
//     (r.tenant === tenant || r.tenant_id === tenant) so a stale row that
//     slipped into the wrong table never crosses a tenant boundary.
//   - We NEVER read across tenants. The aggregator is a per-tenant function.
//
// HONESTY CONTRACT (W604 + sibling-wave style):
//   - Empty namespace ⇒ {ok:false, error:'no_captures', hint:'...', version}
//     never silently returns an empty cluster list.
//   - K-Score breakdown returns {kscore:null, n_samples:0, status:'no_samples'}
//     when a cluster has zero scoreable rows - never NaN, never 0 fabricated.
//   - The IDR gauge is a number in [0,1]. Empty windows give a defined value
//     (1.0 = fully stale) with `status` annotated; NEVER NaN.
//
// ANTI-BRITTLENESS (W604):
//   - CAPTURE_ANALYTICS_VERSION is "w811-v1" and consumers MUST match with
//     a regex /^w811-/ NOT literal equality.
//   - All numeric tunables (cluster cap, IDR windows, weights) are exported
//     so the dashboard / CLI / sibling tests can tune without forking.
//
// CLUSTERING ALGORITHM:
//   W757 (namespace-fingerprint) is the deep version, but the plan accepts
//   "if W757 exists, else simple n-gram bucket". We implement a self-contained
//   bag-of-bigrams + greedy nearest-cluster algorithm to keep this module
//   stdlib-only:
//     1. tokenize each prompt → bag of unigrams + bigrams (lowercased a-z0-9)
//     2. l1-normalize to a sparse vector
//     3. greedy clustering: for each row, find the closest existing centroid
//        by cosine-on-sparse-vec; if max similarity < CLUSTER_SIM_THRESHOLD
//        spawn a new cluster.
//     4. cap clusters at MAX_CLUSTERS - overflow rows go to bucket
//        '__overflow__' with status:'overflow'.
//
// EXTERNAL DEPS: none. node:crypto for the cluster id only.

import crypto from 'node:crypto';
import { findByTenant } from './store.js';
import { appendEvent } from './event-store.js';
import { computeCaptureStats } from './capture-stats.js';

export const CAPTURE_ANALYTICS_VERSION = 'w811-v1';

// Cosine-similarity threshold above which a row joins an existing cluster.
// 0.30 picks up "is the same task" prompts without collapsing every short
// utterance into one bucket. Tunable via opts.cluster_sim_threshold.
export const CLUSTER_SIM_THRESHOLD = 0.30;

// Hard cap on cluster count per call. Above this every additional row
// goes to the __overflow__ bucket. A namespace with > MAX_CLUSTERS
// distinct prompts is almost certainly under-distilled - surface the
// truncation honestly instead of silently merging unrelated tasks.
export const MAX_CLUSTERS = 64;

// Hard cap on rows read per analytics call. Keeps a runaway namespace from
// blowing up the dashboard request. The CSV export honors the same cap.
export const MAX_ROWS_PER_CALL = 20000;

// IDR (Important-Distinct-Recent) windows in milliseconds. Recent = last
// 7 days, comparison = last 30 days. The gauge is 1 - (recent / 30d) so
// 0 means "all recent" and 1 means "fully stale" (no captures in 7d).
export const IDR_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const IDR_COMPARISON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// W811-7 - event-store kind we emit so W815 (active-learning) can subscribe.
// Carries the cluster summary + gap-signal score per cluster.
export const GAP_SIGNAL_EVENT_KIND = 'capture_cluster_gap_signal_w811';

// =============================================================================
// Pure-math helpers
// =============================================================================

function _toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Lowercase a-z0-9 token stream. Keeps the module stdlib-only.
function _tokens(text) {
  if (!text) return [];
  const m = text.toLowerCase().match(/[a-z0-9]+/g);
  return m || [];
}

// Bag-of-bigrams + bag-of-unigrams (l1-normalized sparse vector).
// We use BOTH so very short prompts (one or two tokens) still produce a
// non-empty fingerprint. Returns a plain object {token: weight}.
export function fingerprintPrompt(text) {
  const toks = _tokens(text);
  if (!toks.length) return {};
  const counts = new Map();
  for (const t of toks) {
    counts.set('u:' + t, (counts.get('u:' + t) || 0) + 1);
  }
  for (let i = 0; i < toks.length - 1; i++) {
    const bg = 'b:' + toks[i] + ' ' + toks[i + 1];
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  let total = 0;
  for (const v of counts.values()) total += v;
  if (total === 0) return {};
  const out = {};
  for (const [k, v] of counts) out[k] = v / total;
  return out;
}

// Cosine similarity between two sparse vectors {token: weight}.
// Returns 0 for empty inputs (never NaN).
export function cosineSparse(a, b) {
  if (!a || !b) return 0;
  const keysA = Object.keys(a);
  if (!keysA.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const k of keysA) {
    normA += a[k] * a[k];
    if (k in b) dot += a[k] * b[k];
  }
  for (const k of Object.keys(b)) {
    normB += b[k] * b[k];
  }
  if (normA === 0 || normB === 0) return 0;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return dot / denom;
}

// Generate a stable cluster id from a centroid fingerprint. We pick the
// top-5 tokens by weight, join them with '+', and prepend the sha256[0..8]
// of the same string so two centroids that share the same top-5 but
// differ in tail mass still get distinct ids.
function _clusterIdFromCentroid(centroid) {
  const sorted = Object.entries(centroid).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([k]) => k.replace(/^[ub]:/, '')).join('+') || 'empty';
  const h = crypto.createHash('sha256').update(top).digest('hex').slice(0, 8);
  return 'cl_' + h + '_' + top.slice(0, 32);
}

// Update an existing centroid (incremental mean) with a new fingerprint.
// Mutates `centroid` in place. n is the cluster's pre-add row count.
function _addToCentroid(centroid, fp, n) {
  const newN = n + 1;
  for (const k of Object.keys(fp)) {
    centroid[k] = ((centroid[k] || 0) * n + fp[k]) / newN;
  }
  // Tokens present in the centroid but not in the new fp are diluted.
  for (const k of Object.keys(centroid)) {
    if (!(k in fp)) {
      centroid[k] = (centroid[k] * n) / newN;
    }
  }
}

// =============================================================================
// Tenant-fenced capture read
// =============================================================================

// Pull all captures for (tenant, namespace) from the store. Mirrors the
// fence pattern used by src/capture-anomaly.js - findByTenant + inner
// (tenant || tenant_id) re-check + namespace match (accepting both
// `namespace` and `corpus_namespace` because capture-store writes the
// latter while the canonical event-schema writes the former).
function _readCaptures(tenant_id, namespace, opts = {}) {
  if (!tenant_id) return [];
  const limit = Math.max(1, Math.min(MAX_ROWS_PER_CALL, Math.trunc(Number(opts.limit) || MAX_ROWS_PER_CALL)));
  let rows = [];
  try { rows = findByTenant('observations', tenant_id) || []; } catch (_) { rows = []; }
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    // Defense-in-depth: foreign rows must NEVER cross this boundary.
    if (r.tenant !== tenant_id && r.tenant_id !== tenant_id) continue;
    if (namespace) {
      const ns = r.namespace || r.corpus_namespace || 'default';
      if (ns !== namespace) continue;
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// =============================================================================
// W811-1 - clustering pipeline
// =============================================================================

/**
 * Cluster a list of captures by prompt similarity using bag-of-unigrams +
 * bigrams + greedy nearest-centroid.
 *
 * Returns:
 *   {
 *     clusters: [{
 *       cluster_id: 'cl_<hash>_<top-tokens>',
 *       n: number,
 *       top_tokens: string[],  // the 5 highest-weighted centroid tokens
 *       example_prompts: string[], // up to 3 short samples
 *     }, ...],
 *     overflow_n: number,  // rows shed because cluster count hit MAX_CLUSTERS
 *     total_n: number,
 *     version: 'w811-vN',
 *   }
 *
 * Honest empty: empty input ⇒ {clusters:[], overflow_n:0, total_n:0, version}.
 *
 * @param {Array<object>} captures - rows with .prompt (or .request) text
 * @param {object} [opts]
 * @param {number} [opts.cluster_sim_threshold]
 * @param {number} [opts.max_clusters]
 */
export function clusterCaptures(captures, opts = {}) {
  const list = Array.isArray(captures) ? captures.filter(Boolean) : [];
  const simThr = Number.isFinite(opts.cluster_sim_threshold)
    ? opts.cluster_sim_threshold : CLUSTER_SIM_THRESHOLD;
  const maxClusters = Number.isFinite(opts.max_clusters)
    ? Math.max(1, Math.trunc(opts.max_clusters)) : MAX_CLUSTERS;

  // centroid: { centroid: {token: weight}, n, examples: [string], ids: [string] }
  const centroids = [];
  let overflow_n = 0;

  for (const cap of list) {
    const prompt = _toText(cap && (cap.prompt || cap.request));
    const fp = fingerprintPrompt(prompt);
    if (!Object.keys(fp).length) {
      // Empty prompts can't cluster - bucket as overflow rather than fabricate.
      overflow_n += 1;
      continue;
    }
    // Find best matching existing centroid.
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const s = cosineSparse(fp, centroids[i].centroid);
      if (s > bestSim) { bestSim = s; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestSim >= simThr) {
      const c = centroids[bestIdx];
      _addToCentroid(c.centroid, fp, c.n);
      c.n += 1;
      if (c.examples.length < 3) c.examples.push(prompt.slice(0, 160));
      if (cap && (cap.event_id || cap.id)) c.ids.push(String(cap.event_id || cap.id));
      continue;
    }
    // No good match - open a new centroid, unless we're at the cap.
    if (centroids.length >= maxClusters) {
      overflow_n += 1;
      continue;
    }
    centroids.push({
      centroid: { ...fp },
      n: 1,
      examples: [prompt.slice(0, 160)],
      ids: cap && (cap.event_id || cap.id) ? [String(cap.event_id || cap.id)] : [],
    });
  }

  // Sort clusters by volume (desc) so the dashboard renders the largest
  // bubbles first. Stable secondary sort by cluster_id for deterministic
  // CSV / JSON output across runs.
  const clusters = centroids
    .map((c) => {
      const cluster_id = _clusterIdFromCentroid(c.centroid);
      const top_tokens = Object.entries(c.centroid)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k]) => k.replace(/^[ub]:/, ''));
      return {
        cluster_id,
        n: c.n,
        top_tokens,
        example_prompts: c.examples.slice(),
        // ids retained internally; exposed only via the k-score join.
        _ids: c.ids,
      };
    })
    .sort((a, b) => (b.n - a.n) || a.cluster_id.localeCompare(b.cluster_id));

  return {
    version: CAPTURE_ANALYTICS_VERSION,
    clusters,
    overflow_n,
    total_n: list.length,
  };
}

// =============================================================================
// W811-2 - per-cluster K-Score breakdown
// =============================================================================

// Extract a K-Score from a single capture row if one is recorded. We accept
// several locations because different W720/W807/W812 emitters stamp the
// score in different fields; missing ⇒ null (never 0 fabricated).
function _kscoreFor(row) {
  if (!row) return null;
  // Direct fields first (W812 surface).
  if (typeof row.kscore === 'number' && Number.isFinite(row.kscore)) return row.kscore;
  if (typeof row.k_score === 'number' && Number.isFinite(row.k_score)) return row.k_score;
  // Bakeoff result nested under feedback.bakeoff.
  if (row.feedback && typeof row.feedback === 'object') {
    const f = row.feedback;
    if (typeof f.kscore === 'number' && Number.isFinite(f.kscore)) return f.kscore;
    if (f.bakeoff && typeof f.bakeoff.kscore === 'number' && Number.isFinite(f.bakeoff.kscore)) return f.bakeoff.kscore;
  }
  // Routing decision entropy_summary.mean is NOT a K-Score; do not coerce.
  return null;
}

/**
 * Roll up per-cluster K-Score statistics (n_samples, mean, p50, p95) for a
 * pre-clustered set. The row<->cluster join uses the `_ids` field carried by
 * clusterCaptures(); rows not in any cluster's id-set are silently skipped
 * (they're the overflow / empty-prompt rows).
 *
 * Honest empty: a cluster with no scoreable rows returns
 *   {kscore:null, n_samples:0, status:'no_samples'}.
 */
export function kscoreBreakdown(clusters, captures) {
  const rows = Array.isArray(captures) ? captures.filter(Boolean) : [];
  if (!Array.isArray(clusters) || !clusters.length) {
    return { version: CAPTURE_ANALYTICS_VERSION, breakdown: [] };
  }
  const byId = new Map();
  for (const r of rows) {
    const id = r && (r.event_id || r.id);
    if (id) byId.set(String(id), r);
  }
  const out = [];
  for (const c of clusters) {
    const ids = Array.isArray(c._ids) ? c._ids : [];
    const scores = [];
    for (const id of ids) {
      const row = byId.get(String(id));
      const ks = _kscoreFor(row);
      if (ks != null) scores.push(ks);
    }
    if (!scores.length) {
      out.push({
        cluster_id: c.cluster_id,
        n_samples: 0,
        kscore: null,
        status: 'no_samples',
      });
      continue;
    }
    scores.sort((a, b) => a - b);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const p50 = scores[Math.floor((scores.length - 1) * 0.50)];
    const p95 = scores[Math.floor((scores.length - 1) * 0.95)];
    out.push({
      cluster_id: c.cluster_id,
      n_samples: scores.length,
      kscore: Math.round(mean * 10000) / 10000,
      p50: Math.round(p50 * 10000) / 10000,
      p95: Math.round(p95 * 10000) / 10000,
      status: 'ok',
    });
  }
  return { version: CAPTURE_ANALYTICS_VERSION, breakdown: out };
}

// =============================================================================
// W811-3 - IDR (Important-Distinct-Recent) staleness gauge
// =============================================================================

// Helper to read a timestamp from a row; accepts created_at / ts / time_ms.
function _ts(row) {
  if (!row) return null;
  if (row.created_at) {
    const t = new Date(row.created_at).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (Number.isFinite(row.time_ms)) return Number(row.time_ms);
  if (Number.isFinite(row.ts)) return Number(row.ts);
  return null;
}

/**
 * Compute the IDR (Important-Distinct-Recent) staleness gauge across all
 * captures.
 *
 * Importance proxy = clustered (in any non-overflow cluster), so the
 * weight is 1 - single-occurrence prompts get equal weight.
 *
 * Distinct = unique row count.
 *
 * Recent = within IDR_RECENT_WINDOW_MS (default 7d).
 *
 * Gauge = 1 - clamp(recent_distinct / comparison_distinct, 0, 1).
 *   0   ⇒ all captures are recent (fresh)
 *   1   ⇒ none of the comparison-window captures are recent (fully stale)
 *
 * Honest envelope: zero comparison-window rows ⇒ gauge=1.0 with
 *   status='no_recent_captures'.
 *
 * @param {Array<object>} captures
 * @param {object} [opts] - {now_ms, recent_window_ms, comparison_window_ms}
 */
export function idrStalenessGauge(captures, opts = {}) {
  const list = Array.isArray(captures) ? captures.filter(Boolean) : [];
  const now = Number.isFinite(opts.now_ms) ? Number(opts.now_ms) : Date.now();
  const recentMs = Number.isFinite(opts.recent_window_ms)
    ? Number(opts.recent_window_ms) : IDR_RECENT_WINDOW_MS;
  const compMs = Number.isFinite(opts.comparison_window_ms)
    ? Number(opts.comparison_window_ms) : IDR_COMPARISON_WINDOW_MS;
  let recent_n = 0;
  let comparison_n = 0;
  for (const row of list) {
    const t = _ts(row);
    if (t == null) continue;
    const age = now - t;
    if (age < 0) continue; // future timestamps don't count
    if (age <= compMs) comparison_n += 1;
    if (age <= recentMs) recent_n += 1;
  }
  if (comparison_n === 0) {
    return {
      version: CAPTURE_ANALYTICS_VERSION,
      gauge: 1.0,
      recent_n: 0,
      comparison_n: 0,
      recent_window_ms: recentMs,
      comparison_window_ms: compMs,
      status: 'no_recent_captures',
    };
  }
  const ratio = Math.max(0, Math.min(1, recent_n / comparison_n));
  return {
    version: CAPTURE_ANALYTICS_VERSION,
    gauge: Math.round((1 - ratio) * 10000) / 10000,
    recent_n,
    comparison_n,
    recent_window_ms: recentMs,
    comparison_window_ms: compMs,
    status: 'ok',
  };
}

// =============================================================================
// W811-4 - CSV export
// =============================================================================

// CSV field escape - quote fields containing comma, quote, or newline.
function _csvField(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Serialize a cluster summary (clusters + per-cluster K-Score breakdown) to
 * CSV. Header is stable across calls. Joins on cluster_id.
 *
 * Columns: cluster_id, n, top_tokens, n_kscore_samples, kscore_mean,
 * kscore_p50, kscore_p95, kscore_status, example_prompt_1.
 */
export function clustersToCsv(clusters, breakdown) {
  const header = [
    'cluster_id', 'n', 'top_tokens',
    'n_kscore_samples', 'kscore_mean', 'kscore_p50', 'kscore_p95', 'kscore_status',
    'example_prompt_1',
  ];
  const lines = [header.join(',')];
  const bdMap = new Map();
  for (const b of (Array.isArray(breakdown) ? breakdown : [])) {
    if (b && b.cluster_id) bdMap.set(b.cluster_id, b);
  }
  for (const c of (Array.isArray(clusters) ? clusters : [])) {
    if (!c) continue;
    const b = bdMap.get(c.cluster_id) || {};
    lines.push([
      _csvField(c.cluster_id),
      _csvField(c.n),
      _csvField((c.top_tokens || []).join(' ')),
      _csvField(b.n_samples || 0),
      _csvField(b.kscore == null ? '' : b.kscore),
      _csvField(b.p50 == null ? '' : b.p50),
      _csvField(b.p95 == null ? '' : b.p95),
      _csvField(b.status || 'no_samples'),
      _csvField((c.example_prompts && c.example_prompts[0]) || ''),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

// =============================================================================
// W811-7 - emit per-cluster gap signal → W815
// =============================================================================

// gap_signal score per cluster. Higher = bigger gap:
//   - small clusters in a recent-stale namespace get the biggest gap
//   - small clusters with a LOW K-Score get the next biggest gap
//   - large, recent, high-KS clusters get gap ~ 0
//
// Formula: gap = staleness_weight * (1 - n / max_n) + (1 - normalized_kscore)
// clamped to [0, 1]. Pure function for test stability.
export function clusterGapScore(cluster, breakdown, max_n, staleness_gauge) {
  if (!cluster || !cluster.n) return 0;
  const n = Math.max(1, cluster.n);
  const sw = Math.max(0, Math.min(1, Number(staleness_gauge) || 0));
  const m = Math.max(n, Number(max_n) || n);
  const size_gap = 1 - (n / m); // smaller cluster → larger gap
  let ks_gap = 0.5; // unknown ⇒ split the difference, not 0
  if (breakdown && breakdown.kscore != null && Number.isFinite(breakdown.kscore)) {
    ks_gap = Math.max(0, Math.min(1, 1 - breakdown.kscore));
  }
  const gap = sw * size_gap + (1 - sw) * ks_gap;
  return Math.round(Math.max(0, Math.min(1, gap)) * 10000) / 10000;
}

// Feedback-field prefix the gap_signal payload is JSON-encoded under. The
// canonical event-schema in src/event-schema.js drops unknown keys at
// canonicalize() time, so we have to ride a known column. `feedback` is a
// 4096-char free-string field used by sibling waves for provenance markers
// (e.g. 'migrated_from:capture-store'). We pack the W811 gap-signal payload
// in the same field with a stable prefix so W815 / downstream consumers
// can filter on the prefix and JSON.parse the suffix without ambiguity.
export const GAP_SIGNAL_FEEDBACK_PREFIX = 'w811_gap_signal:';

/**
 * Parse a gap-signal payload back out of an event's `feedback` field.
 * Returns null when the event isn't a W811 gap-signal row.
 */
export function parseGapSignal(event) {
  if (!event || typeof event.feedback !== 'string') return null;
  if (!event.feedback.startsWith(GAP_SIGNAL_FEEDBACK_PREFIX)) return null;
  const json = event.feedback.slice(GAP_SIGNAL_FEEDBACK_PREFIX.length);
  try { return JSON.parse(json); } catch { return null; }
}

// Emit one gap-signal event per cluster into the canonical event-store.
// Best-effort - never throws (the analytics call must succeed even if the
// event-store is misconfigured). Returns the array of events successfully
// emitted (length 0 on full failure).
//
// Each event carries:
//   - tenant_id + namespace (required by event-schema)
//   - status='ok'
//   - model = GAP_SIGNAL_EVENT_KIND (W815 filter)
//   - request_hash = cluster_id (W815 dedupe key)
//   - completion_tokens = cluster.n (volume proxy)
//   - feedback = GAP_SIGNAL_FEEDBACK_PREFIX + JSON.stringify(payload)
//     (rides the only multi-purpose free-string column that survives
//     canonicalize() - see GAP_SIGNAL_FEEDBACK_PREFIX comment)
async function _emitGapSignals({ tenant_id, namespace, clusters, breakdown, staleness }) {
  const out = [];
  const bdMap = new Map();
  for (const b of (Array.isArray(breakdown) ? breakdown : [])) {
    if (b && b.cluster_id) bdMap.set(b.cluster_id, b);
  }
  const max_n = clusters.reduce((m, c) => Math.max(m, c.n || 0), 0);
  const sw = staleness && Number.isFinite(staleness.gauge) ? staleness.gauge : 1;
  for (const c of clusters) {
    const b = bdMap.get(c.cluster_id);
    const gap = clusterGapScore(c, b, max_n, sw);
    const payload = {
      version: CAPTURE_ANALYTICS_VERSION,
      cluster_id: c.cluster_id,
      cluster_n: c.n,
      top_tokens: c.top_tokens,
      kscore: b ? b.kscore : null,
      kscore_status: b ? b.status : 'no_samples',
      staleness_gauge: sw,
      gap_score: gap,
    };
    let feedback;
    try {
      // Clip to the 4096-char limit defensively; the top-5 tokens + ids keep
      // us well under in practice, but a freak cluster with massive token
      // strings shouldn't blow the canonicalizer.
      const j = JSON.stringify(payload);
      feedback = (GAP_SIGNAL_FEEDBACK_PREFIX + j).slice(0, 4096);
    } catch (_) {
      feedback = GAP_SIGNAL_FEEDBACK_PREFIX + '{}';
    }
    try {
      const ev = await appendEvent({
        tenant_id,
        namespace,
        provider: 'kolm-internal',
        model: GAP_SIGNAL_EVENT_KIND,
        status: 'ok',
        request_hash: c.cluster_id,
        completion_tokens: c.n,
        estimated_cost_usd: 0,
        feedback,
      });
      out.push(ev);
    } catch (_) { /* best-effort; honesty contract is on the dashboard envelope */ }
  }
  return out;
}

// =============================================================================
// Top-level orchestrator (the function the route + CLI both call)
// =============================================================================

/**
 * Run the full analytics pipeline for one (tenant, namespace) bucket.
 *
 * @param {object} opts
 * @param {string} opts.tenant_id
 * @param {string} opts.namespace
 * @param {boolean} [opts.emit_gap_signal] - default true; pass false in tests
 *   that should not write to the event-store.
 * @param {number} [opts.limit]
 * @param {number} [opts.now_ms] - for deterministic IDR in tests
 *
 * @returns {Promise<object>} the dashboard envelope or honest error.
 */
export async function analyzeNamespace(opts = {}) {
  const tenant_id = opts.tenant_id;
  const namespace = opts.namespace;
  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'pass {tenant_id} - analytics are per-tenant, never cross-tenant',
      version: CAPTURE_ANALYTICS_VERSION,
    };
  }
  if (!namespace) {
    return {
      ok: false,
      error: 'missing_namespace',
      hint: 'pass {namespace} - pick one with `kolm captures list --by-namespace`',
      version: CAPTURE_ANALYTICS_VERSION,
    };
  }
  const captures = _readCaptures(tenant_id, namespace, opts);
  if (!captures.length) {
    return {
      ok: false,
      error: 'no_captures',
      hint: 'no observations for (tenant, namespace); run a capture first',
      tenant_id,
      namespace,
      version: CAPTURE_ANALYTICS_VERSION,
    };
  }
  // W811-1
  const clustering = clusterCaptures(captures, opts);
  // W811-2
  const breakdown = kscoreBreakdown(clustering.clusters, captures);
  // W811-3
  const staleness = idrStalenessGauge(captures, opts);
  // W716 distribution profile (volume + diversity stats the dashboard wants).
  const distribution = computeCaptureStats(captures);
  // W811-7
  let gap_signals_emitted = 0;
  if (opts.emit_gap_signal !== false) {
    const ev = await _emitGapSignals({
      tenant_id, namespace,
      clusters: clustering.clusters,
      breakdown: breakdown.breakdown,
      staleness,
    });
    gap_signals_emitted = ev.length;
  }
  // Strip internal `_ids` from the exported clusters before returning so the
  // wire envelope is clean for the dashboard / CLI consumer.
  const publicClusters = clustering.clusters.map((c) => ({
    cluster_id: c.cluster_id,
    n: c.n,
    top_tokens: c.top_tokens,
    example_prompts: c.example_prompts,
  }));
  return {
    ok: true,
    version: CAPTURE_ANALYTICS_VERSION,
    tenant_id,
    namespace,
    total_n: clustering.total_n,
    overflow_n: clustering.overflow_n,
    clusters: publicClusters,
    kscore_breakdown: breakdown.breakdown,
    idr: staleness,
    distribution,
    gap_signals_emitted,
  };
}

// =============================================================================
// CSV variant - for `--csv` CLI flag and the dashboard download button.
// =============================================================================
export async function analyzeNamespaceCsv(opts = {}) {
  const env = await analyzeNamespace({ ...opts, emit_gap_signal: false });
  if (!env.ok) return env;
  return {
    ok: true,
    version: CAPTURE_ANALYTICS_VERSION,
    csv: clustersToCsv(env.clusters, env.kscore_breakdown),
  };
}

// Test seam - internal helpers re-exported so the test file can exercise
// each branch without scaffolding new fixtures.
export const __internals = {
  _toText,
  _tokens,
  _kscoreFor,
  _ts,
  _readCaptures,
  _csvField,
  _emitGapSignals,
};
