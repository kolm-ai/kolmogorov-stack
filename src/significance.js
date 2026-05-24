// src/significance.js
//
// W822-3 - Pure-JS statistical significance helpers.
//
// chiSquared(observed, expected)   -> {chi2, df, p_value}
// bootstrap({arr_a, arr_b, n_iters, statistic, alpha}) -> {ci_low, ci_high, p_value}
//
// Why a NEW module (separate from src/stat-sig.js)?
//   stat-sig.js is the Welch's t-test gate from W778. This module ships two
//   *different* test families: chi-squared for contingency-table goodness-of-fit
//   (we use it for fallback_rate / thumbs_up vs thumbs_down counts where the
//   underlying datum is categorical, not continuous), and bootstrap for
//   distribution-free CIs on any statistic. Both belong in their own module so
//   the t-test and the chi-squared paths can evolve independently without one
//   driving regressions into the other.
//
// Honesty contract:
//   - chiSquared returns p_value=1 when expected has any zero cell (chi-sq is
//     undefined). df is the (rows-1)*(cols-1) form when both args are 2-D, or
//     length-1 for 1-D vectors.
//   - bootstrap returns {ci_low:null, ci_high:null, p_value:1} when either
//     array is empty (no signal to resample).
//
// p-value approximation: Wilson-Hilferty cube-root transform of chi-square to
// the standard normal. Accurate to ~1e-3 across (df >= 3, p in [1e-4, 0.5]).
// For df=1 we use the closed-form Phi(sqrt(chi2)).
//
// SIGNIFICANCE_VERSION = 'w822-vN' -- consumers MUST match /^w822-/ NOT
// literal equality (W604 anti-brittleness).

export const SIGNIFICANCE_VERSION = 'w822-v1';

// =============================================================================
// Standard normal CDF Phi(z) -- Abramowitz & Stegun 26.2.17, ~7.5e-8 max error.
// =============================================================================

function _phi(z) {
  // For |z| > 8 the tail is below double-precision floor; return 0/1 cleanly.
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  if (z > 8) return 1;
  if (z < -8) return 0;
  // A&S 26.2.17 -- 1 - phi_pdf(z) * (b1 t + b2 t^2 + ... + b5 t^5), t=1/(1+p z).
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const t = 1 / (1 + p * x);
  const pdf = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const tail = pdf * poly; // upper tail for x > 0
  const cdf = 1 - tail;
  return sign === 1 ? cdf : (1 - cdf);
}

// Two-tailed normal p-value for |z|.
function _twoTailNormal(z) {
  return 2 * (1 - _phi(Math.abs(z)));
}

// =============================================================================
// chiSquared(observed, expected) -> {chi2, df, p_value}
// =============================================================================
//
// Accepts either:
//   - matched 1-D arrays  -> df = length - 1
//   - matched 2-D arrays (rows x cols) -> df = (rows-1) * (cols-1)
//
// Throws TypeError if shapes mismatch. Returns honest envelope (p=1, chi2=0)
// when expected has any zero cell (avoids division by zero) so callers can
// chain on .p_value without NaN.

function _flatten2D(m) {
  const out = [];
  for (const row of m) {
    if (!Array.isArray(row)) {
      throw new TypeError('chiSquared: expected 2-D array but row was not an Array');
    }
    for (const v of row) out.push(v);
  }
  return out;
}

function _is2D(a) {
  return Array.isArray(a) && a.length > 0 && Array.isArray(a[0]);
}

function _shape(a) {
  if (_is2D(a)) return [a.length, a[0].length];
  if (Array.isArray(a)) return [a.length];
  return [];
}

function _sameShape(a, b) {
  const sa = _shape(a);
  const sb = _shape(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Wilson-Hilferty approximation of the upper-tail chi-square p-value.
 * For df==1 we use the closed-form 2 * (1 - Phi(sqrt(chi2))).
 */
function _chi2PValue(chi2, df) {
  if (!Number.isFinite(chi2) || !Number.isFinite(df) || df <= 0) return 1;
  if (chi2 <= 0) return 1;
  if (df === 1) {
    // chi2(1) = Z^2; upper-tail = 2 * (1 - Phi(sqrt(chi2)))
    return 2 * (1 - _phi(Math.sqrt(chi2)));
  }
  // Wilson-Hilferty: ((chi2/df)^(1/3) - (1 - 2/(9 df))) / sqrt(2/(9 df)) ~ N(0,1)
  const a = Math.pow(chi2 / df, 1 / 3);
  const b = 1 - (2 / (9 * df));
  const c = Math.sqrt(2 / (9 * df));
  const z = (a - b) / c;
  // Upper tail probability.
  return 1 - _phi(z);
}

/**
 * chiSquared(observed, expected) -> {chi2, df, p_value, version}
 *
 * observed + expected must have the same shape (both 1-D or both 2-D, same
 * dims). When any expected cell is <=0 the test is undefined; we return
 * chi2=0 + p_value=1 + zero_cells:true (honest envelope, never NaN).
 */
export function chiSquared(observed, expected) {
  if (!Array.isArray(observed) || !Array.isArray(expected)) {
    throw new TypeError('chiSquared(observed, expected) requires two arrays');
  }
  if (!_sameShape(observed, expected)) {
    const so = JSON.stringify(_shape(observed));
    const se = JSON.stringify(_shape(expected));
    throw new TypeError('chiSquared: shape mismatch observed=' + so + ' expected=' + se);
  }
  let obs, exp, df;
  if (_is2D(observed)) {
    obs = _flatten2D(observed);
    exp = _flatten2D(expected);
    const [rows, cols] = _shape(observed);
    df = Math.max(1, (rows - 1) * (cols - 1));
  } else {
    obs = observed.slice();
    exp = expected.slice();
    df = Math.max(1, observed.length - 1);
  }
  let chi2 = 0;
  let zeroCells = false;
  for (let i = 0; i < obs.length; i++) {
    const e = Number(exp[i]);
    const o = Number(obs[i]);
    if (!Number.isFinite(e) || !Number.isFinite(o)) {
      throw new TypeError('chiSquared: non-numeric value at index ' + i);
    }
    if (e <= 0) {
      zeroCells = true;
      continue;
    }
    const diff = o - e;
    chi2 += (diff * diff) / e;
  }
  if (zeroCells) {
    return {
      chi2: 0,
      df,
      p_value: 1,
      zero_cells: true,
      version: SIGNIFICANCE_VERSION,
    };
  }
  return {
    chi2,
    df,
    p_value: _chi2PValue(chi2, df),
    version: SIGNIFICANCE_VERSION,
  };
}

// =============================================================================
// Bootstrap CI + permutation p-value for the difference of statistics.
// =============================================================================
//
// bootstrap({arr_a, arr_b, n_iters, statistic, alpha}) returns:
//   { ci_low, ci_high, p_value, mean_diff, n_a, n_b, statistic, n_iters,
//     alpha, version }
//
// CI: percentile bootstrap on (stat(B*) - stat(A*)) at the (alpha/2, 1-alpha/2)
// quantiles, default alpha=0.05 (95% CI). statistic in {'mean','median','sum'}.
//
// p-value: permutation test (label shuffle) at n_iters trials. Two-sided.
//   p = (1 + #{|stat_perm| >= |stat_obs|}) / (1 + n_iters)
// the +1 is the conservative correction so p > 0 even when no permutation
// exceeds the observed (avoids the "p=0 is impossible" foot-gun).
//
// No external deps. RNG is splitmix32 seeded off Math.random() so tests can be
// flaky-free without taking a `seedrandom` dep; pass {seed:N} for reproducible
// runs.

function _splitmix32(state) {
  // Returns next uint32; advances state in place via closure.
  let s = state.s | 0;
  return function next() {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) | 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) | 0;
    z = (z ^ (z >>> 16)) >>> 0;
    state.s = s;
    return z;
  };
}

function _rngFromSeed(seed) {
  const s = (Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 0x7fffffff)) | 0;
  const state = { s: s || 1 };
  const next = _splitmix32(state);
  // Returns a float in [0, 1).
  return function rng() {
    return next() / 0x100000000;
  };
}

function _statOf(name) {
  if (name === 'median') {
    return (arr) => {
      if (arr.length === 0) return 0;
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      if (sorted.length % 2 === 1) return sorted[mid];
      return (sorted[mid - 1] + sorted[mid]) / 2;
    };
  }
  if (name === 'sum') {
    return (arr) => {
      let s = 0;
      for (const v of arr) s += v;
      return s;
    };
  }
  // default: mean
  return (arr) => {
    if (arr.length === 0) return 0;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  };
}

function _resample(arr, rng) {
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = arr[Math.floor(rng() * n)];
  }
  return out;
}

function _quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * bootstrap({arr_a, arr_b, n_iters, statistic, alpha, seed}) returns:
 *   { ci_low, ci_high, p_value, mean_diff, n_a, n_b, statistic, n_iters,
 *     alpha, version }
 *
 * arr_a, arr_b: number[]; n_iters defaults to 1000; statistic in
 * {'mean','median','sum'}; alpha defaults to 0.05.
 *
 * Empty inputs -> { ci_low:null, ci_high:null, p_value:1, ... }
 */
export function bootstrap(args = {}) {
  const arr_a = Array.isArray(args.arr_a) ? args.arr_a.filter(v => Number.isFinite(Number(v))).map(Number) : [];
  const arr_b = Array.isArray(args.arr_b) ? args.arr_b.filter(v => Number.isFinite(Number(v))).map(Number) : [];
  const n_iters = Math.max(1, Math.min(100000, Math.trunc(Number(args.n_iters) || 1000)));
  const alpha = Number.isFinite(Number(args.alpha)) ? Number(args.alpha) : 0.05;
  const statName = (args.statistic === 'median' || args.statistic === 'sum') ? args.statistic : 'mean';
  const stat = _statOf(statName);
  const rng = _rngFromSeed(args.seed);

  if (arr_a.length === 0 || arr_b.length === 0) {
    return {
      ci_low: null,
      ci_high: null,
      p_value: 1,
      mean_diff: null,
      n_a: arr_a.length,
      n_b: arr_b.length,
      statistic: statName,
      n_iters,
      alpha,
      version: SIGNIFICANCE_VERSION,
    };
  }

  // Observed difference (B - A).
  const obs_diff = stat(arr_b) - stat(arr_a);
  const abs_obs = Math.abs(obs_diff);

  // Percentile bootstrap on (stat(B*) - stat(A*)).
  const diffs = new Array(n_iters);
  for (let i = 0; i < n_iters; i++) {
    diffs[i] = stat(_resample(arr_b, rng)) - stat(_resample(arr_a, rng));
  }
  diffs.sort((a, b) => a - b);
  const ci_low = _quantile(diffs, alpha / 2);
  const ci_high = _quantile(diffs, 1 - alpha / 2);

  // Permutation p-value: shuffle group labels n_iters times, count how many
  // permutations produced a |diff| >= |obs_diff|. +1 correction so p > 0.
  const pool = arr_a.concat(arr_b);
  const n_a = arr_a.length;
  const n_b = arr_b.length;
  let extreme = 0;
  for (let i = 0; i < n_iters; i++) {
    // Fisher-Yates shuffle
    for (let k = pool.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      const t = pool[k]; pool[k] = pool[j]; pool[j] = t;
    }
    const slice_a = pool.slice(0, n_a);
    const slice_b = pool.slice(n_a, n_a + n_b);
    const d = stat(slice_b) - stat(slice_a);
    if (Math.abs(d) >= abs_obs) extreme++;
  }
  const p_value = (1 + extreme) / (1 + n_iters);

  return {
    ci_low,
    ci_high,
    p_value,
    mean_diff: obs_diff,
    n_a,
    n_b,
    statistic: statName,
    n_iters,
    alpha,
    version: SIGNIFICANCE_VERSION,
  };
}

export default {
  SIGNIFICANCE_VERSION,
  chiSquared,
  bootstrap,
};
