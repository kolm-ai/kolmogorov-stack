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
  ONNX_WEB_RUNTIME,
  normalizeOnnxWebRuntimeConfig,
  runVerifiedOnnxWebModel,
} from '../public/device/onnx-web-runner.js';
import { DEVICE_TARGETS, MODEL_FRAMEWORK_TARGETS } from '../src/platform-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_PATH = path.join(ROOT, 'public', 'device', 'onnx-web-runner.js');
const SPEC_PATH = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(bytes) {
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

async function signedOnnxManifest(weightsBytes, overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = {
    schema: BROWSER_WEIGHT_MANIFEST_SPEC,
    model_id: 'kolm-onnx-web-fixture',
    runtime: ONNX_WEB_RUNTIME,
    weights_url: './model.onnx',
    weights_sha256: await sha256Hex(weightsBytes),
    runtime_config: {
      input_name: 'features',
      input_shape: [1, 3],
      dtype: 'float32',
      execution_providers: ['webgpu'],
      output_names: ['logits'],
      require_webgpu: false,
    },
    input: [1, 2, 3],
    output_labels: ['reject', 'accept'],
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

function fakeOrt(record = {}) {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    Tensor,
    env: { wasm: {} },
    InferenceSession: {
      async create(modelBytes, sessionOptions) {
        record.modelByteLength = modelBytes.byteLength;
        record.sessionOptions = sessionOptions;
        return {
          inputNames: ['features'],
          async run(feeds, fetches) {
            record.feeds = feeds;
            record.fetches = fetches;
            return {
              logits: new Tensor('float32', new Float32Array([0.15, 0.85]), [1, 2]),
            };
          },
        };
      },
    },
  };
}

test('W996 signed manifest covers ONNX-Web runtime config', () => {
  assert.ok(BROWSER_WEIGHT_SIGNED_FIELDS.includes('runtime_config'));
  const cfg = normalizeOnnxWebRuntimeConfig({
    runtime_config: {
      input_name: 'x',
      input_shape: [1, 2],
      dtype: 'float32',
      execution_providers: ['webgpu'],
      require_webgpu: false,
    },
  });
  assert.equal(cfg.inputName, 'x');
  assert.deepEqual(cfg.executionProviders, ['webgpu']);
  assert.equal(cfg.requireWebGpu, false);
});

test('W996 runVerifiedOnnxWebModel verifies signed ONNX bytes before session creation', async () => {
  const weights = Buffer.from('pretend-onnx-model-bytes');
  const manifest = await signedOnnxManifest(weights);
  const record = {};
  const result = await runVerifiedOnnxWebModel({
    manifest,
    weightsBytes: weights,
    ort: fakeOrt(record),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.runtime, ONNX_WEB_RUNTIME);
  assert.deepEqual(result.execution_providers, ['webgpu']);
  assert.equal(result.input_name, 'features');
  assert.equal(record.modelByteLength, weights.length);
  assert.deepEqual(record.sessionOptions.executionProviders, ['webgpu']);
  assert.equal(record.feeds.features.type, 'float32');
  assert.deepEqual(Array.from(record.feeds.features.data), [1, 2, 3]);
  assert.deepEqual(record.feeds.features.dims, [1, 3]);
  assert.deepEqual(record.fetches, ['logits']);
  assert.deepEqual(result.output.logits.data, [0.15000000596046448, 0.8500000238418579]);
  assert.ok(result.checks.some((row) => row.name === 'Ed25519 manifest signature valid' && row.ok));
});

test('W996 ONNX-Web runner refuses unsigned runtime-config tampering before ORT runs', async () => {
  const weights = Buffer.from('pretend-onnx-model-bytes');
  const manifest = await signedOnnxManifest(weights);
  const tampered = {
    ...manifest,
    runtime_config: {
      ...manifest.runtime_config,
      input_name: 'attacker_input',
    },
  };
  const record = {};
  const result = await runVerifiedOnnxWebModel({
    manifest: tampered,
    weightsBytes: weights,
    ort: fakeOrt(record),
    skipWebGpuAvailabilityCheck: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'verify');
  assert.match(result.reason, /signature/i);
  assert.equal(record.modelByteLength, undefined, 'ORT session must not be created after manifest tampering');
});

test('W996 ONNX-Web runner has no implicit CDN/runtime auto-fetch path', async () => {
  const weights = Buffer.from('pretend-onnx-model-bytes');
  const manifest = await signedOnnxManifest(weights);
  await assert.rejects(
    () => runVerifiedOnnxWebModel({
      manifest,
      weightsBytes: weights,
      skipWebGpuAvailabilityCheck: true,
    }),
    /onnxruntime-web unavailable/,
  );
  const tamperedImport = await runVerifiedOnnxWebModel({
    manifest: {
      ...manifest,
      runtime_config: {
        ...manifest.runtime_config,
        ort_import_url: 'https://cdn.example.invalid/ort.js',
      },
    },
    weightsBytes: weights,
    skipWebGpuAvailabilityCheck: true,
  });
  assert.equal(tamperedImport.ok, false);
  assert.match(tamperedImport.reason, /signature/i);

  const signedImportManifest = await signedOnnxManifest(weights, {
    runtime_config: {
      ...manifest.runtime_config,
      ort_import_url: 'https://cdn.example.invalid/ort.js',
    },
  });
  await assert.rejects(
    () => runVerifiedOnnxWebModel({
      manifest: signedImportManifest,
      weightsBytes: weights,
      skipWebGpuAvailabilityCheck: true,
    }),
    /allowRuntimeImport:true/,
  );
});

test('W996 platform evidence and stack spec record ONNX-Web closure honestly', () => {
  assert.ok(fs.existsSync(RUNNER_PATH));
  const browser = DEVICE_TARGETS.find((target) => target.id === 'browser-webgpu');
  const framework = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'wasm-webgpu');
  assert.ok(browser);
  assert.ok(framework);
  assert.ok(browser.runtimes.includes('onnxruntime-web'));
  assert.ok(browser.evidence.includes('public/device/onnx-web-runner.js'));
  assert.ok(framework.evidence.includes('public/device/onnx-web-runner.js'));
  const source = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.match(source, /no default CDN import/i);
  assert.doesNotMatch(source, /unpkg\.com|jsdelivr|cdn\.jsdelivr|cdn\.skypack/i);
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /CLOSED W996: wire signed ONNX-Web browser runner/);
  assert.match(spec, /Production WebLLM MLC and LlamaWeb execution is still not wired|remaining gap is production WebLLM\/LlamaWeb engine execution/i);
});
