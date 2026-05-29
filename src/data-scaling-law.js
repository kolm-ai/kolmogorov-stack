// KOLM Data Engine — data-scaling-law / Chinchilla-style data-budget model (W921).
//
// Replaces the hand-tuned, single-anchor, log-saturating pairs heuristic with a
// DATA-DRIVEN scaling curve fitted per (tenant, namespace) from observed
// (n_pairs, K-Score) points, so the autopilot can answer "how many MORE pairs to
// reach target K, and is the next batch worth the spend?" with a defensible
// number instead of a fixed +500/+150 prior.
//
// MODEL: the RECTIFIED SCALING LAW (Lin et al., arXiv:2402.02314) — the only
// published law that captures the small-data "pre-power phase" that IS kolm's
// regime (sub-1000 pairs). In loss space:
//
//     L_hat(D) = B / (D_l + D^beta) + E
//
//   D    = n_pairs (fine-tune data size)
//   B>0  = initial-loss scale
//   D_l>=0 = "pre-learned data size" — how much signal the base model already
//            carries from pretraining (large D_l => flat-then-bends curve). This
//            term is what makes the law fit at small n where a vanilla power law
//            fails.
//   beta>0 = learning-difficulty exponent (smaller => harder task)
//   E>=0   = irreducible loss at infinite data.
//
// K-Score lives in [0,1] (higher = better), NOT loss. Bridge with a monotone
// link L = -ln(K) (K=1 -> L=0, K->0 -> L->inf, strictly decreasing): fit the law
// in L-space (where the power-law math holds), map predictions back via
// K_hat(D) = exp(-L_hat(D)). The K-domain curve is monotone-increasing and
// saturating in D — exactly the shape the heuristic hand-approximates, fitted.
//
// FITTING (Hitchhiker's-Guide recipe, arXiv:2410.11840): minimize HUBER loss of
// the LOG-residual r = ln(L_hat) - ln(L_obs) over log-parameterized positive
// params, optimized with a pure-JS Nelder-Mead simplex from a GRID of
// initializations (the loss surface is non-convex; keep the best seed). Report
// fit RMSD; gate "trust the fit" on RMSD <= gate AND n_points >= min_points.
//
// DERIVED QUANTITIES the autopilot consumes:
//   kHatAtSize(fit, D)         — point estimate of K at any data size
//   marginalDkPerRow(fit, D)   — analytic dK_hat/dD, the true economic signal
//   pairsToTarget(fit, K)      — closed-form data size to hit a target K
//   recommendDataBudget(...)   — acquire | stop | switch_strategy + cost
//
// CAVEATS CONTRACT: cold start (n_points<min) or junk fit (rmsd>gate) returns
// basis:'insufficient', ok:true, no params — the caller falls through to its
// existing heuristic. Determinism: identical points + seed grid => identical
// params (bit-stable). Pure JS, zero new deps. NEVER throws across the public
// API.

export const SCALING_LAW_VERSION = 'sl-v1';

// K <-> pseudo-loss bridge. Clamp K away from {0,1} so the log is finite.
const _K_LO = 1e-3;
const _K_HI = 1 - 1e-3;

export function _kToPseudoLoss(k) {
  const kk = Math.max(_K_LO, Math.min(_K_HI, Number(k)));
  return -Math.log(kk);
}

export function _pseudoLossToK(l) {
  const ll = Math.max(0, Number(l));
  return Math.exp(-ll);
}

// ── model in loss space ───────────────────────────────────────────────────────

// theta = [lnB, lnD_l_p1, beta, lnE]; we parameterize D_l via ln(D_l+1) so the
// optimizer is unconstrained AND D_l can reach 0 (ln(0+1)=0).
function _unpack(theta) {
  return {
    B: Math.exp(theta[0]),
    D_l: Math.exp(theta[1]) - 1,
    beta: Math.max(1e-4, theta[2]),
    E: Math.exp(theta[3]),
  };
}

function _pack(params) {
  return [
    Math.log(Math.max(1e-9, params.B)),
    Math.log(Math.max(1e-9, params.D_l + 1)),
    Math.max(1e-4, params.beta),
    Math.log(Math.max(1e-12, params.E)),
  ];
}

function _lossAt(params, D) {
  const denom = params.D_l + Math.pow(Math.max(1e-9, D), params.beta);
  return params.B / Math.max(1e-12, denom) + params.E;
}

// ── Huber-on-log-residual objective ───────────────────────────────────────────

function _huber(r, delta) {
  const a = Math.abs(r);
  return a <= delta ? 0.5 * r * r : delta * (a - 0.5 * delta);
}

/**
 * _huberLogResidualLoss(theta, points, delta) — sum of Huber(ln L_hat - ln L_obs)
 * @param {number[]} theta  [lnB, lnD_l_p1, beta, lnE]
 * @param {Array<[number,number]>} points  [[D, L_obs], ...]
 * @param {number} delta
 * @returns {number}
 */
export function _huberLogResidualLoss(theta, points, delta = 1e-3) {
  const params = _unpack(theta);
  if (!(params.beta > 0) || !Number.isFinite(params.B) || !Number.isFinite(params.E)) return 1e12;
  let acc = 0;
  for (const [D, Lobs] of points) {
    const Lhat = _lossAt(params, D);
    if (!(Lhat > 0) || !Number.isFinite(Lhat)) return 1e12;
    const r = Math.log(Lhat) - Math.log(Math.max(1e-9, Lobs));
    acc += _huber(r, delta);
  }
  return acc;
}

// ── pure-JS Nelder-Mead simplex ───────────────────────────────────────────────

/**
 * _nelderMead(objective, x0, opts) — downhill simplex (Nelder-Mead 1965).
 * Deterministic given x0. No external numeric deps.
 * @param {(x:number[])=>number} objective
 * @param {number[]} x0
 * @param {object} [opts]
 * @returns {{x:number[], fx:number, iters:number}}
 */
export function _nelderMead(objective, x0, opts = {}) {
  const maxIter = Number.isFinite(opts.maxIter) ? opts.maxIter : 800;
  const tol = Number.isFinite(opts.tol) ? opts.tol : 1e-8;
  const n = x0.length;
  const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
  // initial simplex: x0 plus n perturbed vertices (deterministic step)
  const step = Number.isFinite(opts.step) ? opts.step : 0.5;
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += (v[i] !== 0 ? step * Math.abs(v[i]) : step) + step;
    simplex.push(v);
  }
  let fvals = simplex.map((v) => objective(v));
  let iters = 0;
  for (; iters < maxIter; iters++) {
    // order by objective ascending
    const order = Array.from({ length: n + 1 }, (_, i) => i).sort((a, b) => fvals[a] - fvals[b]);
    const sx = order.map((i) => simplex[i]);
    const sf = order.map((i) => fvals[i]);
    // convergence: spread of function values is tiny
    if (Math.abs(sf[n] - sf[0]) <= tol * (Math.abs(sf[0]) + tol)) {
      return { x: sx[0].slice(), fx: sf[0], iters };
    }
    // centroid of all but worst
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let d = 0; d < n; d++) cen[d] += sx[i][d];
    for (let d = 0; d < n; d++) cen[d] /= n;
    // reflection
    const xr = cen.map((c, d) => c + alpha * (c - sx[n][d]));
    const fr = objective(xr);
    if (fr < sf[0]) {
      // expansion
      const xe = cen.map((c, d) => c + gamma * (xr[d] - c));
      const fe = objective(xe);
      if (fe < fr) { sx[n] = xe; sf[n] = fe; } else { sx[n] = xr; sf[n] = fr; }
    } else if (fr < sf[n - 1]) {
      sx[n] = xr; sf[n] = fr;
    } else {
      // contraction
      const xc = cen.map((c, d) => c + rho * (sx[n][d] - c));
      const fc = objective(xc);
      if (fc < sf[n]) { sx[n] = xc; sf[n] = fc; }
      else {
        // shrink toward best
        for (let i = 1; i <= n; i++) {
          for (let d = 0; d < n; d++) sx[i][d] = sx[0][d] + sigma * (sx[i][d] - sx[0][d]);
          sf[i] = objective(sx[i]);
        }
      }
    }
    // write back the reordered+updated simplex
    for (let i = 0; i <= n; i++) { simplex[i] = sx[i]; fvals[i] = sf[i]; }
  }
  // return best vertex
  let bi = 0;
  for (let i = 1; i <= n; i++) if (fvals[i] < fvals[bi]) bi = i;
  return { x: simplex[bi].slice(), fx: fvals[bi], iters };
}

// ── seed grid ─────────────────────────────────────────────────────────────────

/**
 * _seedInitializations(points) — grid of starting thetas + a closed-form linear
 * seed. The loss surface is non-convex so we fit from each and keep the best.
 * @param {Array<[number,number]>} points  [[D, L_obs], ...]
 * @returns {number[][]}  array of theta seeds
 */
export function _seedInitializations(points) {
  const Ds = points.map((p) => p[0]);
  const Ls = points.map((p) => p[1]);
  const nMin = Math.min(...Ds);
  const meanD = Ds.reduce((a, b) => a + b, 0) / Ds.length;
  const minL = Math.min(...Ls);
  const maxL = Math.max(...Ls);
  // E seed: a fraction of the smallest observed loss (the asymptote sits below it)
  const Eseeds = [Math.max(1e-6, 0.5 * minL), Math.max(1e-6, 0.1 * minL)];
  const Bseeds = [Math.max(1e-3, (maxL - minL) * meanD), Math.max(1e-3, maxL)];
  const betaSeeds = [0.05, 0.1, 0.2, 0.4];
  const DlSeeds = [0, Math.max(0, nMin), Math.max(0, meanD)];
  const seeds = [];
  for (const B of Bseeds) for (const Dl of DlSeeds) for (const beta of betaSeeds) for (const E of Eseeds) {
    seeds.push(_pack({ B, D_l: Dl, beta, E }));
  }
  return seeds;
}

// ── fit ───────────────────────────────────────────────────────────────────────

/**
 * fitDataScalingLaw — fit the rectified law to observed (n_pairs, K) points.
 * Points are provided directly OR (when omitted) read from kscore-timeseries for
 * the (tenant, namespace) via the injectable loader.
 *
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {Array<{n_pairs:number,k:number}>|Array<[number,number]>} [args.points]
 * @param {number} [args.min_points=4]
 * @param {number} [args.rmsd_gate=0.05]
 * @param {Function} [args.loadPoints]  injectable async ({tenant,namespace})=>points
 * @returns {Promise<object>} {ok, version, params?, rmsd?, n_points?, basis, achievable_k_max?, error?}
 */
export async function fitDataScalingLaw({ tenant, namespace, points = null, min_points = 4, rmsd_gate = 0.05, loadPoints = null } = {}) {
  try {
    let pts = points;
    if (!Array.isArray(pts) && typeof loadPoints === 'function') {
      try { pts = await loadPoints({ tenant, namespace }); } catch (_) { pts = null; }
    }
    pts = _normalizePoints(pts);

    const base = { ok: true, version: SCALING_LAW_VERSION, n_points: pts.length };

    if (pts.length < Math.max(2, min_points | 0)) {
      return { ...base, basis: 'insufficient', reason: 'too_few_points' };
    }

    // (D, L_obs) in loss space
    const lossPts = pts.map(([D, K]) => [D, _kToPseudoLoss(K)]);

    const seeds = _seedInitializations(lossPts);
    let best = null;
    for (const s of seeds) {
      const r = _nelderMead((x) => _huberLogResidualLoss(x, lossPts, 1e-3), s, { maxIter: 600, tol: 1e-10 });
      if (best == null || r.fx < best.fx) best = r;
    }
    const params = _unpack(best.x);

    // RMSD in K-space (the metric the caller cares about)
    let sq = 0;
    for (const [D, K] of pts) {
      const khat = _pseudoLossToK(_lossAt(params, D));
      const e = khat - K;
      sq += e * e;
    }
    const rmsd = Math.sqrt(sq / pts.length);
    const achievable_k_max = _pseudoLossToK(params.E); // K as D->inf

    if (!Number.isFinite(rmsd) || rmsd > Number(rmsd_gate)) {
      return { ...base, basis: 'insufficient', reason: 'rmsd_above_gate', rmsd: Number(rmsd.toFixed(6)) };
    }

    return {
      ...base,
      basis: 'rectified',
      params: {
        B: Number(params.B.toFixed(8)),
        D_l: Number(params.D_l.toFixed(6)),
        beta: Number(params.beta.toFixed(8)),
        E: Number(params.E.toFixed(8)),
      },
      rmsd: Number(rmsd.toFixed(6)),
      achievable_k_max: Number(achievable_k_max.toFixed(6)),
    };
  } catch (e) {
    return { ok: false, version: SCALING_LAW_VERSION, basis: 'insufficient', error: String((e && e.message) || e) };
  }
}

function _normalizePoints(pts) {
  if (!Array.isArray(pts)) return [];
  const out = [];
  for (const p of pts) {
    let D, K;
    if (Array.isArray(p)) { D = Number(p[0]); K = Number(p[1]); }
    else if (p && typeof p === 'object') {
      D = Number(p.n_pairs != null ? p.n_pairs : p.D);
      K = Number(p.k != null ? p.k : (p.K != null ? p.K : p.kscore));
    } else continue;
    if (Number.isFinite(D) && D > 0 && Number.isFinite(K)) out.push([D, K]);
  }
  // de-dup on D keeping last, sort ascending — stable input to the fitter
  const byD = new Map();
  for (const [D, K] of out) byD.set(D, K);
  return [...byD.entries()].sort((a, b) => a[0] - b[0]);
}

// ── derived quantities ────────────────────────────────────────────────────────

function _params(fit) {
  if (fit && fit.params) return fit.params;
  if (fit && Number.isFinite(fit.B)) return fit;
  return null;
}

/** kHatAtSize(fit, n_pairs) -> K_hat(D) via exp(-(B/(D_l+D^beta)+E)) */
export function kHatAtSize(fit, n_pairs) {
  const p = _params(fit);
  if (!p) return NaN;
  const D = Math.max(0, Number(n_pairs));
  const L = p.B / Math.max(1e-12, (p.D_l + Math.pow(Math.max(1e-9, D), p.beta))) + p.E;
  return _pseudoLossToK(L);
}

/**
 * marginalDkPerRow(fit, n_pairs) -> analytic dK_hat/dD.
 *   K = exp(-L), L = B/(D_l+D^beta)+E
 *   dL/dD = -B*beta*D^(beta-1) / (D_l+D^beta)^2
 *   dK/dD = -K * dL/dD = K * B*beta*D^(beta-1) / (D_l+D^beta)^2
 */
export function marginalDkPerRow(fit, n_pairs) {
  const p = _params(fit);
  if (!p) return NaN;
  const D = Math.max(1e-9, Number(n_pairs));
  const denom = p.D_l + Math.pow(D, p.beta);
  const K = kHatAtSize(fit, D);
  const dk = K * (p.B * p.beta * Math.pow(D, p.beta - 1)) / Math.max(1e-12, denom * denom);
  return Number.isFinite(dk) ? dk : 0;
}

/**
 * pairsToTarget(fit, k_target) -> closed-form data size to reach K_target.
 *   Lt = -ln(K_target); D_target = ((B/(Lt-E)) - D_l)^(1/beta) when Lt>E
 *   else Infinity (target above the asymptote exp(-E)).
 */
export function pairsToTarget(fit, k_target) {
  const p = _params(fit);
  const k_max = p ? _pseudoLossToK(p.E) : NaN;
  if (!p) return { ok: false, pairs_to_target: null, reachable: false, k_max: NaN };
  const Lt = _kToPseudoLoss(k_target);
  if (!(Lt > p.E)) {
    return { ok: true, pairs_to_target: null, reachable: false, k_max: Number(k_max.toFixed(6)) };
  }
  const inner = (p.B / (Lt - p.E)) - p.D_l;
  if (!(inner > 0)) {
    // target already reachable at D->0+; report a minimal size of 1
    return { ok: true, pairs_to_target: 1, reachable: true, k_max: Number(k_max.toFixed(6)) };
  }
  const D = Math.pow(inner, 1 / p.beta);
  return {
    ok: true,
    pairs_to_target: Number.isFinite(D) ? Math.ceil(D) : null,
    reachable: Number.isFinite(D),
    k_max: Number(k_max.toFixed(6)),
  };
}

/**
 * recommendDataBudget — acquire | stop | switch_strategy with a projected cost.
 * Advisory ONLY to data acquisition; never a deploy trigger.
 * @returns {{recommend, pairs_to_target, marginal_dk_per_row, projected_cost_to_target_usd, reason}}
 */
export function recommendDataBudget({
  fit,
  current_pairs,
  target_kscore,
  min_delta_k = 0.01,
  expected_batch_rows = 100,
  budget_headroom_usd = Infinity,
  cost_per_row_usd = 0,
} = {}) {
  const p = _params(fit);
  const cur = Math.max(0, Number(current_pairs) || 0);
  const marginal = p ? marginalDkPerRow(fit, cur) : 0;
  const ptt = p ? pairsToTarget(fit, target_kscore) : { reachable: false, pairs_to_target: null, k_max: NaN };

  if (!p) {
    return { recommend: 'acquire', pairs_to_target: null, marginal_dk_per_row: 0, projected_cost_to_target_usd: null, reason: 'no_fit:fall_through_to_heuristic' };
  }
  if (!ptt.reachable) {
    return {
      recommend: 'switch_strategy',
      pairs_to_target: null,
      marginal_dk_per_row: Number(marginal.toFixed(8)),
      projected_cost_to_target_usd: null,
      reason: 'target_above_achievable_k_max:' + (ptt.k_max),
    };
  }
  const remaining = Math.max(0, (ptt.pairs_to_target || 0) - cur);
  const projected_cost = Number((remaining * (Number(cost_per_row_usd) || 0)).toFixed(6));
  const batchGain = marginal * Math.max(1, Number(expected_batch_rows) || 1);

  if (batchGain < Number(min_delta_k)) {
    return {
      recommend: 'stop',
      pairs_to_target: ptt.pairs_to_target,
      marginal_dk_per_row: Number(marginal.toFixed(8)),
      projected_cost_to_target_usd: projected_cost,
      reason: 'next_batch_below_min_delta_k',
    };
  }
  if (Number.isFinite(budget_headroom_usd) && projected_cost > budget_headroom_usd) {
    return {
      recommend: 'stop',
      pairs_to_target: ptt.pairs_to_target,
      marginal_dk_per_row: Number(marginal.toFixed(8)),
      projected_cost_to_target_usd: projected_cost,
      reason: 'projected_cost_exceeds_budget_headroom',
    };
  }
  return {
    recommend: 'acquire',
    pairs_to_target: ptt.pairs_to_target,
    marginal_dk_per_row: Number(marginal.toFixed(8)),
    projected_cost_to_target_usd: projected_cost,
    reason: 'next_batch_clears_min_delta_k',
  };
}

export const __internals = {
  _unpack,
  _pack,
  _lossAt,
  _normalizePoints,
  _huber,
};

export default {
  SCALING_LAW_VERSION,
  fitDataScalingLaw,
  kHatAtSize,
  marginalDkPerRow,
  pairsToTarget,
  recommendDataBudget,
  _kToPseudoLoss,
  _pseudoLossToK,
  _huberLogResidualLoss,
  _nelderMead,
  _seedInitializations,
  __internals,
};
