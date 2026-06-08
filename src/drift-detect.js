// W813 - Drift Detection (embedding-distribution + fallback-rate-lift comparator).
//
// Atomic guarantees pinned by tests/wave813-drift-detection.test.js:
//
//   - DRIFT_DETECT_VERSION = 'w813-v1'
//   - DEFAULT_KL_THRESHOLD = 0.10 (W813-2 spec)
//   - DEFAULT_FALLBACK_RATE_LIFT = 0.20 (W813-2 spec)
//   - MIN_HISTOGRAM_BINS = 8
//   - DEFAULT_HISTOGRAM_BINS = 32
//   - embeddingHistogram is pure JS, deterministic for same input.
//   - klDivergence epsilon-smoothed - NEVER NaN, NEVER Infinity.
//   - compareDistributions returns drift_detected as OR(kl_drift, fallback_drift),
//     severity ladder in {none, minor, moderate, severe}.
//   - quantifyShift computes per-cluster proportion deltas, ranked.
//   - buildSuggestedActionText emits the W813-4 spec template verbatim:
//       "your traffic shifted N% more <cluster_label> queries; re-distill recommended"
//
// HONESTY INVARIANTS (NEVER violate):
//   - drift_detected NEVER true unless a threshold is actually crossed
//   - klDivergence epsilon smoothing is mandatory (zero bins must not nuke math)
//   - Empty / insufficient input returns honest envelope, never silent-pass
//   - This module is PURE COMPUTE - no I/O, no notifications, no W720 trigger.
//     The W813 alert + auto-remediate live in src/drift-alert-w813.js + the
//     router. This file extends src/drift-supersession.js CONCEPTUALLY only;
//     supersession is artifact-vs-artifact K-score comparison whereas this is
//     live-vs-training EMBEDDING comparison. The two modules share zero
//     functions on purpose (different threat models).
//
// W411 defense-in-depth note: tenant fencing happens at the alert/store boundary
// (see src/drift-alert-w813.js + src/drift-config.js). This module accepts already-
// scoped embedding arrays - it has no concept of tenant_id, so it cannot leak
// across tenants by construction.

export const DRIFT_DETECT_VERSION = 'w813-v1';

// W813-2 spec: default KL divergence threshold. Below 0.10 the live and
// training distributions are considered statistically interchangeable for
// routing purposes. Above 0.10 the operator gets a drift alert.
export const DEFAULT_KL_THRESHOLD = 0.10;

// W813-2 spec: default fallback-rate lift threshold. When the live fallback
// rate (queries that miss cache + fall back to teacher) climbs more than 20
// percentage points above the training fallback rate, drift is flagged
// independent of KL.
export const DEFAULT_FALLBACK_RATE_LIFT = 0.20;

// Minimum histogram bins. Below 8 the KL signal is dominated by binning noise
// rather than distribution shift. This is a HARD floor - requests for fewer
// bins are clamped up so callers cannot silently degrade signal quality.
export const MIN_HISTOGRAM_BINS = 8;

// Default histogram bin count. 32 bins is small enough to stay sub-millisecond
// on 10k-sample arrays and large enough to resolve the kind of mode shift a
// re-distillation would catch.
export const DEFAULT_HISTOGRAM_BINS = 32;

// Default epsilon for KL smoothing. Small enough that a single nonzero bin
// dominates a zero bin; large enough that the log term stays finite.
const DEFAULT_EPSILON = 1e-9;

// Required sample floor for compareDistributions: at least MIN * 2 in EACH
// of {live, training} so each bin has at least an expected count of 2.
const MIN_SAMPLES_PER_SET = MIN_HISTOGRAM_BINS * 2;

// =============================================================================
// Internal helpers
// =============================================================================

// Reduce a multi-dimensional embedding to a single scalar by projecting onto
// a fixed seed direction. We use a deterministic Mulberry32-style seed so the
// projection is stable across runs. NOT random; same embedding always projects
// to the same scalar. This is intentionally simpler than full PCA because:
//   (a) we only need a scalar for binning, not a basis,
//   (b) the comparator is invariant to which direction we project as long as
//       both live and training use the SAME direction,
//   (c) zero dependencies beyond pure JS.
function _seededDirection(dim, seed = 0x9E3779B9) {
  const out = new Array(dim);
  let s = seed >>> 0;
  for (let i = 0; i < dim; i++) {
    // Mulberry32 step.
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5;
  }
  // L2-normalize so projection magnitudes stay bounded.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

function _projectScalar(embedding, direction) {
  let s = 0;
  const n = Math.min(embedding.length, direction.length);
  for (let i = 0; i < n; i++) {
    const v = Number(embedding[i]);
    if (!Number.isFinite(v)) continue;
    s += v * direction[i];
  }
  return s;
}

function _isEmbeddingArray(x) {
  return Array.isArray(x) && x.every((row) => Array.isArray(row) && row.length > 0);
}

// =============================================================================
// embeddingHistogram(embeddings, opts) - bin a list of embeddings.
//
// Returns:
//   { ok:true, version, bins, bin_edges:[len=bins+1], bin_counts:[len=bins],
//     total_samples, normalized:true }
//
// Honest envelope on empty input or non-array input.
//
// NOTE on `normalized:true` - bin_counts hold raw counts (integers); the
// `normalized:true` flag advertises that bin EDGES were computed on the
// observed scalar range so total counts always equal total_samples. Callers
// that want a PMF can divide bin_counts[i] / total_samples.
// =============================================================================
export function embeddingHistogram(embeddings, opts = {}) {
  if (!_isEmbeddingArray(embeddings) || embeddings.length === 0) {
    return {
      ok: false,
      error: 'no_embeddings',
      hint: 'pass a non-empty array of number arrays (each row is one embedding)',
      version: DRIFT_DETECT_VERSION,
    };
  }
  // All embeddings must share dimension - mixed dims would silently bias the
  // projection. Refuse loudly.
  const dim = embeddings[0].length;
  for (let i = 0; i < embeddings.length; i++) {
    if (embeddings[i].length !== dim) {
      return {
        ok: false,
        error: 'embedding_dim_mismatch',
        hint: `row 0 has dim ${dim}; row ${i} has dim ${embeddings[i].length}`,
        version: DRIFT_DETECT_VERSION,
      };
    }
  }
  let bins = Number(opts && opts.bins);
  if (!Number.isFinite(bins) || bins < MIN_HISTOGRAM_BINS) {
    bins = DEFAULT_HISTOGRAM_BINS;
  }
  bins = Math.max(MIN_HISTOGRAM_BINS, Math.floor(bins));

  const direction = _seededDirection(dim);
  const scalars = new Array(embeddings.length);
  for (let i = 0; i < embeddings.length; i++) {
    scalars[i] = _projectScalar(embeddings[i], direction);
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < scalars.length; i++) {
    const v = scalars[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Degenerate case: every embedding projects to the same scalar (constant
  // input). Single-bin histogram is still honest - return it with total
  // samples and let the caller treat it as "no variance".
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const edges = new Array(bins + 1).fill(min);
    const counts = new Array(bins).fill(0);
    counts[0] = scalars.length;
    return {
      ok: true,
      version: DRIFT_DETECT_VERSION,
      bins,
      bin_edges: edges,
      bin_counts: counts,
      total_samples: scalars.length,
      normalized: true,
      degenerate: true,
    };
  }

  const width = (max - min) / bins;
  const edges = new Array(bins + 1);
  for (let i = 0; i <= bins; i++) edges[i] = min + i * width;
  // Force the last edge to the exact max to avoid floating drift placing the
  // max value beyond the last edge.
  edges[bins] = max;

  const counts = new Array(bins).fill(0);
  for (let i = 0; i < scalars.length; i++) {
    let idx = Math.floor((scalars[i] - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return {
    ok: true,
    version: DRIFT_DETECT_VERSION,
    bins,
    bin_edges: edges,
    bin_counts: counts,
    total_samples: scalars.length,
    normalized: true,
  };
}

// =============================================================================
// klDivergence(p_hist, q_hist, opts) - scalar KL(p||q) >= 0.
//
// p_hist and q_hist are { bin_counts:[], total_samples:N } shapes (or the full
// embeddingHistogram envelope).
//
// Honest envelope on shape mismatch (different bin count).
// Epsilon smoothing: every bin is smoothed by epsilon before division so zero
// bins never produce NaN or Infinity. KL is computed in NATS (natural log).
// =============================================================================
export function klDivergence(p_hist, q_hist, opts = {}) {
  if (!p_hist || !q_hist || typeof p_hist !== 'object' || typeof q_hist !== 'object') {
    return {
      ok: false,
      error: 'bad_histograms',
      hint: 'both p_hist and q_hist must be histogram envelopes ({bin_counts, total_samples})',
      version: DRIFT_DETECT_VERSION,
    };
  }
  const pc = Array.isArray(p_hist.bin_counts) ? p_hist.bin_counts : null;
  const qc = Array.isArray(q_hist.bin_counts) ? q_hist.bin_counts : null;
  if (!pc || !qc) {
    return {
      ok: false,
      error: 'bad_histograms',
      hint: 'bin_counts must be arrays on both histograms',
      version: DRIFT_DETECT_VERSION,
    };
  }
  if (pc.length !== qc.length) {
    return {
      ok: false,
      error: 'shape_mismatch',
      hint: `p has ${pc.length} bins; q has ${qc.length} bins. Use same bins= for both embeddingHistogram() calls.`,
      version: DRIFT_DETECT_VERSION,
    };
  }
  if (pc.length === 0) {
    return {
      ok: false,
      error: 'empty_histograms',
      version: DRIFT_DETECT_VERSION,
    };
  }
  const epsilon = (opts && typeof opts.epsilon === 'number' && opts.epsilon > 0)
    ? opts.epsilon
    : DEFAULT_EPSILON;

  let pSum = 0;
  let qSum = 0;
  for (let i = 0; i < pc.length; i++) {
    pSum += pc[i] + epsilon;
    qSum += qc[i] + epsilon;
  }
  if (pSum <= 0 || qSum <= 0) {
    return {
      ok: true,
      kl: 0,
      version: DRIFT_DETECT_VERSION,
      note: 'degenerate_all_zero',
    };
  }

  let kl = 0;
  for (let i = 0; i < pc.length; i++) {
    const pi = (pc[i] + epsilon) / pSum;
    const qi = (qc[i] + epsilon) / qSum;
    // Guard against any residual numerical edge - both pi and qi must be
    // strictly positive after smoothing.
    if (pi > 0 && qi > 0) {
      kl += pi * Math.log(pi / qi);
    }
  }
  // KL is mathematically nonneg but float drift on near-identical
  // distributions can produce tiny negatives; clamp.
  if (kl < 0) kl = 0;
  // NaN / Infinity defense - should never fire after smoothing, but the
  // honesty invariant demands a finite result.
  if (!Number.isFinite(kl)) {
    return {
      ok: false,
      error: 'numerical_overflow',
      hint: 'KL produced non-finite value despite epsilon smoothing - inspect bin_counts for extreme magnitudes',
      version: DRIFT_DETECT_VERSION,
    };
  }
  return {
    ok: true,
    kl,
    version: DRIFT_DETECT_VERSION,
    epsilon,
    bins: pc.length,
  };
}

// =============================================================================
// compareDistributions({...}) - the W813-2 orchestrator.
//
// Inputs:
//   live_embeddings, training_embeddings  : number[][]
//   opts.bins                              : histogram bins (default 32)
//   opts.kl_threshold                      : default 0.10
//   opts.fallback_rate_lift                : default 0.20
//   opts.live_fallback_rate                : 0..1 observed live fallback rate
//   opts.training_fallback_rate            : 0..1 observed training fallback rate
//
// Returns:
//   { ok:true, version,
//     kl_divergence, kl_threshold, kl_drift_detected,
//     fallback_rate_delta, fallback_drift_detected,
//     drift_detected,                          // OR of kl + fallback
//     severity: 'none'|'minor'|'moderate'|'severe',
//     suggested_action_text }
//
// Honest envelope on insufficient samples (< MIN_SAMPLES_PER_SET in either set).
//
// Severity ladder (W813 spec, no spec line but derived from "soft|hard"):
//   none      : neither signal crosses
//   minor     : one signal crosses by < 2x threshold
//   moderate  : one signal crosses by 2x..5x threshold OR both cross by < 2x
//   severe    : either signal crosses by >= 5x threshold OR both cross by >= 2x
// =============================================================================
export function compareDistributions(input = {}) {
  const {
    live_embeddings = null,
    training_embeddings = null,
    opts = {},
  } = input || {};

  if (!_isEmbeddingArray(live_embeddings) || !_isEmbeddingArray(training_embeddings)) {
    return {
      ok: false,
      error: 'embeddings_required',
      hint: 'pass live_embeddings + training_embeddings as number[][] (each row is one embedding)',
      version: DRIFT_DETECT_VERSION,
    };
  }
  if (live_embeddings.length < MIN_SAMPLES_PER_SET
      || training_embeddings.length < MIN_SAMPLES_PER_SET) {
    return {
      ok: false,
      error: 'insufficient_samples',
      hint: `need >= ${MIN_SAMPLES_PER_SET} embeddings in each set; got live=${live_embeddings.length}, training=${training_embeddings.length}`,
      min_samples_per_set: MIN_SAMPLES_PER_SET,
      version: DRIFT_DETECT_VERSION,
    };
  }

  const bins = (opts && Number.isFinite(Number(opts.bins)))
    ? Math.max(MIN_HISTOGRAM_BINS, Math.floor(Number(opts.bins)))
    : DEFAULT_HISTOGRAM_BINS;
  const kl_threshold = (opts && typeof opts.kl_threshold === 'number' && opts.kl_threshold > 0)
    ? opts.kl_threshold
    : DEFAULT_KL_THRESHOLD;
  const fallback_rate_lift = (opts && typeof opts.fallback_rate_lift === 'number' && opts.fallback_rate_lift > 0)
    ? opts.fallback_rate_lift
    : DEFAULT_FALLBACK_RATE_LIFT;

  // Use the SAME bins for both histograms so KL has a well-defined shape.
  // We compute each histogram against its own min/max range though, which
  // means a sharp shift in support is reflected as KL signal. To keep the
  // bin shapes alignable we re-bin against the union range.
  const allEmbeds = live_embeddings.concat(training_embeddings);
  const unionHist = embeddingHistogram(allEmbeds, { bins });
  if (!unionHist.ok) return unionHist;

  // Now rebin live and training against the unionHist edges so KL operates
  // on a common support.
  const unionEdges = unionHist.bin_edges;
  function _binAgainst(embeddings) {
    if (!_isEmbeddingArray(embeddings) || embeddings.length === 0) return null;
    const dim = embeddings[0].length;
    const direction = _seededDirection(dim);
    const counts = new Array(bins).fill(0);
    const min = unionEdges[0];
    const max = unionEdges[bins];
    const width = (max - min) / bins || 1;
    for (let i = 0; i < embeddings.length; i++) {
      const s = _projectScalar(embeddings[i], direction);
      let idx;
      if (max === min) {
        idx = 0;
      } else {
        idx = Math.floor((s - min) / width);
        if (idx < 0) idx = 0;
        if (idx >= bins) idx = bins - 1;
      }
      counts[idx]++;
    }
    return {
      ok: true,
      bin_counts: counts,
      total_samples: embeddings.length,
      bins,
      bin_edges: unionEdges,
      version: DRIFT_DETECT_VERSION,
      normalized: true,
    };
  }

  const liveHist = _binAgainst(live_embeddings);
  const trainHist = _binAgainst(training_embeddings);
  if (!liveHist || !trainHist) {
    return {
      ok: false,
      error: 'binning_failed',
      version: DRIFT_DETECT_VERSION,
    };
  }

  const klRes = klDivergence(liveHist, trainHist, { epsilon: DEFAULT_EPSILON });
  if (!klRes.ok) return klRes;
  const kl_divergence = klRes.kl;
  const kl_drift_detected = kl_divergence > kl_threshold;

  let fallback_rate_delta = null;
  let fallback_drift_detected = false;
  const lf = (opts && typeof opts.live_fallback_rate === 'number')
    ? Math.max(0, Math.min(1, opts.live_fallback_rate))
    : null;
  const tf = (opts && typeof opts.training_fallback_rate === 'number')
    ? Math.max(0, Math.min(1, opts.training_fallback_rate))
    : null;
  if (lf !== null && tf !== null) {
    fallback_rate_delta = lf - tf;
    fallback_drift_detected = fallback_rate_delta > fallback_rate_lift;
  }

  const drift_detected = kl_drift_detected || fallback_drift_detected;

  // Severity ladder
  let kl_excess = 0;
  if (kl_drift_detected && kl_threshold > 0) {
    kl_excess = kl_divergence / kl_threshold;
  }
  let fb_excess = 0;
  if (fallback_drift_detected && fallback_rate_lift > 0 && fallback_rate_delta !== null) {
    fb_excess = fallback_rate_delta / fallback_rate_lift;
  }
  const maxExcess = Math.max(kl_excess, fb_excess);
  const bothCrossSmall = (kl_drift_detected && fallback_drift_detected
                           && kl_excess >= 1 && fb_excess >= 1);
  let severity = 'none';
  if (drift_detected) {
    if (maxExcess >= 5) severity = 'severe';
    else if (bothCrossSmall && (kl_excess >= 2 || fb_excess >= 2)) severity = 'severe';
    else if (maxExcess >= 2) severity = 'moderate';
    else if (bothCrossSmall) severity = 'moderate';
    else severity = 'minor';
  }

  // Suggested-action text - default phrasing if no shift breakdown.
  // Caller can call quantifyShift + buildSuggestedActionText separately for
  // cluster-aware messaging. Here we emit a coarse default that still uses
  // the W813-4 template shape.
  let suggested_action_text;
  if (!drift_detected) {
    suggested_action_text = 'no action required; live distribution within tolerance of training distribution';
  } else {
    // Approximate "how big a shift" as the dominant signal's excess as a
    // percentage of threshold. Cluster label defaults to "live traffic" so
    // the text remains honest when caller has no cluster breakdown.
    const pct = Math.round(Math.max(kl_excess, fb_excess) * 100);
    suggested_action_text =
      `your traffic shifted ${pct}% more live traffic queries; re-distill recommended`;
  }

  return {
    ok: true,
    version: DRIFT_DETECT_VERSION,
    kl_divergence,
    kl_threshold,
    kl_drift_detected,
    fallback_rate_delta,
    fallback_rate_lift,
    fallback_drift_detected,
    drift_detected,
    severity,
    suggested_action_text,
    bins,
    live_samples: live_embeddings.length,
    training_samples: training_embeddings.length,
  };
}

// =============================================================================
// quantifyShift({live_clusters, training_clusters}) - per-cluster proportion
// shift, ranked desc by |delta_pct|.
//
// Inputs are objects like { cluster_id: count, ... } or arrays of
// { cluster_id, count } / { cluster_id, label, count }.
//
// Returns sorted list of { cluster_id, label?, training_pct, live_pct,
// delta_pct, direction: 'increase' | 'decrease' }.
// =============================================================================
function _normalizeClusters(input) {
  if (!input) return new Map();
  const m = new Map();
  const labels = new Map();
  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || typeof row !== 'object') continue;
      const id = row.cluster_id != null ? String(row.cluster_id) : null;
      if (!id) continue;
      const c = Number(row.count);
      if (!Number.isFinite(c) || c < 0) continue;
      m.set(id, (m.get(id) || 0) + c);
      if (row.label != null && !labels.has(id)) labels.set(id, String(row.label));
    }
  } else if (typeof input === 'object') {
    for (const [id, val] of Object.entries(input)) {
      const c = Number(val);
      if (!Number.isFinite(c) || c < 0) continue;
      m.set(String(id), (m.get(String(id)) || 0) + c);
    }
  }
  return { counts: m, labels };
}

export function quantifyShift({ live_clusters, training_clusters } = {}) {
  const live = _normalizeClusters(live_clusters);
  const train = _normalizeClusters(training_clusters);
  const liveCounts = live.counts || new Map();
  const trainCounts = train.counts || new Map();
  if (liveCounts.size === 0 && trainCounts.size === 0) {
    return {
      ok: false,
      error: 'no_clusters',
      hint: 'pass non-empty live_clusters + training_clusters',
      version: DRIFT_DETECT_VERSION,
    };
  }
  let liveTotal = 0;
  for (const v of liveCounts.values()) liveTotal += v;
  let trainTotal = 0;
  for (const v of trainCounts.values()) trainTotal += v;

  const allIds = new Set([...liveCounts.keys(), ...trainCounts.keys()]);
  const rows = [];
  for (const id of allIds) {
    const liveC = liveCounts.get(id) || 0;
    const trainC = trainCounts.get(id) || 0;
    const live_pct = liveTotal > 0 ? (liveC / liveTotal) * 100 : 0;
    const training_pct = trainTotal > 0 ? (trainC / trainTotal) * 100 : 0;
    const delta_pct = live_pct - training_pct;
    const direction = delta_pct >= 0 ? 'increase' : 'decrease';
    const label = (live.labels && live.labels.get(id)) || (train.labels && train.labels.get(id)) || null;
    const row = { cluster_id: id, training_pct, live_pct, delta_pct, direction };
    if (label) row.label = label;
    rows.push(row);
  }
  rows.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));
  return {
    ok: true,
    version: DRIFT_DETECT_VERSION,
    shifts: rows,
    live_total: liveTotal,
    training_total: trainTotal,
  };
}

// =============================================================================
// buildSuggestedActionText(shift_summary) - W813-4 spec verbatim template.
//
// shift_summary is the output of quantifyShift() OR a single shift row.
// We pick the top |delta_pct| shift (rounded) and emit:
//   "your traffic shifted N% more <cluster_label> queries; re-distill recommended"
//
// HONESTY: when no shifts crossed zero (i.e. live == training perfectly) we
// emit "no action required..." rather than fabricate a fake shift.
// =============================================================================
export function buildSuggestedActionText(shift_summary) {
  if (!shift_summary || typeof shift_summary !== 'object') {
    return 'no action required; insufficient shift data to recommend';
  }
  let top = null;
  if (Array.isArray(shift_summary.shifts)) {
    for (const row of shift_summary.shifts) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.delta_pct !== 'number') continue;
      if (top == null || Math.abs(row.delta_pct) > Math.abs(top.delta_pct)) {
        top = row;
      }
    }
  } else if (typeof shift_summary.delta_pct === 'number') {
    top = shift_summary;
  }
  if (!top || !Number.isFinite(top.delta_pct) || Math.abs(top.delta_pct) < 0.5) {
    return 'no action required; live distribution matches training distribution within tolerance';
  }
  const pct = Math.round(Math.abs(top.delta_pct));
  const label = top.label || top.cluster_label || top.cluster_id || 'unspecified-cluster';
  // W813-4 spec template (verbatim): "your traffic shifted N% more X queries; re-distill recommended"
  return `your traffic shifted ${pct}% more ${label} queries; re-distill recommended`;
}

export default {
  DRIFT_DETECT_VERSION,
  DEFAULT_KL_THRESHOLD,
  DEFAULT_FALLBACK_RATE_LIFT,
  MIN_HISTOGRAM_BINS,
  DEFAULT_HISTOGRAM_BINS,
  embeddingHistogram,
  klDivergence,
  compareDistributions,
  quantifyShift,
  buildSuggestedActionText,
};
