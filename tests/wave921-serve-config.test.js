// tests/wave921-serve-config.test.js
//
// W921 Run / Serve & Deploy — deterministic serve-config picker tests.
//
// Covers all five pickers in src/serve-config.js:
//   1. quantized-GEMM kernel oracle (Marlin/Machete/MoE-Marlin/W4A8/FP8/NVFP4)
//   2. KV-cache policy dispatch + per-runtime capability gate
//   3. EAGLE-2/3 self-speculative decoding resolution + vLLM/SGLang/llama.cpp args
//   4. serving features (prefix/radix cache + chunked prefill + batched tokens)
//   5. multi-LoRA serving plan
// plus the buildServeConfig() composer.
//
// No GPU, no network, no server boot — every input is a synthetic descriptor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVE_CONFIG_VERSION,
  parseComputeCapability,
  kernelCapabilityForCC,
  quantDescriptorFromArtifact,
  vllmQuantizationString,
  resolveServingKernel,
  servingKernelPassportEntry,
  KV_POLICIES,
  resolveWorkloadPolicy,
  selectKvCachePolicy,
  kvPolicyPassportEntry,
  emitKvPolicyVllmConfig,
  EAGLE_HEAD_REGISTRY,
  resolveEagleHead,
  buildVllmSpeculativeConfig,
  buildSglangSpecArgs,
  buildLlamaCppDraftArgs,
  speculativeHeadPassportEntry,
  resolveServingFeatures,
  emitVllmServeArgs,
  emitSglangServeArgs,
  parseLoraModulesFlag,
  estimateAdapterPoolVram,
  planMultiLora,
  buildServeConfig,
  formatServeConfigReport,
} from '../src/serve-config.js';

// ===========================================================================
// 0. compute-capability parsing
// ===========================================================================

test('parseComputeCapability handles dotted, sm_, and Blackwell forms', () => {
  assert.deepEqual(
    { major: parseComputeCapability('8.9').major, minor: parseComputeCapability('8.9').minor },
    { major: 8, minor: 9 });
  assert.equal(parseComputeCapability('10.0').major, 10);
  assert.equal(parseComputeCapability('sm_90a').major, 9);
  assert.equal(parseComputeCapability('sm_90a').suffix, 'a');
  assert.equal(parseComputeCapability('sm_100').major, 10);
  assert.equal(parseComputeCapability('90').major, 9);
  assert.equal(parseComputeCapability(null).major, null);
  assert.equal(parseComputeCapability('apple-silicon').major, null);
});

// ===========================================================================
// 1. KERNEL ORACLE
// ===========================================================================

test('kernelCapabilityForCC golden table', () => {
  const cc70 = kernelCapabilityForCC('7.0');
  assert.equal(cc70.marlin_w4a16, false);
  assert.equal(cc70.fp8_marlin_w8a16, false);

  const cc75 = kernelCapabilityForCC('7.5');
  assert.equal(cc75.fp8_marlin_w8a16, true);   // weight-only FP8 from Turing
  assert.equal(cc75.marlin_w4a16, false);       // Marlin W4A16 needs sm_80

  const cc80 = kernelCapabilityForCC('8.0');
  assert.equal(cc80.marlin_w4a16, true);
  assert.equal(cc80.w4a8_int8, true);
  assert.equal(cc80.w4a8_fp8, false);           // FP8 act needs sm_89
  assert.equal(cc80.machete_w4a16, false);
  assert.equal(cc80.nvfp4_w4a4, false);

  const cc89 = kernelCapabilityForCC('8.9');
  assert.equal(cc89.w4a8_fp8, true);
  assert.equal(cc89.fp8_w8a8, true);
  assert.equal(cc89.machete_w4a16, false);

  const cc90 = kernelCapabilityForCC('9.0');
  assert.equal(cc90.machete_w4a16, true);
  assert.equal(cc90.nvfp4_w4a4, false);

  const cc100 = kernelCapabilityForCC('10.0');
  assert.equal(cc100.nvfp4_w4a4, true);
  assert.equal(cc100.machete_w4a16, false);     // Machete is Hopper-only
});

test('quantDescriptorFromArtifact parses a kolm gptq envelope', () => {
  const d = quantDescriptorFromArtifact({ method: 'gptq', bits: 4, group_size: 128, sym: true, desc_act: true });
  assert.equal(d.method, 'gptq');
  assert.equal(d.weight_bits, 4);
  assert.equal(d.group_size, 128);
  assert.equal(d.sym, true);
  assert.equal(d.desc_act, true);
  assert.equal(d.activation_dtype, 'fp16');
  assert.equal(d.is_moe, false);
});

test('quantDescriptorFromArtifact infers bits + MoE from base_model', () => {
  const d = quantDescriptorFromArtifact({ quantization: 'awq', base_model: 'Qwen/Qwen2-57B-A14B-MoE' });
  assert.equal(d.method, 'awq');
  assert.equal(d.weight_bits, 4);
  assert.equal(d.is_moe, true);
  const fp8 = quantDescriptorFromArtifact({ method: 'fp8' });
  assert.equal(fp8.weight_bits, 8);
  assert.equal(fp8.activation_dtype, 'fp8_e4m3');
});

test('quantDescriptorFromArtifact on a non-quantized manifest -> null method', () => {
  assert.equal(quantDescriptorFromArtifact({ base_model: 'Qwen/Qwen2.5-7B-Instruct' }).method, null);
  assert.equal(quantDescriptorFromArtifact(null).method, null);
});

test('resolveServingKernel: AWQ w4g128 on sm_89 -> awq_marlin + fp8 kv', () => {
  const d = quantDescriptorFromArtifact({ method: 'awq', bits: 4, group_size: 128, sym: true });
  const r = resolveServingKernel(d, '8.9');
  assert.equal(r.kernel, 'awq_marlin');
  assert.equal(r.vllm_quantization, 'awq_marlin');
  assert.equal(r.kv_cache_dtype, 'auto'); // sm_89 major<9 -> auto kv
  assert.equal(r.supported, true);
  assert.equal(r.gate.blocked, false);
  assert.ok(r.est_speedup_x > 9);          // ~10.9x
});

test('resolveServingKernel: GPTQ w4 on sm_80 -> gptq_marlin ~2.6x', () => {
  const d = quantDescriptorFromArtifact({ method: 'gptq', bits: 4, group_size: 128 });
  const r = resolveServingKernel(d, '8.0');
  assert.equal(r.kernel, 'gptq_marlin');
  assert.equal(r.vllm_quantization, 'gptq_marlin');
  assert.ok(r.est_speedup_x >= 2.5 && r.est_speedup_x < 3);
});

test('resolveServingKernel: GPTQ on Hopper -> Machete (prefer)', () => {
  const d = quantDescriptorFromArtifact({ method: 'gptq', bits: 4, group_size: 128 });
  const r = resolveServingKernel(d, '9.0');
  assert.equal(r.kernel, 'machete');
  assert.equal(r.vllm_quantization, 'gptq_marlin');
  assert.equal(r.kv_cache_dtype, 'fp8');   // Hopper sm_90 -> fp8 kv
});

test('resolveServingKernel: NVFP4 on Hopper -> blocked with fallback chain', () => {
  const d = quantDescriptorFromArtifact({ method: 'nvfp4', bits: 4 });
  const r = resolveServingKernel(d, '9.0');
  assert.equal(r.supported, false);
  assert.equal(r.gate.blocked, true);
  assert.ok(r.fallback_chain.length > 0);
  assert.equal(r.est_speedup_x, null);
});

test('resolveServingKernel: NVFP4 on Blackwell -> modelopt', () => {
  const d = quantDescriptorFromArtifact({ method: 'nvfp4', bits: 4 });
  const r = resolveServingKernel(d, '10.0');
  assert.equal(r.kernel, 'nvfp4');
  assert.equal(r.vllm_quantization, 'modelopt');
  assert.equal(r.supported, true);
});

test('resolveServingKernel: W4A8-FP8 on Ampere sm_80 -> blocked, fall to W4A16 Marlin', () => {
  const d = quantDescriptorFromArtifact({ method: 'gptq', bits: 4, group_size: 128, activation_dtype: 'fp8_e4m3' });
  const r = resolveServingKernel(d, '8.0');
  assert.equal(r.supported, false);
  assert.equal(r.gate.blocked, true);
  assert.ok(r.fallback_chain.includes('gptq_marlin'));
});

test('resolveServingKernel: W4A8-FP8 on Ada sm_89 -> marlin_w4a8_fp8', () => {
  const d = quantDescriptorFromArtifact({ method: 'awq', bits: 4, group_size: 128, activation_dtype: 'fp8_e4m3' });
  const r = resolveServingKernel(d, '8.9');
  assert.equal(r.kernel, 'marlin_w4a8_fp8');
  assert.equal(r.supported, true);
});

test('resolveServingKernel: non-Marlin group_size -> raw gptq, not blocked', () => {
  const d = quantDescriptorFromArtifact({ method: 'gptq', bits: 4, group_size: 100 });
  const r = resolveServingKernel(d, '8.9');
  assert.equal(r.kernel, 'gptq');
  assert.equal(r.vllm_quantization, 'gptq');
  assert.equal(r.gate.blocked, false);
  assert.match(r.gate.reason, /group_size 100/);
});

test('resolveServingKernel: AWQ MoE -> moe_marlin flagged advisory', () => {
  const d = quantDescriptorFromArtifact({ method: 'awq', bits: 4, group_size: 128, is_moe: true });
  const r = resolveServingKernel(d, '8.9');
  assert.equal(r.kernel, 'moe_marlin');
  assert.match(r.gate.reason, /fused Triton MoE is faster/);
});

test('resolveServingKernel: FP8 on Turing sm_75 -> weight-only fp8_marlin', () => {
  const d = quantDescriptorFromArtifact({ method: 'fp8' });
  const r = resolveServingKernel(d, '7.5');
  assert.equal(r.kernel, 'fp8_marlin');
  assert.equal(r.vllm_quantization, 'fp8');
});

test('resolveServingKernel: compressed-tensors W4A8-INT warns silent-W4A16', () => {
  const d = quantDescriptorFromArtifact({ method: 'compressed-tensors', bits: 4, activation_dtype: 'int8' });
  const r = resolveServingKernel(d, '8.9');
  assert.equal(r.vllm_quantization, 'compressed-tensors');
  assert.match(r.gate.reason, /38064|W4A16/);
});

test('resolveServingKernel: no quant -> kernel none, never throws', () => {
  const r = resolveServingKernel({ method: null }, '8.9');
  assert.equal(r.kernel, 'none');
  assert.equal(r.vllm_quantization, null);
  assert.equal(r.supported, true);
});

test('vllmQuantizationString maps every kernel', () => {
  assert.equal(vllmQuantizationString('awq_marlin'), 'awq_marlin');
  assert.equal(vllmQuantizationString('machete'), 'gptq_marlin');
  assert.equal(vllmQuantizationString('fp8_marlin'), 'fp8');
  assert.equal(vllmQuantizationString('nvfp4'), 'modelopt');
  assert.equal(vllmQuantizationString('unknown-xyz'), null);
});

test('servingKernelPassportEntry: estimated vs tested', () => {
  const r = resolveServingKernel(quantDescriptorFromArtifact({ method: 'awq', bits: 4, group_size: 128 }), '8.9');
  const est = servingKernelPassportEntry({ resolved: r, compute_capability: '8.9' });
  assert.equal(est.status, 'estimated');
  assert.equal(est.measured_speedup_x, null);
  const tested = servingKernelPassportEntry({ resolved: r, compute_capability: '8.9', measured: { tok_s: 700, baseline_tok_s: 100 } });
  assert.equal(tested.status, 'tested');
  assert.equal(tested.measured_speedup_x, 7);
  assert.ok(Object.isFrozen(tested));
});

// ===========================================================================
// 2. KV-CACHE POLICY
// ===========================================================================

test('resolveWorkloadPolicy maps every workload', () => {
  assert.equal(resolveWorkloadPolicy('chat'), 'streaming');
  assert.equal(resolveWorkloadPolicy('streaming'), 'streaming');
  assert.equal(resolveWorkloadPolicy('qa'), 'snapkv');
  assert.equal(resolveWorkloadPolicy('rag'), 'snapkv');
  assert.equal(resolveWorkloadPolicy('tight_vram'), 'kivi2');
  assert.equal(resolveWorkloadPolicy('long_context'), 'h2o');
  assert.equal(resolveWorkloadPolicy('general'), 'h2o');
});

test('selectKvCachePolicy: auto routing by workload on transformers', () => {
  const chat = selectKvCachePolicy({ format: 'transformers', workload: 'chat', requested: 'auto' });
  assert.equal(chat.policy, 'streaming');
  assert.equal(chat.runtime_can_enforce, true);
  assert.equal(chat.params.sink_tokens, 4);

  const rag = selectKvCachePolicy({ format: 'transformers', workload: 'rag', requested: 'auto' });
  assert.equal(rag.policy, 'snapkv');
  assert.equal(rag.params.window_tokens, 64);
});

test('selectKvCachePolicy: eviction press on vLLM -> not enforceable, falls back to kivi2', () => {
  const r = selectKvCachePolicy({ format: 'vllm', requested: 'snapkv' });
  assert.equal(r.policy, 'snapkv');
  assert.equal(r.runtime_can_enforce, false);
  assert.equal(r.fallback, 'kivi2');
  assert.match(r.reason, /transformers engine/);
});

test('selectKvCachePolicy: kivi2 enforceable on both transformers and vllm', () => {
  assert.equal(selectKvCachePolicy({ format: 'transformers', requested: 'kivi2' }).runtime_can_enforce, true);
  assert.equal(selectKvCachePolicy({ format: 'vllm', requested: 'kivi2' }).runtime_can_enforce, true);
});

test('selectKvCachePolicy: param validation rejects bad budget and nbits', () => {
  const badBudget = selectKvCachePolicy({ format: 'transformers', requested: 'snapkv', budget: 2.0 });
  assert.equal(badBudget.runtime_can_enforce, false);
  assert.match(badBudget.reason, /invalid budget/);
  const badNbits = selectKvCachePolicy({ format: 'transformers', requested: 'kivi2', group_size: 32 });
  // kivi2 default nbits=2 is valid:
  assert.equal(badNbits.runtime_can_enforce, true);
});

test('selectKvCachePolicy: off + unknown policy', () => {
  assert.equal(selectKvCachePolicy({ requested: 'off' }).policy, 'off');
  const unk = selectKvCachePolicy({ requested: 'bogus' });
  assert.equal(unk.policy, 'off');
  assert.match(unk.reason, /unknown kv policy/);
});

test('selectKvCachePolicy: shard remains selectable', () => {
  const r = selectKvCachePolicy({ format: 'transformers', requested: 'shard' });
  assert.equal(r.policy, 'shard');
  assert.equal(r.kind, 'compress');
  assert.equal(r.runtime_can_enforce, true);
});

test('KV_POLICIES registry has all named policies', () => {
  for (const p of ['off', 'streaming', 'h2o', 'snapkv', 'pyramidkv', 'kivi2', 'kivi4', 'shard']) {
    assert.ok(KV_POLICIES[p], `missing policy ${p}`);
  }
});

test('kvPolicyPassportEntry: estimated vs tested + freeze', () => {
  const est = kvPolicyPassportEntry({ policy: 'snapkv', params: { budget: 0.5 } });
  assert.equal(est.status, 'estimated');
  assert.equal(est.compression_ratio, null);
  const tested = kvPolicyPassportEntry({ policy: 'snapkv', params: { budget: 0.5 }, measured: { compression_ratio: 0.5, peak_kv_mb: 2048, retained_tokens: 512, evicted_tokens: 512, quality_delta: -0.01 } });
  assert.equal(tested.status, 'tested');
  assert.equal(tested.compression_ratio, 0.5);
  assert.ok(Object.isFrozen(tested));
});

test('emitKvPolicyVllmConfig honors only what vLLM enforces', () => {
  const evic = emitKvPolicyVllmConfig('snapkv', 'auto');
  assert.match(evic.note, /PagedAttention.*cannot enforce/);
  const quant = emitKvPolicyVllmConfig('kivi2', 'auto');
  assert.equal(quant.kv_cache_dtype, 'fp8');
  assert.match(quant.note, /quant axis/);
});

// ===========================================================================
// 3. EAGLE SPECULATIVE DECODING
// ===========================================================================

test('resolveEagleHead: manifest head wins over registry', () => {
  const r = resolveEagleHead({
    target: 'meta-llama/llama-3.1-8b-instruct',
    manifest: { speculative_decoding: { head_kind: 'eagle3', head_id: 'kolm/my-trained-eagle3' } },
    runtime: 'vllm',
  });
  assert.equal(r.source, 'manifest');
  assert.equal(r.head_id, 'kolm/my-trained-eagle3');
  assert.equal(r.head_kind, 'eagle3');
  assert.equal(r.eagle_topk, 8);
  assert.equal(r.num_steps, 5);
  assert.equal(r.supported, true);
});

test('resolveEagleHead: auto -> registry head for known target', () => {
  const r = resolveEagleHead({ target: 'meta-llama/llama-3.1-8b-instruct', runtime: 'vllm', flag: 'auto' });
  assert.equal(r.source, 'registry');
  assert.equal(r.head_id, EAGLE_HEAD_REGISTRY['meta-llama/llama-3.1-8b-instruct']);
  assert.equal(r.head_kind, 'eagle3');
});

test('resolveEagleHead: unknown target falls to injected pairing picker', () => {
  const r = resolveEagleHead({
    target: 'qwen/qwen2.5-7b-instruct',
    runtime: 'vllm',
    flag: 'auto',
    draftPicker: (t) => (t === 'qwen/qwen2.5-7b-instruct' ? 'Qwen/Qwen2.5-1.5B-Instruct' : null),
  });
  assert.equal(r.source, 'pairing');
  assert.equal(r.head_kind, 'draft_model');
  assert.equal(r.head_id, 'Qwen/Qwen2.5-1.5B-Instruct');
});

test('resolveEagleHead: no head + no picker -> null', () => {
  assert.equal(resolveEagleHead({ target: 'some/unknown-model', runtime: 'vllm', flag: 'auto' }), null);
});

test('resolveEagleHead: explicit off', () => {
  const r = resolveEagleHead({ target: 'meta-llama/llama-3.1-8b-instruct', runtime: 'vllm', flag: 'off' });
  assert.equal(r.supported, false);
  assert.equal(r.num_speculative_tokens, 0);
});

test('resolveEagleHead: explicit concrete head id', () => {
  const r = resolveEagleHead({ target: 'x/y', runtime: 'vllm', flag: 'custom/eagle3-head' });
  assert.equal(r.source, 'explicit');
  assert.equal(r.head_id, 'custom/eagle3-head');
});

test('buildVllmSpeculativeConfig: eagle3 modern dict, NO flat kwargs', () => {
  const r = resolveEagleHead({ target: 'meta-llama/llama-3.1-8b-instruct', runtime: 'vllm', flag: 'auto' });
  const cfg = buildVllmSpeculativeConfig(r, { tp: 2 });
  assert.equal(cfg.method, 'eagle3');
  assert.equal(cfg.model, EAGLE_HEAD_REGISTRY['meta-llama/llama-3.1-8b-instruct']);
  assert.equal(cfg.num_speculative_tokens, 5);
  assert.equal(cfg.draft_tensor_parallel_size, 2);
  // No deprecated flat kwargs:
  assert.equal('speculative_model' in cfg, false);
  assert.equal('draft_model_type' in cfg, false);
});

test('buildVllmSpeculativeConfig: draft_model standard config', () => {
  const r = resolveEagleHead({ target: 'x/y', runtime: 'vllm', flag: 'some/draft-1b' });
  const cfg = buildVllmSpeculativeConfig(r, { tp: 1 });
  assert.equal(cfg.model, 'some/draft-1b');
  assert.equal('method' in cfg, false);
  assert.equal(cfg.num_speculative_tokens, 5);
});

test('buildVllmSpeculativeConfig: off/unsupported -> null', () => {
  assert.equal(buildVllmSpeculativeConfig(resolveEagleHead({ target: 'meta-llama/llama-3.1-8b-instruct', flag: 'off' })), null);
  assert.equal(buildVllmSpeculativeConfig(null), null);
});

test('buildSglangSpecArgs: EAGLE3 round-trips documented flags', () => {
  const r = resolveEagleHead({ target: 'qwen/qwen3-8b', runtime: 'sglang', flag: 'auto' });
  const args = buildSglangSpecArgs(r);
  assert.ok(args.includes('--speculative-algorithm'));
  assert.ok(args.includes('EAGLE3'));
  assert.ok(args.includes('--speculative-draft-model-path'));
  assert.ok(args.includes('--speculative-num-steps'));
  assert.ok(args.includes('--speculative-eagle-topk'));
});

test('buildSglangSpecArgs: draft_model has no EAGLE algo -> empty', () => {
  const r = resolveEagleHead({ target: 'x/y', runtime: 'sglang', flag: 'some/draft' });
  assert.deepEqual(buildSglangSpecArgs(r), []);
});

test('buildLlamaCppDraftArgs: only for separate-draft GGUF', () => {
  const draft = resolveEagleHead({ target: 'x/y', runtime: 'llama.cpp', flag: '/models/draft.gguf' });
  const args = buildLlamaCppDraftArgs(draft);
  assert.ok(args.includes('--model-draft'));
  assert.ok(args.includes('/models/draft.gguf'));
  assert.ok(args.includes('--draft-max'));
  // EAGLE head -> empty (not supported upstream)
  const eagle = resolveEagleHead({ target: 'meta-llama/llama-3.1-8b-instruct', runtime: 'llama.cpp', flag: 'auto' });
  assert.deepEqual(buildLlamaCppDraftArgs(eagle), []);
});

test('speculativeHeadPassportEntry validates ranges + freezes', () => {
  const ok = speculativeHeadPassportEntry({ measured: { head_kind: 'eagle3', head_id: 'h', target_model: 't', runtime: 'vllm', num_speculative_tokens: 5, acceptance_rate: 0.8, accepted_length: 6.2 } });
  assert.equal(ok.status, 'tested');
  assert.equal(ok.acceptance_rate, 0.8);
  assert.ok(Object.isFrozen(ok));
  const est = speculativeHeadPassportEntry({ measured: { head_kind: 'eagle3', head_id: 'h', target_model: 't', runtime: 'vllm', num_speculative_tokens: 5 } });
  assert.equal(est.status, 'estimated');
  assert.equal(est.acceptance_rate, null);
  assert.throws(() => speculativeHeadPassportEntry({ measured: { head_kind: 'bogus' } }), /head_kind/);
  assert.throws(() => speculativeHeadPassportEntry({ measured: { head_kind: 'eagle3', acceptance_rate: 1.5 } }), /acceptance_rate/);
});

// ===========================================================================
// 4. SERVING FEATURES
// ===========================================================================

test('resolveServingFeatures decision table: latency=2048, agent=8192, default=4096', () => {
  assert.equal(resolveServingFeatures({ workload: 'latency' }).max_num_batched_tokens, 2048);
  assert.equal(resolveServingFeatures({ workload: 'agent' }).max_num_batched_tokens, 8192);
  assert.equal(resolveServingFeatures({ workload: 'throughput' }).max_num_batched_tokens, 8192);
  assert.equal(resolveServingFeatures({ workload: 'general' }).max_num_batched_tokens, 4096);
});

test('resolveServingFeatures: prefix_cache off only on one-shot batch + tight VRAM', () => {
  const tight = resolveServingFeatures({ workload: 'one-shot-batch', hardware: { vram_gb: 16 } });
  assert.equal(tight.prefix_cache, false);
  const roomy = resolveServingFeatures({ workload: 'one-shot-batch', hardware: { vram_gb: 80 } });
  assert.equal(roomy.prefix_cache, true);
});

test('resolveServingFeatures: MLA model disables prefix + chunked prefill', () => {
  const r = resolveServingFeatures({ workload: 'agent', manifest: { base_model: 'deepseek-ai/DeepSeek-V3' } });
  assert.equal(r.prefix_cache, false);
  assert.equal(r.chunked_prefill, false);
});

test('emitVllmServeArgs exact arg arrays', () => {
  const on = emitVllmServeArgs({ prefix_cache: true, chunked_prefill: true, max_num_batched_tokens: 8192, max_num_seqs: 8 });
  assert.deepEqual(on, ['--enable-prefix-caching', '--enable-chunked-prefill', '--max-num-batched-tokens', '8192', '--max-num-seqs', '8']);
  const off = emitVllmServeArgs({ prefix_cache: false, chunked_prefill: false, max_num_batched_tokens: 2048 });
  assert.ok(off.includes('--no-enable-prefix-caching'));
  assert.equal(off.includes('--enable-chunked-prefill'), false);
});

test('emitSglangServeArgs includes radix cache + chunked-prefill-size', () => {
  const a = emitSglangServeArgs({ prefix_cache: true, max_num_batched_tokens: 8192 });
  assert.ok(a.includes('--enable-radix-cache'));
  assert.ok(a.includes('--chunked-prefill-size'));
  assert.ok(a.includes('8192'));
});

test('resolveServingFeatures env contract', () => {
  const r = resolveServingFeatures({ workload: 'agent' });
  assert.equal(r.env.KOLM_PROMPT_CACHE, 'on');
  assert.equal(r.env.KOLM_CHUNKED_PREFILL, 'on');
  assert.equal(r.env.KOLM_MAX_NUM_BATCHED_TOKENS, '8192');
  assert.equal(r.vllm_config.enable_prefix_caching, true);
});

// ===========================================================================
// 5. MULTI-LORA
// ===========================================================================

test('parseLoraModulesFlag handles id=path, list, and bare path', () => {
  assert.deepEqual(parseLoraModulesFlag('refund=/a,pii=/b'), [{ id: 'refund', path: '/a' }, { id: 'pii', path: '/b' }]);
  assert.deepEqual(parseLoraModulesFlag(['x=/p']), [{ id: 'x', path: '/p' }]);
  const bare = parseLoraModulesFlag('/var/kolm/adapters/refund');
  assert.equal(bare[0].id, 'refund');
  assert.deepEqual(parseLoraModulesFlag(''), []);
});

test('estimateAdapterPoolVram scales with adapters + reports base', () => {
  const v = estimateAdapterPoolVram([{ rank: 16 }, { rank: 32 }], 3, 0, { hidden_size: 2048, num_layers: 36 });
  assert.ok(v.base_mb > 0);
  assert.ok(v.pool_mb > 0);
  assert.ok(v.est_vram_mb >= v.base_mb);
  assert.equal(v.fits, true); // no budget -> fits
});

test('estimateAdapterPoolVram fit check against budget', () => {
  const big = estimateAdapterPoolVram([{ rank: 16 }], 70, 0, { vram_budget_mb: 16 * 1024 });
  assert.equal(big.fits, false); // 70B base won't fit in 16GB
});

test('planMultiLora: vLLM with manifest adapters -> enable-lora args', () => {
  const plan = planMultiLora(
    { base_model: 'Qwen/Qwen2.5-3B-Instruct', lora_modules: [{ id: 'refund', path: '/a' }, { id: 'pii', path: '/b' }], lora_rank: 16, params_b: 3 },
    { primary: { vram_gb: 32 } },
    { runtime: 'vllm' });
  assert.equal(plan.ok, true);
  assert.equal(plan.enable_lora, true);
  assert.ok(plan.vllm_args.includes('--enable-lora'));
  assert.ok(plan.vllm_args.includes('--max-loras'));
  assert.equal(plan.env.KOLM_ENABLE_LORA, '1');
  assert.match(plan.env.KOLM_LORA_MODULES, /refund=\/a/);
});

test('planMultiLora: non-vLLM runtime not supported', () => {
  const plan = planMultiLora({ base_model: 'x', lora_modules: [{ id: 'a', path: '/p' }] }, { primary: { vram_gb: 32 } }, { runtime: 'llama.cpp' });
  assert.equal(plan.supported, false);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /requires the vLLM runtime/);
});

test('planMultiLora: no adapters -> honest reason', () => {
  const plan = planMultiLora({ base_model: 'x' }, { primary: { vram_gb: 32 } }, { runtime: 'vllm' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no LoRA adapters/);
});

// ===========================================================================
// COMPOSER
// ===========================================================================

test('buildServeConfig: end-to-end AWQ Llama-3.1-8B on Ada, agent workload', () => {
  const cfg = buildServeConfig({
    manifest: {
      base_model: 'meta-llama/llama-3.1-8b-instruct',
      method: 'awq', bits: 4, group_size: 128, sym: true,
    },
    hardware: { primary: { vram_gb: 24, compute_capability: '8.9' } },
    workload: 'agent',
    runtime: 'vllm',
    requested: { speculative: 'auto' },
  });
  assert.equal(cfg.version, SERVE_CONFIG_VERSION);
  assert.equal(cfg.kernel.kernel, 'awq_marlin');
  assert.equal(cfg.vllm.quantization, 'awq_marlin');
  assert.equal(cfg.speculative.head_kind, 'eagle3');
  // vLLM arg list contains the kernel + serving features + spec is in config dict
  assert.ok(cfg.vllm.args.includes('--quantization'));
  assert.ok(cfg.vllm.args.includes('awq_marlin'));
  assert.ok(cfg.vllm.args.includes('--enable-prefix-caching'));
  assert.equal(cfg.vllm.speculative_config.method, 'eagle3');
  // env contract is populated
  assert.equal(cfg.env.KOLM_SERVE_QUANTIZATION, 'awq_marlin');
  assert.ok(cfg.env.KOLM_KV_POLICY.length > 0);
  // dry-run report renders without throwing
  const report = formatServeConfigReport(cfg);
  assert.match(report, /awq_marlin/);
  assert.match(report, /eagle3/);
});

test('buildServeConfig: no quant + no spec head -> clean off states, never throws', () => {
  const cfg = buildServeConfig({
    manifest: { base_model: 'some/unknown-7b' },
    hardware: { primary: { vram_gb: 16, compute_capability: '8.6' } },
    workload: 'chat',
    runtime: 'transformers',
  });
  assert.equal(cfg.kernel.kernel, 'none');
  assert.equal(cfg.speculative, null);
  assert.equal(cfg.kv.policy, 'streaming'); // chat -> streaming on transformers
  assert.equal(cfg.kv.runtime_can_enforce, true);
});

test('buildServeConfig: vLLM eviction policy reports not-enforceable', () => {
  const cfg = buildServeConfig({
    manifest: { base_model: 'some/unknown-7b' },
    hardware: { primary: { vram_gb: 80, compute_capability: '9.0' } },
    workload: 'rag',
    runtime: 'vllm',
  });
  assert.equal(cfg.kv.policy, 'snapkv');
  assert.equal(cfg.kv.runtime_can_enforce, false);
  assert.equal(cfg.kv.fallback, 'kivi2');
});
