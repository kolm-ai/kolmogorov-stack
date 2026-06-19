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
import { methodAvailability, quantizationOracleCatalog, rankQuantizationStrategies } from '../src/quantization-oracle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('1. catalog exposes Blackwell FP4 export methods and device presets', () => {
  const catalog = quantizationOracleCatalog();

  assert.equal(catalog.methods.nvfp4.execution_status, 'export_nvfp4');
  assert.equal(catalog.methods.nvfp4.export_format, 'nvfp4');
  assert.equal(catalog.methods.nvfp4.export_quant, 'w4a8');
  assert.equal(catalog.methods.nvfp4.blackwell_required, true);
  assert.deepEqual(catalog.methods.nvfp4.quality_loss_model_size_curve.map((row) => row.max_params_b), [14, 34, null]);

  assert.equal(catalog.methods.mxfp4.execution_status, 'export_nvfp4');
  assert.equal(catalog.methods.mxfp4.export_quant, 'w4a4');
  assert.equal(catalog.methods.mxfp4.blackwell_required, true);
  assert.deepEqual(catalog.methods.mxfp4.quality_loss_model_size_curve.map((row) => row.max_params_b), [14, 34, null]);

  assert.equal(catalog.methods.moe_mixed_policy.execution_status, 'advisory_policy');
  assert.equal(catalog.methods.moe_mixed_policy.moe_only, true);
  assert.equal(catalog.methods.mc_moe.execution_status, 'worker_external_repo');
  assert.equal(catalog.methods.mc_moe.moe_only, true);
  assert.equal(catalog.methods.gemq.execution_status, 'worker_external_repo');
  assert.equal(catalog.methods.gemq.moe_only, true);

  for (const method of ['spinquant', 'respinquant', 'infoquant', 'mc_moe', 'gemq']) {
    assert.equal(catalog.methods[method].execution_status, 'worker_external_repo');
    assert.equal(catalog.methods[method].worker_method, method);
    assert.equal(catalog.methods[method].experimental, true);
    if (['spinquant', 'respinquant', 'infoquant'].includes(method)) {
      assert.equal(catalog.methods[method].activation_quantization, true);
      assert.equal(catalog.methods[method].kv_quantization, true);
    }
  }

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

test('4. FP4 quality estimate is model-size aware before accuracy-gate promotion', () => {
  const small = rankQuantizationStrategies({
    task: 'medical',
    device: 'b200-180gb',
    params_b: 7,
    context_tokens: 8192,
    calibration_rows: 512,
    quality_floor: 0.97,
  });
  const smallNvfp4 = small.candidates.find((c) => c.method === 'nvfp4');
  assert.equal(small.recommendation.primary.method, 'awq');
  assert.equal(smallNvfp4.estimates.quality_loss_source, 'model_size_quality_curve');
  assert.equal(smallNvfp4.estimates.quality_loss_prior, 0.04);
  assert.deepEqual(smallNvfp4.estimates.quality_loss_band, {
    max_params_b: 14,
    recovery_hint: '95-98% BF16 recovery band',
  });
  assert.equal(smallNvfp4.feasible, false);
  assert.ok(smallNvfp4.warnings.some((w) => w.startsWith('quality_below_floor')));

  const large = rankQuantizationStrategies({
    task: 'medical',
    device: 'b200-180gb',
    params_b: 70,
    context_tokens: 8192,
    calibration_rows: 512,
    quality_floor: 0.97,
  });
  const largeNvfp4 = large.candidates.find((c) => c.method === 'nvfp4');
  assert.equal(large.recommendation.primary.method, 'nvfp4');
  assert.equal(largeNvfp4.estimates.quality_loss_prior, 0.01);
  assert.deepEqual(largeNvfp4.estimates.quality_loss_band, {
    max_params_b: null,
    recovery_hint: '~99% BF16 recovery band',
  });
  assert.ok(largeNvfp4.estimates.quality > smallNvfp4.estimates.quality);
});

test('5. backend spec records W605/W613/W964/W965 and W1010/W1011 closures', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /W605/);
  assert.match(spec, /NVFP4\/MXFP4 oracle routing/);
  assert.match(spec, /W613/);
  assert.match(spec, /W964/);
  assert.match(spec, /quality_loss size-aware/);
  assert.match(spec, /W965/);
  assert.match(spec, /external-command adapters/);
  assert.match(spec, /pre-round FP4 fusion/);
  assert.match(spec, /W1010/);
  assert.match(spec, /W1011/);
});

test('6. W4A4 rotation frontier methods are command-backed experimental worker lanes', () => {
  const plan = rankQuantizationStrategies({
    task: 'medical',
    runtime: 'cuda',
    memory_gb: 6.5,
    params_b: 8,
    context_tokens: 8192,
    calibration_rows: 512,
    quality_floor: 0.976,
    experimental_enabled: true,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.primary.method, 'respinquant');
  assert.match(plan.recommendation.command, /--method=respinquant/);
  for (const method of ['spinquant', 'respinquant', 'infoquant']) {
    const candidate = plan.candidates.find((c) => c.method === method);
    assert.equal(candidate.execution_status, 'worker_external_repo');
    assert.equal(candidate.worker_method, method);
    assert.ok(candidate.warnings.includes('requires_external_research_repo'));
    assert.equal(candidate.warnings.includes('external_runner_not_wired'), false);
  }

  const availability = methodAvailability('respinquant', { KOLM_ENABLE_EXPERIMENTAL_QUANTS: '1' });
  assert.equal(availability.available, true);
  assert.equal(availability.reason, 'experimental_enabled');

  const worker = fs.readFileSync(path.join(ROOT, 'workers', 'quantize', 'scripts', 'quantize.py'), 'utf8');
  assert.match(worker, /"spinquant", "respinquant", "infoquant", "mc_moe", "gemq"/);
  assert.match(worker, /KOLM_SPINQUANT_CMD/);
  assert.match(worker, /KOLM_MC_MOE_CMD/);
  assert.match(worker, /KOLM_GEMQ_CMD/);
  assert.match(worker, /run_rotation_external/);
});

test('7. MoE input routes to router-fp16 advisory policy and names external expert methods', () => {
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
  assert.equal(plan.recommendation.moe_quantization.runtime_plan.placement, 'hot_expert_pin_with_cpu_offload');
  assert.equal(plan.recommendation.moe_quantization.runtime_plan.dynamic_precision.algorithm, 'dynaexq_budgeted_precision');
  assert.ok(plan.recommendation.proof.some((line) => /router fp16/.test(line)));

  const external = plan.recommendation.moe_quantization.external_candidates.map((c) => c.method).sort();
  assert.deepEqual(external, ['gemq', 'mc_moe']);
  const mc = plan.candidates.find((c) => c.method === 'mc_moe');
  assert.ok(mc.warnings.includes('requires_external_research_repo'));
  assert.equal(mc.warnings.includes('external_runner_not_wired'), false);
  assert.ok(mc.warnings.some((w) => w.includes('KOLM_ENABLE_EXPERIMENTAL_QUANTS')));
});
