// Wave 585: optional robust federated aggregation and DP budget accounting.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STRATEGIES,
  ROBUST_AGGREGATORS,
  aggregate,
  applyLaplaceNoise,
  buildContribution,
  newRound,
  verifyFederatedArtifact,
} from '../src/federated-learning.js';

function round(over = {}) {
  return newRound({
    round_id: 'w585-r1',
    model_hash: 'm-' + 'a'.repeat(16),
    target_strategy: STRATEGIES.FEDAVG,
    min_participants: 3,
    ...over,
  });
}

function contrib(roundDef, id, weights, over = {}) {
  return buildContribution({
    round: roundDef,
    participant_id: id,
    delta: { weights },
    sample_count: over.sample_count || 100,
    reviewed: { state: 'approved', reviewer: 'lead' },
    dp_applied: over.dp_applied,
  });
}

test('W585 #1 - coordinate median resists one extreme client update and marks receipt robust', () => {
  const r = round({ robust_aggregation: { method: ROBUST_AGGREGATORS.COORDINATE_MEDIAN } });
  const out = aggregate({
    round: r,
    contributions: [
      contrib(r, 'a', [1, 1, 1]),
      contrib(r, 'b', [1.1, 0.9, 1.2]),
      contrib(r, 'c', [100, -100, 100]),
    ],
  });
  assert.equal(r.byzantine_robust, true);
  assert.equal(out.receipt.byzantine_robust, true);
  assert.equal(out.receipt.byzantine_strategy.method, 'coordinate_median');
  assert.deepEqual(out.aggregated_delta.weights, [1.1, 0.9, 1.2]);
});

test('W585 #2 - trimmed mean drops high and low extremes per coordinate', () => {
  const r = round({ min_participants: 5, robust_aggregation: { method: 'trimmed_mean', f: 1 } });
  const out = aggregate({
    round: r,
    contributions: [
      contrib(r, 'a', [1]),
      contrib(r, 'b', [1.2]),
      contrib(r, 'c', [0.8]),
      contrib(r, 'd', [99]),
      contrib(r, 'e', [-99]),
    ],
  });
  assert.equal(out.receipt.byzantine_robust, true);
  assert.equal(out.aggregated_delta.weights[0], 1);
});

test('W585 #3 - Krum selects a non-outlier contribution when f=1', () => {
  const r = round({ min_participants: 5, robust_aggregation: { method: 'krum', f: 1 } });
  const out = aggregate({
    round: r,
    contributions: [
      contrib(r, 'a', [1, 1]),
      contrib(r, 'b', [1.1, 0.9]),
      contrib(r, 'c', [0.9, 1.2]),
      contrib(r, 'd', [1.2, 1.1]),
      contrib(r, 'evil', [50, -50]),
    ],
  });
  assert.equal(out.receipt.byzantine_strategy.method, 'krum');
  assert.notDeepEqual(out.aggregated_delta.weights, [50, -50]);
});

test('W585 #4 - DP budget composes participant-reported spend instead of staying null', () => {
  const r = round();
  const dp1 = applyLaplaceNoise([1, 2], { sensitivity: 1, epsilon: 0.5 }).dp_applied;
  const dp2 = applyLaplaceNoise([3, 4], { sensitivity: 1, epsilon: 0.25 }).dp_applied;
  const out = aggregate({
    round: r,
    contributions: [
      contrib(r, 'a', [1, 2], { dp_applied: dp1 }),
      contrib(r, 'b', [3, 4], { dp_applied: dp2 }),
      contrib(r, 'c', [5, 6]),
    ],
  });
  assert.equal(out.receipt.privacy_budget.epsilon, 0.75);
  assert.equal(out.receipt.privacy_budget.delta, 0);
  assert.equal(out.receipt.privacy_budget.composition, 'basic');
  assert.equal(out.receipt.dp_summary.participants_with_dp, 2);
});

test('W585 #5 - verifier accepts supported robust receipt and rejects unsupported robust claim', async () => {
  const r = round({ robust_aggregation: { method: 'multi_krum', f: 1, m: 2 }, min_participants: 5 });
  const out = aggregate({
    round: r,
    contributions: [
      contrib(r, 'a', [1, 1]),
      contrib(r, 'b', [1.1, 0.9]),
      contrib(r, 'c', [0.9, 1.2]),
      contrib(r, 'd', [1.2, 1.1]),
      contrib(r, 'evil', [50, -50]),
    ],
  });
  const verified = await verifyFederatedArtifact({ aggregation_round: out.receipt });
  assert.equal(verified.ok, true);
  assert.equal(verified.byzantine_robust, true);
  assert.equal(verified.byzantine_strategy.method, 'multi_krum');

  const bad = await verifyFederatedArtifact({ byzantine_robust: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'byzantine_robust_claimed_no_supported_strategy');
});
