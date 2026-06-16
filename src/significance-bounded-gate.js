// src/significance-bounded-gate.js
//
// FINALIZED-C6 - Significance-bounded, multiplicity-controlled promotion gate.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The shipping promotion gate (src/compile-eval-gate.js evaluateAndGate) decides
// promote/block from a POINT K-Score delta: candidate.composite - baseline.composite
// must exceed `min_kscore_delta`. That is fragile in two ways the literature is
// unambiguous about:
//
//   (1) NO UNCERTAINTY. A 0.021 point delta over a 0.02 threshold "passes" even
//       when the per-case scores are so noisy the true delta could be negative.
//       The gate must promote on a STATISTICALLY-BOUNDED win - the lower bound of
//       a paired confidence interval on the per-case delta must itself clear the
//       threshold - not on a point estimate that happens to land above the line.
//
//   (2) MULTIPLICITY / PEEKING. A real eval reports a composite delta PLUS a
//       per-axis delta for every K-Score axis PLUS per-subgroup deltas PLUS a
//       pass/fail per regression class. Testing that whole FAMILY at a flat
//       alpha, and re-testing it on every self-improvement tick, inflates the
//       aggregate false-promotion rate toward 1. We must (a) control the
//       family-wise / false-discovery rate across the joint family at a declared
//       alpha (Benjamini-Hochberg FDR or Holm FWER), and (b) use ALWAYS-VALID
//       (anytime) p-values so repeated peeking at an accumulating eval stream
//       does not blow the Type-I budget.
//
// This module is the statistics engine for both. It is PURE (no I/O, no network),
// deterministic given a seed, and reuses the codebase's existing, audited
// primitives rather than reimplementing them:
//
//   - src/stat-sig.js  msprtAlwaysValidPValue / gaviConfidenceSequence
//        the W921 anytime-valid (mSPRT + GAVI confidence-sequence) families.
//        We feed them the per-case PAIRED score vectors so the always-valid
//        p-value is computed on the vectors, not on a point composite.
//   - src/compile-eval-gate.js  embedEvalSummaryReceipt / verifyEvalSummaryReceipt
//        the Ed25519-signed binding. We bind the FAMILY, alpha, correction method
//        and the corrected p-values into the signed eval_summary so the
//        significance basis of the decision is tamper-evident.
//
// FAIL-CLOSED CONTRACT (load-bearing, never weaken)
// -------------------------------------------------
//   - Insufficient paired samples  -> ABSTAIN (decision:'abstain'), never promote.
//   - Composite CI straddles the threshold (lower bound below min_kscore_delta)
//        -> ABSTAIN, never promote.
//   - Any regression-class member that is corrected-significant for a DROP
//        -> BLOCK, never promote.
//   - A degenerate / empty family -> ABSTAIN.
//   Promotion requires a POSITIVE proof: composite lower-CI clears the threshold
//   AND the composite is corrected-significant AND no regression fires. Anything
//   short of that proof is abstain/block. We never promote on the absence of a
//   blocking signal.
//
// W604 anti-brittleness: SIG_BOUNDED_GATE_VERSION = 'fc6-v1'; consumers MUST match
// /^fc6-/ NOT literal equality.

import {
  msprtAlwaysValidPValue,
} from './stat-sig.js';

export const SIG_BOUNDED_GATE_VERSION = 'fc6-v1';

// Declared defaults. alpha is the aggregate false-promotion budget across the
// WHOLE family (FDR level for BH, FWER level for Holm). min_kscore_delta mirrors
// compile-eval-gate's 0.02 so the two decision paths agree on the effect floor.
export const DEFAULT_GATE = Object.freeze({
  alpha: 0.05,
  min_kscore_delta: 0.02,
  bootstrap_iters: 2000,
  bootstrap_method: 'bca',   // 'bca' (bias-corrected accelerated) | 'percentile'
  correction: 'bh',          // 'bh' (Benjamini-Hochberg FDR) | 'holm' (FWER)
  ci_level: 0.95,            // 1 - 2*tail for the two-sided CI used to READ bounds
  min_samples: 12,           // paired-case floor below which we ABSTAIN
  regression_min_drop: 0.01,    // magnitude floor: a regression must drop the
                                // per-case pass-rate by MORE than this (and the
                                // CI must confirm it) before it can block. A
                                // sub-1% wobble is noise, not a regression.
  regression_prior_scale: 0.05, // the mSPRT mixing-prior scale (tau) for a
                                // regression member. This is the SCALE of the
                                // effects the always-valid test is tuned to
                                // detect - a DISTINCT statistical role from the
                                // magnitude floor above. Anchoring tau to the
                                // tiny floor (0.01) makes the mixture prior far
                                // too tight and leaves the test underpowered on
                                // binary pass/fail vectors; 0.05 ("a meaningful
                                // pass-rate move") restores power while staying a
                                // fixed constant (Type-I guarantee preserved).
  seed: 0,                    // deterministic default seed; callers override
});

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function _isObj(v) { return v !== null && typeof v === 'object'; }
function _finite(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) { const n = Number(v); if (Number.isFinite(n)) out.push(n); }
  return out;
}

// ===========================================================================
// Deterministic RNG (splitmix32) - matches src/significance.js so seeded runs
// are reproducible without a `seedrandom` dependency.
// ===========================================================================
function _rngFromSeed(seed) {
  let s = (Number.isFinite(Number(seed)) ? Number(seed) : 0) | 0;
  if (s === 0) s = 0x9e3779b9; // avoid the all-zero fixed point
  return function rng() {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) | 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) | 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 0x100000000;
  };
}

function _mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0; for (const v of arr) s += v; return s / arr.length;
}

// Standard normal CDF + inverse (Acklam) for the BCa endpoints. Self-contained
// so this module does not reach into significance.js internals.
function _phi(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  if (z > 8) return 1;
  if (z < -8) return 0;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const p = 0.2316419;
  const t = 1 / (1 + p * x);
  const pdf = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const poly = ((((1.330274429 * t - 1.821255978) * t + 1.781477937) * t - 0.356563782) * t + 0.319381530) * t;
  const cdf = 1 - pdf * poly;
  return sign === 1 ? cdf : (1 - cdf);
}
function _phiInv(p) {
  // Acklam's rational approximation to the inverse normal CDF.
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function _quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[n - 1];
  // Linear interpolation between order statistics.
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const frac = h - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ===========================================================================
// pairedBootstrapCI - bootstrap a CI on the MEAN of a per-case PAIRED delta
// vector d_i = score_candidate(case_i) - score_baseline(case_i).
// ===========================================================================
//
// Resampling cases WITH the pairing intact (one resample index drives both
// arms) removes the between-case variance that an UNPAIRED two-sample bootstrap
// (src/significance.js bootstrap) leaves in - the correct estimator when the
// same eval cases were scored under both artifacts.
//
// method 'bca' = bias-corrected & accelerated (Efron) percentile endpoints:
//   z0  = Phi^-1( frac of bootstrap means < observed mean )   (bias correction)
//   a   = jackknife acceleration (skewness of the leave-one-out means)
//   adjusted lower quantile = Phi( z0 + (z0 + z_lo)/(1 - a (z0 + z_lo)) )
// BCa is second-order accurate and corrects the percentile interval's known
// under-coverage on skewed deltas. Falls back to plain percentile when the
// acceleration is undefined (zero jackknife variance).
//
// Returns { ok, ci_low, ci_high, point, n, method, alpha, ci_level, version }.
// ok:false (insufficient_samples) when fewer than `min_samples` paired cases.
export function pairedBootstrapCI({
  delta_per_case,
  candidate_per_case,
  baseline_per_case,
  alpha,                 // two-sided tail budget; ci_level = 1 - alpha
  ci_level,
  n_iters,
  method,
  seed,
  min_samples,
} = {}) {
  // Accept either a precomputed delta vector OR the two paired arms.
  let D = _finite(delta_per_case);
  if (D.length === 0 && Array.isArray(candidate_per_case) && Array.isArray(baseline_per_case)) {
    const C = candidate_per_case;
    const B = baseline_per_case;
    const m = Math.min(C.length, B.length);
    for (let i = 0; i < m; i++) {
      const c = Number(C[i]);
      const b = Number(B[i]);
      if (Number.isFinite(c) && Number.isFinite(b)) D.push(c - b);
    }
  }
  const lvl = _num(ci_level) != null ? Number(ci_level)
    : (_num(alpha) != null ? 1 - Number(alpha) : DEFAULT_GATE.ci_level);
  const tail = (1 - lvl) / 2;                  // each side
  const iters = Math.max(200, Math.min(200000, Math.trunc(_num(n_iters) || DEFAULT_GATE.bootstrap_iters)));
  const meth = method === 'percentile' ? 'percentile' : 'bca';
  const minN = Math.max(2, Math.trunc(_num(min_samples) ?? DEFAULT_GATE.min_samples));

  if (D.length < minN) {
    return {
      ok: false,
      error: 'insufficient_samples',
      hint: 'paired bootstrap needs >= ' + minN + ' paired finite cases; got ' + D.length,
      ci_low: null, ci_high: null, point: D.length ? _mean(D) : null,
      n: D.length, method: meth, ci_level: lvl, version: SIG_BOUNDED_GATE_VERSION,
    };
  }

  const n = D.length;
  const point = _mean(D);
  const rng = _rngFromSeed(seed);

  // Bootstrap distribution of the mean (paired resample = resample case indices).
  const means = new Array(iters);
  let belowPoint = 0;
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += D[(rng() * n) | 0];
    const mb = s / n;
    means[b] = mb;
    if (mb < point) belowPoint++;
  }
  means.sort((x, y) => x - y);

  if (meth === 'percentile') {
    return {
      ok: true,
      ci_low: _quantileSorted(means, tail),
      ci_high: _quantileSorted(means, 1 - tail),
      point, n, method: 'percentile', ci_level: lvl, n_iters: iters,
      version: SIG_BOUNDED_GATE_VERSION,
    };
  }

  // --- BCa endpoints ---
  // z0: bias correction from the fraction of bootstrap means below the observed.
  let prop = belowPoint / iters;
  if (prop <= 0) prop = 1 / (2 * iters);
  if (prop >= 1) prop = 1 - 1 / (2 * iters);
  const z0 = _phiInv(prop);

  // a: jackknife acceleration from the leave-one-out means.
  const total = point * n;
  let jkMean = 0;
  const jk = new Array(n);
  for (let i = 0; i < n; i++) { jk[i] = (total - D[i]) / (n - 1); jkMean += jk[i]; }
  jkMean /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const diff = jkMean - jk[i];
    num += diff * diff * diff;
    den += diff * diff;
  }
  let a = 0;
  if (den > 0) a = num / (6 * Math.pow(den, 1.5));
  if (!Number.isFinite(a)) a = 0;

  const zLo = _phiInv(tail);
  const zHi = _phiInv(1 - tail);
  const adj = (z) => {
    const denom = 1 - a * (z0 + z);
    if (!(Math.abs(denom) > 1e-12)) return _phi(z0 + z); // acceleration degenerate
    return _phi(z0 + (z0 + z) / denom);
  };
  let qLo = adj(zLo);
  let qHi = adj(zHi);
  // Guard against pathological adjusted quantiles (e.g. a*z0 near 1).
  if (!(qLo >= 0 && qLo <= 1) || !(qHi >= 0 && qHi <= 1) || qLo > qHi) {
    qLo = tail; qHi = 1 - tail; // fall back to percentile endpoints, fail-closed
  }

  return {
    ok: true,
    ci_low: _quantileSorted(means, qLo),
    ci_high: _quantileSorted(means, qHi),
    point, n, method: 'bca', ci_level: lvl, n_iters: iters,
    z0, acceleration: a, q_low: qLo, q_high: qHi,
    version: SIG_BOUNDED_GATE_VERSION,
  };
}

// ===========================================================================
// Multiplicity control.
// ===========================================================================
//
// Both take an array of { id, p } (or raw p's) and a level. Both return
//   { rejected: Set<index>, adjusted: number[], level, method, version }
// where `adjusted[i]` is the multiplicity-adjusted p-value bound for member i
// and `rejected` is the index set declared significant at the family level.

// Benjamini-Hochberg step-up FDR. Controls the expected proportion of false
// discoveries among the rejected at level q. Less conservative than Holm; the
// right default when the family is large and we can tolerate a bounded FDR.
export function benjaminiHochberg(pvalues, level = DEFAULT_GATE.alpha) {
  const ps = pvalues.map((p, i) => ({ p: _clampP(p), i }));
  const m = ps.length;
  const out = { rejected: new Set(), adjusted: new Array(m).fill(1), level, method: 'bh', m, version: SIG_BOUNDED_GATE_VERSION };
  if (m === 0) return out;
  ps.sort((x, y) => x.p - y.p);
  // adjusted (BH q-value): q_(k) = min over j>=rank of ( m * p_(j) / j ), monotone.
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    const rank = k + 1;
    const q = Math.min(1, (m * ps[k].p) / rank);
    running = Math.min(running, q);
    out.adjusted[ps[k].i] = running;
  }
  // largest k with p_(k) <= (k/m) * level; reject all ranks <= that k.
  let kMax = -1;
  for (let k = 0; k < m; k++) {
    if (ps[k].p <= ((k + 1) / m) * level) kMax = k;
  }
  for (let k = 0; k <= kMax; k++) out.rejected.add(ps[k].i);
  return out;
}

// Holm step-down FWER. Controls the probability of even ONE false discovery at
// level alpha. Strict; the right default for regression-class members where a
// single false "no regression" is unacceptable.
export function holm(pvalues, level = DEFAULT_GATE.alpha) {
  const ps = pvalues.map((p, i) => ({ p: _clampP(p), i }));
  const m = ps.length;
  const out = { rejected: new Set(), adjusted: new Array(m).fill(1), level, method: 'holm', m, version: SIG_BOUNDED_GATE_VERSION };
  if (m === 0) return out;
  ps.sort((x, y) => x.p - y.p);
  let running = 0;
  let stillRejecting = true;
  for (let k = 0; k < m; k++) {
    const factor = m - k;                  // (m - k) for the k-th smallest (0-based)
    const adj = Math.min(1, factor * ps[k].p);
    running = Math.max(running, adj);      // enforce monotone non-decreasing
    out.adjusted[ps[k].i] = running;
    if (stillRejecting && ps[k].p <= level / factor) {
      out.rejected.add(ps[k].i);
    } else {
      stillRejecting = false;              // step-down stops at first non-reject
    }
  }
  return out;
}

function _clampP(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function correctFamily(pvalues, level, method) {
  return (method === 'holm' ? holm : benjaminiHochberg)(pvalues, level);
}

// ===========================================================================
// buildTestFamily - assemble the joint family of hypotheses from an eval that
// carries PER-CASE score vectors.
// ===========================================================================
//
// Each artifact reference may carry a `per_case` block:
//   per_case: {
//     composite: number[],                 // per-case composite K-Score
//     axes: { accuracy: number[], ... },   // per-case per-axis scores
//     subgroups: { region_eu: number[] },  // per-case scores for a subgroup
//     regression_classes: { sql_injection: number[] }  // per-case pass(1)/fail(0)
//   }
// The family member kinds:
//   'composite'  - the headline delta; promotion is gated on THIS member.
//   'axis'       - one per K-Score axis.
//   'subgroup'   - one per declared subgroup (fairness slice).
//   'regression' - one per regression class; a corrected-significant DROP blocks.
//
// For each member we pair candidate[i] with baseline[i] index-wise. Members with
// mismatched / missing vectors are emitted as { ok:false } so the gate abstains
// rather than silently dropping a hypothesis from the family.
export function buildTestFamily({ candidate, baseline } = {}) {
  const cpc = _isObj(candidate) ? (candidate.per_case || (_isObj(candidate.eval_results) ? candidate.eval_results.per_case : null)) : null;
  const bpc = _isObj(baseline) ? (baseline.per_case || (_isObj(baseline.eval_results) ? baseline.eval_results.per_case : null)) : null;
  const members = [];
  if (!_isObj(cpc) || !_isObj(bpc)) {
    return { members, ok: false, reason: 'no_per_case_vectors' };
  }

  const push = (kind, name, candVec, baseVec) => {
    const c = _finite(candVec);
    const b = _finite(baseVec);
    const n = Math.min(c.length, b.length);
    const delta = [];
    for (let i = 0; i < n; i++) delta.push(c[i] - b[i]);
    members.push({
      id: kind + ':' + name,
      kind, name,
      candidate_per_case: c.slice(0, n),
      baseline_per_case: b.slice(0, n),
      delta_per_case: delta,
      n,
      ok: n >= 1 && Array.isArray(candVec) && Array.isArray(baseVec),
    });
  };

  // composite (the gated member, always first)
  push('composite', 'composite', cpc.composite, bpc.composite);
  // axes
  const cAxes = _isObj(cpc.axes) ? cpc.axes : {};
  const bAxes = _isObj(bpc.axes) ? bpc.axes : {};
  for (const k of Object.keys(cAxes)) push('axis', k, cAxes[k], bAxes[k]);
  // subgroups
  const cSub = _isObj(cpc.subgroups) ? cpc.subgroups : {};
  const bSub = _isObj(bpc.subgroups) ? bpc.subgroups : {};
  for (const k of Object.keys(cSub)) push('subgroup', k, cSub[k], bSub[k]);
  // regression classes (per-case pass=1/fail=0; a DROP in pass-rate is a regression)
  const cReg = _isObj(cpc.regression_classes) ? cpc.regression_classes : {};
  const bReg = _isObj(bpc.regression_classes) ? bpc.regression_classes : {};
  for (const k of Object.keys(cReg)) push('regression', k, cReg[k], bReg[k]);

  return { members, ok: members.length > 0 && members[0].kind === 'composite' };
}

// ===========================================================================
// significanceBoundedGate - the gate.
// ===========================================================================
//
// Inputs:
//   family            - output of buildTestFamily (or { members:[...] })
//   alpha             - aggregate false-promotion budget across the family
//   min_kscore_delta  - effect floor the composite lower-CI must clear
//   correction        - 'bh' (FDR) | 'holm' (FWER)
//   bootstrap_method  - 'bca' | 'percentile'
//   bootstrap_iters   - resamples
//   min_samples       - paired-case floor for ANY member (below -> abstain)
//   seed              - deterministic RNG seed
//
// For EACH member we compute, on the paired per-case delta vector:
//   - a paired bootstrap CI (BCa) at level 1-alpha
//   - an mSPRT always-valid p-value (reusing src/stat-sig.js) so repeated
//     peeking at an accumulating eval stream does not inflate Type-I error.
//     The mSPRT min_effect_size is the member's own threshold: min_kscore_delta
//     for composite/axis/subgroup; 0 for regression (any real drop matters).
//
// We then apply BH/Holm across the FAMILY of always-valid p-values, producing a
// corrected significance verdict per member at the declared alpha.
//
// DECISION (fail-closed):
//   1. ABSTAIN if the family is degenerate, the composite member is missing, or
//      ANY member has fewer than min_samples paired cases.
//   2. BLOCK  if any regression-class member is corrected-significant for a DROP
//      (its mean delta < 0 i.e. pass-rate fell, and its corrected p clears alpha).
//   3. PROMOTE only if the COMPOSITE member's bootstrap lower-CI bound clears
//      min_kscore_delta AND the composite is corrected-significant (positive).
//   4. Otherwise ABSTAIN (straddling CI / inconclusive). Never promote.
//
// Returns { decision:'promote'|'block'|'abstain', reason, alpha, min_kscore_delta,
//           correction, family:[{...per member...}], composite:{...}, version }.
export function significanceBoundedGate({
  family,
  alpha,
  min_kscore_delta,
  correction,
  bootstrap_method,
  bootstrap_iters,
  ci_level,
  min_samples,
  regression_min_drop,
  regression_prior_scale,
  seed,
} = {}) {
  const a = _num(alpha) != null && alpha > 0 && alpha < 1 ? Number(alpha) : DEFAULT_GATE.alpha;
  const minDelta = _num(min_kscore_delta) != null ? Number(min_kscore_delta) : DEFAULT_GATE.min_kscore_delta;
  const corr = correction === 'holm' ? 'holm' : 'bh';
  const meth = bootstrap_method === 'percentile' ? 'percentile' : 'bca';
  const iters = Math.trunc(_num(bootstrap_iters) || DEFAULT_GATE.bootstrap_iters);
  const minN = Math.max(2, Math.trunc(_num(min_samples) ?? DEFAULT_GATE.min_samples));
  const regMinDrop = _num(regression_min_drop) != null ? Math.abs(Number(regression_min_drop)) : DEFAULT_GATE.regression_min_drop;
  const regPriorScale = _num(regression_prior_scale) != null && Number(regression_prior_scale) > 0
    ? Number(regression_prior_scale) : DEFAULT_GATE.regression_prior_scale;
  const lvl = _num(ci_level) != null ? Number(ci_level) : 1 - a;
  const baseSeed = Math.trunc(_num(seed) || 0);

  const members = (family && Array.isArray(family.members)) ? family.members
    : (Array.isArray(family) ? family : []);

  const meta = {
    decision: 'abstain',
    reason: 'no_family',
    alpha: a,
    min_kscore_delta: minDelta,
    correction: corr,
    bootstrap_method: meth,
    ci_level: lvl,
    min_samples: minN,
    regression_min_drop: regMinDrop,
    regression_prior_scale: regPriorScale,
    family: [],
    composite: null,
    version: SIG_BOUNDED_GATE_VERSION,
  };

  if (members.length === 0) return meta;
  const compositeMember = members.find((mm) => mm.kind === 'composite');
  if (!compositeMember) { meta.reason = 'missing_composite_member'; return meta; }

  // ---- per-member statistics --------------------------------------------
  // Deterministic per-member seed offset so each member's bootstrap is
  // reproducible AND independent (re-using one stream would correlate them).
  let anyUnderpowered = false;
  const enriched = members.map((mm, idx) => {
    const isReg = mm.kind === 'regression';
    // The mSPRT mixing-prior scale (tau / MDE). For composite/axis/subgroup it is
    // the promotion threshold; for a regression class it is the prior SCALE of
    // pass-rate moves the always-valid test is tuned to detect (distinct from the
    // regression_min_drop magnitude floor enforced in the decision below).
    const memberMinEffect = isReg ? regPriorScale : minDelta;
    const ci = pairedBootstrapCI({
      delta_per_case: mm.delta_per_case,
      alpha: a,
      ci_level: lvl,
      n_iters: iters,
      method: meth,
      min_samples: minN,
      seed: (baseSeed ^ (Math.imul(idx + 1, 0x9e3779b9))) | 0,
    });
    // mSPRT always-valid p-value on the paired vectors. We pass the two arms so
    // the always-valid LR is computed on the per-case scores, not a composite.
    const avp = msprtAlwaysValidPValue({
      samples_a: mm.baseline_per_case,
      samples_b: mm.candidate_per_case,
      min_effect_size: memberMinEffect > 0 ? memberMinEffect : 1e-6,
    });
    const point = ci.point;
    if (!ci.ok || !avp.ok || (mm.n || 0) < minN) anyUnderpowered = true;
    return {
      id: mm.id,
      kind: mm.kind,
      name: mm.name,
      n: mm.n,
      mean_delta: point,
      ci_low: ci.ci_low,
      ci_high: ci.ci_high,
      ci_method: ci.method,
      ci_ok: !!ci.ok,
      avp: avp.ok ? avp.avp : 1,         // always-valid p-value (fail-closed -> 1)
      avp_ok: !!avp.ok,
      member_min_effect: memberMinEffect,
    };
  });

  // ---- multiplicity correction across the family ------------------------
  // The p-value tested for each member is its always-valid p-value (avp). BH/Holm
  // bound the aggregate false-promotion rate across {composite, axes, subgroups,
  // regressions} at the declared alpha.
  const familyP = enriched.map((e) => e.avp);
  const corrected = correctFamily(familyP, a, corr);
  enriched.forEach((e, i) => {
    e.adjusted_p = corrected.adjusted[i];
    e.corrected_significant = corrected.rejected.has(i);
  });

  meta.family = enriched;
  meta.composite = enriched.find((e) => e.kind === 'composite') || null;

  // ---- fail-closed decision ladder --------------------------------------
  if (anyUnderpowered) {
    meta.decision = 'abstain';
    meta.reason = 'insufficient_samples: a family member is below min_samples=' + minN +
      ' or has no resolvable statistic; fail-closed abstain';
    return meta;
  }

  // (2) regression block: a regression class blocks when it is corrected-
  //     significant AND the per-case pass-rate dropped by MORE than the
  //     magnitude floor AND the bootstrap CI confirms a real drop (its UPPER
  //     bound is below zero - the whole interval is on the drop side). Requiring
  //     all three keeps a noisy sub-floor wobble from blocking a real win.
  const firedRegressions = enriched.filter((e) =>
    e.kind === 'regression' &&
    e.corrected_significant &&
    Number.isFinite(e.mean_delta) && e.mean_delta < -regMinDrop &&
    Number.isFinite(e.ci_high) && e.ci_high < 0);
  if (firedRegressions.length > 0) {
    meta.decision = 'block';
    meta.reason = 'regression: ' + firedRegressions.length +
      ' regression class(es) corrected-significant for a drop [' +
      firedRegressions.map((e) => e.name).join(', ') + ']';
    meta.fired_regressions = firedRegressions.map((e) => e.id);
    return meta;
  }

  // (3) promote ONLY on positive proof on the composite member.
  const comp = meta.composite;
  const lowerClears = comp && comp.ci_ok && Number.isFinite(comp.ci_low) && comp.ci_low >= minDelta;
  const compSig = comp && comp.corrected_significant && Number.isFinite(comp.mean_delta) && comp.mean_delta > 0;

  if (lowerClears && compSig) {
    meta.decision = 'promote';
    meta.reason = 'promote: composite lower-CI ' + _fmt(comp.ci_low) +
      ' >= min_kscore_delta ' + minDelta + ' AND corrected-significant (adj_p ' +
      _fmt(comp.adjusted_p) + ' < alpha ' + a + ')';
    return meta;
  }

  // (4) straddle / inconclusive -> abstain.
  meta.decision = 'abstain';
  if (comp && comp.ci_ok && Number.isFinite(comp.ci_low) && comp.ci_low < minDelta) {
    meta.reason = 'abstain: composite CI straddles threshold (lower-CI ' +
      _fmt(comp.ci_low) + ' < min_kscore_delta ' + minDelta + ')';
  } else if (comp && !comp.corrected_significant) {
    meta.reason = 'abstain: composite not corrected-significant (adj_p ' +
      _fmt(comp && comp.adjusted_p) + ' >= alpha ' + a + ') under ' + corr.toUpperCase() + ' control';
  } else {
    meta.reason = 'abstain: composite delta not a positive proof';
  }
  return meta;
}

function _fmt(x) { return Number.isFinite(x) ? Number(x).toFixed(5) : String(x); }

// ===========================================================================
// buildSignificanceEvalSummary - shape the gate verdict into the eval_summary
// the receipt binds. The signed body carries the TEST FAMILY, alpha, correction
// method, and the corrected p-values so the significance basis of the decision
// is tamper-evident.
// ===========================================================================
export function buildSignificanceEvalSummary({
  gate,
  candidate_artifact_id,
  baseline_artifact_id,
} = {}) {
  if (!gate || typeof gate !== 'object') {
    throw new Error('buildSignificanceEvalSummary: gate result required');
  }
  return {
    schema: 'kolm.sig_bounded_gate.v1',
    sig_bounded_gate_version: SIG_BOUNDED_GATE_VERSION,
    decision: gate.decision,
    promote: gate.decision === 'promote',
    reason: gate.reason,
    evaluated_at: new Date().toISOString(),
    candidate_artifact_id: candidate_artifact_id || null,
    baseline_artifact_id: baseline_artifact_id || null,
    // The DECLARED significance contract bound into the signature:
    significance: {
      alpha: gate.alpha,
      min_kscore_delta: gate.min_kscore_delta,
      correction: gate.correction,
      bootstrap_method: gate.bootstrap_method,
      ci_level: gate.ci_level,
      min_samples: gate.min_samples,
      regression_min_drop: gate.regression_min_drop,
      regression_prior_scale: gate.regression_prior_scale,
    },
    // The full TEST FAMILY + corrected p-values (the multiplicity record):
    test_family: (gate.family || []).map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      n: e.n,
      mean_delta: _round(e.mean_delta),
      ci_low: _round(e.ci_low),
      ci_high: _round(e.ci_high),
      avp: _round(e.avp),
      adjusted_p: _round(e.adjusted_p),
      corrected_significant: !!e.corrected_significant,
    })),
    family_size: (gate.family || []).length,
    composite: gate.composite ? {
      ci_low: _round(gate.composite.ci_low),
      ci_high: _round(gate.composite.ci_high),
      mean_delta: _round(gate.composite.mean_delta),
      adjusted_p: _round(gate.composite.adjusted_p),
      corrected_significant: !!gate.composite.corrected_significant,
    } : null,
    fired_regressions: gate.fired_regressions || [],
  };
}

function _round(x) { return Number.isFinite(x) ? Number(Number(x).toFixed(8)) : (x == null ? null : x); }

export default {
  SIG_BOUNDED_GATE_VERSION,
  DEFAULT_GATE,
  pairedBootstrapCI,
  benjaminiHochberg,
  holm,
  correctFamily,
  buildTestFamily,
  significanceBoundedGate,
  buildSignificanceEvalSummary,
};
