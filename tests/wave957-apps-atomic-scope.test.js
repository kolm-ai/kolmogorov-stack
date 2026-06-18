// W957 - apps/ backend atomic scope contract.
//
// The master component sheet used to exclude apps/, which hid Python trainer
// and runtime workers from the local-engineering score. Keep this inventory
// explicit so every apps/ worker/runtime/export/trainer component remains in
// docs/backend-atomic-component-deep-dive-2026-06-17.json and has this direct
// test reference.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ATOMIC = path.join(REPO, 'docs', 'backend-atomic-component-deep-dive-2026-06-17.json');

const APPS_COMPONENTS = Object.freeze([
  'apps/capture/image.py',
  'apps/data/ingest.py',
  'apps/data/synth.py',
  'apps/eval/hhem.py',
  'apps/eval/judge.py',
  'apps/eval/judges_mix.py',
  'apps/eval/packs.py',
  'apps/eval/prm.py',
  'apps/export/__init__.py',
  'apps/export/ai_act_docs.py',
  'apps/export/coreml.py',
  'apps/export/executorch.py',
  'apps/export/gguf.py',
  'apps/export/mlx.py',
  'apps/export/model_card.py',
  'apps/export/onnx.py',
  'apps/export/probe.py',
  'apps/export/registry.py',
  'apps/export/run.py',
  'apps/export/sbom.py',
  'apps/export/tensorrt.py',
  'apps/import/__init__.py',
  'apps/import/gguf.py',
  'apps/import/onnx.py',
  'apps/import/safetensors.py',
  'apps/modal/kolm_trainer_app.py',
  'apps/modal/README.md',
  'apps/modal/requirements.txt',
  'apps/replicate/cog.yaml',
  'apps/replicate/predict.py',
  'apps/replicate/README.md',
  'apps/replicate/requirements.txt',
  'apps/runtime/backends/__init__.py',
  'apps/runtime/backends/base.py',
  'apps/runtime/backends/fal.py',
  'apps/runtime/backends/lambda_cloud.py',
  'apps/runtime/backends/local_cpu.py',
  'apps/runtime/backends/local_cuda.py',
  'apps/runtime/backends/local_directml.py',
  'apps/runtime/backends/local_mlx.py',
  'apps/runtime/backends/local_mps.py',
  'apps/runtime/backends/local_rocm.py',
  'apps/runtime/backends/modal.py',
  'apps/runtime/backends/replicate.py',
  'apps/runtime/backends/runpod.py',
  'apps/runtime/backends/sglang.py',
  'apps/runtime/backends/ssh.py',
  'apps/runtime/backends/tgi.py',
  'apps/runtime/backends/together.py',
  'apps/runtime/backends/trt_llm.py',
  'apps/runtime/backends/vast.py',
  'apps/runtime/backends/vllm.py',
  'apps/runtime/best_of_n.py',
  'apps/runtime/constrained.py',
  'apps/runtime/disagg.py',
  'apps/runtime/dispatch.py',
  'apps/runtime/eagle3.py',
  'apps/runtime/entropy_budget.py',
  'apps/runtime/inference_time_scaling.py',
  'apps/runtime/lookahead.py',
  'apps/runtime/medusa.py',
  'apps/runtime/multi_lora.py',
  'apps/runtime/self_verify.py',
  'apps/runtime/serve.py',
  'apps/runtime/streaming_load.py',
  'apps/runtime/streaming_load_bench.py',
  'apps/runtime/tools.py',
  'apps/runtime/ttc.py',
  'apps/showcase/healthcare/build.mjs',
  'apps/showcase/healthcare/patterns.mjs',
  'apps/showcase/healthcare/README.md',
  'apps/showcase/healthcare/run.mjs',
  'apps/trainer/airgap_distill_worker.py',
  'apps/trainer/audio.py',
  'apps/trainer/audio_distill.py',
  'apps/trainer/backends/__init__.py',
  'apps/trainer/backends/cuda.py',
  'apps/trainer/backends/directml.py',
  'apps/trainer/backends/fal_runner.py',
  'apps/trainer/backends/lambda_runner.py',
  'apps/trainer/backends/local.py',
  'apps/trainer/backends/mlx.py',
  'apps/trainer/backends/modal_runner.py',
  'apps/trainer/backends/remote_ssh.py',
  'apps/trainer/backends/replicate_runner.py',
  'apps/trainer/backends/rocm.py',
  'apps/trainer/backends/runpod_runner.py',
  'apps/trainer/backends/together_runner.py',
  'apps/trainer/backends/vast_runner.py',
  'apps/trainer/bench_contrastive_token.py',
  'apps/trainer/bench_trace_aware.py',
  'apps/trainer/contrastive_distill.py',
  'apps/trainer/dapo_runmeta.py',
  'apps/trainer/dapo_sampling.py',
  'apps/trainer/distill.py',
  'apps/trainer/distill_cot.py',
  'apps/trainer/Dockerfile',
  'apps/trainer/eagle3_train.py',
  'apps/trainer/embedding.py',
  'apps/trainer/federated.py',
  'apps/trainer/function_calling.py',
  'apps/trainer/gad.py',
  'apps/trainer/grpo.py',
  'apps/trainer/inference_cache.py',
  'apps/trainer/instant.py',
  'apps/trainer/long_context.py',
  'apps/trainer/lora_variants.py',
  'apps/trainer/main.py',
  'apps/trainer/merge.py',
  'apps/trainer/models.py',
  'apps/trainer/moe.py',
  'apps/trainer/moe_run.py',
  'apps/trainer/multinode_launch.py',
  'apps/trainer/nvfp4.py',
  'apps/trainer/online_dpo.py',
  'apps/trainer/preference.py',
  'apps/trainer/pretokenize_run.py',
  'apps/trainer/pyproject.toml',
  'apps/trainer/qad.py',
  'apps/trainer/README.md',
  'apps/trainer/README-multinode.md',
  'apps/trainer/reject_sample.py',
  'apps/trainer/reranker.py',
  'apps/trainer/reward.py',
  'apps/trainer/ropd.py',
  'apps/trainer/span_objective.py',
  'apps/trainer/speculative.py',
  'apps/trainer/test_distillm2_loss.py',
  'apps/trainer/test_qad.py',
  'apps/trainer/trainer_local.py',
  'apps/trainer/trainer_real.py',
  'apps/trainer/video_distill.py',
  'apps/trainer/vlm.py',
  'apps/trainer/vlm_distill.py',
  'apps/trainer/xlang_distill.py',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__' || entry.name === 'dist' || entry.name === 'build') continue;
      walk(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function rel(abs) {
  return path.relative(REPO, abs).replace(/\\/g, '/');
}

function atomicComponents() {
  const doc = JSON.parse(fs.readFileSync(ATOMIC, 'utf8'));
  return new Map((doc.components || []).map((component) => [component.path, component]));
}

test('apps/ inventory is explicit and in sync with disk', () => {
  const disk = walk(path.join(REPO, 'apps')).map(rel).sort();
  assert.deepEqual(disk, [...APPS_COMPONENTS].sort());
});

test('apps/ files are included in the backend atomic ledger as worker surface', () => {
  const components = atomicComponents();
  for (const componentPath of APPS_COMPONENTS) {
    const component = components.get(componentPath);
    assert.ok(component, `${componentPath} missing from backend atomic ledger`);
    assert.equal(component.surface, 'worker', `${componentPath} should be classified as worker surface`);
    assert.ok(
      component.test_refs.includes('tests/wave957-apps-atomic-scope.test.js'),
      `${componentPath} should carry this direct test reference`,
    );
  }
});

test('apps/ source files are non-empty and free of merge-conflict markers', () => {
  for (const componentPath of APPS_COMPONENTS) {
    const body = fs.readFileSync(path.join(REPO, componentPath), 'utf8');
    assert.ok(body.trim().length > 0, `${componentPath} is empty`);
    assert.doesNotMatch(body, /^(<<<<<<<|=======|>>>>>>>) /m, `${componentPath} has merge-conflict markers`);
  }
});
