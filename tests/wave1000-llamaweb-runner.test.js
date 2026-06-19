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
  LLAMAWEB_RUNTIME,
  normalizeLlamaWebRuntimeConfig,
  runVerifiedLlamaWebModel,
} from '../public/device/llamaweb-runner.js';
import { DEVICE_TARGETS, MODEL_FRAMEWORK_TARGETS } from '../src/platform-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_PATH = path.join(ROOT, 'public', 'device', 'llamaweb-runner.js');
const SPEC_PATH = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(bytes) {
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

async function signedLlamaWebManifest(weightsBytes, overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = {
    schema: BROWSER_WEIGHT_MANIFEST_SPEC,
    model_id: 'kolm-llamaweb-fixture-gguf',
    runtime: LLAMAWEB_RUNTIME,
    weights_url: './model.gguf',
    weights_sha256: await sha256Hex(weightsBytes),
    runtime_config: {
      model_id: 'kolm-llamaweb-fixture-gguf',
      require_webgpu: false,
      cache_mode: 'indexeddb',
      cache_name: 'kolm-llamaweb-test-cache',
      n_ctx: 4096,
      n_gpu_layers: 999,
      max_tokens: 16,
      max_output_chars: 1024,
      temperature: 0,
      top_p: 1,
    },
    input: { prompt: 'Say signed GGUF inference.' },
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

function fakeLlamaWeb(record = {}, { byteLoader = true, streaming = false } = {}) {
  record.events = record.events || [];
  return {
    async createLlamaEngine(config) {
      record.events.push('create');
      record.config = config;
      const engine = {
        async generate(prompt, options) {
          record.events.push('generate');
          record.prompt = prompt;
          record.options = options;
          return { text: 'signed LlamaWeb response', usage: { completion_tokens: 4, ttft_ms: 9 } };
        },
      };
      if (streaming) {
        engine.generateStream = async function* generateStream(prompt, options) {
          record.events.push('stream');
          record.prompt = prompt;
          record.options = options;
          yield 'signed ';
          yield 'stream ';
          yield 'response';
        };
      }
      if (byteLoader) {
        engine.loadGgufBytes = async (bytes, info) => {
          record.events.push('load-gguf');
          record.loadedByteLength = bytes.byteLength;
          record.loadInfo = info;
        };
      }
      return engine;
    },
  };
}

test('W1000 signed manifest covers LlamaWeb runtime config and prompt contract', () => {
  assert.ok(BROWSER_WEIGHT_SIGNED_FIELDS.includes('runtime_config'));
  const cfg = normalizeLlamaWebRuntimeConfig({
    model_id: 'outer-model',
    input: { prompt: 'hello' },
    runtime_config: {
      model_id: 'signed-gguf',
      cache_mode: 'indexeddb',
      cache_name: 'kolm-cache',
      require_webgpu: false,
      n_ctx: 8192,
      n_gpu_layers: 128,
      max_tokens: 32,
    },
  });
  assert.equal(cfg.modelId, 'signed-gguf');
  assert.equal(cfg.prompt, 'hello');
  assert.equal(cfg.cacheMode, 'indexeddb');
  assert.equal(cfg.cacheName, 'kolm-cache');
  assert.equal(cfg.contextSize, 8192);
  assert.equal(cfg.gpuLayers, 128);
  assert.equal(cfg.maxTokens, 32);
  assert.equal(cfg.requireWebGpu, false);
});

test('W1000 runVerifiedLlamaWebModel verifies signed GGUF bytes before generation', async () => {
  const weights = Buffer.from('pretend-gguf-model-bytes');
  const manifest = await signedLlamaWebManifest(weights);
  const record = {};
  const result = await runVerifiedLlamaWebModel({
    manifest,
    weightsBytes: weights,
    llamaweb: fakeLlamaWeb(record),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.runtime, LLAMAWEB_RUNTIME);
  assert.equal(result.output_text, 'signed LlamaWeb response');
  assert.deepEqual(record.events, ['create', 'load-gguf', 'generate']);
  assert.equal(record.loadedByteLength, weights.length);
  assert.equal(record.loadInfo.weights_sha256, result.weights_sha256);
  assert.equal(record.config.cache_mode, 'indexeddb');
  assert.equal(record.config.n_ctx, 4096);
  assert.equal(record.config.n_gpu_layers, 999);
  assert.equal(record.prompt, 'Say signed GGUF inference.');
  assert.equal(record.options.max_tokens, 16);
  assert.equal(result.runtime_passport.runtime, LLAMAWEB_RUNTIME);
  assert.equal(result.runtime_passport.sig_ok, true);
  assert.equal(result.runtime_passport.cache_mode, 'indexeddb');
  assert.equal(result.runtime_passport.byte_load_method, 'engine.loadGgufBytes');
  assert.equal(result.runtime_passport.tokens_generated, 4);
  assert.equal(result.runtime_passport.ttft_ms, 9);
  assert.ok(result.checks.some((row) => row.name === 'Ed25519 manifest signature valid' && row.ok));
});

test('W1000 LlamaWeb runner supports streaming token collection after signed-byte load', async () => {
  const weights = Buffer.from('pretend-gguf-model-bytes');
  const manifest = await signedLlamaWebManifest(weights, {
    runtime_config: {
      model_id: 'kolm-llamaweb-fixture-gguf',
      require_webgpu: false,
      cache_mode: 'indexeddb',
      max_tokens: 16,
      stream: true,
    },
  });
  const record = {};
  const tokens = [];
  const result = await runVerifiedLlamaWebModel({
    manifest,
    weightsBytes: weights,
    llamaweb: fakeLlamaWeb(record, { streaming: true }),
    onToken: (token) => tokens.push(token),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(record.events, ['create', 'load-gguf', 'stream']);
  assert.deepEqual(tokens, ['signed ', 'stream ', 'response']);
  assert.equal(result.output_text, 'signed stream response');
  assert.equal(result.runtime_passport.streaming_requested, true);
  assert.equal(typeof result.runtime_passport.ttft_ms, 'number');
});

test('W1000 LlamaWeb runner refuses signed-runtime tampering before engine creation', async () => {
  const weights = Buffer.from('pretend-gguf-model-bytes');
  const manifest = await signedLlamaWebManifest(weights);
  const tampered = {
    ...manifest,
    runtime_config: {
      ...manifest.runtime_config,
      n_ctx: 131072,
    },
  };
  const record = {};
  const result = await runVerifiedLlamaWebModel({
    manifest: tampered,
    weightsBytes: weights,
    llamaweb: fakeLlamaWeb(record),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'verify');
  assert.match(result.reason, /signature/i);
  assert.deepEqual(record.events, [], 'LlamaWeb engine must not be created after manifest tampering');
});

test('W1000 LlamaWeb runner has no implicit CDN/runtime auto-fetch path', async () => {
  const weights = Buffer.from('pretend-gguf-model-bytes');
  const manifest = await signedLlamaWebManifest(weights);
  await assert.rejects(
    () => runVerifiedLlamaWebModel({
      manifest,
      weightsBytes: weights,
      skipWebGpuAvailabilityCheck: true,
    }),
    /LlamaWeb unavailable/,
  );

  const tamperedImport = await runVerifiedLlamaWebModel({
    manifest: {
      ...manifest,
      runtime_config: {
        ...manifest.runtime_config,
        llamaweb_import_url: 'https://cdn.example.invalid/llamaweb.js',
      },
    },
    weightsBytes: weights,
    skipWebGpuAvailabilityCheck: true,
  });
  assert.equal(tamperedImport.ok, false);
  assert.match(tamperedImport.reason, /signature/i);

  const signedImportManifest = await signedLlamaWebManifest(weights, {
    runtime_config: {
      ...manifest.runtime_config,
      llamaweb_import_url: 'https://cdn.example.invalid/llamaweb.js',
    },
  });
  await assert.rejects(
    () => runVerifiedLlamaWebModel({
      manifest: signedImportManifest,
      weightsBytes: weights,
      skipWebGpuAvailabilityCheck: true,
    }),
    /allowRuntimeImport:true/,
  );
});

test('W1000 LlamaWeb runner refuses unsigned engine-managed model fetch', async () => {
  const weights = Buffer.from('pretend-gguf-model-bytes');
  const manifest = await signedLlamaWebManifest(weights);
  const record = {};
  await assert.rejects(
    () => runVerifiedLlamaWebModel({
      manifest,
      weightsBytes: weights,
      llamaweb: fakeLlamaWeb(record, { byteLoader: false }),
      skipWebGpuAvailabilityCheck: true,
    }),
    /signed-byte loader bridge/,
  );
  assert.deepEqual(record.events, ['create']);
});

test('W1000 LlamaWeb runner supports an explicit signed-byte cache bridge', async () => {
  const weights = Buffer.from('pretend-gguf-model-bytes');
  const manifest = await signedLlamaWebManifest(weights);
  const record = {};
  const result = await runVerifiedLlamaWebModel({
    manifest,
    weightsBytes: weights,
    llamaweb: fakeLlamaWeb(record, { byteLoader: false }),
    loadModelBytes: async ({ weightsBytes: loadedBytes, weightsSha256 }) => {
      record.events.push('bridge-load');
      record.bridgeByteLength = loadedBytes.byteLength;
      record.bridgeSha = weightsSha256;
    },
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(record.events, ['create', 'bridge-load', 'generate']);
  assert.equal(record.bridgeByteLength, weights.length);
  assert.equal(record.bridgeSha, result.weights_sha256);
  assert.equal(result.runtime_passport.byte_load_method, 'opts.loadModelBytes');
});

test('W1000 platform evidence and stack spec record signed LlamaWeb closure honestly', () => {
  assert.ok(fs.existsSync(RUNNER_PATH));
  const browser = DEVICE_TARGETS.find((target) => target.id === 'browser-webgpu');
  const framework = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'wasm-webgpu');
  assert.ok(browser);
  assert.ok(framework);
  assert.ok(browser.runtimes.includes(LLAMAWEB_RUNTIME));
  assert.ok(browser.evidence.includes('public/device/llamaweb-runner.js'));
  assert.ok(framework.evidence.includes('public/device/llamaweb-runner.js'));
  const source = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.match(source, /no default CDN import/i);
  assert.match(source, /no unsigned model fetch/i);
  assert.doesNotMatch(source, /unpkg\.com|jsdelivr|cdn\.jsdelivr|cdn\.skypack/i);
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /CLOSED W1000: wire signed LlamaWeb GGUF browser runner/);
  assert.doesNotMatch(spec, /\[major\] LlamaWeb GGUF execution remains unwired/i);
  assert.match(spec, /ondevice-inference .*open=0\/0\/1|LlamaWeb GGUF execution now has a signed runner/i);
});
