// W-6 (Path to 100%) — distill display contract: a projected loss curve is
// never shown as a measured training result.
//
// The distill generator emits per-step {loss, k_score} that are PROJECTED
// (interpolated toward the target), and listDistillRuns previously reported the
// LAST synthetic step's loss as `loss_final` — i.e. fabricated telemetry shown
// as a real result. Now per-step events carry loss_source:'synthetic' /
// k_source:'projected', and resolveDistillFinalLoss() surfaces the trainer's
// real measured loss from the manifest, or null — never the synthetic step.

import { test } from 'node:test';
import assert from 'node:assert';
import { resolveDistillFinalLoss } from '../src/distill-pipeline.js';

test('W-6: a real measured loss from the trainer manifest is surfaced as measured', () => {
  assert.deepStrictEqual(
    resolveDistillFinalLoss({ loss_final: 0.42 }, { loss: 0.9 }),
    { loss: 0.42, source: 'measured' },
  );
  assert.deepStrictEqual(
    resolveDistillFinalLoss({ metrics: { loss: 0.31 } }, null),
    { loss: 0.31, source: 'measured' },
  );
});

test('W-6: with NO measured loss, the synthetic step is suppressed (never promoted to final)', () => {
  const out = resolveDistillFinalLoss({}, { loss: 0.9, loss_source: 'synthetic' });
  assert.strictEqual(out.loss, null, 'a synthetic step is never reported as the final loss');
  assert.strictEqual(out.source, 'synthetic_suppressed');
});

test('W-6: nothing measured and no steps → unavailable, not a fabricated number', () => {
  assert.deepStrictEqual(resolveDistillFinalLoss(null, null), { loss: null, source: 'unavailable' });
  assert.deepStrictEqual(resolveDistillFinalLoss({}, undefined), { loss: null, source: 'unavailable' });
});

test('W-6: a measured loss of exactly 0 is preserved (not treated as missing)', () => {
  assert.deepStrictEqual(
    resolveDistillFinalLoss({ loss_final: 0 }, { loss: 0.5 }),
    { loss: 0, source: 'measured' },
  );
});
