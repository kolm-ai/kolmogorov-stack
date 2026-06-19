// Wave 1009: measured quantization bakeoffs emit shared paired probe receipts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROFILE, hashDaqProfile } from '../src/daq-profile.js';
import {
  buildQuantizationProbeReceipt,
  runMixedPrecisionBakeoff,
} from '../src/quantize-bakeoff.js';

function profile() {
  return [{
    ...DEFAULT_PROFILE,
    layer_id: 'layers.0.mlp.down_proj',
    weight_bits: 4,
    activation_bits: 8,
    kv_bits: 8,
    kl_sensitivity: 0.02,
  }];
}

function measuredPair() {
  return {
    source: 'test-worker-holdout',
    workload_id: 'holdout-q1009',
    runtime: 'quantize-worker',
    model: 'qwen-test',
    fp16: {
      model: 'qwen-test',
      perplexity: 8.0,
      accuracy: 0.94,
      holdout_accuracy: 0.92,
      size_bytes: 14e9,
      p50_latency_us: 40000,
    },
    quant: {
      model: 'qwen-test',
      perplexity: 8.02,
      kl_mean: 0.005,
      size_bytes: 3.8e9,
      p50_latency_us: 20000,
    },
  };
}

function fakeQuantWorker(_py, args) {
  const outArg = args.find((arg) => String(arg).startsWith('--out='));
  const outDir = outArg.slice('--out='.length);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'model.safetensors'), 'quantized');
  fs.writeFileSync(path.join(outDir, 'quantize-receipt.json'), JSON.stringify({
    ok: true,
    output_files_sha256: {
      'model.safetensors': '0'.repeat(64),
    },
  }));
  return { status: 0, stdout: '', stderr: '' };
}

test('W1009 helper emits hash-only paired quantization probe receipts', () => {
  const receipt = buildQuantizationProbeReceipt({
    profile_id: 'profile-a',
    model_path: 'local-model',
    profile: profile(),
    measured: measuredPair(),
    gate: {
      scorer: 'kscore-v2-harness',
      verdict: 'pass',
      ships: true,
      fp16_kscore: 0.82,
      quant_kscore: 0.84,
      k_score_delta: 0.02,
      k_score_drop: -0.02,
      quant_kl_mean: 0.005,
      max_kl: 0.1,
      max_delta_drop: 0.02,
    },
    eval_set: [{
      prompt_text: 'TENANT_SECRET_PROMPT',
      response_text: 'TENANT_SECRET_RESPONSE',
      output: 'reference answer',
    }],
  });

  assert.equal(receipt.domain, 'quantization');
  assert.equal(receipt.claim_scope, 'paired_measurement_receipt_digest_only');
  assert.equal(receipt.sample_count, 1);
  assert.match(receipt.baseline_digest, /^[a-f0-9]{64}$/);
  assert.match(receipt.candidate_digest, /^[a-f0-9]{64}$/);
  assert.match(receipt.metrics_digest, /^[a-f0-9]{64}$/);
  const flat = JSON.stringify(receipt);
  assert.equal(flat.includes('TENANT_SECRET_PROMPT'), false);
  assert.equal(flat.includes('TENANT_SECRET_RESPONSE'), false);
  assert.equal(flat.includes('reference answer'), false);
});

test('W1009 measured bakeoff rows attach a quantization probe receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1009-'));
  const modelDir = path.join(root, 'model');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');

  const prof = profile();
  const profileId = hashDaqProfile(prof).slice(0, 12);
  const run = await runMixedPrecisionBakeoff(
    modelDir,
    [prof],
    [{ prompt_text: 'SECRET_EVAL_PROMPT', output: 'reference answer' }],
    {
      measured: { [profileId]: measuredPair() },
      spawnSync: fakeQuantWorker,
    },
  );

  assert.equal(run.ok, true);
  assert.equal(run.results.length, 1);
  const row = run.results[0];
  assert.equal(row.profile_id, profileId);
  assert.equal(row.scorer, 'kscore-v2-harness');
  assert.equal(row.accuracy_gate.measured, true);
  assert.equal(row.probe_measurement_receipt.domain, 'quantization');
  assert.equal(row.probe_measurement_receipt.claim_scope, 'paired_measurement_receipt_digest_only');
  assert.equal(JSON.stringify(row.probe_measurement_receipt).includes('SECRET_EVAL_PROMPT'), false);
});

test('W1009 surrogate-only bakeoffs do not mint measured probe receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1009-surrogate-'));
  const modelDir = path.join(root, 'model');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');

  const run = await runMixedPrecisionBakeoff(
    modelDir,
    [profile()],
    [{ output: 'reference answer', model_output: 'reference answer' }],
    { spawnSync: fakeQuantWorker },
  );

  assert.equal(run.ok, true);
  assert.equal(run.results.length, 1);
  const row = run.results[0];
  assert.equal(row.probe_measurement_receipt, undefined);
  assert.equal(row.accuracy_gate.measured, false);
  assert.equal(row.accepted, false);
});
