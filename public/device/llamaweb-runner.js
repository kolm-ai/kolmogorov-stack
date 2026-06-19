// Browser LlamaWeb/GGUF signed-artifact runner.
//
// The contract is intentionally fail-closed: verify the signed manifest and
// exact GGUF bytes first, then load those bytes through an explicit browser
// LlamaWeb bridge. There is no default CDN import and no unsigned model fetch.

import {
  BROWSER_WEIGHT_MANIFEST_SPEC,
  verifyWeightManifest,
} from './webgpu-runner.js';

export const LLAMAWEB_RUNTIME = 'llama.cpp-webgpu';
export const LLAMAWEB_ACCEPTED_RUNTIMES = Object.freeze(['llama.cpp-webgpu', 'llamaweb', 'llama-web']);
export const LLAMAWEB_DEFAULT_MAX_OUTPUT_CHARS = 16_000;
export const LLAMAWEB_DEFAULT_MAX_TOKENS = 256;

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
    throw kolmError('KOLM_E_LLAMAWEB_RUNTIME', `${field} must be a positive integer`);
  }
  return Math.min(max, Math.trunc(n));
}

function finiteNumber(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw kolmError('KOLM_E_LLAMAWEB_RUNTIME', `${field} must be finite`);
  }
  return n;
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw kolmError('KOLM_E_LLAMAWEB_RUNTIME', 'LlamaWeb weightsBytes must be an ArrayBuffer or Uint8Array');
}

function webGpuAvailable() {
  return !!(globalThis.navigator && globalThis.navigator.gpu);
}

function normalizePrompt(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.prompt === 'string') return input.prompt;
  if (input && Array.isArray(input.messages)) {
    const last = [...input.messages].reverse().find((msg) => msg && typeof msg.content === 'string');
    if (last) return last.content;
  }
  return '';
}

function normalizeImportUrl(opts, cfg) {
  return opts.llamawebImportUrl
    || opts.llamaWebImportUrl
    || cfg.llamaweb_import_url
    || cfg.llamaWebImportUrl
    || cfg.llamawebImportUrl
    || null;
}

export function normalizeLlamaWebRuntimeConfig(manifest = {}, opts = {}) {
  const runtimeCfg = asObject(manifest.runtime_config);
  const modelId = String(
    opts.modelId
      || opts.model_id
      || runtimeCfg.model_id
      || runtimeCfg.modelId
      || manifest.model_id
      || '',
  ).trim();
  if (!modelId) throw kolmError('KOLM_E_LLAMAWEB_MANIFEST', 'LlamaWeb manifest must provide model_id');

  const prompt = String(opts.prompt ?? normalizePrompt(opts.input ?? manifest.input)).trim();
  if (!prompt) throw kolmError('KOLM_E_LLAMAWEB_INPUT', 'LlamaWeb runner requires a non-empty prompt');
  const cacheMode = String(opts.cacheMode || runtimeCfg.cache_mode || runtimeCfg.cacheMode || 'indexeddb').trim();
  const cacheName = opts.cacheName || runtimeCfg.cache_name || runtimeCfg.cacheName || null;
  const requireWebGpu = opts.requireWebGpu ?? runtimeCfg.require_webgpu ?? runtimeCfg.requireWebGpu ?? true;
  const stream = opts.stream ?? runtimeCfg.stream ?? false;

  return {
    modelId,
    prompt,
    cacheMode,
    cacheName,
    requireWebGpu: !!requireWebGpu,
    stream: !!stream,
    maxTokens: positiveInt(
      opts.maxTokens ?? opts.max_tokens ?? runtimeCfg.max_tokens ?? runtimeCfg.maxTokens,
      LLAMAWEB_DEFAULT_MAX_TOKENS,
      'maxTokens',
      32_768,
    ),
    maxOutputChars: positiveInt(
      opts.maxOutputChars ?? opts.max_output_chars ?? runtimeCfg.max_output_chars ?? runtimeCfg.maxOutputChars,
      LLAMAWEB_DEFAULT_MAX_OUTPUT_CHARS,
      'maxOutputChars',
      1_000_000,
    ),
    contextSize: positiveInt(
      opts.contextSize ?? opts.n_ctx ?? runtimeCfg.context_size ?? runtimeCfg.contextSize ?? runtimeCfg.n_ctx,
      4096,
      'contextSize',
      1_048_576,
    ),
    gpuLayers: positiveInt(
      opts.gpuLayers ?? opts.n_gpu_layers ?? runtimeCfg.gpu_layers ?? runtimeCfg.gpuLayers ?? runtimeCfg.n_gpu_layers,
      999,
      'gpuLayers',
      4096,
    ),
    temperature: finiteNumber(opts.temperature ?? runtimeCfg.temperature, 0, 'temperature'),
    topP: finiteNumber(opts.topP ?? opts.top_p ?? runtimeCfg.top_p ?? runtimeCfg.topP, 1, 'topP'),
    chatTemplate: opts.chatTemplate || runtimeCfg.chat_template || runtimeCfg.chatTemplate || null,
    engineConfig: { ...asObject(runtimeCfg.engine_config), ...asObject(runtimeCfg.engineConfig), ...asObject(opts.engineConfig) },
    llamawebImportUrl: normalizeImportUrl(opts, runtimeCfg),
  };
}

export async function loadLlamaWebRuntime(opts = {}, manifest = {}) {
  if (opts.llamaweb) return opts.llamaweb;
  if (opts.llamaWeb) return opts.llamaWeb;
  if (typeof opts.loadLlamaWeb === 'function') {
    const loaded = await opts.loadLlamaWeb();
    if (loaded) return loaded;
  }
  if (globalThis.llamaweb) return globalThis.llamaweb;
  if (globalThis.LlamaWeb) return globalThis.LlamaWeb;
  const cfg = asObject(manifest.runtime_config);
  const importUrl = normalizeImportUrl(opts, cfg);
  if (importUrl) {
    if (opts.allowRuntimeImport !== true) {
      throw kolmError(
        'KOLM_E_LLAMAWEB_RUNTIME_IMPORT_BLOCKED',
        'explicit llamawebImportUrl requires allowRuntimeImport:true; no default CDN runtime is fetched',
      );
    }
    const mod = await import(importUrl);
    return mod.default || mod;
  }
  throw kolmError(
    'KOLM_E_LLAMAWEB_RUNTIME_MISSING',
    'LlamaWeb unavailable; pass opts.llamaweb, opts.loadLlamaWeb, globalThis.llamaweb, or an explicit llamawebImportUrl with allowRuntimeImport:true',
  );
}

function engineOptions(cfg) {
  return {
    model_id: cfg.modelId,
    n_ctx: cfg.contextSize,
    n_gpu_layers: cfg.gpuLayers,
    cache_mode: cfg.cacheMode,
    cache_name: cfg.cacheName,
    chat_template: cfg.chatTemplate,
    ...cfg.engineConfig,
  };
}

export async function createLlamaWebEngine(runtime, cfg, opts = {}) {
  if (opts.engine) return opts.engine;
  if (typeof opts.createEngine === 'function') {
    return opts.createEngine({ runtime, config: cfg });
  }
  if (runtime && typeof runtime.createLlamaEngine === 'function') {
    return runtime.createLlamaEngine(engineOptions(cfg));
  }
  if (runtime && typeof runtime.createEngine === 'function') {
    return runtime.createEngine(engineOptions(cfg));
  }
  if (runtime && typeof runtime.LlamaWebEngine === 'function') {
    const engine = new runtime.LlamaWebEngine(engineOptions(cfg));
    if (typeof engine.init === 'function') await engine.init(engineOptions(cfg));
    return engine;
  }
  if (typeof runtime === 'function') {
    return new runtime(engineOptions(cfg));
  }
  throw kolmError(
    'KOLM_E_LLAMAWEB_ENGINE',
    'LlamaWeb runtime does not expose createLlamaEngine, createEngine, LlamaWebEngine, or a constructor',
  );
}

async function callModelBytesLoader(fn, engine, weightsBytes, manifest, cfg, verified) {
  await fn({
    engine,
    weightsBytes: asUint8Array(weightsBytes),
    manifest,
    config: cfg,
    modelId: cfg.modelId,
    weightsSha256: verified.weights_sha256,
  });
}

export async function loadSignedLlamaWebModelBytes(engine, weightsBytes, manifest, cfg, opts = {}, verified = {}) {
  if (typeof opts.loadModelBytes === 'function') {
    await callModelBytesLoader(opts.loadModelBytes, engine, weightsBytes, manifest, cfg, verified);
    return { method: 'opts.loadModelBytes' };
  }
  const loaders = [
    ['loadGgufBytes', engine && engine.loadGgufBytes],
    ['loadGGUFBytes', engine && engine.loadGGUFBytes],
    ['loadModelFromBytes', engine && engine.loadModelFromBytes],
    ['loadModelBytes', engine && engine.loadModelBytes],
    ['registerModelBytes', engine && engine.registerModelBytes],
  ];
  for (const [name, fn] of loaders) {
    if (typeof fn === 'function') {
      await fn.call(engine, asUint8Array(weightsBytes), {
        manifest,
        model_id: cfg.modelId,
        weights_sha256: verified.weights_sha256,
        cache_mode: cfg.cacheMode,
        cache_name: cfg.cacheName,
      });
      return { method: `engine.${name}` };
    }
  }
  throw kolmError(
    'KOLM_E_LLAMAWEB_BYTES_REQUIRED',
    'LlamaWeb runner requires an explicit signed-byte loader bridge; unsigned engine-managed fetch is refused',
  );
}

function capOutputText(text, maxOutputChars) {
  const s = String(text ?? '');
  if (s.length <= maxOutputChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxOutputChars), truncated: true };
}

function parseLlamaWebResponse(response) {
  if (typeof response === 'string') return { text: response, raw: response, usage: null };
  const choice = response?.choices?.[0];
  const text = choice?.message?.content
    ?? choice?.text
    ?? response?.text
    ?? response?.content
    ?? response?.message
    ?? '';
  return { text, raw: response, usage: response?.usage || null };
}

function estimateGeneratedTokens(text, usage) {
  const usageTokens = usage?.completion_tokens ?? usage?.completionTokens ?? usage?.generated_tokens ?? usage?.generatedTokens;
  if (Number.isFinite(Number(usageTokens)) && Number(usageTokens) >= 0) return Number(usageTokens);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words * 1.33)) : 0;
}

async function collectAsyncTokens(iterable, onToken) {
  let text = '';
  let firstTokenMs = null;
  const started = nowMs();
  for await (const chunk of iterable) {
    const token = typeof chunk === 'string'
      ? chunk
      : chunk?.token ?? chunk?.text ?? chunk?.choices?.[0]?.delta?.content ?? '';
    if (!token) continue;
    if (firstTokenMs == null) firstTokenMs = Math.max(0, Math.round(nowMs() - started));
    text += token;
    if (typeof onToken === 'function') onToken(token);
  }
  return { text, usage: firstTokenMs == null ? null : { ttft_ms: firstTokenMs } };
}

export async function runLlamaWebGeneration(engine, cfg, opts = {}) {
  const generationOptions = {
    prompt: cfg.prompt,
    n_predict: cfg.maxTokens,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    top_p: cfg.topP,
    stream: cfg.stream,
  };
  if ((cfg.stream || typeof opts.onToken === 'function') && typeof engine?.generateStream === 'function') {
    return collectAsyncTokens(engine.generateStream(cfg.prompt, generationOptions), opts.onToken);
  }
  if (typeof engine?.createCompletion === 'function') {
    return parseLlamaWebResponse(await engine.createCompletion(generationOptions));
  }
  if (typeof engine?.complete === 'function') {
    return parseLlamaWebResponse(await engine.complete(cfg.prompt, generationOptions));
  }
  if (typeof engine?.generate === 'function') {
    return parseLlamaWebResponse(await engine.generate(cfg.prompt, generationOptions));
  }
  if (typeof engine?.chat === 'function') {
    return parseLlamaWebResponse(await engine.chat([{ role: 'user', content: cfg.prompt }], generationOptions));
  }
  throw kolmError(
    'KOLM_E_LLAMAWEB_ENGINE',
    'LlamaWeb engine does not expose generateStream, createCompletion, complete, generate, or chat',
  );
}

async function fetchJsonAndBytes(manifestUrl, fetchImpl) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') throw kolmError('KOLM_E_LLAMAWEB_FETCH', 'fetch unavailable');
  const manifestResponse = await fetcher(manifestUrl);
  if (!manifestResponse.ok) throw kolmError('KOLM_E_LLAMAWEB_FETCH', `manifest fetch failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const base = globalThis.location ? location.href : 'http://localhost/';
  const weightUrl = new URL(manifest.weights_url, new URL(manifestUrl, base)).toString();
  const weightsResponse = await fetcher(weightUrl);
  if (!weightsResponse.ok) throw kolmError('KOLM_E_LLAMAWEB_FETCH', `weights fetch failed: ${weightsResponse.status}`);
  return { manifest, weightsBytes: new Uint8Array(await weightsResponse.arrayBuffer()) };
}

function validateLlamaWebManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw kolmError('KOLM_E_LLAMAWEB_MANIFEST', 'LlamaWeb manifest must be an object');
  }
  if (manifest.schema !== BROWSER_WEIGHT_MANIFEST_SPEC) {
    throw kolmError('KOLM_E_LLAMAWEB_MANIFEST', `unexpected manifest schema: ${manifest.schema || '<missing>'}`);
  }
  if (!LLAMAWEB_ACCEPTED_RUNTIMES.includes(String(manifest.runtime || ''))) {
    throw kolmError('KOLM_E_LLAMAWEB_MANIFEST', `LlamaWeb runner refuses runtime=${manifest.runtime || '<missing>'}`);
  }
}

export async function runVerifiedLlamaWebModel({
  manifestUrl = null,
  manifest = null,
  weightsBytes = null,
  input = null,
  fetchImpl = null,
  ...opts
} = {}) {
  if (!manifest || !weightsBytes) {
    if (!manifestUrl) throw kolmError('KOLM_E_LLAMAWEB_MANIFEST', 'manifestUrl is required when manifest or weightsBytes are omitted');
    const loaded = await fetchJsonAndBytes(manifestUrl, fetchImpl);
    manifest = loaded.manifest;
    weightsBytes = loaded.weightsBytes;
  }

  const verified = await verifyWeightManifest(manifest, weightsBytes, opts);
  if (!verified.ok) return { ok: false, stage: 'verify', ...verified };
  validateLlamaWebManifest(manifest);

  const cfg = normalizeLlamaWebRuntimeConfig({ ...manifest, input: input ?? manifest.input }, opts);
  if (cfg.requireWebGpu && !webGpuAvailable() && opts.skipWebGpuAvailabilityCheck !== true) {
    throw kolmError('KOLM_E_LLAMAWEB_WEBGPU_UNAVAILABLE', 'WebGPU unavailable; refusing signed LlamaWeb run without explicit fallback');
  }

  const runtime = await loadLlamaWebRuntime(opts, manifest);
  const loadStart = nowMs();
  const engine = await createLlamaWebEngine(runtime, cfg, opts);
  const byteLoad = await loadSignedLlamaWebModelBytes(engine, weightsBytes, manifest, cfg, opts, verified);
  const loadMs = Math.max(0, Math.round(nowMs() - loadStart));

  const runStart = nowMs();
  const generation = await runLlamaWebGeneration(engine, cfg, opts);
  const runMs = Math.max(0, Math.round(nowMs() - runStart));
  const capped = capOutputText(generation.text, cfg.maxOutputChars);
  const generatedTokens = estimateGeneratedTokens(capped.text, generation.usage);
  const tokS = generatedTokens > 0 && runMs > 0
    ? Number((generatedTokens / (runMs / 1000)).toFixed(3))
    : null;

  return {
    ok: true,
    stage: 'run',
    model_id: manifest.model_id,
    runtime: LLAMAWEB_RUNTIME,
    weights_sha256: verified.weights_sha256,
    output_text: capped.text,
    output_truncated: capped.truncated,
    usage: generation.usage,
    timings_ms: { load: loadMs, run: runMs },
    runtime_passport: {
      schema: 'kolm.browser_runtime_passport.v1',
      runtime: LLAMAWEB_RUNTIME,
      model_id: cfg.modelId,
      weights_sha256: verified.weights_sha256,
      sig_ok: true,
      cache_mode: cfg.cacheMode,
      cache_name: cfg.cacheName,
      webgpu_required: cfg.requireWebGpu,
      byte_load_method: byteLoad.method,
      streaming_requested: cfg.stream || typeof opts.onToken === 'function',
      tokens_generated: generatedTokens,
      tok_s: tokS,
      ttft_ms: generation.usage?.ttft_ms ?? generation.usage?.ttftMs ?? null,
    },
    checks: verified.checks,
  };
}

if (typeof window !== 'undefined') {
  window.kolmLlamaWebRunner = {
    runVerifiedLlamaWebModel,
    normalizeLlamaWebRuntimeConfig,
    loadLlamaWebRuntime,
    createLlamaWebEngine,
    loadSignedLlamaWebModelBytes,
    runLlamaWebGeneration,
  };
}
