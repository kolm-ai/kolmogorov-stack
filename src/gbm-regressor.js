// W921 Phase-1 — gbm-regressor: a REAL pure-JS gradient-boosted regression-tree
// meta-model, built to replace the depth-1 stump GBM in src/kolm-meta-trainer.js
// (W832). This module is intentionally STANDALONE and contract-free of the meta
// feature schema so it can be reused anywhere a small-n tabular regressor is
// wanted: fit(X, y, opts) -> model; predict(model, x) -> number;
// serialize/deserialize for durable JSON persistence.
//
// WHAT "REAL GBM" MEANS (vs the toy stump).
//   Gradient boosting fits F_M(x) = base + sum_m (eta * h_m(x)), where each h_m
//   is a regression tree fit to the negative gradient of the loss. For squared
//   error the gradient g_i = -(y_i - F_{m-1}(x_i)) is just the residual and the
//   Hessian h_i = 1. We follow the XGBoost regularized objective
//   (Chen & Guestrin 2016, arXiv:1603.02754):
//
//     leaf weight  w*  = -G / (H + lambda)
//     split gain   Gain = 1/2 [ GL^2/(HL+lambda) + GR^2/(HR+lambda)
//                               - (GL+GR)^2/(HL+HR+lambda) ] - gamma
//
//   where G = sum g_i, H = sum h_i over the node. min_child_weight rejects
//   splits whose child Hessian-sum (here = child row count) falls below the
//   floor. Friedman 2001 (arXiv euclid.aos/1013203451) stochastic subsampling
//   draws a row subsample per tree; XGBoost-style colsample draws a feature
//   subsample per tree. F_0 = mean(y) is the constant baseline (NOT the toy's
//   constant-0). Early stopping watches an internal holdout and trims the
//   ensemble back to the best round.
//
// WHAT WE DO PROMISE.
//   - Pure JS, ZERO external deps; runs anywhere Node runs.
//   - Deterministic given identical (X, y, opts): a seeded splitmix64-style PRNG
//     is persisted in the model so subsampling is reproducible byte-for-byte.
//   - Depth-CONFIGURABLE trees (max_depth >= 1; depth 1 reproduces a stump).
//   - Honest, NaN-free inference: missing/NaN feature cells coerce to 0; an
//     empty ensemble predicts the base; predict never returns NaN/undefined.
//   - serialize -> deserialize round-trips to a numerically-identical model.
//
// WHAT WE DO NOT PRETEND TO.
//   - We are not XGBoost / LightGBM at billion-row scale. The split scan is an
//     exact O(n log n) sort-per-feature-per-node brute force, correct and fast
//     at the n <= ~50k tabular regime kolm targets, NOT a histogram engine.
//   - No native categorical handling — the caller hands us numeric vectors.
//   - Squared-error objective only (the meta-task is regression in [0,1]).

// =============================================================================
// Seeded PRNG (deterministic subsampling)
// =============================================================================

// splitmix64-derived 32-bit generator. Pure integer math, no Math.random, so a
// given seed yields an identical stream on every platform/run.
function makeRng(seed) {
  // Mix the seed so small/zero seeds still scramble well.
  let s = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    // xorshift32 with a golden-ratio increment.
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = (Math.imul(t ^ (t >>> 15), t | 1)) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
  };
}

// Deterministic partial Fisher-Yates: returns the first `k` of a shuffled
// [0..n). Used for both row and column subsampling.
function sampleIndices(n, k, rng) {
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const m = Math.max(1, Math.min(n, k | 0));
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, m);
}

// =============================================================================
// Numeric coercion (never leak NaN)
// =============================================================================

function num(v) {
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function coerceRow(row, nFeat) {
  // Accepts an array (preferred) or an object indexed 0..nFeat-1.
  const out = new Array(nFeat);
  if (Array.isArray(row)) {
    for (let i = 0; i < nFeat; i++) out[i] = num(row[i]);
  } else if (row && typeof row === 'object') {
    for (let i = 0; i < nFeat; i++) out[i] = num(row[i]);
  } else {
    for (let i = 0; i < nFeat; i++) out[i] = 0;
  }
  return out;
}

// =============================================================================
// Defaults
// =============================================================================

export const GBM_DEFAULTS = Object.freeze({
  max_depth: 3,
  n_trees: 200,
  learning_rate: 0.05,
  subsample: 0.8,        // Friedman row subsample per tree
  colsample: 0.7,        // XGBoost-style column subsample per tree
  lambda: 1.0,           // L2 leaf regularization
  gamma: 0.0,            // minimum split-gain to keep a split
  min_child_weight: 3,   // min rows (Hessian sum) per child
  early_stopping_rounds: 20,
  validation_fraction: 0.2, // internal holdout for early stopping
  min_split_gain: 0,     // additional absolute floor on gain
  seed: 1337,
});

function resolveOpts(opts) {
  const o = { ...GBM_DEFAULTS, ...(opts || {}) };
  o.max_depth = Math.max(1, Math.floor(o.max_depth) || 1);
  o.n_trees = Math.max(1, Math.floor(o.n_trees) || 1);
  o.learning_rate = Number(o.learning_rate) > 0 ? Number(o.learning_rate) : 0.05;
  o.subsample = clamp01x(o.subsample, 1.0);
  o.colsample = clamp01x(o.colsample, 1.0);
  o.lambda = Number.isFinite(Number(o.lambda)) ? Number(o.lambda) : 1.0;
  o.gamma = Number.isFinite(Number(o.gamma)) ? Math.max(0, Number(o.gamma)) : 0;
  o.min_child_weight = Math.max(1, Math.floor(o.min_child_weight) || 1);
  o.early_stopping_rounds = Math.max(0, Math.floor(o.early_stopping_rounds) || 0);
  o.validation_fraction = clampRange(o.validation_fraction, 0, 0.9, 0.2);
  o.seed = (Number(o.seed) >>> 0) || GBM_DEFAULTS.seed;
  return o;
}

function clamp01x(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return n > 1 ? 1 : n;
}
function clampRange(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// =============================================================================
// Regularized regression-tree builder
// =============================================================================

// Best regularized split over a row subset on a single feature column.
// grad/hess are full-length arrays; rowIdx selects the active rows.
// Returns { feature, split, gain, leftIdx, rightIdx } or null.
function bestSplitOnFeature(xs, grad, hess, rowIdx, feature, lambda, gamma, minChild, minGain) {
  const m = rowIdx.length;
  if (m < 2) return null;
  // Sort active rows by this feature value.
  const order = rowIdx.slice().sort((a, b) => xs[a][feature] - xs[b][feature]);

  let G = 0;
  let H = 0;
  for (let i = 0; i < m; i++) {
    G += grad[order[i]];
    H += hess[order[i]];
  }

  let GL = 0;
  let HL = 0;
  let best = null;
  // Threshold candidates sit between consecutive distinct feature values.
  for (let i = 0; i < m - 1; i++) {
    const r = order[i];
    GL += grad[r];
    HL += hess[r];
    const vCur = xs[r][feature];
    const vNext = xs[order[i + 1]][feature];
    if (vCur === vNext) continue; // can't split between identical values
    const HR = H - HL;
    const leftN = i + 1;
    const rightN = m - leftN;
    // min_child_weight is enforced on Hessian sum (= row count for sq-loss).
    if (HL < minChild || HR < minChild) continue;
    const GR = G - GL;
    const gain = 0.5 * (
      (GL * GL) / (HL + lambda) +
      (GR * GR) / (HR + lambda) -
      (G * G) / (H + lambda)
    ) - gamma;
    if (gain > (best ? best.gain : minGain) && gain > minGain) {
      best = {
        feature,
        split: (vCur + vNext) / 2,
        gain,
        leftN,
        rightN,
      };
    }
  }
  if (!best) return null;
  // Materialize the partition with the chosen threshold (cheaper than carrying
  // index slices through the candidate loop).
  const leftIdx = [];
  const rightIdx = [];
  for (let i = 0; i < m; i++) {
    const r = rowIdx[i];
    if (xs[r][best.feature] <= best.split) leftIdx.push(r);
    else rightIdx.push(r);
  }
  best.leftIdx = leftIdx;
  best.rightIdx = rightIdx;
  return best;
}

function leafWeight(grad, hess, rowIdx, lambda) {
  let G = 0;
  let H = 0;
  for (let i = 0; i < rowIdx.length; i++) {
    G += grad[rowIdx[i]];
    H += hess[rowIdx[i]];
  }
  // w* = -G / (H + lambda). Squared-loss grad is the NEGATIVE residual, so this
  // resolves to the (regularized) mean residual — the correct boosting step.
  return -G / (H + lambda);
}

// Recursive depth-D tree. Returns a node:
//   leaf:   { leaf: true, value }
//   split:  { feature, split, left, right }
function buildTree(xs, grad, hess, rowIdx, colIdx, depth, o) {
  // Stop: max depth reached, too few rows to split, or no positive-gain split.
  if (depth >= o.max_depth || rowIdx.length < 2 * o.min_child_weight) {
    return { leaf: true, value: leafWeight(grad, hess, rowIdx, o.lambda) };
  }
  let best = null;
  for (let c = 0; c < colIdx.length; c++) {
    const cand = bestSplitOnFeature(
      xs, grad, hess, rowIdx, colIdx[c],
      o.lambda, o.gamma, o.min_child_weight, o.min_split_gain,
    );
    if (cand && (best == null || cand.gain > best.gain)) best = cand;
  }
  if (!best || best.leftIdx.length === 0 || best.rightIdx.length === 0) {
    return { leaf: true, value: leafWeight(grad, hess, rowIdx, o.lambda) };
  }
  return {
    feature: best.feature,
    split: best.split,
    gain: best.gain,
    left: buildTree(xs, grad, hess, best.leftIdx, colIdx, depth + 1, o),
    right: buildTree(xs, grad, hess, best.rightIdx, colIdx, depth + 1, o),
  };
}

function predictTree(node, xRow) {
  let n = node;
  while (n && !n.leaf) {
    n = (xRow[n.feature] <= n.split) ? n.left : n.right;
  }
  return n ? (Number.isFinite(n.value) ? n.value : 0) : 0;
}

// =============================================================================
// fit / predict
// =============================================================================

// Internal: build the boosted ensemble over a pre-coerced numeric matrix.
function boost(xs, ys, nFeat, o) {
  const n = xs.length;
  const rng = makeRng(o.seed);

  // Internal holdout for early stopping (deterministic split via the PRNG).
  let trainRows;
  let valRows;
  if (o.early_stopping_rounds > 0 && o.validation_fraction > 0 && n >= 8) {
    const nVal = Math.max(1, Math.floor(n * o.validation_fraction));
    const shuffled = sampleIndices(n, n, rng); // full deterministic shuffle
    valRows = shuffled.slice(0, nVal);
    trainRows = shuffled.slice(nVal);
    if (trainRows.length < 2) { trainRows = shuffled.slice(); valRows = null; }
  } else {
    trainRows = new Array(n);
    for (let i = 0; i < n; i++) trainRows[i] = i;
    valRows = null;
  }

  // F_0 = mean(y) over the training portion.
  let base = 0;
  for (let i = 0; i < trainRows.length; i++) base += ys[trainRows[i]];
  base = trainRows.length ? base / trainRows.length : 0;

  // Running predictions for ALL rows (so we can evaluate the holdout cheaply).
  const F = new Array(n).fill(base);
  const grad = new Array(n).fill(0);
  const hess = new Array(n).fill(1); // squared loss => Hessian == 1

  const trees = [];
  let bestValSSE = Infinity;
  let bestRound = 0;
  let sinceImprove = 0;

  const subRowCount = Math.max(1, Math.round(trainRows.length * o.subsample));
  const subColCount = Math.max(1, Math.round(nFeat * o.colsample));

  for (let t = 0; t < o.n_trees; t++) {
    // Negative gradient for squared loss = residual: g_i = -(y_i - F_i).
    for (let i = 0; i < trainRows.length; i++) {
      const r = trainRows[i];
      grad[r] = F[r] - ys[r];
    }
    // Per-tree stochastic row + column subsample (deterministic via rng).
    const rowSub = (subRowCount >= trainRows.length)
      ? trainRows.slice()
      : pickFrom(trainRows, subRowCount, rng);
    const colIdx = (subColCount >= nFeat)
      ? rangeArr(nFeat)
      : sampleIndices(nFeat, subColCount, rng);

    const tree = buildTree(xs, grad, hess, rowSub, colIdx, 0, o);
    trees.push(tree);

    // Update running predictions for every row.
    for (let r = 0; r < n; r++) {
      F[r] += o.learning_rate * predictTree(tree, xs[r]);
    }

    // Early stopping on the holdout SSE.
    if (valRows && o.early_stopping_rounds > 0) {
      let sse = 0;
      for (let i = 0; i < valRows.length; i++) {
        const r = valRows[i];
        const d = F[r] - ys[r];
        sse += d * d;
      }
      if (sse < bestValSSE - 1e-12) {
        bestValSSE = sse;
        bestRound = t + 1;
        sinceImprove = 0;
      } else {
        sinceImprove++;
        if (sinceImprove >= o.early_stopping_rounds) break;
      }
    } else {
      bestRound = t + 1;
    }
  }

  // Trim back to the best round when early stopping engaged.
  const used = (valRows && bestRound > 0) ? trees.slice(0, bestRound) : trees;

  return {
    base,
    learning_rate: o.learning_rate,
    trees: used,
    n_trees_used: used.length,
  };
}

function pickFrom(pool, k, rng) {
  // Deterministic partial shuffle of an arbitrary index pool.
  const a = pool.slice();
  const m = Math.max(1, Math.min(a.length, k | 0));
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a.slice(0, m);
}

function rangeArr(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

export const GBM_MODEL_VERSION = 'gbm-v1';

// fit(X, y, opts) -> model
//   X: array of numeric feature vectors (arrays). y: array of numeric targets.
//   Returns a plain serializable model object. Throws TypeError on bad shape.
export function fit(X, y, opts = {}) {
  if (!Array.isArray(X) || !Array.isArray(y)) {
    throw new TypeError('fit(X, y): X and y must be arrays');
  }
  if (X.length !== y.length) {
    throw new TypeError(`fit(X, y): length mismatch X=${X.length} y=${y.length}`);
  }
  if (X.length === 0) {
    throw new TypeError('fit(X, y): empty training set');
  }
  const o = resolveOpts(opts);

  // Infer feature width from the widest row so ragged input does not silently
  // drop columns. coerceRow zero-fills missing cells.
  let nFeat = 0;
  for (let i = 0; i < X.length; i++) {
    const w = Array.isArray(X[i]) ? X[i].length : (X[i] && typeof X[i] === 'object' ? Object.keys(X[i]).length : 0);
    if (w > nFeat) nFeat = w;
  }
  if (opts && Number.isFinite(Number(opts.n_features)) && Number(opts.n_features) > nFeat) {
    nFeat = Math.floor(Number(opts.n_features));
  }
  nFeat = Math.max(1, nFeat);

  const xs = new Array(X.length);
  for (let i = 0; i < X.length; i++) xs[i] = coerceRow(X[i], nFeat);
  const ys = new Array(y.length);
  for (let i = 0; i < y.length; i++) ys[i] = num(y[i]);

  const ens = boost(xs, ys, nFeat, o);

  return {
    version: GBM_MODEL_VERSION,
    n_features: nFeat,
    n_train_rows: X.length,
    base: ens.base,
    learning_rate: ens.learning_rate,
    n_trees_used: ens.n_trees_used,
    trees: ens.trees,
    hyperparameters: {
      max_depth: o.max_depth,
      n_trees: o.n_trees,
      learning_rate: o.learning_rate,
      subsample: o.subsample,
      colsample: o.colsample,
      lambda: o.lambda,
      gamma: o.gamma,
      min_child_weight: o.min_child_weight,
      early_stopping_rounds: o.early_stopping_rounds,
      validation_fraction: o.validation_fraction,
      seed: o.seed,
    },
  };
}

// predict(model, x) -> number. Never NaN. x may be a numeric array or object.
export function predict(model, x) {
  if (!model || typeof model !== 'object') return 0;
  const nFeat = Number(model.n_features) || (Array.isArray(x) ? x.length : 0);
  const row = coerceRow(x, Math.max(1, nFeat));
  let sum = Number.isFinite(model.base) ? model.base : 0;
  const trees = Array.isArray(model.trees) ? model.trees : [];
  const lr = Number.isFinite(model.learning_rate) ? model.learning_rate : 1;
  for (let i = 0; i < trees.length; i++) {
    sum += lr * predictTree(trees[i], row);
  }
  return Number.isFinite(sum) ? sum : 0;
}

// predictBatch(model, X) -> number[] convenience.
export function predictBatch(model, X) {
  if (!Array.isArray(X)) return [];
  return X.map((row) => predict(model, row));
}

// =============================================================================
// serialize / deserialize
// =============================================================================

// serialize(model) -> JSON string (stable: sorted keys for byte-determinism).
export function serialize(model) {
  return JSON.stringify(model, stableReplacer(model));
}

// stable key ordering so identical models serialize to identical bytes.
function stableReplacer() {
  return function replacer(_key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  };
}

// deserialize(jsonOrObj) -> model. Accepts a JSON string or an already-parsed
// object. Throws on malformed JSON, returns a structurally-validated model.
export function deserialize(input) {
  let m = input;
  if (typeof input === 'string') {
    m = JSON.parse(input);
  }
  if (!m || typeof m !== 'object') {
    throw new TypeError('deserialize: not a model object');
  }
  if (!Array.isArray(m.trees)) {
    throw new TypeError('deserialize: model missing trees[]');
  }
  // Re-coerce numeric scalars so a hand-edited / cross-version file cannot leak
  // strings or NaN into the predict path.
  return {
    version: String(m.version || GBM_MODEL_VERSION),
    n_features: Math.max(1, Math.floor(Number(m.n_features) || 1)),
    n_train_rows: Math.max(0, Math.floor(Number(m.n_train_rows) || 0)),
    base: Number.isFinite(Number(m.base)) ? Number(m.base) : 0,
    learning_rate: Number.isFinite(Number(m.learning_rate)) ? Number(m.learning_rate) : 1,
    n_trees_used: Math.max(0, Math.floor(Number(m.n_trees_used) || m.trees.length)),
    trees: m.trees,
    hyperparameters: (m.hyperparameters && typeof m.hyperparameters === 'object')
      ? m.hyperparameters
      : {},
  };
}

// =============================================================================
// Small metrics helper (used by tests + callers comparing models)
// =============================================================================

// rmse(model, X, y) -> root-mean-squared error on a holdout. NaN-safe.
export function rmse(model, X, y) {
  if (!Array.isArray(X) || !Array.isArray(y) || X.length === 0) return Infinity;
  let sse = 0;
  let n = 0;
  for (let i = 0; i < X.length; i++) {
    const p = predict(model, X[i]);
    const t = num(y[i]);
    const d = p - t;
    sse += d * d;
    n++;
  }
  return n ? Math.sqrt(sse / n) : Infinity;
}

export const __internals = Object.freeze({
  makeRng,
  sampleIndices,
  bestSplitOnFeature,
  buildTree,
  predictTree,
  leafWeight,
  coerceRow,
  num,
  resolveOpts,
});
