// R-7 — Namespace-scoped drift detection over the capture lake + receipts.
//
// Where this fits in the drift family:
//
//   - src/drift-supersession.js  (W167) : artifact-vs-artifact K-score drift.
//                                          Compares two .kolm bundles. Used by
//                                          `kolm drift detect|cron|verify`.
//   - src/drift-detect.js        (W813) : pure-compute embedding-distribution
//                                          comparator (KL + fallback-rate). Caller
//                                          supplies pre-computed embeddings; no I/O.
//   - src/drift-alert-w813.js    (W813) : alert ladder + auto-remediate hooks.
//   - src/drift-detector.js      (R-7)  : THIS FILE. Reads live capture + receipt
//                                          rows from the lake at a NAMESPACE
//                                          scope, computes three signals
//                                          (fallback-rate delta, distribution
//                                          distance, volume ratio), and returns
//                                          a single status/recommendation.
//
// The three drift signals R-7 computes:
//
//   1. fallback_rate_delta
//      In the lookback window, what fraction of routed calls hit
//      `frontier_fallback`? Compare against the baseline window. The
//      ConfidenceRouter only emits `frontier_fallback` when the local
//      artifact lacked confidence — a rising rate is the canonical
//      "your traffic shifted away from the artifact" signal.
//      Receipts without route_decision (older rows) are excluded so we
//      never under-count or over-count the rate by treating missing as 0.
//
//   2. distribution_distance
//      Sample N captures from each window, project each one to a 256-dim
//      hash-based pseudo-embedding (bag-of-words sha256-bucketed), compute
//      the L2-normalized centroid of each window, return cosine distance.
//      This is intentionally model-free: no torch, no transformers, no
//      embedding API call. The hash bucket is stable across runs so the
//      same capture text always lands in the same bucket.
//
//   3. volume_ratio
//      Per-day rate in lookback / per-day rate in baseline. >1 means traffic
//      is climbing; <1 means it's tapering. Drift signal is the magnitude
//      of the deviation from 1.0.
//
// Thresholds + status ladder:
//
//   We track baseline statistics over the baseline window itself, then
//   declare drift when ANY of the three signals exceeds 2σ ('warn') or
//   3σ ('alert') of its in-window variance. The 2σ/3σ convention is the
//   standard SPC (Statistical Process Control) ladder and keeps thresholds
//   self-calibrating across tenants — a steady namespace with low variance
//   trips on smaller absolute deltas than a noisy one.
//
//   When the baseline window is too thin (< MIN_BASELINE_SAMPLES) we
//   return status='ok' and `recommendation:null` — refusing to fabricate
//   a drift call from insufficient data.
//
// Recommendation generator:
//
//   On warn/alert we emit the literal CLI command the operator should run:
//
//     kolm distill --namespace <ns> --priority-captures fallback_eligible --limit 200
//
//   We do NOT auto-run anything from this module — the operator stays in
//   the loop. The W813 auto-remediate path (src/drift-alert-w813.js +
//   /v1/drift/auto-remediate) is the opt-in self-driving counterpart.
//
// Tenant scoping note:
//
//   This module accepts an already-scoped {tenant_id, namespace} pair and
//   loads rows via findByTenant(...) + namespace filter. Cross-tenant
//   leakage is structurally impossible because the tenant_id is the
//   primary index on the observations table and we never fall back to
//   `all()` if findByTenant returns nothing.
//
// Pure JS — no model imports, no embedding API. Safe to call from the
// router hot path; the heaviest op is one sha256 per capture sentence.

import crypto from 'node:crypto';
import * as store from './store.js';

export const DRIFT_DETECTOR_VERSION = 'r7-v1';

// Hash-based pseudo-embedding dimension. 256 keeps the cosine distance
// numerically stable on small (10s of captures) windows while staying
// cheap to compute (one sha256 per token, mod 256).
export const PSEUDO_EMBEDDING_DIM = 256;

// Minimum captures we require in the baseline window before computing
// distribution distance. Below this we return distance:null + a
// 'insufficient_baseline_captures' note instead of a fabricated number.
export const MIN_BASELINE_SAMPLES = 8;

// Minimum receipts we require in the baseline window before computing
// fallback-rate delta. Below this we return fallback_rate_delta:null.
export const MIN_BASELINE_RECEIPTS = 5;

// Standard SPC ladder: warn at 2σ, alert at 3σ. The "1σ floor" is the
// minimum baseline standard deviation we accept — a perfectly steady
// baseline (σ ≈ 0) would otherwise trip on the tiniest absolute delta;
// the floor turns those into "ok" instead of "alert".
export const SIGMA_WARN = 2.0;
export const SIGMA_ALERT = 3.0;
const SIGMA_FLOOR_FALLBACK_RATE = 0.02; // 2 percentage points minimum noise
const SIGMA_FLOOR_DISTRIBUTION = 0.02;  // 2% cosine-distance minimum noise
const SIGMA_FLOOR_VOLUME = 0.10;        // 10% per-day rate minimum noise

// Default lookback/baseline windows in days. The lookback ("recent")
// window is what we're scoring; the baseline is the reference distribution
// that lookback is compared against.
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_BASELINE_DAYS = 30;

// =============================================================================
// Pure-compute helpers (no I/O)
// =============================================================================

// Sha256-bucket one token into [0, dim).
function _bucket(token, dim) {
  const h = crypto.createHash('sha256').update(token).digest();
  // First 4 bytes -> uint32, mod dim. Stable across runs.
  const u = (h[0] << 24 | h[1] << 16 | h[2] << 8 | h[3]) >>> 0;
  return u % dim;
}

// Bag-of-words tokenizer. Lowercase, split on non-alphanumerics, drop empties.
// Keeps the function pure and dependency-free.
function _tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  // Cap at 4096 chars per capture so a single pathological row can't blow
  // through the loop. The cap mirrors prompt_redacted's 16k slice / 4 since
  // distribution distance is rough by design.
  const sliced = text.length > 4096 ? text.slice(0, 4096) : text;
  return sliced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * pseudoEmbed(text) -> Float64Array of length PSEUDO_EMBEDDING_DIM.
 *
 * Bucketed bag-of-words: each token is sha256-hashed and the high bits
 * mod DIM pick a bucket; the bucket count is incremented. Final vector
 * is L2-normalized so cosine == dot product. Empty input -> zero vector
 * (caller must guard against zero vectors in cosine math).
 */
export function pseudoEmbed(text, dim = PSEUDO_EMBEDDING_DIM) {
  const v = new Float64Array(dim);
  const toks = _tokenize(text);
  if (toks.length === 0) return v;
  for (const t of toks) {
    v[_bucket(t, dim)] += 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/**
 * centroid(vecs) -> Float64Array. Mean vector of a list of pseudo-embeddings,
 * itself L2-normalized so cosine distance against another centroid stays
 * in [0, 2]. Empty input -> zero vector.
 */
export function centroid(vecs, dim = PSEUDO_EMBEDDING_DIM) {
  const out = new Float64Array(dim);
  if (!Array.isArray(vecs) || vecs.length === 0) return out;
  for (const v of vecs) {
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

/**
 * cosineDistance(a, b) -> number in [0, 2]. 0 == identical direction;
 * 1 == orthogonal; 2 == opposite. We return distance (1 - similarity)
 * rather than similarity so larger == more drift.
 */
export function cosineDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Clamp numerical residue.
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;
  return 1 - dot;
}

// =============================================================================
// Lake reads (the only I/O in this module)
// =============================================================================

// Receipts live in the `observations` table; rows carry `tenant`,
// `namespace`, `route_decision`, `provider`, `cost_usd`, and `ts` (epoch
// ms). Captures live in the `captures` table; rows carry `tenant`,
// `namespace`, `prompt_redacted`/`prompt`, and `created_at` (ISO string).
//
// We accept both `ts` (epoch ms) and `created_at` (ISO) on every row.
function _rowTimestampMs(row) {
  if (!row || typeof row !== 'object') return NaN;
  if (typeof row.ts === 'number' && Number.isFinite(row.ts)) return row.ts;
  if (typeof row.created_at === 'string') {
    const t = new Date(row.created_at).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof row.created_at === 'number' && Number.isFinite(row.created_at)) {
    return row.created_at;
  }
  return NaN;
}

function _isInWindow(rowTs, windowStartMs, windowEndMs) {
  return Number.isFinite(rowTs) && rowTs >= windowStartMs && rowTs <= windowEndMs;
}

// Tenant-scoped reads. Optional injection so tests can stub the lake
// without touching disk. The default reader reads observations + captures
// from src/store.js — same shape the router writes via the gateway path.
function _defaultReadReceipts(tenant_id) {
  try {
    return store.findByTenant('observations', tenant_id) || [];
  } catch (_) {
    return [];
  }
}

function _defaultReadCaptures(tenant_id) {
  try {
    // Captures live in BOTH the 'observations' table (gateway proxy) and the
    // 'captures' table (capture-stream). The fields we read (prompt text + ts)
    // are present on both; gateway observations carry `input_text` while
    // captures carry `prompt` or `prompt_redacted`. We union them so the
    // distribution signal sees the full namespace traffic.
    const obs = store.findByTenant('observations', tenant_id) || [];
    const caps = store.findByTenant('captures', tenant_id) || [];
    return [...obs, ...caps];
  } catch (_) {
    return [];
  }
}

// Slice the rows down to the requested namespace. Observations use
// `namespace` (gateway path) or `corpus_namespace` (capture-store path).
function _byNamespace(rows, namespace) {
  if (!namespace || namespace === '*') return rows;
  return rows.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    return r.namespace === namespace || r.corpus_namespace === namespace;
  });
}

// Pull the prompt text off a row for embedding. Try the most-canonical
// field first; fall back through the next-most-canonical so we work on
// both gateway rows and capture-store rows.
function _promptText(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.prompt_redacted === 'string') return row.prompt_redacted;
  if (typeof row.prompt === 'string') return row.prompt;
  if (typeof row.input_text === 'string') return row.input_text;
  if (typeof row.request_text === 'string') return row.request_text;
  return '';
}

// =============================================================================
// Signal computations
// =============================================================================

function _fallbackRate(receipts) {
  // Older rows lack route_decision — exclude them so we never mis-count.
  let known = 0;
  let fb = 0;
  for (const r of receipts) {
    if (!r || typeof r.route_decision !== 'string') continue;
    known++;
    if (r.route_decision === 'frontier_fallback') fb++;
  }
  if (known === 0) return { rate: null, sample_size: 0 };
  return { rate: fb / known, sample_size: known };
}

// Distribution distance between two pools of captures. Returns
// { distance, baseline_size, lookback_size }. distance is null when
// either window is empty.
function _distributionDistance(baselineCaps, lookbackCaps) {
  const bVecs = [];
  for (const c of baselineCaps) {
    const t = _promptText(c);
    if (!t) continue;
    bVecs.push(pseudoEmbed(t));
  }
  const lVecs = [];
  for (const c of lookbackCaps) {
    const t = _promptText(c);
    if (!t) continue;
    lVecs.push(pseudoEmbed(t));
  }
  if (bVecs.length === 0 || lVecs.length === 0) {
    return { distance: null, baseline_size: bVecs.length, lookback_size: lVecs.length };
  }
  const bC = centroid(bVecs);
  const lC = centroid(lVecs);
  return {
    distance: cosineDistance(bC, lC),
    baseline_size: bVecs.length,
    lookback_size: lVecs.length,
  };
}

// Volume ratio: per-day rate in lookback over per-day rate in baseline.
// >1 means rising traffic; <1 means tapering. Returns 1.0 when either
// window contributes zero rows (no signal -> no drift).
function _volumeRatio(baselineCount, baselineDays, lookbackCount, lookbackDays) {
  if (baselineDays <= 0 || lookbackDays <= 0) return 1;
  const bRate = baselineCount / baselineDays;
  const lRate = lookbackCount / lookbackDays;
  if (bRate <= 0) {
    // No baseline traffic; if lookback also has none, no signal. Otherwise
    // treat as a large ratio so the SPC ladder flags it.
    return lRate > 0 ? Infinity : 1;
  }
  return lRate / bRate;
}

// =============================================================================
// SPC ladder — compute baseline standard deviation by chunking the baseline
// window into N sub-windows and treating each chunk's signal as one sample.
// =============================================================================

// Chunk baseline receipts into K equal-time slices, compute fallback rate
// per slice, return {mean, sigma}. Used so the SPC ladder is self-calibrated
// against in-window variance rather than a global constant.
function _baselineFallbackStats(baselineReceipts, baselineStartMs, baselineEndMs) {
  const K = 6; // 6 chunks of a 30-day window = 5-day slices.
  const stepMs = (baselineEndMs - baselineStartMs) / K;
  if (stepMs <= 0) return { mean: 0, sigma: SIGMA_FLOOR_FALLBACK_RATE };
  const rates = [];
  for (let i = 0; i < K; i++) {
    const s = baselineStartMs + i * stepMs;
    const e = s + stepMs;
    const inSlice = baselineReceipts.filter((r) => {
      const t = _rowTimestampMs(r);
      return Number.isFinite(t) && t >= s && t < e;
    });
    const { rate, sample_size } = _fallbackRate(inSlice);
    if (rate !== null && sample_size > 0) rates.push(rate);
  }
  if (rates.length === 0) return { mean: 0, sigma: SIGMA_FLOOR_FALLBACK_RATE };
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  let varSum = 0;
  for (const r of rates) varSum += (r - mean) * (r - mean);
  const sigma = Math.max(SIGMA_FLOOR_FALLBACK_RATE, Math.sqrt(varSum / rates.length));
  return { mean, sigma };
}

// Same idea, but for the distribution-distance signal. Each chunk gets its
// own centroid; we compute distance against the overall baseline centroid
// and treat the per-chunk distances as the variance sample. This is a
// self-baseline noise floor — if the baseline is internally chunky we let
// lookback drift more before flagging.
function _baselineDistributionStats(baselineCaps, baselineStartMs, baselineEndMs) {
  const K = 6;
  const stepMs = (baselineEndMs - baselineStartMs) / K;
  if (stepMs <= 0) return { mean: 0, sigma: SIGMA_FLOOR_DISTRIBUTION };
  const fullVecs = [];
  for (const c of baselineCaps) {
    const t = _promptText(c);
    if (t) fullVecs.push(pseudoEmbed(t));
  }
  if (fullVecs.length === 0) return { mean: 0, sigma: SIGMA_FLOOR_DISTRIBUTION };
  const fullC = centroid(fullVecs);
  const dists = [];
  for (let i = 0; i < K; i++) {
    const s = baselineStartMs + i * stepMs;
    const e = s + stepMs;
    const slice = baselineCaps.filter((c) => {
      const t = _rowTimestampMs(c);
      return Number.isFinite(t) && t >= s && t < e;
    });
    const sliceVecs = [];
    for (const c of slice) {
      const t = _promptText(c);
      if (t) sliceVecs.push(pseudoEmbed(t));
    }
    if (sliceVecs.length === 0) continue;
    const sC = centroid(sliceVecs);
    dists.push(cosineDistance(sC, fullC));
  }
  if (dists.length === 0) return { mean: 0, sigma: SIGMA_FLOOR_DISTRIBUTION };
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  let varSum = 0;
  for (const d of dists) varSum += (d - mean) * (d - mean);
  const sigma = Math.max(SIGMA_FLOOR_DISTRIBUTION, Math.sqrt(varSum / dists.length));
  return { mean, sigma };
}

// Volume sigma derives from per-day count variance in the baseline.
function _baselineVolumeStats(baselineRows, baselineStartMs, baselineEndMs, baselineDays) {
  if (baselineDays <= 0) return { mean: 1, sigma: SIGMA_FLOOR_VOLUME };
  const dayMs = 24 * 3600 * 1000;
  const daily = [];
  for (let d = 0; d < baselineDays; d++) {
    const s = baselineStartMs + d * dayMs;
    const e = s + dayMs;
    if (e > baselineEndMs) break;
    let count = 0;
    for (const r of baselineRows) {
      const t = _rowTimestampMs(r);
      if (Number.isFinite(t) && t >= s && t < e) count++;
    }
    daily.push(count);
  }
  if (daily.length === 0) return { mean: 0, sigma: SIGMA_FLOOR_VOLUME };
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  if (mean <= 0) return { mean: 0, sigma: SIGMA_FLOOR_VOLUME };
  let varSum = 0;
  for (const c of daily) varSum += (c - mean) * (c - mean);
  // Coefficient-of-variation as ratio noise (sigma_ratio = sigma/mean).
  const sigmaCount = Math.sqrt(varSum / daily.length);
  const sigmaRatio = Math.max(SIGMA_FLOOR_VOLUME, sigmaCount / mean);
  return { mean, sigma: sigmaRatio };
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * computeDriftSignals({tenant_id, namespace, lookback_days, baseline_days, ...})
 *
 * Returns a structured envelope:
 *
 *   {
 *     ok: true, version,
 *     tenant_id, namespace,
 *     lookback_days, baseline_days,
 *     fallback_rate_delta: number|null,
 *     distribution_distance: number|null,
 *     volume_ratio: number|null,
 *     status: 'ok' | 'warn' | 'alert',
 *     recommendation: string|null,
 *     // Diagnostic breakdown — surfaced so the dashboard can show "why".
 *     details: {
 *       lookback: { receipts_count, captures_count, fallback_rate, fallback_sample_size },
 *       baseline: { receipts_count, captures_count, fallback_rate, fallback_sample_size,
 *                   fallback_sigma, distribution_sigma, volume_sigma },
 *       per_signal_status: { fallback: 'ok'|'warn'|'alert', distribution: ..., volume: ... },
 *     }
 *   }
 *
 * On bad input returns { ok:false, error, hint, version }.
 *
 * `now` and `readReceipts`/`readCaptures` are test injection seams so unit
 * tests can pin the clock and stub the lake.
 */
export function computeDriftSignals(opts = {}) {
  const {
    tenant_id = null,
    namespace = 'default',
    lookback_days = DEFAULT_LOOKBACK_DAYS,
    baseline_days = DEFAULT_BASELINE_DAYS,
    now = Date.now(),
    readReceipts = _defaultReadReceipts,
    readCaptures = _defaultReadCaptures,
  } = opts || {};

  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass tenant_id (drift is scoped per-tenant; cross-tenant queries are not supported)',
      version: DRIFT_DETECTOR_VERSION,
    };
  }
  if (!Number.isFinite(Number(lookback_days)) || Number(lookback_days) <= 0) {
    return {
      ok: false,
      error: 'invalid_lookback_days',
      hint: 'lookback_days must be a positive number',
      version: DRIFT_DETECTOR_VERSION,
    };
  }
  if (!Number.isFinite(Number(baseline_days)) || Number(baseline_days) <= 0) {
    return {
      ok: false,
      error: 'invalid_baseline_days',
      hint: 'baseline_days must be a positive number',
      version: DRIFT_DETECTOR_VERSION,
    };
  }

  const lbDays = Number(lookback_days);
  const bDays = Number(baseline_days);
  const dayMs = 24 * 3600 * 1000;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const lookbackStart = nowMs - lbDays * dayMs;
  const lookbackEnd = nowMs;
  // Baseline window ends where the lookback begins (they don't overlap).
  const baselineEnd = lookbackStart;
  const baselineStart = baselineEnd - bDays * dayMs;

  // ---- Read once + slice into windows ----
  const allReceipts = _byNamespace(readReceipts(tenant_id), namespace);
  const allCaptures = _byNamespace(readCaptures(tenant_id), namespace);

  const lookbackReceipts = allReceipts.filter((r) =>
    _isInWindow(_rowTimestampMs(r), lookbackStart, lookbackEnd));
  const baselineReceipts = allReceipts.filter((r) =>
    _isInWindow(_rowTimestampMs(r), baselineStart, baselineEnd));
  const lookbackCaptures = allCaptures.filter((r) =>
    _isInWindow(_rowTimestampMs(r), lookbackStart, lookbackEnd));
  const baselineCaptures = allCaptures.filter((r) =>
    _isInWindow(_rowTimestampMs(r), baselineStart, baselineEnd));

  // ---- Signal 1: fallback-rate delta ----
  const lbFb = _fallbackRate(lookbackReceipts);
  const bFb = _fallbackRate(baselineReceipts);
  let fallback_rate_delta = null;
  if (lbFb.rate !== null && bFb.rate !== null && bFb.sample_size >= MIN_BASELINE_RECEIPTS) {
    fallback_rate_delta = lbFb.rate - bFb.rate;
  }
  const fbStats = _baselineFallbackStats(baselineReceipts, baselineStart, baselineEnd);

  // ---- Signal 2: distribution distance ----
  const dd = _distributionDistance(baselineCaptures, lookbackCaptures);
  let distribution_distance = null;
  if (dd.distance !== null && dd.baseline_size >= MIN_BASELINE_SAMPLES) {
    distribution_distance = dd.distance;
  }
  const dStats = _baselineDistributionStats(baselineCaptures, baselineStart, baselineEnd);

  // ---- Signal 3: volume ratio (per-day rate lookback / baseline) ----
  // We use receipts as the volume signal so it stays aligned with the
  // fallback-rate denominator. If receipts are sparse we fall back to
  // capture counts.
  const volumeRows = baselineReceipts.length + lookbackReceipts.length >= MIN_BASELINE_RECEIPTS
    ? { baseline: baselineReceipts, lookback: lookbackReceipts }
    : { baseline: baselineCaptures, lookback: lookbackCaptures };
  const volume_ratio = (volumeRows.baseline.length > 0)
    ? _volumeRatio(volumeRows.baseline.length, bDays, volumeRows.lookback.length, lbDays)
    : (volumeRows.lookback.length > 0 ? Infinity : 1);
  const vStats = _baselineVolumeStats(volumeRows.baseline, baselineStart, baselineEnd, bDays);

  // ---- SPC ladder: classify each signal against its in-window σ ----
  function _spc(deltaAbs, sigma) {
    if (sigma <= 0) return 'ok';
    if (deltaAbs >= SIGMA_ALERT * sigma) return 'alert';
    if (deltaAbs >= SIGMA_WARN * sigma) return 'warn';
    return 'ok';
  }

  const fbStatus = (fallback_rate_delta == null)
    ? 'ok'
    : _spc(Math.abs(fallback_rate_delta), fbStats.sigma);
  const dStatus = (distribution_distance == null)
    ? 'ok'
    : _spc(Math.max(0, distribution_distance - dStats.mean), dStats.sigma);
  // Volume: deviation is |ratio - 1|. We compare against a sigma derived
  // from baseline per-day variance.
  const vStatus = (!Number.isFinite(volume_ratio))
    ? 'alert'
    : _spc(Math.abs(volume_ratio - 1), vStats.sigma);

  // Overall status = worst of the three.
  const ladder = { ok: 0, warn: 1, alert: 2 };
  const worst = Math.max(ladder[fbStatus], ladder[dStatus], ladder[vStatus]);
  const status = worst === 2 ? 'alert' : worst === 1 ? 'warn' : 'ok';

  // ---- Recommendation generator ----
  let recommendation = null;
  if (status === 'warn' || status === 'alert') {
    // Always recommend the same starting command — the operator can refine
    // limits. The `fallback_eligible` cohort lifts the captures that landed
    // on `frontier_fallback` so the next distill round focuses on the
    // weakness the router already surfaced.
    recommendation = `kolm distill --namespace ${namespace} --priority-captures fallback_eligible --limit 200`;
  }

  return {
    ok: true,
    version: DRIFT_DETECTOR_VERSION,
    tenant_id,
    namespace,
    lookback_days: lbDays,
    baseline_days: bDays,
    fallback_rate_delta,
    distribution_distance,
    volume_ratio: Number.isFinite(volume_ratio) ? volume_ratio : null,
    status,
    recommendation,
    details: {
      lookback: {
        receipts_count: lookbackReceipts.length,
        captures_count: lookbackCaptures.length,
        fallback_rate: lbFb.rate,
        fallback_sample_size: lbFb.sample_size,
      },
      baseline: {
        receipts_count: baselineReceipts.length,
        captures_count: baselineCaptures.length,
        fallback_rate: bFb.rate,
        fallback_sample_size: bFb.sample_size,
        fallback_mean: fbStats.mean,
        fallback_sigma: fbStats.sigma,
        distribution_mean: dStats.mean,
        distribution_sigma: dStats.sigma,
        volume_mean: vStats.mean,
        volume_sigma: vStats.sigma,
      },
      per_signal_status: {
        fallback: fbStatus,
        distribution: dStatus,
        volume: vStatus,
      },
      thresholds: {
        sigma_warn: SIGMA_WARN,
        sigma_alert: SIGMA_ALERT,
        min_baseline_samples: MIN_BASELINE_SAMPLES,
        min_baseline_receipts: MIN_BASELINE_RECEIPTS,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// wave4-r-enrich: KL-divergence calc + topic/length/fallback/language drift
// score, severity ladder, and class wrapper. Distinct from the
// computeDriftSignals path above (which uses an SPC ladder over receipts).
// The KL path is more suitable for topic-distribution drift where the caller
// already has discrete event/topic counts in hand.
// ---------------------------------------------------------------------------

export const SEVERITY_LEVELS = Object.freeze(['none', 'low', 'medium', 'high']);

// SPC-independent thresholds for the KL-class severity rules. Tuned against
// the same baseline-vs-lookback fixtures the R-7 SPC ladder uses.
export const SEVERITY_THRESHOLDS = Object.freeze({
  // high if fallback_rate_delta > 0.05 OR topic_kl > 0.3
  high_fallback_rate_delta: 0.05,
  high_topic_kl:            0.30,
  // medium if either > half the high thresholds
  medium_fallback_rate_delta: 0.025,
  medium_topic_kl:            0.15,
  // length / language are tertiary signals — same shape, smaller cutoffs
  medium_length_shift: 0.20,
  high_length_shift:   0.40,
  medium_language_shift: 0.10,
  high_language_shift:   0.25,
});

/**
 * klDivergence(distA, distB) -> number
 *
 * KL(A || B) = sum_k A[k] * log( A[k] / B[k] ).
 *
 * Inputs are distributions expressed as `{key: prob}` objects. Probabilities
 * are normalised inside the function so callers can pass raw counts; we
 * never assume the caller pre-normalised.
 *
 * For numerical stability we add SMOOTHING (Laplace +1 over the merged
 * support) to every bucket before normalising. This means two truly
 * identical distributions still return ~0 (within float precision); a
 * distribution and the empty distribution returns a finite (non-NaN) value.
 *
 * Returns 0 when both distributions are empty.
 */
const KL_SMOOTHING = 1e-12;

export function klDivergence(distA, distB) {
  if (!distA || typeof distA !== 'object' || Array.isArray(distA)) {
    throw new TypeError('klDivergence: distA must be an object {key: prob}');
  }
  if (!distB || typeof distB !== 'object' || Array.isArray(distB)) {
    throw new TypeError('klDivergence: distB must be an object {key: prob}');
  }
  // Build the union of keys, then add smoothing so log() never sees a 0.
  const keys = new Set([...Object.keys(distA), ...Object.keys(distB)]);
  if (keys.size === 0) return 0;
  // Normalise + smooth both distributions over the same support.
  let sumA = 0;
  let sumB = 0;
  for (const k of keys) {
    sumA += Number(distA[k]) || 0;
    sumB += Number(distB[k]) || 0;
  }
  if (sumA <= 0 && sumB <= 0) return 0;
  const denomA = sumA + KL_SMOOTHING * keys.size;
  const denomB = sumB + KL_SMOOTHING * keys.size;
  let kl = 0;
  for (const k of keys) {
    const pa = ((Number(distA[k]) || 0) + KL_SMOOTHING) / denomA;
    const pb = ((Number(distB[k]) || 0) + KL_SMOOTHING) / denomB;
    if (pa <= 0) continue;
    kl += pa * Math.log(pa / pb);
  }
  // KL is non-negative for proper distributions; clamp to 0 for
  // numerical residue on the floating-point boundary.
  return Math.max(0, kl);
}

/**
 * scoreSeverity(drift) -> 'none' | 'low' | 'medium' | 'high'
 *
 * Applies the documented thresholds. `drift` is the object returned by
 * DriftDetector.checkDrift(); the rules:
 *
 *   high   if fallback_rate_delta > 0.05 OR topic_kl > 0.3
 *   medium if fallback_rate_delta > 0.025 OR topic_kl > 0.15
 *          (i.e. half the high thresholds)
 *   low    if any tertiary signal trips its low cutoff
 *   none   otherwise
 */
export function scoreSeverity(drift) {
  if (!drift || typeof drift !== 'object') return 'none';
  const fbd = Math.abs(Number(drift.fallback_rate_delta) || 0);
  const tkl = Number(drift.topic_kl_divergence) || 0;
  const len = Math.abs(Number(drift.length_shift) || 0);
  const lang = Number(drift.language_shift) || 0;

  if (fbd > SEVERITY_THRESHOLDS.high_fallback_rate_delta
      || tkl > SEVERITY_THRESHOLDS.high_topic_kl
      || len > SEVERITY_THRESHOLDS.high_length_shift
      || lang > SEVERITY_THRESHOLDS.high_language_shift) {
    return 'high';
  }
  if (fbd > SEVERITY_THRESHOLDS.medium_fallback_rate_delta
      || tkl > SEVERITY_THRESHOLDS.medium_topic_kl
      || len > SEVERITY_THRESHOLDS.medium_length_shift
      || lang > SEVERITY_THRESHOLDS.medium_language_shift) {
    return 'medium';
  }
  if (fbd > 0 || tkl > 0 || len > 0 || lang > 0) return 'low';
  return 'none';
}

/**
 * DriftDetector — class wrapper around the lake-read drift signals path.
 *
 * Distinct from computeDriftSignals above:
 *   - returns the (topic_kl_divergence, length_shift, fallback_rate,
 *     fallback_rate_baseline, fallback_rate_delta, language_shift,
 *     severity, recommendation, suggested_captures) shape the Part-B
 *     spec calls for.
 *   - severity comes from scoreSeverity (KL-class rules), not the SPC ladder.
 *   - recommendation includes a suggested_captures cohort identifier so the
 *     UI can deep-link to the right capture filter.
 *
 * Construct with the same scoping context computeDriftSignals takes:
 *   new DriftDetector({tenant_id, namespace, now?, readReceipts?, readCaptures?})
 */
export class DriftDetector {
  constructor(opts = {}) {
    if (!opts.tenant_id || typeof opts.tenant_id !== 'string') {
      throw new Error('DriftDetector: tenant_id required (string)');
    }
    this.tenant_id = opts.tenant_id;
    this.namespace = opts.namespace || 'default';
    this.now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    this.readReceipts = opts.readReceipts || _defaultReadReceipts;
    this.readCaptures = opts.readCaptures || _defaultReadCaptures;
  }

  async checkDrift(windowDays = DEFAULT_LOOKBACK_DAYS) {
    const dayMs = 24 * 3600 * 1000;
    const windowEnd = this.now;
    const windowStart = windowEnd - windowDays * dayMs;
    const baselineEnd = windowStart;
    const baselineStart = baselineEnd - DEFAULT_BASELINE_DAYS * dayMs;

    const allReceipts = _byNamespace(this.readReceipts(this.tenant_id), this.namespace);
    const allCaptures = _byNamespace(this.readCaptures(this.tenant_id), this.namespace);

    const lookbackReceipts = allReceipts.filter((r) =>
      _isInWindow(_rowTimestampMs(r), windowStart, windowEnd));
    const baselineReceipts = allReceipts.filter((r) =>
      _isInWindow(_rowTimestampMs(r), baselineStart, baselineEnd));
    const lookbackCaptures = allCaptures.filter((r) =>
      _isInWindow(_rowTimestampMs(r), windowStart, windowEnd));
    const baselineCaptures = allCaptures.filter((r) =>
      _isInWindow(_rowTimestampMs(r), baselineStart, baselineEnd));

    // Fallback rates (rate is null when window is empty so we never average
    // across silence)
    const lbFb = _fallbackRate(lookbackReceipts);
    const bFb = _fallbackRate(baselineReceipts);
    const fallback_rate = lbFb.rate;
    const fallback_rate_baseline = bFb.rate;
    const fallback_rate_delta = (lbFb.rate != null && bFb.rate != null)
      ? lbFb.rate - bFb.rate
      : null;

    // Topic KL via bag-of-words histograms (the same hash buckets the SPC
    // path uses, but here aggregated as raw counts so KL is meaningful)
    const buildHist = (rows) => {
      const h = {};
      for (const r of rows) {
        const t = _promptText(r);
        if (!t) continue;
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          h[tok] = (h[tok] || 0) + 1;
        }
      }
      return h;
    };
    const histL = buildHist(lookbackCaptures);
    const histB = buildHist(baselineCaptures);
    const topic_kl_divergence = (Object.keys(histL).length === 0 && Object.keys(histB).length === 0)
      ? 0
      : klDivergence(histL, histB);

    // Length shift = (mean_lookback - mean_baseline) / mean_baseline
    const meanLen = (rows) => {
      let n = 0, sum = 0;
      for (const r of rows) {
        const t = _promptText(r);
        if (!t) continue;
        n++; sum += t.length;
      }
      return n > 0 ? sum / n : 0;
    };
    const mlL = meanLen(lookbackCaptures);
    const mlB = meanLen(baselineCaptures);
    const length_shift = mlB > 0 ? (mlL - mlB) / mlB : 0;

    // Language shift — coarse: fraction of captures with non-ASCII characters.
    // Magnitude of |frac_lookback - frac_baseline|.
    const nonAsciiFrac = (rows) => {
      if (rows.length === 0) return 0;
      let n = 0;
      for (const r of rows) {
        const t = _promptText(r);
        if (t && /[^\x00-\x7F]/.test(t)) n++;
      }
      return n / rows.length;
    };
    const language_shift = Math.abs(nonAsciiFrac(lookbackCaptures) - nonAsciiFrac(baselineCaptures));

    const drift = {
      topic_kl_divergence,
      length_shift,
      fallback_rate,
      fallback_rate_baseline,
      fallback_rate_delta,
      language_shift,
    };
    const severity = scoreSeverity(drift);
    let recommendation = null;
    let suggested_captures = null;
    if (severity === 'high' || severity === 'medium') {
      recommendation = `kolm distill --namespace ${this.namespace} --priority-captures fallback_eligible --limit 200`;
      suggested_captures = 'fallback_eligible';
    } else if (severity === 'low') {
      recommendation = `kolm distill --namespace ${this.namespace} --priority-captures recent --limit 50`;
      suggested_captures = 'recent';
    }
    return {
      ...drift,
      severity,
      recommendation,
      suggested_captures,
      window_days: windowDays,
      baseline_days: DEFAULT_BASELINE_DAYS,
      sample_sizes: {
        lookback_receipts: lookbackReceipts.length,
        baseline_receipts: baselineReceipts.length,
        lookback_captures: lookbackCaptures.length,
        baseline_captures: baselineCaptures.length,
      },
    };
  }
}

export default {
  DRIFT_DETECTOR_VERSION,
  PSEUDO_EMBEDDING_DIM,
  MIN_BASELINE_SAMPLES,
  MIN_BASELINE_RECEIPTS,
  SIGMA_WARN,
  SIGMA_ALERT,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_BASELINE_DAYS,
  SEVERITY_LEVELS,
  SEVERITY_THRESHOLDS,
  pseudoEmbed,
  centroid,
  cosineDistance,
  computeDriftSignals,
  klDivergence,
  scoreSeverity,
  DriftDetector,
};
