// W815 - Active Learning Loop (high-information-density scorer + coverage-gap
// detector + recommend-next-capture surface + W720 feedback wiring).
//
// This is one of the four "T1" waves that unblock W775 (the killer
// continuous-distillation feature). The W775 daemon imports
// getCoverageGapsForNamespace() from this module to decide WHEN to surface
// a re-distill prompt - so the exported signature here is LOAD-BEARING.
//
// What it does:
//
//   1. scoreCaptureRichness(capture, ctx) - high-information-density score
//      in [0..1]. Blends:
//        - W711 capture-importance (the existing token-density + entropy +
//          MinHash novelty trio) → 0.35 weight
//        - W807 weakness_signal flag pulled from the routing decision blob →
//          0.20 weight when present, else neutral 0.5
//        - novelty-against-corpus via per-cluster n-gram TF-IDF →
//          0.30 weight (a brand-new cluster scores 1.0, a duplicate scores 0)
//        - recency half-life: 7-day exponential decay, anchored to NOW →
//          0.15 weight (so a stale capture is never higher-scored than a
//          fresh one with the same other signals)
//
//   2. detectCoverageGaps(captures, opts) - bucket captures by a topic key
//      (W811 cluster_id when present, else a 3-gram hash bucket), compare
//      each bucket's count to the corpus median, and rank under-represented
//      buckets by `gap_score = (median - count) / median × demand_proxy` where
//      demand_proxy = (production routing volume in that bucket / total
//      routing volume) so high-traffic gaps surface first.
//
//   3. recommendNextCaptures(tenant_id, namespace, opts) - top-K gap buckets
//      returned as actionable items {topic_cluster, gap_score,
//      recommended_count, sample_synthetic_input?, capture_template?}.
//
//   4. feedToSelfImprovement(tenant_id, namespace, gaps) - for each gap,
//      writes ONE event-store row with feedback JSON marking
//      {capture_candidate:true, weakness_signal:false, active_learning_gap:true}
//      so the W720 detectUnderperformingCaptures sweep treats the gap as a
//      seed for the next orchestrateImprovement call.
//
//   5. getCoverageGapsForNamespace(ns, opts) - W775-unblock contract. The
//      W775 background daemon polls this every minute to decide when to
//      surface a re-distill suggestion.
//
// Honesty contracts:
//
//   - getCoverageGapsForNamespace(ns) when fewer than MIN_CAPTURES_FOR_GAPS
//     captures exist for the namespace returns
//     {ok:false, error:'insufficient_captures_for_coverage', n, hint:...,
//      version:'w815-v1'}.
//     NEVER returns a fabricated gap list under-sampled data - the daemon
//     would re-trigger forever.
//   - feedToSelfImprovement is best-effort: event-store write failure does
//     NOT throw into the caller; we return the per-gap envelope with
//     {ok:false, error:...} entries so the CLI / dashboard can surface them.
//   - All read paths are tenant-fenced via findByTenant + defense-in-depth
//     namespace re-check inside the loop.
//
// W775-unblock contract (binding signature):
//
//   getCoverageGapsForNamespace(namespace: string, opts?: {
//     tenant_id?: string,
//     min_captures?: number,
//     top_k?: number,
//   }) => Promise<{
//     ok: boolean,
//     gaps?: Array<{cluster_id: string, gap_score: number, recommended_count: number}>,
//     computed_at: string,         // ISO timestamp
//     n?: number,
//     error?: string,
//     hint?: string,
//     version: 'w815-v1',
//   }>
//
// Pure-JS, no top-level deps added.

import crypto from 'node:crypto';

import { findByTenant } from './store.js';
import {
  scoreCapture as scoreCaptureImportance,
  createScorerWindow,
} from './capture-importance.js';

export const ACTIVE_LEARNING_VERSION = 'w815-v1';

// Coverage-gap detection refuses to run on under-sampled data. 30 is the
// smallest sample where a 5-bucket histogram has meaningful spread under a
// uniform null hypothesis (each bucket would have ~6 captures, enough that
// a count of 1 reads as a real gap rather than sampling noise).
export const MIN_CAPTURES_FOR_GAPS = 30;

// Cluster-hash bucket count when W811 cluster_id is missing. 32 buckets give
// us enough resolution to surface real gaps without exploding the table at
// the dashboard layer (32 rows fit in one viewport).
const FALLBACK_BUCKET_COUNT = 32;

// Recency half-life for the freshness component of the richness score.
// 7 days × milliseconds = 604_800_000ms. After one half-life the freshness
// contribution drops to 0.5; after two it drops to 0.25; etc.
const RECENCY_HALFLIFE_MS = 7 * 24 * 60 * 60 * 1000;

const WEIGHT_IMPORTANCE = 0.35;
const WEIGHT_WEAKNESS = 0.20;
const WEIGHT_NOVELTY = 0.30;
const WEIGHT_RECENCY = 0.15;

// Default recommended_count per gap bucket. The dashboard / CLI overrides
// per call; the default is sized so a single distill cycle filling all top-K
// gaps stays within a typical per-tenant per-day capture cap (≈100 rows).
const DEFAULT_RECOMMENDED_PER_GAP = 5;

const DEFAULT_TOP_K_GAPS = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _now() {
  return Date.now();
}

function _isoNow() {
  return new Date().toISOString();
}

function _safeText(s) {
  if (typeof s !== 'string') return '';
  return s;
}

function _extractPromptText(capture) {
  if (!capture || typeof capture !== 'object') return '';
  if (typeof capture.prompt === 'string') return capture.prompt;
  if (capture.request && typeof capture.request === 'object') {
    if (typeof capture.request.prompt === 'string') return capture.request.prompt;
    if (Array.isArray(capture.request.messages)) {
      return capture.request.messages
        .map(m => (m && typeof m.content === 'string') ? m.content : '')
        .filter(Boolean).join('\n');
    }
    if (typeof capture.request.input === 'string') return capture.request.input;
  }
  if (typeof capture.input === 'string') return capture.input;
  if (typeof capture.prompt_redacted === 'string') return capture.prompt_redacted;
  return '';
}

function _extractTimestamp(capture) {
  if (!capture || typeof capture !== 'object') return null;
  // Try canonical event-schema first, then capture-row hybrids.
  if (capture.created_at) {
    const ms = new Date(capture.created_at).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (Number.isFinite(Number(capture.enqueued_at_ms))) {
    return Number(capture.enqueued_at_ms);
  }
  if (Number.isFinite(Number(capture.ts))) return Number(capture.ts);
  if (capture.timestamp) {
    const ms = new Date(capture.timestamp).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// W811 ships cluster_id on capture analytics rows. When absent we hash the
// prompt to one of FALLBACK_BUCKET_COUNT buckets so every capture lands in a
// deterministic bucket - duplicates collide, novel-by-text spreads.
//
// We use a 3-gram word-shingle prefix so prompts that share an opening phrase
// (which is usually the most diagnostic part of intent) cluster together
// even when the rest differs.
// Public named export (CD-004): data-curate.js imports this directly instead of
// reaching through the __internals hack, so a refactor of __internals can no
// longer silently degrade curate's cluster stage to the 3-gram fallback. The
// __internals._bucketKey alias below is preserved for back-compat.
export function _bucketKey(capture) {
  // Prefer explicit W811 cluster_id if present (forward-compat).
  if (capture && typeof capture === 'object') {
    if (typeof capture.cluster_id === 'string' && capture.cluster_id.length > 0) {
      return String(capture.cluster_id);
    }
    if (capture.cluster && typeof capture.cluster.id === 'string') {
      return String(capture.cluster.id);
    }
  }
  const prompt = _extractPromptText(capture).toLowerCase().trim();
  if (!prompt) return 'cluster_empty';
  const toks = prompt.split(/\s+/).filter(Boolean);
  // 3-gram prefix when possible, else the whole tokenized prompt joined.
  const prefix = toks.slice(0, 3).join(' ') || toks.join(' ');
  const h = crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 8);
  const idx = parseInt(h, 16) % FALLBACK_BUCKET_COUNT;
  return 'cluster_fb_' + idx;
}

// Pull the W807 weakness_signal flag out of a capture row. The event-store
// canonical shape parks the flag inside `feedback` (JSON-encoded). Both the
// capture-store row shape and the canonical event shape are accepted.
function _readWeaknessSignal(capture) {
  if (!capture || typeof capture !== 'object') return null;
  // Direct boolean on the row (some hybrid call sites).
  if (capture.weakness_signal === true) return true;
  if (capture.weakness_signal === false) return false;
  // W807 stamps the flag inside the feedback JSON blob.
  if (typeof capture.feedback === 'string' && capture.feedback.length > 0) {
    try {
      const fb = JSON.parse(capture.feedback);
      if (fb && typeof fb === 'object') {
        if (fb.weakness_signal === true) return true;
        if (fb.weakness_signal === false) return false;
      }
    } catch (_) { /* feedback was free text, not JSON - ignore */ }
  }
  // Some callers attach the routing decision directly.
  if (capture.routing_decision && typeof capture.routing_decision === 'object') {
    if (capture.routing_decision.weakness_signal === true) return true;
    if (capture.routing_decision.weakness_signal === false) return false;
  }
  return null;
}

// Recency component: exponential decay with RECENCY_HALFLIFE_MS half-life.
// Returns [0..1]; 1.0 = NOW, 0.5 = 7 days ago, 0.25 = 14 days ago, etc.
// Missing timestamp returns 0.5 (neutral - never throw, never under-score).
function _recencyScore(timestampMs, nowMs) {
  if (!Number.isFinite(timestampMs)) return 0.5;
  const dt = Math.max(0, (nowMs || _now()) - timestampMs);
  // Exponential decay: 2^(-dt/halflife).
  const halflives = dt / RECENCY_HALFLIFE_MS;
  return Math.pow(2, -halflives);
}

// TF-IDF novelty score against a per-cluster reference n-gram set. Higher
// means more novel relative to the cluster's prior captures. Uses 3-gram
// word shingles so it surfaces stylistic deviation; uses Jaccard over the
// shingle set (1 - Jaccard = novelty) so the math stays pure JS.
function _ngramSet(text, k) {
  const toks = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return new Set();
  if (toks.length < k) return new Set([toks.join(' ')]);
  const out = new Set();
  for (let i = 0; i <= toks.length - k; i++) {
    out.add(toks.slice(i, i + k).join(' '));
  }
  return out;
}

function _jaccard(a, b) {
  if (!a || a.size === 0) return b && b.size > 0 ? 0 : 1;
  if (!b || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  if (union === 0) return 1;
  return inter / union;
}

// ---------------------------------------------------------------------------
// W815-1 - high-information-density scorer
// ---------------------------------------------------------------------------

/**
 * Score a capture for training value with a four-signal blend:
 *
 *   importance × 0.35   (W711 token-density / entropy / MinHash novelty)
 *   weakness   × 0.20   (W807 weakness_signal - 1.0 when true, 0.5 when null,
 *                         0.0 when false)
 *   novelty    × 0.30   (per-cluster 3-gram Jaccard distance against the
 *                         reference set passed in opts.cluster_reference)
 *   recency    × 0.15   (exponential half-life of 7 days from now())
 *
 * Returns a {score, components, version} envelope. NEVER throws.
 *
 * @param {object} capture
 * @param {object} [opts]
 * @param {Set<string>} [opts.cluster_reference]   per-cluster n-gram set the
 *   caller maintains across the corpus (so novelty is bucket-relative, not
 *   global). When omitted, novelty defaults to 1.0 (max - safe over-estimate).
 * @param {object}  [opts.importance_window]       optional W711 scorer
 *   window threaded through to keep stateful novelty consistent with the
 *   rolling-window contract.
 * @param {number}  [opts.now_ms]                  override clock for tests.
 * @returns {{score:number, components:object, version:string}}
 */
export function scoreCaptureRichness(capture, opts = {}) {
  const importanceOpts = opts && opts.importance_window
    ? { window: opts.importance_window }
    : undefined;
  let importanceEnv = { score: 0.5, components: {} };
  try {
    importanceEnv = scoreCaptureImportance(capture, importanceOpts);
  } catch (_) {
    // capture-importance NEVER throws on its own, but defend in case.
    importanceEnv = { score: 0.5, components: {} };
  }
  const importance = Math.max(0, Math.min(1, Number(importanceEnv.score) || 0));

  // weakness: explicit true → 1.0, explicit false → 0.0, missing → 0.5.
  const wflag = _readWeaknessSignal(capture);
  const weakness = wflag === true ? 1.0 : (wflag === false ? 0.0 : 0.5);

  // novelty: Jaccard distance against the per-cluster reference shingle set.
  let novelty = 1.0;
  if (opts && opts.cluster_reference instanceof Set) {
    const promptShingles = _ngramSet(_extractPromptText(capture), 3);
    const sim = _jaccard(promptShingles, opts.cluster_reference);
    novelty = Math.max(0, Math.min(1, 1 - sim));
  }

  // recency: exponential half-life of 7 days.
  const ts = _extractTimestamp(capture);
  const recency = _recencyScore(ts, opts && opts.now_ms ? Number(opts.now_ms) : null);

  const score =
      WEIGHT_IMPORTANCE * importance
    + WEIGHT_WEAKNESS * weakness
    + WEIGHT_NOVELTY * novelty
    + WEIGHT_RECENCY * recency;

  return {
    score: Math.max(0, Math.min(1, score)),
    components: {
      importance,
      weakness,
      novelty,
      recency,
      importance_internals: importanceEnv.components || null,
    },
    version: ACTIVE_LEARNING_VERSION,
  };
}

// ---------------------------------------------------------------------------
// W815-2 - coverage-gap detector
// ---------------------------------------------------------------------------

/**
 * Detect coverage gaps across the supplied captures + optional production
 * demand histogram.
 *
 * Algorithm:
 *
 *   1. Bucket every capture by `_bucketKey` (W811 cluster_id if present,
 *      else a deterministic 3-gram-prefix hash bucket).
 *   2. Compute the corpus median bucket size; any bucket with count below
 *      `gap_threshold × median` is a candidate gap.
 *   3. Score each gap as `(median - count) / median` × demand_proxy where
 *      demand_proxy = (production_volume_for_bucket / total_production_volume)
 *      or 1.0 when no production histogram is supplied.
 *   4. Return the top-K gaps sorted by gap_score descending.
 *
 * Honest envelope: insufficient captures returns
 * {ok:false, error:'insufficient_captures_for_coverage', n, hint:..., version}.
 *
 * @param {Array<object>} captures
 * @param {object} [opts]
 * @param {number} [opts.gap_threshold=0.5]  buckets below threshold×median count.
 * @param {number} [opts.top_k=10]
 * @param {number} [opts.min_captures=MIN_CAPTURES_FOR_GAPS]  callers like the
 *   W775-unblock wrapper may lower the floor to surface gaps over a smaller
 *   sample; floor is clamped to >=1 (zero-capture buckets are meaningless).
 * @param {Record<string, number>} [opts.production_histogram]  optional
 *   {cluster_id: count} histogram from W813 drift detector / live traffic.
 * @returns {{ok:boolean, gaps?:Array, total_buckets?:number,
 *            median_bucket_size?:number, n?:number, error?:string,
 *            hint?:string, version:string}}
 */
export function detectCoverageGaps(captures, opts = {}) {
  const list = Array.isArray(captures) ? captures.filter(Boolean) : [];
  const n = list.length;
  const minCaptures = Number.isFinite(Number(opts && opts.min_captures))
    ? Math.max(1, Math.trunc(Number(opts.min_captures)))
    : MIN_CAPTURES_FOR_GAPS;
  if (n < minCaptures) {
    return {
      ok: false,
      error: 'insufficient_captures_for_coverage',
      n,
      hint: `need at least ${minCaptures} captures for coverage analysis; have ${n}. Capture more traffic or pass a wider time window.`,
      version: ACTIVE_LEARNING_VERSION,
    };
  }

  const gapThreshold = Number.isFinite(Number(opts.gap_threshold))
    ? Math.max(0.0, Math.min(1.0, Number(opts.gap_threshold)))
    : 0.5;
  const topK = Number.isFinite(Number(opts.top_k))
    ? Math.max(1, Math.min(1000, Math.trunc(Number(opts.top_k))))
    : DEFAULT_TOP_K_GAPS;
  const demandHist = (opts.production_histogram && typeof opts.production_histogram === 'object')
    ? opts.production_histogram
    : null;
  let totalDemand = 0;
  if (demandHist) {
    for (const k of Object.keys(demandHist)) {
      const v = Number(demandHist[k]);
      if (Number.isFinite(v) && v > 0) totalDemand += v;
    }
  }

  // 1. Bucket every capture.
  const counts = new Map();
  for (const c of list) {
    const key = _bucketKey(c);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const totalBuckets = counts.size;

  // 2. Median bucket size - robust to outliers (one mega-bucket doesn't
  //    swamp the threshold).
  const sortedCounts = Array.from(counts.values()).sort((a, b) => a - b);
  let median = 0;
  if (sortedCounts.length > 0) {
    const mid = Math.floor(sortedCounts.length / 2);
    median = sortedCounts.length % 2 === 0
      ? (sortedCounts[mid - 1] + sortedCounts[mid]) / 2
      : sortedCounts[mid];
  }
  // Edge: median can be 0 if exactly one bucket has all captures. Treat that
  // as "no gaps detectable" - every other bucket would be a 100% gap which
  // is uninformative. Returns ok:true with empty gaps + a hint via header.
  if (median <= 0) {
    return {
      ok: true,
      gaps: [],
      total_buckets: totalBuckets,
      median_bucket_size: 0,
      n,
      computed_at: _isoNow(),
      version: ACTIVE_LEARNING_VERSION,
    };
  }

  // 3. Rank candidate gaps. Iterate over BOTH capture buckets (under-rep'd
  //    ones) AND production-histogram buckets (zero-capture buckets that
  //    have real traffic). A pure capture-bucket scan would miss the most
  //    important gap class: production demand we have NEVER captured for.
  const candidateKeys = new Set(counts.keys());
  if (demandHist) {
    for (const k of Object.keys(demandHist)) candidateKeys.add(k);
  }
  const cutoff = median * gapThreshold;
  const gaps = [];
  for (const key of candidateKeys) {
    const count = counts.get(key) || 0;
    if (count >= cutoff) continue; // not a gap
    const shortfall = (median - count) / median;
    let demandProxy = 1.0;
    if (demandHist && totalDemand > 0) {
      const prodVol = Number(demandHist[key]) || 0;
      demandProxy = prodVol / totalDemand;
    }
    // recommended_count: try to bring the bucket up to median. Floor 1, cap
    // by the per-gap default so a single bucket doesn't dominate the next
    // distill batch.
    const recommended = Math.max(1, Math.min(
      DEFAULT_RECOMMENDED_PER_GAP,
      Math.ceil(median - count),
    ));
    gaps.push({
      cluster_id: key,
      gap_score: shortfall * demandProxy,
      shortfall,
      demand_proxy: demandProxy,
      current_count: count,
      recommended_count: recommended,
    });
  }
  gaps.sort((a, b) => b.gap_score - a.gap_score);

  return {
    ok: true,
    gaps: gaps.slice(0, topK),
    total_buckets: totalBuckets,
    median_bucket_size: median,
    n,
    computed_at: _isoNow(),
    version: ACTIVE_LEARNING_VERSION,
  };
}

// ---------------------------------------------------------------------------
// W815-3 - recommend-next-capture surface
// ---------------------------------------------------------------------------

/**
 * Top-K recommended next captures for a (tenant, namespace) pair. Reads the
 * existing capture store (multiple tables tried), pulls the production
 * routing-volume histogram from observations when present, then runs the
 * coverage-gap detector.
 *
 * Returns the list shaped for direct rendering in the dashboard / CLI:
 *   {topic_cluster, gap_score, recommended_count, sample_synthetic_input?,
 *    capture_template?}
 *
 * sample_synthetic_input is a single canonical example prompt from the bucket
 * (deterministic: the first capture in the bucket by enqueued order). This
 * is NEVER synthetic generation - we are showing one of the captures that
 * already landed in the bucket as a prompt template. Synthetic generation is
 * a future surface (out of W815 scope per the W815-3 spec note "Optional").
 *
 * @param {string} tenantId
 * @param {string} [namespace='default']
 * @param {object} [opts]
 * @param {number} [opts.top_k=10]
 * @returns {Promise<{ok:boolean, recommendations?:Array, n?:number,
 *                    error?:string, hint?:string, version:string,
 *                    computed_at?:string}>}
 */
export async function recommendNextCaptures(tenantId, namespace = 'default', opts = {}) {
  if (!tenantId) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'tenant_id is required so reads are tenant-fenced',
      version: ACTIVE_LEARNING_VERSION,
    };
  }
  const ns = String(namespace || 'default').slice(0, 128);

  const captures = await _loadCapturesForCoverage(tenantId, ns);
  const det = detectCoverageGaps(captures, opts);
  if (!det.ok) {
    return { ...det, namespace: ns };
  }

  // Build a sample prompt per bucket so the dashboard has something concrete
  // to show. Deterministic: first capture (by enqueue order) in the bucket.
  const bucketSample = new Map();
  for (const c of captures) {
    const key = _bucketKey(c);
    if (!bucketSample.has(key)) {
      const text = _extractPromptText(c);
      if (text) bucketSample.set(key, text.slice(0, 240));
    }
  }

  const recommendations = det.gaps.map((g) => {
    const sample = bucketSample.get(g.cluster_id) || null;
    const template = sample
      ? `Capture more examples like: "${sample.slice(0, 120)}${sample.length > 120 ? '…' : ''}"`
      : 'Capture any traffic in this cluster (no prior examples on file)';
    return {
      topic_cluster: g.cluster_id,
      gap_score: g.gap_score,
      recommended_count: g.recommended_count,
      current_count: g.current_count,
      sample_synthetic_input: sample,
      capture_template: template,
    };
  });

  return {
    ok: true,
    recommendations,
    n: det.n,
    total_buckets: det.total_buckets,
    median_bucket_size: det.median_bucket_size,
    computed_at: det.computed_at,
    namespace: ns,
    version: ACTIVE_LEARNING_VERSION,
  };
}

// Read every capture-like row for a (tenant, namespace) pair. We probe the
// existing tables in priority order. Foreign-tenant rows are dropped via
// findByTenant AND a per-row defense-in-depth re-check.
async function _loadCapturesForCoverage(tenantId, namespace) {
  const candidates = [];
  // 1. The W710 active-learning queue - every routing-decision-derived row.
  try {
    const rows = findByTenant('active_learning_queue', tenantId) || [];
    for (const r of rows) {
      if (!r) continue;
      if (r.tenant !== tenantId && r.tenant_id !== tenantId) continue;
      if (r.namespace !== namespace) continue;
      candidates.push(_normalizeForCoverage(r));
    }
  } catch (_) { /* table may not exist on a brand-new store */ }
  // 2. observations table (captures land here on most ingest paths).
  try {
    const rows = findByTenant('observations', tenantId) || [];
    for (const r of rows) {
      if (!r) continue;
      if (r.tenant !== tenantId && r.tenant_id !== tenantId) continue;
      if (r.namespace !== namespace) continue;
      candidates.push(_normalizeForCoverage(r));
    }
  } catch (_) {} // deliberate: cleanup
  // 3. canonical event-store events - the authoritative capture lake.
  try {
    const { listEvents } = await import('./event-store.js');
    const events = await listEvents({ tenant_id: tenantId, namespace, limit: 0 });
    for (const ev of events) {
      if (!ev) continue;
      if (ev.tenant_id !== tenantId) continue;
      if (ev.namespace !== namespace) continue;
      candidates.push(_normalizeForCoverage(ev));
    }
  } catch (_) { /* event-store may be unavailable */ }
  return candidates;
}

function _normalizeForCoverage(row) {
  // Pass through unchanged - every helper below knows how to read the
  // capture-store / event-store / queue-row shapes.
  return row;
}

// ---------------------------------------------------------------------------
// W815-4 - feed loop into W720 self-improvement
// ---------------------------------------------------------------------------

/**
 * For each gap, write one event-store row that the W720
 * detectUnderperformingCaptures sweep treats as a candidate. The feedback
 * blob is JSON-encoded so:
 *
 *   {capture_candidate: true, weakness_signal: false, active_learning_gap: true,
 *    cluster_id, gap_score, recommended_count, version}
 *
 * weakness_signal:false is deliberate: an active-learning gap is NOT a
 * student failure (the student may not have been called at all in that
 * cluster yet). active_learning_gap:true is the new flag the W720 detector
 * inspects to elevate the candidate.
 *
 * Honest envelope: per-gap write failures are surfaced, never silenced.
 * The function returns one row per gap with ok:true|false.
 *
 * @param {string} tenantId
 * @param {string} namespace
 * @param {Array<{cluster_id:string, gap_score:number, recommended_count:number}>} gaps
 * @returns {Promise<{ok:boolean, written:number, attempted:number,
 *                    rows:Array, version:string}>}
 */
export async function feedToSelfImprovement(tenantId, namespace, gaps) {
  if (!tenantId) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'tenant_id is required for feedToSelfImprovement',
      version: ACTIVE_LEARNING_VERSION,
    };
  }
  if (!Array.isArray(gaps) || gaps.length === 0) {
    return {
      ok: true,
      written: 0,
      attempted: 0,
      rows: [],
      version: ACTIVE_LEARNING_VERSION,
    };
  }
  const ns = String(namespace || 'default').slice(0, 128);

  let es = null;
  try { es = await import('./event-store.js'); }
  catch (e) {
    return {
      ok: false,
      error: 'event_store_unavailable',
      hint: 'src/event-store.js failed to load - cannot feed W720',
      detail: e && e.message,
      version: ACTIVE_LEARNING_VERSION,
    };
  }

  const rows = [];
  let written = 0;
  for (const g of gaps) {
    if (!g || typeof g !== 'object' || !g.cluster_id) {
      rows.push({ ok: false, error: 'invalid_gap_row', gap: g });
      continue;
    }
    const fb = JSON.stringify({
      kind: 'active_learning_gap',
      capture_candidate: true,
      weakness_signal: false,
      active_learning_gap: true,
      cluster_id: String(g.cluster_id),
      gap_score: Number(g.gap_score) || 0,
      recommended_count: Number(g.recommended_count) || 0,
      version: ACTIVE_LEARNING_VERSION,
    });
    // request_hash is deterministic by (namespace, cluster_id, day) so re-runs
    // within the same day don't pile up duplicate W720 candidates - the
    // event-store's INSERT-OR-REPLACE de-dupes them. Day-bucketed so a new
    // gap detected tomorrow still creates a fresh row.
    const dayKey = new Date().toISOString().slice(0, 10);
    const requestHash = 'w815-gap-' + crypto.createHash('sha256')
      .update(ns + ':' + String(g.cluster_id) + ':' + dayKey)
      .digest('hex').slice(0, 16);
    try {
      const ev = await es.appendEvent({
        tenant_id: tenantId,
        namespace: ns,
        provider: 'kolm-active-learning',
        vendor: 'kolm',
        model: 'active-learning/gap',
        workflow_id: 'active_learning:gap_signal',
        request_hash: requestHash,
        prompt_tokens: 0,
        completion_tokens: 0,
        tokens_in: 0,
        tokens_out: 0,
        // status:'ok' so we don't pollute the failure rate; the W720 detector
        // picks us up via the feedback prefix below ('reject') not via status.
        status: 'ok',
        feedback: fb,
      });
      rows.push({ ok: true, event_id: ev && ev.event_id, cluster_id: g.cluster_id });
      written++;
    } catch (e) {
      rows.push({
        ok: false,
        error: 'event_store_write_failed',
        detail: e && e.message,
        cluster_id: g.cluster_id,
      });
    }
  }

  return {
    ok: true,
    written,
    attempted: gaps.length,
    rows,
    version: ACTIVE_LEARNING_VERSION,
  };
}

// ---------------------------------------------------------------------------
// W815-7 - W775-unblock contract.
// ---------------------------------------------------------------------------

/**
 * Coverage-gap surface consumed by the W775 continuous-distillation daemon.
 *
 * THIS SIGNATURE IS LOAD-BEARING - W775 imports it by this exact name and
 * destructures {ok, gaps, computed_at} from the resolved value. Do NOT
 * rename, do NOT change the return shape without coordinating with W775.
 *
 * @param {string} namespace
 * @param {object} [opts]
 * @param {string} [opts.tenant_id]   when omitted, falls back to env
 *   KOLM_TENANT_ID. Refuses to run without a tenant.
 * @param {number} [opts.min_captures=MIN_CAPTURES_FOR_GAPS]
 * @param {number} [opts.top_k=DEFAULT_TOP_K_GAPS]
 * @returns {Promise<{ok:boolean, gaps?:Array<{cluster_id:string,
 *                    gap_score:number, recommended_count:number}>,
 *                    computed_at:string, n?:number, error?:string,
 *                    hint?:string, version:'w815-v1'}>}
 */
export async function getCoverageGapsForNamespace(namespace, opts = {}) {
  const tenantId = (opts && opts.tenant_id)
    || process.env.KOLM_TENANT_ID
    || null;
  if (!tenantId) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'pass {tenant_id} or set KOLM_TENANT_ID',
      computed_at: _isoNow(),
      version: ACTIVE_LEARNING_VERSION,
    };
  }
  const ns = String(namespace || 'default').slice(0, 128);
  const topK = Number.isFinite(Number(opts && opts.top_k))
    ? Math.max(1, Math.min(1000, Math.trunc(Number(opts.top_k))))
    : DEFAULT_TOP_K_GAPS;

  const captures = await _loadCapturesForCoverage(tenantId, ns);
  // Allow opts.min_captures to lower the bar IF supplied, but never override
  // the floor of 1 capture - gaps over zero captures is meaningless.
  const minCaptures = Number.isFinite(Number(opts && opts.min_captures))
    ? Math.max(1, Math.trunc(Number(opts.min_captures)))
    : MIN_CAPTURES_FOR_GAPS;
  if (captures.length < minCaptures) {
    return {
      ok: false,
      error: 'insufficient_captures_for_coverage',
      n: captures.length,
      hint: `need at least ${minCaptures} captures for coverage analysis; have ${captures.length}.`,
      computed_at: _isoNow(),
      version: ACTIVE_LEARNING_VERSION,
    };
  }

  const det = detectCoverageGaps(captures, { top_k: topK, min_captures: minCaptures });
  if (!det.ok) {
    return {
      ok: false,
      error: det.error,
      n: det.n,
      hint: det.hint,
      computed_at: _isoNow(),
      version: ACTIVE_LEARNING_VERSION,
    };
  }

  // Shape exactly the W775-unblock fields. Extra detector fields stay
  // available behind `_details` for debugging but the daemon only relies on
  // the three required keys per gap.
  const slimGaps = det.gaps.map((g) => ({
    cluster_id: g.cluster_id,
    gap_score: g.gap_score,
    recommended_count: g.recommended_count,
  }));

  return {
    ok: true,
    gaps: slimGaps,
    n: det.n,
    computed_at: det.computed_at,
    version: ACTIVE_LEARNING_VERSION,
    _details: {
      total_buckets: det.total_buckets,
      median_bucket_size: det.median_bucket_size,
    },
  };
}

// ---------------------------------------------------------------------------
// Public test/inspection helpers
// ---------------------------------------------------------------------------

export const __internals = {
  _bucketKey,
  _readWeaknessSignal,
  _recencyScore,
  _ngramSet,
  _jaccard,
  _extractPromptText,
  _extractTimestamp,
  RECENCY_HALFLIFE_MS,
  FALLBACK_BUCKET_COUNT,
};

export default {
  ACTIVE_LEARNING_VERSION,
  MIN_CAPTURES_FOR_GAPS,
  scoreCaptureRichness,
  detectCoverageGaps,
  recommendNextCaptures,
  feedToSelfImprovement,
  getCoverageGapsForNamespace,
  __internals,
};
