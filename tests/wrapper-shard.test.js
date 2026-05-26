// tests/wrapper-shard.test.js
//
// W3-SHARD — Module-shape + memory-math tests for the Shard KV cache
// integration (src/kv-cache-shard.js + src/kv-cache-policy.js).
//
// These tests do NOT execute Shard itself. They pin the module API contract
// + the memory math that the runtime passport, the memory-fit calculator,
// and the policy selector all depend on.
//
// 10 tests, all sub-100ms:
//
//   #1  SHARD_VERSION is 'kolm-shard/1'
//   #2  SUPPORTED_MODEL_FAMILIES includes llama, qwen, mistral, gemma, deepseek
//   #3  estimateKvCacheBytes for Qwen-2.5-7B at 8K  ~ 1.0 GB (within 10%)
//   #4  estimateShardKvCacheBytes for same model at 8K ~ 100 MB (within 20%)
//   #5  compressionRatio at 8K is between 8.0 and 12.0 (the 10x ballpark)
//   #6  maxContextAtVram with use_shard=true is >= 4x the no-shard ceiling
//   #7  isShardSupported({qwen2.5, vllm, has_rope:true}) => true
//   #8  isShardSupported({gpt2-non-rope, llama.cpp, has_rope:false}) => false
//   #9  selectKvCache({requested:'auto', valid family}) => backend:'shard'
//   #10 selectKvCache({requested:'default'}) => backend:'default' always

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARD_VERSION,
  SUPPORTED_MODEL_FAMILIES,
  SUPPORTED_RUNTIMES,
  estimateKvCacheBytes,
  estimateShardKvCacheBytes,
  compressionRatio,
  maxContextAtVram,
  isShardSupported,
  shardPassportEntry,
} from '../src/kv-cache-shard.js';
import { selectKvCache, formatPolicyReport } from '../src/kv-cache-policy.js';

// Qwen2.5-7B-Instruct config (from HF config.json):
//   num_hidden_layers      = 28
//   num_key_value_heads    = 4   (GQA — much smaller than Q heads)
//   head_dim               = 128
//
// Per-token KV slots = 2 * 28 * 4 * 128 = 28,672 elements
// At FP16 (2 bytes/element) that's 57,344 bytes/token = 56 KiB/token.
// At 8192 tokens, default = 8192 * 57,344 = ~469 MB.
// At 8192 tokens, Shard = (4+64)*57,344 + (8192-68)*28,672*0.1875
//                       = 3,899,392 + 43,690,432
//                       = ~47,589,824 bytes (~45 MB).
// Compression at 8K = ~9.86x.
//
// NOTE: the task brief's "~1.0 GB / ~100 MB at 8K" target was computed
// against a non-GQA proxy (num_key_value_heads = 28). With real GQA both
// numbers scale down by 7x but the RATIO (the actual contract under test)
// is unchanged at ~10x. We keep the realistic GQA config and assert on the
// ratio + the absolute bytes consistent with it.
const QWEN_2_5_7B = Object.freeze({
  num_hidden_layers: 28,
  num_key_value_heads: 4,
  head_dim: 128,
});

const CTX_8K = 8192;

test('shard #1 — SHARD_VERSION is kolm-shard/1', () => {
  assert.equal(SHARD_VERSION, 'kolm-shard/1');
});

test('shard #2 — SUPPORTED_MODEL_FAMILIES covers the headline families', () => {
  for (const fam of ['llama', 'qwen', 'mistral', 'gemma', 'deepseek']) {
    assert.ok(
      SUPPORTED_MODEL_FAMILIES.includes(fam),
      `expected ${fam} in SUPPORTED_MODEL_FAMILIES; got ${SUPPORTED_MODEL_FAMILIES.join(',')}`
    );
  }
  // Also confirm SUPPORTED_RUNTIMES is the documented HF-Cache pair.
  assert.ok(SUPPORTED_RUNTIMES.includes('transformers'));
  assert.ok(SUPPORTED_RUNTIMES.includes('vllm'));
});

test('shard #3 — estimateKvCacheBytes for Qwen-2.5-7B at 8K is consistent', () => {
  const bytes = estimateKvCacheBytes({ ...QWEN_2_5_7B, context_length: CTX_8K });
  // Expected: 2 * 28 * 4 * 128 * 8192 * 2 = 469,762,048 bytes = ~448 MiB.
  const expected = 2 * 28 * 4 * 128 * 8192 * 2;
  assert.equal(bytes, expected, `default KV bytes mismatch`);
  // Sanity: must be in the hundreds-of-MB range, not GB and not MB.
  assert.ok(bytes > 100 * 1024 * 1024, `default KV must be > 100 MB; got ${bytes}`);
  assert.ok(bytes < 2 * 1024 * 1024 * 1024, `default KV must be < 2 GB; got ${bytes}`);
});

test('shard #4 — estimateShardKvCacheBytes for Qwen-2.5-7B at 8K is consistent', () => {
  const bytes = estimateShardKvCacheBytes({
    ...QWEN_2_5_7B,
    context_length: CTX_8K,
  });
  // Expected:
  //   protectedTokens = 68
  //   compressedTokens = 8124
  //   perTokenSlots = 2*28*4*128 = 28,672
  //   sinkWindow = 28,672 * 68 * 2 = 3,899,392
  //   compressed = 28,672 * 8124 * 0.1875 = 43,675,704
  //   total      = ~47,575,096 (~45 MiB)
  const perTokenSlots = 2 * 28 * 4 * 128;
  const expected =
    perTokenSlots * 68 * 2 + perTokenSlots * (CTX_8K - 68) * (1.5 / 8);
  assert.ok(
    Math.abs(bytes - expected) < 8, // floating-point slack
    `shard KV bytes mismatch; expected ~${expected}, got ${bytes}`
  );
  // Sanity: must be ~10x smaller than default, i.e. tens of MB.
  assert.ok(bytes < 100 * 1024 * 1024, `shard KV must be < 100 MB; got ${bytes}`);
  assert.ok(bytes > 1 * 1024 * 1024, `shard KV must be > 1 MB; got ${bytes}`);
});

test('shard #5 — compressionRatio at 8K is in the [8.0, 12.0] ballpark', () => {
  const ratio = compressionRatio({ ...QWEN_2_5_7B, context_length: CTX_8K });
  assert.ok(ratio >= 8.0, `compression ratio must be >= 8.0; got ${ratio}`);
  assert.ok(ratio <= 12.0, `compression ratio must be <= 12.0; got ${ratio}`);
});

test('shard #6 — maxContextAtVram with use_shard returns >= 4x the no-shard ceiling', () => {
  const vram = 2e9; // 2 GB earmarked for KV
  const noShard = maxContextAtVram({
    vram_bytes_for_kv: vram,
    model_arch: QWEN_2_5_7B,
    use_shard: false,
  });
  const withShard = maxContextAtVram({
    vram_bytes_for_kv: vram,
    model_arch: QWEN_2_5_7B,
    use_shard: true,
  });
  assert.ok(noShard > 0, `no-shard ceiling must be > 0; got ${noShard}`);
  assert.ok(
    withShard >= 4 * noShard,
    `shard ceiling (${withShard}) must be >= 4x no-shard (${noShard})`
  );
});

test('shard #7 — isShardSupported({qwen2.5, vllm, has_rope:true}) is true', () => {
  const r = isShardSupported({
    model_family: 'qwen2.5',
    runtime: 'vllm',
    has_rope: true,
  });
  assert.equal(r.supported, true, `expected supported=true; got ${JSON.stringify(r)}`);
});

test('shard #8 — isShardSupported rejects non-RoPE + non-HF-cache runtime', () => {
  const r = isShardSupported({
    model_family: 'gpt2-non-rope',
    runtime: 'llama.cpp',
    has_rope: false,
  });
  assert.equal(r.supported, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `reason must be a non-empty string`);
});

test('shard #9 — selectKvCache(auto + valid family) chooses shard', () => {
  const policy = selectKvCache({
    format: 'vllm',
    modelMeta: { family: 'qwen2.5', has_rope: true },
    hardware: { vram_gb: 24 },
    requested: 'auto',
  });
  assert.equal(policy.backend, 'shard', `expected shard; got ${JSON.stringify(policy)}`);
  assert.equal(policy.fallback, 'default');
  // formatPolicyReport must produce a multi-line string mentioning the backend.
  const report = formatPolicyReport(policy);
  assert.ok(typeof report === 'string' && report.includes('shard'), `report missing shard mention: ${report}`);
});

test('shard #10 — selectKvCache(requested:default) chooses default regardless', () => {
  const policy = selectKvCache({
    format: 'vllm',
    modelMeta: { family: 'qwen2.5', has_rope: true },
    hardware: { vram_gb: 80 },
    requested: 'default',
  });
  assert.equal(policy.backend, 'default');
  assert.equal(policy.fallback, null);
});

test('shard bonus — shardPassportEntry returns the documented shape', () => {
  const entry = shardPassportEntry({
    measured: {
      compression_ratio: 9.86,
      quality_delta: -0.002,
      max_context_at_vram: { 16: 32_768, 24: 65_536, 32: 131_072 },
    },
  });
  assert.equal(entry.method, 'shard');
  assert.equal(entry.k_method, 'pca_int4');
  assert.equal(entry.v_method, 'hadamard_vq256');
  assert.equal(entry.sink_tokens, 4);
  assert.equal(entry.window_tokens, 64);
  assert.equal(entry.bits_per_element, 1.5);
  assert.equal(entry.compression_ratio, 9.86);
  assert.equal(entry.quality_delta, -0.002);
  assert.equal(entry.max_context_at_vram[16], 32_768);
});
