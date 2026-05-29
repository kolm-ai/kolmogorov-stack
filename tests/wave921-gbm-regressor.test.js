// W921 Phase-1 — tests for src/gbm-regressor.js (the real depth-D GBM that
// replaces the depth-1 stump meta-model). Hermetic, no filesystem, no deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fit,
  predict,
  predictBatch,
  serialize,
  deserialize,
  rmse,
  GBM_DEFAULTS,
  GBM_MODEL_VERSION,
  __internals,
} from '../src/gbm-regressor.js';

// -----------------------------------------------------------------------------
// Synthetic data generators (seeded, deterministic)
// -----------------------------------------------------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// y = 0.9 if (feature0 high AND feature1 low) else 0.4 — a 2-way interaction a
// depth-1 stump CANNOT represent (it needs at least one nested split).
function makeInteractionData(n, seed, noise = 0.0) {
  const r = lcg(seed);
  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const f0 = r();           // [0,1)
    const f1 = r();           // [0,1)
    const f2 = r();           // pure noise feature
    const high = f0 > 0.5;
    const low = f1 < 0.5;
    let target = (high && low) ? 0.9 : 0.4;
    if (noise > 0) target += (r() - 0.5) * 2 * noise;
    X.push([f0, f1, f2]);
    y.push(target);
  }
  return { X, y };
}

// -----------------------------------------------------------------------------
// (1) INTERACTION RECOVERY — depth-3 beats depth-1 stump on interacting features
// -----------------------------------------------------------------------------

test('depth-3 GBM achieves lower RMSE than depth-1 stumps on a 2-way interaction', () => {
  const train = makeInteractionData(600, 7);
  const test_ = makeInteractionData(300, 99);

  const deep = fit(train.X, train.y, {
    max_depth: 3, n_trees: 120, learning_rate: 0.1,
    subsample: 1.0, colsample: 1.0, min_child_weight: 2,
  });
  const stump = fit(train.X, train.y, {
    max_depth: 1, n_trees: 120, learning_rate: 0.1,
    subsample: 1.0, colsample: 1.0, min_child_weight: 2,
  });

  const deepRmse = rmse(deep, test_.X, test_.y);
  const stumpRmse = rmse(stump, test_.X, test_.y);

  // The interaction is unlearnable by depth-1; depth-3 must be meaningfully
  // better. Spec acceptance is >=20% relative; we hold a conservative margin.
  assert.ok(deepRmse < stumpRmse * 0.8,
    `depth-3 RMSE ${deepRmse.toFixed(4)} should beat depth-1 ${stumpRmse.toFixed(4)} by >=20%`);
  assert.ok(Number.isFinite(deepRmse) && deepRmse >= 0);
});

// -----------------------------------------------------------------------------
// (2) DETERMINISM — identical (X, y, opts+seed) => byte-identical model
// -----------------------------------------------------------------------------

test('fit is deterministic: identical inputs+seed produce byte-identical models', () => {
  const { X, y } = makeInteractionData(400, 21, 0.05);
  const opts = { max_depth: 3, n_trees: 60, seed: 42, subsample: 0.8, colsample: 0.7 };
  const a = fit(X, y, opts);
  const b = fit(X, y, opts);
  assert.equal(serialize(a), serialize(b), 'two fits with same seed must serialize identically');
});

test('different seeds with subsampling produce different ensembles', () => {
  const { X, y } = makeInteractionData(400, 21, 0.05);
  const a = fit(X, y, { max_depth: 3, n_trees: 60, seed: 1, subsample: 0.6, colsample: 0.6 });
  const b = fit(X, y, { max_depth: 3, n_trees: 60, seed: 2, subsample: 0.6, colsample: 0.6 });
  assert.notEqual(serialize(a), serialize(b), 'distinct seeds should diverge under subsampling');
});

// -----------------------------------------------------------------------------
// (3) SERIALIZE / DESERIALIZE round-trip
// -----------------------------------------------------------------------------

test('serialize -> deserialize -> predict round-trips to identical predictions', () => {
  const { X, y } = makeInteractionData(300, 5);
  const model = fit(X, y, { max_depth: 3, n_trees: 50, seed: 9 });
  const json = serialize(model);
  const restored = deserialize(json);

  const test_ = makeInteractionData(50, 1234);
  for (let i = 0; i < test_.X.length; i++) {
    assert.equal(predict(restored, test_.X[i]), predict(model, test_.X[i]));
  }
  // deserialize also accepts an already-parsed object.
  const restored2 = deserialize(JSON.parse(json));
  assert.equal(predict(restored2, test_.X[0]), predict(model, test_.X[0]));
});

test('serialize is stable: same model serializes to the same bytes twice', () => {
  const { X, y } = makeInteractionData(200, 3);
  const model = fit(X, y, { seed: 11 });
  assert.equal(serialize(model), serialize(model));
});

test('deserialize rejects malformed input', () => {
  assert.throws(() => deserialize('not json {'), /./);
  assert.throws(() => deserialize({ no_trees: true }), /trees/);
  assert.throws(() => deserialize(null), /model object/);
});

// -----------------------------------------------------------------------------
// (4) HONEST / NaN-SAFE envelope
// -----------------------------------------------------------------------------

test('predict never returns NaN, even on garbage rows or empty model', () => {
  const { X, y } = makeInteractionData(120, 8);
  const model = fit(X, y, { n_trees: 20, seed: 4 });
  assert.ok(Number.isFinite(predict(model, [NaN, undefined, 'x'])));
  assert.ok(Number.isFinite(predict(model, null)));
  assert.ok(Number.isFinite(predict(model, {})));
  // Empty / absent model degrades to 0, not NaN.
  assert.equal(predict({ base: 0.5, trees: [] }, [1, 2, 3]), 0.5);
  assert.equal(predict(null, [1]), 0);
});

test('fit throws on shape errors but produces a usable single-row-class model', () => {
  assert.throws(() => fit('x', []), TypeError);
  assert.throws(() => fit([[1]], [1, 2]), TypeError);
  assert.throws(() => fit([], []), TypeError);
  // A degenerate constant target: base learns the mean, predict returns near it.
  const model = fit([[1], [2], [3], [4]], [0.7, 0.7, 0.7, 0.7], { n_trees: 10 });
  assert.ok(Math.abs(predict(model, [2.5]) - 0.7) < 1e-6);
});

// -----------------------------------------------------------------------------
// (5) SHRINKAGE + baseline behavior
// -----------------------------------------------------------------------------

test('F_0 baseline equals mean(y) when no trees split (depth honored)', () => {
  // All-identical features => no split possible => model collapses to the base.
  // Disable the holdout (so base = mean over ALL rows) and L2 (so leaf steps
  // are unregularized) to assert the exact textbook F_0 = mean(y) contract.
  const X = [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]];
  const y = [0.2, 0.4, 0.6, 0.8, 0.5, 0.5];
  const model = fit(X, y, {
    n_trees: 30, max_depth: 3, lambda: 0, gamma: 0,
    early_stopping_rounds: 0, subsample: 1, colsample: 1,
  });
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  // No feature variation -> trees cannot split -> prediction == base == mean(y).
  assert.equal(model.base, mean);
  assert.ok(Math.abs(predict(model, [1, 1]) - mean) < 1e-9);
});

test('lower learning_rate underfits relative to higher rate at equal trees', () => {
  const { X, y } = makeInteractionData(400, 13);
  const test_ = makeInteractionData(200, 77);
  const slow = fit(X, y, { learning_rate: 0.01, n_trees: 30, max_depth: 3,
    subsample: 1, colsample: 1, early_stopping_rounds: 0 });
  const fast = fit(X, y, { learning_rate: 0.3, n_trees: 30, max_depth: 3,
    subsample: 1, colsample: 1, early_stopping_rounds: 0 });
  // With few trees, a tiny LR has not yet fit the signal => worse RMSE.
  assert.ok(rmse(slow, test_.X, test_.y) > rmse(fast, test_.X, test_.y));
});

// -----------------------------------------------------------------------------
// (6) EARLY STOPPING trims the ensemble
// -----------------------------------------------------------------------------

test('early stopping trims n_trees_used at or below the requested n_trees', () => {
  const { X, y } = makeInteractionData(300, 31);
  const model = fit(X, y, {
    max_depth: 2, n_trees: 500, learning_rate: 0.2,
    early_stopping_rounds: 10, validation_fraction: 0.2, seed: 3,
  });
  assert.ok(model.n_trees_used <= 500);
  assert.equal(model.trees.length, model.n_trees_used);
  assert.ok(model.n_trees_used >= 1);
});

// -----------------------------------------------------------------------------
// (7) RAGGED INPUT + colsample/subsample plumbing
// -----------------------------------------------------------------------------

test('ragged feature rows infer width from the widest row (zero-fill)', () => {
  const X = [[1, 2, 3], [4, 5], [6], [7, 8, 9]];
  const y = [0.1, 0.2, 0.3, 0.4];
  const model = fit(X, y, { n_trees: 5 });
  assert.equal(model.n_features, 3);
  assert.ok(Number.isFinite(predict(model, [1])));        // short row OK
  assert.ok(Number.isFinite(predict(model, [1, 2, 3, 4]))); // long row OK
});

test('predictBatch maps predict over rows', () => {
  const { X, y } = makeInteractionData(100, 6);
  const model = fit(X, y, { n_trees: 10, seed: 6 });
  const out = predictBatch(model, X.slice(0, 5));
  assert.equal(out.length, 5);
  assert.ok(out.every(Number.isFinite));
  assert.deepEqual(predictBatch(model, 'nope'), []);
});

// -----------------------------------------------------------------------------
// (8) Defaults + internals sanity
// -----------------------------------------------------------------------------

test('GBM_DEFAULTS expose the documented contract', () => {
  assert.equal(GBM_DEFAULTS.max_depth, 3);
  assert.equal(GBM_DEFAULTS.learning_rate, 0.05);
  assert.equal(GBM_MODEL_VERSION, 'gbm-v1');
  assert.ok(Object.isFrozen(GBM_DEFAULTS));
});

test('seeded rng is reproducible and bounded in [0,1)', () => {
  const a = __internals.makeRng(123);
  const b = __internals.makeRng(123);
  for (let i = 0; i < 50; i++) {
    const va = a();
    const vb = b();
    assert.equal(va, vb);
    assert.ok(va >= 0 && va < 1);
  }
});

test('leafWeight is the regularized negative-mean-gradient', () => {
  // grad = -residual; two rows, grad = [-0.4, -0.6], hess = [1,1], lambda=0.
  const grad = [-0.4, -0.6];
  const hess = [1, 1];
  const w = __internals.leafWeight(grad, hess, [0, 1], 0);
  // w* = -G/(H+lambda) = -(-1.0)/2 = 0.5
  assert.ok(Math.abs(w - 0.5) < 1e-12);
});
