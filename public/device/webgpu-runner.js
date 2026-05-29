// Minimal on-device LLM token-generation runner for the browser.
//
// Loads transformers.js from the official @huggingface/transformers CDN ESM
// build (no bundler, no build step) and generates tokens from a tiny model.
// It prefers the WebGPU backend when navigator.gpu is present, and falls back
// to the WASM backend otherwise. Every run returns a flat result envelope so
// the harness page (and tests) can reason about the outcome deterministically:
//
//   { ok, runtime: 'webgpu' | 'wasm', tokens, ms, device, model, text, error }
//
// Determinism note: generation defaults to greedy decoding (do_sample:false)
// and no wall-clock value is used in control flow. The `ms` field is reported
// for observability only; callers may pass any seed/options through `opts`.

// Pinned CDN ESM import. Kept as a top-level constant string as well so static
// contract tests can assert the import URL is present without executing it.
export const TRANSFORMERS_CDN_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

// Tiny, public, fast-to-download default models. distilgpt2 is the smallest
// reliable causal-LM demo; the Qwen 0.5B instruct ONNX build is the upgrade
// path once WebGPU is confirmed available.
export const DEFAULT_MODEL = 'Xenova/distilgpt2';
export const WEBGPU_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';

const DEFAULT_PROMPT = 'The Kolmogorov stack compiles models so they';

// Resolve the runtime we will ask transformers.js to use. Pure function of the
// passed navigator-like object, so it is unit-testable without a real browser.
export function pickRuntime(nav) {
  const gpu = nav && typeof nav === 'object' ? nav.gpu : undefined;
  return gpu ? 'webgpu' : 'wasm';
}

// Build a normalized envelope. Always includes the same keys.
function envelope(fields) {
  return {
    ok: false,
    runtime: 'wasm',
    tokens: 0,
    ms: 0,
    device: 'unknown',
    model: null,
    text: '',
    error: null,
    ...fields,
  };
}

function now() {
  // Prefer the high-resolution monotonic clock when available.
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// Count tokens with the model's tokenizer when we can, otherwise approximate by
// whitespace so the envelope always carries a positive integer on success.
function countTokens(tokenizer, text) {
  try {
    if (tokenizer && typeof tokenizer.encode === 'function') {
      const ids = tokenizer.encode(text);
      if (Array.isArray(ids)) return ids.length;
      if (ids && typeof ids.length === 'number') return ids.length;
    }
  } catch {
    // fall through to whitespace estimate
  }
  const trimmed = String(text || '').trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

// Core runner. Dynamically imports transformers.js so this module can be parsed
// and its pure helpers tested in Node without pulling the CDN.
export async function runOnDevice(opts = {}) {
  const nav = opts.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  const runtime = opts.runtime || pickRuntime(nav);
  const model =
    opts.model || (runtime === 'webgpu' ? WEBGPU_MODEL : DEFAULT_MODEL);
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : DEFAULT_PROMPT;
  const maxNewTokens = Number.isInteger(opts.maxNewTokens) ? opts.maxNewTokens : 24;
  const cdnUrl = opts.cdnUrl || TRANSFORMERS_CDN_URL;
  const start = now();

  try {
    // Allow tests / harness to inject a transformers module; otherwise import
    // the pinned CDN ESM build at call time.
    const transformers = opts.transformers || (await import(/* @vite-ignore */ cdnUrl));
    const { pipeline, env } = transformers;

    // Keep it dependency-light: use the bundled remote weights, no local cache
    // server required.
    if (env && env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      // Single-threaded WASM is the most compatible default for static hosting
      // (no cross-origin-isolation / SharedArrayBuffer requirement).
      env.backends.onnx.wasm.numThreads = 1;
    }

    const device = runtime === 'webgpu' ? 'webgpu' : 'wasm';
    const generator = await pipeline('text-generation', model, { device });

    const output = await generator(prompt, {
      max_new_tokens: maxNewTokens,
      do_sample: false, // greedy: deterministic given the same model + prompt
      temperature: 1,
      return_full_text: true,
    });

    const first = Array.isArray(output) ? output[0] : output;
    const text =
      (first && (first.generated_text || first.text)) ||
      (typeof first === 'string' ? first : '');
    const tokenizer = generator.tokenizer || null;
    const tokens = countTokens(tokenizer, text);
    const ms = Math.max(0, Math.round(now() - start));

    return envelope({
      ok: true,
      runtime,
      tokens,
      ms,
      device,
      model,
      text,
      error: null,
    });
  } catch (err) {
    const ms = Math.max(0, Math.round(now() - start));
    return envelope({
      ok: false,
      runtime,
      tokens: 0,
      ms,
      device: runtime === 'webgpu' ? 'webgpu' : 'wasm',
      model,
      text: '',
      error: (err && (err.message || String(err))) || 'unknown_error',
    });
  }
}

// Browser convenience: render the envelope into a target element if one is
// supplied. Returns the same envelope so callers can chain.
export function renderResult(envelopeObj, el) {
  if (el && typeof el === 'object') {
    try {
      el.textContent = JSON.stringify(envelopeObj, null, 2);
    } catch {
      el.textContent = String(envelopeObj && envelopeObj.error ? envelopeObj.error : envelopeObj);
    }
  }
  return envelopeObj;
}

// Auto-expose on window for the harness page (no-op under Node / module tests).
if (typeof window !== 'undefined') {
  window.KolmWebGPURunner = {
    runOnDevice,
    pickRuntime,
    renderResult,
    TRANSFORMERS_CDN_URL,
    DEFAULT_MODEL,
    WEBGPU_MODEL,
  };
}
