// Wave 606: post-quantization accuracy floor.
//
// The DAQ bakeoff can still compute surrogate ranking scores when no model is
// runnable locally, but promotion must be gated on measured K-score deltas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_QUANT_ACCURACY_MAX_REL_DROP,
  enforceAccuracyFloor,
} from '../src/quantize-bakeoff.js';
import { rankQuantizationStrategies } from '../src/quantization-oracle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('1. measured bakeoff rows below the relative K-score floor are rejected', () => {
  const rows = [
    { profile_id: 'fp16', method: 'fp16', kscore: 0.9, avg_weight_bits: 16, scorer: 'kscore-v2-harness', accepted: true },
    { profile_id: 'near-lossless', kscore: 0.878, avg_weight_bits: 4, scorer: 'kscore-v2-harness', accepted: true },
    { profile_id: 'bad-drop', kscore: 0.82, avg_weight_bits: 4, scorer: 'kscore-v2-harness', accepted: true },
  ];

  enforceAccuracyFloor(rows, { maxRelDrop: 0.03 });

  assert.equal(rows[0].accepted, true);
  assert.equal(rows[1].accepted, true);
  assert.equal(rows[1].accuracy_gate.passed, true);
  assert.equal(rows[2].accepted, false);
  assert.equal(rows[2].accuracy_gate.status, 'fail');
  assert.ok(rows[2].accuracy_gate.relative_drop > 0.03);
  assert.ok(rows[2].rejection_reasons.includes('accuracy_below_floor'));
});

test('2. surrogate-only bakeoff rows fail closed unless explicitly advisory-only', () => {
  const rows = [
    { profile_id: 'surrogate-8bit', kscore: 0.91, avg_weight_bits: 8, scorer: 'jaccard-surrogate', accepted: true },
    { profile_id: 'surrogate-4bit', kscore: 0.89, avg_weight_bits: 4, scorer: 'jaccard-surrogate', accepted: true },
  ];

  enforceAccuracyFloor(rows);

  assert.equal(rows[0].accepted, false);
  assert.equal(rows[0].accuracy_gate.measured, false);
  assert.equal(rows[0].accuracy_gate.passed, false);
  assert.ok(rows[0].rejection_reasons.includes('accuracy_gate_unmeasured'));
  assert.equal(rows[1].accepted, false);
  assert.ok(rows[1].rejection_reasons.includes('accuracy_gate_unmeasured'));

  const advisoryRows = rows.map((row) => ({ ...row, accepted: true, rejection_reasons: [] }));
  enforceAccuracyFloor(advisoryRows, { requireMeasured: false });
  assert.equal(advisoryRows[0].accuracy_gate.measured, false);
  assert.equal(advisoryRows[0].accuracy_gate.passed, true);
});

test('3. embedded K-score gate failures reject even when relative score drop is small', () => {
  const rows = [
    { profile_id: 'fp16', method: 'fp16', kscore: 0.9, avg_weight_bits: 16, scorer: 'kscore-v2-harness', accepted: true },
    {
      profile_id: 'kl-fail',
      kscore: 0.89,
      avg_weight_bits: 4,
      scorer: 'kscore-v2-harness',
      kscore_gate: { ships: false, reasons: ['teacher_quant_kl_exceeds_max:0.9>0.1'] },
      accepted: true,
    },
  ];

  enforceAccuracyFloor(rows, { maxRelDrop: 0.03 });

  assert.equal(rows[1].accepted, false);
  assert.equal(rows[1].accuracy_gate.relative_drop < 0.03, true);
  assert.ok(rows[1].rejection_reasons.includes('kscore_gate_failed'));
});

test('4. quantization oracle exposes structured post-quant accuracy gate', () => {
  const plan = rankQuantizationStrategies({
    task: 'extraction',
    device: 'rtx-4090-24gb',
    params_b: 7,
    context_tokens: 8192,
    calibration_rows: 256,
  });

  assert.equal(plan.recommendation.accuracy_gate.required, true);
  assert.equal(plan.recommendation.accuracy_gate.metric, 'kscore');
  assert.equal(plan.recommendation.accuracy_gate.max_rel_drop, DEFAULT_QUANT_ACCURACY_MAX_REL_DROP);
  assert.equal(plan.recommendation.accuracy_gate.fail_closed_without_measured_holdout, true);
  assert.ok(plan.recommendation.proof.some((line) => /accuracy_gate/.test(line)));
});

test('5. backend spec records W606 closure while leaving measurement-harness follow-up open', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /W606/);
  assert.match(spec, /post-quant accuracy gate/);
  assert.match(spec, /shared boot-and-measure probe harness/);
});
