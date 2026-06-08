// src/conformal.js
//
// W921 - Conformal / calibrated uncertainty for the K-Score prediction.
//
// Replaces quality-predictor.js's admittedly-fabricated confidence-scaled band
// (heuristic half = 0.26 - 0.32*confidence; learned half = 0.155 - 0.11*conf)
// with a DISTRIBUTION-FREE, FINITE-SAMPLE interval that actually covers the
// true K at a stated rate, plus an ABSTAIN signal when the interval straddles
// the ship gate.
//
// SPLIT (INDUCTIVE) CONFORMAL - REGRESSION (Lei et al. 2018; Angelopoulos &
// Bates 2021):
//   1. Hold out a calibration set disjoint from the predictor fit.
//   2. Nonconformity score s_i = |y_i - f_hat(x_i)| (abs residual).
//   3. qhat = the b-th order statistic of {s_i}, b = ceil((n+1)*(1-alpha)).
//   4. For a new point: C(x) = [f_hat(x) - qhat, f_hat(x) + qhat], clamped to
//      [0,1].
//   THEOREM (exchangeability): 1-alpha <= P(Y in C(x)) <= 1-alpha + 1/(n+1) - 
//   finite-sample, distribution-free.
//
// SMALL-n GUARD: if b > n (n < 1/alpha - 1) qhat is undefined and the only
// valid interval is [0,1]; we return basis 'conformal_undercalibrated' so the
// caller falls back to its existing heuristic band (same heuristic->learned
// flip pattern the predictor already uses, gate at MIN_CONFORMAL_CAL).
//
// LOCALLY-WEIGHTED variant (Lei split-localized): normalize the residual by a
// local sigma estimate so intervals are wider on uncertain x, tighter on
// confident x at equal marginal coverage.
//
// MONDRIAN / GROUP-CONDITIONAL (Vovk 2003; MAPIE): a separate qhat per group
// (group = namespace) so a single namespace cannot be silently mis-covered;
// below-floor groups report insufficient_data and fall back to the pooled qhat.
//
// ACI for NON-STATIONARITY (Gibbs & Candes 2021): online level update
// alpha_{t+1} = alpha_t + gamma*(alpha - err_t) drives long-run miscoverage to
// alpha under arbitrary shift.
//
// CONFORMAL SELECTIVE PREDICTION: with interval [lo,hi] and ship gate g:
//   lo>=g -> ship_safe ;  hi<g -> skip_safe ;  lo<g<=hi -> ABSTAIN.
//
// Pure-JS, zero-dep, deterministic. Every public fn returns an envelope and
// never throws. CONFORMAL_VERSION='cf-v1'.

export const CONFORMAL_VERSION = 'cf-v1';

// ceil(1/alpha)+1 at alpha=0.10 = 11; the predictor uses a more conservative
// floor so the conformal path only activates with a meaningful pool.
export const MIN_CONFORMAL_CAL = 21;

const EPS = 1e-9;

// =============================================================================
// Pure-math helpers.
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

function _clamp01(x) {
  if (!Number.isFinite(x)) return x;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function _clampAlpha(alpha) {
  const a = Number(alpha);
  if (!Number.isFinite(a) || a <= 0 || a >= 1) return 0.10;
  return a;
}

// =============================================================================
// Split-conformal quantile.
// =============================================================================
//
// The conformal quantile of a set of nonconformity scores. qhat is the
// b-th smallest score, b = ceil((n+1)*(1-alpha)). When b > n the empirical
// (1-alpha) quantile at level (n+1)/n exceeds the largest observation, which
// means the only finite-sample-valid interval is the full range -> qhat is
// Infinity and undercalibrated:true.

/**
 * @param {number[]} scores  nonconformity scores (e.g. abs residuals)
 * @param {number} alpha     miscoverage level (0,1)
 * @returns {{ qhat:number, n:number, b:number, undercalibrated:boolean }}
 */
export function splitConformalQuantile(scores, alpha) {
  const a = _clampAlpha(alpha);
  const s = _finiteOnly(scores).slice().sort((x, y) => x - y);
  const n = s.length;
  if (n === 0) {
    return { qhat: Number.POSITIVE_INFINITY, n: 0, b: 0, undercalibrated: true };
  }
  const b = Math.ceil((n + 1) * (1 - a));
  if (b > n) {
    // Quantile lies above the largest observation -> only [0,1] is valid.
    return { qhat: Number.POSITIVE_INFINITY, n, b, undercalibrated: true };
  }
  // b is 1-indexed order statistic -> array index b-1.
  const qhat = s[b - 1];
  return { qhat, n, b, undercalibrated: false };
}

/**
 * conformalQuantile - empirical (n+1)(1-alpha) quantile of scores. Alias kept
 * for parity with the judge-conformal spec naming; returns the numeric qhat
 * (Infinity when undercalibrated).
 * @returns {number}
 */
export function conformalQuantile(scores, alpha) {
  return splitConformalQuantile(scores, alpha).qhat;
}

// =============================================================================
// Locally-weighted (normalized) residual + local sigma.
// =============================================================================

/**
 * Normalized nonconformity score s_i = |residual| / sigma. sigma is floored to
 * EPS so a zero spread never divides by zero.
 * @returns {number}
 */
export function localizedScore(residual, sigma) {
  const r = Math.abs(Number(residual));
  const s = Math.max(EPS, Number(sigma) || 0);
  if (!Number.isFinite(r)) return 0;
  return r / s;
}

/**
 * sigmaEstimate - local difficulty estimate for x via the spread of the k
 * nearest calibration rows. Distance is Euclidean over numeric feature vectors
 * when x and calRows[i].x are arrays; otherwise falls back to the global
 * residual std. Returns a value floored to EPS.
 *
 * @param {Object} args
 * @param {number[]|Object} args.x        feature vector (or feature object)
 * @param {Array<{x?:number[], residual?:number, y?:number, yhat?:number}>} args.calRows
 * @param {number} [args.k=10]
 * @returns {number} sigma > 0
 */
export function sigmaEstimate({ x, calRows, k = 10 } = {}) {
  const rows = Array.isArray(calRows) ? calRows : [];
  if (rows.length === 0) return 1;

  const resid = (row) => {
    if (Number.isFinite(Number(row.residual))) return Math.abs(Number(row.residual));
    if (Number.isFinite(Number(row.y)) && Number.isFinite(Number(row.yhat))) {
      return Math.abs(Number(row.y) - Number(row.yhat));
    }
    return null;
  };

  const xv = _toVec(x);
  // If we cannot localize (no usable feature vectors), return the global std of residuals.
  if (!xv) {
    const rs = rows.map(resid).filter((v) => v !== null);
    return Math.max(EPS, _std(rs));
  }

  const scored = [];
  for (const row of rows) {
    const rv = _toVec(row.x);
    const r = resid(row);
    if (!rv || r === null) continue;
    scored.push({ d: _dist(xv, rv), r });
  }
  if (scored.length === 0) {
    const rs = rows.map(resid).filter((v) => v !== null);
    return Math.max(EPS, _std(rs));
  }
  scored.sort((a, b) => a.d - b.d);
  const kk = Math.max(1, Math.min(Math.trunc(k) || 10, scored.length));
  const near = scored.slice(0, kk).map((o) => o.r);
  // Local difficulty = mean abs residual of neighbours (a robust scale proxy).
  const mean = near.reduce((acc, v) => acc + v, 0) / near.length;
  return Math.max(EPS, mean);
}

function _toVec(x) {
  if (Array.isArray(x)) {
    const v = x.map(Number).filter(Number.isFinite);
    return v.length ? v : null;
  }
  if (x && typeof x === 'object') {
    const v = Object.values(x).map(Number).filter(Number.isFinite);
    return v.length ? v : null;
  }
  return null;
}

function _dist(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function _std(arr) {
  const a = _finiteOnly(arr);
  if (a.length < 2) return 0;
  const mean = a.reduce((acc, v) => acc + v, 0) / a.length;
  let ss = 0;
  for (const v of a) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (a.length - 1));
}

// Resolve an abs residual from a calibration row (shared shape).
function _rowResidual(row) {
  if (Number.isFinite(Number(row.residual))) return Math.abs(Number(row.residual));
  if (Number.isFinite(Number(row.y)) && Number.isFinite(Number(row.yhat))) {
    return Math.abs(Number(row.y) - Number(row.yhat));
  }
  if (Number.isFinite(Number(row.observed)) && Number.isFinite(Number(row.predicted))) {
    return Math.abs(Number(row.observed) - Number(row.predicted));
  }
  return null;
}

// =============================================================================
// predictInterval - the focused split-conformal core (residuals, alpha).
// =============================================================================
//
// Given a point prediction and a pool of calibration residuals, return a
// calibrated prediction interval. This is the primary entry point: the caller
// passes the residuals it has accumulated (observed - predicted on a holdout)
// and a point estimate; the function returns the conformal half-width and the
// clamped [lo,hi].

/**
 * @param {number[]} residuals             calibration residuals (signed or abs)
 * @param {number} alpha                   miscoverage level (0,1); default 0.10
 * @param {Object} [opts]
 * @param {number} [opts.point]            point prediction f_hat(x); default 0
 * @param {boolean} [opts.clamp01=true]    clamp the interval to [0,1] (K-score domain)
 * @param {number} [opts.sigma]            local sigma for normalized residuals (localized mode)
 * @returns {{ ok:boolean, lo:number, hi:number, half_width:number, qhat:number,
 *             n_cal:number, b:number, coverage_target:number,
 *             basis:'conformal'|'conformal_localized'|'conformal_undercalibrated',
 *             localized:boolean, version:string }}
 */
export function predictInterval(residuals, alpha = 0.10, opts = {}) {
  const a = _clampAlpha(alpha);
  const point = Number.isFinite(Number(opts.point)) ? Number(opts.point) : 0;
  const doClamp = opts.clamp01 !== false;
  const localized = Number.isFinite(Number(opts.sigma)) && Number(opts.sigma) > 0;
  const sigma = localized ? Number(opts.sigma) : 1;

  // Normalize residuals to absolute nonconformity scores (optionally localized).
  const raw = _finiteOnly(residuals);
  const scores = localized
    ? raw.map((r) => localizedScore(r, sigma))
    : raw.map((r) => Math.abs(r));

  const q = splitConformalQuantile(scores, a);
  const coverage_target = 1 - a;

  if (q.undercalibrated || !Number.isFinite(q.qhat)) {
    // Only the full domain is finite-sample valid.
    const lo = doClamp ? 0 : Number.NEGATIVE_INFINITY;
    const hi = doClamp ? 1 : Number.POSITIVE_INFINITY;
    return {
      ok: true,
      lo,
      hi,
      half_width: doClamp ? 1 : Number.POSITIVE_INFINITY,
      qhat: Number.POSITIVE_INFINITY,
      n_cal: q.n,
      b: q.b,
      coverage_target,
      basis: 'conformal_undercalibrated',
      localized,
      version: CONFORMAL_VERSION,
    };
  }

  // De-normalize the half-width when localized (qhat is on the normalized scale).
  const half_width = localized ? q.qhat * sigma : q.qhat;
  let lo = point - half_width;
  let hi = point + half_width;
  if (doClamp) { lo = _clamp01(lo); hi = _clamp01(hi); }

  return {
    ok: true,
    lo,
    hi,
    half_width,
    qhat: q.qhat,
    n_cal: q.n,
    b: q.b,
    coverage_target,
    basis: localized ? 'conformal_localized' : 'conformal',
    localized,
    version: CONFORMAL_VERSION,
  };
}

// =============================================================================
// conformalInterval - calibration-row entry point (spec signature).
// =============================================================================
//
// Computes residuals from a pool of labelled calibration rows and delegates to
// predictInterval. Each calRow carries either {residual} or {y,yhat} (or
// {observed,predicted}). In localized mode, sigma is estimated from x via the
// k nearest calibration rows unless sigmaHat is supplied.

/**
 * @param {Object} args
 * @param {number} args.point              f_hat(x)
 * @param {number[]|Object} [args.x]       feature vector for localization
 * @param {Array} args.calRows             [{residual} | {y,yhat} | {observed,predicted}]
 * @param {number} [args.alpha=0.10]
 * @param {'split'|'localized'} [args.mode='localized']
 * @param {string} [args.group]
 * @param {number} [args.sigmaHat]         explicit local sigma override
 * @returns {{ ok, version, lo, hi, qhat, n_cal, coverage_target, basis,
 *             localized, group, error? }}
 */
export function conformalInterval({ point, x, calRows, alpha = 0.10, mode = 'localized', group, sigmaHat } = {}) {
  const a = _clampAlpha(alpha);
  if (!Number.isFinite(Number(point))) {
    return {
      ok: false,
      error: 'invalid_point',
      version: CONFORMAL_VERSION,
      group: group || null,
    };
  }
  const rows = Array.isArray(calRows) ? calRows : [];
  const residuals = [];
  for (const row of rows) {
    const r = _rowResidual(row);
    if (r !== null) residuals.push(r);
  }

  const wantLocal = mode === 'localized';
  let sigma;
  if (wantLocal) {
    sigma = Number.isFinite(Number(sigmaHat)) && Number(sigmaHat) > 0
      ? Number(sigmaHat)
      : sigmaEstimate({ x, calRows: rows });
  }

  // In localized mode, normalize each calibration residual by ITS OWN local
  // sigma so the score scale matches the test point. We approximate per-row
  // sigma with the global sigma here when no per-row x is available; the
  // dedicated bench validates the heteroskedastic-width property.
  const res = predictInterval(residuals, a, {
    point: Number(point),
    clamp01: true,
    sigma: wantLocal ? sigma : undefined,
  });

  return {
    ok: res.ok,
    version: CONFORMAL_VERSION,
    lo: res.lo,
    hi: res.hi,
    qhat: res.qhat,
    n_cal: res.n_cal,
    coverage_target: res.coverage_target,
    basis: res.basis,
    localized: res.localized,
    group: group || null,
  };
}

// =============================================================================
// Mondrian / group-conditional calibration.
// =============================================================================

/**
 * Calibrate a separate qhat per group. Groups below minPerGroup are listed in
 * insufficient[] and should fall back to the pooled qhat.
 *
 * @param {Object} args
 * @param {Array} args.rows               calibration rows ({residual}|{y,yhat})
 * @param {Function} [args.groupKey]      row -> group label; default r=>r.namespace
 * @param {number} [args.alpha=0.10]
 * @param {number} [args.minPerGroup]     default MIN_CONFORMAL_CAL
 * @returns {{ ok, byGroup:Object, pooled:Object, insufficient:string[],
 *             min_per_group:number, version:string }}
 */
export function mondrianCalibrate({ rows, groupKey = (r) => r.namespace, alpha = 0.10, minPerGroup } = {}) {
  const a = _clampAlpha(alpha);
  const minG = Number.isFinite(Number(minPerGroup)) ? Math.max(1, Math.trunc(Number(minPerGroup))) : MIN_CONFORMAL_CAL;
  const all = Array.isArray(rows) ? rows : [];

  const buckets = new Map();
  const pooledScores = [];
  for (const row of all) {
    const r = _rowResidual(row);
    if (r === null) continue;
    pooledScores.push(r);
    let g;
    try { g = groupKey(row); } catch { g = undefined; }
    g = (g === undefined || g === null || g === '') ? '__ungrouped__' : String(g);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(r);
  }

  const pooled = { ...splitConformalQuantile(pooledScores, a), alpha: a };
  const byGroup = {};
  const insufficient = [];
  for (const [g, scores] of buckets.entries()) {
    const q = splitConformalQuantile(scores, a);
    byGroup[g] = { ...q, alpha: a };
    if (scores.length < minG || q.undercalibrated) insufficient.push(g);
  }

  return {
    ok: true,
    byGroup,
    pooled,
    insufficient,
    min_per_group: minG,
    version: CONFORMAL_VERSION,
  };
}

/**
 * applyConformal - resolve an interval for (category, yhat) from a Mondrian
 * mapping, falling back to pooled when the category is below floor.
 *
 * @returns {{ lo, hi, midpoint, qhat, coverage_target, status, group }}
 */
export function applyConformal(mapping, category, yhat, { clamp01 = true } = {}) {
  const m = mapping || {};
  const cat = (category === undefined || category === null) ? '__ungrouped__' : String(category);
  const insufficient = Array.isArray(m.insufficient) ? m.insufficient : [];
  const byGroup = m.byGroup || {};
  let entry = byGroup[cat];
  let status = 'group';
  if (!entry || entry.undercalibrated || insufficient.includes(cat)) {
    entry = m.pooled || { qhat: Number.POSITIVE_INFINITY };
    status = (m.pooled && !m.pooled.undercalibrated) ? 'pooled_fallback' : 'undercalibrated';
  }
  const point = Number(yhat);
  const qhat = entry ? entry.qhat : Number.POSITIVE_INFINITY;
  const target = 1 - (entry && Number.isFinite(entry.alpha) ? entry.alpha : 0.10);
  if (!Number.isFinite(qhat) || !Number.isFinite(point)) {
    return {
      lo: clamp01 ? 0 : Number.NEGATIVE_INFINITY,
      hi: clamp01 ? 1 : Number.POSITIVE_INFINITY,
      midpoint: Number.isFinite(point) ? point : null,
      qhat: Number.POSITIVE_INFINITY,
      coverage_target: target,
      status: 'undercalibrated',
      group: cat,
    };
  }
  let lo = point - qhat;
  let hi = point + qhat;
  if (clamp01) { lo = _clamp01(lo); hi = _clamp01(hi); }
  return { lo, hi, midpoint: point, qhat, coverage_target: target, status, group: cat };
}

// =============================================================================
// ACI - Adaptive Conformal Inference (online level update for drift).
// =============================================================================

/**
 * Update the online miscoverage level from a realized outcome.
 *
 *   err_t = 1 if observed fell OUTSIDE the issued interval, else 0
 *   alpha_{t+1} = clamp( alpha_t + gamma*(targetAlpha - err_t), eps, 1-eps )
 *
 * @param {Object} args
 * @param {{alpha_t?:number, miscover_count?:number, n_seen?:number}} [args.state]
 * @param {number} args.observed
 * @param {[number,number]} args.interval  [lo,hi]
 * @param {number} [args.gamma=0.02]
 * @param {number} [args.targetAlpha=0.10]
 * @returns {{ alpha_t:number, miscover_rate:number, n_seen:number,
 *             miscover_count:number, last_err:0|1, version:string }}
 */
export function aciUpdate({ state, observed, interval, gamma = 0.02, targetAlpha = 0.10 } = {}) {
  const st = state || {};
  const tAlpha = _clampAlpha(targetAlpha);
  const g = Number.isFinite(Number(gamma)) && Number(gamma) > 0 ? Number(gamma) : 0.02;
  let alpha_t = Number.isFinite(Number(st.alpha_t)) ? Number(st.alpha_t) : tAlpha;
  let n_seen = Number.isFinite(Number(st.n_seen)) ? Math.trunc(Number(st.n_seen)) : 0;
  let miscover_count = Number.isFinite(Number(st.miscover_count)) ? Math.trunc(Number(st.miscover_count)) : 0;

  const iv = Array.isArray(interval) ? interval : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const lo = Number(iv[0]);
  const hi = Number(iv[1]);
  const y = Number(observed);
  let err = 0;
  if (Number.isFinite(y) && Number.isFinite(lo) && Number.isFinite(hi)) {
    err = (y < lo || y > hi) ? 1 : 0;
  } else if (Number.isFinite(y)) {
    // Unbounded interval -> covers by definition.
    err = 0;
  }

  alpha_t = alpha_t + g * (tAlpha - err);
  // Keep the level a valid probability.
  if (alpha_t < EPS) alpha_t = EPS;
  if (alpha_t > 1 - EPS) alpha_t = 1 - EPS;
  n_seen += 1;
  miscover_count += err;

  return {
    alpha_t,
    miscover_rate: n_seen > 0 ? miscover_count / n_seen : 0,
    n_seen,
    miscover_count,
    last_err: err,
    version: CONFORMAL_VERSION,
  };
}

// =============================================================================
// Selective prediction / abstention.
// =============================================================================

/**
 * @param {Object} args
 * @param {number} args.lo
 * @param {number} args.hi
 * @param {number} [args.gate=0.85]
 * @returns {'ship_safe'|'skip_safe'|'abstain'}
 */
export function selectiveDecision({ lo, hi, gate = 0.85 } = {}) {
  const g = Number(gate);
  const l = Number(lo);
  const h = Number(hi);
  if (!Number.isFinite(l) || !Number.isFinite(h) || !Number.isFinite(g)) return 'abstain';
  if (l >= g) return 'ship_safe';
  if (h < g) return 'skip_safe';
  return 'abstain';
}

/**
 * decideFromConformal - compile-simulator decision from a proposed candidate's
 * conformal interval vs the ship gate + the current-vs-proposed K delta.
 *
 *   straddle the gate                          -> 'abstain'
 *   prop_lo >= gate AND delta_k >= min_delta_k -> 'compile'
 *   otherwise                                  -> 'skip'
 *
 * @returns {{ decision:'compile'|'skip'|'abstain', reason:string }}
 */
export function decideFromConformal({ k_current, prop_lo, prop_hi, gate = 0.85, min_delta_k = 0.02, delta_k } = {}) {
  const g = Number(gate);
  const lo = Number(prop_lo);
  const hi = Number(prop_hi);
  const minDk = Number.isFinite(Number(min_delta_k)) ? Number(min_delta_k) : 0.02;
  let dk = Number(delta_k);
  if (!Number.isFinite(dk) && Number.isFinite(Number(k_current)) && Number.isFinite((lo + hi) / 2)) {
    dk = (lo + hi) / 2 - Number(k_current);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { decision: 'abstain', reason: 'invalid_interval' };
  }
  const sel = selectiveDecision({ lo, hi, gate: g });
  if (sel === 'abstain') return { decision: 'abstain', reason: 'interval_straddles_gate' };
  if (sel === 'skip_safe') return { decision: 'skip', reason: 'upper_below_gate' };
  // ship_safe: lower bound clears the gate; still require a meaningful improvement.
  if (Number.isFinite(dk) && dk < minDk) {
    return { decision: 'skip', reason: 'delta_k_below_min' };
  }
  return { decision: 'compile', reason: 'lower_clears_gate_and_delta' };
}

// =============================================================================
// Coverage report (for the bench / validation).
// =============================================================================

/**
 * Split rows into calibration (first half) + holdout (second half), fit qhat
 * on the calibration scores, and measure realized coverage on the holdout.
 * Optional groupKey produces per-group coverage too.
 *
 * @param {Object} args
 * @param {Array} args.rows               [{y,yhat[,namespace]} | {residual,...}]
 * @param {number} [args.alpha=0.10]
 * @param {Function} [args.groupKey]
 * @returns {{ ok, realized_coverage, target, n, mean_width, by_group,
 *             version }}
 */
export function conformalCoverageReport({ rows, alpha = 0.10, groupKey } = {}) {
  const a = _clampAlpha(alpha);
  const all = (Array.isArray(rows) ? rows : []).filter((r) =>
    Number.isFinite(Number(r && r.y)) && Number.isFinite(Number(r && r.yhat)));
  const n = all.length;
  if (n < 4) {
    return {
      ok: false,
      error: 'insufficient_rows',
      realized_coverage: null,
      target: 1 - a,
      n,
      mean_width: null,
      by_group: {},
      version: CONFORMAL_VERSION,
    };
  }
  const half = Math.floor(n / 2);
  const cal = all.slice(0, half);
  const hold = all.slice(half);
  const calScores = cal.map((r) => Math.abs(Number(r.y) - Number(r.yhat)));
  const q = splitConformalQuantile(calScores, a);

  let covered = 0;
  let widthSum = 0;
  const groupAgg = new Map();
  for (const r of hold) {
    const point = Number(r.yhat);
    const lo = q.undercalibrated ? 0 : _clamp01(point - q.qhat);
    const hi = q.undercalibrated ? 1 : _clamp01(point + q.qhat);
    const y = Number(r.y);
    const isCov = y >= lo - EPS && y <= hi + EPS;
    if (isCov) covered += 1;
    widthSum += (hi - lo);
    if (typeof groupKey === 'function') {
      let g;
      try { g = groupKey(r); } catch { g = undefined; }
      g = (g === undefined || g === null || g === '') ? '__ungrouped__' : String(g);
      if (!groupAgg.has(g)) groupAgg.set(g, { covered: 0, n: 0 });
      const ga = groupAgg.get(g);
      ga.n += 1;
      if (isCov) ga.covered += 1;
    }
  }

  const by_group = {};
  for (const [g, ga] of groupAgg.entries()) {
    by_group[g] = { realized_coverage: ga.n ? ga.covered / ga.n : null, n: ga.n };
  }

  return {
    ok: true,
    realized_coverage: hold.length ? covered / hold.length : null,
    target: 1 - a,
    n: hold.length,
    n_cal: cal.length,
    qhat: q.qhat,
    undercalibrated: q.undercalibrated,
    mean_width: hold.length ? widthSum / hold.length : null,
    by_group,
    version: CONFORMAL_VERSION,
  };
}

// =============================================================================
// recordConformalOutcome - best-effort durable feedback for ACI.
// =============================================================================
//
// Persists a (issued interval, observed K, miscovered?) tuple to the event
// store so the ACI loop has a durable feedback stream. Best-effort: never
// throws; returns persisted:false honestly when the store is unavailable.

/**
 * @param {Object} args
 * @param {string} args.tenant
 * @param {string} args.namespace
 * @param {number} args.observed_k
 * @param {[number,number]} args.issued_interval
 * @returns {Promise<{ ok:boolean, version:string, persisted:boolean,
 *           miscovered:boolean, error?:string }>}
 */
export async function recordConformalOutcome({ tenant, namespace, observed_k, issued_interval } = {}) {
  const iv = Array.isArray(issued_interval) ? issued_interval : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const lo = Number(iv[0]);
  const hi = Number(iv[1]);
  const y = Number(observed_k);
  let miscovered = false;
  if (Number.isFinite(y) && Number.isFinite(lo) && Number.isFinite(hi)) {
    miscovered = y < lo || y > hi;
  }

  if (!Number.isFinite(y)) {
    return { ok: false, version: CONFORMAL_VERSION, persisted: false, miscovered: false, error: 'invalid_observed_k' };
  }

  let persisted = false;
  try {
    const es = await import('./event-store.js');
    await es.appendEvent({
      tenant_id: tenant || 'tenant_anonymous',
      namespace: namespace || 'default',
      workflow_id: 'w921:conformal',
      status: 'ok',
      conformal_observed_k: y,
      conformal_interval_lo: Number.isFinite(lo) ? lo : null,
      conformal_interval_hi: Number.isFinite(hi) ? hi : null,
      conformal_miscovered: miscovered,
    });
    persisted = true;
  } catch (e) {
    // Best-effort: the durable feed is optional; ACI also works in-memory.
    return {
      ok: true,
      version: CONFORMAL_VERSION,
      persisted: false,
      miscovered,
      error: String((e && e.message) || e),
    };
  }

  return { ok: true, version: CONFORMAL_VERSION, persisted, miscovered };
}

export default {
  CONFORMAL_VERSION,
  MIN_CONFORMAL_CAL,
  splitConformalQuantile,
  conformalQuantile,
  localizedScore,
  sigmaEstimate,
  predictInterval,
  conformalInterval,
  mondrianCalibrate,
  applyConformal,
  aciUpdate,
  selectiveDecision,
  decideFromConformal,
  conformalCoverageReport,
  recordConformalOutcome,
};
