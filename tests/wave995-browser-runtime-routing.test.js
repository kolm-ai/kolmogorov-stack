// W995 - browser/WebGPU runtime routing for signed weight artifacts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BROWSER_ONLY_RUNTIMES,
  RUNTIME_SELECTION,
  detectRuntime,
  selectRuntime,
} from '../src/serve-autodetect.js';
import {
  BROWSER_DEPLOY_TARGET_INFO,
  describeBrowserDeployTarget,
} from '../src/compile-targets.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const HW_BROWSER = {
  class: 'browser',
  primary: {
    vendor: 'browser',
    name: 'Chromium WebGPU',
    vram_gb: 4,
    compute_capability: 'webgpu',
    native_dtypes: ['fp16', 'int8', 'int4'],
  },
};

test('W995 serve-autodetect has explicit browser rows for frontier browser engines', async () => {
  assert.equal(RUNTIME_SELECTION.gguf.browser.runtime, 'llama.cpp-webgpu');
  assert.equal(RUNTIME_SELECTION.mlc.browser.runtime, 'webllm');
  assert.equal(RUNTIME_SELECTION.onnx.browser.runtime, 'onnxruntime-web');
  assert.ok(BROWSER_ONLY_RUNTIMES.includes('llama.cpp-webgpu'));
  assert.ok(BROWSER_ONLY_RUNTIMES.includes('webllm'));
  assert.ok(BROWSER_ONLY_RUNTIMES.includes('onnxruntime-web'));

  const gguf = await selectRuntime('/models/qwen.gguf', 'browser');
  assert.equal(gguf.ok, true);
  assert.equal(gguf.runtime, 'llama.cpp-webgpu');
  assert.equal(gguf.browser_only, true);
  assert.equal(gguf.requires_signed_weights, true);

  const mlc = await selectRuntime('/models/qwen-q4f16_1.mlc', { class: 'browser' });
  assert.equal(mlc.ok, true);
  assert.equal(mlc.runtime, 'webllm');

  const onnx = await selectRuntime('/models/embed.onnx', { class: 'browser' });
  assert.equal(onnx.ok, true);
  assert.equal(onnx.runtime, 'onnxruntime-web');
});

test('W995 detectRuntime emits browser deploy specs instead of server spawn commands', () => {
  const gguf = detectRuntime({ artifactPath: '/models/qwen.gguf', hwProbe: HW_BROWSER });
  assert.equal(gguf.runtime, 'llama.cpp-webgpu');
  assert.equal(gguf.gpu_class, 'browser');
  assert.equal(gguf.browser_only, true);
  assert.equal(gguf.requires_signed_weights, true);
  assert.equal(gguf.env.KOLM_BROWSER_REQUIRE_SIGNED_WEIGHTS, '1');
  assert.equal(gguf.env.KOLM_BROWSER_NO_UNSIGNED_AUTO_FETCH, '1');
  assert.equal(gguf.command.bin, 'browser-deploy-spec');
  assert.equal(gguf.command.browser_only, true);
  assert.match(gguf.reason, /signed-weight deploy spec/);

  const mlc = detectRuntime({
    artifactPath: '/models/renamed.bin',
    manifest: { format: 'mlc' },
    hwProbe: HW_BROWSER,
  });
  assert.equal(mlc.runtime, 'webllm');
  assert.equal(mlc.format, 'mlc');

  const onnx = detectRuntime({ artifactPath: '/models/embed.onnx', hwProbe: HW_BROWSER });
  assert.equal(onnx.runtime, 'onnxruntime-web');
});

test('W995 compile/deploy catalog carries signed-manifest browser requirements', () => {
  assert.equal(BROWSER_DEPLOY_TARGET_INFO.gguf.runtime, 'llama.cpp-webgpu');
  assert.equal(BROWSER_DEPLOY_TARGET_INFO.mlc.runtime, 'webllm');
  assert.equal(BROWSER_DEPLOY_TARGET_INFO.onnx.runtime, 'onnxruntime-web');

  for (const target of ['gguf', 'mlc', 'onnx']) {
    const info = describeBrowserDeployTarget(target);
    assert.equal(info.signed_weight_manifest_required, true);
    assert.equal(info.no_unsigned_auto_fetch, true);
    assert.ok(info.required_artifact_fields.includes('model_weight_artifact_manifest'));
  }
  assert.equal(describeBrowserDeployTarget('safetensors'), null);
});

test('W995 stack spec closes routing without claiming LlamaWeb browser GGUF execution', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');
  assert.match(spec, /CLOSED W995: Browser runtime deploy rows for LlamaWeb\/WebLLM\/ONNX-Web/);
  assert.match(spec, /browser-only signed-weight deploy specs/);
  assert.match(spec, /CLOSED W999: wire signed WebLLM browser runner/);
  assert.match(spec, /LlamaWeb GGUF execution remains unwired/);
});
