// Browser WebLLM signed-artifact runner.
//
// This module mirrors the browser ONNX/WebGPU contract: verify the signed
// manifest and exact model bytes first, then hand those bytes to an explicit
// WebLLM/MLC engine bridge. There is no default CDN import and no unsigned
// engine-managed model fetch path.

import {
  BROWSER_WEIGHT_MANIFEST_SPEC,
  verifyWeightManifest,
} from './webgpu-runner.js';

export const WEBLLM_RUNTIME = 'webllm';
export const WEBLLM_ACCEPTED_RUNTIMES = Object.freeze(['webllm', 'mlc-webllm', 'mlc']);
export const WEBLLM_DEFAULT_MAX_OUTPUT_CHARS = 16_000;
export const WEBLLM_DEFAULT_MAX_TOKENS = 256;

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
    throw kolmError('KOLM_E_WEBLLM_RUNTIME', `${field} must be a positive integer`);
  }
  return Math.min(max, Math.trunc(n));
}

function finiteNumber(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw kolmError('KOLM_E_WEBLLM_RUNTIME', `${field} must be finite`);
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
  throw kolmError('KOLM_E_WEBLLM_RUNTIME', 'WebLLM weightsBytes must be an ArrayBuffer or Uint8Array');
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

function normalizeMessages(manifest, opts) {
  if (Array.isArray(opts.messages) && opts.messages.length) return opts.messages;
  const input = opts.input ?? manifest.input;
  if (input && Array.isArray(input.messages) && input.messages.length) return input.messages;
  const prompt = opts.prompt ?? normalizePrompt(input);
  if (!prompt || !String(prompt).trim()) {
    throw kolmError('KOLM_E_WEBLLM_INPUT', 'WebLLM runner requires a non-empty prompt or messages array');
  }
  return [{ role: 'user', content: String(prompt) }];
}

function normalizeImportUrl(opts, cfg) {
  return opts.webllmImportUrl
    || cfg.webllm_import_url
    || cfg.webllmImportUrl
    || null;
}

function mergeAppConfig(cfg, runtimeCfg) {
  const appConfig = { ...asObject(runtimeCfg.app_config), ...asObject(runtimeCfg.appConfig) };
  if (cfg.cacheMode) appConfig.cache_mode = cfg.cacheMode;
  if (cfg.cacheName) appConfig.cache_name = cfg.cacheName;
  if (cfg.modelLibUrl) appConfig.model_lib_url = cfg.modelLibUrl;
  return appConfig;
}

export function normalizeWebLlmRuntimeConfig(manifest = {}, opts = {}) {
  const runtimeCfg = asObject(manifest.runtime_config);
  const modelId = String(
    opts.modelId
      || opts.model_id
      || runtimeCfg.model_id
      || runtimeCfg.modelId
      || manifest.model_id
      || '',
  ).trim();
  if (!modelId) throw kolmError('KOLM_E_WEBLLM_MANIFEST', 'WebLLM manifest must provide model_id');

  const cacheMode = String(opts.cacheMode || runtimeCfg.cache_mode || runtimeCfg.cacheMode || 'indexeddb').trim();
  const cacheName = opts.cacheName || runtimeCfg.cache_name || runtimeCfg.cacheName || null;
  const modelLibUrl = opts.modelLibUrl || runtimeCfg.model_lib_url || runtimeCfg.modelLibUrl || null;
  const requireWebGpu = opts.requireWebGpu ?? runtimeCfg.require_webgpu ?? runtimeCfg.requireWebGpu ?? true;
  const maxTokens = positiveInt(
    opts.maxTokens ?? opts.max_tokens ?? runtimeCfg.max_tokens ?? runtimeCfg.maxTokens,
    WEBLLM_DEFAULT_MAX_TOKENS,
    'maxTokens',
    32_768,
  );
  const maxOutputChars = positiveInt(
    opts.maxOutputChars ?? opts.max_output_chars ?? runtimeCfg.max_output_chars ?? runtimeCfg.maxOutputChars,
    WEBLLM_DEFAULT_MAX_OUTPUT_CHARS,
    'maxOutputChars',
    1_000_000,
  );
  const chatOptions = {
    ...asObject(runtimeCfg.chat_options),
    ...asObject(runtimeCfg.chatOptions),
    ...asObject(opts.chatOptions),
  };
  const temperature = finiteNumber(
    opts.temperature ?? chatOptions.temperature ?? runtimeCfg.temperature,
    0,
    'temperature',
  );

  return {
    modelId,
    cacheMode,
    cacheName,
    modelLibUrl,
    requireWebGpu: !!requireWebGpu,
    maxTokens,
    maxOutputChars,
    temperature,
    chatOptions,
    engineConfig: { ...asObject(runtimeCfg.engine_config), ...asObject(runtimeCfg.engineConfig), ...asObject(opts.engineConfig) },
    appConfig: mergeAppConfig({ cacheMode, cacheName, modelLibUrl }, runtimeCfg),
    webllmImportUrl: normalizeImportUrl(opts, runtimeCfg),
  };
}

export async function loadWebLlmRuntime(opts = {}, manifest = {}) {
  if (opts.webllm) return opts.webllm;
  if (typeof opts.loadWebLLM === 'function') {
    const loaded = await opts.loadWebLLM();
    if (loaded) return loaded;
  }
  if (globalThis.webllm) return globalThis.webllm;
  const cfg = asObject(manifest.runtime_config);
  const importUrl = normalizeImportUrl(opts, cfg);
  if (importUrl) {
    if (opts.allowRuntimeImport !== true) {
      throw kolmError(
        'KOLM_E_WEBLLM_RUNTIME_IMPORT_BLOCKED',
        'explicit webllmImportUrl requires allowRuntimeImport:true; no default CDN runtime is fetched',
      );
    }
    const mod = await import(importUrl);
    return mod.default || mod;
  }
  throw kolmError(
    'KOLM_E_WEBLLM_RUNTIME_MISSING',
    'WebLLM unavailable; pass opts.webllm, opts.loadWebLLM, globalThis.webllm, or an explicit webllmImportUrl with allowRuntimeImport:true',
  );
}

function engineOptions(cfg) {
  const out = { ...cfg.appConfig };
  if (Object.keys(cfg.engineConfig).length) out.engine_config = cfg.engineConfig;
  return out;
}

export async function createWebLlmEngine(webllm, cfg, opts = {}) {
  if (opts.engine) return opts.engine;
  if (typeof opts.createEngine === 'function') {
    return opts.createEngine({ webllm, config: cfg });
  }
  if (webllm && typeof webllm.CreateMLCEngine === 'function') {
    return webllm.CreateMLCEngine(cfg.modelId, engineOptions(cfg));
  }
  if (webllm && typeof webllm.createEngine === 'function') {
    return webllm.createEngine(cfg.modelId, engineOptions(cfg));
  }
  if (webllm && typeof webllm.MLCEngine === 'function') {
    const engine = new webllm.MLCEngine(engineOptions(cfg));
    if (typeof engine.reload === 'function') {
      await engine.reload(cfg.modelId, engineOptions(cfg));
    }
    return engine;
  }
  throw kolmError(
    'KOLM_E_WEBLLM_ENGINE',
    'WebLLM runtime does not expose CreateMLCEngine, createEngine, or MLCEngine',
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

export async function loadSignedWebLlmModelBytes(engine, weightsBytes, manifest, cfg, opts = {}, verified = {}) {
  if (typeof opts.loadModelBytes === 'function') {
    await callModelBytesLoader(opts.loadModelBytes, engine, weightsBytes, manifest, cfg, verified);
    return { method: 'opts.loadModelBytes' };
  }
  const loaders = [
    ['registerModelBytes', engine && engine.registerModelBytes],
    ['loadModelFromBytes', engine && engine.loadModelFromBytes],
    ['loadModelBytes', engine && engine.loadModelBytes],
    ['reloadFromBytes', engine && engine.reloadFromBytes],
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
    'KOLM_E_WEBLLM_BYTES_REQUIRED',
    'WebLLM runner requires an explicit signed-byte loader bridge; unsigned engine-managed fetch is refused',
  );
}

function capOutputText(text, maxOutputChars) {
  const s = String(text ?? '');
  if (s.length <= maxOutputChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxOutputChars), truncated: true };
}

function parseWebLlmResponse(response) {
  if (typeof response === 'string') return { text: response, raw: response, usage: null };
  const choice = response?.choices?.[0];
  const text = choice?.message?.content
    ?? choice?.delta?.content
    ?? choice?.text
    ?? response?.text
    ?? response?.message
    ?? '';
  return {
    text,
    raw: response,
    usage: response?.usage || null,
  };
}

function estimateGeneratedTokens(text, usage) {
  const usageTokens = usage?.completion_tokens ?? usage?.completionTokens ?? usage?.generated_tokens ?? usage?.generatedTokens;
  if (Number.isFinite(Number(usageTokens)) && Number(usageTokens) >= 0) return Number(usageTokens);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words * 1.33)) : 0;
}

export async function runWebLlmGeneration(engine, messages, cfg) {
  const options = {
    ...cfg.chatOptions,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
  };
  if (engine?.chat?.completions && typeof engine.chat.completions.create === 'function') {
    return parseWebLlmResponse(await engine.chat.completions.create(options));
  }
  if (typeof engine?.chatCompletion === 'function') {
    return parseWebLlmResponse(await engine.chatCompletion(options));
  }
  if (typeof engine?.generate === 'function') {
    const prompt = messages.map((msg) => msg.content).join('\n');
    return parseWebLlmResponse(await engine.generate(prompt, options));
  }
  if (typeof engine?.chat === 'function') {
    return parseWebLlmResponse(await engine.chat(messages, options));
  }
  throw kolmError(
    'KOLM_E_WEBLLM_ENGINE',
    'WebLLM engine does not expose chat.completions.create, chatCompletion, generate, or chat',
  );
}

async function fetchJsonAndBytes(manifestUrl, fetchImpl) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') throw kolmError('KOLM_E_WEBLLM_FETCH', 'fetch unavailable');
  const manifestResponse = await fetcher(manifestUrl);
  if (!manifestResponse.ok) throw kolmError('KOLM_E_WEBLLM_FETCH', `manifest fetch failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const base = globalThis.location ? location.href : 'http://localhost/';
  const weightUrl = new URL(manifest.weights_url, new URL(manifestUrl, base)).toString();
  const weightsResponse = await fetcher(weightUrl);
  if (!weightsResponse.ok) throw kolmError('KOLM_E_WEBLLM_FETCH', `weights fetch failed: ${weightsResponse.status}`);
  return { manifest, weightsBytes: new Uint8Array(await weightsResponse.arrayBuffer()) };
}

function validateWebLlmManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw kolmError('KOLM_E_WEBLLM_MANIFEST', 'WebLLM manifest must be an object');
  }
  if (manifest.schema !== BROWSER_WEIGHT_MANIFEST_SPEC) {
    throw kolmError('KOLM_E_WEBLLM_MANIFEST', `unexpected manifest schema: ${manifest.schema || '<missing>'}`);
  }
  if (!WEBLLM_ACCEPTED_RUNTIMES.includes(String(manifest.runtime || ''))) {
    throw kolmError('KOLM_E_WEBLLM_MANIFEST', `WebLLM runner refuses runtime=${manifest.runtime || '<missing>'}`);
  }
}

export async function runVerifiedWebLlmModel({
  manifestUrl = null,
  manifest = null,
  weightsBytes = null,
  input = null,
  fetchImpl = null,
  ...opts
} = {}) {
  if (!manifest || !weightsBytes) {
    if (!manifestUrl) throw kolmError('KOLM_E_WEBLLM_MANIFEST', 'manifestUrl is required when manifest or weightsBytes are omitted');
    const loaded = await fetchJsonAndBytes(manifestUrl, fetchImpl);
    manifest = loaded.manifest;
    weightsBytes = loaded.weightsBytes;
  }

  const verified = await verifyWeightManifest(manifest, weightsBytes, opts);
  if (!verified.ok) return { ok: false, stage: 'verify', ...verified };
  validateWebLlmManifest(manifest);

  const cfg = normalizeWebLlmRuntimeConfig(manifest, opts);
  if (cfg.requireWebGpu && !webGpuAvailable() && opts.skipWebGpuAvailabilityCheck !== true) {
    throw kolmError('KOLM_E_WEBLLM_WEBGPU_UNAVAILABLE', 'WebGPU unavailable; refusing signed WebLLM run without explicit fallback');
  }

  const messages = normalizeMessages({ ...manifest, input: input ?? manifest.input }, opts);
  const runtime = await loadWebLlmRuntime(opts, manifest);
  const loadStart = nowMs();
  const engine = await createWebLlmEngine(runtime, cfg, opts);
  const byteLoad = await loadSignedWebLlmModelBytes(engine, weightsBytes, manifest, cfg, opts, verified);
  const loadMs = Math.max(0, Math.round(nowMs() - loadStart));

  const runStart = nowMs();
  const generation = await runWebLlmGeneration(engine, messages, cfg);
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
    runtime: WEBLLM_RUNTIME,
    weights_sha256: verified.weights_sha256,
    output_text: capped.text,
    output_truncated: capped.truncated,
    usage: generation.usage,
    timings_ms: { load: loadMs, run: runMs },
    runtime_passport: {
      schema: 'kolm.browser_runtime_passport.v1',
      runtime: WEBLLM_RUNTIME,
      model_id: cfg.modelId,
      weights_sha256: verified.weights_sha256,
      sig_ok: true,
      cache_mode: cfg.cacheMode,
      cache_name: cfg.cacheName,
      webgpu_required: cfg.requireWebGpu,
      byte_load_method: byteLoad.method,
      tokens_generated: generatedTokens,
      tok_s: tokS,
      ttft_ms: generation.usage?.ttft_ms ?? generation.usage?.ttftMs ?? null,
    },
    checks: verified.checks,
  };
}

if (typeof window !== 'undefined') {
  window.kolmWebLlmRunner = {
    runVerifiedWebLlmModel,
    normalizeWebLlmRuntimeConfig,
    loadWebLlmRuntime,
    createWebLlmEngine,
    loadSignedWebLlmModelBytes,
    runWebLlmGeneration,
  };
}
