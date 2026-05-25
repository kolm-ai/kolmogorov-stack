// W866 — memory fit calculator (will_it_fit).
//
// "Will this model at this quant fit in my VRAM at this context length?"
//
// Inputs: model_params_b, quant_target (one of ALL_METHODS), vram_gb, context, batch
// Output: { fits, est_total_gb, est_weights_gb, est_kv_gb, est_activations_gb,
//           overhead_gb, headroom_gb, recommendation }
//
// Numbers are intentionally conservative. The KV cache estimate scales with
// (ctx × batch × num_layers × num_kv_heads × head_dim × kv_precision_bytes).
// We don't have num_kv_heads + head_dim for an arbitrary model id, so we
// fall back to a rule of thumb (KV ~= 0.18 GB per 1B params per 8K ctx at fp16)
// which is accurate within ±20% for Llama/Qwen/Mistral families.
//
// Runtime overhead is a flat ~1 GB for CUDA contexts + activation buffers.

import { ALL_METHODS } from './forge-hardware.js';

export const FIT_VERSION = 'forge-fit-v1';

// Bytes-per-parameter for each quant target. Approximations from real artifacts.
const BYTES_PER_PARAM = Object.freeze({
  'fp16':         2.0,
  'bf16':         2.0,
  'fp8':          1.0,
  'nvfp4':        0.5,
  'int8':         1.0,
  'int4':         0.55,   // NF4 + double quant overhead
  'gguf-q8':      1.07,   // Q8_0 = 8.5 bits/param effective
  'gguf-q6k':     0.82,
  'gguf-q5km':    0.69,
  'gguf-q4km':    0.56,
  'gguf-q3km':    0.45,
  'gguf-q2k':     0.35,
  'gguf-iq4xs':   0.53,   // IQ4_XS importance matrix
  'gguf-iq3xxs':  0.40,
  'gguf-iq2xs':   0.30,
  'exl2':         0.50,   // 4.0 bpw default
  'gptq-4bit':    0.56,
  'awq-4bit':     0.56,
  'hqq':          0.50,
  'mlx-4bit':     0.55,
});

// KV cache bytes per token per layer per head (rough).
// fp16 KV ≈ 4 bytes/token/layer/head; fp8 KV ≈ 2 bytes.
const KV_PRECISION_BYTES = Object.freeze({ fp16: 4, bf16: 4, fp8: 2, int8: 2, int4: 1 });

// Rough KV ratio: GB per 1B params per 8K ctx at fp16.
// Empirical from Llama-7B, Qwen-14B, Mistral-7B reference cards.
const KV_GB_PER_BPARAM_8K = 0.18;

/**
 * Estimate VRAM use for a given (params, quant, ctx, batch).
 * @returns {Object} {fits, est_total_gb, est_weights_gb, est_kv_gb, est_activations_gb,
 *                    overhead_gb, headroom_gb, recommendation}
 */
export function estimateMemoryFit({ model_params_b, quant, vram_gb, context = 8192, batch = 1, kv_precision = 'fp16' }) {
  if (!model_params_b || model_params_b <= 0) {
    throw new Error(`fit_requires_model_params_b: got ${model_params_b}`);
  }
  if (!ALL_METHODS.includes(quant) && !BYTES_PER_PARAM[quant]) {
    throw new Error(`fit_unknown_quant: ${quant}`);
  }
  if (!vram_gb || vram_gb <= 0) {
    throw new Error(`fit_requires_vram_gb: got ${vram_gb}`);
  }
  const bpp = BYTES_PER_PARAM[quant] ?? BYTES_PER_PARAM.fp16;
  // Weights memory
  const est_weights_gb = Math.round(model_params_b * bpp * 10) / 10;
  // KV cache (scales linearly with ctx × batch)
  const kv_byte_ratio = KV_PRECISION_BYTES[kv_precision] / KV_PRECISION_BYTES.fp16;
  const est_kv_gb = Math.round(model_params_b * KV_GB_PER_BPARAM_8K * (context / 8192) * batch * kv_byte_ratio * 10) / 10;
  // Activations: typically 5-15% of weights for inference
  const est_activations_gb = Math.round(est_weights_gb * 0.08 * 10) / 10;
  // CUDA context + framework overhead
  const overhead_gb = 1.0;
  const est_total_gb = Math.round((est_weights_gb + est_kv_gb + est_activations_gb + overhead_gb) * 10) / 10;
  const headroom_gb = Math.round((vram_gb - est_total_gb) * 10) / 10;
  const fits = est_total_gb <= vram_gb;
  const tight = fits && headroom_gb < vram_gb * 0.10;  // <10% headroom = tight
  let recommendation = null;
  if (!fits) {
    // Suggest a smaller quant
    const smaller = Object.entries(BYTES_PER_PARAM)
      .filter(([k, v]) => v < bpp)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    recommendation = smaller.length
      ? `try ${smaller[0]} or smaller — current quant exceeds VRAM by ${Math.round((est_total_gb - vram_gb) * 10) / 10} GB`
      : `model too large for ${vram_gb} GB VRAM — needs sharding or CPU offload`;
  } else if (tight) {
    recommendation = `fits but headroom <10% — long contexts may OOM. Consider quant tier down or shorter ctx`;
  } else {
    recommendation = `comfortable fit (${headroom_gb} GB free)`;
  }
  return {
    fits, tight,
    est_total_gb, est_weights_gb, est_kv_gb, est_activations_gb,
    overhead_gb, headroom_gb,
    bytes_per_param: bpp,
    context, batch, kv_precision,
    recommendation,
    forge_fit_version: FIT_VERSION,
  };
}

/**
 * Pick the best quant target that fits on this hardware, ranked by quality.
 * Quality order (best → worst): fp16 > fp8 > nvfp4 > gguf-q8 > exl2(6bpw) >
 *   gguf-q6k > gguf-q5km > awq-4bit > gptq-4bit > gguf-q4km > gguf-iq4xs >
 *   int4 > hqq > gguf-q3km > gguf-q2k
 */
const QUALITY_ORDER = Object.freeze([
  'fp16', 'bf16', 'fp8', 'nvfp4', 'gguf-q8', 'gguf-q6k', 'gguf-q5km',
  'awq-4bit', 'gptq-4bit', 'gguf-q4km', 'gguf-iq4xs', 'int4', 'exl2',
  'mlx-4bit', 'hqq', 'gguf-q3km', 'gguf-iq3xxs', 'gguf-q2k', 'gguf-iq2xs',
]);

export function pickBestFitTarget({ model_params_b, vram_gb, context = 8192, supported_methods = ALL_METHODS }) {
  for (const q of QUALITY_ORDER) {
    if (!supported_methods.includes(q)) continue;
    const fit = estimateMemoryFit({ model_params_b, quant: q, vram_gb, context });
    if (fit.fits && !fit.tight) {
      return { picked: q, fit, rationale: `highest-quality quant that fits with headroom` };
    }
  }
  // If nothing comfortable fits, try tight fits
  for (const q of QUALITY_ORDER) {
    if (!supported_methods.includes(q)) continue;
    const fit = estimateMemoryFit({ model_params_b, quant: q, vram_gb, context });
    if (fit.fits) {
      return { picked: q, fit, rationale: `tight fit — last viable target` };
    }
  }
  return {
    picked: null,
    fit: null,
    rationale: `nothing fits — model ${model_params_b}B too large for ${vram_gb} GB VRAM. Needs sharding or CPU.`,
  };
}
