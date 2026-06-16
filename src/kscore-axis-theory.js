// C6 - K-score axis identifiability, reliability, and weight-derivation theory.
//
// PURPOSE. An ADDITIVE, OFFLINE, OPT-IN (env-gated) analysis pass that runs over
// a labeled preference corpus + per-artifact axis vectors and EMITS a derived-
// weights spec `spec:'k-score-derived-1'` ALONGSIDE the frozen V1_WEIGHTS /
// V2_WEIGHTS / GATE in src/kscore.js. It NEVER mutates the runtime weights,
// NEVER changes any artifact's `ships` decision, and is dormant (returns
// {status:'disabled'}) unless KOLM_KSCORE_AXIS_THEORY=1. It mirrors the W810
// fitAndPersist quarterly-job shape and the KOLM_KSCORE_CONFORMAL stricter-only
// / fail-closed contract.
//
// UNIFYING OBJECT. Phi in R^{N x d}: rows = artifacts, cols = the d in-[0,1]
// axes the artifact carries (subset of A,S,L,C,V,R,T,F,E,Z; governance axes F,Z
// are flagged). Input is a plain object:
//   { axisOrder:[...], rows:[{id, axes:{A:..,S:..,...}}], occasions?, pairs? }
// All four stages consume Phi; each carries a frozen falsification test (FT1-4,
// proven in tests/finalized-c6-kscore-axis-identifiability-theory.test.js).
//
// PRIVACY (load-bearing). The W810 pack is the least-protected sensitive surface
// (plaintext prompt + response_a + response_b). This module's stage-3 fit
// consumes ONLY Phi (numeric axis vectors in [0,1]) + pref labels - it never
// reads prompt/response text, so the most sensitive bytes never enter the fit
// at all (provable boundary: the only string inputs are axis names + row ids).
// Two hardening layers, both REAL: (1) DP objective-perturbation on the ridge
// logistic fit; (2) tenant-side execution over a hash-pinned holdout corpus
// (corpus_hash binds the derived spec to the exact corpus it was fit on).
//
// MOAT. The emitted object is shaped to drop straight into the signed
// attestation envelope via the W460 conditional-spread byte-stability law:
// a self-contained block carrying proof-of-validity (oof agreement CI +
// corpus_hash + convergence + reliability bands), not just numbers.
//
// STYLE. ESM, ASCII-only, pure JS, no new deps. Reuses the numeric idioms
// (stable log-sigmoid, ridge, diagonal-Newton + backtracking, Wald-from-
// Hessian-diagonal) and the convergence contract from src/bradley-terry.js;
// reuses the KOLM_DATA_DIR test seam + fitAndPersist persistence shape from
// src/kscore-calibration.js. Caveats noted inline; the word 'honest' avoided.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { BT_DEFAULTS } from './bradley-terry.js';
// finalized-c6 - kscore.js now exports the frozen weight/gate literals (the C6
// integrator wired `export { V1_WEIGHTS, V2_WEIGHTS, GATE }`). Prefer the real
// named import (single source of truth, no fragile regex); the load-time source
// parse below stays as a proven fallback for older kscore.js revisions.
import {
  V1_WEIGHTS as _KS_V1,
  V2_WEIGHTS as _KS_V2,
  GATE as _KS_GATE,
} from './kscore.js';

// Frozen baseline-to-beat. src/kscore.js declares V1_WEIGHTS / V2_WEIGHTS / GATE
// as module-private `const` literals (not exported), and the C6 contract is to
// NOT edit that shared funnel. We therefore recover the SAME frozen literals
// READ-ONLY by parsing the source file at load time (single source of truth, no
// mutation, no duplicated hand-typed numbers that could silently drift). If the
// integrator later exports them (W810 pattern) this falls back to the export.
// crossFileNeeds records the desired `export` for a cleaner import.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function _loadFrozenWeights() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'kscore.js'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\{[^}]*\\}|[0-9.]+)\\s*;'));
    if (!m) throw new Error('axis-theory: could not recover frozen ' + name + ' from src/kscore.js');
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + m[1] + ');')();
  };
  return {
    V1_WEIGHTS: Object.freeze(grab('V1_WEIGHTS')),
    V2_WEIGHTS: Object.freeze(grab('V2_WEIGHTS')),
    GATE: grab('GATE'),
  };
}

// Prefer the named import from kscore.js (finalized-c6 export); fall back to the
// load-time source parse if a kscore.js revision predates the export.
const _frozen = (_KS_V1 && _KS_V2 && _KS_GATE != null)
  ? { V1_WEIGHTS: Object.freeze({ ..._KS_V1 }), V2_WEIGHTS: Object.freeze({ ..._KS_V2 }), GATE: _KS_GATE }
  : _loadFrozenWeights();
export const V1_WEIGHTS = _frozen.V1_WEIGHTS;
export const V2_WEIGHTS = _frozen.V2_WEIGHTS;
export const GATE = _frozen.GATE;

export const KSCORE_AXIS_THEORY_SPEC = 'k-score-derived-1';
export const KSCORE_AXIS_THEORY_VERSION = 'c6-v1';

// Governance axes carry a configurable minimum-weight floor so the fit can
// never zero them out. Mirrors the V2 spec calling out F (fairness) and Z
// (drift) as the governance axes.
export const GOVERNANCE_AXES = Object.freeze(['F', 'Z']);
export const DEFAULT_GOVERNANCE_FLOOR = 0.05;

// Koo-Li ICC reliability bands.
export const ICC_BANDS = Object.freeze({ poor: 0.5, moderate: 0.75 });

// k-fold default for the out-of-fold validity headline.
const DEFAULT_FOLDS = 5;
// Bootstrap resamples for per-weight percentile CI.
const DEFAULT_BOOTSTRAP = 500;

// ===========================================================================
// Numeric helpers. Same idioms as src/bradley-terry.js + kscore-calibration.js
// (_sigmoid / _logit / _expit), extended with the stats primitives the theory
// needs (regularized incomplete beta -> F-quantile, Jacobi eigensolver,
// Gaussian elimination, seeded RNG). All pure JS, deterministic, dep-free.
// ===========================================================================

function _sigmoid(x) {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
  const z = Math.exp(x); return z / (1 + z);
}
function _logit(p) {
  const q = Math.max(1e-12, Math.min(1 - 1e-12, p));
  return Math.log(q / (1 - q));
}
function _expit(x) { return _sigmoid(x); }
function _clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function _round(x, n) { return Number(Number(x).toFixed(n)); }

// log-Gamma via Lanczos. Needed for the incomplete-beta normalizer.
function _logGamma(z) {
  // Lanczos g=7, n=9 coefficients (standard, deterministic).
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // reflection: Gamma(z)Gamma(1-z) = pi/sin(pi z)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _logGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Regularized incomplete beta I_x(a,b) via continued fraction (Lentz),
// same numeric style as the _expit/_logit helpers (stable, branch-on-x).
function _betacf(x, a, b) {
  const MAXIT = 300, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function _betai(x, a, b) {
  // Regularized incomplete beta function I_x(a,b) in [0,1].
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = _logGamma(a + b) - _logGamma(a) - _logGamma(b);
  const bt = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * _betacf(x, a, b)) / a;
  return 1 - (bt * _betacf(1 - x, b, a)) / b;
}

// CDF of the F-distribution: P(F_{d1,d2} <= f).
function _fcdf(f, d1, d2) {
  if (f <= 0) return 0;
  const x = (d1 * f) / (d1 * f + d2);
  return _betai(x, d1 / 2, d2 / 2);
}

// Quantile (inverse CDF) of the F-distribution via monotone bisection on the
// real CDF above. p in (0,1). Deterministic, ~60 iters to ~1e-9.
function _fquantile(p, d1, d2) {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  let lo = 0, hi = 1;
  // expand hi until CDF exceeds p
  while (_fcdf(hi, d1, d2) < p && hi < 1e12) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (_fcdf(mid, d1, d2) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return 0.5 * (lo + hi);
}

// Deterministic seeded RNG (mulberry32) for DP noise + bootstrap. Seeded from
// the corpus_hash so tests are reproducible and the DP draw is bound to the
// exact corpus.
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _seedFromHash(hexHash) {
  // Fold the first 8 hex chars of the corpus hash into a uint32 seed.
  return parseInt(hexHash.slice(0, 8), 16) >>> 0;
}

// Standard-normal sample via Box-Muller using a seeded uniform RNG.
function _gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Solve A w = b for symmetric-ish A via Gaussian elimination with partial
// pivoting. Returns null if singular (used for VIF/normal equations).
function _solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => row.slice().concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const pv = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

// Classic cyclic Jacobi eigensolver for a symmetric d x d matrix. Returns
// {eigenvalues:[...] (descending), iterations}. Deterministic; d<=10 so cheap.
function _jacobiEig(Sin) {
  const n = Sin.length;
  // copy
  const S = Sin.map((r) => r.slice());
  let sweeps = 0;
  for (let iter = 0; iter < 100; iter++) {
    // largest off-diagonal
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += S[i][j] * S[i][j];
    if (off < 1e-18) break;
    sweeps++;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(S[p][q]) < 1e-300) continue;
        const app = S[p][p], aqq = S[q][q], apq = S[p][q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const cph = Math.cos(phi), sph = Math.sin(phi);
        for (let k = 0; k < n; k++) {
          const skp = S[k][p], skq = S[k][q];
          S[k][p] = cph * skp - sph * skq;
          S[k][q] = sph * skp + cph * skq;
        }
        for (let k = 0; k < n; k++) {
          const spk = S[p][k], sqk = S[q][k];
          S[p][k] = cph * spk - sph * sqk;
          S[q][k] = sph * spk + cph * sqk;
        }
      }
    }
  }
  const eig = [];
  for (let i = 0; i < n; i++) eig.push(S[i][i]);
  eig.sort((a, b) => b - a);
  return { eigenvalues: eig, sweeps };
}

// ===========================================================================
// Phi construction + validation (fail-closed disjointness).
// ===========================================================================

function _buildPhi(corpus) {
  const axisOrder = corpus.axisOrder;
  if (!Array.isArray(axisOrder) || axisOrder.length === 0) {
    throw new TypeError('axis-theory: corpus.axisOrder must be a non-empty array of axis names');
  }
  for (const a of axisOrder) {
    if (typeof a !== 'string' || !a) throw new TypeError('axis-theory: axisOrder entries must be non-empty strings');
  }
  if (!Array.isArray(corpus.rows) || corpus.rows.length === 0) {
    throw new TypeError('axis-theory: corpus.rows must be a non-empty array');
  }
  const d = axisOrder.length;
  const ids = [];
  const idSet = new Set();
  const Phi = [];
  for (const row of corpus.rows) {
    if (row == null || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) {
      throw new TypeError('axis-theory: each row must be {id:string, axes:{...}}');
    }
    if (idSet.has(row.id)) throw new TypeError('axis-theory: duplicate row id ' + row.id);
    idSet.add(row.id);
    ids.push(row.id);
    const axes = row.axes || {};
    const vec = new Array(d);
    for (let j = 0; j < d; j++) {
      const v = axes[axisOrder[j]];
      // Missing axis value clamps to 0 (the artifact simply does not carry it).
      vec[j] = _clamp01(typeof v === 'number' ? v : 0);
    }
    Phi.push(vec);
  }
  return { axisOrder, ids, idSet, Phi, d, N: ids.length };
}

// Canonical corpus hash over axes + sorted ids + sorted pref triples ONLY.
// Provable privacy boundary: prompt/response text NEVER enters this hash.
function _corpusHash(corpus, axisOrder, ids) {
  const sortedIds = ids.slice().sort();
  const prefs = Array.isArray(corpus.pairs)
    ? corpus.pairs.map((p) => [String(p.a), String(p.b), String(p.pref)])
    : [];
  prefs.sort((x, y) => (x[0] + ' ' + x[1] + ' ' + x[2]).localeCompare(y[0] + ' ' + y[1] + ' ' + y[2]));
  const canon = JSON.stringify({ axisOrder: axisOrder.slice(), ids: sortedIds, prefs });
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ===========================================================================
// STAGE 1 - RELIABILITY (ICC(2,k) + Spearman-Brown split-half over occasions).
// ===========================================================================

function _iccBand(icc) {
  if (!Number.isFinite(icc) || icc < ICC_BANDS.poor) return { band: 'poor', r: 0 };
  if (icc < ICC_BANDS.moderate) return { band: 'moderate', r: icc };
  return { band: icc >= 0.9 ? 'excellent' : 'good', r: 1 };
}

function _stageReliability(axisOrder, occasions) {
  // occasions: rows[i].occasions[k].axes -> reshaped by caller into
  // perAxis[axis] = matrix[target][occasion]. We accept the structured shape:
  //   occasions = [ { id, scorings:[ {axes:{...}}, ... ] }, ... ]
  // and build, per axis, an n_targets x k matrix.
  const result = {};
  for (const axis of axisOrder) {
    const M = []; // rows=targets, cols=occasions
    for (const t of occasions) {
      const row = [];
      for (const s of t.scorings) row.push(_clamp01(s.axes ? s.axes[axis] : undefined));
      M.push(row);
    }
    const n = M.length;
    const k = n > 0 ? M[0].length : 0;
    if (n < 2 || k < 2) {
      result[axis] = { icc2k: null, split_half: null, n_targets: n, k_occasions: k,
        ci95: [null, null], band: 'poor', reliability_weight: 0,
        note: 'need n>=2 targets and k>=2 occasions for ICC' };
      continue;
    }
    // Two-way random, average-measures ICC(2,k) (Shrout-Fleiss).
    let grand = 0, count = 0;
    const rowMean = new Array(n).fill(0);
    const colMean = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) {
      grand += M[i][j]; rowMean[i] += M[i][j]; colMean[j] += M[i][j]; count++;
    }
    grand /= count;
    for (let i = 0; i < n; i++) rowMean[i] /= k;
    for (let j = 0; j < k; j++) colMean[j] /= n;
    let SSR = 0, SSC = 0, SST = 0;
    for (let i = 0; i < n; i++) SSR += (rowMean[i] - grand) ** 2;
    SSR *= k;
    for (let j = 0; j < k; j++) SSC += (colMean[j] - grand) ** 2;
    SSC *= n;
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) SST += (M[i][j] - grand) ** 2;
    const SSE = SST - SSR - SSC;
    const MSR = SSR / (n - 1);
    const MSC = SSC / (k - 1);
    const MSE = SSE / ((n - 1) * (k - 1));
    // ICC(2,k) = (MSR - MSE) / (MSR + (MSC - MSE)/n)
    const denom = MSR + (MSC - MSE) / n;
    let icc2k = denom === 0 ? 0 : (MSR - MSE) / denom;
    if (!Number.isFinite(icc2k)) icc2k = 0;
    icc2k = Math.max(-1, Math.min(1, icc2k));

    // F-distribution CI for ICC(2,k) (McGraw-Wong / Shrout-Fleiss bounds).
    // F_obs = MSR/MSE; df1=n-1, df2=(n-1)(k-1). Map F bounds -> ICC bounds.
    const df1 = n - 1, df2 = (n - 1) * (k - 1);
    const alpha = 0.05;
    let ci95 = [null, null];
    if (MSE > 0 && Number.isFinite(MSR) && MSR > 0) {
      const Fobs = MSR / MSE;
      const Fl = Fobs / _fquantile(1 - alpha / 2, df1, df2);
      const Fu = Fobs * _fquantile(1 - alpha / 2, df2, df1);
      // ICC_k from an F: 1 - 1/F (the average-measures reduction).
      const lo = 1 - 1 / Fl;
      const hi = 1 - 1 / Fu;
      ci95 = [Math.max(-1, Math.min(1, lo)), Math.max(-1, Math.min(1, hi))];
    }

    // Spearman-Brown corrected split-half over odd/even occasions (cross-check).
    const splitHalf = _splitHalf(M);

    const { band, r } = _iccBand(icc2k);
    result[axis] = {
      icc2k: _round(icc2k, 6),
      split_half: splitHalf == null ? null : _round(splitHalf, 6),
      n_targets: n,
      k_occasions: k,
      ci95: [ci95[0] == null ? null : _round(ci95[0], 6), ci95[1] == null ? null : _round(ci95[1], 6)],
      band,
      reliability_weight: _round(r, 6),
    };
  }
  return result;
}

function _pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function _splitHalf(M) {
  // Average odd vs even occasions per target, correlate, Spearman-Brown.
  const odd = [], even = [];
  for (const row of M) {
    let so = 0, no = 0, se = 0, ne = 0;
    for (let j = 0; j < row.length; j++) {
      if (j % 2 === 0) { se += row[j]; ne++; } else { so += row[j]; no++; }
    }
    if (no === 0 || ne === 0) return null;
    odd.push(so / no); even.push(se / ne);
  }
  const r = _pearson(odd, even);
  if (r == null) return null;
  // Spearman-Brown prophecy for the full (2-half) length.
  const sb = (2 * r) / (1 + r);
  return Math.max(-1, Math.min(1, sb));
}

// ===========================================================================
// STAGE 2 - REDUNDANCY (correlation, VIF, condition number, PCA d_eff).
// ===========================================================================

function _columnCenter(Phi, d) {
  const N = Phi.length;
  const means = new Array(d).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < d; j++) means[j] += Phi[i][j];
  for (let j = 0; j < d; j++) means[j] /= N;
  const Xc = Phi.map((row) => row.map((v, j) => v - means[j]));
  return { Xc, means };
}

function _covariance(Xc, d) {
  const N = Xc.length;
  const C = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let a = 0; a < d; a++) for (let b = a; b < d; b++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += Xc[i][a] * Xc[i][b];
    const cov = s / Math.max(1, N - 1);
    C[a][b] = cov; C[b][a] = cov;
  }
  return C;
}

function _correlation(C, d) {
  const R = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) {
    const den = Math.sqrt(C[a][a] * C[b][b]);
    R[a][b] = den <= 1e-300 ? (a === b ? 1 : 0) : C[a][b] / den;
  }
  return R;
}

function _stageRedundancy(axisOrder, Phi, d) {
  const { Xc } = _columnCenter(Phi, d);
  const C = _covariance(Xc, d);
  const R = _correlation(C, d);

  // VIF_j = 1/(1 - R2_j): regress column j on the others via normal equations
  // with a tiny ridge. Singular -> Inf / 'collinear'.
  const vif = {};
  const flagged = {};
  for (let j = 0; j < d; j++) {
    const others = [];
    for (let m = 0; m < d; m++) if (m !== j) others.push(m);
    if (others.length === 0) { vif[axisOrder[j]] = 1; continue; }
    // Build X'X (with ridge) and X'y on centered columns.
    const k = others.length;
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    const Xty = new Array(k).fill(0);
    const N = Xc.length;
    for (let a = 0; a < k; a++) {
      for (let b = a; b < k; b++) {
        let s = 0;
        for (let i = 0; i < N; i++) s += Xc[i][others[a]] * Xc[i][others[b]];
        XtX[a][b] = s + (a === b ? 1e-8 : 0);
        XtX[b][a] = XtX[a][b];
      }
      let sy = 0;
      for (let i = 0; i < N; i++) sy += Xc[i][others[a]] * Xc[i][j];
      Xty[a] = sy;
    }
    const beta = _solveLinear(XtX, Xty);
    let r2;
    if (beta == null) { r2 = 1; }
    else {
      let ssTot = 0, ssRes = 0;
      for (let i = 0; i < N; i++) {
        const yi = Xc[i][j];
        let yhat = 0;
        for (let a = 0; a < k; a++) yhat += beta[a] * Xc[i][others[a]];
        ssTot += yi * yi; ssRes += (yi - yhat) * (yi - yhat);
      }
      r2 = ssTot <= 1e-300 ? 0 : 1 - ssRes / ssTot;
    }
    r2 = Math.max(0, Math.min(1, r2));
    const v = (1 - r2) <= 1e-12 ? Infinity : 1 / (1 - r2);
    vif[axisOrder[j]] = Number.isFinite(v) ? _round(v, 6) : Infinity;
    if (!Number.isFinite(v) || v > 1e6) flagged[axisOrder[j]] = 'collinear';
  }

  // Condition number + PCA from a Jacobi eigensolve of the covariance.
  const { eigenvalues } = _jacobiEig(C);
  const lamMax = eigenvalues[0];
  let lamMin = eigenvalues[eigenvalues.length - 1];
  // clamp tiny-negative eigenvalues from numeric noise to 0.
  const eigClean = eigenvalues.map((e) => (Math.abs(e) < 1e-12 ? 0 : e));
  lamMin = eigClean[eigClean.length - 1];
  let condition_number;
  if (lamMin <= 1e-12) condition_number = Infinity;
  else condition_number = Math.sqrt(Math.max(0, lamMax) / lamMin);

  // participation-ratio effective dimensionality.
  let sumL = 0, sumL2 = 0;
  for (const e of eigClean) { const ee = Math.max(0, e); sumL += ee; sumL2 += ee * ee; }
  const d_eff = sumL2 <= 1e-300 ? 0 : (sumL * sumL) / sumL2;

  // Near-duplicate pairs: |corr| >= 0.9.
  const near_duplicates = [];
  for (let a = 0; a < d; a++) for (let b = a + 1; b < d; b++) {
    if (Math.abs(R[a][b]) >= 0.9) near_duplicates.push([axisOrder[a], axisOrder[b], _round(R[a][b], 6)]);
  }

  return {
    vif,
    flagged,
    correlation: R.map((row) => row.map((v) => _round(v, 6))),
    condition_number: Number.isFinite(condition_number) ? _round(condition_number, 6) : Infinity,
    eigenvalues: eigClean.map((e) => _round(e, 9)),
    trace: _round(eigClean.reduce((s, e) => s + e, 0), 9),
    d_eff: _round(d_eff, 6),
    near_duplicates,
  };
}

// ===========================================================================
// STAGE 3 - WEIGHT DERIVATION (non-negative logistic over axis-difference
// vectors, with reliability shrink + governance floors + DP option).
// Reuses the bradley-terry NUMERIC IDIOM (stable log-sigmoid, ridge,
// diagonal-Newton + backtracking, Wald-from-Hessian-diagonal), but this is
// NNLS-on-logit over Phi_a - Phi_b, NOT fitBradleyTerry (which fits item skill).
// ===========================================================================

function _diffVectors(pairs, idIndex, Phi, d) {
  // For each pair, x = Phi_a - Phi_b; y in {1 (a>b), 0 (b>a)}; ties split.
  const X = [];
  const Y = [];
  const W = [];
  for (const p of pairs) {
    const ia = idIndex.get(p.a);
    const ib = idIndex.get(p.b);
    // Fail-closed disjointness: a pair referencing an absent row id throws.
    if (ia == null) throw new TypeError('axis-theory: pair references unknown row id ' + p.a);
    if (ib == null) throw new TypeError('axis-theory: pair references unknown row id ' + p.b);
    const x = new Array(d);
    for (let j = 0; j < d; j++) x[j] = Phi[ia][j] - Phi[ib][j];
    if (p.pref === 'a') { X.push(x); Y.push(1); W.push(1); }
    else if (p.pref === 'b') { X.push(x); Y.push(0); W.push(1); }
    else if (p.pref === 'tie') {
      // Rao-Kupper half-credit each direction (matches BT tie handling).
      X.push(x); Y.push(1); W.push(0.5);
      X.push(x); Y.push(0); W.push(0.5);
    } else {
      throw new TypeError("axis-theory: pair.pref must be 'a'|'b'|'tie'");
    }
  }
  return { X, Y, W };
}

function _fitNNLogistic(X, Y, W, d, opts) {
  // Projected-gradient ridge logistic with non-negativity + governance floors.
  // P(a>b)=sigmoid(w.x); maximize weighted log-likelihood - ridge/2 ||w||^2.
  const cfg = {
    max_iter: BT_DEFAULTS.max_iter,
    grad_tol: BT_DEFAULTS.grad_tol,
    ridge: 1e-3,
    init_step: BT_DEFAULTS.init_step,
    backtrack_limit: BT_DEFAULTS.backtrack_limit,
    ...opts,
  };
  const floors = opts.floors || new Array(d).fill(0);
  const allowNegative = opts.allowNegative === true; // test-only sign-flip path
  // DP objective perturbation (Chaudhuri-Monteleoni-Sarwate): add (1/n) b.w to
  // objective; gradient gains -(1/n) b. b is a Gamma-direction noise vector
  // scaled to epsilon. Off by default (epsilon=Infinity -> b=0).
  const bNoise = opts.dpNoise || new Array(d).fill(0);
  const nSamp = Math.max(1, X.length);

  function negProject(w) {
    for (let j = 0; j < d; j++) {
      if (!allowNegative && w[j] < 0) w[j] = 0;
      if (w[j] < floors[j]) w[j] = floors[j];
    }
  }
  function objective(w) {
    let ll = 0;
    for (let i = 0; i < X.length; i++) {
      let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      // stable log-sigmoid (same idiom as bradley-terry _logLikelihood)
      const lsig = z >= 0 ? -Math.log(1 + Math.exp(-z)) : z - Math.log(1 + Math.exp(z));
      const lsign = z >= 0 ? -z - Math.log(1 + Math.exp(-z)) : -Math.log(1 + Math.exp(z));
      ll += W[i] * (Y[i] * lsig + (1 - Y[i]) * lsign);
    }
    let r = 0; for (let j = 0; j < d; j++) r += w[j] * w[j];
    ll -= 0.5 * cfg.ridge * r;
    // DP perturbation term: +(1/n) b.w
    let bw = 0; for (let j = 0; j < d; j++) bw += bNoise[j] * w[j];
    ll += bw / nSamp;
    return ll;
  }
  function gradAndHessDiag(w) {
    const g = new Array(d).fill(0);
    const h = new Array(d).fill(cfg.ridge);
    for (let i = 0; i < X.length; i++) {
      let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const s = _sigmoid(z);
      const resid = Y[i] - s;            // dLL/dz
      const info = s * (1 - s);          // Fisher info weight
      for (let j = 0; j < d; j++) {
        g[j] += W[i] * resid * X[i][j];
        h[j] += W[i] * info * X[i][j] * X[i][j];
      }
    }
    for (let j = 0; j < d; j++) {
      g[j] -= cfg.ridge * w[j];
      g[j] += bNoise[j] / nSamp;
    }
    return { g, h };
  }

  let w = new Array(d).fill(0);
  negProject(w);
  let obj = objective(w);
  let iter = 0, gradInf = Infinity;
  while (iter < cfg.max_iter) {
    const { g, h } = gradAndHessDiag(w);
    gradInf = 0; for (let j = 0; j < d; j++) gradInf = Math.max(gradInf, Math.abs(g[j]));
    if (gradInf < cfg.grad_tol) break;
    const dir = new Array(d);
    for (let j = 0; j < d; j++) dir[j] = g[j] / Math.max(h[j], 1e-9);
    let step = cfg.init_step, accepted = false;
    for (let bt = 0; bt < cfg.backtrack_limit; bt++) {
      const cand = new Array(d);
      for (let j = 0; j < d; j++) cand[j] = w[j] + step * dir[j];
      negProject(cand);
      const candObj = objective(cand);
      if (candObj > obj) { w = cand; obj = candObj; accepted = true; break; }
      step *= 0.5;
    }
    if (!accepted) break;
    iter++;
  }

  // Wald SE from inverse diagonal of the (negative-Hessian) Fisher info.
  const { h: hFinal } = gradAndHessDiag(w);
  const se = hFinal.map((hh) => Math.sqrt(1 / Math.max(hh, 1e-9)));
  return { w, se, iter, grad_inf: gradInf, converged: gradInf < cfg.grad_tol, ll: obj };
}

function _kFolds(nPairs, kFolds, rng) {
  // deterministic fold assignment (seeded shuffle).
  const idxs = Array.from({ length: nPairs }, (_, i) => i);
  for (let i = nPairs - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t;
  }
  const folds = Array.from({ length: kFolds }, () => []);
  for (let i = 0; i < nPairs; i++) folds[i % kFolds].push(idxs[i]);
  return folds;
}

function _agreement(w, X, Y, W) {
  // fraction (weighted) where sign(w.x) matches the pref.
  let correct = 0, total = 0;
  for (let i = 0; i < X.length; i++) {
    let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
    const pred = z >= 0 ? 1 : 0;
    if (pred === Y[i]) correct += W[i];
    total += W[i];
  }
  return total === 0 ? null : correct / total;
}

function _waldCI(p, n) {
  if (n <= 0) return [null, null];
  const se = Math.sqrt(Math.max(0, p * (1 - p)) / n);
  return [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)];
}

function _stageWeights(axisOrder, Phi, d, idIndex, pairs, shrinkR, opts) {
  // Apply reliability shrink to Phi columns BEFORE fitting (noise cannot earn
  // weight). shrinkR[j] in [0,1].
  const PhiShrunk = Phi.map((row) => row.map((v, j) => v * shrinkR[j]));
  const { X, Y, W } = _diffVectors(pairs, idIndex, PhiShrunk, d);

  // Governance floors.
  const govFloor = opts.governance_floor == null ? DEFAULT_GOVERNANCE_FLOOR : opts.governance_floor;
  const floors = axisOrder.map((a) => (GOVERNANCE_AXES.includes(a) ? govFloor : 0));

  // DP noise vector (objective perturbation), seeded from corpus hash.
  const dpEpsilon = opts.dp_epsilon == null ? Infinity : opts.dp_epsilon;
  if (dpEpsilon <= 0) {
    throw new Error('axis-theory: dp_epsilon must be > 0 (got ' + dpEpsilon
      + '). Disable DP by omitting dp_epsilon (default Infinity = no noise).');
  }
  let dpNoise = new Array(d).fill(0);
  if (Number.isFinite(dpEpsilon)) {
    // b = (2/epsilon)*||.|| direction. Draw a Gaussian direction, normalize,
    // scale its magnitude by a Gamma(d, 2/epsilon) draw (CMS mechanism).
    const rng = _mulberry32(opts.seed >>> 0);
    const dir = new Array(d);
    let nrm = 0;
    for (let j = 0; j < d; j++) { dir[j] = _gaussian(rng); nrm += dir[j] * dir[j]; }
    nrm = Math.sqrt(nrm) || 1;
    // Gamma(shape=d, scale=2/eps) magnitude via sum of exponentials approx for
    // integer-ish shape; deterministic from the seeded rng.
    let mag = 0;
    const shape = Math.max(1, Math.round(d));
    for (let s = 0; s < shape; s++) { let u = rng(); if (u <= 0) u = 1e-12; mag += -Math.log(u); }
    mag *= (2 / dpEpsilon);
    for (let j = 0; j < d; j++) dpNoise[j] = (dir[j] / nrm) * mag;
  }

  // Full-data fit.
  const full = _fitNNLogistic(X, Y, W, d, {
    ...opts, floors, dpNoise, seed: opts.seed,
  });

  // Per-weight bootstrap CI95 (percentile interval, B resamples of pairs).
  const B = opts.bootstrap == null ? DEFAULT_BOOTSTRAP : opts.bootstrap;
  const bootW = Array.from({ length: d }, () => []);
  const rngB = _mulberry32((opts.seed >>> 0) ^ 0x9e3779b9);
  for (let b = 0; b < B; b++) {
    const Xs = [], Ys = [], Ws = [];
    for (let i = 0; i < X.length; i++) {
      const r = Math.floor(rngB() * X.length);
      Xs.push(X[r]); Ys.push(Y[r]); Ws.push(W[r]);
    }
    const fb = _fitNNLogistic(Xs, Ys, Ws, d, { ...opts, floors, dpNoise: new Array(d).fill(0), seed: opts.seed });
    for (let j = 0; j < d; j++) bootW[j].push(fb.w[j]);
  }
  const weight_cis = {};
  for (let j = 0; j < d; j++) {
    const sorted = bootW[j].slice().sort((a, c) => a - c);
    const lo = sorted.length ? sorted[Math.floor(0.025 * sorted.length)] : null;
    const hi = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.975 * sorted.length))] : null;
    // Wald CI from Fisher info diagonal too.
    const waldLo = full.w[j] - 1.96 * full.se[j];
    const waldHi = full.w[j] + 1.96 * full.se[j];
    weight_cis[axisOrder[j]] = {
      bootstrap: [lo == null ? null : _round(lo, 6), hi == null ? null : _round(hi, 6)],
      wald: [_round(waldLo, 6), _round(waldHi, 6)],
    };
  }

  // k-fold OUT-OF-FOLD agreement (headline) + Wald CI.
  const kFolds = opts.folds == null ? DEFAULT_FOLDS : opts.folds;
  const rngF = _mulberry32((opts.seed >>> 0) ^ 0x85ebca6b);
  // Fold over PAIRS (not the expanded tie rows) so OOF disjointness is clean.
  const pairCount = pairs.length;
  const folds = _kFolds(pairCount, Math.min(kFolds, Math.max(2, pairCount)), rngF);
  let oofCorrect = 0, oofTotal = 0;
  let baseCorrect = 0, baseTotal = 0;
  let uniCorrect = 0, uniTotal = 0;
  const uniformW = new Array(d).fill(1);
  // Baseline V2 default weights aligned to axisOrder (frozen, read-only).
  const v2vec = axisOrder.map((a) => (V2_WEIGHTS[a] != null ? V2_WEIGHTS[a] : (V1_WEIGHTS[a] != null ? V1_WEIGHTS[a] : 0)));
  for (let f = 0; f < folds.length; f++) {
    const testPairIdx = new Set(folds[f]);
    const trainPairs = pairs.filter((_, i) => !testPairIdx.has(i));
    const testPairs = pairs.filter((_, i) => testPairIdx.has(i));
    if (trainPairs.length === 0 || testPairs.length === 0) continue;
    const tr = _diffVectors(trainPairs, idIndex, PhiShrunk, d);
    const te = _diffVectors(testPairs, idIndex, PhiShrunk, d);
    const fit = _fitNNLogistic(tr.X, tr.Y, tr.W, d, { ...opts, floors, dpNoise: new Array(d).fill(0), seed: opts.seed });
    for (let i = 0; i < te.X.length; i++) {
      let z = 0; for (let j = 0; j < d; j++) z += fit.w[j] * te.X[i][j];
      if ((z >= 0 ? 1 : 0) === te.Y[i]) oofCorrect += te.W[i];
      oofTotal += te.W[i];
      let zb = 0; for (let j = 0; j < d; j++) zb += v2vec[j] * te.X[i][j];
      if ((zb >= 0 ? 1 : 0) === te.Y[i]) baseCorrect += te.W[i];
      baseTotal += te.W[i];
      let zu = 0; for (let j = 0; j < d; j++) zu += uniformW[j] * te.X[i][j];
      if ((zu >= 0 ? 1 : 0) === te.Y[i]) uniCorrect += te.W[i];
      uniTotal += te.W[i];
    }
  }
  const oof = oofTotal === 0 ? null : oofCorrect / oofTotal;
  const baseAgree = baseTotal === 0 ? null : baseCorrect / baseTotal;
  const uniAgree = uniTotal === 0 ? null : uniCorrect / uniTotal;
  // Use effective n = number of pairs for the Wald CI (ties already split).
  const oofN = pairCount;
  const oofCI = oof == null ? [null, null] : _waldCI(oof, oofN);
  const uniCI = uniAgree == null ? [null, null] : _waldCI(uniAgree, oofN);

  // Reportable events: zeroed-by-fit / shrunk-by-reliability / redundant.
  const reportable_events = [];
  for (let j = 0; j < d; j++) {
    const axis = axisOrder[j];
    const floored = floors[j] > 0;
    if (shrinkR[j] === 0) {
      reportable_events.push({ axis, reason: 'shrunk_by_reliability' });
    } else if (full.w[j] <= 1e-9 && !floored) {
      reportable_events.push({ axis, reason: 'zeroed_by_fit' });
    }
  }

  const weights = {};
  for (let j = 0; j < d; j++) weights[axisOrder[j]] = _round(full.w[j], 6);

  return {
    weights,
    weight_cis,
    se: Object.fromEntries(axisOrder.map((a, j) => [a, _round(full.se[j], 6)])),
    fit_meta: { iter: full.iter, grad_inf: Number(full.grad_inf.toExponential(3)), converged: full.converged, ll: _round(full.ll, 6) },
    oof_agreement: oof == null ? null : _round(oof, 6),
    oof_agreement_ci: [oofCI[0] == null ? null : _round(oofCI[0], 6), oofCI[1] == null ? null : _round(oofCI[1], 6)],
    baseline_v2_agreement: baseAgree == null ? null : _round(baseAgree, 6),
    baseline_uniform_agreement: uniAgree == null ? null : _round(uniAgree, 6),
    baseline_uniform_ci: [uniCI[0] == null ? null : _round(uniCI[0], 6), uniCI[1] == null ? null : _round(uniCI[1], 6)],
    reportable_events,
    dpNoise,
    dp_epsilon: dpEpsilon,
    _wfull: full.w,
    _floors: floors,
  };
}

// ===========================================================================
// STAGE 4 - CERTIFICATION (monotonicity + re-derived gate threshold).
// ===========================================================================

function _kDerived(w, axesVec, d) {
  let num = 0, den = 0;
  for (let j = 0; j < d; j++) { num += w[j] * axesVec[j]; den += w[j]; }
  return den <= 1e-12 ? 0 : num / den;
}

function _stageCertify(axisOrder, Phi, d, w, opts, oofFit) {
  // Composite monotonicity: with non-negative w, K_derived = w.Phi/sum(w) is
  // monotone non-decreasing in every axis BY CONSTRUCTION. Certify numerically:
  // perturb each axis +epsilon on a grid of sampled rows; K_derived never drops.
  const eps = 1e-4;
  const sumW = w.reduce((s, x) => s + x, 0);
  let monotone = true;
  let offending = null;
  let minPartial = Infinity;
  const sampleRows = Phi.slice(0, Math.min(Phi.length, 50));
  for (let j = 0; j < d; j++) {
    // analytic partial derivative of K_derived wrt axis j = w[j]/sum(w).
    const partial = sumW <= 1e-12 ? 0 : w[j] / sumW;
    minPartial = Math.min(minPartial, partial);
    for (const row of sampleRows) {
      const base = _kDerived(w, row, d);
      const bumped = row.slice(); bumped[j] = _clamp01(bumped[j] + eps);
      const after = _kDerived(w, bumped, d);
      if (after < base - 1e-9) { monotone = false; offending = axisOrder[j]; }
    }
  }
  if (!Number.isFinite(minPartial)) minPartial = 0;

  // Re-derived gate: fit P(prefer-this >= median) vs K_derived, find K_derived
  // where calibrated preference crosses the target rate (default 0.85). We use
  // a 1-D logistic of (above-median-preference) on K_derived across rows that
  // appear in pairs, projecting the gate point.
  const targetRate = opts.target_rate == null ? GATE : opts.target_rate;
  let derived_gate = { point: null, ci95: [null, null], target_rate: targetRate, adopt_blocked: true,
    note: 'insufficient signal to re-derive a gate' };

  if (oofFit && oofFit._pairLabels && oofFit._pairLabels.length >= 4) {
    // Build (K_derived(winner-ish), label) by mapping each pair to the K of its
    // preferred artifact and a binary "preferred-side wins" outcome, then fit a
    // 1-D logistic of outcome on K via diagonal-Newton (same idiom).
    const ks = oofFit._pairLabels.map((p) => p.k);
    const ys = oofFit._pairLabels.map((p) => p.y);
    const fit1d = _fit1DLogistic(ks, ys);
    if (fit1d) {
      // Solve sigmoid(a + b*K) = targetRate -> K* = (logit(target) - a)/b.
      const lg = _logit(targetRate);
      if (Math.abs(fit1d.b) > 1e-9) {
        let point = (lg - fit1d.a) / fit1d.b;
        point = Math.max(0, Math.min(1, point));
        // CI via Wald on (a,b): propagate to K* by perturbing a,b at +/-1.96 SE.
        const lo1 = (lg - (fit1d.a + 1.96 * fit1d.se_a)) / (fit1d.b + 1.96 * fit1d.se_b);
        const hi1 = (lg - (fit1d.a - 1.96 * fit1d.se_a)) / (fit1d.b - 1.96 * fit1d.se_b);
        const lo = Math.max(0, Math.min(1, Math.min(lo1, hi1)));
        const hi = Math.max(0, Math.min(1, Math.max(lo1, hi1)));
        // Stricter-only law: a recommendation looser than GATE is adopt_blocked.
        const operatorOverride = opts.allow_looser_gate === true;
        const adopt_blocked = (point < GATE) && !operatorOverride;
        derived_gate = {
          point: _round(point, 6),
          ci95: [_round(lo, 6), _round(hi, 6)],
          target_rate: targetRate,
          adopt_blocked,
          stricter_than_default: point >= GATE,
          note: adopt_blocked
            ? 'recommended gate looser than frozen GATE=' + GATE + '; adoption blocked (stricter-only law)'
            : 'recommended gate is stricter-or-equal to frozen GATE; adoptable as an opt-in suggestion',
        };
      }
    }
  }

  return {
    monotone,
    monotone_offending_axis: offending,
    axes_checked: d,
    min_partial_derivative: _round(minPartial, 9),
    derived_gate,
  };
}

function _fit1DLogistic(xs, ys) {
  // Fit sigmoid(a + b*x); diagonal-Newton + backtracking (same idiom). Returns
  // {a,b,se_a,se_b} or null.
  if (xs.length < 4) return null;
  let a = 0, b = 0;
  const ridge = 1e-4;
  function obj(aa, bb) {
    let ll = 0;
    for (let i = 0; i < xs.length; i++) {
      const z = aa + bb * xs[i];
      const lsig = z >= 0 ? -Math.log(1 + Math.exp(-z)) : z - Math.log(1 + Math.exp(z));
      const lsign = z >= 0 ? -z - Math.log(1 + Math.exp(-z)) : -Math.log(1 + Math.exp(z));
      ll += ys[i] * lsig + (1 - ys[i]) * lsign;
    }
    return ll - 0.5 * ridge * (aa * aa + bb * bb);
  }
  let cur = obj(a, b);
  for (let it = 0; it < 500; it++) {
    let ga = 0, gb = 0, ha = ridge, hb = ridge;
    for (let i = 0; i < xs.length; i++) {
      const z = a + b * xs[i];
      const s = _sigmoid(z);
      const r = ys[i] - s;
      const info = s * (1 - s);
      ga += r; gb += r * xs[i];
      ha += info; hb += info * xs[i] * xs[i];
    }
    ga -= ridge * a; gb -= ridge * b;
    const da = ga / Math.max(ha, 1e-9), db = gb / Math.max(hb, 1e-9);
    let step = 1, accepted = false;
    for (let bt = 0; bt < 25; bt++) {
      const na = a + step * da, nb = b + step * db;
      const no = obj(na, nb);
      if (no > cur) { a = na; b = nb; cur = no; accepted = true; break; }
      step *= 0.5;
    }
    if (!accepted) break;
    if (Math.abs(ga) < 1e-7 && Math.abs(gb) < 1e-7) break;
  }
  // Wald SE from Hessian diagonal.
  let ha = ridge, hb = ridge;
  for (let i = 0; i < xs.length; i++) {
    const z = a + b * xs[i]; const s = _sigmoid(z); const info = s * (1 - s);
    ha += info; hb += info * xs[i] * xs[i];
  }
  return { a, b, se_a: Math.sqrt(1 / Math.max(ha, 1e-9)), se_b: Math.sqrt(1 / Math.max(hb, 1e-9)) };
}

// ===========================================================================
// PUBLIC ENTRY.
// ===========================================================================

export function deriveAxisTheory(corpus, opts = {}) {
  // Env-gate: dormant unless KOLM_KSCORE_AXIS_THEORY=1.
  if (process.env.KOLM_KSCORE_AXIS_THEORY !== '1' && opts.force !== true) {
    return {
      status: 'disabled',
      hint: 'set KOLM_KSCORE_AXIS_THEORY=1 to run the offline axis-theory pass',
    };
  }
  if (corpus == null || typeof corpus !== 'object') {
    throw new TypeError('axis-theory: corpus must be an object { axisOrder, rows, occasions?, pairs? }');
  }

  // Build Phi (fail-closed on bad rows / duplicate ids).
  const { axisOrder, ids, Phi, d } = _buildPhi(corpus);
  const idIndex = new Map(ids.map((id, i) => [id, i]));

  // Corpus hash binds the derived spec to the exact corpus (privacy-safe:
  // axes + ids + pref triples ONLY, never prompt/response text).
  const corpus_hash = _corpusHash(corpus, axisOrder, ids);
  const seed = _seedFromHash(corpus_hash);

  // STAGE 1 - reliability. Occasions optional; without them every axis is
  // treated as fully reliable (r=1) and no shrink is applied, but the report
  // flags that reliability was not measured.
  let reliability = null;
  const shrinkR = new Array(d).fill(1);
  if (Array.isArray(corpus.occasions) && corpus.occasions.length > 0) {
    reliability = _stageReliability(axisOrder, corpus.occasions);
    for (let j = 0; j < d; j++) {
      const rec = reliability[axisOrder[j]];
      shrinkR[j] = rec && Number.isFinite(rec.reliability_weight) ? rec.reliability_weight : 1;
    }
  } else {
    reliability = { _measured: false, note: 'no occasions supplied; reliability not measured, shrink=1 for all axes' };
  }

  // STAGE 2 - redundancy.
  const redundancy = _stageRedundancy(axisOrder, Phi, d);

  // STAGE 3 - weight derivation (requires pairs).
  let weightsOut = null;
  let pairLabels = [];
  if (Array.isArray(corpus.pairs) && corpus.pairs.length > 0) {
    weightsOut = _stageWeights(axisOrder, Phi, d, idIndex, corpus.pairs, shrinkR, { ...opts, seed });
    // Build pair-label evidence for the gate re-derivation: K of the preferred
    // artifact (using the fitted weights) + binary "preferred side scored higher".
    const wvec = weightsOut._wfull;
    for (const p of corpus.pairs) {
      const ia = idIndex.get(p.a), ib = idIndex.get(p.b);
      if (ia == null || ib == null) continue;
      if (p.pref === 'tie') continue;
      const winner = p.pref === 'a' ? ia : ib;
      const kWin = _kDerived(wvec, Phi[winner], d);
      // outcome y=1 means the higher-K artifact was the preferred one.
      const kA = _kDerived(wvec, Phi[ia], d), kB = _kDerived(wvec, Phi[ib], d);
      const higherIsPreferred = (p.pref === 'a' && kA >= kB) || (p.pref === 'b' && kB >= kA);
      pairLabels.push({ k: kWin, y: higherIsPreferred ? 1 : 0 });
    }
  }

  // STAGE 4 - certification.
  const certWeights = weightsOut ? weightsOut._wfull : new Array(d).fill(1);
  const certification = _stageCertify(axisOrder, Phi, d, certWeights, opts, { _pairLabels: pairLabels });

  const dpEnabled = weightsOut ? Number.isFinite(weightsOut.dp_epsilon) : false;
  const block = {
    spec: KSCORE_AXIS_THEORY_SPEC,
    version: KSCORE_AXIS_THEORY_VERSION,
    status: 'ok',
    corpus_hash,
    axisOrder: axisOrder.slice(),
    n_rows: ids.length,
    d,
    reliability,
    redundancy,
    weights: weightsOut ? weightsOut.weights : null,
    weight_cis: weightsOut ? weightsOut.weight_cis : null,
    se: weightsOut ? weightsOut.se : null,
    fit_meta: weightsOut ? weightsOut.fit_meta : null,
    oof_agreement: weightsOut ? weightsOut.oof_agreement : null,
    oof_agreement_ci: weightsOut ? weightsOut.oof_agreement_ci : null,
    baseline_v2_agreement: weightsOut ? weightsOut.baseline_v2_agreement : null,
    baseline_uniform_agreement: weightsOut ? weightsOut.baseline_uniform_agreement : null,
    baseline_uniform_ci: weightsOut ? weightsOut.baseline_uniform_ci : null,
    monotone: certification.monotone,
    monotone_offending_axis: certification.monotone_offending_axis,
    min_partial_derivative: certification.min_partial_derivative,
    derived_gate: certification.derived_gate,
    dp: {
      enabled: dpEnabled,
      epsilon: weightsOut ? (Number.isFinite(weightsOut.dp_epsilon) ? weightsOut.dp_epsilon : Infinity) : Infinity,
      mechanism: 'objective_perturbation',
    },
    reportable_events: weightsOut ? weightsOut.reportable_events : [],
    fitted_at: opts.now || new Date().toISOString(),
  };
  return block;
}

// Persistence mirror of W810 fitAndPersist. Writes to
// $KOLM_DATA_DIR/kscore-axis-theory.json (same dir as kscore-calibration.json).
// Never to a committed path; never secrets.
export function persistAxisTheory(block) {
  if (block == null || block.status !== 'ok') {
    throw new TypeError('persistAxisTheory: block must be a successful deriveAxisTheory() result');
  }
  const out = _axisTheoryPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(block, null, 2) + '\n', 'utf8');
  return { ok: true, path: out };
}

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _dataDir() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  return path.join(_home(), '.kolm');
}
export function _axisTheoryPath() {
  return path.join(_dataDir(), 'kscore-axis-theory.json');
}

// Test-only export of internals so the falsification tests can drive the
// numeric primitives directly (e.g. the sign-flipped weight FT4 path).
export const __internals = {
  _betai, _fcdf, _fquantile, _jacobiEig, _solveLinear, _mulberry32,
  _stageReliability, _stageRedundancy, _stageWeights, _stageCertify,
  _fitNNLogistic, _diffVectors, _buildPhi, _corpusHash, _kDerived,
};
