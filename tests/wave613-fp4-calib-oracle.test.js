// Wave 613: FP4 calibration plan wiring from oracle -> CLI/export surface.
//
// W921 built the pure FP4 calibration planner and the worker flag passthrough.
// This pins the missing recommendation bridge so Blackwell NVFP4 plans carry
// the BATQuant-style calibration flags all the way into the suggested command.

import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankQuantizationStrategies } from '../src/quantization-oracle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

test('1. Blackwell NVFP4 oracle recommendation attaches the FP4 calibration plan', () => {
  const plan = rankQuantizationStrategies({
    task: 'chat',
    device: 'b200-180gb',
    params_b: 70,
    context_tokens: 8192,
    calibration_rows: 512,
  });

  const fp4 = plan.recommendation.fp4_calibration_plan;
  assert.equal(plan.recommendation.primary.method, 'nvfp4');
  assert.equal(fp4.enabled, true);
  assert.equal(fp4.algorithm, 'batquant-block-affine+block-clip');
  assert.deepEqual([...fp4.python_flags], [
    '--calib-fp4',
    '--calib-fp4-block=32',
    '--calib-fp4-max-layers=64',
  ]);
  for (const flag of fp4.python_flags) {
    assert.match(plan.recommendation.command, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok(plan.recommendation.proof.some((line) => line.includes('--calib-fp4')));
});

test('2. non-FP4 worker recommendations do not get FP4 calibration flags', () => {
  const plan = rankQuantizationStrategies({
    task: 'extraction',
    device: 'rtx-4090-24gb',
    params_b: 7,
    context_tokens: 8192,
    calibration_rows: 256,
  });

  assert.equal(plan.recommendation.primary.method, 'awq');
  assert.equal(plan.recommendation.fp4_calibration_plan, null);
  assert.doesNotMatch(plan.recommendation.command, /--calib-fp4/);
});

test('3. CLI preview parses oracle-style --calib-fp4 tuning flags for NVFP4 export', () => {
  const stdout = execFileSync(process.execPath, [
    CLI,
    'export',
    'preview-artifact.kolm',
    '--format',
    'nvfp4',
    '--quant',
    'w4a8',
    '--preview',
    '--calib-fp4',
    '--calib-fp4-block=16',
    '--calib-fp4-max-layers=0',
  ], { cwd: ROOT, encoding: 'utf8' });

  const preview = JSON.parse(stdout);
  assert.equal(preview.fp4_calibration_plan.enabled, true);
  assert.equal(preview.fp4_calibration_plan.block, 16);
  assert.equal(preview.fp4_calibration_plan.max_layers, 0);
  assert.deepEqual([...preview.fp4_calibration_plan.python_flags], [
    '--calib-fp4',
    '--calib-fp4-block=16',
    '--calib-fp4-max-layers=0',
  ]);
});

test('4. NVFP4 export path records calibration result when the option is enabled', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'export-nvfp4.js'), 'utf8');

  assert.match(src, /buildFp4CalibPlan/);
  assert.match(src, /run_fp4_calibration/);
  assert.match(src, /fp4_calibration_plan/);
  assert.match(src, /fp4_calibration/);
});

test('5. backend spec records W613 closure and keeps transform fusion as follow-up', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /CLOSED W613/);
  assert.match(spec, /FP4 calibration plan into the oracle recommendation/);
  assert.match(spec, /Fuse the BATQuant calibration plan into the NVFP4 export/);
});
