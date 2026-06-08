// src/kv-cache-policy.js
//
// Policy selector for the runtime KV cache backend.
//
// Resolves a request for the KV cache implementation into one of:
//
//   { backend: 'shard',   reason, fallback: 'default' }
//   { backend: 'default', reason, fallback: null }
//
// Inputs:
//   * format - runtime/format identifier ('transformers', 'vllm',
//                    'llama.cpp', 'mlx', 'ollama', 'gguf', 'safetensors', ...)
//   * modelMeta - { family, has_rope, num_hidden_layers, ... }
//   * hardware - { vram_gb, device } (currently advisory only)
//   * requested - 'auto' (default) | 'shard' (force) | 'default' (force)
//
// 'shard' is chosen when:
//   * requested === 'shard' (force, regardless of compatibility), OR
//   * requested === 'auto' AND format is a HF Cache consumer AND model is
//     RoPE-based AND the family is on the SUPPORTED_MODEL_FAMILIES list AND
//     the Python `shard` package is reachable (advisory: this module records
//     the intent; the Python side hard-fails if the import is missing).
//
// 'default' is chosen otherwise, with a reason string explaining why.

import {
  SUPPORTED_MODEL_FAMILIES,
  SUPPORTED_RUNTIMES,
  isShardSupported,
} from './kv-cache-shard.js';

// Map of format -> HF Cache runtime. llama.cpp / mlx / ollama use their own
// KV cache implementations and intentionally resolve to null here.
const FORMAT_TO_RUNTIME = Object.freeze({
  transformers: 'transformers',
  hf: 'transformers',
  huggingface: 'transformers',
  safetensors: 'transformers',
  vllm: 'vllm',
  'llama.cpp': null,
  llamacpp: null,
  gguf: null,
  mlx: null,
  ollama: null,
  tgi: 'transformers', // TGI is built on transformers
  sglang: null, // sglang has its own radix cache
});

function _normalizeFormat(format) {
  if (!format || typeof format !== 'string') return null;
  return String(format).toLowerCase().trim();
}

function _resolveRuntime(format) {
  const key = _normalizeFormat(format);
  if (key === null) return null;
  if (Object.prototype.hasOwnProperty.call(FORMAT_TO_RUNTIME, key)) {
    return FORMAT_TO_RUNTIME[key];
  }
  // Unknown format - pass through if it already matches a supported runtime.
  if (SUPPORTED_RUNTIMES.includes(key)) return key;
  return null;
}

/**
 * Resolve a KV cache backend request.
 *
 * Returns { backend, reason, fallback } where:
 *   backend - 'shard' | 'default'
 *   reason - short explanation suitable for logs / passport / --dry-run
 *   fallback - backend to retry with if `backend` errors; null when N/A
 */
export function selectKvCache({
  format,
  modelMeta = {},
  hardware = {},
  requested = 'auto',
} = {}) {
  const family = modelMeta.family || modelMeta.model_family || null;
  const hasRope =
    modelMeta.has_rope !== undefined
      ? modelMeta.has_rope === true
      : Boolean(family && SUPPORTED_MODEL_FAMILIES.includes(String(family).toLowerCase()));
  const runtime = _resolveRuntime(format);

  // Force overrides.
  if (requested === 'default') {
    return {
      backend: 'default',
      reason: 'requested=default (forced)',
      fallback: null,
    };
  }
  if (requested === 'shard') {
    // Force Shard - but still record whether the gate would have allowed it,
    // so the passport carries the reason.
    const gate = isShardSupported({
      model_family: family || 'unknown',
      runtime: runtime || 'unknown',
      has_rope: hasRope,
    });
    return {
      backend: 'shard',
      reason: gate.supported
        ? 'requested=shard (forced); gate: ok'
        : `requested=shard (forced); gate would have rejected: ${gate.reason}`,
      fallback: 'default',
    };
  }

  // requested === 'auto' (the default).
  if (!runtime) {
    return {
      backend: 'default',
      reason: `format ${format ?? '(none)'} is not a HF Cache consumer; Shard supports ${SUPPORTED_RUNTIMES.join(', ')}`,
      fallback: null,
    };
  }
  const gate = isShardSupported({
    model_family: family || 'unknown',
    runtime,
    has_rope: hasRope,
  });
  if (!gate.supported) {
    return {
      backend: 'default',
      reason: `shard gate rejected: ${gate.reason}`,
      fallback: null,
    };
  }
  // Advisory: hardware is currently consulted only for the passport; the
  // gate decision does not require a minimum VRAM (Shard ON a small GPU is
  // exactly when it pays off most).
  const hwNote =
    hardware && typeof hardware.vram_gb === 'number' && Number.isFinite(hardware.vram_gb)
      ? `; hw=${hardware.vram_gb}GB`
      : '';
  return {
    backend: 'shard',
    reason: `auto: format=${runtime} family=${family} has_rope=true${hwNote}`,
    fallback: 'default',
  };
}

/**
 * Human-readable multi-line report for `--dry-run` output.
 */
export function formatPolicyReport(policy) {
  if (!policy || typeof policy !== 'object') return '(no policy)';
  const { backend, reason, fallback } = policy;
  const lines = [
    'KV cache policy',
    `  backend  : ${backend}`,
    `  reason   : ${reason}`,
    `  fallback : ${fallback ?? '(none)'}`,
  ];
  return lines.join('\n');
}

export default {
  selectKvCache,
  formatPolicyReport,
};
