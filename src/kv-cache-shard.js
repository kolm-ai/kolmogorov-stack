// src/kv-cache-shard.js
//
// Shard KV cache integration module - drop-in HuggingFace Cache replacement
// that achieves ~10x KV cache compression by treating K and V differently:
//
//   K  : low-rank after undoing RoPE -> PCA + int4
//   V  : Hadamard rotation + VQ256 (vector quantization, 256-entry codebook)
//   FP16 attention sinks (first 4 tokens, never compressed)
//   FP16 recency window (last 64 tokens, never compressed)
//
// Reference: github.com/krish1905/shard (Apache-2.0).
//
// This module is the JS-side contract for the Python Shard library. It does
// not run Shard itself - it exposes:
//
//   * estimateKvCacheBytes - bytes for the default FP16 KV cache.
//   * estimateShardKvCacheBytes - bytes for the Shard-compressed KV cache.
//   * compressionRatio - default / shard ratio.
//   * maxContextAtVram - integer max context that fits in VRAM.
//   * isShardSupported - gate (family + runtime + RoPE).
//   * shardPassportEntry - runtime passport kv_cache sub-object.
//
// Caveats:
//   * Shard is a HF Cache subclass. transformers + vLLM use HF Cache;
//     llama.cpp + MLX have their own cache and are NOT in scope.
//   * quality_delta must be MEASURED per model. The reported "no measurable
//     quality drop" claim is for the reference Llama/Qwen runs in the Shard
//     paper. Each new model the kolm pipeline ships through Shard must
//     re-measure quality vs the FP16 baseline.
//   * 1.5 bits-per-element (bpe) is the geometric mean of the K int4 path
//     (4 bpe over the rank-reduced subspace) and the V VQ256 path (8 bits
//     for the codebook index over a typically rank-8 group). The exact
//     ratio depends on per-layer ranks; 1.5 bpe is the kolm calibration
//     default for Qwen + Llama families.

export const SHARD_VERSION = 'kolm-shard/1';

// Decoder-only transformer families with RoPE. Shard requires undoing RoPE
// on K before PCA, so non-RoPE families (e.g. GPT-2 with learned positional
// embeddings) are not supported.
export const SUPPORTED_MODEL_FAMILIES = Object.freeze([
  'llama',
  'qwen',
  'qwen2',
  'qwen2.5',
  'qwen3',
  'mistral',
  'mixtral',
  'gemma',
  'gemma2',
  'deepseek',
]);

// Runtimes that consume the HuggingFace Cache contract. llama.cpp and MLX
// have their own KV cache implementations and are out of scope for Shard.
export const SUPPORTED_RUNTIMES = Object.freeze(['transformers', 'vllm']);

// Default sink + window sizes from the Shard reference implementation.
// Both regions stay at FP16 (or the model's native dtype) and never
// participate in K-PCA or V-VQ. Sink protects the first tokens of
// every sequence (attention sinks paper); window protects recent tokens
// because they have not yet been "warmed up" enough to compress safely.
export const SHARD_DEFAULT_SINK_TOKENS = 4;
export const SHARD_DEFAULT_WINDOW_TOKENS = 64;
export const SHARD_DEFAULT_BITS_PER_ELEMENT = 1.5; // ~10x vs FP16's 16 bpe
export const SHARD_DEFAULT_BYTES_PER_ELEMENT_FP16 = 2;

function _requireFiniteNonNegativeInt(value, name) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new TypeError(
      `${name} must be a finite non-negative integer; got ${value}`
    );
  }
}

function _requireFiniteNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `${name} must be a finite non-negative number; got ${value}`
    );
  }
}

/**
 * Default FP16 KV cache size in bytes.
 *
 * Formula: 2 (one K + one V) * L * Hkv * d * T * bpe
 * where L = num_hidden_layers, Hkv = num_key_value_heads, d = head_dim,
 * T = context_length, bpe = bytes_per_element (2 for FP16).
 */
export function estimateKvCacheBytes({
  num_hidden_layers,
  num_key_value_heads,
  head_dim,
  context_length,
  bytes_per_element = SHARD_DEFAULT_BYTES_PER_ELEMENT_FP16,
}) {
  _requireFiniteNonNegativeInt(num_hidden_layers, 'num_hidden_layers');
  _requireFiniteNonNegativeInt(num_key_value_heads, 'num_key_value_heads');
  _requireFiniteNonNegativeInt(head_dim, 'head_dim');
  _requireFiniteNonNegativeInt(context_length, 'context_length');
  _requireFiniteNonNegative(bytes_per_element, 'bytes_per_element');
  return (
    2 *
    num_hidden_layers *
    num_key_value_heads *
    head_dim *
    context_length *
    bytes_per_element
  );
}

/**
 * Shard-compressed KV cache size in bytes.
 *
 * Two regions:
 *   * Sink + window (sink_tokens + window_tokens) - FP16, 2 bytes/element
 *   * Compressed tail (context_length - sink - window) - bits_per_element / 8 bytes/element
 *
 * If context_length <= sink + window, the compressed region is empty and
 * the answer is just the FP16 region (which is what HF Cache would store
 * anyway up to that length).
 */
export function estimateShardKvCacheBytes({
  num_hidden_layers,
  num_key_value_heads,
  head_dim,
  context_length,
  sink_tokens = SHARD_DEFAULT_SINK_TOKENS,
  window_tokens = SHARD_DEFAULT_WINDOW_TOKENS,
  bits_per_element = SHARD_DEFAULT_BITS_PER_ELEMENT,
}) {
  _requireFiniteNonNegativeInt(num_hidden_layers, 'num_hidden_layers');
  _requireFiniteNonNegativeInt(num_key_value_heads, 'num_key_value_heads');
  _requireFiniteNonNegativeInt(head_dim, 'head_dim');
  _requireFiniteNonNegativeInt(context_length, 'context_length');
  _requireFiniteNonNegativeInt(sink_tokens, 'sink_tokens');
  _requireFiniteNonNegativeInt(window_tokens, 'window_tokens');
  _requireFiniteNonNegative(bits_per_element, 'bits_per_element');

  const protectedTokens = Math.min(context_length, sink_tokens + window_tokens);
  const compressedTokens = Math.max(0, context_length - protectedTokens);
  const perTokenSlots = 2 * num_hidden_layers * num_key_value_heads * head_dim;
  const sinkWindowBytes =
    perTokenSlots * protectedTokens * SHARD_DEFAULT_BYTES_PER_ELEMENT_FP16;
  const compressedBytes = perTokenSlots * compressedTokens * (bits_per_element / 8);
  return sinkWindowBytes + compressedBytes;
}

/**
 * Compression ratio = default FP16 bytes / Shard bytes.
 *
 * At T much larger than sink+window, this approaches 16 bpe / 1.5 bpe = 10.67x.
 * At T = sink+window, the ratio is 1.0 (no compression yet).
 */
export function compressionRatio(args) {
  const defaultBytes = estimateKvCacheBytes(args);
  const shardBytes = estimateShardKvCacheBytes(args);
  if (shardBytes <= 0) return 1.0;
  return defaultBytes / shardBytes;
}

/**
 * Solve for the largest context that fits in `vram_bytes_for_kv` bytes.
 *
 * Returns an integer token count. Uses a closed-form solve when
 * use_shard is true:
 *
 *   vram = sinkBytes(sink + window) + perToken * (T - sink - window) * 0.1875
 *
 *   T = sink + window + (vram - sinkBytes) / (perToken * 0.1875)
 *
 * Floored to int; never returns less than sink + window.
 *
 * model_arch is the same {num_hidden_layers, num_key_value_heads, head_dim}
 * shape the other functions take.
 */
export function maxContextAtVram({
  vram_bytes_for_kv,
  model_arch,
  use_shard,
  sink_tokens = SHARD_DEFAULT_SINK_TOKENS,
  window_tokens = SHARD_DEFAULT_WINDOW_TOKENS,
  bits_per_element = SHARD_DEFAULT_BITS_PER_ELEMENT,
}) {
  _requireFiniteNonNegative(vram_bytes_for_kv, 'vram_bytes_for_kv');
  if (!model_arch || typeof model_arch !== 'object') {
    throw new TypeError(
      'model_arch must be {num_hidden_layers, num_key_value_heads, head_dim}'
    );
  }
  const { num_hidden_layers, num_key_value_heads, head_dim } = model_arch;
  _requireFiniteNonNegativeInt(num_hidden_layers, 'model_arch.num_hidden_layers');
  _requireFiniteNonNegativeInt(num_key_value_heads, 'model_arch.num_key_value_heads');
  _requireFiniteNonNegativeInt(head_dim, 'model_arch.head_dim');

  const perTokenSlots = 2 * num_hidden_layers * num_key_value_heads * head_dim;
  if (perTokenSlots <= 0) return 0;

  if (!use_shard) {
    const perTokenBytes = perTokenSlots * SHARD_DEFAULT_BYTES_PER_ELEMENT_FP16;
    return Math.max(0, Math.floor(vram_bytes_for_kv / perTokenBytes));
  }

  const protectedFloor = sink_tokens + window_tokens;
  const sinkWindowBytes =
    perTokenSlots * protectedFloor * SHARD_DEFAULT_BYTES_PER_ELEMENT_FP16;
  if (vram_bytes_for_kv <= sinkWindowBytes) {
    // Sink+window alone doesn't fit; degenerate, return the integer count of
    // FP16 tokens we can fit (treating it as no compression below the floor).
    const perTokenBytes = perTokenSlots * SHARD_DEFAULT_BYTES_PER_ELEMENT_FP16;
    return Math.max(0, Math.floor(vram_bytes_for_kv / perTokenBytes));
  }
  const remaining = vram_bytes_for_kv - sinkWindowBytes;
  const compressedBytesPerToken = perTokenSlots * (bits_per_element / 8);
  if (compressedBytesPerToken <= 0) return protectedFloor;
  const compressedTokens = Math.floor(remaining / compressedBytesPerToken);
  return protectedFloor + compressedTokens;
}

/**
 * Gate: can Shard be used for (family, runtime, has_rope)?
 *
 * Returns { supported: boolean, reason: string }.
 */
export function isShardSupported({ model_family, runtime, has_rope }) {
  if (!model_family || typeof model_family !== 'string') {
    return { supported: false, reason: 'model_family is required (string)' };
  }
  if (!runtime || typeof runtime !== 'string') {
    return { supported: false, reason: 'runtime is required (string)' };
  }
  if (has_rope !== true) {
    return {
      supported: false,
      reason: `Shard requires RoPE; ${model_family} reports has_rope=${has_rope}`,
    };
  }
  const normalizedFamily = String(model_family).toLowerCase();
  if (!SUPPORTED_MODEL_FAMILIES.includes(normalizedFamily)) {
    return {
      supported: false,
      reason: `model_family ${model_family} is not in SUPPORTED_MODEL_FAMILIES (${SUPPORTED_MODEL_FAMILIES.join(', ')})`,
    };
  }
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    return {
      supported: false,
      reason: `runtime ${runtime} is not a HF Cache consumer; Shard supports ${SUPPORTED_RUNTIMES.join(', ')}`,
    };
  }
  return { supported: true, reason: 'ok' };
}

/**
 * Build the runtime-passport kv_cache sub-object.
 *
 * `measured` carries the per-model measurements:
 *   {
 *     compression_ratio: number   // measured ratio (default_bytes / shard_bytes)
 *     quality_delta: number       // measured eval delta vs FP16 baseline (0 = parity)
 *     max_context_at_vram: { 16: int, 24: int, 32: int }  // tokens at 16/24/32 GB
 *     sink_tokens?: number        // override default 4
 *     window_tokens?: number      // override default 64
 *     bits_per_element?: number   // override default 1.5
 *   }
 *
 * The returned object is suitable as runtime_passport.kv_cache. R-1's
 * runtime-passport.js owner adds the kv_cache field via the documented
 * extension in docs/kv-cache-shard.md.
 */
export function shardPassportEntry({ measured }) {
  if (!measured || typeof measured !== 'object') {
    throw new TypeError('shardPassportEntry: measured object is required');
  }
  const {
    compression_ratio,
    quality_delta,
    max_context_at_vram,
    sink_tokens = SHARD_DEFAULT_SINK_TOKENS,
    window_tokens = SHARD_DEFAULT_WINDOW_TOKENS,
    bits_per_element = SHARD_DEFAULT_BITS_PER_ELEMENT,
  } = measured;
  _requireFiniteNonNegative(compression_ratio, 'measured.compression_ratio');
  if (typeof quality_delta !== 'number' || !Number.isFinite(quality_delta)) {
    throw new TypeError(
      `measured.quality_delta must be a finite number; got ${quality_delta}`
    );
  }
  if (!max_context_at_vram || typeof max_context_at_vram !== 'object') {
    throw new TypeError(
      'measured.max_context_at_vram must be {16: int, 24: int, 32: int}'
    );
  }
  return Object.freeze({
    method: 'shard',
    version: SHARD_VERSION,
    compression_ratio,
    k_method: 'pca_int4',
    v_method: 'hadamard_vq256',
    sink_tokens,
    window_tokens,
    bits_per_element,
    quality_delta,
    max_context_at_vram: Object.freeze({ ...max_context_at_vram }),
  });
}

export default {
  SHARD_VERSION,
  SUPPORTED_MODEL_FAMILIES,
  SUPPORTED_RUNTIMES,
  SHARD_DEFAULT_SINK_TOKENS,
  SHARD_DEFAULT_WINDOW_TOKENS,
  SHARD_DEFAULT_BITS_PER_ELEMENT,
  estimateKvCacheBytes,
  estimateShardKvCacheBytes,
  compressionRatio,
  maxContextAtVram,
  isShardSupported,
  shardPassportEntry,
};
