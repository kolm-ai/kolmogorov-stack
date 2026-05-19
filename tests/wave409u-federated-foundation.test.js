// W409u — federated learning foundations (honest labeling).
//
// Audit said: "no secure aggregation/network/production Byzantine
// robustness". W409u keeps the working aggregator + DP helpers but labels
// every surface `feature_state: 'foundation'` so the product copy + the
// verifier cannot pretend it's production federated learning.
//
// Tests assert behavior:
//   1. Every produced object (round, contribution receipt, aggregation
//      receipt) carries feature_state:'foundation'.
//   2. Round + receipt declare transport:'in_memory_dev_only' by default.
//   3. Aggregation receipt locks byzantine_robust:false.
//   4. secure_aggregation defaults to {status:'not_verified', provider:null}.
//   5. privacy_budget defaults to {epsilon:null, delta:null}.
//   6. verifyFederatedArtifact rejects when secure_aggregation_verified:true
//      is claimed but no plugin is registered.
//   7. Registering a plugin that returns ok:true upgrades the verifier
//      output to secure_aggregation_verified:true.
//   8. Lineage trace: artifact → aggregation_round → client_updates →
//      dataset_hash is reachable from the receipt.
//   9. client_update schema fields (round_id, client_id, gradient_summary_hash,
//      sample_count, dataset_hash) are populated by buildContribution.
//  10. aggregation_round schema fields (round_id, participants, started_at,
//      completed_at, aggregation_method, byzantine_robust:false) populated
//      by aggregate().
//  11. verifyContribution rejects an unreviewed client_update.
//  12. PRODUCT_COPY constants never claim "production federated learning".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FL_SPEC_VERSION,
  FEATURE_STATE,
  FEATURE_STATE_LABEL,
  FEATURE_STATE_DESCRIPTION,
  STRATEGIES,
  newRound,
  buildContribution,
  verifyContribution,
  aggregate,
  verifyFederatedArtifact,
  traceLineage,
  registerSecureAggregationPlugin,
  clearSecureAggregationPlugin,
  listSecureAggregationPlugins,
} from '../src/federated-learning.js';

function fakeDelta() {
  return { layer1: [0.1, 0.2, 0.3], layer2: [-0.1, 0.0, 0.4] };
}

function happyRound(over = {}) {
  return newRound({
    round_id: 'rnd-1',
    model_hash: 'm-aaaaaaaa',
    base_artifact_version: 'v1',
    target_strategy: STRATEGIES.FEDAVG,
    min_participants: 2,
    ...over,
  });
}

function happyContribution(round, client_id = 'cli-1', { reviewed = 'approved', dataset_hash = 'ds_aaaa' } = {}) {
  return buildContribution({
    round, participant_id: client_id, client_id,
    delta: fakeDelta(), sample_count: 100,
    dataset_hash,
    reviewed: { state: reviewed, reviewer: 'lead' },
  });
}

// ───────────────────────────────────────────────────────────────────────────

test('W409u #1 — feature_state:"foundation" everywhere (round, contribution, aggregation)', () => {
  const round = happyRound();
  assert.equal(round.feature_state, FEATURE_STATE);
  assert.equal(round.feature_state, 'foundation');

  const c1 = happyContribution(round, 'a');
  const c2 = happyContribution(round, 'b');
  assert.equal(c1.receipt.feature_state, 'foundation');
  assert.equal(c2.receipt.feature_state, 'foundation');

  const { receipt: agg } = aggregate({ round, contributions: [c1, c2] });
  assert.equal(agg.feature_state, 'foundation');
});

test('W409u #2 — transport defaults to in_memory_dev_only', () => {
  const round = happyRound();
  assert.equal(round.transport, 'in_memory_dev_only');
});

test('W409u #3 — aggregation receipt locks byzantine_robust:false', () => {
  const round = happyRound();
  const c1 = happyContribution(round, 'a');
  const c2 = happyContribution(round, 'b');
  const { receipt: agg } = aggregate({ round, contributions: [c1, c2] });
  assert.equal(agg.byzantine_robust, false);
  assert.equal(round.byzantine_robust, false);
});

test('W409u #4 — secure_aggregation defaults to status:not_verified, provider:null', () => {
  const round = happyRound();
  assert.equal(round.secure_aggregation.status, 'not_verified');
  assert.equal(round.secure_aggregation.provider, null);
  assert.equal(round.secure_aggregation.verified_at, null);
  const c1 = happyContribution(round, 'a');
  const c2 = happyContribution(round, 'b');
  const { receipt: agg } = aggregate({ round, contributions: [c1, c2] });
  assert.equal(agg.secure_aggregation.status, 'not_verified');
  assert.equal(agg.secure_aggregation.provider, null);
});

test('W409u #5 — privacy_budget defaults to epsilon:null, delta:null', () => {
  const round = happyRound();
  assert.deepEqual(round.privacy_budget, { epsilon: null, delta: null });
  const c1 = happyContribution(round, 'a');
  const c2 = happyContribution(round, 'b');
  const { receipt: agg } = aggregate({ round, contributions: [c1, c2] });
  assert.deepEqual(agg.privacy_budget, { epsilon: null, delta: null });
});

test('W409u #6 — verifyFederatedArtifact rejects secure_aggregation_verified:true claim without plugin', async () => {
  const artifact = {
    secure_aggregation: { status: 'verified', provider: 'azure-secagg' },
    secure_aggregation_verified: true,
  };
  // No plugin registered → MUST reject.
  const r = await verifyFederatedArtifact(artifact);
  assert.equal(r.ok, false);
  assert.equal(r.secure_aggregation_verified, false);
  assert.equal(r.reason, 'secure_aggregation_no_plugin');
  assert.equal(r.federated_foundation, true);
});

test('W409u #7 — registering a plugin that returns ok:true flips secure_aggregation_verified to true', async () => {
  registerSecureAggregationPlugin('azure-secagg', async () => ({ ok: true, trust_root: 'azure-root' }));
  try {
    const artifact = {
      secure_aggregation: { status: 'verified', provider: 'azure-secagg' },
      secure_aggregation_verified: true,
    };
    const r = await verifyFederatedArtifact(artifact);
    assert.equal(r.ok, true);
    assert.equal(r.secure_aggregation_verified, true);
    assert.equal(r.plugin, 'azure-secagg');
    assert.equal(r.federated_foundation, true, 'foundation flag remains true even after plugin verification');
  } finally {
    clearSecureAggregationPlugin('azure-secagg');
  }
});

test('W409u #7b — plugin that returns ok:false leaves secure_aggregation_verified:false', async () => {
  registerSecureAggregationPlugin('bad', async () => ({ ok: false, reason: 'no_trust' }));
  try {
    const artifact = {
      secure_aggregation: { status: 'verified', provider: 'bad' },
      secure_aggregation_verified: true,
    };
    const r = await verifyFederatedArtifact(artifact);
    assert.equal(r.ok, false);
    assert.equal(r.secure_aggregation_verified, false);
    assert.equal(r.reason, 'secure_aggregation_plugin_returned_falsy');
  } finally {
    clearSecureAggregationPlugin('bad');
  }
});

test('W409u #8 — lineage trace: artifact → aggregation_round → client_updates → dataset_hash', () => {
  const round = happyRound();
  const c1 = happyContribution(round, 'a', { dataset_hash: 'ds_a' });
  const c2 = happyContribution(round, 'b', { dataset_hash: 'ds_b' });
  const { receipt: agg } = aggregate({ round, contributions: [c1, c2] });
  const trace = traceLineage(agg);
  // Each client_update entry surfaces gradient_summary_hash + dataset_hash.
  assert.equal(trace.client_updates.length, 2);
  for (const cu of trace.client_updates) {
    assert.ok(cu.client_id);
    assert.ok(cu.gradient_summary_hash);
    assert.equal(typeof cu.sample_count, 'number');
    assert.ok(cu.dataset_hash);
    assert.equal(cu.reviewed_state, 'approved');
  }
  // dataset_hashes set is reachable end-to-end.
  assert.deepEqual(trace.dataset_hashes, ['ds_a', 'ds_b']);
});

test('W409u #9 — client_update schema fields populated by buildContribution', () => {
  const round = happyRound();
  const c = happyContribution(round, 'cli-9', { dataset_hash: 'ds_z' });
  assert.equal(c.receipt.round_id, 'rnd-1');
  assert.equal(c.receipt.client_id, 'cli-9');
  assert.ok(c.receipt.gradient_summary_hash);
  assert.equal(c.receipt.gradient_summary_hash, c.receipt.delta_hash, 'gradient_summary_hash aliases delta_hash');
  assert.equal(c.receipt.sample_count, 100);
  assert.equal(c.receipt.dataset_hash, 'ds_z');
  assert.equal(c.receipt.reviewed.state, 'approved');
  assert.equal(c.receipt.reviewed.reviewer, 'lead');
});

test('W409u #10 — aggregation_round schema fields populated by aggregate()', () => {
  const round = happyRound();
  const c1 = happyContribution(round, 'a');
  const c2 = happyContribution(round, 'b');
  const started = new Date().toISOString();
  const { receipt } = aggregate({ round, contributions: [c1, c2], started_at: started });
  assert.equal(receipt.round_id, 'rnd-1');
  assert.deepEqual(receipt.participants.sort(), ['a', 'b']);
  assert.equal(receipt.started_at, started);
  assert.ok(receipt.completed_at);
  assert.equal(receipt.aggregation_method, STRATEGIES.FEDAVG);
  assert.equal(receipt.byzantine_robust, false);
});

test('W409u #11 — verifyContribution rejects an unreviewed client_update when require_reviewed:true', () => {
  const round = happyRound();
  const c = buildContribution({
    round, participant_id: 'cli-u', delta: fakeDelta(), sample_count: 10,
    reviewed: { state: 'pending', reviewer: null },
  });
  const v = verifyContribution({ contribution: c, round, require_reviewed: true });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unreviewed_client_update');
});

test('W409u #11b — verifyContribution accepts an approved client_update with require_reviewed:true', () => {
  const round = happyRound();
  const c = buildContribution({
    round, participant_id: 'cli-r', delta: fakeDelta(), sample_count: 10,
    reviewed: { state: 'approved', reviewer: 'lead' },
  });
  const v = verifyContribution({ contribution: c, round, require_reviewed: true });
  assert.equal(v.ok, true);
});

test('W409u #11c — verifyContribution default (no flag) is back-compat — passes pending', () => {
  // Pre-W409u callers (e.g. /v1/fl/contribution/verify) keep working until
  // they opt into the review gate.
  const round = happyRound();
  const c = buildContribution({
    round, participant_id: 'cli-d', delta: fakeDelta(), sample_count: 10,
    reviewed: { state: 'pending', reviewer: null },
  });
  const v = verifyContribution({ contribution: c, round });
  assert.equal(v.ok, true);
});

test('W409u #12 — product copy constants never claim "production federated learning"', () => {
  // The FEATURE_STATE_LABEL + FEATURE_STATE_DESCRIPTION are what product
  // pages read. They MUST surface "foundation" and MUST NOT pretend to be
  // production federated learning.
  assert.equal(FEATURE_STATE, 'foundation');
  assert.match(FEATURE_STATE_LABEL, /foundation/i);
  assert.match(FEATURE_STATE_DESCRIPTION, /foundation/i);
  assert.doesNotMatch(FEATURE_STATE_LABEL, /\bproduction federated learning\b/i);
  assert.doesNotMatch(FEATURE_STATE_DESCRIPTION, /\bproduction federated learning\b/i);
});

test('W409u #13 — plugin registry list returns the currently-registered providers', () => {
  // Spec invariant: list is sorted + reflects what was registered.
  registerSecureAggregationPlugin('a-prov', async () => ({ ok: true }));
  registerSecureAggregationPlugin('z-prov', async () => ({ ok: true }));
  try {
    const ls = listSecureAggregationPlugins();
    assert.ok(ls.includes('a-prov'));
    assert.ok(ls.includes('z-prov'));
    assert.deepEqual(ls.slice().sort(), ls);
  } finally {
    clearSecureAggregationPlugin('a-prov');
    clearSecureAggregationPlugin('z-prov');
  }
});

test('W409u #14 — spec version constants survive', () => {
  assert.equal(FL_SPEC_VERSION, 'fl-v1');
  assert.equal(FEATURE_STATE, 'foundation');
});
