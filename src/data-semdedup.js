// KOLM Data Engine - SemDeDup semantic (embedding-cluster) deduplication (W921).
//
// SemDeDup (Abbas, Tirumala, Simig, Ganguli, Morcos - "SemDeDup: Data-efficient
// learning at web-scale through semantic deduplication", 2023). MinHash/LSH
// (src/minhash-dedup.js) collapses SURFACE near-dups (shared 5-shingles). It is
// blind to PARAPHRASE: two pairs that say the same thing in different words share
// few shingles, so MinHash keeps BOTH and the expensive teacher/embedding stages
// pay to distill the same example twice. SemDeDup catches exactly that band -
// SEMANTIC duplicates - by clustering in embedding space and pruning members that
// are within epsilon (cosine) of a kept neighbor inside the same cluster.
//
// Pipeline placement: a NEW curate stage "b1. semdedup" runs in Node AFTER the
// MinHash pre-pass and BEFORE the python embedding dedup. By the time the costly
// python pass / SELECT stage runs, it only ever sees the SEMANTIC survivors. This
// is the cheap-stages-only-see-survivors funneling that makes the JS curate path
// scale (Abbas et al. report 50% of web data removable at near-zero quality loss).
//
// Algorithm (faithful to the paper, pure JS):
//   1. EMBED  - each pair -> a unit vector (reuse src/embedding.js hash-bag
//                embedder by default; an injected embedder swaps in a real model).
//   2. CLUSTER - k-means (k = sqrt(n/2) heuristic, capped) with DETERMINISTIC
//                k-means++ seeding via a seeded LCG. Cosine space (vectors are
//                already L2-normalized, so Euclidean k-means == spherical k-means).
//   3. PRUNE  - WITHIN each cluster only (the paper's key cost trick: O(sum c_i^2)
//                not O(n^2)). Order members by the KEEP POLICY so the chosen
//                representative is visited first; greedily keep a member, then drop
//                any later member whose max cosine to an ALREADY-KEPT neighbor in
//                the cluster exceeds (1 - epsilon). epsilon is the single knob:
//                bigger epsilon => looser match => fewer removed.
//
// Keep policy (configurable): which member of a semantic-dup group survives.
//   - 'low-density' (DEFAULT, the paper's recommendation at scale): keep the
//     member FARTHEST from its cluster centroid (lowest local density), i.e. the
//     most atypical exemplar - this preserves hard/rare examples and removes the
//     redundant prototypes. Abbas et al. find keep-low-density >= keep-random.
//   - 'high-quality': keep the highest local quality survivor (mirrors the
//     minhash survivor contract: confidence > teacher-priority > quality). Use when
//     the cluster is genuinely redundant and you want the cleanest exemplar.
//   - 'centroid' / 'high-density': keep the member CLOSEST to the centroid (most
//     prototypical) - the classic medoid; cheaper-to-learn but drops tail exemplars.
//
// Return contract (headline): { kept, removed_groups, dup_rate, epsilon } plus a
// per-cluster redundancy report. NEVER throws. If embedding is unavailable or n is
// degenerate it DEGRADES to a recorded no-op (report.backend_used reflects which
// path actually ran: 'semdedup-js' | 'none:<reason>' | 'injected').
//
// Privacy: the default path embeds LOCALLY (deterministic hash-bag, no network).
// An injected embedder is the caller's responsibility - kolm never ships pair text
// to a hyperscaler from here. ZERO new npm deps.

import { embed as _embedText, cosine as _cosineVec } from './embedding.js';

export const SEMDEDUP_VERSION = 'semdedup-v1';

const DEFAULT_SEED = 0x6b6f6c6d; // 'kolm' - shared with minhash-dedup for parity.
const VALID_KEEP_POLICIES = ['low-density', 'high-quality', 'centroid', 'high-density', 'first'];

// ── pair text extraction (mirrors data-curate / minhash-dedup / data-select) ──

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

function _pairText(p, key) {
  if (typeof p === 'string') return p;
  if (key === 'input') return _pairInput(p);
  if (key === 'output') return _pairOutput(p);
  return (_pairInput(p) + '\n\n' + _pairOutput(p)).trim();
}

// ── local quality heuristic (mirrors minhash-dedup _scoreQuality contract) ────

const _HARD_COT = [/<\/?think>/i, /<\/?reasoning>/i, /<\|?\s*thinking\s*\|?>/i, /<\|?\s*reasoning\s*\|?>/i];
const _REFUSAL = /\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b/i;
const _STRUCTURE = /(^|\n)\s*(\d+[.)]|[-*•])\s+/m;

function _scoreQuality(text) {
  const s = String(text == null ? '' : text);
  let score = 0.5;
  if (_HARD_COT.some((re) => re.test(s))) score -= 0.5;
  if (_REFUSAL.test(s)) score -= 0.2;
  const n = s.trim().length;
  if (n < 20) score -= 0.2;
  else if (n < 60) score -= 0.1;
  else if (n <= 1200) score += 0.1;
  else if (n > 2000) score -= 0.1;
  if (_STRUCTURE.test(s)) score += 0.05;
  return Math.max(0, Math.min(1, score));
}

function _pairQuality(p) {
  const explicit = p && typeof p.confidence === 'number' ? p.confidence : null;
  if (explicit !== null) return explicit;
  return _scoreQuality(_pairOutput(p));
}

// ── vector helpers (pure) ─────────────────────────────────────────────────────

function _cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  return _cosineVec(a, b);
}

// Squared Euclidean over L2-normalized vectors == 2*(1 - cosine). Cheap distance
// for k-means; monotone in cosine so it ranks identically to cosine distance.
function _sqDist(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function _l2Normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

// ── seeded RNG (LCG, Numerical Recipes constants) - shared with minhash-dedup ──

function _lcg(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000; // float in [0,1)
  };
}

// ── deterministic k-means++ (cosine / spherical) ──────────────────────────────

// chooseK - sqrt(n/2) heuristic capped to [1, n], the SemDeDup-style "many small
// clusters" regime (the paper uses k in the thousands for web-scale; the heuristic
// keeps clusters small so within-cluster O(c^2) prune stays cheap).
function _chooseK(n, override) {
  if (Number.isFinite(Number(override)) && Number(override) >= 1) {
    return Math.max(1, Math.min(n, Math.trunc(Number(override))));
  }
  const k = Math.round(Math.sqrt(n / 2));
  return Math.max(1, Math.min(n, k || 1));
}

// kmeansPlusPlusSeed - deterministic D^2 seeding. Returns the chosen center
// indices. The first center is fixed (index 0) for determinism; each subsequent
// center is drawn proportional to squared distance from the nearest chosen center
// using the seeded RNG, exactly like BADGE/k-means++.
function _kmeansPlusPlusSeed(vectors, k, rng) {
  const n = vectors.length;
  const centers = [0];
  const d2 = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) d2[i] = _sqDist(vectors[i], vectors[0]);
  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) total += d2[i];
    let pick;
    if (total <= 0) {
      // All remaining points coincide with a center: pick the first not-yet-center
      // index deterministically so we never spin.
      pick = -1;
      for (let i = 0; i < n; i++) {
        if (!centers.includes(i)) { pick = i; break; }
      }
      if (pick < 0) break; // fewer distinct points than k
    } else {
      let target = rng() * total;
      pick = n - 1;
      for (let i = 0; i < n; i++) {
        target -= d2[i];
        if (target <= 0) { pick = i; break; }
      }
      if (centers.includes(pick)) {
        // Degenerate draw landed on an existing center; advance to next novel idx.
        let found = -1;
        for (let i = 0; i < n; i++) if (!centers.includes(i)) { found = i; break; }
        if (found < 0) break;
        pick = found;
      }
    }
    centers.push(pick);
    for (let i = 0; i < n; i++) {
      const nd = _sqDist(vectors[i], vectors[pick]);
      if (nd < d2[i]) d2[i] = nd;
    }
  }
  return centers;
}

// kmeans - Lloyd iterations over cosine space. Centroids re-L2-normalized each
// step (spherical k-means). Fully deterministic given the seed. Returns
// { assign, centroids } where assign[i] is the cluster index of point i.
function _kmeans(vectors, k, opts) {
  const n = vectors.length;
  const dim = n > 0 ? vectors[0].length : 0;
  const maxIter = Math.max(1, Math.trunc(Number(opts && opts.maxIter) || 25));
  const seed = (Number(opts && opts.seed) >>> 0) || DEFAULT_SEED;
  const rng = _lcg(seed);

  const seedIdx = _kmeansPlusPlusSeed(vectors, k, rng);
  let centroids = seedIdx.map((i) => vectors[i].slice());
  // If seeding produced fewer than k centers (fewer distinct points), shrink k.
  const kEff = centroids.length;

  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    // assignment step
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kEff; c++) {
        const d = _sqDist(vectors[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    // update step
    const sums = [];
    const counts = new Array(kEff).fill(0);
    for (let c = 0; c < kEff; c++) sums.push(new Array(dim).fill(0));
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      const v = vectors[i];
      const s = sums[c];
      for (let d = 0; d < dim; d++) s[d] += v[d];
      counts[c] += 1;
    }
    for (let c = 0; c < kEff; c++) {
      if (counts[c] === 0) continue; // keep an empty cluster's old centroid
      const s = sums[c];
      for (let d = 0; d < dim; d++) s[d] /= counts[c];
      centroids[c] = _l2Normalize(s);
    }
    if (!moved && iter > 0) break; // converged
  }
  return { assign, centroids, k: kEff };
}

// ── headline: semDedup ────────────────────────────────────────────────────────

/**
 * semDedup(pairs, opts) - within-cluster semantic deduplication.
 *
 * @param {object[]} pairs  {input|prompt, output|teacher_output|response}[]
 * @param {object} [opts]
 * @param {number} [opts.epsilon=0.05]   THE knob. A member is a semantic dup of a
 *        kept neighbor when their cosine similarity > (1 - epsilon). Bigger epsilon
 *        = looser = fewer removed. epsilon in (0,1]; 0 disables pruning (no-op).
 * @param {number} [opts.k]              cluster count override (default sqrt(n/2)).
 * @param {'low-density'|'high-quality'|'centroid'|'high-density'|'first'} [opts.keep='low-density']
 * @param {'pair'|'input'|'output'} [opts.key='pair']  which text to embed.
 * @param {(text:string)=>number[]} [opts.embedder]  injected embedder (real model);
 *        defaults to the local deterministic hash-bag embedder.
 * @param {number} [opts.seed]           k-means seed (shared with minhash-dedup).
 * @param {number} [opts.maxIter=25]     Lloyd iterations.
 * @returns {{kept:object[], removed_groups:Array, dup_rate:number, epsilon:number, report:object}}
 */
export function semDedup(pairs, opts = {}) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const n = rows.length;

  let epsilon = Number(opts.epsilon);
  if (!Number.isFinite(epsilon)) epsilon = 0.05;
  // Clamp to (0,1]. epsilon<=0 => threshold>=1 => nothing prunes (recorded no-op).
  if (epsilon < 0) epsilon = 0;
  if (epsilon > 1) epsilon = 1;
  const simThreshold = 1 - epsilon; // cosine ABOVE this => semantic duplicate

  const keep = VALID_KEEP_POLICIES.includes(opts.keep) ? opts.keep : 'low-density';
  const key = (opts.key === 'input' || opts.key === 'output') ? opts.key : 'pair';
  const seed = (Number(opts.seed) >>> 0) || DEFAULT_SEED;
  const injected = typeof opts.embedder === 'function';
  const embedFn = injected ? opts.embedder : _embedText;

  const baseReport = {
    n_in: n,
    n_kept: n,
    n_removed: 0,
    n_clusters: 0,
    epsilon,
    sim_threshold: simThreshold,
    keep_policy: keep,
    key,
    seed,
    backend_used: 'none',
    version: SEMDEDUP_VERSION,
    clusters: [], // per-cluster redundancy report
  };

  // Degenerate / disabled cases => recorded no-op (never throws).
  if (n === 0) {
    baseReport.backend_used = 'none:empty';
    return { kept: [], removed_groups: [], dup_rate: 0, epsilon, report: baseReport };
  }
  if (n === 1) {
    baseReport.backend_used = 'none:singleton';
    baseReport.n_clusters = 1;
    return { kept: rows.slice(), removed_groups: [], dup_rate: 0, epsilon, report: baseReport };
  }
  if (epsilon <= 0) {
    // Threshold == 1.0: only EXACT-cosine matches would prune; the paper's
    // contract treats epsilon=0 as "off". Record an explicit no-op.
    baseReport.backend_used = 'none:epsilon_zero';
    return { kept: rows.slice(), removed_groups: [], dup_rate: 0, epsilon, report: baseReport };
  }

  // 1. EMBED (degrades to a no-op if embedding ever fails).
  let vectors;
  try {
    vectors = new Array(n);
    for (let i = 0; i < n; i++) {
      const text = _pairText(rows[i], key);
      let v = embedFn(text);
      if (!Array.isArray(v) || v.length === 0) {
        // an injected embedder can hand back junk; treat as a single zero vector
        // sized to the rest so k-means stays well-formed.
        v = null;
      }
      vectors[i] = v;
    }
    // Resolve a consistent dimension; backfill nulls / wrong-length with zeros.
    let dim = 0;
    for (const v of vectors) if (Array.isArray(v) && v.length > dim) dim = v.length;
    if (dim === 0) throw new Error('empty_embedding');
    for (let i = 0; i < n; i++) {
      const v = vectors[i];
      if (!Array.isArray(v) || v.length !== dim) {
        vectors[i] = new Array(dim).fill(0);
      } else {
        // re-normalize defensively so cosine == dot (injected embedders may not).
        vectors[i] = _l2Normalize(v);
      }
    }
  } catch (e) {
    baseReport.backend_used = 'none:embed_failed:' + String((e && e.message) || e);
    return { kept: rows.slice(), removed_groups: [], dup_rate: 0, epsilon, report: baseReport };
  }

  // 2. CLUSTER (deterministic k-means++). Degrades to a single cluster on failure.
  let assign;
  let centroids;
  let k;
  try {
    const km = _kmeans(vectors, _chooseK(n, opts.k), { seed, maxIter: opts.maxIter });
    assign = km.assign;
    centroids = km.centroids;
    k = km.k;
  } catch (e) {
    // single-cluster fallback: still does the within-corpus prune, just O(n^2).
    assign = new Array(n).fill(0);
    // centroid = mean of all vectors
    const dim = vectors[0].length;
    const mean = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mean[d] += vectors[i][d];
    for (let d = 0; d < dim; d++) mean[d] /= n;
    centroids = [_l2Normalize(mean)];
    k = 1;
    baseReport.cluster_note = 'fallback:single:' + String((e && e.message) || e);
  }

  // Group member indices by cluster.
  const members = [];
  for (let c = 0; c < k; c++) members.push([]);
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    if (c >= 0 && c < k) members[c].push(i);
  }

  // 3. PRUNE within each cluster.
  const keptIdx = new Set();
  const removedSet = new Set();
  const removed_groups = [];
  const clusterReports = [];

  for (let c = 0; c < k; c++) {
    const idxs = members[c];
    if (idxs.length === 0) continue;
    const centroid = centroids[c];

    // Distance-to-centroid for keep-policy ordering + density report.
    const centDist = new Map();
    for (const i of idxs) centDist.set(i, _sqDist(vectors[i], centroid));

    // Order members so the chosen REPRESENTATIVE is visited first (greedy keeps
    // whatever it sees first that is not a dup of an already-kept member). Stable
    // tie-break on original index for determinism.
    const ordered = idxs.slice().sort((a, b) => {
      let pa;
      let pb;
      if (keep === 'low-density') {
        // farthest from centroid first (lowest local density / most atypical)
        pa = -centDist.get(a); pb = -centDist.get(b);
      } else if (keep === 'centroid' || keep === 'high-density') {
        // closest to centroid first (most prototypical medoid)
        pa = centDist.get(a); pb = centDist.get(b);
      } else if (keep === 'high-quality') {
        // highest quality first
        pa = -_pairQuality(rows[a]); pb = -_pairQuality(rows[b]);
      } else { // 'first' - input order
        pa = a; pb = b;
      }
      if (pa !== pb) return pa - pb;
      return a - b;
    });

    // Greedy semantic prune: keep a member iff its max cosine to an already-kept
    // member in THIS cluster is <= simThreshold; else it's a semantic dup.
    const clusterKept = [];
    const groupOf = new Map(); // representative idx -> {kept, dups:[]}
    let clusterRedundant = 0;
    let maxIntraSim = 0;
    for (const i of ordered) {
      let bestSim = -1;
      let bestRep = -1;
      for (const kept of clusterKept) {
        const sim = _cosine(vectors[i], vectors[kept]);
        if (sim > bestSim) { bestSim = sim; bestRep = kept; }
      }
      if (bestRep >= 0 && bestSim > maxIntraSim) maxIntraSim = bestSim;
      if (bestRep >= 0 && bestSim > simThreshold) {
        // semantic duplicate of bestRep -> remove i
        removedSet.add(i);
        clusterRedundant += 1;
        let g = groupOf.get(bestRep);
        if (!g) { g = { kept_idx: bestRep, dups: [] }; groupOf.set(bestRep, g); }
        g.dups.push({ removed_idx: i, sim: Number(bestSim.toFixed(6)) });
      } else {
        clusterKept.push(i);
        keptIdx.add(i);
      }
    }

    // Emit removed_groups (one per representative that absorbed >=1 dup).
    for (const g of groupOf.values()) {
      removed_groups.push({
        cluster: c,
        kept_idx: g.kept_idx,
        removed_idxs: g.dups.map((d) => d.removed_idx),
        sims: g.dups.map((d) => d.sim),
        group_size: g.dups.length + 1,
      });
    }

    clusterReports.push({
      cluster: c,
      size: idxs.length,
      kept: clusterKept.length,
      removed: clusterRedundant,
      redundancy: idxs.length > 0 ? Number((clusterRedundant / idxs.length).toFixed(4)) : 0,
      max_intra_sim: Number(maxIntraSim.toFixed(4)),
    });
  }

  // Assemble kept rows in ORIGINAL input order (determinism + stable downstream).
  const kept = [];
  for (let i = 0; i < n; i++) if (!removedSet.has(i)) kept.push(rows[i]);

  const nRemoved = removedSet.size;
  const dupRate = n > 0 ? Number((nRemoved / n).toFixed(6)) : 0;

  // Sort the per-cluster report by descending redundancy so the noisiest topics
  // surface first in the Data Health panel.
  clusterReports.sort((a, b) => b.redundancy - a.redundancy || a.cluster - b.cluster);
  removed_groups.sort((a, b) => a.kept_idx - b.kept_idx);

  const report = Object.assign(baseReport, {
    n_kept: kept.length,
    n_removed: nRemoved,
    n_clusters: k,
    dup_rate: dupRate,
    backend_used: injected ? 'semdedup-js:injected' : 'semdedup-js',
    clusters: clusterReports,
  });

  return { kept, removed_groups, dup_rate: dupRate, epsilon, report };
}

export default {
  SEMDEDUP_VERSION,
  semDedup,
};
