// src/stat-sig.js
//
// W778 — Statistical significance testing + auto-rollback gate.
//
// Companion of W777 (A/B router): W777 splits traffic + records outcomes,
// W778 decides "did the new arm actually win?". The gate combines three
// conditions before promoting:
//
//   1. Both arms have at least `min_n` samples (sample-size floor).
//   2. The Welch's t-test p-value across the two kscore distributions is
//      below `alpha` (default 0.05).
//   3. The arm-B mean beats arm-A by at least `min_effect_size` in absolute
//      kscore (default 0.01 — never promote a hairline win).
//
// Welch's t-test (not Student's) because the two arms are independent samples
// with unequal variances by default. Welch-Satterthwaite degrees of freedom
// keep the test honest when sample sizes differ.
//
// W604 anti-brittleness:
//   - STAT_SIG_VERSION = 'w778-vN' — consumers MUST match /^w778-/ NOT literal
//     equality so a v1.x bump within the same wave doesn't break callers.
//   - Threshold knobs (alpha, min_n, min_effect_size) are exported defaults
//     so the route + CLI + dashboard share one truth, and so a future test
//     can tune without forking the module.
//
// Honesty contract:
//   - Empty / single-sample arms -> honest envelope
//     { ok:false, error:'insufficient_samples', ... } never NaN.
//   - Zero-variance arms (e.g. every kscore = 1.0) -> we still emit a finite
//     test statistic with p set to 1.0 (no signal) so the gate degrades to
//     'insufficient' instead of pretending a winner.
//
// Pure functions: no I/O. The W777 ab-router pulls samples out of the
// event-store and feeds them in; the gate() helper below takes a tenant +
// ab_test_id and delegates the I/O to W777 via dynamic import so this module
// remains pure-math and unit-testable in isolation.

export const STAT_SIG_VERSION = 'w778-v1';
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_MIN_N = 30;
export const DEFAULT_MIN_EFFECT_SIZE = 0.01;

// =============================================================================
// Pure-math primitives.
// =============================================================================

function _finiteOnly(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    const n = Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function _meanVar(arr) {
  const n = arr.length;
  if (n === 0) return { mean: 0, var_s: 0, n: 0 };
  let mean = 0;
  for (const v of arr) mean += v;
  mean /= n;
  if (n === 1) return { mean, var_s: 0, n: 1 };
  let sumSq = 0;
  for (const v of arr) sumSq += (v - mean) * (v - mean);
  // Sample variance (n-1 denominator). Welch's t-test uses sample variance.
  const var_s = sumSq / (n - 1);
  return { mean, var_s, n };
}

// =============================================================================
// Welch's t-test + p-value approximation.
// =============================================================================
//
// Returns { t, df, p, mean_a, mean_b, var_a, var_b, n_a, n_b, ci_low, ci_high }.
// For empty / single-sample inputs, returns an honest envelope with t=0 + p=1
// + ok:false on the wrapping object.
//
// p-value uses Hill's series approximation to the two-tailed Student's-t CDF.
// Accurate to ~1e-3 across the range we care about (alpha in [0.001, 0.5]).

function _tDistTail2(t, df) {
  // Two-tailed tail probability for Student's t. Hill (1970) approximation.
  // For df >= 1. Returns a number in [0, 1].
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = Math.abs(t);
  if (x === 0) return 1;
  // Convert t to one-tail upper, then double.
  // Use the regularized incomplete beta function:
  //   1 - I_{df/(df+t^2)}(df/2, 1/2) = upper-tail probability
  // We implement I_x(a, b) via the continued-fraction expansion (Abramowitz).
  const a = df / 2;
  const b = 0.5;
  const xb = df / (df + x * x);
  const ib = _regIncompleteBeta(xb, a, b);
  // upper tail one-sided = 0.5 * I_xb(a, b) for the t distribution.
  const oneTail = 0.5 * ib;
  let two = 2 * oneTail;
  if (!Number.isFinite(two)) two = 1;
  if (two < 0) two = 0;
  if (two > 1) two = 1;
  return two;
}

function _logGamma(z) {
  // Lanczos approximation, good to ~1e-12 for z > 0.
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _logGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function _regIncompleteBeta(x, a, b) {
  // Regularized incomplete beta function I_x(a, b). Used by t-distribution CDF.
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Logarithm of the prefactor.
  const lbeta = _logGamma(a) + _logGamma(b) - _logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  // Lentz's continued-fraction algorithm. 200 iters is overkill for our
  // df range (n_a + n_b - 2 typically << 1000); the loop bails on convergence.
  const eps = 1e-12;
  let f = 1.0;
  let c2 = 1.0;
  let d = 0.0;
  for (let m = 0; m < 200; m++) {
    const m2 = 2 * m;
    let aa;
    if (m === 0) {
      aa = 1;
    } else {
      aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    }
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c2 = 1 + aa / c2;
    if (Math.abs(c2) < 1e-30) c2 = 1e-30;
    d = 1 / d;
    f *= d * c2;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c2 = 1 + aa / c2;
    if (Math.abs(c2) < 1e-30) c2 = 1e-30;
    d = 1 / d;
    const del = d * c2;
    f *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return front * (f - 1);
}

/**
 * Welch's t-test on two independent samples.
 *
 * @param {Object} args
 * @param {number[]} args.samples_a
 * @param {number[]} args.samples_b
 * @returns {{
 *   ok: boolean,
 *   t: number,
 *   df: number,
 *   p: number,
 *   mean_a: number, mean_b: number,
 *   var_a: number, var_b: number,
 *   n_a: number, n_b: number,
 *   ci_low: number, ci_high: number,
 *   error?: string, hint?: string,
 *   version: string
 * }}
 */
export function welchT({ samples_a, samples_b } = {}) {
  const A = _finiteOnly(samples_a);
  const B = _finiteOnly(samples_b);
  if (A.length < 2 || B.length < 2) {
    return {
      ok: false,
      error: 'insufficient_samples',
      hint: 'each arm needs >= 2 finite samples for a meaningful Welch t-test; got n_a=' + A.length + ' n_b=' + B.length,
      n_a: A.length,
      n_b: B.length,
      t: 0,
      df: 0,
      p: 1,
      mean_a: A.length ? _meanVar(A).mean : 0,
      mean_b: B.length ? _meanVar(B).mean : 0,
      var_a: 0,
      var_b: 0,
      ci_low: 0,
      ci_high: 0,
      version: STAT_SIG_VERSION,
    };
  }
  const a = _meanVar(A);
  const b = _meanVar(B);
  const seSq = a.var_s / a.n + b.var_s / b.n;
  let t = 0;
  let df = 1;
  let p = 1;
  if (seSq <= 0) {
    // Both arms zero-variance. Honest envelope: no signal.
    t = 0;
    df = a.n + b.n - 2;
    p = 1;
  } else {
    const se = Math.sqrt(seSq);
    t = (b.mean - a.mean) / se;
    // Welch-Satterthwaite df.
    const num = seSq * seSq;
    const den = (a.var_s * a.var_s) / (a.n * a.n * (a.n - 1)) +
                (b.var_s * b.var_s) / (b.n * b.n * (b.n - 1));
    df = den > 0 ? num / den : (a.n + b.n - 2);
    p = _tDistTail2(t, df);
  }
  // 95% CI on the difference of means (b - a), Welch-style.
  const diff = b.mean - a.mean;
  const se = Math.sqrt(Math.max(0, seSq));
  // For a 95% CI we want the t-quantile at df. We don't ship a Quantile
  // function; for df >= 30 the normal approx 1.96 is < 0.5% off and for
  // df < 30 the difference matters less to the gate (which uses p not CI).
  // The CI is informational; the decision uses p directly.
  const tq = df >= 30 ? 1.96 : 2.045;
  const ci_low = diff - tq * se;
  const ci_high = diff + tq * se;
  return {
    ok: true,
    t,
    df,
    p,
    mean_a: a.mean,
    mean_b: b.mean,
    var_a: a.var_s,
    var_b: b.var_s,
    n_a: a.n,
    n_b: b.n,
    ci_low,
    ci_high,
    version: STAT_SIG_VERSION,
  };
}

// =============================================================================
// Gate -- combined sample-size + significance + effect-size check.
// =============================================================================
//
// Returns:
//   { ok:true,  decision:'pass',         ... } promote arm B
//   { ok:true,  decision:'fail',         ... } don't promote (no signal)
//   { ok:false, decision:'insufficient', ... } need more data
//
// `ab_test_id` is optional. When supplied, the gate reads samples from the
// W777 ab-router (via dynamic import to keep this module pure when callers
// pass raw samples directly).

/**
 * @param {Object} args
 * @param {string} [args.ab_test_id]
 * @param {string} [args.tenant]
 * @param {number[]} [args.samples_a]
 * @param {number[]} [args.samples_b]
 * @param {number} [args.alpha]            default 0.05
 * @param {number} [args.min_n]            default 30
 * @param {number} [args.min_effect_size]  default 0.01
 */
export async function gate(args = {}) {
  const alpha = Number.isFinite(Number(args.alpha)) ? Number(args.alpha) : DEFAULT_ALPHA;
  const min_n = Number.isFinite(Number(args.min_n)) ? Math.max(2, Math.trunc(Number(args.min_n))) : DEFAULT_MIN_N;
  const min_effect_size = Number.isFinite(Number(args.min_effect_size)) ? Number(args.min_effect_size) : DEFAULT_MIN_EFFECT_SIZE;

  let samples_a = Array.isArray(args.samples_a) ? args.samples_a : null;
  let samples_b = Array.isArray(args.samples_b) ? args.samples_b : null;

  // If raw samples weren't passed, pull them from the W777 ab-router.
  if ((!samples_a || !samples_b) && args.ab_test_id) {
    try {
      const ab = await import('./ab-router.js');
      const sampled = await ab.readSamples({
        tenant: args.tenant || null,
        ab_test_id: args.ab_test_id,
      });
      samples_a = sampled.samples_a;
      samples_b = sampled.samples_b;
    } catch (e) {
      return {
        ok: false,
        decision: 'insufficient',
        error: 'ab_router_unavailable',
        hint: 'gate({ab_test_id}) needs src/ab-router.js to be importable',
        detail: String(e && e.message || e),
        version: STAT_SIG_VERSION,
      };
    }
  }

  const A = _finiteOnly(samples_a);
  const B = _finiteOnly(samples_b);

  // Sample-size floor.
  if (A.length < min_n || B.length < min_n) {
    return {
      ok: false,
      decision: 'insufficient',
      reason: 'sample_size_below_min',
      n_a: A.length,
      n_b: B.length,
      min_n,
      p: null,
      effect_size: null,
      hint: 'each arm needs >= ' + min_n + ' samples before the gate has signal; got n_a=' + A.length + ' n_b=' + B.length,
      version: STAT_SIG_VERSION,
    };
  }

  const t = welchT({ samples_a: A, samples_b: B });
  // welchT only fails on n<2; we already enforced min_n>=2 above so this
  // branch is defensive.
  if (!t.ok) {
    return {
      ok: false,
      decision: 'insufficient',
      reason: t.error || 'welch_t_failed',
      n_a: t.n_a,
      n_b: t.n_b,
      p: null,
      effect_size: null,
      hint: t.hint || 'welch_t internal failure',
      version: STAT_SIG_VERSION,
    };
  }
  const effect_size = t.mean_b - t.mean_a;
  if (Math.abs(effect_size) < min_effect_size) {
    return {
      ok: true,
      decision: 'insufficient',
      reason: 'effect_size_below_min',
      n_a: t.n_a,
      n_b: t.n_b,
      p: t.p,
      effect_size,
      mean_a: t.mean_a,
      mean_b: t.mean_b,
      min_effect_size,
      hint: '|mean_b - mean_a| < ' + min_effect_size + '; got ' + effect_size,
      version: STAT_SIG_VERSION,
    };
  }
  // Pass: arm B beats arm A by min_effect_size, with p < alpha, AND
  // effect_size positive (B > A).
  if (t.p < alpha && effect_size > 0) {
    return {
      ok: true,
      decision: 'pass',
      reason: 'sig_and_effect',
      n_a: t.n_a,
      n_b: t.n_b,
      p: t.p,
      effect_size,
      mean_a: t.mean_a,
      mean_b: t.mean_b,
      ci_low: t.ci_low,
      ci_high: t.ci_high,
      alpha,
      version: STAT_SIG_VERSION,
    };
  }
  // Otherwise fail (no significant winner OR arm B is worse).
  return {
    ok: true,
    decision: 'fail',
    reason: t.p >= alpha ? 'p_above_alpha' : 'arm_b_underperforms',
    n_a: t.n_a,
    n_b: t.n_b,
    p: t.p,
    effect_size,
    mean_a: t.mean_a,
    mean_b: t.mean_b,
    alpha,
    version: STAT_SIG_VERSION,
  };
}

export default {
  STAT_SIG_VERSION,
  DEFAULT_ALPHA,
  DEFAULT_MIN_N,
  DEFAULT_MIN_EFFECT_SIZE,
  welchT,
  gate,
};
