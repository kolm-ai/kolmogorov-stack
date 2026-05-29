// KOLM Data Engine — diversity-aware active selection (BADGE / k-center-greedy /
// facility-location), pure-JS, embedding-native (W921).
//
// CURATE today only FILTERS. Pure-pointwise (top-N by score) selection produces
// REDUNDANT batches: the richest items cluster in one region of input space, so
// each teacher token buys little new information. Diversity-aware active
// selection scores SETS, not points. This module implements the three classic
// set-selection algorithms directly over an embedding matrix (so it is reusable
// by CURATE, active-learning, and the data engine without re-embedding):
//
//   (1) k-CENTER-GREEDY (core-set; Sener & Savarese ICLR'18). min_S max_i
//       min_{j in S} dist(x_i,x_j): every unselected point near SOME selected
//       point. Greedy 2-OPT: pick the farthest point, add it, update each point's
//       min-distance-to-S in O(N). Result: maximal SPREAD (coverage / corners).
//
//   (2) FACILITY-LOCATION (monotone submodular; apricot/SMART). maximize
//       f(S)=Σ_i max_{j in S} sim(x_i,x_j). Lazy greedy gives (1-1/e)≈0.63.
//       Result: REPRESENTATIVENESS — picks cluster medoids, prefers dense regions
//       (the complement of k-center).
//
//   (3) BADGE (Ash et al. ICLR'20). Combines uncertainty + diversity via
//       k-means++ SEEDING (each pick ∝ squared distance from nearest already-
//       picked). With no class logits in a distillation corpus we use the
//       kolm-adapted variant: distance²-weighted k-means++ where each point's
//       WEIGHT = its informativeness score, reproducing magnitude=informativeness
//       / distance=diversity without gradients. Deterministic via a seeded LCG.
//
// All three operate on row-vectors and return selected indices + a per-method
// auxiliary signal (radii / gains). selectDiverse() is the orchestrator that
// embeds pairs (via the deterministic hash-bag embedder) and dispatches.
//
// Pure JS, zero new deps. Determinism: identical embeddings + seed => identical
// selection (BADGE included, via the seeded RNG). NEVER throws across the public
// API.

import { embed as _embedText, cosine as _cosineVec } from './embedding.js';

export const DIVERSITY_SELECT_VERSION = 'divsel-v1';

const VALID_METHODS = ['k-center', 'facility-location', 'badge'];

// ── pair text extraction (mirrors data-curate / data-select) ─────────────────

function _pairInput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.input === 'string') return p.input;
  if (typeof p.prompt === 'string') return p.prompt;
  return '';
}

function _pairOutput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.output === 'string') return p.output;
  if (typeof p.teacher_output === 'string') return p.teacher_output;
  if (typeof p.response === 'string') return p.response;
  return '';
}

function _pairText(p) {
  if (typeof p === 'string') return p;
  return (_pairInput(p) + '\n\n' + _pairOutput(p)).trim();
}

// ── vector ops (pure) ─────────────────────────────────────────────────────────

function _cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  return _cosineVec(a, b);
}

function _l2(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function _sqDist(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

// seeded LCG (Numerical-Recipes constants) for deterministic BADGE sampling.
function _lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function _resolveBudget(B, n) {
  const t = Number(B);
  if (!Number.isFinite(t) || t <= 0) return n;
  if (t > 1) return Math.min(n, Math.max(1, Math.trunc(t)));
  return Math.min(n, Math.max(1, Math.round(t * n)));
}

// ── (1) k-center-greedy ───────────────────────────────────────────────────────

/**
 * kCenterGreedy(embeddings, B, seedIndices) — incremental min-distance core-set.
 * @param {number[][]} embeddings  N x d
 * @param {number} B  budget (count)
 * @param {number[]} [seedIndices]  pre-selected indices to extend from
 * @returns {{selected_indices:number[], radii:number[], coverage_radius:number}}
 */
export function kCenterGreedy(embeddings, B, seedIndices = []) {
  const embs = Array.isArray(embeddings) ? embeddings : [];
  const n = embs.length;
  const budget = _resolveBudget(B, n);
  if (n === 0 || budget === 0) return { selected_indices: [], radii: [], coverage_radius: 0 };

  const selected = [];
  const radii = [];
  const minDist = new Float64Array(n).fill(Infinity);
  const seeds = Array.isArray(seedIndices) ? seedIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < n) : [];
  for (const s of seeds) {
    if (selected.includes(s)) continue;
    selected.push(s);
    for (let i = 0; i < n; i++) { const d = _l2(embs[i], embs[s]); if (d < minDist[i]) minDist[i] = d; }
  }
  if (selected.length === 0) {
    selected.push(0);
    for (let i = 0; i < n; i++) { const d = _l2(embs[i], embs[0]); if (d < minDist[i]) minDist[i] = d; }
  }
  while (selected.length < budget) {
    let far = -1; let farDist = -1;
    for (let i = 0; i < n; i++) if (minDist[i] > farDist) { farDist = minDist[i]; far = i; }
    if (far < 0) break;
    selected.push(far);
    radii.push(Number(farDist.toFixed(6)));
    for (let i = 0; i < n; i++) { const d = _l2(embs[i], embs[far]); if (d < minDist[i]) minDist[i] = d; }
  }
  // coverage radius = max over all points of min distance to selected (k-center objective)
  let cov = 0;
  for (let i = 0; i < n; i++) if (minDist[i] > cov) cov = minDist[i];
  return { selected_indices: selected.slice().sort((a, b) => a - b), radii, coverage_radius: Number(cov.toFixed(6)) };
}

// ── (2) facility-location (lazy greedy submodular max) ────────────────────────

/**
 * facilityLocationSelect(embeddings, B) — lazy-greedy maximization of
 * f(S)=Σ_i max_{j in S} sim(i,j). Uses cosine similarity. Lazy (Minoux)
 * evaluation: keep a max-heap-by-stale-gain and only recompute the top.
 * @param {number[][]} embeddings  N x d
 * @param {number} B  budget
 * @returns {{selected_indices:number[], gains:number[], objective:number}}
 */
export function facilityLocationSelect(embeddings, B) {
  const embs = Array.isArray(embeddings) ? embeddings : [];
  const n = embs.length;
  const budget = _resolveBudget(B, n);
  if (n === 0 || budget === 0) return { selected_indices: [], gains: [], objective: 0 };

  // best similarity of each point to the CURRENT selection
  const bestSim = new Float64Array(n).fill(0);
  const selected = [];
  const gains = [];

  // marginal gain of adding j = Σ_i max(0, sim(i,j) - bestSim[i])
  const marginalGain = (j) => {
    let g = 0;
    for (let i = 0; i < n; i++) {
      const s = _cosineSim(embs[i], embs[j]);
      if (s > bestSim[i]) g += s - bestSim[i];
    }
    return g;
  };

  // lazy structure: upper-bound gains; recompute lazily.
  const ub = new Float64Array(n);
  for (let j = 0; j < n; j++) ub[j] = Infinity;
  const inSel = new Uint8Array(n);

  while (selected.length < budget) {
    // find the candidate with the highest stale upper bound, recompute, and
    // accept if it is still the best after recompute (Minoux lazy greedy).
    let bestJ = -1; let bestG = -Infinity;
    // iterate candidates in descending stale-UB order; recompute on demand
    const order = [];
    for (let j = 0; j < n; j++) if (!inSel[j]) order.push(j);
    order.sort((a, b) => ub[b] - ub[a]);
    for (const j of order) {
      if (ub[j] <= bestG) break; // no remaining candidate can beat the current best
      const g = marginalGain(j);
      ub[j] = g;
      if (g > bestG) { bestG = g; bestJ = j; }
    }
    if (bestJ < 0) break;
    inSel[bestJ] = 1;
    selected.push(bestJ);
    gains.push(Number(bestG.toFixed(6)));
    for (let i = 0; i < n; i++) { const s = _cosineSim(embs[i], embs[bestJ]); if (s > bestSim[i]) bestSim[i] = s; }
  }
  let objective = 0;
  for (let i = 0; i < n; i++) objective += bestSim[i];
  return { selected_indices: selected.slice().sort((a, b) => a - b), gains, objective: Number(objective.toFixed(6)) };
}

// ── (3) BADGE — weighted k-means++ seeding ────────────────────────────────────

/**
 * badgeSelect(embeddings, weights, B, seed) — distance²-weighted k-means++
 * seeding. Each pick is chosen with probability ∝ weight * (sq distance to the
 * nearest already-picked). High-weight (informative) + well-separated (diverse)
 * points are favored, reproducing BADGE without class gradients. Deterministic
 * via the seeded LCG.
 * @param {number[][]} embeddings  N x d
 * @param {number[]|null} weights  per-point informativeness (>=0); null => uniform
 * @param {number} B  budget
 * @param {number} [seed=0x6b6f6c6d]
 * @returns {{selected_indices:number[]}}
 */
export function badgeSelect(embeddings, weights, B, seed = 0x6b6f6c6d) {
  const embs = Array.isArray(embeddings) ? embeddings : [];
  const n = embs.length;
  const budget = _resolveBudget(B, n);
  if (n === 0 || budget === 0) return { selected_indices: [] };
  const w = (Array.isArray(weights) && weights.length === n)
    ? weights.map((x) => Math.max(0, Number(x) || 0))
    : new Array(n).fill(1);
  const rng = _lcg(seed);

  const selected = [];
  // first pick: the highest-weight point (deterministic anchor on informativeness)
  let first = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[first]) first = i;
  selected.push(first);
  const minSq = new Float64Array(n);
  for (let i = 0; i < n; i++) minSq[i] = _sqDist(embs[i], embs[first]);

  const chosen = new Uint8Array(n);
  chosen[first] = 1;
  while (selected.length < budget) {
    // sampling weights ∝ weight * distance²
    let total = 0;
    const cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = chosen[i] ? 0 : (w[i] * minSq[i]);
      total += p;
      cum[i] = total;
    }
    let next = -1;
    if (total <= 0) {
      // all remaining are coincident/zero-weight -> pick first unchosen
      for (let i = 0; i < n; i++) if (!chosen[i]) { next = i; break; }
    } else {
      const r = rng() * total;
      for (let i = 0; i < n; i++) if (!chosen[i] && r <= cum[i]) { next = i; break; }
      if (next < 0) for (let i = n - 1; i >= 0; i--) if (!chosen[i]) { next = i; break; }
    }
    if (next < 0) break;
    chosen[next] = 1;
    selected.push(next);
    for (let i = 0; i < n; i++) { const d = _sqDist(embs[i], embs[next]); if (d < minSq[i]) minSq[i] = d; }
  }
  return { selected_indices: selected.slice().sort((a, b) => a - b) };
}

// ── orchestrator ──────────────────────────────────────────────────────────────

/**
 * selectDiverse — embed pairs/strings and dispatch to a diversity algorithm.
 * @param {object} args
 * @param {object[]|string[]} args.items
 * @param {number} args.target_size  >1 = count, 0<x<=1 = fraction
 * @param {'k-center'|'facility-location'|'badge'} [args.method='k-center']
 * @param {number[][]|null} [args.embeddings]  precomputed embeddings (optional)
 * @param {number[]|null} [args.scores]  per-item informativeness (BADGE weights / k-center seed)
 * @param {number[]} [args.seed_selected]  pre-selected indices (k-center)
 * @param {number} [args.seed=0x6b6f6c6d]  BADGE RNG seed
 * @returns {{ok, version, method, n_in, n_selected, selected_indices, kept, coverage_radius, objective}}
 */
export function selectDiverse({
  items,
  target_size,
  method = 'k-center',
  embeddings = null,
  scores = null,
  seed_selected = [],
  seed = 0x6b6f6c6d,
} = {}) {
  try {
    const rows = Array.isArray(items) ? items : [];
    const n = rows.length;
    const m = VALID_METHODS.includes(method) ? method : 'k-center';
    const base = { ok: true, version: DIVERSITY_SELECT_VERSION, method: m, n_in: n };
    if (n === 0) {
      return { ...base, n_selected: 0, selected_indices: [], kept: [], coverage_radius: 0, objective: 0 };
    }
    const embs = (Array.isArray(embeddings) && embeddings.length === n)
      ? embeddings
      : rows.map((p) => _embedText(_pairText(p)));
    const B = _resolveBudget(target_size, n);

    let selected_indices = [];
    let coverage_radius = null;
    let objective = null;
    if (m === 'facility-location') {
      const r = facilityLocationSelect(embs, B);
      selected_indices = r.selected_indices;
      objective = r.objective;
    } else if (m === 'badge') {
      const r = badgeSelect(embs, scores, B, seed);
      selected_indices = r.selected_indices;
    } else {
      // k-center
      let seeds = Array.isArray(seed_selected) ? seed_selected.slice() : [];
      if (seeds.length === 0 && Array.isArray(scores) && scores.length === n) {
        let best = 0; for (let i = 1; i < n; i++) if (scores[i] > scores[best]) best = i;
        seeds = [best];
      }
      const r = kCenterGreedy(embs, B, seeds);
      selected_indices = r.selected_indices;
      coverage_radius = r.coverage_radius;
    }

    if (coverage_radius == null) coverage_radius = _coverageRadius(embs, selected_indices);
    const kept = selected_indices.map((i, rank) => _stamp(rows[i], { method: m, rank, diversity_radius: coverage_radius }));
    return {
      ...base,
      n_selected: selected_indices.length,
      selected_indices,
      kept,
      coverage_radius,
      objective,
    };
  } catch (e) {
    return {
      ok: false,
      version: DIVERSITY_SELECT_VERSION,
      error: String((e && e.message) || e),
      n_in: Array.isArray(items) ? items.length : 0,
      n_selected: 0,
      selected_indices: [],
      kept: [],
      coverage_radius: 0,
    };
  }
}

function _stamp(row, sel) {
  if (!row || typeof row !== 'object') return row;
  const prov = (row.provenance && typeof row.provenance === 'object')
    ? { ...row.provenance, selection: sel }
    : { selection: sel };
  return { ...row, provenance: prov };
}

function _coverageRadius(embs, selected) {
  if (!selected || !selected.length || !embs.length) return 0;
  let worst = 0;
  for (let i = 0; i < embs.length; i++) {
    let best = Infinity;
    for (const j of selected) { const d = _l2(embs[i], embs[j]); if (d < best) best = d; }
    if (best > worst) worst = best;
  }
  return Number(worst.toFixed(6));
}

export const __internals = {
  _cosineSim,
  _l2,
  _sqDist,
  _lcg,
  _resolveBudget,
  _coverageRadius,
  _pairText,
};

export default {
  DIVERSITY_SELECT_VERSION,
  selectDiverse,
  kCenterGreedy,
  facilityLocationSelect,
  badgeSelect,
  __internals,
};
