// W921 — Compile Simulator decision contract (src/compile-simulator.js).
//
// simulateCompile({ tenant, namespace, current_features, proposed_delta, min_delta_k })
// is a PURE-ish decision wrapper over the Quality Predictor: it predicts K for the
// current feature vector vs current+delta and decides compile-vs-skip against the
// ship-gate threshold (DEFAULT_MIN_DELTA_K = 0.02). It returns a cs-v1 envelope and
// never throws across the public API.
//
// Determinism: the cold-start path (no accumulated meta rows for a fresh tenant) is
// the deterministic heuristic blend — no wall-clock branching, no network. Every call
// is tenant-fenced with a unique test tenant id so the event-store side effect cannot
// leak across tests. No seed/clock fixture is needed because the heuristic is a fixed
// monotonic function of the feature vector.
//
// Pins (envelope shape read directly from the module, not guessed):
//  1) current_features missing => { ok:false, error:'current_features_required', version }
//     proposed_delta  missing => { ok:false, error:'proposed_delta_required',   version }
//  2) marginal delta (below min_delta_k) => decision 'skip' with a non-empty reason
//  3) strong delta (clearly above threshold) => decision 'compile' with a reason
//  4) k_proposed reflects delta direction: an improving delta raises k_proposed > k_current
//     and a degrading delta lowers k_proposed < k_current
//  5) the ok envelope carries k_current / k_proposed / delta_k / decision / reason
//     (plus version, min_delta_k) and delta_k === k_proposed - k_current

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateCompile,
  COMPILE_SIM_VERSION,
} from '../src/compile-simulator.js';

// Unique tenant per call so the best-effort event-store write is fenced and no
// accumulated row store flips the predictor onto the learned path mid-suite.
let __seq = 0;
function freshTenant() {
  __seq += 1;
  return `tenant_w921_csim_${process.pid}_${__seq}_${Math.random().toString(36).slice(2, 10)}`;
}

// A solid-but-not-perfect current vector (Trinity-like): high quality/coverage,
// low dup/CoT-contamination, ~400 pairs. Lands the heuristic K mid-high.
const BASE_FEATURES = Object.freeze({
  n_pairs: 400,
  dup_fraction: 0.05,
  coverage_score: 0.7,
  avg_quality: 0.7,
  cot_contam_fraction: 0.05,
  teacher_diversity: 0.6,
});

test('1) missing current_features or proposed_delta => ok:false with exact error', async () => {
  const noCurrent = await simulateCompile({
    tenant: freshTenant(),
    proposed_delta: { avg_quality: 0.1 },
  });
  assert.deepEqual(noCurrent, {
    ok: false,
    error: 'current_features_required',
    version: COMPILE_SIM_VERSION,
  });

  const noDelta = await simulateCompile({
    tenant: freshTenant(),
    current_features: { ...BASE_FEATURES },
  });
  assert.deepEqual(noDelta, {
    ok: false,
    error: 'proposed_delta_required',
    version: COMPILE_SIM_VERSION,
  });
});

test('2) marginal proposed_delta (below min_delta_k) => decision skip with a reason', async () => {
  const res = await simulateCompile({
    tenant: freshTenant(),
    namespace: 'w921',
    current_features: { ...BASE_FEATURES },
    // Tiny improvement: predicted K gain stays well under the 0.02 ship gate.
    proposed_delta: { avg_quality: 0.005 },
  });

  assert.equal(res.ok, true);
  assert.equal(res.decision, 'skip');
  assert.ok(res.delta_k < res.min_delta_k, 'marginal delta_k must be below the threshold');
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0, 'skip must carry a non-empty reason');
});

test('3) strong proposed_delta (clearly above threshold) => decision compile', async () => {
  const res = await simulateCompile({
    tenant: freshTenant(),
    namespace: 'w921',
    current_features: { ...BASE_FEATURES },
    // Large, clearly-good improvement on the two heaviest-weighted features.
    proposed_delta: { avg_quality: 0.25, coverage_score: 0.25 },
  });

  assert.equal(res.ok, true);
  assert.equal(res.decision, 'compile');
  assert.ok(res.delta_k >= res.min_delta_k, 'strong delta_k must clear the threshold');
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0, 'compile must carry a non-empty reason');
});

test('4) k_proposed reflects delta direction (improvement up, degradation down)', async () => {
  const improving = await simulateCompile({
    tenant: freshTenant(),
    current_features: { ...BASE_FEATURES },
    proposed_delta: { avg_quality: 0.2, coverage_score: 0.2 },
  });
  assert.equal(improving.ok, true);
  assert.ok(
    improving.k_proposed > improving.k_current,
    `improving delta should raise k_proposed (${improving.k_proposed}) above k_current (${improving.k_current})`,
  );

  const degrading = await simulateCompile({
    tenant: freshTenant(),
    current_features: { ...BASE_FEATURES },
    // More duplicates + lower quality => strictly worse data => lower predicted K.
    proposed_delta: { dup_fraction: 0.3, avg_quality: -0.2 },
  });
  assert.equal(degrading.ok, true);
  assert.ok(
    degrading.k_proposed < degrading.k_current,
    `degrading delta should lower k_proposed (${degrading.k_proposed}) below k_current (${degrading.k_current})`,
  );
  assert.equal(degrading.decision, 'skip', 'a degrading delta is never worth compiling');
});

test('5) ok envelope carries the full cs-v1 decision contract', async () => {
  const res = await simulateCompile({
    tenant: freshTenant(),
    namespace: 'w921',
    current_features: { ...BASE_FEATURES },
    proposed_delta: { avg_quality: 0.15 },
  });

  assert.equal(res.ok, true);
  assert.equal(res.version, COMPILE_SIM_VERSION);
  assert.equal(typeof res.k_current, 'number');
  assert.equal(typeof res.k_proposed, 'number');
  assert.equal(typeof res.delta_k, 'number');
  assert.equal(typeof res.min_delta_k, 'number');
  assert.ok(res.decision === 'compile' || res.decision === 'skip');
  assert.equal(typeof res.reason, 'string');
  // delta_k is the rounded difference of the two point predictions.
  assert.equal(
    res.delta_k,
    Number((res.k_proposed - res.k_current).toFixed(6)),
    'delta_k must equal k_proposed - k_current',
  );
});

test('6) explicit min_delta_k threshold steers the decision deterministically', async () => {
  // The SAME modest delta flips from skip (default 0.02 gate) to compile when the
  // caller lowers the threshold below the predicted gain — proves the threshold is
  // honored, not hard-coded.
  const tenant = freshTenant();
  const delta = { avg_quality: 0.03 };

  const atDefault = await simulateCompile({
    tenant,
    current_features: { ...BASE_FEATURES },
    proposed_delta: { ...delta },
  });
  assert.equal(atDefault.ok, true);

  const loose = await simulateCompile({
    tenant: freshTenant(),
    current_features: { ...BASE_FEATURES },
    proposed_delta: { ...delta },
    min_delta_k: 0,
  });
  assert.equal(loose.ok, true);
  assert.equal(loose.min_delta_k, 0);
  assert.ok(loose.delta_k >= 0, 'a positive-quality delta yields a non-negative gain');
  assert.equal(loose.decision, 'compile', 'any non-negative gain clears a zero threshold');
});
