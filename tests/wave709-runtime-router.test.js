// @unauthed-test — pure unit test of src/runtime-confidence-router.js; never mounts buildRouter().
// W709 — runtime confidence-aware router tests. Pins the entropy primitive
// and the routing-decision contract that the /v1/route/chat/completions
// endpoint depends on. Honest-degradation behavior (no_entropy_signal_available)
// is locked in too — if a future commit silently substitutes "always teacher"
// when logprobs are missing, these tests fail.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenEntropy,
  decideRouting,
  shouldEscalateToTeacher,
  DEFAULT_ENTROPY_THRESHOLD_NATS,
} from '../src/runtime-confidence-router.js';

// Build a synthetic OpenAI-format logprobs row from a probability distribution.
// We re-log the probs so the module's exp(logprob) round-trips to the input
// distribution (modulo floating-point noise).
function rowFromProbs(probs) {
  return {
    token: 'x',
    logprob: Math.log(probs[0]),
    top_logprobs: probs.map((p, i) => ({ token: `t${i}`, logprob: Math.log(p) })),
  };
}

// =============================================================================
// 1) tokenEntropy on a uniform 4-token distribution = log(4)
// =============================================================================

test('W709 #1 — tokenEntropy uniform 4-way distribution returns log(4)', () => {
  const probs = [0.25, 0.25, 0.25, 0.25];
  const row = rowFromProbs(probs);
  const summary = tokenEntropy([row]);
  assert.equal(summary.count, 1);
  assert.equal(summary.reason, 'ok');
  assert.ok(Math.abs(summary.per_token[0] - Math.log(4)) < 1e-9,
    `expected log(4)=${Math.log(4)} got ${summary.per_token[0]}`);
  assert.ok(Math.abs(summary.max - Math.log(4)) < 1e-9);
});

// =============================================================================
// 2) tokenEntropy on a near-one-hot distribution ≈ 0
// =============================================================================

test('W709 #2 — tokenEntropy near-one-hot distribution is approximately zero', () => {
  // Mass piled on top-1; tiny floor for the other candidates so we don't
  // feed log(0). Real-world adapters never emit a hard 1.0 either.
  const probs = [0.999997, 0.000001, 0.000001, 0.000001];
  const row = rowFromProbs(probs);
  const summary = tokenEntropy([row]);
  assert.equal(summary.reason, 'ok');
  assert.ok(summary.per_token[0] < 0.001,
    `expected entropy << 1 got ${summary.per_token[0]}`);
  assert.ok(summary.max < 0.001);
});

// =============================================================================
// 3) decideRouting with hasLogprobs=false → student + no_entropy_signal_available
// =============================================================================

test('W709 #3 — decideRouting honest-degrades when adapter has no logprobs', () => {
  const d = decideRouting({ tokens: null, hasLogprobs: false });
  assert.equal(d.route, 'student');
  assert.equal(d.confidence, null);
  assert.equal(d.reason, 'no_entropy_signal_available');
  assert.equal(d.entropy_per_token, null);
  assert.deepEqual(d.segments, []);
  // CRITICAL — must NOT silently escalate.
  assert.equal(shouldEscalateToTeacher(d), false,
    'honest degradation must not trip escalation');
});

// =============================================================================
// 4) decideRouting all low-entropy tokens → student route
// =============================================================================

test('W709 #4 — decideRouting all-confident stream stays on student', () => {
  // Three near-one-hot rows. Max entropy ~0; below default threshold.
  const probs = [0.97, 0.01, 0.01, 0.01];
  const tokens = [rowFromProbs(probs), rowFromProbs(probs), rowFromProbs(probs)];
  const d = decideRouting({ tokens, hasLogprobs: true });
  assert.equal(d.route, 'student');
  assert.equal(d.reason, 'all_tokens_below_threshold');
  assert.equal(d.entropy_per_token.length, 3);
  assert.equal(d.segments.length, 1);
  assert.deepEqual(d.segments[0], { start: 0, end: 2, source: 'student' });
  // Confidence in [0, 1] and high (close to 1) because max entropy << log(K).
  assert.ok(d.confidence > 0.85,
    `expected high confidence, got ${d.confidence}`);
});

// =============================================================================
// 5) decideRouting with one high-entropy token in the middle → mixed segment
// =============================================================================

test('W709 #5 — decideRouting single high-entropy token produces mixed mid-span segment', () => {
  const confident = rowFromProbs([0.97, 0.01, 0.01, 0.01]);
  const uniform = rowFromProbs([0.25, 0.25, 0.25, 0.25]);  // entropy = log(4) > log(2)
  const tokens = [confident, confident, uniform, confident, confident];
  const d = decideRouting({ tokens, hasLogprobs: true });
  assert.equal(d.route, 'mixed');
  assert.equal(d.reason, 'high_entropy_span_detected');
  assert.equal(d.entropy_per_token.length, 5);
  // Three segments: student[0..1], teacher[2..2], student[3..4].
  assert.equal(d.segments.length, 3);
  assert.deepEqual(d.segments[0], { start: 0, end: 1, source: 'student' });
  assert.deepEqual(d.segments[1], { start: 2, end: 2, source: 'teacher' });
  assert.deepEqual(d.segments[2], { start: 3, end: 4, source: 'student' });
  assert.equal(shouldEscalateToTeacher(d), true);
});

// =============================================================================
// 6) decideRouting all tokens above threshold → teacher route
// =============================================================================

test('W709 #6 — decideRouting all-uncertain stream routes fully to teacher', () => {
  const uniform = rowFromProbs([0.25, 0.25, 0.25, 0.25]);
  const tokens = [uniform, uniform, uniform];
  const d = decideRouting({ tokens, hasLogprobs: true });
  assert.equal(d.route, 'teacher');
  assert.equal(d.reason, 'all_tokens_above_threshold');
  assert.equal(shouldEscalateToTeacher(d), true);
});

// =============================================================================
// 7) shouldEscalateToTeacher truth-table coverage
// =============================================================================

test('W709 #7 — shouldEscalateToTeacher truth-table is honest', () => {
  // student → false
  assert.equal(shouldEscalateToTeacher({ route: 'student' }), false);
  // mixed → true
  assert.equal(shouldEscalateToTeacher({ route: 'mixed' }), true);
  // teacher → true
  assert.equal(shouldEscalateToTeacher({ route: 'teacher' }), true);
  // Bogus inputs should not crash and must NOT escalate by accident.
  assert.equal(shouldEscalateToTeacher(null), false);
  assert.equal(shouldEscalateToTeacher(undefined), false);
  assert.equal(shouldEscalateToTeacher({}), false);
  assert.equal(shouldEscalateToTeacher({ route: 'unknown' }), false);
  // Honest-degraded decision must not escalate.
  const degraded = decideRouting({ tokens: null, hasLogprobs: false });
  assert.equal(shouldEscalateToTeacher(degraded), false);
});

// =============================================================================
// 8) custom threshold tunability — raising threshold flips mixed → student
// =============================================================================

test('W709 #8 — raising threshold suppresses escalation', () => {
  const confident = rowFromProbs([0.97, 0.01, 0.01, 0.01]);
  const uniform = rowFromProbs([0.25, 0.25, 0.25, 0.25]);
  const tokens = [confident, uniform, confident];
  // Default threshold = log(2): uniform's entropy log(4) > log(2) → mixed.
  const defaultD = decideRouting({ tokens, hasLogprobs: true });
  assert.equal(defaultD.route, 'mixed');
  // Threshold = log(5) (~1.609) suppresses every realistic 4-way row.
  const highThr = decideRouting({ tokens, threshold: Math.log(5), hasLogprobs: true });
  assert.equal(highThr.route, 'student');
  assert.equal(highThr.reason, 'all_tokens_below_threshold');
  // Sanity-check the default is what we documented.
  assert.ok(Math.abs(DEFAULT_ENTROPY_THRESHOLD_NATS - Math.log(2)) < 1e-12);
});
