// tests/wave921-runtime-passport-w921.test.js
//
// W921 Run / Serve & Deploy — the additive v2 passport helpers
// (serving_kernel, generalized KV policy, probe merge) and their integration
// with the serve-config picker entries. All pure, no GPU, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_PASSPORT_FIELDS_V2,
  RUNTIME_PASSPORT_FIELDS,
  validatePassport,
  estimatePassport,
  addServingKernelToPassport,
  addKvPolicyToPassport,
  addShardKvCacheToPassport,
  mergeProbeIntoPassports,
  recordTestedPassport,
} from '../src/runtime-passport.js';
import {
  resolveServingKernel,
  quantDescriptorFromArtifact,
  servingKernelPassportEntry,
  kvPolicyPassportEntry,
  selectKvCachePolicy,
} from '../src/serve-config.js';
import {
  planRemoteDistill,
  selectGpuForJob,
  estimateDistillVramGb,
  buildModalLaunchSpec,
  buildRunpodLaunchSpec,
} from '../src/distill-runners/index.js';

// ---------------------------------------------------------------------------
// passport schema additivity
// ---------------------------------------------------------------------------

test('v2 fields include serving_kernel; v1 fields unchanged', () => {
  assert.ok(RUNTIME_PASSPORT_FIELDS_V2.includes('serving_kernel'));
  assert.ok(RUNTIME_PASSPORT_FIELDS_V2.includes('kv_cache'));
  // v1 validator field list must NOT have grown (back-compat).
  assert.equal(RUNTIME_PASSPORT_FIELDS.includes('serving_kernel'), false);
});

test('existing v1 estimatePassport row still validates', () => {
  const p = estimatePassport({ target_id: 'vllm-fp16', runtime: 'vllm', runtime_version: '0.10.0', precision: 'fp16', params_b: 7 });
  assert.equal(validatePassport(p).ok, true);
});

// ---------------------------------------------------------------------------
// serving_kernel attach (kernel oracle -> passport)
// ---------------------------------------------------------------------------

test('addServingKernelToPassport carries a serve-config kernel entry', () => {
  const resolved = resolveServingKernel(quantDescriptorFromArtifact({ method: 'awq', bits: 4, group_size: 128 }), '8.9');
  const entry = servingKernelPassportEntry({ resolved, compute_capability: '8.9', measured: { tok_s: 741, baseline_tok_s: 68 } });
  const base = estimatePassport({ target_id: 'vllm-int4', runtime: 'vllm', runtime_version: '0.10.0', precision: 'int4', params_b: 32 });
  const enriched = addServingKernelToPassport(base, entry);
  assert.equal(enriched.serving_kernel.kernel, 'awq_marlin');
  assert.equal(enriched.serving_kernel.status, 'tested');
  assert.ok(enriched.serving_kernel.measured_speedup_x > 10);
  // input passport not mutated
  assert.equal('serving_kernel' in base, false);
});

test('addServingKernelToPassport rejects bad input', () => {
  assert.throws(() => addServingKernelToPassport(null, {}), /passport/);
  assert.throws(() => addServingKernelToPassport({}, null), /serving_kernel/);
});

// ---------------------------------------------------------------------------
// generalized KV policy attach (kv picker -> passport)
// ---------------------------------------------------------------------------

test('addKvPolicyToPassport accepts any policy entry, not just shard', () => {
  const policy = selectKvCachePolicy({ format: 'transformers', requested: 'snapkv' });
  const entry = kvPolicyPassportEntry({ policy: policy.policy, params: policy.params, measured: { compression_ratio: 0.5, peak_kv_mb: 1024, retained_tokens: 256, evicted_tokens: 256, quality_delta: -0.01 } });
  const base = estimatePassport({ target_id: 't-fp16', runtime: 'transformers', runtime_version: '4.46', precision: 'fp16', params_b: 7 });
  const enriched = addKvPolicyToPassport(base, entry);
  assert.equal(enriched.kv_cache.policy, 'snapkv');
  assert.equal(enriched.kv_cache.status, 'tested');
  // backward-compat: the legacy shard attach still works
  const shardEnriched = addShardKvCacheToPassport(base, { foo: 'bar' });
  assert.deepEqual(shardEnriched.kv_cache, { foo: 'bar' });
});

// ---------------------------------------------------------------------------
// probe merge (estimated -> tested by target_id)
// ---------------------------------------------------------------------------

test('mergeProbeIntoPassports replaces matching estimated row, leaves others', () => {
  const est1 = estimatePassport({ target_id: 'vllm-fp16', runtime: 'vllm', runtime_version: '0.10', precision: 'fp16', params_b: 7 });
  const est2 = estimatePassport({ target_id: 'llama.cpp-q4_k_m', runtime: 'llama.cpp', runtime_version: 'b3000', precision: 'q4_k_m', params_b: 7 });
  const tested = recordTestedPassport({ target_id: 'vllm-fp16', runtime: 'vllm', runtime_version: 'vllm 0.10.0', precision: 'fp16', memory_mb: 18000, latency_p50_ms: 12, latency_p95_ms: 22, tok_s: 41, quality_delta: 0 });
  const merged = mergeProbeIntoPassports([est1, est2], tested);
  assert.equal(merged.length, 2);
  const vllmRow = merged.find((p) => p.target_id === 'vllm-fp16');
  assert.equal(vllmRow.status, 'tested');
  assert.equal(merged.find((p) => p.target_id === 'llama.cpp-q4_k_m').status, 'estimated');
  // original array untouched
  assert.equal(est1.status, 'estimated');
});

test('mergeProbeIntoPassports appends when no estimated row matches', () => {
  const tested = recordTestedPassport({ target_id: 'new-target', runtime: 'mlx', runtime_version: 'mlx 0.20', precision: 'fp16', memory_mb: 8000, latency_p50_ms: 18, latency_p95_ms: 30, tok_s: 60, quality_delta: 0 });
  const merged = mergeProbeIntoPassports([], tested);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].target_id, 'new-target');
  // bad input -> unchanged copy
  assert.deepEqual(mergeProbeIntoPassports(['x'], null), ['x']);
});

// ---------------------------------------------------------------------------
// distill runners (remote launch spec planner)
// ---------------------------------------------------------------------------

test('estimateDistillVramGb: LoRA 7B fits a 24GB GPU, full-finetune does not', () => {
  const lora = estimateDistillVramGb({ params_b: 7 });
  assert.ok(lora > 14 && lora < 30);
  const full = estimateDistillVramGb({ params_b: 7, full_finetune: true });
  assert.ok(full > lora);
});

test('selectGpuForJob: picks smallest fitting GPU per provider', () => {
  const r = selectGpuForJob({ student_params_b: 7 }, { provider: 'runpod' });
  assert.ok(r.gpu);
  assert.equal(r.fits, true);
  assert.ok(r.gpu.vram_gb >= 24);
  // explicit override
  const o = selectGpuForJob({ student_params_b: 7 }, { provider: 'runpod', gpu: 'H100' });
  assert.equal(o.gpu.id, 'H100');
});

test('planRemoteDistill: runpod 14B -> ok spec with gpu_type_id', () => {
  const plan = planRemoteDistill({ recipe: { id: 'trinity-2000', student_params_b: 14 }, provider: 'runpod' });
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'runpod');
  assert.equal(plan.spec.provider, 'runpod');
  assert.ok(plan.spec.gpu_type_id);
  assert.ok(plan.spec.env.KOLM_OUT_DIR);
});

test('W1020 planRemoteDistill carries train launcher env into remote specs', () => {
  const plan = planRemoteDistill({
    recipe: {
      id: 'frontier-32b',
      student: 'unsloth/Qwen2.5-32B-Instruct-bnb-4bit',
      student_params_b: 32,
      train_launcher: 'single_32b_unsloth',
      train_launch_plan: {
        kind: 'single_32b_unsloth',
        env: {
          KOLM_32B_BASE: 'unsloth/Qwen2.5-32B-Instruct-bnb-4bit',
          KOLM_32B_STEPS: '12',
        },
      },
    },
    provider: 'runpod',
    gpu: 'RTX5090',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.gpu.id, 'RTX5090');
  assert.equal(plan.spec.env.KOLM_TRAIN_LAUNCHER, 'single_32b_unsloth');
  assert.equal(plan.spec.env.KOLM_32B_BASE, 'unsloth/Qwen2.5-32B-Instruct-bnb-4bit');
  assert.equal(plan.spec.env.KOLM_32B_STEPS, '12');
});

test('planRemoteDistill: modal spec carries gpu + env', () => {
  const plan = planRemoteDistill({ recipe: { id: 'x', student: 'Qwen/Qwen3-8B', student_params_b: 8 }, provider: 'modal' });
  assert.equal(plan.spec.provider, 'modal');
  assert.ok(plan.spec.function.gpu);
  assert.equal(plan.spec.function.env.KOLM_STUDENT, 'Qwen/Qwen3-8B');
});

test('planRemoteDistill: unknown provider -> not ok', () => {
  const plan = planRemoteDistill({ recipe: {}, provider: 'nope' });
  assert.equal(plan.ok, false);
});

test('buildModalLaunchSpec + buildRunpodLaunchSpec are frozen + deterministic', () => {
  const m1 = buildModalLaunchSpec({ recipe: { id: 'r', student_params_b: 7 } });
  const m2 = buildModalLaunchSpec({ recipe: { id: 'r', student_params_b: 7 } });
  assert.deepEqual(m1, m2);
  assert.ok(Object.isFrozen(m1));
  const r1 = buildRunpodLaunchSpec({ recipe: { id: 'r', student_params_b: 7 } });
  assert.ok(Object.isFrozen(r1));
  assert.ok(r1.docker_args.includes('--out-dir'));
});
