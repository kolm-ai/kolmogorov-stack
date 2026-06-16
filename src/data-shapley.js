// KOLM Data Engine - Training-Data Valuation via Data Shapley (W-finalized C3).
//
// Per-pair MARGINAL VALUE: how much does each training pair contribute to a
// model's validation utility, accounting for interactions with every other
// pair? A pair with NEGATIVE Shapley value is actively HARMFUL (mislabeled,
// off-distribution, adversarial) - removing it RAISES validation utility. This
// is the signal CURATE's heuristic/quality/dedup stages cannot see: a pair can
// be fluent, unique, and on-topic yet still drag the model down.
//
// Two tractable estimators share one envelope (valuePairsByShapley):
//
//   (1) KNN-Shapley  (Jia, Dai, Wang, Spanos et al., VLDB 2019,
//       arXiv:1908.08619 / arXiv:1911.07128). For a KNN utility the Shapley
//       value has an EXACT closed form computed by a single backward recursion
//       per validation point over the training pairs sorted by distance - total
//       cost O(N_val * N_train log N_train). No coalition sampling, no model
//       retraining. Gives every pair a SIGNED value; negative => harmful.
//
//   (2) Truncated Monte-Carlo Shapley  (Ghorbani & Zou, ICML 2019,
//       arXiv:1904.02868). The general (model-agnostic) Shapley estimator:
//       average each pair's marginal contribution over random permutations of
//       the training set. We make each coalition evaluate in MILLISECONDS by
//       using a CHEAP utility proxy (a KNN holdout-accuracy / soft-margin
//       readout over the existing embedding space, or an injected quality head)
//       instead of retraining a real model. Two accelerators from the paper:
//         - performance TRUNCATION: once a coalition's utility is within
//           `truncationTol` of the full-set utility, stop scanning the rest of
//           that permutation (their marginals are ~0).
//         - convergence GATING: stop adding permutations once the running mean
//           values stabilize (max relative change < `convergenceTol` over a
//           window), capped at `maxPermutations`.
//
// Envelope: valuePairsByShapley({pairs, val_pairs, ...}) =>
//   {ok, version:'shapley-v1', method, values:number[], harmful_indices:int[],
//    convergence:{...}, ...}  and NEVER throws across the public API. On MC
//   non-convergence it DEGRADES to the exact KNN-Shapley result (always
//   available) and records method:'knn (mc-degraded)'.
//
// Determinism: seeded permutations via an FNV-1a seed -> mulberry32 PRNG, so an
// identical (pairs, val_pairs, seed) yields byte-identical values. NO npm deps;
// reuses the in-repo deterministic embedder (src/embedding.js). All compute is
// LOCAL - no pair text ever leaves the process (privacy boundary: this stage
// operates on embeddings + labels only, never calls a hyperscaler).
//
// Pure JS. ASCII only.

import { embed as _embedText, cosine as _cosineVec } from './embedding.js';

export const DATA_SHAPLEY_VERSION = 'shapley-v1';

// -- pair text extraction (mirrors data-curate / data-quality-classifier) ------

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

// A pair's LABEL for the KNN utility. Shapley needs a target each train point
// "votes" on at each validation query. We derive a deterministic class label:
//   - explicit p.label / p.class / p.y if present (string or number)
//   - else the cluster_id stamped by CURATE's cluster stage
//   - else a coarse topic bucket (first input content word) so unlabeled
//     corpora still get a non-degenerate KNN-vote structure.
// The label is ONLY used to define "did this neighbor agree with the val
// point" - it is never surfaced or sent anywhere.
function _pairLabel(p) {
  if (p && typeof p === 'object') {
    if (p.label != null) return String(p.label);
    if (p.class != null) return String(p.class);
    if (p.y != null) return String(p.y);
    if (typeof p.cluster_id === 'string' && p.cluster_id) return p.cluster_id;
  }
  const words = String(_pairInput(p) || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const w of words) if (w.length > 2) return 'topic_' + w;
  return 'topic_default';
}

// -- deterministic PRNG (FNV-1a seed -> mulberry32 stream) ---------------------

function _hashSeed(seedInput) {
  // Fold any seed (number | string) into a 32-bit unsigned integer
  // deterministically. FNV-1a over the string form.
  const s = String(seedInput == null ? 'kolm-shapley' : seedInput);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function _mulberry32(a) {
  let state = a >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates over indices [0..n) using a seeded stream. Returns a fresh array.
function _seededPermutation(n, rng) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// -- embedding cache -----------------------------------------------------------

function _embedAll(pairs) {
  return pairs.map((p) => {
    // allow a caller to inject a precomputed vector (e.g. a real embedding API)
    if (p && Array.isArray(p.vector) && p.vector.length) return p.vector;
    if (p && Array.isArray(p.embedding) && p.embedding.length) return p.embedding;
    return _embedText(_pairText(p));
  });
}

// Distance ordering via cosine SIMILARITY on L2-normalized vectors: higher
// cosine == nearer. We sort by descending similarity so rank 1 is the NEAREST
// neighbor (matches the KNN-Shapley "alpha_1 = closest" order).
function _simRow(qVec, trainVecs) {
  const n = trainVecs.length;
  const sims = new Array(n);
  for (let i = 0; i < n; i++) sims[i] = _cosineVec(qVec, trainVecs[i]);
  return sims;
}

// -- (1) KNN-Shapley exact closed form (Jia et al. 2019) -----------------------
//
// For a single validation point (x_val, y_val) and training points sorted from
// NEAREST (rank 1) to FARTHEST (rank N), the per-point Shapley value under an
// unweighted-KNN utility is given by the backward recursion (Theorem 1):
//
//   s_{a_N}     = indicator(y_{a_N} == y_val) / N
//   s_{a_i}     = s_{a_{i+1}}
//                 + ( indicator(y_{a_i}==y_val) - indicator(y_{a_{i+1}}==y_val) )
//                   / K * min(K, i) / i                       (for i from N-1..1)
//
// where a_i is the train index at sorted rank i (1-indexed). This is EXACT for
// the KNN utility and costs O(N) after the O(N log N) sort, per val point. The
// total value of a train point is the AVERAGE over all validation points.
function _knnShapleyForValPoint(simRow, trainLabels, yVal, K) {
  const N = simRow.length;
  const phi = new Array(N).fill(0);
  if (N === 0) return phi;

  // order[0] = nearest train index (highest similarity), order[N-1] = farthest.
  const order = new Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  order.sort((a, b) => simRow[b] - simRow[a]);

  const k = Math.max(1, Math.min(K, N));
  const eq = (idx) => (trainLabels[idx] === yVal ? 1 : 0);

  // rank N (farthest) -> 1-indexed i=N maps to order[N-1].
  const farthest = order[N - 1];
  phi[farthest] = eq(farthest) / N;

  // recurse upward toward the nearest neighbor.
  for (let i = N - 1; i >= 1; i--) {
    const cur = order[i - 1];      // rank i (1-indexed)
    const next = order[i];         // rank i+1
    const diff = eq(cur) - eq(next);
    phi[cur] = phi[next] + (diff / k) * (Math.min(k, i) / i);
  }
  return phi;
}

/**
 * _knnShapley({trainVecs, trainLabels, valVecs, valLabels, K}) - exact per-train
 * Shapley values averaged over the validation set. O(N_val*N_train log N_train).
 * @returns {number[]} length == trainVecs.length; signed (negative => harmful).
 */
function _knnShapley({ trainVecs, trainLabels, valVecs, valLabels, K }) {
  const N = trainVecs.length;
  const M = valVecs.length;
  const acc = new Array(N).fill(0);
  if (N === 0 || M === 0) return acc;
  for (let v = 0; v < M; v++) {
    const sims = _simRow(valVecs[v], trainVecs);
    const phi = _knnShapleyForValPoint(sims, trainLabels, valLabels[v], K);
    for (let i = 0; i < N; i++) acc[i] += phi[i];
  }
  for (let i = 0; i < N; i++) acc[i] /= M;
  return acc;
}

// -- utility proxy for TMC (cheap, millisecond coalitions) ---------------------
//
// Given the SET of currently-included train indices, score validation utility.
// Default: the EXACT KNN utility the closed form assumes (so the two estimators
// value the SAME objective):
//   U(S) = (1/|val|) * sum_val (1/K) * sum_{top-K nearest in S} 1[label match]
// The normalizer is the CONSTANT K (not min(K,|S|)): a small coalition divides
// by K and simply scores lower. This is what makes MC's permutation marginals
// the unbiased Monte-Carlo estimate of the same Shapley values KNN-Shapley
// computes in closed form. Bounded in [0,1], strictly responsive to membership.
// An injected `utility` fn (e.g. the data-quality-classifier head reading the
// coalition) overrides this; it must be a pure (includedSet:Set<idx>)=>number
// (any bounded scale) and is called many times, so keep it cheap.
function _makeKnnUtility({ trainVecs, trainLabels, valVecs, valLabels, K }) {
  const M = valVecs.length;
  // Precompute, for each val point, the similarity to every train point ONCE.
  const simRows = valVecs.map((qv) => _simRow(qv, trainVecs));
  const k = Math.max(1, K | 0);
  return function utility(includedSet) {
    if (!includedSet || includedSet.size === 0 || M === 0) return 0;
    let total = 0;
    for (let v = 0; v < M; v++) {
      const sims = simRows[v];
      // top-k included neighbors by similarity (small k -> partial selection).
      const cand = [];
      for (const idx of includedSet) cand.push(idx);
      cand.sort((a, b) => sims[b] - sims[a]);
      const top = cand.slice(0, Math.min(k, cand.length));
      let agree = 0;
      for (const idx of top) if (trainLabels[idx] === valLabels[v]) agree += 1;
      total += agree / k; // constant-K normalizer (matches closed form)
    }
    return total / M;
  };
}

// -- (2) Truncated Monte-Carlo Shapley (Ghorbani & Zou 2019) -------------------
//
// values[i] = E_perm [ U(prefix up to and including i) - U(prefix before i) ].
// We average over seeded permutations, with performance-truncation inside each
// permutation and a convergence gate across permutations.
function _tmcShapley({
  trainVecs, trainLabels, valVecs, valLabels, K,
  utility, seed, minPermutations, maxPermutations, convergenceTol,
  truncationTol, convergenceWindow,
}) {
  const N = trainVecs.length;
  const fullUtilFn = utility || _makeKnnUtility({ trainVecs, trainLabels, valVecs, valLabels, K });
  const rng = _mulberry32(_hashSeed(seed));

  const fullSet = new Set();
  for (let i = 0; i < N; i++) fullSet.add(i);
  const emptyUtil = 0;                 // U({}) = 0 by convention
  const fullUtil = fullUtilFn(fullSet);

  const sums = new Array(N).fill(0);
  const values = new Array(N).fill(0);
  let prevValues = values.slice();

  let perm = 0;
  let converged = false;
  let truncatedSteps = 0;
  let evals = 0;
  const minP = Math.max(1, minPermutations | 0);
  const maxP = Math.max(minP, maxPermutations | 0);
  const tol = Number.isFinite(convergenceTol) ? convergenceTol : 0.05;
  const truncTol = Number.isFinite(truncationTol) ? truncationTol : 1e-4;
  const window = Math.max(1, convergenceWindow | 0);

  // running history of mean-relative-change for the convergence window.
  const history = [];
  let lastM = 0;

  for (perm = 0; perm < maxP; perm++) {
    const order = _seededPermutation(N, rng);
    const included = new Set();
    let prevUtil = emptyUtil;
    for (let pos = 0; pos < N; pos++) {
      const idx = order[pos];
      // performance truncation: once the coalition is within truncTol of the
      // full-set utility, the remaining marginals are ~0 - skip them.
      if (Math.abs(fullUtil - prevUtil) < truncTol) {
        truncatedSteps += (N - pos);
        break;
      }
      included.add(idx);
      const newUtil = fullUtilFn(included);
      evals += 1;
      sums[idx] += (newUtil - prevUtil);
      prevUtil = newUtil;
    }
    // pairs never reached in a truncated permutation get a 0 marginal for this
    // permutation (already the case - sums unchanged). Update running means.
    const m = perm + 1;
    lastM = m;
    for (let i = 0; i < N; i++) values[i] = sums[i] / m;

    if (m >= minP) {
      // mean relative change of the value vector vs the previous permutation.
      let num = 0; let den = 0;
      for (let i = 0; i < N; i++) {
        num += Math.abs(values[i] - prevValues[i]);
        den += Math.abs(values[i]);
      }
      const rel = den > 1e-12 ? num / den : (num > 1e-12 ? 1 : 0);
      history.push(rel);
      if (history.length > window) history.shift();
      const windowMax = history.length === window ? Math.max(...history) : Infinity;
      if (windowMax < tol) { converged = true; prevValues = values.slice(); break; }
    }
    prevValues = values.slice();
  }

  return {
    values,
    convergence: {
      converged,
      permutations: lastM,
      max_permutations: maxP,
      min_permutations: minP,
      convergence_tol: tol,
      truncation_tol: truncTol,
      truncated_steps: truncatedSteps,
      utility_evals: evals,
      full_utility: Number(fullUtil.toFixed(8)),
      last_rel_change: history.length ? Number(history[history.length - 1].toFixed(8)) : null,
    },
  };
}

// -- public API ----------------------------------------------------------------

/**
 * valuePairsByShapley({pairs, val_pairs, method, K, seed, harmfulThreshold,
 *   utility, mc options...}) - per-pair marginal-value valuation.
 *
 * @param {object[]} pairs       training pairs to value.
 * @param {object[]} val_pairs   small validation/holdout set defining utility.
 * @param {string}   [method]    'knn' (exact, default), 'mc' (TMC), or 'auto'
 *                               (run MC, degrade to KNN on non-convergence).
 * @param {number}   [K]         KNN neighborhood size (default min(5, N)).
 * @param {number|string} [seed] deterministic permutation seed.
 * @param {number}   [harmfulThreshold] value <= this => harmful (default 0).
 * @param {function} [utility]   optional cheap (Set<idx>)=>number coalition
 *                               utility proxy for MC (e.g. the quality head).
 * @returns {{ok, version, method, values:number[], harmful_indices:number[],
 *            convergence:object, n, n_val, K}}  NEVER throws.
 */
export function valuePairsByShapley({
  pairs,
  val_pairs,
  method = 'knn',
  K,
  seed = 'kolm-shapley',
  harmfulThreshold = 0,
  utility = null,
  minPermutations = 8,
  maxPermutations = 200,
  convergenceTol = 0.05,
  truncationTol = 1e-4,
  convergenceWindow = 3,
} = {}) {
  try {
    const train = Array.isArray(pairs) ? pairs : [];
    const val = Array.isArray(val_pairs) ? val_pairs : [];
    const N = train.length;
    const M = val.length;

    const out = (extra) => Object.assign({
      ok: true,
      version: DATA_SHAPLEY_VERSION,
      n: N,
      n_val: M,
    }, extra);

    if (N === 0) {
      return out({ method: 'none', values: [], harmful_indices: [], harmful_count: 0, K: 0, convergence: { converged: true, permutations: 0, reason: 'no_train_pairs' } });
    }
    if (M === 0) {
      // no validation signal -> cannot value; return zeros, not a crash.
      return out({ method: 'none', values: new Array(N).fill(0), harmful_indices: [], harmful_count: 0, K: 0, convergence: { converged: false, permutations: 0, reason: 'no_validation_pairs' } });
    }

    const thr = Number.isFinite(Number(harmfulThreshold)) ? Number(harmfulThreshold) : 0;
    // K default: small neighborhood, bounded by train size. Jia et al. use a
    // fixed small K; 5 (or N if smaller) is the standard default.
    const k = Number.isFinite(Number(K)) && Number(K) > 0
      ? Math.min(Number(K) | 0, N)
      : Math.min(5, N);

    const trainVecs = _embedAll(train);
    const valVecs = _embedAll(val);
    const trainLabels = train.map(_pairLabel);
    const valLabels = val.map(_pairLabel);

    const round = (x) => Number(x.toFixed(8));

    // exact KNN-Shapley is ALWAYS computed - it is the universal fallback and is
    // cheap. method 'knn' returns it directly.
    const knnValues = _knnShapley({ trainVecs, trainLabels, valVecs, valLabels, K: k });

    const finish = (values, methodName, convergence) => {
      const harmful = [];
      for (let i = 0; i < values.length; i++) if (values[i] <= thr) harmful.push(i);
      return out({
        method: methodName,
        K: k,
        values: values.map(round),
        harmful_indices: harmful,
        harmful_count: harmful.length,
        harmful_threshold: thr,
        convergence: convergence || { converged: true, permutations: 0, method: 'knn-closed-form' },
      });
    };

    if (method === 'knn') {
      return finish(knnValues, 'knn', { converged: true, permutations: 0, method: 'knn-closed-form' });
    }

    // 'mc' or 'auto' -> run Truncated Monte-Carlo Shapley.
    const mc = _tmcShapley({
      trainVecs, trainLabels, valVecs, valLabels, K: k,
      utility: typeof utility === 'function' ? utility : null,
      seed, minPermutations, maxPermutations, convergenceTol,
      truncationTol, convergenceWindow,
    });

    if (mc.convergence.converged) {
      return finish(mc.values, 'mc', mc.convergence);
    }

    // MC did not converge.
    if (method === 'mc') {
      // caller explicitly asked for MC: return the (non-converged) MC estimate
      // but record it clearly so the report can flag low-confidence values.
      return finish(mc.values, 'mc (not-converged)', mc.convergence);
    }
    // 'auto': DEGRADE to the exact KNN-Shapley result (always available).
    const conv = Object.assign({}, mc.convergence, { degraded_to: 'knn' });
    return finish(knnValues, 'knn (mc-degraded)', conv);
  } catch (e) {
    const N = Array.isArray(pairs) ? pairs.length : 0;
    return {
      ok: false,
      version: DATA_SHAPLEY_VERSION,
      error: String((e && e.message) || e),
      method: 'error',
      values: new Array(N).fill(0),
      harmful_indices: [],
      harmful_count: 0,
      convergence: { converged: false, permutations: 0 },
      n: N,
      n_val: Array.isArray(val_pairs) ? val_pairs.length : 0,
    };
  }
}

export default {
  DATA_SHAPLEY_VERSION,
  valuePairsByShapley,
};
