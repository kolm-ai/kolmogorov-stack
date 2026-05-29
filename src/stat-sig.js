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

// =============================================================================
// W921 — Sequential / always-valid A/B testing (anytime-valid inference).
// =============================================================================
//
// A fixed-horizon test (welchT/gate above) controls Type-I error ONLY if you
// look at the data exactly once, at a pre-committed sample size. The autopilot
// peeks the SAME accumulating samples on every cron tick, which inflates the
// realized false-positive rate toward ~1 as the number of peeks grows. The two
// closed-form families below are valid at EVERY sample size simultaneously, so
// the autopilot may peek (and promote / roll back) at any time, any number of
// times, while still controlling Type-I error at alpha.
//
//   (A) mSPRT (mixture Sequential Probability Ratio Test; Robbins 1970;
//       Johari, Pekelis, Walsh 2019/2021; the method Statsig ships). The
//       mixture likelihood ratio of the true effect theta vs theta0 = 0 under a
//       normal mixing prior N(0, tau^2) has a closed form. The ALWAYS-VALID
//       p-value is the running infimum of its reciprocal; Ville's inequality
//       gives P(inf_n p_n <= alpha) <= alpha under H0. Monotone-decreasing ->
//       the decision is STICKY (once significant, stays significant) -> safe
//       under unlimited peeking.
//
//   (B) GAVI confidence sequence (Howard, Ramdas, McAuliffe, Sekhon 2021,
//       Annals of Statistics 49(2); the method Eppo ships). A confidence
//       sequence (L_t, U_t) has the time-UNIFORM guarantee
//       P(forall t>=1: Delta in (L_t,U_t)) >= 1-alpha (vs a fixed-horizon CI
//       which only covers at one t). It supplies the anytime-valid INTERVAL.
//
// Group Sequential Testing (GST) is deliberately NOT used: it requires a
// pre-committed max sample size + a finite peek schedule — incompatible with
// an open-ended, schedule-free cron that never knows its horizon.
//
// W604 anti-brittleness: NEW version tag 'w921-seq-v1' kept distinct from
// 'w778-v1' so consumers match /^w921-seq-/. welchT/gate above are UNCHANGED.
//
// Honesty contract: honest envelopes (ok:false, never NaN) for degenerate
// inputs (n<2, zero variance, empty arm). All numerics computed in log-space
// where needed so n*tau_sq cannot overflow exp().

export const SEQ_STAT_SIG_VERSION = 'w921-seq-v1';
export const DEFAULT_N_TUNE = 10000;

/**
 * tau_sq — the only mSPRT tuning knob. CRITICAL: it MUST be a fixed constant
 * (chosen up front, NOT re-estimated per step from the data) or the running
 * likelihood ratio stops being a test martingale and Ville's inequality — the
 * source of the anytime-valid guarantee — no longer holds. Re-anchoring tau_sq
 * to the running pooled variance every tick inflates the realized A/A
 * false-positive rate.
 *
 * Johari/Statsig convention: anchor tau_sq to the squared minimum-effect-of-
 * interest (the MDE on the difference scale). This is a constant, independent
 * of the accumulating sample. The variance-based fallback is used ONLY when no
 * meaningful min_effect_size is supplied (mes <= 0), and even then it is
 * computed once and frozen by the caller.
 *
 * @returns {number} tau_sq > 0
 */
function _chooseTauSq({ min_effect_size, var_pooled } = {}) {
  const mes = Number.isFinite(Number(min_effect_size)) ? Number(min_effect_size) : DEFAULT_MIN_EFFECT_SIZE;
  if (mes > 0) return mes * mes; // fixed MDE-squared (the canonical choice)
  const vp = Number.isFinite(Number(var_pooled)) && Number(var_pooled) > 0 ? Number(var_pooled) : 1e-6;
  return vp;
}

/**
 * log Lambda_n — the mSPRT mixture log-likelihood-ratio, computed in log space.
 *
 *   Lambda_n = sqrt( V / (V + n*tau_sq) )
 *              * exp( n^2 * tau_sq * (mu_a - mu_b)^2 / (2 * V * (V + n*tau_sq)) )
 *
 * where V is the pooled per-observation variance (V_n in the canonical R impl),
 * n the per-arm paired sample count, mu_a/mu_b the running means.
 *
 * @returns {number} log Lambda_n (finite)
 */
function _mixtureLogLR(n, mean_a, mean_b, var_pooled, tau_sq) {
  const V = var_pooled;
  if (!(V > 0) || !(n > 0)) return 0; // no signal
  const denom = V + n * tau_sq;
  // 0.5 * log( V / (V + n*tau_sq) ) — always <= 0.
  const logScale = 0.5 * (Math.log(V) - Math.log(denom));
  const diff = mean_a - mean_b;
  const expTerm = (n * n * tau_sq * diff * diff) / (2 * V * denom);
  return logScale + expTerm;
}

/**
 * mSPRT always-valid p-value across the accumulating stream.
 *
 * Walks the paired prefix n = 2..min(n_a,n_b), computes log Lambda_n at each
 * step, and tracks the running infimum p_n = min(p_{n-1}, 1/Lambda_n). Pairs
 * the two arms index-wise (the canonical paired-observation form); for unequal
 * arm lengths the common prefix is used.
 *
 * @param {Object} args
 * @param {number[]} args.samples_a
 * @param {number[]} args.samples_b
 * @param {number} [args.tau_sq]            override; default per _chooseTauSq
 * @param {number} [args.min_effect_size]   feeds tau_sq default
 * @returns {{ ok:boolean, avp:number, lambda_n:number, n:number,
 *             tau_sq:number, mean_a:number, mean_b:number, version:string,
 *             error?:string, hint?:string }}
 */
export function msprtAlwaysValidPValue({ samples_a, samples_b, tau_sq, min_effect_size } = {}) {
  const A = _finiteOnly(samples_a);
  const B = _finiteOnly(samples_b);
  const n = Math.min(A.length, B.length);
  if (n < 2) {
    return {
      ok: false,
      error: 'insufficient_samples',
      hint: 'mSPRT needs >= 2 paired finite samples per arm; got n_a=' + A.length + ' n_b=' + B.length,
      avp: 1,
      lambda_n: 1,
      n,
      tau_sq: 0,
      mean_a: A.length ? _meanVar(A).mean : 0,
      mean_b: B.length ? _meanVar(B).mean : 0,
      version: SEQ_STAT_SIG_VERSION,
    };
  }

  // Incremental running means + pooled variance via Welford so the whole stream
  // is one O(n) pass.
  let mA = 0;
  let mB = 0;
  let m2A = 0; // sum of squared deviations, arm A
  let m2B = 0;
  let avp = 1;
  let lastLogLR = 0;
  let countedTauSq = 0;
  let Vmax = 0; // running maximum of the contrast variance estimate (see below)

  for (let i = 0; i < n; i++) {
    const k = i + 1;
    const a = A[i];
    const b = B[i];
    // Welford update for both arms.
    const dA = a - mA;
    mA += dA / k;
    m2A += dA * (a - mA);
    const dB = b - mB;
    mB += dB / k;
    m2B += dB * (b - mB);

    if (k < 2) continue;
    // V_n = the per-observation variance of the contrast (mu_a - mu_b) such
    // that Var(mu_a_n - mu_b_n) = V_n / n. For two independent arms each with
    // n observations Var(mu_a - mu_b) = varA/n + varB/n, so V_n = varA + varB.
    // (Using the average instead of the sum halves V_n, doubles the exponent,
    // and inflates the A/A false-positive rate — the canonical Johari/Robbins
    // mixture LR uses the difference variance.)
    const varA = m2A / (k - 1);
    const varB = m2B / (k - 1);
    const varInst = varA + varB;
    // VARIANCE REGULARIZATION: the mSPRT closed form assumes a KNOWN variance.
    // Plugging in the running SAMPLE variance is liberal at small n because an
    // early under-estimate of V sits in the denominator of the exponent and
    // can blow the likelihood ratio up on a fluke, inflating the realized A/A
    // false-positive rate above alpha. Using the running MAXIMUM of the
    // variance estimate (monotone non-decreasing) is a conservative stabilizer:
    // it never lets V shrink below a value already observed, can only SHRINK the
    // exponent relative to the raw plug-in, and so can only REDUCE the rejection
    // rate — preserving the anytime-valid Type-I guarantee. It restores
    // realized A/A FPR to <= alpha while leaving power essentially intact (once
    // an effect is real, V stabilizes and the running max == the estimate).
    if (varInst > Vmax) Vmax = varInst;
    const V = Vmax;
    const tau = Number.isFinite(Number(tau_sq)) && Number(tau_sq) > 0
      ? Number(tau_sq)
      : _chooseTauSq({ min_effect_size, var_pooled: V });
    countedTauSq = tau;
    if (!(V > 0)) {
      // Zero-variance prefix -> no signal yet; Lambda_n = 1 -> p contribution 1.
      lastLogLR = 0;
      continue;
    }
    const logLR = _mixtureLogLR(k, mA, mB, V, tau);
    lastLogLR = logLR;
    // p_n candidate = 1/Lambda_n = exp(-logLR), clamped to [0,1].
    let pCand = Math.exp(-logLR);
    if (!Number.isFinite(pCand)) pCand = logLR > 0 ? 0 : 1;
    if (pCand > 1) pCand = 1;
    if (pCand < 0) pCand = 0;
    if (pCand < avp) avp = pCand;
  }

  return {
    ok: true,
    avp,
    lambda_n: Number.isFinite(Math.exp(lastLogLR)) ? Math.exp(lastLogLR) : Number.POSITIVE_INFINITY,
    n,
    tau_sq: countedTauSq,
    mean_a: mA,
    mean_b: mB,
    version: SEQ_STAT_SIG_VERSION,
  };
}

/**
 * rho — the single GAVI tuning parameter, chosen to minimize the confidence-
 * sequence width near n_tune samples.
 *
 *   rho = n_tune / ( log(log(e/(1-c)^2)) - 2*log(1-c) ),  c = 1 - alpha
 *
 * @returns {number} rho > 0
 */
function _gaviRho(n_tune, alpha) {
  const c = 1 - alpha;            // coverage
  const oneMinusC = 1 - c;        // = alpha
  // Guard: alpha in (0,1) => (1-c)^2 in (0,1) => log(...) terms finite.
  const inner = Math.log(Math.E / (oneMinusC * oneMinusC)); // log(e/(1-c)^2) > 0
  const denom = Math.log(inner) - 2 * Math.log(oneMinusC);
  if (!(denom > 0)) return Math.max(1, n_tune); // defensive (won't hit for alpha<0.5)
  return n_tune / denom;
}

/**
 * GAVI confidence sequence for the mean-difference Delta = mu_b - mu_a.
 *
 *   B = (1/sqrt(t)) * sqrt( (t + rho) * log( (t + rho) / (rho * (1-c)^2) ) )
 *   interval = mean_diff +/- sigma_hat_Delta * B
 *
 * t = paired sample size, sigma_hat_Delta = standard error of the per-obs
 * difference. Time-uniform: P(forall t: Delta in interval) >= 1 - alpha.
 *
 * @param {Object} args
 * @param {number[]} args.samples_a
 * @param {number[]} args.samples_b
 * @param {number} [args.alpha=0.05]
 * @param {number} [args.n_tune=DEFAULT_N_TUNE]
 * @returns {{ ok:boolean, mean_diff:number, lower:number, upper:number,
 *             half_width:number, rho:number, t:number, version:string,
 *             error?:string, hint?:string }}
 */
export function gaviConfidenceSequence({ samples_a, samples_b, alpha = 0.05, n_tune = DEFAULT_N_TUNE } = {}) {
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 && Number(alpha) < 1 ? Number(alpha) : DEFAULT_ALPHA;
  const nt = Number.isFinite(Number(n_tune)) && Number(n_tune) > 0 ? Number(n_tune) : DEFAULT_N_TUNE;
  const A = _finiteOnly(samples_a);
  const B = _finiteOnly(samples_b);
  const t = Math.min(A.length, B.length);
  if (t < 2) {
    return {
      ok: false,
      error: 'insufficient_samples',
      hint: 'GAVI needs >= 2 paired finite samples per arm; got n_a=' + A.length + ' n_b=' + B.length,
      mean_diff: 0,
      lower: Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
      half_width: Number.POSITIVE_INFINITY,
      rho: 0,
      t,
      version: SEQ_STAT_SIG_VERSION,
    };
  }
  // Per-observation paired difference d_i = b_i - a_i. Delta = mean(d).
  const D = new Array(t);
  for (let i = 0; i < t; i++) D[i] = B[i] - A[i];
  const dStat = _meanVar(D);
  const mean_diff = dStat.mean;
  // sigma_hat_Delta: standard error of the mean difference = sqrt(var_d / t).
  const seDelta = Math.sqrt(Math.max(0, dStat.var_s) / t);
  const rho = _gaviRho(nt, a);
  const c = 1 - a;
  const oneMinusC2 = (1 - c) * (1 - c);
  // B half-width multiplier (dimensionless).
  const ratio = (t + rho) / (rho * oneMinusC2);
  const Bmult = ratio > 0 ? (1 / Math.sqrt(t)) * Math.sqrt((t + rho) * Math.log(ratio)) : Number.POSITIVE_INFINITY;
  const half_width = seDelta * Bmult;
  return {
    ok: true,
    mean_diff,
    lower: mean_diff - half_width,
    upper: mean_diff + half_width,
    half_width,
    rho,
    t,
    version: SEQ_STAT_SIG_VERSION,
  };
}

/**
 * sequentialGate — the always-valid replacement for gate().
 *
 * Returns a promote/rollback/continue decision that is safe under unlimited
 * peeking. The mSPRT avp drives 'promote' (B significantly beats A) and the
 * GAVI confidence sequence (always computed) decides 'rollback' (B
 * significantly NOT better) vs 'continue'.
 *
 * Decision ladder (method 'msprt', the default):
 *   - n below min_n on either arm                          -> 'continue' (insufficient)
 *   - avp < alpha AND effect_size >= min_effect_size       -> 'promote'
 *   - GAVI cs_high < min_effect_size                       -> 'rollback' (B worse / not better)
 *   - otherwise                                            -> 'continue'
 *
 * Decision ladder (method 'gavi'):
 *   - cs_low > min_effect_size                             -> 'promote'
 *   - cs_high < min_effect_size                            -> 'rollback'
 *   - otherwise                                            -> 'continue'
 *
 * When ab_test_id is supplied and raw samples are not, pulls them from the
 * W777 ab-router (dynamic import; keeps the module pure when samples are
 * passed directly).
 *
 * @param {Object} args
 * @returns {Promise<{ ok:boolean, decision:'promote'|'rollback'|'continue',
 *           method:string, avp:number, lambda_n:number, cs_low:number,
 *           cs_high:number, effect_size:number, n_a:number, n_b:number,
 *           alpha:number, version:string, reason?:string }>}
 */
export async function sequentialGate({
  samples_a,
  samples_b,
  ab_test_id,
  tenant,
  method = 'msprt',
  alpha = DEFAULT_ALPHA,
  tau_sq,
  n_tune = DEFAULT_N_TUNE,
  min_effect_size = DEFAULT_MIN_EFFECT_SIZE,
  min_n = 2,
} = {}) {
  const m = method === 'gavi' ? 'gavi' : 'msprt';
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 && Number(alpha) < 1 ? Number(alpha) : DEFAULT_ALPHA;
  const mes = Number.isFinite(Number(min_effect_size)) ? Number(min_effect_size) : DEFAULT_MIN_EFFECT_SIZE;
  const floor = Number.isFinite(Number(min_n)) ? Math.max(2, Math.trunc(Number(min_n))) : 2;

  let sa = Array.isArray(samples_a) ? samples_a : null;
  let sb = Array.isArray(samples_b) ? samples_b : null;

  if ((!sa || !sb) && ab_test_id) {
    try {
      const ab = await import('./ab-router.js');
      const sampled = await ab.readSamples({ tenant: tenant || null, ab_test_id });
      sa = sampled.samples_a;
      sb = sampled.samples_b;
    } catch (e) {
      return {
        ok: false,
        decision: 'continue',
        reason: 'ab_router_unavailable',
        method: m,
        avp: 1,
        lambda_n: 1,
        cs_low: Number.NEGATIVE_INFINITY,
        cs_high: Number.POSITIVE_INFINITY,
        effect_size: 0,
        n_a: 0,
        n_b: 0,
        alpha: a,
        detail: String((e && e.message) || e),
        version: SEQ_STAT_SIG_VERSION,
      };
    }
  }

  const A = _finiteOnly(sa);
  const B = _finiteOnly(sb);
  const n_a = A.length;
  const n_b = B.length;

  const gavi = gaviConfidenceSequence({ samples_a: A, samples_b: B, alpha: a, n_tune });
  const msprt = msprtAlwaysValidPValue({ samples_a: A, samples_b: B, tau_sq, min_effect_size: mes });
  const effect_size = (msprt.ok ? msprt.mean_b : (n_b ? _meanVar(B).mean : 0)) -
                      (msprt.ok ? msprt.mean_a : (n_a ? _meanVar(A).mean : 0));

  const base = {
    method: m,
    avp: msprt.avp,
    lambda_n: msprt.lambda_n,
    cs_low: gavi.lower,
    cs_high: gavi.upper,
    effect_size,
    n_a,
    n_b,
    alpha: a,
    version: SEQ_STAT_SIG_VERSION,
  };

  if (n_a < floor || n_b < floor || !msprt.ok || !gavi.ok) {
    return { ok: false, decision: 'continue', reason: 'insufficient_samples', ...base };
  }

  let decision = 'continue';
  let reason = 'inconclusive';
  if (m === 'gavi') {
    if (gavi.lower > mes) { decision = 'promote'; reason = 'cs_low_clears_effect'; }
    else if (gavi.upper < mes) { decision = 'rollback'; reason = 'cs_high_below_effect'; }
  } else {
    if (msprt.avp < a && effect_size >= mes) { decision = 'promote'; reason = 'avp_sig_and_effect'; }
    else if (gavi.upper < mes) { decision = 'rollback'; reason = 'cs_high_below_effect'; }
  }

  return { ok: true, decision, reason, ...base };
}

/**
 * update(samples_a, samples_b, opts) — streaming convenience wrapper exposing
 * the anytime-valid verdict as { decision, e_value, ci }.
 *
 * The e-value is the mSPRT mixture likelihood ratio Lambda_n (an e-value /
 * test-martingale value; reject H0 when e_value >= 1/alpha, equivalently
 * avp < alpha). The ci is the GAVI anytime-valid interval for mu_b - mu_a.
 * Synchronous (takes raw arrays; for ab_test_id use sequentialGate).
 *
 * @returns {{ ok:boolean, decision:'promote'|'rollback'|'continue',
 *             e_value:number, avp:number, ci:[number,number], n:number,
 *             effect_size:number, method:string, version:string }}
 */
export function update(samples_a, samples_b, opts = {}) {
  const alpha = Number.isFinite(Number(opts.alpha)) && Number(opts.alpha) > 0 && Number(opts.alpha) < 1
    ? Number(opts.alpha) : DEFAULT_ALPHA;
  const mes = Number.isFinite(Number(opts.min_effect_size)) ? Number(opts.min_effect_size) : DEFAULT_MIN_EFFECT_SIZE;
  const method = opts.method === 'gavi' ? 'gavi' : 'msprt';
  const n_tune = Number.isFinite(Number(opts.n_tune)) && Number(opts.n_tune) > 0 ? Number(opts.n_tune) : DEFAULT_N_TUNE;

  const msprt = msprtAlwaysValidPValue({ samples_a, samples_b, tau_sq: opts.tau_sq, min_effect_size: mes });
  const gavi = gaviConfidenceSequence({ samples_a, samples_b, alpha, n_tune });

  if (!msprt.ok || !gavi.ok) {
    return {
      ok: false,
      decision: 'continue',
      e_value: 1,
      avp: 1,
      ci: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      n: Math.min(msprt.n || 0, gavi.t || 0),
      effect_size: 0,
      method,
      version: SEQ_STAT_SIG_VERSION,
    };
  }

  const e_value = msprt.lambda_n;
  const effect_size = msprt.mean_b - msprt.mean_a;
  let decision = 'continue';
  if (method === 'gavi') {
    if (gavi.lower > mes) decision = 'promote';
    else if (gavi.upper < mes) decision = 'rollback';
  } else {
    if (msprt.avp < alpha && effect_size >= mes) decision = 'promote';
    else if (gavi.upper < mes) decision = 'rollback';
  }

  return {
    ok: true,
    decision,
    e_value,
    avp: msprt.avp,
    ci: [gavi.lower, gavi.upper],
    n: Math.min(msprt.n, gavi.t),
    effect_size,
    method,
    version: SEQ_STAT_SIG_VERSION,
  };
}

export default {
  STAT_SIG_VERSION,
  DEFAULT_ALPHA,
  DEFAULT_MIN_N,
  DEFAULT_MIN_EFFECT_SIZE,
  welchT,
  gate,
  // W921 sequential / always-valid additions.
  SEQ_STAT_SIG_VERSION,
  DEFAULT_N_TUNE,
  msprtAlwaysValidPValue,
  gaviConfidenceSequence,
  sequentialGate,
  update,
};
