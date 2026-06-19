// Wave 582: Kolm-Q quantization oracle lock-ins.
//
// The quantize surface already exposes many methods. This pins the missing
// backend decision layer: given task, device, memory, runtime, calibration, and
// privacy constraints, Kolm must rank quantization strategies deterministically
// and return an executable worker command only when a method is actually wired.

import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodAvailability, quantizationOracleCatalog, rankQuantizationStrategies } from '../src/quantization-oracle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

test('1. oracle catalog covers worker methods plus external/runtime-only methods', () => {
  const catalog = quantizationOracleCatalog();
  for (const method of ['fp16', 'int8', 'smoothquant', 'int4', 'gptq', 'awq', 'nvfp4', 'mxfp4', 'hqq', 'exl2', 'aqlm', 'quip', 'qat', 'spinquant', 'respinquant', 'infoquant', 'moe_mixed_policy', 'mc_moe', 'gemq', 'kivi_kv']) {
    assert.ok(catalog.methods[method], `catalog missing ${method}`);
  }
  assert.equal(catalog.methods.awq.worker_method, 'awq');
  assert.equal(catalog.methods.nvfp4.execution_status, 'export_nvfp4');
  assert.equal(catalog.methods.smoothquant.execution_status, 'external_toolchain');
  assert.equal(catalog.methods.moe_mixed_policy.execution_status, 'advisory_policy');
  assert.equal(catalog.methods.kivi_kv.execution_status, 'runtime_policy');
});

test('2. calibrated RTX extraction workload chooses an executable 4-bit worker method', () => {
  const plan = rankQuantizationStrategies({
    task: 'extraction',
    device: 'rtx-4090-24gb',
    params_b: 7,
    context_tokens: 8192,
    calibration_rows: 256,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.primary.method, 'awq');
  assert.equal(plan.recommendation.primary.worker_method, 'awq');
  assert.equal(plan.recommendation.primary.feasible, true);
  assert.match(plan.recommendation.command, /kolm quantize --local-worker --method=awq/);
  assert.ok(plan.recommendation.primary.estimates.memory_gb < plan.input.device.memory_gb);
});

test('3. tiny browser target refuses fake feasible worker claims when memory/runtime do not fit', () => {
  const plan = rankQuantizationStrategies({
    task: 'medical',
    device: 'browser-4gb',
    params_b: 13,
    context_tokens: 32768,
    calibration_rows: 0,
    quality_floor: 0.98,
    privacy_mode: 'airgap',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.primary.feasible, false);
  assert.equal(plan.recommendation.command, null);
  assert.ok(plan.candidates.some((row) => row.warnings.some((w) => w.startsWith('memory_exceeds_device'))));
  assert.ok(plan.candidates.some((row) => row.warnings.some((w) => w.startsWith('runtime_mismatch'))));
});

test('4. long-context serving plan can recommend KV-cache compression separately from weight quant', () => {
  const plan = rankQuantizationStrategies({
    task: 'summarization',
    runtime: 'vllm',
    memory_gb: 80,
    target_latency_ms: 40,
    params_b: 34,
    context_tokens: 65536,
    calibration_rows: 256,
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.recommendation.kv_cache, 'long-context vLLM plan should include KV-cache recommendation');
  assert.equal(plan.recommendation.kv_cache.method, 'kivi_kv');
});

test('5. CLI smoke and package gates expose verify:quant-oracle', () => {
  const stdout = execFileSync(process.execPath, [
    'scripts/quantization-oracle.mjs',
    '--task', 'extraction',
    '--device', 'rtx-4090-24gb',
    '--params-b', '7',
    '--context', '8192',
    '--calibration-rows', '256',
  ], { cwd: ROOT, encoding: 'utf8' });
  const plan = JSON.parse(stdout);
  assert.equal(plan.recommendation.primary.method, 'awq');

  const pkg = readJson('package.json');
  assert.ok(pkg.scripts['verify:quant-oracle'].includes('quantization-oracle.mjs'));
  assert.ok(pkg.scripts['verify:depth'].includes('verify:quant-oracle'));
});

test('5b. CLI exposes direct quantization oracle planning before worker install', () => {
  const stdout = execFileSync(process.execPath, [
    CLI,
    'quantize',
    'oracle',
    '--task',
    'extraction',
    '--device',
    'rtx-4090-24gb',
    '--params-b',
    '7',
    '--context',
    '8192',
    '--calibration-rows',
    '256',
    '--json',
  ], { cwd: ROOT, encoding: 'utf8' });
  const plan = JSON.parse(stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.primary.method, 'awq');
  assert.match(plan.recommendation.command, /kolm quantize --local-worker --method=awq/);

  const catalog = JSON.parse(execFileSync(process.execPath, [CLI, 'quantize', 'oracle', '--catalog', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  assert.ok(catalog.methods.awq);
  assert.equal(catalog.methods.kivi_kv.execution_status, 'runtime_policy');
});

test('5c. CLI quantization oracle accepts MoE topology flags', () => {
  const stdout = execFileSync(process.execPath, [
    CLI,
    'quantize',
    'oracle',
    '--runtime',
    'vllm',
    '--memory-gb',
    '24',
    '--params-b',
    '47',
    '--moe-family',
    'mixtral-8x7b',
    '--moe',
    '--json',
  ], { cwd: ROOT, encoding: 'utf8' });
  const plan = JSON.parse(stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.input.moe.family, 'mixtral-8x7b');
  assert.equal(plan.recommendation.primary.method, 'moe_mixed_policy');
  assert.equal(plan.recommendation.command, null);
  assert.equal(plan.recommendation.moe_quantization.policy.router, 'fp16');
  assert.equal(plan.recommendation.moe_quantization.runtime_plan.runtime, 'vllm');
  assert.equal(plan.recommendation.moe_quantization.runtime_plan.dynamic_precision.algorithm, 'dynaexq_budgeted_precision');
});

test('5d. external quant methods stay gated, then become worker-addressable when enabled', () => {
  const gated = methodAvailability('mc_moe', {});
  assert.equal(gated.available, false);
  assert.equal(gated.reason, 'experimental_gated');

  const enabled = methodAvailability('mc_moe', { KOLM_ENABLE_EXPERIMENTAL_QUANTS: '1' });
  assert.equal(enabled.known, true);
  assert.equal(enabled.available, true);
  assert.equal(enabled.reason, 'experimental_enabled');

  const rotation = methodAvailability('infoquant', { KOLM_ENABLE_EXPERIMENTAL_QUANTS: '1' });
  assert.equal(rotation.known, true);
  assert.equal(rotation.available, true);
  assert.equal(rotation.reason, 'experimental_enabled');
});

async function makeRouterApp() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key };
}

function withListening(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

test('6. router exposes quantization oracle catalog and planner as authenticated envelopes', async () => {
  const { app, apiKey } = await makeRouterApp();
  await withListening(app, async (base) => {
    const headers = { authorization: 'Bearer ' + apiKey };
    const catalogRes = await fetch(base + '/v1/quantization/oracle/catalog', { headers });
    assert.equal(catalogRes.status, 200, `catalog status ${catalogRes.status}`);
    const catalog = await catalogRes.json();
    assert.equal(catalog.ok, true);
    assert.equal(catalog.surface, 'compile-artifact-verification');
    assert.equal(catalog.data.catalog.methods.awq.worker_method, 'awq');

    const planRes = await fetch(base + '/v1/quantization/oracle', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'extraction',
        device: 'rtx-4090-24gb',
        params_b: 7,
        context_tokens: 8192,
        calibration_rows: 256,
      }),
    });
    assert.equal(planRes.status, 200, `plan status ${planRes.status}`);
    const plan = await planRes.json();
    assert.equal(plan.ok, true);
    assert.equal(plan.readiness.status, 'implemented');
    assert.equal(plan.data.plan.recommendation.primary.method, 'awq');
    assert.match(plan.next_actions[0].value, /kolm quantize --local-worker --method=awq/);
  });
});
