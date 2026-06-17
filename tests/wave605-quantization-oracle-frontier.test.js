// Wave 605: Blackwell FP4 quantization oracle frontier routing.
//
// NVFP4/MXFP4 export already exists in src/export-nvfp4.js. These tests pin
// the decision layer so the oracle reaches that path on Blackwell TensorRT/vLLM
// targets, while keeping Hopper/Ada on executable legacy worker methods.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantizationOracleCatalog, rankQuantizationStrategies } from '../src/quantization-oracle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('1. catalog exposes Blackwell FP4 export methods and device presets', () => {
  const catalog = quantizationOracleCatalog();

  assert.equal(catalog.methods.nvfp4.execution_status, 'export_nvfp4');
  assert.equal(catalog.methods.nvfp4.export_format, 'nvfp4');
  assert.equal(catalog.methods.nvfp4.export_quant, 'w4a8');
  assert.equal(catalog.methods.nvfp4.blackwell_required, true);

  assert.equal(catalog.methods.mxfp4.execution_status, 'export_nvfp4');
  assert.equal(catalog.methods.mxfp4.export_quant, 'w4a4');
  assert.equal(catalog.methods.mxfp4.blackwell_required, true);

  assert.equal(catalog.methods.moe_mixed_policy.execution_status, 'advisory_policy');
  assert.equal(catalog.methods.moe_mixed_policy.moe_only, true);
  assert.equal(catalog.methods.mc_moe.execution_status, 'worker_external_repo');
  assert.equal(catalog.methods.mc_moe.moe_only, true);
  assert.equal(catalog.methods.gemq.execution_status, 'worker_external_repo');
  assert.equal(catalog.methods.gemq.moe_only, true);

  assert.equal(catalog.devices['b200-180gb'].blackwell, true);
  assert.equal(catalog.devices['gb200-180gb'].blackwell, true);
  assert.equal(catalog.devices['rtx-5090-32gb'].blackwell, true);
});

test('2. Blackwell TensorRT workload chooses NVFP4 export command', () => {
  const plan = rankQuantizationStrategies({
    task: 'chat',
    device: 'b200-180gb',
    params_b: 70,
    context_tokens: 8192,
    calibration_rows: 512,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.input.device.blackwell, true);
  assert.equal(plan.recommendation.primary.method, 'nvfp4');
  assert.equal(plan.recommendation.primary.hardware_native, true);
  assert.equal(plan.recommendation.primary.execution_status, 'export_nvfp4');
  assert.equal(plan.recommendation.primary.export_format, 'nvfp4');
  assert.equal(plan.recommendation.primary.export_quant, 'w4a8');
  assert.equal(plan.recommendation.fp4_calibration_plan.enabled, true);
  assert.match(plan.recommendation.command, /^kolm export <artifact\.kolm> --format nvfp4 --quant w4a8 --calib-fp4 --calib-fp4-block=32 --calib-fp4-max-layers=64 --out <out-dir>$/);
});

test('3. Hopper TensorRT and Ada CUDA targets do not get Blackwell-only FP4 recommendations', () => {
  const hopper = rankQuantizationStrategies({
    task: 'chat',
    device: 'h100-80gb',
    params_b: 70,
    context_tokens: 8192,
    calibration_rows: 512,
  });
  const hopperNvfp4 = hopper.candidates.find((c) => c.method === 'nvfp4');
  assert.equal(hopper.recommendation.primary.method, 'awq');
  assert.equal(hopperNvfp4.feasible, false);
  assert.ok(hopperNvfp4.warnings.includes('blackwell_required'));
  assert.doesNotMatch(hopper.recommendation.command, /--format nvfp4/);

  const ada = rankQuantizationStrategies({
    task: 'extraction',
    device: 'rtx-4090-24gb',
    params_b: 7,
    context_tokens: 8192,
    calibration_rows: 256,
  });
  const adaNvfp4 = ada.candidates.find((c) => c.method === 'nvfp4');
  assert.equal(ada.recommendation.primary.method, 'awq');
  assert.equal(adaNvfp4.feasible, false);
  assert.ok(adaNvfp4.warnings.includes('blackwell_required'));
  assert.ok(adaNvfp4.warnings.includes('runtime_mismatch:cuda'));
});

test('4. backend spec records W605 and W613 closures while leaving FP4 export-fusion work open', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /W605/);
  assert.match(spec, /NVFP4\/MXFP4 oracle routing/);
  assert.match(spec, /W613/);
  assert.match(spec, /Fuse the BATQuant calibration plan into the NVFP4 export/);
});

test('5. MoE input routes to router-fp16 advisory policy and names external expert methods', () => {
  const plan = rankQuantizationStrategies({
    task: 'chat',
    runtime: 'vllm',
    memory_gb: 24,
    params_b: 47,
    context_tokens: 8192,
    calibration_rows: 256,
    moe_info: {
      is_moe: true,
      family: 'mixtral-8x7b',
      num_experts: 8,
      experts_per_token: 2,
      params: 47,
    },
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.input.moe.is_moe, true);
  assert.equal(plan.input.moe.family, 'mixtral-8x7b');
  assert.equal(plan.recommendation.primary.method, 'moe_mixed_policy');
  assert.equal(plan.recommendation.primary.execution_status, 'advisory_policy');
  assert.equal(plan.recommendation.command, null);
  assert.equal(plan.recommendation.moe_quantization.policy.router, 'fp16');
  assert.ok(plan.recommendation.moe_quantization.policy.experts);
  assert.ok(plan.recommendation.proof.some((line) => /router fp16/.test(line)));

  const external = plan.recommendation.moe_quantization.external_candidates.map((c) => c.method).sort();
  assert.deepEqual(external, ['gemq', 'mc_moe']);
  const mc = plan.candidates.find((c) => c.method === 'mc_moe');
  assert.ok(mc.warnings.includes('requires_external_research_repo'));
  assert.ok(mc.warnings.some((w) => w.includes('KOLM_ENABLE_EXPERIMENTAL_QUANTS')));
});
