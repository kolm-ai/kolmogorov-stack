// Browser ONNX-Web signed-artifact runner.
//
// The security contract mirrors webgpu-runner.js: load the signed manifest,
// hash exact model bytes, verify Ed25519 over the manifest, and only then hand
// bytes to onnxruntime-web. This module intentionally has no default CDN import
// path; callers must provide an ORT object, a loader, globalThis.ort, or an
// explicit import URL with allowRuntimeImport:true.

import {
  BROWSER_WEIGHT_MANIFEST_SPEC,
  verifyWeightManifest,
} from './webgpu-runner.js';

export const ONNX_WEB_RUNTIME = 'onnxruntime-web';
export const ONNX_WEB_ACCEPTED_RUNTIMES = Object.freeze(['onnxruntime-web', 'onnx-web']);
export const ONNX_WEB_DEFAULT_MAX_OUTPUT_ELEMENTS = 1_000_000;

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function nowMs() {
  return globalThis.performance && typeof globalThis.performance.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function positiveInt(value, fallback, field, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', `${field} must be a positive integer`);
  }
  return Math.min(max, Math.trunc(n));
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'ONNX-Web weightsBytes must be an ArrayBuffer or Uint8Array');
}

function exactArrayBuffer(bytes) {
  const u8 = asUint8Array(bytes);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function normalizeDtype(dtype) {
  const d = String(dtype || 'float32').toLowerCase();
  if (d === 'float32' || d === 'int64' || d === 'string' || d === 'bool') return d;
  throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', `unsupported ONNX-Web input dtype ${JSON.stringify(dtype)}`);
}

function normalizeNumericInput(input) {
  if (Array.isArray(input)) return input;
  if (ArrayBuffer.isView(input)) return Array.from(input);
  if (typeof input === 'number' || typeof input === 'bigint' || typeof input === 'boolean') return [input];
  if (input && input.data != null) return Array.from(input.data);
  return [];
}

function normalizeShape(shape, dataLen) {
  const dims = shape == null ? [1, dataLen] : shape;
  if (!Array.isArray(dims) || dims.length < 1 || dims.length > 8) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'ONNX-Web tensor shape must be an array with 1-8 dimensions');
  }
  const out = dims.map((x) => Number(x));
  if (out.some((x) => !Number.isInteger(x) || x < 1)) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', `ONNX-Web tensor shape must contain positive integer dimensions (got ${JSON.stringify(dims)})`);
  }
  const product = out.reduce((a, b) => a * b, 1);
  if (product !== dataLen) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', `ONNX-Web tensor shape ${JSON.stringify(out)} expects ${product} values, got ${dataLen}`);
  }
  return out;
}

function normalizeStringArray(value, fallback = []) {
  if (value == null) return fallback.slice();
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((x) => String(x || '').trim()).filter(Boolean);
}

function webGpuAvailable() {
  return !!(globalThis.navigator && globalThis.navigator.gpu);
}

export function normalizeOnnxWebRuntimeConfig(manifest = {}, opts = {}) {
  const cfg = manifest.runtime_config && typeof manifest.runtime_config === 'object'
    ? manifest.runtime_config
    : {};
  const requireWebGpu = opts.requireWebGpu ?? cfg.require_webgpu ?? true;
  const allowWasmFallback = opts.allowWasmFallback ?? cfg.allow_wasm_fallback ?? false;
  const explicitProviders = opts.executionProviders ?? cfg.execution_providers;
  let executionProviders = normalizeStringArray(explicitProviders);
  if (!executionProviders.length) {
    executionProviders = allowWasmFallback ? ['webgpu', 'wasm'] : ['webgpu'];
  }
  if (requireWebGpu && !executionProviders.includes('webgpu')) {
    throw kolmError('KOLM_E_ONNX_WEB_WEBGPU_REQUIRED', 'ONNX-Web signed runner requires the WebGPU execution provider');
  }
  return {
    inputName: opts.inputName
      || cfg.input_name
      || cfg.inputName
      || manifest.entrypoint?.input_schema?.name
      || null,
    dtype: normalizeDtype(opts.dtype || cfg.dtype || manifest.entrypoint?.input_schema?.dtype || 'float32'),
    shape: opts.shape || cfg.input_shape || cfg.shape || manifest.entrypoint?.input_schema?.shape || null,
    outputNames: normalizeStringArray(opts.outputNames || cfg.output_names || cfg.outputNames),
    executionProviders,
    requireWebGpu: !!requireWebGpu,
    allowWasmFallback: !!allowWasmFallback,
    maxOutputElements: positiveInt(
      opts.maxOutputElements ?? cfg.max_output_elements,
      ONNX_WEB_DEFAULT_MAX_OUTPUT_ELEMENTS,
      'maxOutputElements',
    ),
    wasmPaths: opts.wasmPaths || cfg.wasm_paths || cfg.wasmPaths || null,
    graphOptimizationLevel: opts.graphOptimizationLevel || cfg.graph_optimization_level || cfg.graphOptimizationLevel || 'all',
    freeDimensionOverrides: opts.freeDimensionOverrides || cfg.free_dimension_overrides || cfg.freeDimensionOverrides || null,
  };
}

export async function loadOnnxRuntimeWeb(opts = {}, manifest = {}) {
  if (opts.ort) return opts.ort;
  if (typeof opts.loadOrt === 'function') {
    const ort = await opts.loadOrt();
    if (ort) return ort;
  }
  if (globalThis.ort) return globalThis.ort;
  const cfg = manifest.runtime_config && typeof manifest.runtime_config === 'object' ? manifest.runtime_config : {};
  const importUrl = opts.ortImportUrl || cfg.ort_import_url || cfg.ortImportUrl;
  if (importUrl) {
    if (opts.allowRuntimeImport !== true) {
      throw kolmError(
        'KOLM_E_ONNX_WEB_RUNTIME_IMPORT_BLOCKED',
        'explicit ortImportUrl requires allowRuntimeImport:true; no default CDN runtime is fetched',
      );
    }
    const mod = await import(importUrl);
    return mod.default || mod;
  }
  throw kolmError(
    'KOLM_E_ONNX_WEB_RUNTIME_MISSING',
    'onnxruntime-web unavailable; pass opts.ort, opts.loadOrt, globalThis.ort, or an explicit ortImportUrl with allowRuntimeImport:true',
  );
}

function configureOrtEnv(ort, cfg) {
  if (!cfg.wasmPaths) return;
  if (!ort.env) ort.env = {};
  if (!ort.env.wasm) ort.env.wasm = {};
  ort.env.wasm.wasmPaths = cfg.wasmPaths;
}

export function buildOnnxWebTensor(ort, dtype, input, shape) {
  if (!ort || typeof ort.Tensor !== 'function') {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'onnxruntime-web Tensor constructor is unavailable');
  }
  if (dtype === 'string') {
    const s = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    return new ort.Tensor('string', [s], [1]);
  }
  const arr = normalizeNumericInput(input);
  if (!arr.length) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'ONNX-Web numeric input requires a non-empty array, typed array, or scalar');
  }
  const dims = normalizeShape(shape, arr.length);
  if (dtype === 'int64') {
    let data;
    try { data = new BigInt64Array(arr.map((x) => BigInt(x))); }
    catch (e) { throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', `ONNX-Web int64 input contains a non-integer value: ${e.message}`); }
    return new ort.Tensor('int64', data, dims);
  }
  if (dtype === 'bool') {
    return new ort.Tensor('bool', arr.map(Boolean), dims);
  }
  const nums = arr.map((x) => Number(x));
  if (nums.some((x) => !Number.isFinite(x))) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'ONNX-Web float32 input contains a non-finite value');
  }
  return new ort.Tensor('float32', new Float32Array(nums), dims);
}

export function plainOnnxWebTensor(v, maxOutputElements = ONNX_WEB_DEFAULT_MAX_OUTPUT_ELEMENTS) {
  const dataLen = v && v.data && typeof v.data.length === 'number' ? v.data.length : 0;
  if (dataLen > maxOutputElements) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', `ONNX-Web output tensor too large: ${dataLen} elements exceeds cap ${maxOutputElements}`);
  }
  return {
    dims: Array.isArray(v?.dims) ? v.dims.slice() : [],
    type: v?.type || null,
    data: Array.from(v?.data || []).map((x) => (typeof x === 'bigint' ? x.toString() : x)),
  };
}

async function fetchJsonAndBytes(manifestUrl, fetchImpl) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') throw kolmError('KOLM_E_ONNX_WEB_FETCH', 'fetch unavailable');
  const manifestResponse = await fetcher(manifestUrl);
  if (!manifestResponse.ok) throw kolmError('KOLM_E_ONNX_WEB_FETCH', `manifest fetch failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const base = globalThis.location ? location.href : 'http://localhost/';
  const weightUrl = new URL(manifest.weights_url, new URL(manifestUrl, base)).toString();
  const weightsResponse = await fetcher(weightUrl);
  if (!weightsResponse.ok) throw kolmError('KOLM_E_ONNX_WEB_FETCH', `weights fetch failed: ${weightsResponse.status}`);
  return { manifest, weightsBytes: new Uint8Array(await weightsResponse.arrayBuffer()) };
}

function validateOnnxWebManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw kolmError('KOLM_E_ONNX_WEB_MANIFEST', 'ONNX-Web manifest must be an object');
  }
  if (manifest.schema !== BROWSER_WEIGHT_MANIFEST_SPEC) {
    throw kolmError('KOLM_E_ONNX_WEB_MANIFEST', `unexpected manifest schema: ${manifest.schema || '<missing>'}`);
  }
  if (!ONNX_WEB_ACCEPTED_RUNTIMES.includes(String(manifest.runtime || ''))) {
    throw kolmError('KOLM_E_ONNX_WEB_MANIFEST', `ONNX-Web runner refuses runtime=${manifest.runtime || '<missing>'}`);
  }
}

export async function runVerifiedOnnxWebModel({
  manifestUrl = null,
  manifest = null,
  weightsBytes = null,
  input = null,
  fetchImpl = null,
  ...opts
} = {}) {
  if (!manifest || !weightsBytes) {
    if (!manifestUrl) throw kolmError('KOLM_E_ONNX_WEB_MANIFEST', 'manifestUrl is required when manifest or weightsBytes are omitted');
    const loaded = await fetchJsonAndBytes(manifestUrl, fetchImpl);
    manifest = loaded.manifest;
    weightsBytes = loaded.weightsBytes;
  }

  const verified = await verifyWeightManifest(manifest, weightsBytes, opts);
  if (!verified.ok) return { ok: false, stage: 'verify', ...verified };
  validateOnnxWebManifest(manifest);

  const cfg = normalizeOnnxWebRuntimeConfig(manifest, opts);
  if (cfg.requireWebGpu && !webGpuAvailable() && opts.skipWebGpuAvailabilityCheck !== true) {
    throw kolmError('KOLM_E_ONNX_WEB_WEBGPU_UNAVAILABLE', 'WebGPU unavailable; refusing signed ONNX-Web run without explicit fallback');
  }

  const ort = await loadOnnxRuntimeWeb(opts, manifest);
  configureOrtEnv(ort, cfg);
  if (!ort?.InferenceSession || typeof ort.InferenceSession.create !== 'function') {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'onnxruntime-web InferenceSession.create is unavailable');
  }

  const sessionOptions = {
    executionProviders: cfg.executionProviders.slice(),
    graphOptimizationLevel: cfg.graphOptimizationLevel,
    ...(cfg.freeDimensionOverrides ? { freeDimensionOverrides: cfg.freeDimensionOverrides } : {}),
  };
  const loadStart = nowMs();
  const session = await ort.InferenceSession.create(exactArrayBuffer(weightsBytes), sessionOptions);
  const loadMs = Math.max(0, Math.round(nowMs() - loadStart));
  const inputName = cfg.inputName || session.inputNames?.[0];
  if (!inputName) {
    throw kolmError('KOLM_E_ONNX_WEB_RUNTIME', 'unable to derive ONNX-Web input name');
  }
  const runInput = input ?? manifest.input;
  const tensor = buildOnnxWebTensor(ort, cfg.dtype, runInput, cfg.shape);
  const feeds = { [inputName]: tensor };
  const runStart = nowMs();
  const rawOutput = cfg.outputNames.length
    ? await session.run(feeds, cfg.outputNames)
    : await session.run(feeds);
  const runMs = Math.max(0, Math.round(nowMs() - runStart));
  const output = {};
  for (const [name, tensorOut] of Object.entries(rawOutput || {})) {
    output[name] = plainOnnxWebTensor(tensorOut, cfg.maxOutputElements);
  }

  return {
    ok: true,
    stage: 'run',
    model_id: manifest.model_id,
    runtime: ONNX_WEB_RUNTIME,
    execution_providers: cfg.executionProviders.slice(),
    weights_sha256: verified.weights_sha256,
    input_name: inputName,
    output,
    timings_ms: { load: loadMs, run: runMs },
    checks: verified.checks,
  };
}

if (typeof window !== 'undefined') {
  window.kolmOnnxWebRunner = {
    runVerifiedOnnxWebModel,
    normalizeOnnxWebRuntimeConfig,
    loadOnnxRuntimeWeb,
    buildOnnxWebTensor,
  };
}
