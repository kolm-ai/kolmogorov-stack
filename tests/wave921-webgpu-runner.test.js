// Wave 921 - on-device WebGPU runner contract.
//
// Two jobs:
//   (1) Lock the *honest* platform-capabilities status for the browser WebGPU
//       runtime. A minimal transformers.js demo path now ships, but full
//       Kolm-artifact in-browser inference is not yet built, so the status must
//       NOT claim a bare 'implemented'.
//   (2) Statically assert the runner files exist and are well-formed without
//       requiring a real GPU/network. Headless CI may have no WebGPU adapter,
//       so this is a structure/contract test only - it never generates tokens.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  listPlatformCapabilities,
  MODEL_FRAMEWORK_TARGETS,
} from '../src/platform-capabilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER_JS = path.join(ROOT, 'public', 'device', 'webgpu-runner.js');
const RUNNER_HTML = path.join(ROOT, 'public', 'device', 'webgpu-runner.html');

const CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers';

test('W921 #1 - wasm-webgpu framework status is honest (not a bare "implemented" WebGPU inference claim)', () => {
  const caps = listPlatformCapabilities();
  const row = caps.model_framework_targets.find((r) => r.id === 'wasm-webgpu');
  assert.ok(row, 'wasm-webgpu framework target must exist');
  // The accuracy fix: must reflect reality, not over-claim.
  assert.notEqual(row.status, 'implemented', 'WebGPU LLM inference is not fully implemented');
  assert.ok(
    ['in_progress', 'target-declared', 'target_declared', 'manifest-supported', 'dependency-gated'].includes(row.status),
    `wasm-webgpu status must be an accurate non-implemented value, got: ${row.status}`,
  );
  assert.ok(typeof row.note === 'string' && row.note.length > 0, 'status should carry a short honest note');
  // Evidence should point at the new runner files now that they exist.
  assert.ok(
    row.evidence.includes('public/device/webgpu-runner.js'),
    'wasm-webgpu evidence should reference the shipped runner',
  );
});

test('W921 #2 - the frozen MODEL_FRAMEWORK_TARGETS export agrees with the listing', () => {
  const row = MODEL_FRAMEWORK_TARGETS.find((r) => r.id === 'wasm-webgpu');
  assert.ok(row, 'wasm-webgpu must be present in the frozen export');
  assert.notEqual(row.status, 'implemented');
});

test('W921 #3 - runner JS file exists and is well-formed', () => {
  assert.ok(fs.existsSync(RUNNER_JS), 'public/device/webgpu-runner.js must exist');
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  // ESM exports the public API used by the harness + tests.
  for (const sym of ['runOnDevice', 'pickRuntime', 'renderResult', 'TRANSFORMERS_CDN_URL']) {
    assert.ok(new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${sym}\\b`).test(src), `must export ${sym}`);
  }
  // The CDN import URL must be present (the dependency-light load path).
  assert.ok(src.includes(CDN_URL), 'must reference the @huggingface/transformers CDN URL');
  // It uses a dynamic import so the module parses without pulling the CDN.
  assert.ok(/await import\(/.test(src), 'must dynamically import transformers.js at call time');
  // Result envelope shape is part of the contract.
  for (const key of ['ok', 'runtime', 'tokens', 'ms', 'device']) {
    assert.ok(new RegExp(`${key}\\b`).test(src), `envelope should reference ${key}`);
  }
  assert.ok(/'webgpu'/.test(src) && /'wasm'/.test(src), 'must handle both webgpu and wasm runtimes');
});

test('W921 #4 - runner JS is statically importable and pure helpers behave', async () => {
  // Importing the module must not require a browser or the CDN. The top-level
  // code only touches `window` behind a typeof guard.
  const mod = await import('../public/device/webgpu-runner.js');
  assert.equal(typeof mod.runOnDevice, 'function');
  assert.equal(typeof mod.pickRuntime, 'function');
  assert.equal(typeof mod.renderResult, 'function');
  assert.equal(mod.TRANSFORMERS_CDN_URL, 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5');

  // pickRuntime is a pure function of a navigator-like object - deterministic,
  // no real GPU needed.
  assert.equal(mod.pickRuntime({ gpu: {} }), 'webgpu');
  assert.equal(mod.pickRuntime({}), 'wasm');
  assert.equal(mod.pickRuntime(null), 'wasm');

  // renderResult writes JSON into a fake element and returns the envelope.
  const fake = {};
  const env = { ok: true, runtime: 'wasm', tokens: 3 };
  assert.equal(mod.renderResult(env, fake), env);
  assert.ok(fake.textContent.includes('"tokens": 3'));

  // runOnDevice with an injected fake transformers module never touches the
  // network and produces a well-formed success envelope (deterministic).
  const fakeTransformers = {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => {
      const gen = async () => [{ generated_text: 'hello on device world' }];
      gen.tokenizer = { encode: (t) => String(t).trim().split(/\s+/) };
      return gen;
    },
  };
  const result = await mod.runOnDevice({
    transformers: fakeTransformers,
    navigator: {},
    prompt: 'hi',
    maxNewTokens: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.runtime, 'wasm');
  assert.equal(result.device, 'wasm');
  assert.ok(result.tokens >= 1, 'should count at least one token');
  assert.equal(typeof result.ms, 'number');
  assert.ok(result.text.includes('hello'));

  // Error path: a throwing pipeline yields ok:false with an error string and
  // still returns the full envelope shape.
  const errResult = await mod.runOnDevice({
    transformers: { pipeline: async () => { throw new Error('no adapter'); } },
    navigator: { gpu: {} },
  });
  assert.equal(errResult.ok, false);
  assert.equal(errResult.runtime, 'webgpu');
  assert.equal(errResult.error, 'no adapter');
  assert.equal(errResult.tokens, 0);
});

test('W921 #5 - harness HTML exists and references the runner module + CDN', () => {
  assert.ok(fs.existsSync(RUNNER_HTML), 'public/device/webgpu-runner.html must exist');
  const html = fs.readFileSync(RUNNER_HTML, 'utf8');
  assert.ok(/<!DOCTYPE html>/i.test(html), 'must be an HTML document');
  // The page must load the runner as an ES module.
  assert.ok(/type="module"/.test(html), 'must use a module script');
  assert.ok(/['"]\.\/webgpu-runner\.js['"]/.test(html), 'must import ./webgpu-runner.js');
  assert.ok(/runOnDevice/.test(html), 'must call runOnDevice');
  // Surfaces the honest status to anyone viewing the demo.
  assert.ok(/in_progress/.test(html), 'must surface the honest in_progress status');
});
