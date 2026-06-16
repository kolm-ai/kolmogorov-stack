// Finalized C6 - contamination-impact estimation + clean/dirty accuracy
// decomposition + contamination-corrected K-score.
//
// Proves:
//   1)  3-tier cascade (exact/near/grouped) flags the right holdout rows
//       HOLDOUT-vs-TRAIN.
//   2)  Accuracy decomposes into accuracy_reported / accuracy_clean /
//       accuracy_flagged correctly.
//   3)  Inflation delta = reported - clean, and is POSITIVE when flagged rows
//       score higher (the inflation case).
//   4)  Bootstrap CI is seeded + reproducible + brackets the point delta.
//   5)  Corrected K-score feeds accuracy_clean as the A axis and is <= raw
//       K-score (downward-only correction; fail-closed preserved).
//   6)  ship_decision_flipped is surfaced when contamination flips the gate.
//   7)  Signed block round-trips through verifyContaminationImpactBlock.
//   8)  Tamper with corrected accuracy -> hash drift detected.
//   9)  Tamper with a signed block -> signature fails.
//  10)  No-contamination case: clean==reported, delta 0, flagged null.
//  11)  correctness/holdout length mismatch throws.
//  12)  Unsigned path (sign:false) -> signed:false, hash still verifies.
//  13)  Privacy: emitted block carries no raw row text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateContaminationImpact,
  partitionHoldout,
  bootstrapDeltaCI,
  verifyContaminationImpactBlock,
  CONTAMINATION_IMPACT_SPEC,
} from '../src/contamination-impact.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';

function row(input, expected, tags) {
  return { input, expected, metadata: tags ? { tags } : {} };
}

const SIGNER = (() => {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
})();

const BASE_KINPUTS = {
  size_bytes: 4096,
  coverage: 1,
  p50_latency_us: 500,
  cost_usd_per_call: 0,
};

// ── Tier cascade ────────────────────────────────────────────────────────────

test('1) 3-tier cascade flags exact, near, and grouped holdout rows', () => {
  const train = [
    row('what is the capital of france', 'paris'),
    row('the quick brown fox jumps over the lazy dog today', 'foxlabel', ['member:alice']),
  ];
  const holdout = [
    row('what is the capital of france', 'paris'),                            // exact (input+output)
    row('the quick brown fox jumps over the lazy dog right now', 'rephrase'), // near (distinct label)
    row('totally unrelated question about astronomy and stars', 'astro', ['member:alice']), // grouped
    row('a fully clean row sharing nothing with the training set', 'cleanlabel'), // clean
  ];
  const part = partitionHoldout(train, holdout, { similarity_threshold: 0.4, group_key: 'member' });
  assert.ok(part.tier_hits.exact.includes(0), 'row 0 exact');
  assert.ok(part.tier_hits.near.includes(1), 'row 1 near');
  assert.ok(part.tier_hits.grouped.includes(2), 'row 2 grouped');
  assert.deepEqual(part.clean_indices, [3], 'only row 3 is clean');
  assert.equal(part.flagged_indices.length, 3);
});

// ── Decomposition + inflation ───────────────────────────────────────────────

test('2/3) accuracy decomposes and inflation delta is positive when flagged rows inflate', () => {
  // 4 flagged rows (all correct via memorization) + 4 clean rows (half correct).
  const train = [row('memorized prompt one', 'a'), row('memorized prompt two', 'b')];
  const holdout = [
    row('memorized prompt one', 'a'),   // 0 exact, correct
    row('memorized prompt two', 'b'),   // 1 exact, correct
    row('memorized prompt one', 'a'),   // 2 exact, correct
    row('memorized prompt two', 'b'),   // 3 exact, correct
    row('clean q1', 'x'),               // 4 clean, correct
    row('clean q2', 'y'),               // 5 clean, wrong
    row('clean q3', 'z'),               // 6 clean, correct
    row('clean q4', 'w'),               // 7 clean, wrong
  ];
  const correctness = [1, 1, 1, 1, 1, 0, 1, 0];
  const block = estimateContaminationImpact({
    train, holdout, correctness,
    kscore_inputs: BASE_KINPUTS,
    cascade: { similarity_threshold: 0.99 },
    bootstrap: { iterations: 1000, seed: 7 },
    signer: SIGNER,
    generated_at: '2026-06-17T00:00:00.000Z',
  });
  assert.equal(block.decomposition.accuracy_reported, 0.75); // 6/8
  assert.equal(block.decomposition.accuracy_clean, 0.5);     // 2/4
  assert.equal(block.decomposition.accuracy_flagged, 1.0);   // 4/4
  assert.equal(block.decomposition.flagged_count, 4);
  assert.equal(block.decomposition.clean_count, 4);
  assert.equal(block.inflation.delta, 0.25); // 0.75 - 0.5
  assert.ok(block.inflation.delta > 0, 'inflation positive');
});

// ── Bootstrap CI ────────────────────────────────────────────────────────────

test('4) bootstrap CI is seeded, reproducible, and brackets the point delta', () => {
  const correctness = [1, 1, 1, 1, 1, 0, 1, 0];
  const cleanSet = new Set([4, 5, 6, 7]);
  const a = bootstrapDeltaCI(correctness, cleanSet, { iterations: 1500, seed: 42 });
  const b = bootstrapDeltaCI(correctness, cleanSet, { iterations: 1500, seed: 42 });
  assert.deepEqual(a, b, 'same seed => identical CI');
  assert.ok(a.ci_low <= a.point && a.point <= a.ci_high, 'point inside CI');
  // Different seed should still be a valid interval (not necessarily identical).
  const c = bootstrapDeltaCI(correctness, cleanSet, { iterations: 1500, seed: 99 });
  assert.ok(c.ci_low <= c.ci_high);
});

test('4b) bootstrap honest envelope when no clean rows', () => {
  const out = bootstrapDeltaCI([1, 0, 1], new Set(), { iterations: 100, seed: 1 });
  assert.equal(out.ci_low, null);
  assert.equal(out.reason, 'no_clean_rows');
});

// ── Corrected K-score ───────────────────────────────────────────────────────

test('5) corrected K-score uses accuracy_clean as A and is <= raw K-score', () => {
  const train = [row('mem one', 'a'), row('mem two', 'b')];
  const holdout = [
    row('mem one', 'a'), row('mem two', 'b'),
    row('clean a', 'x'), row('clean b', 'y'),
  ];
  const correctness = [1, 1, 1, 0]; // flagged both right, clean 1/2
  const block = estimateContaminationImpact({
    train, holdout, correctness,
    kscore_inputs: { ...BASE_KINPUTS, holdout_accuracy: 0.75 },
    cascade: { similarity_threshold: 0.99 },
    bootstrap: { iterations: 500, seed: 3 },
    signer: SIGNER,
    generated_at: '2026-06-17T00:00:00.000Z',
  });
  assert.equal(block.kscore.raw.accuracy, 0.75);
  assert.equal(block.kscore.corrected.accuracy, 0.5); // accuracy_clean = 2/4? -> clean rows idx2,3 = [1,0] = 0.5
  assert.ok(block.kscore.corrected.composite <= block.kscore.raw.composite,
    'corrected composite <= raw (downward-only)');
  assert.ok(block.kscore.correction >= 0, 'correction magnitude non-negative');
});

test('6) ship_decision_flipped surfaces when contamination flips the gate', () => {
  // Raw accuracy high enough to ship, clean accuracy low enough to fail.
  const train = [row('leak one', 'a'), row('leak two', 'b'), row('leak three', 'c'), row('leak four', 'd')];
  const holdout = [
    row('leak one', 'a'), row('leak two', 'b'), row('leak three', 'c'), row('leak four', 'd'), // flagged, all correct
    row('clean one', 'x'),  // clean, wrong
  ];
  const correctness = [1, 1, 1, 1, 0];
  const block = estimateContaminationImpact({
    train, holdout, correctness,
    // High S/L/C/V so the composite hangs on A near the 0.85 gate.
    kscore_inputs: { size_bytes: 256, coverage: 1, p50_latency_us: 1, cost_usd_per_call: 0 },
    cascade: { similarity_threshold: 0.99 },
    bootstrap: { iterations: 400, seed: 5 },
    sign: false,
    generated_at: '2026-06-17T00:00:00.000Z',
  });
  // reported = 4/5 = 0.8; clean = 0/1 = 0.0. K(raw) vs K(corrected) should differ
  // in ship decision given the heavy non-A weights are maxed.
  assert.equal(block.kscore.raw.ships, true);
  assert.equal(block.kscore.corrected.ships, false);
  assert.equal(block.kscore.ship_decision_flipped, true);
});

// ── Signing + verification ──────────────────────────────────────────────────

test('7) signed block round-trips through verifier', () => {
  const train = [row('q', 'a')];
  const holdout = [row('q', 'a'), row('clean', 'b')];
  const block = estimateContaminationImpact({
    train, holdout, correctness: [1, 1],
    kscore_inputs: BASE_KINPUTS,
    signer: SIGNER,
    generated_at: '2026-06-17T00:00:00.000Z',
  });
  assert.equal(block.spec, CONTAMINATION_IMPACT_SPEC);
  assert.equal(block.signed, true);
  const res = verifyContaminationImpactBlock(block);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.hash_ok, true);
  assert.equal(res.signature_ok, true);
});

test('8) tamper with corrected accuracy is caught by content_hash', () => {
  const block = estimateContaminationImpact({
    train: [row('q', 'a')], holdout: [row('q', 'a'), row('clean', 'b')], correctness: [1, 0],
    kscore_inputs: BASE_KINPUTS, signer: SIGNER, generated_at: '2026-06-17T00:00:00.000Z',
  });
  block.kscore.corrected.accuracy = 0.999; // forge a better corrected number
  const res = verifyContaminationImpactBlock(block);
  assert.equal(res.ok, false);
  assert.equal(res.hash_ok, false);
  assert.match(res.reason, /content_hash drift/);
});

test('9) tamper after re-hashing still fails the signature', async () => {
  const block = estimateContaminationImpact({
    train: [row('q', 'a')], holdout: [row('q', 'a'), row('clean', 'b')], correctness: [1, 0],
    kscore_inputs: BASE_KINPUTS, signer: SIGNER, generated_at: '2026-06-17T00:00:00.000Z',
  });
  // Forge the corrected number AND recompute a matching content_hash, but the
  // signature still covers the original content_hash -> signature must fail.
  block.inflation.delta = -0.5;
  // Recompute content_hash over the tampered core so hash_ok passes.
  const { content_hash, signed, signature, ...core } = block;
  // eslint-disable-next-line no-undef
  const crypto = await import('node:crypto');
  const { canonicalJson } = await import('../src/seeds.js');
  block.content_hash = crypto.createHash('sha256').update(canonicalJson(core)).digest('hex');
  const res = verifyContaminationImpactBlock(block);
  assert.equal(res.hash_ok, true, 'hash recomputed to match the forgery');
  assert.equal(res.signature_ok, false, 'signature does not cover the forged content_hash');
  assert.equal(res.ok, false);
});

// ── No-contamination + edge cases ───────────────────────────────────────────

test('10) no-contamination: clean==reported, delta 0, flagged null', () => {
  const block = estimateContaminationImpact({
    train: [row('train only', 'a')],
    holdout: [row('fresh one', 'x'), row('fresh two', 'y')],
    correctness: [1, 0],
    kscore_inputs: BASE_KINPUTS, signer: SIGNER, generated_at: '2026-06-17T00:00:00.000Z',
  });
  assert.equal(block.decomposition.flagged_count, 0);
  assert.equal(block.decomposition.accuracy_flagged, null);
  assert.equal(block.decomposition.accuracy_clean, block.decomposition.accuracy_reported);
  assert.equal(block.inflation.delta, 0);
  assert.equal(block.kscore.correction, 0);
  assert.equal(verifyContaminationImpactBlock(block).ok, true);
});

test('11) correctness/holdout length mismatch throws', () => {
  assert.throws(() => estimateContaminationImpact({
    train: [], holdout: [row('a', 'b')], correctness: [1, 0], kscore_inputs: BASE_KINPUTS, sign: false,
  }), /must equal holdout length/);
});

test('12) unsigned path (sign:false) -> signed:false, hash still verifies', () => {
  const block = estimateContaminationImpact({
    train: [row('q', 'a')], holdout: [row('q', 'a'), row('clean', 'b')], correctness: [1, 1],
    kscore_inputs: BASE_KINPUTS, sign: false, generated_at: '2026-06-17T00:00:00.000Z',
  });
  assert.equal(block.signed, false);
  assert.equal(block.signature, null);
  const res = verifyContaminationImpactBlock(block);
  assert.equal(res.ok, true);
  assert.equal(res.signature_ok, null);
});

test('13) privacy: emitted block carries no raw row text', () => {
  const secret = 'PATIENT_SSN_123456789_DO_NOT_LEAK';
  const block = estimateContaminationImpact({
    train: [row(secret, secret)],
    holdout: [row(secret, secret), row('clean unrelated text', 'ok')],
    correctness: [1, 1],
    kscore_inputs: BASE_KINPUTS, signer: SIGNER, generated_at: '2026-06-17T00:00:00.000Z',
  });
  const serialized = JSON.stringify(block);
  assert.ok(!serialized.includes(secret), 'no raw sensitive row text in the emitted block');
});
