// src/govern-drift.js
//
// W921 Govern / Receipts & Compliance — standard drift statistics: PSI,
// MMD (RBF + median-heuristic + permutation p-value) and ADWIN2.
//
// WHY: kolm's bespoke SPC detector is fine for a thin baseline, but a buyer's
// model-risk / compliance reviewer expects the STANDARD, named, citable tests
// (Population Stability Index; Gretton-2012 Maximum Mean Discrepancy; Bifet &
// Gavaldà ADWIN2). This module provides them as pure, zero-dependency,
// deterministic-under-seed functions that produce corroborating evidence
// (each with its own sample floor and threshold ladder). They never flip a
// primary SPC verdict — they are additional signals under a standard_signals
// block, with a named test + threshold + p-value cite-able by assurance-case.
//
// All math is from primary sources (cited inline). Zero new package.json deps.

export const DRIFT_STATS_VERSION = 'w921-drift-v1';

// Standard PSI ladder.
export const PSI_WARN = 0.1;
export const PSI_ALERT = 0.25;
// MMD permutation defaults.
export const MMD_PERMUTATIONS = 200;
export const MMD_ALPHA = 0.05;
export const MMD_MAX_SAMPLES = 512;
// ADWIN2 default confidence.
export const ADWIN_DELTA = 0.002;
// Sample floors — below these we report status:'ok' with a note, never alert.
export const MIN_PSI_SAMPLES = 20;
export const MIN_MMD_SAMPLES = 8;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so permutation tests + subsampling are
// reproducible under a fixed seed (acceptance criterion).
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function asFiniteNumbers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(Number).filter((x) => Number.isFinite(x));
}

// ===========================================================================
// PSI — Population Stability Index
//
//   PSI = Σ_bins (observed% - expected%) * ln(observed% / expected%)
//   bins = baseline-derived quantile edges (deciles default), reused for BOTH
//   samples. Empty bins are epsilon-smoothed so PSI is never ±Infinity/NaN.
//   Ladder: <0.1 ok, 0.1..0.25 warn, >=0.25 alert.
// ===========================================================================

// psiBins — baseline quantile bin edges (length = bins+1). Deciles default.
export function psiBins(baselineScalars, bins = 10) {
  const xs = asFiniteNumbers(baselineScalars).slice().sort((a, b) => a - b);
  const nBins = Math.max(2, Math.floor(bins) || 10);
  if (xs.length === 0) return null;
  const edges = [];
  for (let i = 0; i <= nBins; i++) {
    const q = i / nBins;
    // type-7 empirical quantile
    const pos = q * (xs.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    edges.push(xs[lo] + (xs[hi] - xs[lo]) * frac);
  }
  // Force monotone non-decreasing edges and ensure the outer edges are open.
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] < edges[i - 1]) edges[i] = edges[i - 1];
  }
  edges[0] = -Infinity;
  edges[edges.length - 1] = Infinity;
  return edges;
}

function bucketize(xs, edges) {
  const counts = new Array(edges.length - 1).fill(0);
  for (const x of xs) {
    // find bin b with edges[b] <= x < edges[b+1]; last bin is closed on right.
    let placed = false;
    for (let b = 0; b < counts.length; b++) {
      const lo = edges[b];
      const hi = edges[b + 1];
      if (x >= lo && (x < hi || b === counts.length - 1)) {
        counts[b]++;
        placed = true;
        break;
      }
    }
    if (!placed) counts[counts.length - 1]++;
  }
  return counts;
}

export function populationStabilityIndex(baselineScalars, lookbackScalars, opts = {}) {
  const eps = opts.eps != null ? opts.eps : 1e-4;
  const bins = opts.bins != null ? opts.bins : 10;
  const warn = opts.warn != null ? opts.warn : PSI_WARN;
  const alert = opts.alert != null ? opts.alert : PSI_ALERT;
  const base = asFiniteNumbers(baselineScalars);
  const look = asFiniteNumbers(lookbackScalars);
  if (base.length < MIN_PSI_SAMPLES || look.length < MIN_PSI_SAMPLES) {
    return {
      ok: true, psi: null, status: 'ok', bins: 0, per_bin: [],
      baseline_size: base.length, lookback_size: look.length,
      note: `insufficient_samples (need >=${MIN_PSI_SAMPLES} each)`,
      version: DRIFT_STATS_VERSION,
    };
  }
  const edges = psiBins(base, bins);
  const eCounts = bucketize(base, edges);
  const oCounts = bucketize(look, edges);
  const eTotal = base.length;
  const oTotal = look.length;
  let psi = 0;
  const per_bin = [];
  for (let b = 0; b < eCounts.length; b++) {
    let ePct = eCounts[b] / eTotal;
    let oPct = oCounts[b] / oTotal;
    if (ePct <= 0) ePct = eps;
    if (oPct <= 0) oPct = eps;
    const contribution = (oPct - ePct) * Math.log(oPct / ePct);
    psi += contribution;
    per_bin.push({
      edge_lo: edges[b], edge_hi: edges[b + 1],
      expected: ePct, observed: oPct, contribution,
    });
  }
  let status = 'ok';
  if (psi >= alert) status = 'alert';
  else if (psi >= warn) status = 'warn';
  return {
    ok: true, psi, status, bins: eCounts.length, per_bin,
    baseline_size: eTotal, lookback_size: oTotal, version: DRIFT_STATS_VERSION,
  };
}

// ===========================================================================
// MMD — Maximum Mean Discrepancy (Gretton 2012)
//
//   MMD^2_u = 1/(m(m-1)) Σ_{i≠j} k(x_i,x_j) + 1/(n(n-1)) Σ_{i≠j} k(y_i,y_j)
//             - 2/(mn) Σ_{i,j} k(x_i,y_j)   (unbiased U-statistic)
//   RBF kernel k(a,b) = exp(-||a-b||^2 / (2 sigma^2)); sigma = median heuristic.
//   p-value via P pooled label-shuffle permutations.
// ===========================================================================

function sqL2(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

export function medianHeuristicSigma(pooled) {
  if (!Array.isArray(pooled) || pooled.length < 2) return 1;
  const dists = [];
  // cap pairwise computation for large pools
  const cap = Math.min(pooled.length, 64);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      dists.push(Math.sqrt(sqL2(pooled[i], pooled[j])));
    }
  }
  if (dists.length === 0) return 1;
  dists.sort((a, b) => a - b);
  const mid = Math.floor(dists.length / 2);
  const med = dists.length % 2 ? dists[mid] : (dists[mid - 1] + dists[mid]) / 2;
  return med > 0 ? med : 1;
}

export function rbfKernelMatrix(A, B, sigma) {
  const denom = 2 * sigma * sigma || 1;
  const m = A.length, n = B.length;
  const K = new Array(m);
  for (let i = 0; i < m; i++) {
    K[i] = new Array(n);
    for (let j = 0; j < n; j++) {
      K[i][j] = Math.exp(-sqL2(A[i], B[j]) / denom);
    }
  }
  return K;
}

function rbf(a, b, sigma) {
  const denom = 2 * sigma * sigma || 1;
  return Math.exp(-sqL2(a, b) / denom);
}

export function mmd2Unbiased(X, Y, kernel) {
  const m = X.length, n = Y.length;
  if (m < 2 || n < 2) return 0;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) if (i !== j) sxx += kernel(X[i], X[j]);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) if (i !== j) syy += kernel(Y[i], Y[j]);
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) sxy += kernel(X[i], Y[j]);
  }
  return sxx / (m * (m - 1)) + syy / (n * (n - 1)) - (2 * sxy) / (m * n);
}

function deterministicSubsample(arr, max, rng) {
  if (arr.length <= max) return arr.slice();
  const idx = arr.map((_, i) => i);
  // Fisher-Yates with seeded rng, take first max.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, max).map((i) => arr[i]);
}

export function mmdPermutationTest(X0, Y0, opts = {}) {
  const permutations = opts.permutations != null ? opts.permutations : MMD_PERMUTATIONS;
  const alpha = opts.alpha != null ? opts.alpha : MMD_ALPHA;
  const maxSamples = opts.max_samples != null ? opts.max_samples : MMD_MAX_SAMPLES;
  const seed = opts.seed != null ? opts.seed : 1337;
  const rng = mulberry32(seed);

  const X = Array.isArray(X0) ? X0.filter((v) => Array.isArray(v)) : [];
  const Y = Array.isArray(Y0) ? Y0.filter((v) => Array.isArray(v)) : [];
  if (X.length < MIN_MMD_SAMPLES || Y.length < MIN_MMD_SAMPLES) {
    return {
      ok: true, mmd2: null, p_value: null, status: 'ok',
      sigma: 0, permutations: 0, x_size: X.length, y_size: Y.length,
      subsampled: false, note: `insufficient_samples (need >=${MIN_MMD_SAMPLES} each)`,
      version: DRIFT_STATS_VERSION,
    };
  }
  // Deterministic subsample to bound O((m+n)^2 P).
  const halfCap = Math.floor(maxSamples / 2);
  const subsampled = X.length > halfCap || Y.length > halfCap;
  const Xs = deterministicSubsample(X, halfCap, rng);
  const Ys = deterministicSubsample(Y, halfCap, rng);
  const pooled = Xs.concat(Ys);
  const sigma = opts.sigma != null && opts.sigma > 0 ? opts.sigma : medianHeuristicSigma(pooled);
  const kernel = (a, b) => rbf(a, b, sigma);

  const observed = mmd2Unbiased(Xs, Ys, kernel);
  const m = Xs.length;
  let geCount = 1; // include observed (conservative, avoids p=0)
  for (let p = 0; p < permutations; p++) {
    // shuffle pooled, split into m / rest.
    const perm = pooled.slice();
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const pa = perm.slice(0, m);
    const pb = perm.slice(m);
    const stat = mmd2Unbiased(pa, pb, kernel);
    if (stat >= observed) geCount++;
  }
  const p_value = geCount / (permutations + 1);
  return {
    ok: true, mmd2: observed, p_value,
    status: p_value < alpha ? 'alert' : 'ok',
    sigma, permutations, x_size: Xs.length, y_size: Ys.length,
    subsampled, version: DRIFT_STATS_VERSION,
  };
}

// ===========================================================================
// ADWIN2 (Bifet & Gavaldà 2007) — adaptive windowing change detector over a
// stream of bounded real values. Exponential-histogram buckets; cut threshold
//   epsilon_cut = sqrt(2 * m * v * deltaPrime) + (2/3) * m * deltaPrime
//   m = harmonic mean of the two subwindow sizes; deltaPrime = ln(2 ln(n)/delta).
// ===========================================================================

export function adwinEpsilonCut(n0, n1, variance, n, delta) {
  if (n0 <= 0 || n1 <= 0) return Infinity;
  const m = 1 / (1 / n0 + 1 / n1); // harmonic-mean style m = (n0*n1)/(n0+n1)
  const lnTerm = Math.log((2 * Math.log(Math.max(n, 2))) / delta);
  const dp = lnTerm > 0 ? lnTerm : 1e-9;
  return Math.sqrt(2 * (1 / m) * variance * dp) + (2 / 3) * (1 / m) * dp;
}

// A compact ADWIN2 over an explicit bucket list. We keep a list of buckets,
// each {total, count}. On each update we add a new singleton bucket, then look
// for a cut point where the two subwindow means differ by more than epsilon_cut.
export function adwin2(opts = {}) {
  const delta = opts.delta != null ? opts.delta : ADWIN_DELTA;
  const minWin = opts.min_window_length != null ? opts.min_window_length : 5;
  const grace = opts.grace_period != null ? opts.grace_period : 0;

  let buckets = []; // each {sum, n}
  let total = 0;
  let width = 0;
  let seen = 0;
  let nDetections = 0;

  function variance() {
    if (width === 0) return 0;
    const mean = total / width;
    // We track a running approximation via bucket means (bounded-value streams,
    // so this is the standard ADWIN incremental variance proxy).
    let v = 0;
    for (const b of buckets) {
      const bm = b.sum / b.n;
      v += b.n * (bm - mean) * (bm - mean);
    }
    return v / width;
  }

  function tryShrink() {
    let drift = false;
    let changePoint = null;
    let changed = true;
    while (changed) {
      changed = false;
      if (buckets.length < 2 || width < minWin) break;
      // walk split points from the left
      let n0 = 0, sum0 = 0;
      for (let i = 0; i < buckets.length - 1; i++) {
        n0 += buckets[i].n;
        sum0 += buckets[i].sum;
        const n1 = width - n0;
        const sum1 = total - sum0;
        if (n0 < 1 || n1 < 1) continue;
        const mean0 = sum0 / n0;
        const mean1 = sum1 / n1;
        const eps = adwinEpsilonCut(n0, n1, variance(), width, delta);
        if (Math.abs(mean0 - mean1) > eps) {
          // drop the oldest bucket (subwindow W0 head) — older data is stale.
          drift = true;
          nDetections++;
          changePoint = n0;
          const dropped = buckets.shift();
          width -= dropped.n;
          total -= dropped.sum;
          changed = true;
          break;
        }
      }
    }
    return { drift, changePoint };
  }

  return {
    update(x) {
      const v = Number(x);
      if (!Number.isFinite(v)) return { drift_detected: false, change_point_index: null };
      seen++;
      buckets.push({ sum: v, n: 1 });
      total += v; width += 1;
      if (seen <= grace) return { drift_detected: false, change_point_index: null };
      const { drift, changePoint } = tryShrink();
      return { drift_detected: drift, change_point_index: drift ? (seen - width) : null, _cp: changePoint };
    },
    width() { return width; },
    variance() { return variance(); },
    total() { return total; },
    detections() { return nDetections; },
    reset() { buckets = []; total = 0; width = 0; seen = 0; nDetections = 0; },
  };
}

export function detectAdwinOverSeries(series, opts = {}) {
  const delta = opts.delta != null ? opts.delta : ADWIN_DELTA;
  if (!Array.isArray(series) || series.length === 0) {
    return { ok: true, drift_detected: false, change_point_ts: null, n_detections: 0, final_width: 0, delta, version: DRIFT_STATS_VERSION };
  }
  const sorted = series
    .filter((p) => p && Number.isFinite(Number(p.value)))
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const det = adwin2({ delta, ...(opts.adwin || {}) });
  let drift = false;
  let changePointTs = null;
  let lastDetectIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    const r = det.update(sorted[i].value);
    if (r.drift_detected) {
      drift = true;
      lastDetectIdx = i;
      changePointTs = sorted[i].ts;
    }
  }
  return {
    ok: true,
    drift_detected: drift,
    change_point_ts: changePointTs,
    n_detections: det.detections(),
    final_width: det.width(),
    last_detection_index: lastDetectIdx,
    delta, version: DRIFT_STATS_VERSION,
  };
}

// ===========================================================================
// computeStandardSignals — orchestrator producing the standard_signals block.
// ===========================================================================
export function computeStandardSignals(input = {}) {
  const opts = input.opts || {};
  const psi = (input.baselineScalars && input.lookbackScalars)
    ? populationStabilityIndex(input.baselineScalars, input.lookbackScalars, opts.psi || {})
    : null;
  const psi_cost = (input.costScalars && input.costScalars.baseline && input.costScalars.lookback)
    ? populationStabilityIndex(input.costScalars.baseline, input.costScalars.lookback, opts.psi || {})
    : null;
  const mmd = (input.baselineEmbeds && input.lookbackEmbeds)
    ? mmdPermutationTest(input.baselineEmbeds, input.lookbackEmbeds, opts.mmd || {})
    : null;
  const adwin_fallback = input.fallbackSeries
    ? detectAdwinOverSeries(input.fallbackSeries, opts.adwin || {})
    : null;
  const adwin_volume = input.volumeSeries
    ? detectAdwinOverSeries(input.volumeSeries, opts.adwin || {})
    : null;

  // Aggregate status: alert if any alert; warn if any warn; else ok.
  let status = 'ok';
  const sigs = [psi, psi_cost, mmd, adwin_fallback, adwin_volume];
  for (const s of sigs) {
    if (!s) continue;
    if (s.status === 'alert' || s.drift_detected === true) { status = 'alert'; break; }
    if (s.status === 'warn') status = 'warn';
  }
  return {
    ok: true, psi, psi_cost, mmd, adwin_fallback, adwin_volume,
    status, version: DRIFT_STATS_VERSION,
  };
}

export const GOVERN_DRIFT_SPEC = {
  version: DRIFT_STATS_VERSION,
  tests: ['psi', 'mmd_rbf_permutation', 'adwin2'],
  psi_ladder: { warn: PSI_WARN, alert: PSI_ALERT },
  mmd: { permutations: MMD_PERMUTATIONS, alpha: MMD_ALPHA, kernel: 'rbf_median_heuristic' },
  adwin: { delta: ADWIN_DELTA },
};
