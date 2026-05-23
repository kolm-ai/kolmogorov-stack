// W810-2 — Bradley-Terry latent-skill fitter (pure JS).
//
// Mission: estimate per-item latent "skill" parameters theta_i from pairwise
// human preferences such that
//
//     P(item i preferred over item j) = sigmoid(theta_i - theta_j)
//
// We fit by maximizing the logistic log-likelihood with gradient ascent +
// simple line search. Ties (human_preference === 'tie') contribute half-weight
// to BOTH directions (Rao-Kupper style). Identifiability is anchored by
// pinning the mean of theta to zero (centered solution) so that absolute
// levels don't drift.
//
// Why pure JS: this code runs (a) inside the K-Score envelope path, which is
// already in the request-serving hot path, and (b) in a quarterly recalibration
// CLI script with no Python toolchain installed. Pulling in a numerical
// dependency for a 2D logistic likelihood is the wrong shape.
//
// Convergence: max 1000 iterations OR |grad|_inf < 1e-6 (whichever comes
// first). On exit, also computes the Wald CI95 from the inverse of the
// diagonal of the negative Hessian (approximation that's exact for the
// per-parameter variance and is what every BT fitter in the wild reports).
//
// Inputs:
//   pairs: Array<{a: string, b: string, pref: 'a'|'b'|'tie', weight?: number}>
//     - 'pref:a' means "a was preferred over b"
//     - 'pref:b' means "b was preferred over a"
//     - 'pref:tie' splits the credit
//     - optional 'weight' lets the caller pass importance weights; default 1
//
// Outputs (object):
//   theta: Record<itemId, number>      latent skill in logit space, centered
//   se:    Record<itemId, number>      Wald standard error (used for ci95)
//   n_items: number
//   n_pairs: number
//   iter:    number                    iterations executed
//   grad_inf: number                   final |grad|_inf
//   ll:      number                    final log-likelihood
//   converged: boolean                 true iff grad_inf < grad_tol
//
// The mapping back to a "human preference rate" calibration curve lives in
// `src/kscore-calibration.js` — this module deliberately does NOT know
// anything about K-Score axes. It just fits BT.

export const BRADLEY_TERRY_SPEC = 'kolm-bradley-terry-1';

// Hyperparameters. Exported so tests can dial them down for tiny fixtures.
export const BT_DEFAULTS = Object.freeze({
  max_iter: 1000,
  grad_tol: 1e-6,
  // L2 regularization toward 0. Tiny ridge keeps the Hessian invertible when
  // a single item appears in only one pair, and prevents the centering
  // constraint from leaking into infinite likelihood for separated subgraphs.
  ridge: 1e-3,
  // Line-search: start at this step, halve up to backtrack_limit times if
  // the LL does not improve.
  init_step: 1.0,
  backtrack_limit: 25,
});

function _sigmoid(x) {
  // Numerically stable sigmoid: avoids exp(big positive) overflow.
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function _logLikelihood(theta, pairs, idx, ridge) {
  let ll = 0;
  for (const p of pairs) {
    const ti = theta[idx.get(p.a)];
    const tj = theta[idx.get(p.b)];
    const d = ti - tj;
    const w = (p.weight == null) ? 1 : p.weight;
    if (p.pref === 'a') {
      // log sigmoid(d)
      ll += w * (d >= 0 ? -Math.log(1 + Math.exp(-d)) : d - Math.log(1 + Math.exp(d)));
    } else if (p.pref === 'b') {
      // log sigmoid(-d) = -d - log(1 + exp(-d)) for d>=0
      ll += w * (d >= 0 ? -d - Math.log(1 + Math.exp(-d)) : -Math.log(1 + Math.exp(d)));
    } else {
      // tie: half credit each way (Rao-Kupper degenerate; tie strength=1)
      const la = (d >= 0) ? -Math.log(1 + Math.exp(-d)) : d - Math.log(1 + Math.exp(d));
      const lb = (d >= 0) ? -d - Math.log(1 + Math.exp(-d)) : -Math.log(1 + Math.exp(d));
      ll += 0.5 * w * (la + lb);
    }
  }
  // L2 ridge keeps things stable; the ridge term is -ridge/2 * ||theta||^2 in
  // the log-likelihood. (The corresponding gradient term is -ridge*theta.)
  let r = 0;
  for (let i = 0; i < theta.length; i++) r += theta[i] * theta[i];
  return ll - 0.5 * ridge * r;
}

function _grad(theta, pairs, idx, ridge) {
  const g = new Array(theta.length).fill(0);
  for (const p of pairs) {
    const ia = idx.get(p.a);
    const ib = idx.get(p.b);
    const d = theta[ia] - theta[ib];
    const sa = _sigmoid(d);          // P(a beats b)
    const sb = 1 - sa;
    const w = (p.weight == null) ? 1 : p.weight;
    let contrib;
    if (p.pref === 'a') contrib = w * (1 - sa);
    else if (p.pref === 'b') contrib = w * (-sa);
    else contrib = w * (0.5 - sa);   // tie: pulls toward 0.5
    g[ia] += contrib;
    g[ib] -= contrib;
    // sa/sb suppression warning silencer (not used after assignment but kept
    // for symmetry with the Hessian path which DOES need both)
    void sb;
  }
  for (let i = 0; i < theta.length; i++) g[i] -= ridge * theta[i];
  return g;
}

function _hessianDiag(theta, pairs, idx, ridge) {
  // Diagonal of the negative Hessian. For BT:
  //   -d2L/dthetai^2 = sum_{pairs touching i} w * sa * (1-sa) + ridge
  // Off-diagonal entries are -w*sa*(1-sa) for the partner; we only need the
  // diagonal for Wald per-item SE. Documented approximation.
  const h = new Array(theta.length).fill(ridge);
  for (const p of pairs) {
    const ia = idx.get(p.a);
    const ib = idx.get(p.b);
    const d = theta[ia] - theta[ib];
    const sa = _sigmoid(d);
    const w = (p.weight == null) ? 1 : p.weight;
    const info = w * sa * (1 - sa);
    h[ia] += info;
    h[ib] += info;
  }
  return h;
}

function _gradInf(g) {
  let m = 0;
  for (let i = 0; i < g.length; i++) {
    const a = Math.abs(g[i]);
    if (a > m) m = a;
  }
  return m;
}

export function fitBradleyTerry(pairs, opts = {}) {
  const cfg = { ...BT_DEFAULTS, ...opts };
  if (!Array.isArray(pairs)) {
    throw new TypeError('fitBradleyTerry: pairs must be an array');
  }
  // Index distinct item ids in stable insertion order so tests are
  // deterministic across runs and platforms.
  const idx = new Map();
  const order = [];
  for (const p of pairs) {
    if (p == null || typeof p !== 'object') {
      throw new TypeError('fitBradleyTerry: pair must be {a,b,pref}');
    }
    if (typeof p.a !== 'string' || typeof p.b !== 'string') {
      throw new TypeError('fitBradleyTerry: a and b must be string ids');
    }
    if (p.pref !== 'a' && p.pref !== 'b' && p.pref !== 'tie') {
      throw new TypeError("fitBradleyTerry: pref must be 'a'|'b'|'tie'");
    }
    if (p.a === p.b) {
      throw new TypeError('fitBradleyTerry: self-pair rejected (' + p.a + ')');
    }
    if (!idx.has(p.a)) { idx.set(p.a, order.length); order.push(p.a); }
    if (!idx.has(p.b)) { idx.set(p.b, order.length); order.push(p.b); }
  }

  if (order.length === 0) {
    return {
      spec: BRADLEY_TERRY_SPEC,
      theta: {},
      se: {},
      n_items: 0,
      n_pairs: 0,
      iter: 0,
      grad_inf: 0,
      ll: 0,
      converged: true,
    };
  }

  let theta = new Array(order.length).fill(0);
  let ll = _logLikelihood(theta, pairs, idx, cfg.ridge);
  let g = _grad(theta, pairs, idx, cfg.ridge);
  let iter = 0;
  let gradInf = _gradInf(g);

  while (iter < cfg.max_iter && gradInf >= cfg.grad_tol) {
    // Quasi-Newton direction using the diagonal of the (negative) Hessian.
    // For BT, the diagonal IS the per-item Fisher information so it captures
    // the dominant curvature; this gives near-quadratic tail convergence
    // without requiring a full Hessian inversion. Pure gradient ascent
    // crawled past 1e-5 in 1000 iters on the simplest 3-item fixture.
    const hDiag = _hessianDiag(theta, pairs, idx, cfg.ridge);
    const dir = new Array(theta.length);
    for (let i = 0; i < theta.length; i++) {
      dir[i] = g[i] / Math.max(hDiag[i], 1e-9);
    }
    // Backtracking line search along the scaled direction.
    let step = cfg.init_step;
    let accepted = false;
    let nextTheta = theta;
    let nextLL = ll;
    for (let bt = 0; bt < cfg.backtrack_limit; bt++) {
      const candidate = new Array(theta.length);
      for (let i = 0; i < theta.length; i++) candidate[i] = theta[i] + step * dir[i];
      // Re-center after each step so the mean stays at 0 (BT identifiability
      // — overall level is unidentifiable without an anchor).
      let mean = 0;
      for (let i = 0; i < candidate.length; i++) mean += candidate[i];
      mean /= candidate.length;
      for (let i = 0; i < candidate.length; i++) candidate[i] -= mean;
      const candLL = _logLikelihood(candidate, pairs, idx, cfg.ridge);
      if (candLL > ll) {
        nextTheta = candidate;
        nextLL = candLL;
        accepted = true;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) break;        // line search collapsed -> at a local max
    theta = nextTheta;
    ll = nextLL;
    g = _grad(theta, pairs, idx, cfg.ridge);
    gradInf = _gradInf(g);
    iter += 1;
  }

  const hDiag = _hessianDiag(theta, pairs, idx, cfg.ridge);
  const thetaOut = {};
  const seOut = {};
  for (let i = 0; i < order.length; i++) {
    thetaOut[order[i]] = theta[i];
    const v = 1 / Math.max(hDiag[i], 1e-9);
    seOut[order[i]] = Math.sqrt(v);
  }

  return {
    spec: BRADLEY_TERRY_SPEC,
    theta: thetaOut,
    se: seOut,
    n_items: order.length,
    n_pairs: pairs.length,
    iter,
    grad_inf: gradInf,
    ll,
    converged: gradInf < cfg.grad_tol,
  };
}

// Predict P(item a beats item b) given a fit (or any theta dict).
export function predictPairProb(fit, a, b) {
  const ta = fit.theta[a];
  const tb = fit.theta[b];
  if (ta == null || tb == null) return null;
  return _sigmoid(ta - tb);
}
