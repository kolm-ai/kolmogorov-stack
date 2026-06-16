// FINALIZED-C6 - regression guard for the deep-dive fix.
//
// contamination-corrected-kscore: the atom claimed the contamination correction
// was "downward-only / fail-closed" (can only LOWER the reported accuracy, only
// make the ship gate STRICTER). That was FALSE: correctedA = accuracy_clean, so
// when flagged/contaminated rows scored LOWER than clean rows, accuracy_clean >
// accuracy_reported and the correction went UPWARD -- flipping a non-shipping
// model to ship (contamination HELPING you pass, the opposite of the moat). Fix:
// clamp correctedA = min(reported, clean), making the downward-only invariant
// unconditionally true. This test reproduces the exact bug trigger (the deflation
// case the atom's own tests never covered) and asserts the correction can ONLY
// lower the K-score and can NEVER flip raw.ships=false -> corrected.ships=true.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateContaminationImpact } from '../src/contamination-impact.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';

function row(input, expected) { return { input, expected, metadata: {} }; }

const SIGNER = (() => {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
})();
const BASE_KINPUTS = { size_bytes: 4096, coverage: 1, p50_latency_us: 500, cost_usd_per_call: 0 };

// Same train/holdout/cascade as the atom's inflation test (4 flagged exact-dups +
// 4 clean) but with INVERTED correctness: flagged rows WRONG, clean rows RIGHT ->
// accuracy_clean (1.0) > accuracy_reported (0.5) -> the upward-correction trigger.
function _deflationBlock() {
  const train = [row('memorized prompt one', 'a'), row('memorized prompt two', 'b')];
  const holdout = [
    row('memorized prompt one', 'a'), row('memorized prompt two', 'b'),
    row('memorized prompt one', 'a'), row('memorized prompt two', 'b'),
    row('clean q1', 'x'), row('clean q2', 'y'), row('clean q3', 'z'), row('clean q4', 'w'),
  ];
  const correctness = [0, 0, 0, 0, 1, 1, 1, 1]; // flagged wrong, clean right
  return estimateContaminationImpact({
    train, holdout, correctness,
    kscore_inputs: BASE_KINPUTS,
    cascade: { similarity_threshold: 0.99 },
    bootstrap: { iterations: 500, seed: 7 },
    signer: SIGNER,
    generated_at: '2026-06-17T00:00:00.000Z',
  });
}

test('contamination decomposition still surfaces the real clean/flagged split', () => {
  const b = _deflationBlock();
  assert.equal(b.decomposition.accuracy_reported, 0.5); // 4/8
  assert.equal(b.decomposition.accuracy_clean, 1.0);    // 4/4 clean correct
  assert.equal(b.decomposition.accuracy_flagged, 0.0);  // 0/4 flagged correct
  // This is exactly the case where accuracy_clean > accuracy_reported.
  assert.ok(b.decomposition.accuracy_clean > b.decomposition.accuracy_reported);
});

test('correction is DOWNWARD-ONLY: clamped to min(reported, clean), inflation_delta >= 0', () => {
  const b = _deflationBlock();
  // Without the clamp this would be -0.5 (an UPWARD correction). With it: 0.
  assert.ok(b.inflation.delta >= 0,
    `inflation_delta must be >= 0 (downward-only); got ${b.inflation.delta}`);
  assert.ok(b.kscore.corrected.accuracy <= b.kscore.raw.accuracy,
    'corrected accuracy must never exceed reported (clamp)');
});

test('the corrected K-score can NEVER flip a non-shipping model to ship (moat)', () => {
  const b = _deflationBlock();
  assert.ok(b.kscore.corrected.composite <= b.kscore.raw.composite,
    `corrected composite (${b.kscore.corrected.composite}) must be <= raw (${b.kscore.raw.composite})`);
  assert.equal(b.kscore.raw.ships === false && b.kscore.corrected.ships === true, false,
    'contamination correction must NOT flip raw.ships=false -> corrected.ships=true (fail-closed)');
  assert.equal(b.kscore.ship_decision_flipped && !b.kscore.raw.ships, false,
    'a flip to MORE lenient is forbidden');
});
