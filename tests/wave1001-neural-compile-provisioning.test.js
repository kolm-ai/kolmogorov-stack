// W1001: neural compile provisioning contract.
//
// A distilled_model compile is not turnkey until it has a selected backbone,
// a supported portable export target, disjoint train/holdout rows, an execution
// lane, and post-train real-byte signing gates. This test pins that contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NEURAL_COMPILE_PROVISIONING_VERSION,
  buildNeuralCompileProvisioningPlan,
  normalizeNeuralCompilePortableTarget,
} from '../src/neural-compile-provisioning.js';

test('W1001 default neural compile plan names frontier backbone and external byte gate', () => {
  const plan = buildNeuralCompileProvisioningPlan({
    job: {
      recipe_class: 'distilled_model',
      base_model: 'none',
      output_target: 'gguf',
    },
    train_count: 6,
    holdout_eval_count: 2,
  }, {
    cloudBackendStatus: {
      status: 'no_pool_configured',
      endpoint: null,
      hint: 'fixture status',
    },
  });

  assert.equal(plan.version, NEURAL_COMPILE_PROVISIONING_VERSION);
  assert.equal(plan.ok, true);
  assert.equal(plan.student_base, 'Qwen/Qwen3-4B-Instruct-2507');
  assert.equal(plan.selected_default, true);
  assert.equal(plan.model_registry.present, true);
  assert.equal(plan.model_registry.frontier_student, true);
  assert.equal(plan.backbone_registry.present, true);
  assert.equal(plan.portable_target.id, 'gguf');
  assert.equal(plan.portable_target.recipe_field, 'gguf_file');
  assert.equal(plan.runtime_weight_manifest.status, 'post_train_export_required_no_prebuilt_variant');
  assert.equal(plan.execution_lane.cloud_backend_status, 'no_pool_configured');
  assert.ok(plan.post_train_signing_gates.includes('portable_weight_file_present_and_nonempty'));
  assert.equal(plan.external_execution_gate.fixture_injection_claimable, false);
});

test('W1001 only artifact-portable neural targets are accepted before worker dispatch', () => {
  assert.equal(normalizeNeuralCompilePortableTarget('gguf')?.runtime_target, 'gguf');
  assert.equal(normalizeNeuralCompilePortableTarget('onnx')?.recipe_field, 'onnx_file');
  assert.equal(normalizeNeuralCompilePortableTarget('wasm')?.recipe_field, 'weights_file');
  assert.equal(normalizeNeuralCompilePortableTarget('safetensors'), null);

  const plan = buildNeuralCompileProvisioningPlan({
    job: {
      recipe_class: 'distilled_model',
      base_model: 'Qwen/Qwen3-4B-Instruct-2507',
      output_target: 'safetensors',
    },
    train_count: 6,
    holdout_eval_count: 2,
  }, { cloudBackendStatus: { status: 'simulated', endpoint: 'simulated://unit' } });

  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'KOLM_E_NEURAL_PORTABLE_TARGET_UNSUPPORTED');
  assert.match(plan.error, /portable_target_supported/);
  const failed = plan.required_pretrain_checks.find((row) => row.name === 'portable_target_supported');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.allowed, ['gguf', 'onnx', 'wasm']);
});

test('W1001 unknown neural bases fail strict registry preflight but remain explicit opt-in', () => {
  const strict = buildNeuralCompileProvisioningPlan({
    job: {
      recipe_class: 'distilled_model',
      base_model: 'example/NotARegisteredStudent',
      output_target: 'gguf',
    },
    train_count: 6,
    holdout_eval_count: 2,
  }, { cloudBackendStatus: { status: 'simulated', endpoint: 'simulated://unit' } });

  assert.equal(strict.ok, false);
  assert.equal(strict.code, 'KOLM_E_NEURAL_MODEL_UNKNOWN');
  assert.equal(strict.model_registry.present, false);
  assert.equal(strict.backbone_registry.present, false);

  const optIn = buildNeuralCompileProvisioningPlan({
    job: {
      recipe_class: 'distilled_model',
      base_model: 'example/NotARegisteredStudent',
      output_target: 'gguf',
    },
    train_count: 6,
    holdout_eval_count: 2,
  }, {
    allowUnregisteredBase: true,
    cloudBackendStatus: { status: 'simulated', endpoint: 'simulated://unit' },
  });

  assert.equal(optIn.ok, true);
  assert.equal(optIn.model_registry.present, false);
  assert.equal(optIn.external_execution_gate.requires_real_gpu_or_managed_provider, true);
});

test('W1001 compile records provisioning and fails before worker for unsupported target', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1001-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    id: 'ex_' + i,
    input: 'prompt ' + i,
    output: 'answer ' + i,
  }));
  const job = createJob({
    task: 'answer prompts with a neural student',
    examples,
    tenant: 't_w1001_a',
    recipe_class: 'distilled_model',
    base_model: 'Qwen/Qwen3-4B-Instruct-2507',
    output_target: 'safetensors',
    k_threshold: 0.50,
  });

  let distillCalled = false;
  await runJob(job, {
    examples,
    synthesize: async () => { throw new Error('synthesize must not run for distilled_model compile'); },
    distill: async function* () {
      distillCalled = true;
      yield { done: true };
    },
    recall: null,
    registry: null,
    outDir: process.env.KOLM_DATA_DIR,
    neuralProvisioning: {
      cloudBackendStatus: { status: 'simulated', endpoint: 'simulated://unit' },
    },
  });

  const fresh = getJob(job.id, 't_w1001_a');
  assert.equal(distillCalled, false, 'unsupported portable target must fail before worker dispatch');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_NEURAL_PORTABLE_TARGET_UNSUPPORTED');
  const stage = fresh.stages.find((row) => row.name === 'distill.neural.provisioning');
  assert.ok(stage, 'compile must record the provisioning stage');
  assert.equal(stage.ok, false);
  assert.equal(stage.portable_target.supported, false);
  assert.equal(fresh.neural_compile.provisioning.code, 'KOLM_E_NEURAL_PORTABLE_TARGET_UNSUPPORTED');
});

test('W1001 compile carries successful preflight into existing worker failure envelope', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1001-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    id: 'ex_' + i,
    input: 'prompt ' + i,
    output: 'answer ' + i,
  }));
  const job = createJob({
    task: 'answer prompts with a neural student',
    examples,
    tenant: 't_w1001_b',
    recipe_class: 'distilled_model',
    base_model: 'Qwen/Qwen3-4B-Instruct-2507',
    output_target: 'gguf',
    k_threshold: 0.50,
  });

  await runJob(job, {
    examples,
    synthesize: async () => { throw new Error('synthesize must not run for distilled_model compile'); },
    distill: async function* () {
      yield {
        done: true,
        artifact_path: process.env.KOLM_DATA_DIR,
        worker_mode: 'collect',
        student_path: null,
        manifest: {
          worker: 'kolm-distill-worker',
          worker_version: 'w1001-test',
          mode: 'collect',
          ml_pipeline_run: false,
        },
      };
    },
    recall: null,
    registry: null,
    outDir: process.env.KOLM_DATA_DIR,
    neuralProvisioning: {
      cloudBackendStatus: { status: 'simulated', endpoint: 'simulated://unit' },
    },
  });

  const fresh = getJob(job.id, 't_w1001_b');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_NEURAL_TRAINING_NOT_RUN');
  const stage = fresh.stages.find((row) => row.name === 'distill.neural.provisioning');
  assert.equal(stage.ok, true);
  assert.equal(stage.student_base, 'Qwen/Qwen3-4B-Instruct-2507');
  assert.equal(stage.runtime_weight_manifest.status, 'post_train_export_required_no_prebuilt_variant');
  assert.equal(fresh.neural_compile.provisioning.ok, true);
  assert.ok(fresh.neural_compile.provisioning.post_train_signing_gates.includes('manifest.ml_pipeline_run=true'));
});
