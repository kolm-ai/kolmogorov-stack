import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_WEIGHT_MANIFEST_SPEC,
  BROWSER_WEIGHT_SIGNATURE_SPEC,
  BROWSER_WEIGHT_SIGNED_FIELDS,
  canonicalWeightManifest,
} from '../public/device/webgpu-runner.js';
import {
  WEBLLM_RUNTIME,
  normalizeWebLlmRuntimeConfig,
  runVerifiedWebLlmModel,
} from '../public/device/webllm-runner.js';
import { DEVICE_TARGETS, MODEL_FRAMEWORK_TARGETS } from '../src/platform-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_PATH = path.join(ROOT, 'public', 'device', 'webllm-runner.js');
const SPEC_PATH = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(bytes) {
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

async function signedWebLlmManifest(weightsBytes, overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = {
    schema: BROWSER_WEIGHT_MANIFEST_SPEC,
    model_id: 'kolm-webllm-fixture-q4f16',
    runtime: WEBLLM_RUNTIME,
    weights_url: './webllm-model.mlc',
    weights_sha256: await sha256Hex(weightsBytes),
    runtime_config: {
      model_id: 'kolm-webllm-fixture-q4f16',
      require_webgpu: false,
      cache_mode: 'indexeddb',
      cache_name: 'kolm-webllm-test-cache',
      max_tokens: 16,
      max_output_chars: 1024,
      chat_options: { top_p: 0.9 },
    },
    input: { prompt: 'Say signed inference.' },
    output_labels: ['text'],
    created_at: '2026-06-19T00:00:00Z',
    ...overrides,
  };
  const signature = crypto.sign(null, Buffer.from(canonicalWeightManifest(manifest)), privateKey);
  manifest.signature_ed25519 = {
    alg: 'ed25519',
    spec: BROWSER_WEIGHT_SIGNATURE_SPEC,
    public_key: publicPem,
    signature: b64url(signature),
  };
  return manifest;
}

function fakeWebLlm(record = {}, { byteLoader = true } = {}) {
  record.events = record.events || [];
  return {
    async CreateMLCEngine(modelId, appConfig) {
      record.events.push('create');
      record.modelId = modelId;
      record.appConfig = appConfig;
      const engine = {
        chat: {
          completions: {
            async create(options) {
              record.events.push('chat');
              record.chatOptions = options;
              return {
                choices: [{ message: { content: 'signed WebLLM response' } }],
                usage: { completion_tokens: 4, ttft_ms: 12 },
              };
            },
          },
        },
      };
      if (byteLoader) {
        engine.loadModelFromBytes = async (bytes, info) => {
          record.events.push('load-bytes');
          record.loadedByteLength = bytes.byteLength;
          record.loadInfo = info;
        };
      }
      return engine;
    },
  };
}

test('W999 signed manifest covers WebLLM runtime config and prompt contract', () => {
  assert.ok(BROWSER_WEIGHT_SIGNED_FIELDS.includes('runtime_config'));
  const cfg = normalizeWebLlmRuntimeConfig({
    model_id: 'outer-model',
    runtime_config: {
      model_id: 'signed-model',
      cache_mode: 'indexeddb',
      cache_name: 'kolm-cache',
      require_webgpu: false,
      max_tokens: 32,
      chat_options: { top_p: 0.8 },
    },
  });
  assert.equal(cfg.modelId, 'signed-model');
  assert.equal(cfg.cacheMode, 'indexeddb');
  assert.equal(cfg.cacheName, 'kolm-cache');
  assert.equal(cfg.requireWebGpu, false);
  assert.equal(cfg.maxTokens, 32);
  assert.equal(cfg.chatOptions.top_p, 0.8);
});

test('W999 runVerifiedWebLlmModel verifies signed MLC bytes before WebLLM chat', async () => {
  const weights = Buffer.from('pretend-mlc-webllm-model-shards');
  const manifest = await signedWebLlmManifest(weights);
  const record = {};
  const result = await runVerifiedWebLlmModel({
    manifest,
    weightsBytes: weights,
    webllm: fakeWebLlm(record),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.runtime, WEBLLM_RUNTIME);
  assert.equal(result.output_text, 'signed WebLLM response');
  assert.deepEqual(record.events, ['create', 'load-bytes', 'chat']);
  assert.equal(record.modelId, 'kolm-webllm-fixture-q4f16');
  assert.equal(record.loadedByteLength, weights.length);
  assert.equal(record.loadInfo.weights_sha256, result.weights_sha256);
  assert.equal(record.appConfig.cache_mode, 'indexeddb');
  assert.equal(record.chatOptions.max_tokens, 16);
  assert.deepEqual(record.chatOptions.messages, [{ role: 'user', content: 'Say signed inference.' }]);
  assert.equal(result.runtime_passport.runtime, WEBLLM_RUNTIME);
  assert.equal(result.runtime_passport.sig_ok, true);
  assert.equal(result.runtime_passport.cache_mode, 'indexeddb');
  assert.equal(result.runtime_passport.byte_load_method, 'engine.loadModelFromBytes');
  assert.equal(result.runtime_passport.tokens_generated, 4);
  assert.equal(result.runtime_passport.ttft_ms, 12);
  assert.ok(result.checks.some((row) => row.name === 'Ed25519 manifest signature valid' && row.ok));
});

test('W999 WebLLM runner refuses signed-runtime tampering before engine creation', async () => {
  const weights = Buffer.from('pretend-mlc-webllm-model-shards');
  const manifest = await signedWebLlmManifest(weights);
  const tampered = {
    ...manifest,
    runtime_config: {
      ...manifest.runtime_config,
      max_tokens: 4096,
    },
  };
  const record = {};
  const result = await runVerifiedWebLlmModel({
    manifest: tampered,
    weightsBytes: weights,
    webllm: fakeWebLlm(record),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'verify');
  assert.match(result.reason, /signature/i);
  assert.deepEqual(record.events, [], 'WebLLM engine must not be created after manifest tampering');
});

test('W999 WebLLM runner has no implicit CDN/runtime auto-fetch path', async () => {
  const weights = Buffer.from('pretend-mlc-webllm-model-shards');
  const manifest = await signedWebLlmManifest(weights);
  await assert.rejects(
    () => runVerifiedWebLlmModel({
      manifest,
      weightsBytes: weights,
      skipWebGpuAvailabilityCheck: true,
    }),
    /WebLLM unavailable/,
  );

  const tamperedImport = await runVerifiedWebLlmModel({
    manifest: {
      ...manifest,
      runtime_config: {
        ...manifest.runtime_config,
        webllm_import_url: 'https://cdn.example.invalid/web-llm.js',
      },
    },
    weightsBytes: weights,
    skipWebGpuAvailabilityCheck: true,
  });
  assert.equal(tamperedImport.ok, false);
  assert.match(tamperedImport.reason, /signature/i);

  const signedImportManifest = await signedWebLlmManifest(weights, {
    runtime_config: {
      ...manifest.runtime_config,
      webllm_import_url: 'https://cdn.example.invalid/web-llm.js',
    },
  });
  await assert.rejects(
    () => runVerifiedWebLlmModel({
      manifest: signedImportManifest,
      weightsBytes: weights,
      skipWebGpuAvailabilityCheck: true,
    }),
    /allowRuntimeImport:true/,
  );
});

test('W999 WebLLM runner refuses unsigned engine-managed model fetch', async () => {
  const weights = Buffer.from('pretend-mlc-webllm-model-shards');
  const manifest = await signedWebLlmManifest(weights);
  const record = {};
  await assert.rejects(
    () => runVerifiedWebLlmModel({
      manifest,
      weightsBytes: weights,
      webllm: fakeWebLlm(record, { byteLoader: false }),
      skipWebGpuAvailabilityCheck: true,
    }),
    /signed-byte loader bridge/,
  );
  assert.deepEqual(record.events, ['create']);
});

test('W999 WebLLM runner supports an explicit signed-byte cache bridge', async () => {
  const weights = Buffer.from('pretend-mlc-webllm-model-shards');
  const manifest = await signedWebLlmManifest(weights);
  const record = {};
  const result = await runVerifiedWebLlmModel({
    manifest,
    weightsBytes: weights,
    webllm: fakeWebLlm(record, { byteLoader: false }),
    loadModelBytes: async ({ weightsBytes: loadedBytes, weightsSha256 }) => {
      record.events.push('bridge-load');
      record.bridgeByteLength = loadedBytes.byteLength;
      record.bridgeSha = weightsSha256;
    },
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(record.events, ['create', 'bridge-load', 'chat']);
  assert.equal(record.bridgeByteLength, weights.length);
  assert.equal(record.bridgeSha, result.weights_sha256);
  assert.equal(result.runtime_passport.byte_load_method, 'opts.loadModelBytes');
});

test('W999 platform evidence and stack spec record signed WebLLM closure honestly', () => {
  assert.ok(fs.existsSync(RUNNER_PATH));
  const browser = DEVICE_TARGETS.find((target) => target.id === 'browser-webgpu');
  const framework = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'wasm-webgpu');
  assert.ok(browser);
  assert.ok(framework);
  assert.ok(browser.runtimes.includes('webllm'));
  assert.ok(browser.evidence.includes('public/device/webllm-runner.js'));
  assert.ok(framework.evidence.includes('public/device/webllm-runner.js'));
  const source = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.match(source, /no default CDN import/i);
  assert.match(source, /unsigned[\s/]+engine-managed model fetch path/i);
  assert.doesNotMatch(source, /unpkg\.com|jsdelivr|cdn\.jsdelivr|cdn\.skypack/i);
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /CLOSED W999: wire signed WebLLM browser runner/);
  assert.match(spec, /CLOSED W1000: wire signed LlamaWeb GGUF browser runner/);
  assert.doesNotMatch(spec, /\[major\] LlamaWeb GGUF execution remains unwired/i);
});
