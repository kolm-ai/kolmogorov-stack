// src/serve-config.js
//
// W921 Run / Serve & Deploy - the deterministic SERVE-CONFIG picker.
//
// One pure module that, given (a hardware profile + a model/artifact descriptor
// + a workload hint), chooses the serving knobs that make a kolm artifact run at
// the speed it was distilled/quantized for, and emits a *valid* vLLM / SGLang /
// llama.cpp launch spec WITHOUT booting a server. Every output is a plain JSON
// object so the caller (CLI banner, deploy generator, runtime-passport probe)
// can render it, diff it, sign it, or hand it to apps/runtime/serve.py via the
// KOLM_* env contract.
//
// The five frontier pickers, all deterministic data + pure functions:
//
//   1. KERNEL ORACLE     resolveServingKernel()      Marlin / Machete / MoE-Marlin
//                        kernelCapabilityForCC()     / W4A8 / FP8 / NVFP4 selection
//                        quantDescriptorFromArtifact() with a hardware gate +
//                        vllmQuantizationString()    safe fallback chain.
//
//   2. KV-CACHE POLICY   selectKvCachePolicy()       StreamingLLM / H2O / SnapKV /
//                        resolveWorkloadPolicy()     PyramidKV / KIVI-2/4 / Shard,
//                        KV_POLICIES registry        with a per-runtime capability
//                        kvPolicyPassportEntry()     gate (eviction = transformers
//                                                    only; quant axis = vLLM too).
//
//   3. SPECULATIVE       resolveEagleHead()          EAGLE-2/EAGLE-3 self-spec
//                        buildVllmSpeculativeConfig()decoding with the MODERN vLLM
//                        buildSglangSpecArgs()       speculative_config dict (no
//                        buildLlamaCppDraftArgs()    deprecated flat kwargs) +
//                        EAGLE_HEAD_REGISTRY         SGLang + llama.cpp arg lists.
//
//   4. SERVING FEATURES  resolveServingFeatures()    prefix/radix prompt caching +
//                        emitVllmServeArgs()         chunked prefill + batched-token
//                        emitSglangServeArgs()       width, emitted identically for
//                                                    serve and deploy (no drift).
//
//   5. MULTI-LORA        planMultiLora()             one base + N adapters on one
//                        parseLoraModulesFlag()      GPU (S-LoRA / vLLM enable-lora)
//                        estimateAdapterPoolVram()   with a VRAM-fit check.
//
// And a top-level composer:
//
//   buildServeConfig({ artifact, hardware, workload, requested })
//      -> { kernel, kv, speculative, features, lora, env, vllm, sglang,
//           llamacpp, reason, version }
//
// Design rules honored throughout:
//   * Deterministic - no wall-clock reads, no Math.random; the only host probe
//     is the caller-supplied `hardware` object (never read implicitly).
//   * Honest gates - an impossible (dtype, compute-capability) triple returns
//     supported:false + gate.blocked + a non-empty fallback_chain rather than a
//     config the runtime would reject or silently degrade.
//   * Additive - this is a NEW module; it imports nothing that mutates existing
//     behavior and changes no existing default.
//
// Sources (cited inline at each gate): vLLM quantization + speculative_config +
// prefix-caching docs, Red Hat Machete article, NVIDIA kvpress, SGLang
// RadixAttention/EAGLE docs, EAGLE-1/2/3 papers (arXiv:2401.15077 / 2406.16858 /
// 2503.01840), KIVI/H2O/SnapKV/PyramidKV/StreamingLLM papers, S-LoRA
// (arXiv:2311.03285).

import { buildItkvProfile, hashItkvProfile } from './itkv-profile.js';

export const SERVE_CONFIG_VERSION = 'serve-config-v1';
export const QUANT_KERNEL_ORACLE_VERSION = 'qko-v1';
export const KV_POLICY_VERSION = 'kv-policy-v2-itkv';
export const EAGLE_RESOLVER_VERSION = 'eagle-resolver-v1';

// ===========================================================================
// Small deterministic helpers (no globals, no wall-clock, no RNG).
// ===========================================================================

function _isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function _lower(s) {
  return typeof s === 'string' ? s.toLowerCase().trim() : '';
}

function _round(n, places = 2) {
  if (!_isFiniteNumber(n)) return null;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

// Parse a compute-capability string ('8.9', '10.0', 'sm_90a', '9.0a') into a
// {major, minor, suffix} triple. Returns {major:null} when unparseable so every
// gate degrades to "not claimed" rather than throwing.
export function parseComputeCapability(cc) {
  if (cc == null) return { major: null, minor: 0, suffix: '', raw: '' };
  const raw = String(cc).trim();
  const m = raw.toLowerCase().match(/(?:sm_)?(\d+)(?:\.(\d+))?([a-z]*)/);
  if (!m) return { major: null, minor: 0, suffix: '', raw };
  let major = parseInt(m[1], 10);
  let minor = m[2] != null ? parseInt(m[2], 10) : 0;
  // sm_90 form: '90' -> major 9 minor 0; '120' -> major 12 minor 0.
  if (!raw.includes('.') && major >= 10 && major < 100) {
    minor = major % 10;
    major = Math.floor(major / 10);
  } else if (!raw.includes('.') && major >= 100) {
    // sm_100 (Blackwell datacenter) -> 10.0
    minor = 0;
    major = Math.floor(major / 10);
  }
  return { major: Number.isFinite(major) ? major : null, minor: Number.isFinite(minor) ? minor : 0, suffix: m[3] || '', raw };
}

// Pull a compute-capability string out of a hardware probe (forge-hardware.js
// detectHardware() shape) or accept a bare cc string / {compute_capability}.
function _ccFromHardware(hardware) {
  if (!hardware) return null;
  if (typeof hardware === 'string') return hardware;
  if (hardware.compute_capability) return hardware.compute_capability;
  if (hardware.primary && hardware.primary.compute_capability) return hardware.primary.compute_capability;
  return null;
}

function _vramGbFromHardware(hardware) {
  if (!hardware || typeof hardware !== 'string') {
    if (hardware && _isFiniteNumber(hardware.vram_gb)) return hardware.vram_gb;
    if (hardware && hardware.primary && _isFiniteNumber(hardware.primary.vram_gb)) return hardware.primary.vram_gb;
  }
  return null;
}

// ===========================================================================
// 1. QUANTIZED-GEMM KERNEL ORACLE
//    (Marlin / Machete / MoE-Marlin / W4A8 / FP8 / NVFP4)
// ===========================================================================
//
// A quantized checkpoint only delivers its throughput win if the engine
// dispatches it through a hardware-optimized mixed-input GEMM. Otherwise vLLM
// falls back to a dequant->FP16 path at-or-below FP16 speed. The selection is a
// pure function of (quant_method, weight_bits, group_size, sym, activation_dtype,
// is_moe, compute_capability). Refs:
//   vLLM quantization matrix  https://docs.vllm.ai/en/latest/features/quantization/
//   Machete (Hopper sm_90a)   https://developers.redhat.com/articles/2024/10/14/introducing-machete-mixed-input-gemm-kernel
//   W4A8 Marlin (sm_89+ fp8)  https://github.com/vllm-project/vllm/pull/24722
//   Fused MoE Triton > MoE Marlin  https://github.com/vllm-project/vllm/pull/12185

// Group sizes Marlin/Machete accept. -1 means per-channel (column-wise) which
// Marlin supports; arbitrary group sizes (e.g. 100) fall back to the slow path.
const MARLIN_GROUP_SIZES = Object.freeze([-1, 32, 64, 128]);

/**
 * Per-compute-capability serving-kernel capability map. Conservative: a cell is
 * true only when the kernel is genuinely available on that SM.
 *
 * @param {string} computeCapability  e.g. '8.0', '8.9', '9.0', '10.0', 'sm_90a'
 * @returns {{sm_major:number, sm_minor:number, marlin_w4a16:boolean,
 *            machete_w4a16:boolean, w4a8_int8:boolean, w4a8_fp8:boolean,
 *            fp8_w8a8:boolean, fp8_marlin_w8a16:boolean, nvfp4_w4a4:boolean,
 *            moe_marlin:boolean}}
 */
export function kernelCapabilityForCC(computeCapability) {
  const { major, minor } = parseComputeCapability(computeCapability);
  const sm = _isFiniteNumber(major) ? major + minor / 10 : 0;
  return Object.freeze({
    sm_major: _isFiniteNumber(major) ? major : 0,
    sm_minor: _isFiniteNumber(major) ? minor : 0,
    // Marlin W4A16: Ampere sm_80+ (mixed-input INT4 weight / FP16 act GEMM).
    marlin_w4a16: sm >= 8.0,
    // Machete W4A16/W8A16: Hopper sm_90a only (CUTLASS 3.5.1, beats Marlin on H100).
    machete_w4a16: major === 9,
    // W4A8 Marlin INT8 activations: sm_80+ (m16n8k32 layout).
    w4a8_int8: sm >= 8.0,
    // W4A8 Marlin FP8(E4M3) activations: Ada sm_89+ (native FP8 tensor cores).
    w4a8_fp8: sm >= 8.9,
    // FP8 W8A8 (CUTLASS): Ada sm_89+ for native FP8 activations.
    fp8_w8a8: sm >= 8.9,
    // Weight-only FP8 W8A16 via fp8_marlin: Turing sm_75+ (no native FP8 needed).
    fp8_marlin_w8a16: sm >= 7.5,
    // NVFP4 W4A4 microscaling: Blackwell sm_100+ (CUDA 12.8).
    nvfp4_w4a4: sm >= 10.0,
    // MoE Marlin (fused_marlin_moe): sm_80+ but known slower than fused Triton MoE.
    moe_marlin: sm >= 8.0,
  });
}

/**
 * Extract a normalized quant descriptor from an artifact manifest or an
 * export-*.js result envelope. Tolerant of several shapes (compressed-tensors
 * quantize_config, kolm export envelopes, bare manifests).
 *
 * @returns {{method:string|null, weight_bits:number|null, group_size:number|null,
 *            sym:boolean, desc_act:boolean, activation_dtype:string, is_moe:boolean}}
 */
export function quantDescriptorFromArtifact(m) {
  const empty = {
    method: null, weight_bits: null, group_size: null,
    sym: true, desc_act: false, activation_dtype: 'fp16', is_moe: false,
  };
  if (!m || typeof m !== 'object') return empty;
  // Drill into common nesting points.
  const q = m.quant_descriptor || m.kernel_descriptor || m.quantization_config ||
            m.quantize_config || m.quantization || m;
  const src = (typeof q === 'object' && q) ? q : m;

  let method = _lower(src.method || src.quant_method || src.quantization ||
                      m.method || m.quant_method || m.quantization);
  // Normalize common aliases.
  if (method.includes('gptq')) method = 'gptq';
  else if (method.includes('awq')) method = 'awq';
  else if (method.includes('nvfp4') || method.includes('fp4')) method = 'nvfp4';
  else if (method.includes('compressed') || method.includes('compressed-tensors')) method = 'compressed-tensors';
  else if (method.includes('fp8')) method = 'fp8';
  else if (!method) method = null;

  let weight_bits = src.weight_bits != null ? Number(src.weight_bits)
                  : src.bits != null ? Number(src.bits)
                  : src.wbits != null ? Number(src.wbits) : null;
  if (!_isFiniteNumber(weight_bits)) {
    if (method === 'fp8') weight_bits = 8;
    else if (method === 'nvfp4') weight_bits = 4;
    else if (method === 'gptq' || method === 'awq') weight_bits = 4;
    else weight_bits = null;
  }

  let group_size = src.group_size != null ? Number(src.group_size)
                 : src.groupsize != null ? Number(src.groupsize) : null;
  if (!_isFiniteNumber(group_size)) group_size = null;

  const sym = src.sym != null ? Boolean(src.sym)
            : src.symmetric != null ? Boolean(src.symmetric) : true;
  const desc_act = src.desc_act != null ? Boolean(src.desc_act)
                 : src.act_order != null ? Boolean(src.act_order) : false;

  let activation_dtype = _lower(src.activation_dtype || src.act_dtype || '');
  if (!activation_dtype) {
    if (method === 'fp8') activation_dtype = 'fp8_e4m3';
    else if (method === 'nvfp4') activation_dtype = 'nvfp4';
    else activation_dtype = 'fp16';
  }

  const is_moe = Boolean(src.is_moe || src.moe || m.is_moe || m.moe ||
                         /moe|mixtral|qwen.*moe|deepseek.*moe/i.test(_lower(m.base_model || m.model || '')));

  return { method, weight_bits, group_size, sym, desc_act, activation_dtype, is_moe };
}

/**
 * Map a resolved kernel name to the exact `quantization` string vLLM accepts.
 * Returns null when no quant string applies (e.g. unquantized).
 */
export function vllmQuantizationString(kernel) {
  const k = _lower(kernel);
  switch (k) {
    case 'gptq_marlin': return 'gptq_marlin';
    case 'awq_marlin': return 'awq_marlin';
    case 'machete': return 'gptq_marlin';  // vLLM auto-selects Machete behind the gptq_marlin string on Hopper
    case 'marlin': return 'gptq_marlin';
    case 'moe_marlin': return 'gptq_marlin';
    case 'fp8':
    case 'fp8_w8a8':
    case 'fp8_marlin': return 'fp8';
    case 'nvfp4':
    case 'modelopt_nvfp4': return 'modelopt';
    case 'compressed-tensors': return 'compressed-tensors';
    case 'gptq': return 'gptq';
    case 'awq': return 'awq';
    default: return null;
  }
}

// Cited per-kernel speedup estimates vs the naive dequant path (NOT measured
// here - these are published references the passport surfaces as "est"). The
// probe upgrades them to measured_speedup_x.
const KERNEL_SPEEDUP_EST = Object.freeze({
  awq_marlin: { x: 10.9, basis: 'jarvislabs H200 Qwen2.5-32B awq 68->741 tok/s' },
  gptq_marlin: { x: 2.6, basis: 'jarvislabs H200 Qwen2.5-32B gptq 276->712 tok/s' },
  machete: { x: 3.4, basis: 'Red Hat 1xH100 Llama-3.1-70B-4bit +29-32% over Marlin (~2.6x*1.3)' },
  fp8: { x: 1.8, basis: 'vLLM FP8 W8A8 vs bf16 throughput' },
  nvfp4: { x: 2.0, basis: 'NVFP4 W4A4 Blackwell vs fp8 (vLLM blog)' },
  moe_marlin: { x: 1.2, basis: 'fused_marlin_moe (slower than fused Triton MoE; advisory)' },
});

/**
 * THE kernel resolver. Given a quant descriptor + a compute capability, choose
 * the optimal serving kernel + the vLLM quantization string + kv_cache_dtype,
 * with hardware gating and a safe fallback chain.
 *
 * @param {object} quantDescriptor  from quantDescriptorFromArtifact()
 * @param {string} computeCapability
 * @param {{engine?:'vllm'|'sglang', prefer_machete?:boolean}} [opts]
 * @returns {{ok:boolean, kernel:string, vllm_quantization:string|null,
 *            kv_cache_dtype:'auto'|'fp8', supported:boolean,
 *            gate:{reason:string, blocked:boolean}, fallback_chain:string[],
 *            est_speedup_x:number|null, est_speedup_basis:string,
 *            source_engine:string, qko_version:string}}
 */
export function resolveServingKernel(quantDescriptor, computeCapability, opts = {}) {
  const d = quantDescriptor && typeof quantDescriptor === 'object'
    ? quantDescriptor
    : { method: null };
  const cap = kernelCapabilityForCC(computeCapability);
  const engine = opts.engine === 'sglang' ? 'sglang' : 'vllm';
  const preferMachete = opts.prefer_machete !== false; // default: prefer Machete on Hopper

  // kv_cache_dtype: fp8 on Hopper+ (matches serve.py major>=9 rule); auto else.
  const kv_cache_dtype = cap.sm_major >= 9 ? 'fp8' : 'auto';

  const result = (extra) => Object.freeze({
    ok: true,
    kernel: 'auto',
    vllm_quantization: null,
    kv_cache_dtype,
    supported: true,
    gate: { reason: 'ok', blocked: false },
    fallback_chain: [],
    est_speedup_x: null,
    est_speedup_basis: '',
    source_engine: engine,
    qko_version: QUANT_KERNEL_ORACLE_VERSION,
    ...extra,
  });

  const method = _lower(d.method);
  // Unquantized / unknown - no kernel string; vLLM uses bf16/fp16 path.
  if (!method) {
    return result({ kernel: 'none', gate: { reason: 'no quant method on artifact; serving unquantized', blocked: false } });
  }

  const bits = d.weight_bits;
  const gs = d.group_size;
  const marlinGroupOk = gs == null || MARLIN_GROUP_SIZES.includes(gs);

  // ---- FP8 W8A8 ----
  if (method === 'fp8') {
    if (cap.fp8_w8a8) {
      return result({ kernel: 'fp8', vllm_quantization: 'fp8', est_speedup_x: KERNEL_SPEEDUP_EST.fp8.x, est_speedup_basis: KERNEL_SPEEDUP_EST.fp8.basis });
    }
    if (cap.fp8_marlin_w8a16) {
      // Turing/Ampere lack native FP8 tensor cores -> weight-only FP8 via Marlin.
      return result({ kernel: 'fp8_marlin', vllm_quantization: 'fp8', fallback_chain: ['fp8'], gate: { reason: 'no native FP8 tensor cores; weight-only fp8_marlin W8A16', blocked: false }, est_speedup_x: 1.4, est_speedup_basis: 'fp8_marlin weight-only W8A16' });
    }
    return result({ ok: false, kernel: 'fp8', vllm_quantization: 'fp8', supported: false, gate: { reason: `FP8 needs sm_75+ (got sm_${cap.sm_major}.${cap.sm_minor})`, blocked: true }, fallback_chain: ['bf16'], est_speedup_x: null });
  }

  // ---- NVFP4 W4A4 ----
  if (method === 'nvfp4') {
    if (cap.nvfp4_w4a4) {
      return result({ kernel: 'nvfp4', vllm_quantization: 'modelopt', est_speedup_x: KERNEL_SPEEDUP_EST.nvfp4.x, est_speedup_basis: KERNEL_SPEEDUP_EST.nvfp4.basis });
    }
    // NVFP4 on non-Blackwell: blocked, fall back to W4A16 Marlin path if a 4-bit
    // sibling is servable, else fp8.
    const fb = cap.marlin_w4a16 ? ['awq_marlin', 'gptq_marlin'] : (cap.fp8_w8a8 ? ['fp8'] : ['bf16']);
    return result({ ok: false, kernel: 'nvfp4', vllm_quantization: 'modelopt', supported: false, gate: { reason: `NVFP4 W4A4 needs sm_100+ Blackwell (got sm_${cap.sm_major}.${cap.sm_minor})`, blocked: true }, fallback_chain: fb, est_speedup_x: null });
  }

  // ---- compressed-tensors ----
  if (method === 'compressed-tensors') {
    // W4A8-INT silently runs W4A16 on current vLLM (issue #38064) - warn, don't over-promise.
    const actInt8 = _lower(d.activation_dtype) === 'int8';
    return result({
      kernel: 'compressed-tensors',
      vllm_quantization: 'compressed-tensors',
      gate: actInt8
        ? { reason: 'compressed-tensors W4A8-INT currently runs as W4A16 on vLLM (issue #38064); activation quant not yet realized', blocked: false }
        : { reason: 'compressed-tensors checkpoint; vLLM auto-selects the inner kernel', blocked: false },
      est_speedup_x: KERNEL_SPEEDUP_EST.gptq_marlin.x,
      est_speedup_basis: 'compressed-tensors W4A16 inner Marlin path',
    });
  }

  // ---- GPTQ / AWQ (the INT4 mixed-input case) ----
  if (method === 'gptq' || method === 'awq') {
    const isAwq = method === 'awq';
    const w4a8Requested = _lower(d.activation_dtype) === 'fp8_e4m3' || _lower(d.activation_dtype) === 'int8';

    // MoE: only path is fused_marlin_moe (flag as known-slow vs fused Triton MoE).
    if (d.is_moe) {
      if (cap.moe_marlin && bits === 4 && marlinGroupOk) {
        return result({
          kernel: 'moe_marlin',
          vllm_quantization: isAwq ? 'awq_marlin' : 'gptq_marlin',
          gate: { reason: 'MoE GPTQ/AWQ -> fused_marlin_moe (advisory: fused Triton MoE is faster where the engine supports it)', blocked: false },
          fallback_chain: [isAwq ? 'awq' : 'gptq'],
          est_speedup_x: KERNEL_SPEEDUP_EST.moe_marlin.x,
          est_speedup_basis: KERNEL_SPEEDUP_EST.moe_marlin.basis,
        });
      }
      return result({ ok: false, kernel: 'moe_marlin', vllm_quantization: isAwq ? 'awq' : 'gptq', supported: false, gate: { reason: 'MoE quantized GEMM needs sm_80+ and 4-bit Marlin-compatible group_size', blocked: true }, fallback_chain: [isAwq ? 'awq' : 'gptq'] });
    }

    // W4A8 (INT4 weights + INT8/FP8 activations).
    if (w4a8Requested) {
      const wantFp8 = _lower(d.activation_dtype) === 'fp8_e4m3';
      if (wantFp8 && cap.w4a8_fp8) {
        return result({ kernel: 'marlin_w4a8_fp8', vllm_quantization: isAwq ? 'awq_marlin' : 'gptq_marlin', gate: { reason: 'W4A8 Marlin with FP8 activations (sm_89+)', blocked: false }, est_speedup_x: 3.0, est_speedup_basis: 'W4A8 Marlin beats W4A16 at large batch (PR #24722)' });
      }
      if (!wantFp8 && cap.w4a8_int8) {
        return result({ kernel: 'marlin_w4a8_int8', vllm_quantization: isAwq ? 'awq_marlin' : 'gptq_marlin', gate: { reason: 'W4A8 Marlin with INT8 activations (sm_80+)', blocked: false }, est_speedup_x: 2.8, est_speedup_basis: 'W4A8 Marlin INT8 activations' });
      }
      // Activation-quant unsupported on this SM -> fall back to W4A16 Marlin.
      const fbKernel = isAwq ? 'awq_marlin' : 'gptq_marlin';
      return result({
        ok: false,
        kernel: fbKernel,
        vllm_quantization: fbKernel,
        supported: false,
        gate: { reason: `W4A8-${wantFp8 ? 'FP8' : 'INT8'} activations need ${wantFp8 ? 'sm_89+' : 'sm_80+'}; falling back to W4A16 Marlin`, blocked: true },
        fallback_chain: [fbKernel, isAwq ? 'awq' : 'gptq'],
        est_speedup_x: isAwq ? KERNEL_SPEEDUP_EST.awq_marlin.x : KERNEL_SPEEDUP_EST.gptq_marlin.x,
      });
    }

    // W4A16 - the common case. Marlin (sm_80+) or Machete (Hopper).
    if (bits === 4 && marlinGroupOk && cap.marlin_w4a16) {
      if (cap.machete_w4a16 && preferMachete && !isAwq) {
        // Machete is the W4A16 winner on Hopper for GPTQ-shape checkpoints.
        return result({ kernel: 'machete', vllm_quantization: 'gptq_marlin', gate: { reason: 'Hopper sm_90a: Machete W4A16 (+29-42% over Marlin)', blocked: false }, est_speedup_x: KERNEL_SPEEDUP_EST.machete.x, est_speedup_basis: KERNEL_SPEEDUP_EST.machete.basis });
      }
      const kernel = isAwq ? 'awq_marlin' : 'gptq_marlin';
      const est = isAwq ? KERNEL_SPEEDUP_EST.awq_marlin : KERNEL_SPEEDUP_EST.gptq_marlin;
      return result({ kernel, vllm_quantization: kernel, est_speedup_x: est.x, est_speedup_basis: est.basis });
    }

    // 8-bit weight-only GPTQ/AWQ also runs under Marlin on sm_80+.
    if (bits === 8 && marlinGroupOk && cap.marlin_w4a16) {
      const kernel = isAwq ? 'awq_marlin' : 'gptq_marlin';
      return result({ kernel, vllm_quantization: kernel, gate: { reason: '8-bit weight-only via Marlin', blocked: false }, est_speedup_x: 1.6, est_speedup_basis: '8-bit Marlin weight-only' });
    }

    // Group size not Marlin-compatible (e.g. 100) OR sm too old -> raw kernel.
    // This preserves vLLM's own auto-convert/auto-detect rather than emitting a
    // broken config; a stale kolm table degrades to today's behavior.
    const raw = isAwq ? 'awq' : 'gptq';
    return result({
      kernel: raw,
      vllm_quantization: raw,
      gate: {
        reason: !marlinGroupOk
          ? `group_size ${gs} not Marlin-compatible (need one of ${MARLIN_GROUP_SIZES.join('/')}); using raw ${raw} (vLLM may still auto-convert)`
          : `Marlin needs sm_80+ (got sm_${cap.sm_major}.${cap.sm_minor}); using raw ${raw}`,
        blocked: false,
      },
      fallback_chain: [raw],
      est_speedup_x: null,
      est_speedup_basis: 'raw dequant path',
    });
  }

  // Unknown method - pass through as the raw string (vLLM auto-detect).
  return result({ kernel: method, vllm_quantization: vllmQuantizationString(method), gate: { reason: `unrecognized method ${method}; passing through`, blocked: false } });
}

/**
 * Build the runtime-passport serving_kernel sub-object.
 *
 * @param {{resolved:object, compute_capability:string,
 *          measured?:{tok_s?:number, baseline_tok_s?:number}}} args
 * @returns frozen serving_kernel sub-object
 */
export function servingKernelPassportEntry({ resolved, compute_capability, measured } = {}) {
  if (!resolved || typeof resolved !== 'object') {
    throw new TypeError('servingKernelPassportEntry: resolved object required');
  }
  let measured_speedup_x = null;
  if (measured && _isFiniteNumber(measured.tok_s) && _isFiniteNumber(measured.baseline_tok_s) && measured.baseline_tok_s > 0) {
    measured_speedup_x = _round(measured.tok_s / measured.baseline_tok_s, 2);
  }
  return Object.freeze({
    kernel: resolved.kernel,
    vllm_quantization: resolved.vllm_quantization ?? null,
    compute_capability: compute_capability || resolved.compute_capability || null,
    kv_cache_dtype: resolved.kv_cache_dtype ?? 'auto',
    est_speedup_x: _isFiniteNumber(resolved.est_speedup_x) ? resolved.est_speedup_x : null,
    measured_speedup_x,
    gate: resolved.gate || { reason: 'ok', blocked: false },
    qko_version: QUANT_KERNEL_ORACLE_VERSION,
    status: measured_speedup_x != null ? 'tested' : 'estimated',
  });
}

// ===========================================================================
// 2. KV-CACHE POLICY DISPATCH
//    (StreamingLLM / H2O / SnapKV / PyramidKV / KIVI / Shard)
// ===========================================================================
//
// All five techniques attack the O(layers * kv_heads * head_dim * seq_len) KV
// blow-up. Eviction presses (StreamingLLM/SnapKV/H2O/PyramidKV) run on the
// transformers engine via NVIDIA kvpress; KIVI is the quant axis (transformers
// QuantizedCache and vLLM kv_cache_dtype). vLLM/PagedAttention can ONLY honor
// the quant axis + sliding window, never pluggable eviction - the dispatcher is
// explicit about runtime_can_enforce. Refs:
//   StreamingLLM arXiv:2309.17453   H2O arXiv:2306.14048
//   SnapKV arXiv:2404.14469         PyramidKV arXiv:2406.02069
//   KIVI arXiv:2402.02750           kvpress https://github.com/NVIDIA/kvpress

export const KV_POLICIES = Object.freeze({
  off:        { kind: 'off',      press: null,                runtimes: ['transformers', 'vllm', 'sglang', 'llama.cpp'] },
  streaming:  { kind: 'eviction', press: 'streaming_llm',     runtimes: ['transformers'] },
  h2o:        { kind: 'eviction', press: 'observed_attention',runtimes: ['transformers'] },
  snapkv:     { kind: 'eviction', press: 'snapkv',            runtimes: ['transformers'] },
  pyramidkv:  { kind: 'eviction', press: 'pyramidkv', wraps: true, runtimes: ['transformers'] },
  kivi2:      { kind: 'quant',    nbits: 2,                   runtimes: ['transformers', 'vllm'] },
  kivi4:      { kind: 'quant',    nbits: 4,                   runtimes: ['transformers', 'vllm'] },
  shard:      { kind: 'compress', press: null,                runtimes: ['transformers'] },
});

// Default tuning per policy. Numbers are the published defaults for each method.
const KV_POLICY_DEFAULTS = Object.freeze({
  streaming: { sink_tokens: 4, window_tokens: 1020 },        // StreamingLLM S=4
  h2o:       { budget: 0.5 },                                // keep top-50% heavy hitters + recent
  snapkv:    { budget: 0.5, window_tokens: 64, kernel_size: 5 }, // SnapKV obs-window 64, maxpool 5
  pyramidkv: { budget: 0.5, window_tokens: 64, kernel_size: 5 },
  kivi2:     { nbits: 2, group_size: 32, residual_length: 128 }, // KIVI 2-bit per-channel K
  kivi4:     { nbits: 4, group_size: 32, residual_length: 128 },
  shard:     { sink_tokens: 4, window_tokens: 64, compression_ratio: 0.1 },
});

function _normalizeRuntimeForKv(format) {
  const f = _lower(format);
  if (['transformers', 'hf', 'huggingface', 'safetensors', 'tgi'].includes(f)) return 'transformers';
  if (f === 'vllm') return 'vllm';
  if (f === 'sglang') return 'sglang';
  if (['llama.cpp', 'llamacpp', 'gguf'].includes(f)) return 'llama.cpp';
  if (f === 'mlx') return 'mlx';
  return f || 'transformers';
}

function _validItkvProfile(profile) {
  return profile && typeof profile === 'object'
    && profile.precision_by_class && typeof profile.precision_by_class === 'object'
    && Number.isInteger(profile.sink_anchor)
    && Number.isInteger(profile.recent_window_size)
    && profile.recent_window_size > 0;
}

function _resolveItkvProfile({ kv_profile, modelMeta = {} } = {}) {
  const candidate = kv_profile
    || modelMeta.kv_profile
    || modelMeta.kvProfile
    || modelMeta.itkv_profile
    || modelMeta.itkvProfile
    || null;
  if (_validItkvProfile(candidate)) {
    return { profile: candidate, source: 'provided' };
  }
  const artifact_id = String(
    modelMeta.artifact_id
    || modelMeta.artifactId
    || modelMeta.artifact_hash
    || modelMeta.base_model
    || modelMeta.model
    || modelMeta.family
    || ''
  );
  const built = buildItkvProfile({ artifact_id });
  if (built && built.ok && _validItkvProfile(built.profile)) {
    return { profile: built.profile, source: candidate ? 'default_invalid_profile' : 'default' };
  }
  return null;
}

function _fuseItkvProfileParams(policy, params, profileInfo, { explicitSink, explicitWindow } = {}) {
  if (!profileInfo || !_validItkvProfile(profileInfo.profile)) return params;
  const profile = profileInfo.profile;
  const fused = {
    ...params,
    kv_profile_hash: hashItkvProfile(profile),
    kv_profile_version: profile.version || null,
    kv_profile_source: profileInfo.source,
    precision_by_class: { ...profile.precision_by_class },
    prefix_cache_enabled: profile.prefix_cache_enabled !== false,
  };
  if (policy === 'streaming' || policy === 'shard') {
    if (!explicitSink) fused.sink_tokens = profile.sink_anchor;
    if (!explicitWindow) fused.window_tokens = profile.recent_window_size;
  }
  return fused;
}

/**
 * Map a workload hint to a default KV policy.
 *   chat|streaming -> streaming
 *   qa|rag         -> snapkv
 *   long_context|general -> h2o
 *   tight_vram     -> kivi2
 */
export function resolveWorkloadPolicy(workload) {
  const w = _lower(workload);
  switch (w) {
    case 'chat':
    case 'streaming': return 'streaming';
    case 'qa':
    case 'rag': return 'snapkv';
    case 'tight_vram': return 'kivi2';
    case 'long_context':
    case 'general':
    default: return 'h2o';
  }
}

/**
 * THE KV-policy resolver. Supersedes the binary selectKvCache(); returns a full
 * descriptor with per-runtime capability gating and a fallback.
 *
 * @returns {{policy:string, kind:string, params:object,
 *            runtime_can_enforce:boolean, runtime:string, reason:string,
 *            fallback:string, version:string}}
 */
export function selectKvCachePolicy({
  format = 'transformers',
  modelMeta = {},
  hardware = {},
  workload = 'general',
  requested = 'auto',
  budget,
  sink_tokens,
  window_tokens,
  kernel_size,
  group_size,
  residual_length,
  kv_profile,
} = {}) {
  const runtime = _normalizeRuntimeForKv(format);
  let policy = _lower(requested);

  if (!policy || policy === 'auto') {
    policy = resolveWorkloadPolicy(workload);
  } else if (policy === 'on') {
    policy = 'h2o';
  }

  if (!Object.prototype.hasOwnProperty.call(KV_POLICIES, policy)) {
    return Object.freeze({
      policy: 'off', kind: 'off', params: {},
      runtime_can_enforce: true, runtime,
      reason: `unknown kv policy '${requested}'; defaulting to off`,
      fallback: 'off', version: KV_POLICY_VERSION,
    });
  }

  if (policy === 'off') {
    return Object.freeze({
      policy: 'off', kind: 'off', params: {},
      runtime_can_enforce: true, runtime,
      reason: 'kv policy off (full cache)', fallback: 'off', version: KV_POLICY_VERSION,
    });
  }

  const spec = KV_POLICIES[policy];
  const defaults = KV_POLICY_DEFAULTS[policy] || {};
  // Merge defaults with explicit caller overrides (only finite/defined values).
  let params = { ...defaults };
  const profileInfo = _resolveItkvProfile({ kv_profile, modelMeta });
  params = _fuseItkvProfileParams(policy, params, profileInfo, {
    explicitSink: _isFiniteNumber(sink_tokens),
    explicitWindow: _isFiniteNumber(window_tokens),
  });
  if (_isFiniteNumber(budget)) params.budget = budget;
  if (_isFiniteNumber(sink_tokens)) params.sink_tokens = sink_tokens;
  if (_isFiniteNumber(window_tokens)) params.window_tokens = window_tokens;
  if (_isFiniteNumber(kernel_size)) params.kernel_size = kernel_size;
  if (_isFiniteNumber(group_size)) params.group_size = group_size;
  if (_isFiniteNumber(residual_length)) params.residual_length = residual_length;
  if (spec.nbits != null && params.nbits == null) params.nbits = spec.nbits;

  // Param validation - reject impossible values rather than ship a broken config.
  if (params.budget != null && (params.budget <= 0 || params.budget > 1)) {
    return Object.freeze({
      policy, kind: spec.kind, params,
      runtime_can_enforce: false, runtime,
      reason: `invalid budget ${params.budget} (must be in (0,1])`,
      fallback: 'off', version: KV_POLICY_VERSION,
    });
  }
  if (params.nbits != null && ![2, 4, 8].includes(params.nbits)) {
    return Object.freeze({
      policy, kind: spec.kind, params,
      runtime_can_enforce: false, runtime,
      reason: `invalid nbits ${params.nbits} (must be 2, 4, or 8)`,
      fallback: 'off', version: KV_POLICY_VERSION,
    });
  }

  // Capability gate: can this runtime enforce this policy?
  const canEnforce = spec.runtimes.includes(runtime);
  if (!canEnforce) {
    // Eviction presses are transformers-only; on vLLM fall back to the quant
    // axis (kivi2) which vLLM CAN honor via kv_cache_dtype; else 'default'.
    let fallback = 'off';
    if (runtime === 'vllm' || runtime === 'sglang') {
      fallback = KV_POLICIES.kivi2.runtimes.includes(runtime) ? 'kivi2' : 'off';
    }
    return Object.freeze({
      policy, kind: spec.kind, params,
      runtime_can_enforce: false, runtime,
      reason: `${policy} (${spec.kind}) requires the transformers engine; ${runtime} owns its own KV cache. Falling back to ${fallback}.`,
      fallback, version: KV_POLICY_VERSION,
    });
  }

  const vramGb = _vramGbFromHardware(hardware);
  const hwNote = _isFiniteNumber(vramGb) ? ` hw=${vramGb}GB` : '';
  return Object.freeze({
    policy, kind: spec.kind, params,
    runtime_can_enforce: true, runtime,
    reason: `${policy} (${spec.kind}) enforceable on ${runtime}; workload=${workload}${hwNote}`,
    fallback: spec.kind === 'eviction' ? 'kivi2' : 'off',
    version: KV_POLICY_VERSION,
  });
}

/**
 * Build the runtime-passport kv_cache sub-object for a policy.
 * `measured` carries the boot-and-measure numbers from apps/export/probe.py.
 *
 * @returns frozen kv_cache sub-object
 */
export function kvPolicyPassportEntry({ policy, params = {}, measured } = {}) {
  if (typeof policy !== 'string' || !policy) {
    throw new TypeError('kvPolicyPassportEntry: policy string required');
  }
  const m = measured && typeof measured === 'object' ? measured : {};
  const num = (v) => (_isFiniteNumber(v) ? v : null);
  return Object.freeze({
    policy,
    kind: (KV_POLICIES[policy] && KV_POLICIES[policy].kind) || 'unknown',
    params: Object.freeze({ ...params }),
    compression_ratio: num(m.compression_ratio),
    retained_tokens: num(m.retained_tokens),
    evicted_tokens: num(m.evicted_tokens),
    budget: num(m.budget != null ? m.budget : params.budget),
    peak_kv_mb: num(m.peak_kv_mb),
    quality_delta: num(m.quality_delta),
    max_context_at_vram: num(m.max_context_at_vram),
    version: KV_POLICY_VERSION,
    status: (_isFiniteNumber(m.compression_ratio) && _isFiniteNumber(m.peak_kv_mb)) ? 'tested' : 'estimated',
  });
}

/**
 * Emit only the KV fields vLLM can actually enforce for a policy: the quant
 * axis (kv_cache_dtype) and sliding-window; eviction presses get a note.
 */
export function emitKvPolicyVllmConfig(policy, kvCacheDtype = 'auto') {
  const p = typeof policy === 'object' && policy ? policy.policy : policy;
  const kind = (KV_POLICIES[p] && KV_POLICIES[p].kind) || 'off';
  const out = { kv_cache_dtype: kvCacheDtype };
  if (kind === 'quant') {
    // KIVI maps onto vLLM's fp8/int8 KV quant axis. 2-bit is not a vLLM KV
    // dtype yet, so the closest honest vLLM enforcement is fp8.
    out.kv_cache_dtype = kvCacheDtype === 'auto' ? 'fp8' : kvCacheDtype;
    out.note = `${p} requested; vLLM enforces the quant axis via kv_cache_dtype=${out.kv_cache_dtype} (2-bit eviction not a vLLM KV dtype)`;
  } else if (kind === 'eviction' || kind === 'compress') {
    out.note = `${p} is a transformers-engine eviction policy; vLLM (PagedAttention) cannot enforce it - emit on the transformers serve path`;
  }
  return out;
}

// ===========================================================================
// 3. EAGLE-2 / EAGLE-3 SELF-SPECULATIVE DECODING
// ===========================================================================
//
// EAGLE reuses the TARGET's own hidden states instead of a second full model.
// The kolm-trained EAGLE3 head must be served via the MODERN vLLM
// speculative_config dict ({'method','model','num_speculative_tokens'}), not the
// deprecated flat speculative_model kwargs (removed in vLLM >=0.10). Refs:
//   EAGLE arXiv:2401.15077  EAGLE-2 arXiv:2406.16858  EAGLE-3 arXiv:2503.01840
//   vLLM EAGLE https://docs.vllm.ai/en/latest/features/speculative_decoding/eagle/
//   SGLang     https://docs.sglang.ai/advanced_features/speculative_decoding.html

export const EAGLE_HEAD_KINDS = Object.freeze(['eagle', 'eagle2', 'eagle3', 'medusa', 'draft_model']);

// target id -> a verified pretrained EAGLE3 head HF repo. Verified repos only.
export const EAGLE_HEAD_REGISTRY = Object.freeze({
  'meta-llama/llama-3.1-8b-instruct': 'RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3',
  'meta-llama/llama-3.3-70b-instruct': 'RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3',
  'qwen/qwen3-8b': 'lmsys/SGLang-EAGLE3-Qwen3-8B',
});

// Per-head-kind dynamic draft-tree defaults (EAGLE-2/3 confidence-aware tree).
const EAGLE_TREE_DEFAULTS = Object.freeze({
  eagle:      { eagle_topk: 8, num_steps: 5, num_draft_tokens: 32, num_speculative_tokens: 5 },
  eagle2:     { eagle_topk: 10, num_steps: 6, num_draft_tokens: 60, num_speculative_tokens: 5 },
  eagle3:     { eagle_topk: 8, num_steps: 5, num_draft_tokens: 32, num_speculative_tokens: 5 },
  medusa:     { eagle_topk: null, num_steps: null, num_draft_tokens: null, num_speculative_tokens: 5 },
  draft_model:{ eagle_topk: null, num_steps: null, num_draft_tokens: null, num_speculative_tokens: 5 },
});

/**
 * Resolve the EAGLE/Medusa/draft head to serve. Priority:
 *   manifest head > EAGLE_HEAD_REGISTRY > DRAFT_PAIRINGS (via draftPicker) >
 *   explicit flag. Returns null when nothing resolves and no flag is given.
 *
 * @param {{target:string, manifest?:object, runtime?:string, flag?:string,
 *          numSpeculativeTokens?:number, draftPicker?:Function}} args
 * @returns {{head_kind:string, head_id:string, num_speculative_tokens:number,
 *            eagle_topk:number|null, num_steps:number|null,
 *            num_draft_tokens:number|null, source:string, supported:boolean,
 *            reason:string} | null}
 */
export function resolveEagleHead({ target, manifest, runtime = 'vllm', flag, numSpeculativeTokens, draftPicker } = {}) {
  const rt = _lower(runtime);
  const flagStr = _lower(flag);
  // Explicit off.
  if (['off', 'none', 'false'].includes(flagStr)) {
    return { head_kind: 'draft_model', head_id: '', num_speculative_tokens: 0, eagle_topk: null, num_steps: null, num_draft_tokens: null, source: 'explicit', supported: false, reason: 'speculative decoding disabled (--speculative off)' };
  }

  const kDefault = (kind) => {
    const t = EAGLE_TREE_DEFAULTS[kind] || EAGLE_TREE_DEFAULTS.eagle3;
    const k = _isFiniteNumber(numSpeculativeTokens) && numSpeculativeTokens > 0
      ? Math.floor(numSpeculativeTokens) : t.num_speculative_tokens;
    return { ...t, num_speculative_tokens: k };
  };

  // Runtimes that can drive an EAGLE head natively. llama.cpp only does the
  // separate-draft GGUF path (no EAGLE head support upstream).
  const eagleCapable = (rt === 'vllm' || rt === 'sglang' || rt === 'transformers');

  // 1. Manifest speculative_decoding block (compile-time choice wins).
  const spec = (manifest && typeof manifest === 'object' && manifest.speculative_decoding) || null;
  if (spec && typeof spec === 'object') {
    const headKind = _lower(spec.head_kind || spec.method || (spec.version ? 'eagle3' : ''));
    const headId = spec.head_id || spec.head_path || spec.draft_model || '';
    if (headId) {
      const isEagle = ['eagle', 'eagle2', 'eagle3', 'medusa'].includes(headKind);
      const kind = isEagle ? headKind : 'draft_model';
      const d = kDefault(kind);
      const supported = (kind === 'draft_model') ? (rt === 'vllm' || rt === 'sglang' || rt === 'transformers' || rt === 'llama.cpp') : eagleCapable;
      return {
        head_kind: kind,
        head_id: headId,
        num_speculative_tokens: _isFiniteNumber(spec.num_speculative_tokens) && spec.num_speculative_tokens > 0 ? Math.floor(spec.num_speculative_tokens) : d.num_speculative_tokens,
        eagle_topk: _isFiniteNumber(spec.eagle_topk) ? spec.eagle_topk : d.eagle_topk,
        num_steps: _isFiniteNumber(spec.num_steps) ? spec.num_steps : d.num_steps,
        num_draft_tokens: _isFiniteNumber(spec.num_draft_tokens) ? spec.num_draft_tokens : d.num_draft_tokens,
        source: 'manifest',
        supported,
        reason: supported ? `manifest ${kind} head ${headId}` : `${kind} head not drivable on ${rt}`,
      };
    }
  }

  // 2. Explicit non-off flag: treat as a head id (or 'eagle3'/'auto' keyword).
  if (flagStr && !['auto', 'on'].includes(flagStr)) {
    // A bare 'eagle3'/'eagle2' keyword means "use the registry head for target".
    if (['eagle', 'eagle2', 'eagle3', 'medusa'].includes(flagStr)) {
      const regHead = EAGLE_HEAD_REGISTRY[_lower(target)];
      if (regHead) {
        const d = kDefault(flagStr);
        return { head_kind: flagStr, head_id: regHead, num_speculative_tokens: d.num_speculative_tokens, eagle_topk: d.eagle_topk, num_steps: d.num_steps, num_draft_tokens: d.num_draft_tokens, source: 'registry', supported: eagleCapable, reason: eagleCapable ? `registry ${flagStr} head for ${target}` : `${flagStr} not drivable on ${rt}` };
      }
      return { head_kind: flagStr, head_id: '', num_speculative_tokens: kDefault(flagStr).num_speculative_tokens, eagle_topk: null, num_steps: null, num_draft_tokens: null, source: 'explicit', supported: false, reason: `no registry ${flagStr} head for target ${target}` };
    }
    // Otherwise it's a concrete head/draft id.
    const d = kDefault('draft_model');
    return { head_kind: 'draft_model', head_id: flag.trim(), num_speculative_tokens: d.num_speculative_tokens, eagle_topk: null, num_steps: null, num_draft_tokens: null, source: 'explicit', supported: true, reason: `explicit head/draft ${flag.trim()}` };
  }

  // 3. auto / unset: registry head for the target.
  const regHead = EAGLE_HEAD_REGISTRY[_lower(target)];
  if (regHead) {
    const d = kDefault('eagle3');
    return { head_kind: 'eagle3', head_id: regHead, num_speculative_tokens: d.num_speculative_tokens, eagle_topk: d.eagle_topk, num_steps: d.num_steps, num_draft_tokens: d.num_draft_tokens, source: 'registry', supported: eagleCapable, reason: eagleCapable ? `auto: registry eagle3 head for ${target}` : `eagle3 not drivable on ${rt}` };
  }

  // 4. Fall back to a separate-draft pairing via the injected picker.
  if (typeof draftPicker === 'function') {
    const draft = draftPicker(target);
    if (draft) {
      const d = kDefault('draft_model');
      const supported = (rt === 'vllm' || rt === 'sglang' || rt === 'transformers' || rt === 'llama.cpp');
      return { head_kind: 'draft_model', head_id: draft, num_speculative_tokens: d.num_speculative_tokens, eagle_topk: null, num_steps: null, num_draft_tokens: null, source: 'pairing', supported, reason: supported ? `auto-paired separate draft ${target} -> ${draft}` : `draft path not drivable on ${rt}` };
    }
  }

  return null;
}

/**
 * Build the MODERN vLLM speculative_config dict for a resolved head, or null
 * when speculation is off / unsupported. NO deprecated flat kwargs.
 */
export function buildVllmSpeculativeConfig(resolved, { tp = 1 } = {}) {
  if (!resolved || !resolved.head_id || !resolved.supported || resolved.num_speculative_tokens <= 0) {
    return null;
  }
  const k = Math.max(1, Math.floor(resolved.num_speculative_tokens));
  if (resolved.head_kind === 'eagle' || resolved.head_kind === 'eagle2' || resolved.head_kind === 'eagle3') {
    // Current vLLM SpeculativeConfig accepts method/model/K/TP, but does not
    // expose SGLang-style EAGLE tree controls. Keep tree policy in the Kolm
    // env/report contract instead of passing unknown keys to vLLM.
    const cfg = {
      method: resolved.head_kind,
      model: resolved.head_id,
      num_speculative_tokens: k,
    };
    if (_isFiniteNumber(tp) && tp > 1) cfg.draft_tensor_parallel_size = Math.floor(tp);
    return cfg;
  }
  if (resolved.head_kind === 'medusa') {
    return { method: 'medusa', model: resolved.head_id, num_speculative_tokens: k };
  }
  // draft_model: standard separate-draft modern config.
  const cfg = { model: resolved.head_id, num_speculative_tokens: k };
  if (_isFiniteNumber(tp) && tp > 1) cfg.draft_tensor_parallel_size = Math.floor(tp);
  return cfg;
}

/**
 * Build the preserved EAGLE tree-policy sidecar. SGLang can enforce these
 * knobs directly; vLLM currently cannot, so the vLLM path records them for
 * audit/runtime visibility without adding unsupported speculative_config keys.
 */
export function buildSpeculativeTreePolicy(resolved, { runtime = 'vllm' } = {}) {
  if (!resolved || !['eagle', 'eagle2', 'eagle3'].includes(resolved.head_kind)) {
    return null;
  }
  const rt = _lower(runtime) || 'vllm';
  const tree = {};
  if (_isFiniteNumber(resolved.eagle_topk)) tree.eagle_topk = Math.floor(resolved.eagle_topk);
  if (_isFiniteNumber(resolved.num_steps)) tree.num_steps = Math.floor(resolved.num_steps);
  if (_isFiniteNumber(resolved.num_draft_tokens)) tree.num_draft_tokens = Math.floor(resolved.num_draft_tokens);
  if (Object.keys(tree).length === 0) return null;
  return Object.freeze({
    ...tree,
    runtime: rt,
    engine_configurable: rt === 'sglang',
    note: rt === 'vllm'
      ? 'preserved by Kolm; current vLLM SpeculativeConfig does not expose EAGLE tree knobs'
      : 'passed to runtime when supported',
  });
}

/**
 * Build SGLang speculative server args for a resolved EAGLE head. Empty when
 * not applicable. When tree params are present we emit them explicitly; when
 * absent we leave them unset so SGLang auto-tunes.
 */
export function buildSglangSpecArgs(resolved) {
  if (!resolved || !resolved.head_id || !resolved.supported || resolved.num_speculative_tokens <= 0) {
    return [];
  }
  const algoMap = { eagle: 'EAGLE', eagle2: 'EAGLE', eagle3: 'EAGLE3', medusa: 'EAGLE' };
  const algo = algoMap[resolved.head_kind];
  if (!algo) return []; // draft_model has no SGLang EAGLE algo
  const args = ['--speculative-algorithm', algo, '--speculative-draft-model-path', resolved.head_id];
  if (_isFiniteNumber(resolved.num_steps)) args.push('--speculative-num-steps', String(resolved.num_steps));
  if (_isFiniteNumber(resolved.eagle_topk)) args.push('--speculative-eagle-topk', String(resolved.eagle_topk));
  if (_isFiniteNumber(resolved.num_draft_tokens)) args.push('--speculative-num-draft-tokens', String(resolved.num_draft_tokens));
  return args;
}

/**
 * Build llama.cpp --model-draft args (separate-draft GGUF only; no EAGLE heads
 * upstream). Empty when the head is an EAGLE head (unsupported on llama.cpp).
 */
export function buildLlamaCppDraftArgs(resolved) {
  if (!resolved || !resolved.head_id || resolved.num_speculative_tokens <= 0) return [];
  if (resolved.head_kind !== 'draft_model') return []; // EAGLE not supported on llama.cpp
  const k = Math.max(1, Math.floor(resolved.num_speculative_tokens));
  return ['--model-draft', resolved.head_id, '--draft-max', String(k), '--draft-min', '1'];
}

/**
 * Runtime-passport speculative sub-object extended with EAGLE head fields.
 * Always paired with the artifact's runtime; not back-fillable to v1 without
 * re-measurement.
 */
export function speculativeHeadPassportEntry({ measured } = {}) {
  if (!measured || typeof measured !== 'object') {
    throw new TypeError('speculativeHeadPassportEntry: measured object required');
  }
  const m = measured;
  const numOrNull = (v) => (_isFiniteNumber(v) ? v : null);
  const acceptedLength = m.accepted_length ?? m.mean_accept_length;
  if (typeof m.head_kind !== 'string' || !EAGLE_HEAD_KINDS.includes(m.head_kind)) {
    throw new TypeError(`measured.head_kind must be one of ${EAGLE_HEAD_KINDS.join('|')}`);
  }
  if (m.acceptance_rate != null && (!_isFiniteNumber(m.acceptance_rate) || m.acceptance_rate < 0 || m.acceptance_rate > 1)) {
    throw new TypeError('measured.acceptance_rate must be in [0,1] or null');
  }
  if (acceptedLength != null && (!_isFiniteNumber(acceptedLength) || acceptedLength <= 0)) {
    throw new TypeError('measured.accepted_length must be > 0 or null');
  }
  return Object.freeze({
    method: 'speculative_decoding',
    version: EAGLE_RESOLVER_VERSION,
    head_kind: m.head_kind,
    head_id: String(m.head_id || ''),
    target_model: String(m.target_model || ''),
    runtime: String(m.runtime || ''),
    num_speculative_tokens: _isFiniteNumber(m.num_speculative_tokens) ? Math.floor(m.num_speculative_tokens) : 0,
    eagle_topk: numOrNull(m.eagle_topk),
    num_steps: numOrNull(m.num_steps),
    acceptance_rate: numOrNull(m.acceptance_rate),
    accepted_length: numOrNull(acceptedLength),
    throughput_speedup: numOrNull(m.throughput_speedup),
    mode: m.mode === 'auto' ? 'auto' : 'explicit',
    status: (_isFiniteNumber(m.acceptance_rate)) ? 'tested' : 'estimated',
  });
}

// ===========================================================================
// 4. SERVING FEATURES (prefix/radix caching + chunked prefill + batched-token)
// ===========================================================================
//
// Resolve prefix_cache / chunked_prefill / max_num_batched_tokens / max_num_seqs
// ONCE and emit them identically into serve, the spawned command, and every
// deploy artifact so they cannot drift. Refs:
//   vLLM APC + chunked prefill https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/
//   SGLang RadixAttention      https://www.lmsys.org/blog/2024-01-17-sglang/

/**
 * @param {{workload?:string, hardware?:object, runtime?:string,
 *          maxModelLen?:number, manifest?:object, requested?:object}} args
 * @returns {{prefix_cache:boolean, chunked_prefill:boolean,
 *            max_num_batched_tokens:number, max_num_seqs:number, runtime:string,
 *            reason:string, vllm_args:string[], sglang_args:string[],
 *            vllm_config:object, env:object}}
 */
export function resolveServingFeatures({
  workload = 'agent',
  hardware = {},
  runtime = 'vllm',
  maxModelLen = 8192,
  manifest = {},
  requested = {},
} = {}) {
  const w = _lower(workload);
  const rt = _lower(runtime) || 'vllm';

  // MLA attention models disable chunked prefill / prefix caching in vLLM; gate.
  const attnType = _lower((manifest && (manifest.attention_type || (manifest.runtime && manifest.runtime.attention_type))) || '');
  const isMla = attnType.includes('mla') || /deepseek/i.test(_lower(manifest.base_model || manifest.model || ''));

  // prefix_cache: on unless a one-shot batch on tight VRAM, or MLA, or override.
  let prefix_cache = true;
  let reasonBits = [];
  if (requested.prefix_cache === false) { prefix_cache = false; reasonBits.push('prefix_cache off (requested)'); }
  else if (isMla) { prefix_cache = false; reasonBits.push('prefix_cache off (MLA model)'); }
  else if (w === 'one-shot-batch') {
    const vramGb = _vramGbFromHardware(hardware);
    if (_isFiniteNumber(vramGb) && vramGb < 24) { prefix_cache = false; reasonBits.push('prefix_cache off (one-shot batch, tight VRAM)'); }
    else reasonBits.push('prefix_cache on');
  } else { reasonBits.push('prefix_cache on'); }

  // chunked_prefill: on (vLLM V1 default), emit explicitly; off for MLA.
  let chunked_prefill = true;
  if (requested.chunked_prefill === false) { chunked_prefill = false; reasonBits.push('chunked_prefill off (requested)'); }
  else if (isMla) { chunked_prefill = false; reasonBits.push('chunked_prefill off (MLA model)'); }
  else reasonBits.push('chunked_prefill on');

  // max_num_batched_tokens: latency 2048, throughput/agent 8192, default 4096.
  let max_num_batched_tokens;
  if (_isFiniteNumber(requested.max_num_batched_tokens)) {
    max_num_batched_tokens = Math.max(1, Math.floor(requested.max_num_batched_tokens));
    reasonBits.push(`max_num_batched_tokens=${max_num_batched_tokens} (requested)`);
  } else if (w === 'latency') { max_num_batched_tokens = 2048; reasonBits.push('max_num_batched_tokens=2048 (latency)'); }
  else if (w === 'throughput' || w === 'agent') { max_num_batched_tokens = 8192; reasonBits.push('max_num_batched_tokens=8192 (throughput/agent)'); }
  else { max_num_batched_tokens = 4096; reasonBits.push('max_num_batched_tokens=4096 (default)'); }

  // max_num_seqs: continuous-batching width.
  let max_num_seqs = 8;
  if (_isFiniteNumber(requested.max_num_seqs)) max_num_seqs = Math.max(1, Math.floor(requested.max_num_seqs));

  const features = {
    prefix_cache, chunked_prefill, max_num_batched_tokens, max_num_seqs, runtime: rt,
    reason: reasonBits.join('; '),
  };

  const vllm_args = emitVllmServeArgs(features);
  const sglang_args = emitSglangServeArgs(features);
  const vllm_config = {
    enable_prefix_caching: prefix_cache,
    enable_chunked_prefill: chunked_prefill,
    max_num_batched_tokens,
    max_num_seqs,
    max_model_len: _isFiniteNumber(maxModelLen) ? Math.floor(maxModelLen) : 8192,
  };
  const env = {
    KOLM_PROMPT_CACHE: prefix_cache ? 'on' : 'off',
    KOLM_CHUNKED_PREFILL: chunked_prefill ? 'on' : 'off',
    KOLM_MAX_NUM_BATCHED_TOKENS: String(max_num_batched_tokens),
    KOLM_MAX_NUM_SEQS: String(max_num_seqs),
  };

  return { ...features, vllm_args, sglang_args, vllm_config, env };
}

/** Exact vLLM CLI serving-feature arg list. */
export function emitVllmServeArgs(features) {
  const f = features || {};
  const args = [];
  args.push(f.prefix_cache === false ? '--no-enable-prefix-caching' : '--enable-prefix-caching');
  if (f.chunked_prefill !== false) args.push('--enable-chunked-prefill');
  if (_isFiniteNumber(f.max_num_batched_tokens)) args.push('--max-num-batched-tokens', String(f.max_num_batched_tokens));
  if (_isFiniteNumber(f.max_num_seqs)) args.push('--max-num-seqs', String(f.max_num_seqs));
  return args;
}

/** SGLang launch_server serving-feature args. */
export function emitSglangServeArgs(features) {
  const f = features || {};
  const args = [];
  if (f.prefix_cache !== false) args.push('--enable-radix-cache');
  if (_isFiniteNumber(f.max_num_batched_tokens)) args.push('--chunked-prefill-size', String(f.max_num_batched_tokens));
  args.push('--schedule-conservativeness', '1.0');
  return args;
}

/** Multi-line --dry-run banner for serving features. */
export function formatServingFeaturesReport(features) {
  const f = features || {};
  return [
    'Serving features',
    `  prefix_cache           : ${f.prefix_cache}`,
    `  chunked_prefill        : ${f.chunked_prefill}`,
    `  max_num_batched_tokens : ${f.max_num_batched_tokens}`,
    `  max_num_seqs           : ${f.max_num_seqs}`,
    `  reason                 : ${f.reason || ''}`,
  ].join('\n');
}

// ===========================================================================
// 5. MULTI-LORA SERVING PLAN (one base + N adapters on one GPU)
// ===========================================================================
//
// S-LoRA / vLLM --enable-lora: keep one base in VRAM, swap adapter weights per
// request (O(rank*layers*hidden) bytes). Ref: arXiv:2311.03285.

/**
 * Parse a --lora-modules flag value into [{id, path}].
 * Accepts: "id1=path1,id2=path2"  |  ["id1=path1", ...]  |  "name=path"
 */
export function parseLoraModulesFlag(spec) {
  const out = [];
  if (!spec) return out;
  const parts = Array.isArray(spec) ? spec : String(spec).split(',');
  for (const raw of parts) {
    const s = String(raw).trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq > 0) {
      const id = s.slice(0, eq).trim();
      const path = s.slice(eq + 1).trim();
      if (id && path) out.push({ id, path });
    } else {
      // bare path -> derive id from the last path segment
      const id = s.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || s;
      out.push({ id, path: s });
    }
  }
  return out;
}

/**
 * Estimate the VRAM the adapter pool adds on top of the base, and whether it
 * fits. Adapter size ~= 2 * rank * num_layers * hidden * 2 targets * 2 bytes.
 *
 * @param {Array<{rank?:number}>} adapters
 * @param {number} base_params_b   base model size (billions of params)
 * @param {number} [kv_reserve_mb] VRAM reserved for KV (advisory)
 * @returns {{est_vram_mb:number, fits:boolean, per_adapter_mb:number,
 *            base_mb:number}}
 */
export function estimateAdapterPoolVram(adapters, base_params_b, kv_reserve_mb = 0, opts = {}) {
  const list = Array.isArray(adapters) ? adapters : [];
  const hidden = _isFiniteNumber(opts.hidden_size) ? opts.hidden_size : 4096;
  const layers = _isFiniteNumber(opts.num_layers) ? opts.num_layers : 32;
  const bytes = _isFiniteNumber(opts.bytes_per_param) ? opts.bytes_per_param : 2; // bf16
  const targetMods = _isFiniteNumber(opts.target_modules) ? opts.target_modules : 7; // q,k,v,o,gate,up,down
  // base weights in MB at the artifact precision (default bf16 ~2 bytes/param).
  const baseBytesPerParam = _isFiniteNumber(opts.base_bytes_per_param) ? opts.base_bytes_per_param : 2;
  const base_mb = _isFiniteNumber(base_params_b) && base_params_b > 0
    ? Math.round((base_params_b * 1e9 * baseBytesPerParam) / (1024 * 1024)) : 0;

  let pool_mb = 0;
  let per_adapter_sum = 0;
  for (const a of list) {
    const rank = _isFiniteNumber(a && a.rank) ? a.rank : 16;
    // LoRA A+B for each target module across layers: 2 * rank * hidden * 2-bytes * targets * layers
    const aMb = (2 * rank * hidden * bytes * targetMods * layers) / (1024 * 1024);
    pool_mb += aMb;
    per_adapter_sum += aMb;
  }
  const per_adapter_mb = list.length ? Math.round((per_adapter_sum / list.length) * 100) / 100 : 0;
  const est_vram_mb = Math.round(base_mb + pool_mb + (kv_reserve_mb || 0));
  const budget_mb = _isFiniteNumber(opts.vram_budget_mb) ? opts.vram_budget_mb : null;
  const fits = budget_mb != null ? est_vram_mb <= budget_mb * 0.95 : true;
  return { est_vram_mb, fits, per_adapter_mb, base_mb, pool_mb: Math.round(pool_mb) };
}

/**
 * Build a multi-LoRA serving plan from a manifest + hardware probe.
 *
 * @param {object} manifest  artifact manifest (reads base_model, lora_modules)
 * @param {object} hwProbe   forge-hardware detectHardware() shape (or {primary})
 * @param {{modules?:Array, runtime?:string, max_loras?:number,
 *          max_lora_rank?:number, base_params_b?:number}} [opts]
 * @returns {{ok:boolean, runtime:string, base_model:string|null,
 *            modules:Array<{id,path,rank}>, max_loras:number, max_lora_rank:number,
 *            enable_lora:boolean, vram:object, vllm_args:string[], env:object,
 *            supported:boolean, reason:string}}
 */
export function planMultiLora(manifest = {}, hwProbe = {}, opts = {}) {
  const runtime = _lower(opts.runtime || 'vllm') || 'vllm';
  const base_model = (manifest && (manifest.base_model ||
    (manifest.runtime && manifest.runtime.base_model))) || null;

  // Resolve modules: explicit opts.modules > manifest.lora_modules > none.
  let modules = [];
  if (Array.isArray(opts.modules) && opts.modules.length) {
    modules = opts.modules.map((m) => ({ id: m.id, path: m.path, rank: _isFiniteNumber(m.rank) ? m.rank : (manifest.lora_rank || 16) }));
  } else if (Array.isArray(manifest.lora_modules)) {
    modules = manifest.lora_modules.map((m) => ({ id: m.id || m.adapter_id, path: m.path, rank: _isFiniteNumber(m.rank) ? m.rank : (manifest.lora_rank || 16) }));
  }

  const ranks = modules.map((m) => m.rank).filter(_isFiniteNumber);
  const max_lora_rank = _isFiniteNumber(opts.max_lora_rank) ? opts.max_lora_rank
    : (ranks.length ? Math.max(...ranks) : 16);
  const max_loras = _isFiniteNumber(opts.max_loras) ? opts.max_loras
    : Math.max(1, modules.length || 1);

  // VRAM estimate.
  const primary = hwProbe && (hwProbe.primary || (typeof hwProbe.vram_gb === 'number' ? hwProbe : null));
  const vramGb = primary && _isFiniteNumber(primary.vram_gb) ? primary.vram_gb : null;
  const base_params_b = _isFiniteNumber(opts.base_params_b) ? opts.base_params_b : (manifest.params_b || null);
  const vram = estimateAdapterPoolVram(modules, base_params_b, opts.kv_reserve_mb || 0, {
    vram_budget_mb: vramGb != null ? vramGb * 1024 : null,
    hidden_size: manifest.hidden_size,
    num_layers: manifest.num_hidden_layers,
  });

  // vLLM only path drives multi-LoRA today (--enable-lora).
  const supported = runtime === 'vllm';
  const enable_lora = supported && modules.length > 0;

  const vllm_args = [];
  if (enable_lora) {
    vllm_args.push('--enable-lora', '--max-loras', String(max_loras), '--max-lora-rank', String(max_lora_rank));
    for (const m of modules) {
      vllm_args.push('--lora-modules', `${m.id}=${m.path}`);
    }
  }

  const env = {};
  if (enable_lora) {
    env.KOLM_ENABLE_LORA = '1';
    env.KOLM_LORA_MODULES = modules.map((m) => `${m.id}=${m.path}`).join(',');
    env.KOLM_MAX_LORAS = String(max_loras);
    env.KOLM_MAX_LORA_RANK = String(max_lora_rank);
  }

  let reason;
  if (!supported) reason = `multi-LoRA serving requires the vLLM runtime; ${runtime} not supported`;
  else if (!modules.length) reason = 'no LoRA adapters resolved (manifest.lora_modules empty and no --lora-modules)';
  else if (!vram.fits) reason = `adapter pool may not fit: est ${vram.est_vram_mb}MB on ${vramGb}GB GPU`;
  else reason = `multi-LoRA on vLLM: ${modules.length} adapter(s), max_loras=${max_loras}, max_rank=${max_lora_rank}`;

  return {
    ok: supported && modules.length > 0 && vram.fits,
    runtime, base_model, modules, max_loras, max_lora_rank,
    enable_lora, vram, vllm_args, env, supported, reason,
  };
}

// ===========================================================================
// TOP-LEVEL COMPOSER + dry-run renderer
// ===========================================================================

/**
 * Compose the full serve config from an artifact descriptor + hardware probe.
 * Pure: never boots a server. The CLI/deploy/probe callers render or forward it.
 *
 * @param {{artifact?:object, manifest?:object, hardware?:object,
 *          workload?:string, runtime?:string, requested?:object,
 *          draftPicker?:Function, tp?:number}} args
 * @returns {object} full serve-config envelope
 */
export function buildServeConfig({
  artifact = {},
  manifest,
  hardware = {},
  workload = 'agent',
  runtime,
  requested = {},
  draftPicker,
  tp = 1,
} = {}) {
  const mf = manifest || artifact || {};
  const cc = _ccFromHardware(hardware);
  const target = mf.base_model || (mf.runtime && mf.runtime.base_model) ||
    (mf.speculative_decoding && mf.speculative_decoding.target_model) || mf.model || null;
  const rt = _lower(runtime) || _lower(requested.runtime) || 'vllm';

  // 1. Kernel.
  const quantDescriptor = quantDescriptorFromArtifact(mf);
  const kernel = resolveServingKernel(quantDescriptor, cc, { engine: rt === 'sglang' ? 'sglang' : 'vllm' });

  // 2. KV policy.
  const kv = selectKvCachePolicy({
    format: rt,
    modelMeta: {
      family: mf.family,
      has_rope: mf.has_rope,
      num_hidden_layers: mf.num_hidden_layers,
      artifact_id: mf.artifact_id || mf.artifact_hash || mf.id || target,
      base_model: target,
      kv_profile: mf.kv_profile,
    },
    hardware,
    workload,
    requested: requested.kv_policy || 'auto',
    budget: requested.kv_budget,
    sink_tokens: requested.kv_sink,
    window_tokens: requested.kv_window,
    group_size: requested.kv_group,
    residual_length: requested.kv_residual,
  });

  // 3. Speculative.
  const speculative = target
    ? resolveEagleHead({ target, manifest: mf, runtime: rt, flag: requested.speculative, numSpeculativeTokens: requested.num_speculative_tokens, draftPicker })
    : null;
  const vllm_spec = speculative ? buildVllmSpeculativeConfig(speculative, { tp }) : null;
  const speculative_tree_policy = speculative ? buildSpeculativeTreePolicy(speculative, { runtime: rt }) : null;
  const sglang_spec = speculative ? buildSglangSpecArgs(speculative) : [];
  const llamacpp_spec = speculative ? buildLlamaCppDraftArgs(speculative) : [];

  // 4. Serving features.
  const features = resolveServingFeatures({
    workload, hardware, runtime: rt, maxModelLen: requested.max_model_len || 8192, manifest: mf, requested,
  });

  // 5. Multi-LoRA.
  const lora = planMultiLora(mf, hardware, {
    runtime: rt, modules: requested.lora_modules ? parseLoraModulesFlag(requested.lora_modules) : undefined,
  });

  // Assemble per-engine arg lists + a merged env contract.
  const vllm = {
    quantization: kernel.vllm_quantization,
    kv_cache_dtype: kernel.kv_cache_dtype,
    speculative_config: vllm_spec,
    speculative_tree_policy: rt === 'vllm' ? speculative_tree_policy : null,
    config: features.vllm_config,
    args: [
      ...(kernel.vllm_quantization ? ['--quantization', kernel.vllm_quantization] : []),
      '--kv-cache-dtype', kernel.kv_cache_dtype,
      ...features.vllm_args,
      ...lora.vllm_args,
    ],
  };
  const sglang = { args: [...features.sglang_args, ...sglang_spec] };
  const llamacpp = { args: [...llamacpp_spec] };

  const env = {
    ...features.env,
    ...lora.env,
    ...(kernel.vllm_quantization ? { KOLM_SERVE_QUANTIZATION: kernel.vllm_quantization } : {}),
    KOLM_SERVE_KV_CACHE_DTYPE: kernel.kv_cache_dtype,
    KOLM_KV_POLICY: JSON.stringify({ policy: kv.policy, kind: kv.kind, params: kv.params }),
    ...(speculative && speculative.supported && speculative.head_id
      ? {
          KOLM_SPEC_HEAD_KIND: speculative.head_kind,
          KOLM_SERVE_SPECULATIVE_DRAFT: speculative.head_id,
          KOLM_NUM_SPECULATIVE_TOKENS: String(speculative.num_speculative_tokens),
          ...(_isFiniteNumber(speculative.eagle_topk) ? { KOLM_SPEC_EAGLE_TOPK: String(Math.floor(speculative.eagle_topk)) } : {}),
          ...(_isFiniteNumber(speculative.num_steps) ? { KOLM_SPEC_NUM_STEPS: String(Math.floor(speculative.num_steps)) } : {}),
          ...(_isFiniteNumber(speculative.num_draft_tokens) ? { KOLM_SPEC_NUM_DRAFT_TOKENS: String(Math.floor(speculative.num_draft_tokens)) } : {}),
        }
      : {}),
  };

  return {
    version: SERVE_CONFIG_VERSION,
    target_model: target,
    runtime: rt,
    compute_capability: cc,
    kernel, kv, speculative, speculative_tree_policy, features, lora,
    vllm, sglang, llamacpp, env,
    reason: [kernel.gate.reason, kv.reason, features.reason, lora.reason].filter(Boolean).join(' | '),
  };
}

/** Multi-line --dry-run banner for the whole serve config. */
export function formatServeConfigReport(cfg) {
  if (!cfg || typeof cfg !== 'object') return '(no serve config)';
  const lines = [
    `kolm serve config (${cfg.version})`,
    `  target          : ${cfg.target_model || '(unknown)'}`,
    `  runtime         : ${cfg.runtime}`,
    `  compute_cap     : ${cfg.compute_capability || '(unknown)'}`,
    `  kernel          : ${cfg.kernel.kernel}${cfg.kernel.vllm_quantization ? ` (vllm: ${cfg.kernel.vllm_quantization})` : ''}`,
    `    gate          : ${cfg.kernel.gate.reason}${cfg.kernel.gate.blocked ? ' [BLOCKED]' : ''}`,
    `    est speedup   : ${cfg.kernel.est_speedup_x != null ? cfg.kernel.est_speedup_x + 'x' : 'n/a'}`,
    `  kv policy       : ${cfg.kv.policy} (${cfg.kv.kind}, enforce=${cfg.kv.runtime_can_enforce})`,
    `  speculative     : ${cfg.speculative && cfg.speculative.head_id ? `${cfg.speculative.head_kind} ${cfg.speculative.head_id} K=${cfg.speculative.num_speculative_tokens}` : 'off'}`,
    `  spec tree       : ${cfg.speculative_tree_policy ? `topk=${cfg.speculative_tree_policy.eagle_topk ?? 'n/a'} steps=${cfg.speculative_tree_policy.num_steps ?? 'n/a'} draft_tokens=${cfg.speculative_tree_policy.num_draft_tokens ?? 'n/a'} enforced=${cfg.speculative_tree_policy.engine_configurable}` : 'off'}`,
    `  prefix_cache    : ${cfg.features.prefix_cache}`,
    `  chunked_prefill : ${cfg.features.chunked_prefill}`,
    `  max_num_batched : ${cfg.features.max_num_batched_tokens}`,
    `  multi-lora      : ${cfg.lora.enable_lora ? `${cfg.lora.modules.length} adapter(s)` : 'off'}`,
  ];
  return lines.join('\n');
}

export default {
  SERVE_CONFIG_VERSION,
  QUANT_KERNEL_ORACLE_VERSION,
  KV_POLICY_VERSION,
  EAGLE_RESOLVER_VERSION,
  parseComputeCapability,
  // kernel oracle
  kernelCapabilityForCC,
  quantDescriptorFromArtifact,
  vllmQuantizationString,
  resolveServingKernel,
  servingKernelPassportEntry,
  // kv policy
  KV_POLICIES,
  resolveWorkloadPolicy,
  selectKvCachePolicy,
  kvPolicyPassportEntry,
  emitKvPolicyVllmConfig,
  // speculative
  EAGLE_HEAD_KINDS,
  EAGLE_HEAD_REGISTRY,
  resolveEagleHead,
  buildVllmSpeculativeConfig,
  buildSpeculativeTreePolicy,
  buildSglangSpecArgs,
  buildLlamaCppDraftArgs,
  speculativeHeadPassportEntry,
  // serving features
  resolveServingFeatures,
  emitVllmServeArgs,
  emitSglangServeArgs,
  formatServingFeaturesReport,
  // multi-lora
  parseLoraModulesFlag,
  estimateAdapterPoolVram,
  planMultiLora,
  // composer
  buildServeConfig,
  formatServeConfigReport,
};
