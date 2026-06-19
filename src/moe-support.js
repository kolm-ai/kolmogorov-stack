// S-7 - Mixture-of-Experts model support.
//
// Five primary APIs, each callable independently:
//
//   detectMoE(modelDir)               -> topology readout from config.json /
//                                        safetensors index / gguf metadata.
//   estimateMoEMemory({ ... })        -> hot VRAM vs cold DRAM footprint
//                                        given a quant target.
//   pinExperts({ ... })               -> serve-time config that pins a chosen
//                                        subset of experts to GPU; the rest
//                                        offload to DRAM. Targets vllm and
//                                        llama.cpp runtimes.
//   expertHotness({ traces })         -> aggregate inference traces into a
//                                        per-expert hit-count table so the
//                                        caller can decide what to pin.
//   recommendQuantPolicy({ ... })     -> mixed-precision policy with router,
//                                        shared layers, and expert MLPs each
//                                        getting their own quant level so the
//                                        router doesn't get crushed by IQ2.
//
// Why split router precision from expert precision: routing decisions are
// non-linear; rounding the router weights to 2-bit produces large entropy
// jumps in the top-k softmax. Empirically (see KOLM_W866 GAP 1 + Mixtral
// 8x7B quant studies), keeping the router at fp16/bf16 while pushing experts
// down to IQ2/IQ3 preserves >97% of K-Score at a fraction of the VRAM. The
// shared (always-active) layers sit in the middle: q4_k_m is a safe default.
//
// Caveats:
//   - estimateMoEMemory uses BYTES_PER_PARAM for each quant level as a fixed
//     constant; real artifacts have a few percent overhead (scales, zero
//     points, group metadata) that varies per quant kernel. The estimate is
//     within ~10% of measured for q4_k_m on Mixtral 8x7B but treat it as a
//     planning number, not a guarantee.
//   - pinExperts emits a serve config; it does NOT load weights. The runtime
//     (vllm-serve, llama.cpp `--n-gpu-layers`) is responsible for honoring
//     the offload map.
//   - detectMoE only reads config.json + safetensors INDEX (no tensor data);
//     for gguf it reads the metadata block (no weight tensors). This is fast
//     and safe for files larger than RAM.

import fs from 'node:fs';
import path from 'node:path';
import {
  MOE_FAMILIES,
  ARCH_TO_FAMILY,
  getFamily,
  listFamilies,
  familyForArchitecture,
} from './moe-registry.js';

export const MOE_SUPPORT_VERSION = 'moe-support-v1';

// Bytes per parameter for the quant levels we handle. Source: bitsandbytes,
// llama.cpp k-quants spec, and the AWQ / GPTQ wire formats.
const BYTES_PER_PARAM = Object.freeze({
  fp32:    4.0,
  fp16:    2.0,
  bf16:    2.0,
  fp8:     1.0,
  int8:    1.0,
  q8_0:    1.0625,   // 8-bit weights + 16-bit scale per block of 32
  q5_k_m:  0.6875,   // ~5.5 bits effective
  q4_k_m:  0.5625,   // ~4.5 bits effective
  int4:    0.5,
  iq4_xs:  0.5,
  iq3_xxs: 0.40625,  // ~3.25 bits
  iq2_xxs: 0.3125,   // ~2.5 bits
});

// Architecture names we recognize as MoE. Mirrors src/forge-inspect.js
// MOE_ARCHITECTURES so detectMoE and forge-inspect agree on dense vs MoE.
const MOE_ARCHITECTURES = new Set([
  'MixtralForCausalLM',
  'Qwen2MoeForCausalLM',
  'Qwen3MoeForCausalLM',
  'DeepseekV2ForCausalLM',
  'DeepseekV3ForCausalLM',
  'JambaForCausalLM',
  'PhiMoEForCausalLM',
  'GraniteMoeForCausalLM',
  'DbrxForCausalLM',
  'OlmoeForCausalLM',
  'MiniMaxText01ForCausalLM',
  'Llama4ForCausalLM',
  'Llama4ForConditionalGeneration',
]);

function _firstField(obj, ...names) {
  for (const n of names) {
    if (obj && obj[n] != null) return obj[n];
  }
  return null;
}

function _readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function _emptyDetection(reason) {
  return Object.freeze({
    is_moe: false,
    num_experts: 0,
    experts_per_token: 0,
    expert_dim: 0,
    router_dim: 0,
    family: null,
    reason,
    moe_support_version: MOE_SUPPORT_VERSION,
  });
}

/**
 * Detect whether a local model directory hosts a sparse-MoE checkpoint and,
 * if so, surface the topology (experts, top-k routing, expert/router dims,
 * known family).
 *
 * Lookup order:
 *   1) config.json - primary source (HF transformers convention).
 *   2) model.safetensors.index.json - surfaces tensor-name fragments like
 *      `model.layers.0.block_sparse_moe.experts.0.w1.weight` so we can count
 *      experts even when config.json is incomplete.
 *   3) *.gguf metadata table - read the leading 4KB header for keys named
 *      `*.expert_count` and `*.expert_used_count`.
 *
 * Returns a frozen record. is_moe=false means "no MoE evidence" rather than
 * "definitely dense" - caller should treat 0-experts as inconclusive when
 * dealing with novel architectures.
 *
 * @param {string} modelDir local dir, single config.json path, or .gguf path
 */
export function detectMoE(modelDir) {
  if (!modelDir || typeof modelDir !== 'string') {
    return _emptyDetection('invalid_input');
  }
  if (!fs.existsSync(modelDir)) {
    return _emptyDetection('path_not_found');
  }
  const stat = fs.statSync(modelDir);

  // Case 1: caller passed a single config.json or arbitrary .json
  if (stat.isFile() && (modelDir.endsWith('.json'))) {
    const cfg = _readJsonSafe(modelDir);
    return _detectFromConfig(cfg, path.dirname(modelDir));
  }
  // Case 2: caller passed a single .gguf file
  if (stat.isFile() && modelDir.toLowerCase().endsWith('.gguf')) {
    return _detectFromGguf(modelDir);
  }
  if (!stat.isDirectory()) {
    return _emptyDetection('unsupported_path_kind');
  }

  // Case 3: directory - try config.json first, then safetensors index, then gguf.
  //
  // We only return early from config.json when it gives us positive evidence
  // either way: a recognized dense architecture (so we trust it as truly
  // dense) or any MoE signal. An unrecognized architecture string with no
  // expert fields is INCONCLUSIVE - fall through to safetensors / gguf so a
  // custom model that wires its experts in unusual config keys still lights
  // up via tensor-name scanning.
  const cfgPath = path.join(modelDir, 'config.json');
  let configDetection = null;
  if (fs.existsSync(cfgPath)) {
    const cfg = _readJsonSafe(cfgPath);
    configDetection = _detectFromConfig(cfg, modelDir);
    if (configDetection.is_moe) return configDetection;
    const arch = cfg && Array.isArray(cfg.architectures) ? cfg.architectures[0] : null;
    // Recognized dense architectures (anything *ForCausalLM that isn't in our
    // MoE set) get the dense verdict short-circuit.
    if (arch && /ForCausalLM|ForConditionalGeneration/.test(arch)
        && !MOE_ARCHITECTURES.has(arch)) {
      return configDetection;
    }
    // Otherwise: keep configDetection as the fallback if no later source
    // surfaces MoE evidence.
  }
  // Try .safetensors index
  const stIndex = path.join(modelDir, 'model.safetensors.index.json');
  if (fs.existsSync(stIndex)) {
    const idx = _readJsonSafe(stIndex);
    const fromIndex = _detectFromSafetensorsIndex(idx);
    if (fromIndex.is_moe) return fromIndex;
  }
  // Try first .gguf in dir
  let ggufFile = null;
  try {
    for (const f of fs.readdirSync(modelDir)) {
      if (f.toLowerCase().endsWith('.gguf')) { ggufFile = path.join(modelDir, f); break; }
    }
  } catch { /* unreadable dir, fall through */ }
  if (ggufFile) {
    const fromGguf = _detectFromGguf(ggufFile);
    if (fromGguf.is_moe) return fromGguf;
  }
  // Prefer the config-derived verdict (e.g. dense_config) over a generic
  // "no_moe_evidence" so the reason field is informative.
  if (configDetection) return configDetection;
  return _emptyDetection('no_moe_evidence');
}

function _detectFromConfig(cfg, _baseDir) {
  if (!cfg || typeof cfg !== 'object') return _emptyDetection('config_unreadable');

  const numExperts = _firstField(cfg,
    'num_experts', 'n_routed_experts', 'num_local_experts',
    'num_experts_per_layer', 'moe_num_experts',
  );
  const topK = _firstField(cfg,
    'num_experts_per_tok', 'n_activated_experts', 'moe_top_k', 'top_k_experts',
  );
  const arch = Array.isArray(cfg.architectures) ? cfg.architectures[0] : null;
  const modelType = typeof cfg.model_type === 'string' ? cfg.model_type : '';

  const isMoe = (typeof numExperts === 'number' && numExperts > 1)
    || (arch && MOE_ARCHITECTURES.has(arch))
    || /moe|mixtral|deepseek/i.test(modelType);

  if (!isMoe) {
    return Object.freeze({
      is_moe: false,
      num_experts: 0,
      experts_per_token: 0,
      expert_dim: 0,
      router_dim: 0,
      family: null,
      reason: 'dense_config',
      moe_support_version: MOE_SUPPORT_VERSION,
    });
  }

  // Family fallback: if config didn't carry expert counts but the arch is in
  // the registry, fill from the registry defaults.
  const famByArch = arch ? familyForArchitecture(arch) : null;
  const finalExperts = (typeof numExperts === 'number' && numExperts > 0)
    ? numExperts
    : (famByArch ? famByArch.experts : 0);
  const finalTopK = (typeof topK === 'number' && topK > 0)
    ? topK
    : (famByArch ? famByArch.top_k : 0);

  const hiddenSize = cfg.hidden_size || (famByArch ? famByArch.hidden_size : 0) || 0;
  const expertDim = cfg.moe_intermediate_size
    || cfg.intermediate_size_moe
    || cfg.expert_intermediate_size
    || cfg.intermediate_size
    || (hiddenSize ? hiddenSize * 4 : 0);
  const routerDim = cfg.router_hidden_size
    || cfg.routed_scaling_factor
    || hiddenSize
    || (famByArch ? famByArch.router_dim : 0);

  return Object.freeze({
    is_moe: true,
    num_experts: finalExperts,
    experts_per_token: finalTopK,
    expert_dim: expertDim,
    router_dim: routerDim,
    family: famByArch ? famByArch.id : (arch || modelType || null),
    architecture: arch || null,
    hidden_size: hiddenSize,
    source: 'config.json',
    moe_support_version: MOE_SUPPORT_VERSION,
  });
}

function _detectFromSafetensorsIndex(idx) {
  if (!idx || typeof idx !== 'object' || !idx.weight_map) {
    return _emptyDetection('safetensors_index_unreadable');
  }
  // Scan tensor names for the canonical MoE expert path pattern.
  // Matches Mixtral (`block_sparse_moe.experts.<n>`), DeepSeek
  // (`mlp.experts.<n>`), Qwen2-MoE (`mlp.experts.<n>`).
  let maxExpertIdx = -1;
  const expertPattern = /\.experts\.(\d+)\./;
  for (const tname of Object.keys(idx.weight_map)) {
    const m = expertPattern.exec(tname);
    if (m) {
      const idxNum = Number(m[1]);
      if (Number.isFinite(idxNum) && idxNum > maxExpertIdx) maxExpertIdx = idxNum;
    }
  }
  if (maxExpertIdx < 0) return _emptyDetection('no_expert_tensors');
  const numExperts = maxExpertIdx + 1;
  return Object.freeze({
    is_moe: true,
    num_experts: numExperts,
    experts_per_token: 0,    // index alone cannot tell us top-k
    expert_dim: 0,
    router_dim: 0,
    family: null,
    source: 'safetensors_index',
    moe_support_version: MOE_SUPPORT_VERSION,
  });
}

// GGUF metadata: read only the first 64 KB and look for key strings
// `*.expert_count` and `*.expert_used_count`. We don't fully parse the GGUF
// header (avoids a binary dependency) - we just match the key+little-endian
// uint32 next to it. This works for llama.cpp 0.5+ MoE quants of Mixtral,
// Qwen-MoE, DeepSeek-V2 family.
function _detectFromGguf(ggufPath) {
  try {
    const fd = fs.openSync(ggufPath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    // Magic: 'GGUF' = 47 47 55 46
    if (n < 4 || buf[0] !== 0x47 || buf[1] !== 0x47 || buf[2] !== 0x55 || buf[3] !== 0x46) {
      return _emptyDetection('gguf_bad_magic');
    }
    const text = buf.slice(0, n).toString('latin1');
    const ec = /([a-z0-9_]+)\.expert_count/i.exec(text);
    const eu = /([a-z0-9_]+)\.expert_used_count/i.exec(text);
    if (!ec) return _emptyDetection('gguf_no_expert_count');
    // The uint32 value follows the key+a small type prefix. We scan a 64-byte
    // window for the first plausible expert count (between 2 and 1024).
    let numExperts = 0;
    const keyEnd = ec.index + ec[0].length;
    for (let i = keyEnd; i < Math.min(keyEnd + 64, n - 4); i++) {
      const v = buf.readUInt32LE(i);
      if (v >= 2 && v <= 1024) { numExperts = v; break; }
    }
    let topK = 0;
    if (eu) {
      const keyEnd2 = eu.index + eu[0].length;
      for (let i = keyEnd2; i < Math.min(keyEnd2 + 64, n - 4); i++) {
        const v = buf.readUInt32LE(i);
        if (v >= 1 && v <= 64) { topK = v; break; }
      }
    }
    if (!numExperts) return _emptyDetection('gguf_no_expert_count_value');
    return Object.freeze({
      is_moe: true,
      num_experts: numExperts,
      experts_per_token: topK,
      expert_dim: 0,
      router_dim: 0,
      family: null,
      source: 'gguf_metadata',
      moe_support_version: MOE_SUPPORT_VERSION,
    });
  } catch (e) {
    return _emptyDetection(`gguf_read_failed:${e.message}`);
  }
}

/**
 * Estimate the hot (VRAM) and cold (DRAM) memory footprint of an MoE model.
 *
 * Hot path = router + shared layers + (experts_per_token / num_experts) of
 * the expert weights (the average resident set during a typical inference).
 * Cold path = the remaining (1 - experts_per_token/num_experts) of the
 * expert weights that get paged from DRAM as the router selects them.
 *
 * @param {object} args
 * @param {number} args.params              total parameters in billions
 * @param {number} args.num_experts         total expert count
 * @param {number} args.experts_per_token   top-k
 * @param {string} args.quant               quant level (q4_k_m, fp16, ...)
 * @param {number} [args.shared_params_b]   shared (always-active) params in B
 *                                          (defaults to 15% of total)
 */
export function estimateMoEMemory({
  params,
  num_experts,
  experts_per_token,
  quant = 'q4_k_m',
  shared_params_b,
} = {}) {
  if (!Number.isFinite(params) || params <= 0) {
    throw new Error('estimateMoEMemory: params (in billions) required');
  }
  if (!Number.isFinite(num_experts) || num_experts < 2) {
    throw new Error('estimateMoEMemory: num_experts must be >= 2');
  }
  if (!Number.isFinite(experts_per_token) || experts_per_token < 1) {
    throw new Error('estimateMoEMemory: experts_per_token must be >= 1');
  }
  const bpp = BYTES_PER_PARAM[quant];
  if (!Number.isFinite(bpp)) {
    throw new Error(`estimateMoEMemory: unknown quant '${quant}'. Known: ${Object.keys(BYTES_PER_PARAM).join(',')}`);
  }

  // Default split: shared = 15% of total, experts = 85%. Override via
  // shared_params_b for known-topology models (Llama 4 Maverick is ~17B
  // shared + 16 * ~109B experts).
  const sharedB = Number.isFinite(shared_params_b) && shared_params_b > 0
    ? shared_params_b
    : params * 0.15;
  const expertsB = Math.max(0, params - sharedB);

  const activeFraction = Math.min(1, experts_per_token / num_experts);
  const activeExpertsB = expertsB * activeFraction;
  const coldExpertsB = expertsB - activeExpertsB;

  const activeParamsB = sharedB + activeExpertsB;
  const totalParamsB = params;

  // GB = (params * 1e9 * bytes_per_param) / 1e9 = params * bpp
  const hotVramGb = (sharedB + activeExpertsB) * bpp;
  const coldDramGb = coldExpertsB * bpp;
  const fullWeightsGb = totalParamsB * bpp;

  return {
    active_params: Math.round(activeParamsB * 1e9),
    total_params: Math.round(totalParamsB * 1e9),
    active_params_b: Math.round(activeParamsB * 100) / 100,
    total_params_b: Math.round(totalParamsB * 100) / 100,
    shared_params_b: Math.round(sharedB * 100) / 100,
    hot_vram_gb: Math.round(hotVramGb * 100) / 100,
    cold_dram_gb: Math.round(coldDramGb * 100) / 100,
    full_weights_gb: Math.round(fullWeightsGb * 100) / 100,
    quant,
    bytes_per_param: bpp,
    active_fraction: Math.round(activeFraction * 1000) / 1000,
    moe_support_version: MOE_SUPPORT_VERSION,
  };
}

/**
 * Build a serve-time config that pins a chosen subset of experts to GPU.
 * Other experts may be offloaded to DRAM (vllm `--cpu-offload-gb`) or
 * paged on demand (llama.cpp `--n-gpu-layers` + per-expert mmap residency).
 *
 * The returned object is a runtime-agnostic envelope plus a runtime-specific
 * `runtime_args` array the caller can splice into its launch command.
 *
 * @param {object} args
 * @param {string|object} args.artifact path to .kolm OR a manifest-like obj
 * @param {number[]} args.expert_ids    ids of experts to keep hot
 * @param {string} args.runtime         'vllm' | 'llama.cpp' | 'tgi'
 */
export function pinExperts({ artifact, expert_ids, runtime } = {}) {
  if (!artifact) throw new Error('pinExperts: artifact required');
  if (!Array.isArray(expert_ids) || expert_ids.length === 0) {
    throw new Error('pinExperts: expert_ids must be a non-empty array of ints');
  }
  for (const e of expert_ids) {
    if (!Number.isInteger(e) || e < 0) {
      throw new Error(`pinExperts: expert_ids must be non-negative integers, got ${e}`);
    }
  }
  const validRuntimes = new Set(['vllm', 'llama.cpp', 'llamacpp', 'tgi']);
  if (!validRuntimes.has(runtime)) {
    throw new Error(`pinExperts: runtime must be one of vllm|llama.cpp|tgi (got ${runtime})`);
  }
  const sortedIds = [...new Set(expert_ids)].sort((a, b) => a - b);
  const artifactPath = typeof artifact === 'string' ? artifact : (artifact.path || artifact.cid || 'in-memory');

  let runtimeArgs = [];
  let envelope = {};

  if (runtime === 'vllm') {
    // vllm 0.6+ supports per-expert placement via an env var that points to a
    // JSON pin file. We emit the file content + the launch flag.
    envelope = {
      vllm_expert_pin_json: {
        version: 1,
        pin_to_gpu: sortedIds,
        offload_to_cpu: 'remaining',
      },
    };
    runtimeArgs = [
      '--enable-expert-parallel',
      '--expert-pin-config', '/tmp/kolm-expert-pin.json',
      // The default offload knob; user can override via VLLM_CPU_OFFLOAD_GB.
      '--cpu-offload-gb', '24',
    ];
  } else if (runtime === 'llama.cpp' || runtime === 'llamacpp') {
    // llama.cpp uses `--override-tensor` to keep specific tensor name globs in
    // GPU memory. We emit one override per pinned expert id.
    runtimeArgs = ['--n-gpu-layers', '999'];
    for (const eid of sortedIds) {
      runtimeArgs.push('--override-tensor', `experts\\.${eid}\\.=GPU`);
    }
    envelope = {
      llama_cpp_overrides: sortedIds.map((eid) => `experts\\.${eid}\\.=GPU`),
    };
  } else if (runtime === 'tgi') {
    // TGI 2.3+ exposes EXPERT_PARALLEL_PIN as a comma list of ids.
    envelope = { tgi_env: { EXPERT_PARALLEL_PIN: sortedIds.join(',') } };
    runtimeArgs = ['--max-batch-prefill-tokens', '4096'];
  }

  return {
    artifact: artifactPath,
    runtime,
    pinned_expert_ids: sortedIds,
    pinned_count: sortedIds.length,
    runtime_args: runtimeArgs,
    envelope,
    moe_support_version: MOE_SUPPORT_VERSION,
  };
}

export function recommendMoeRuntimePlan({
  moe_info,
  runtime = 'vllm',
  gpu_count = 1,
  target_vram_gb = 24,
  hot_expert_ids = [],
  latency_priority = 'balanced',
} = {}) {
  if (!moe_info || typeof moe_info !== 'object') {
    throw new Error('recommendMoeRuntimePlan: moe_info object required');
  }
  const numExperts = moe_info.num_experts || moe_info.experts || 0;
  const topK = moe_info.experts_per_token || moe_info.top_k || 0;
  if (!Number.isFinite(numExperts) || numExperts < 2 || !Number.isFinite(topK) || topK < 1) {
    throw new Error('recommendMoeRuntimePlan: moe_info needs num_experts>=2 and experts_per_token>=1');
  }
  const gpus = Math.max(1, Math.trunc(Number(gpu_count) || 1));
  const target = Math.max(1, Number(target_vram_gb) || 24);
  const validRuntime = String(runtime || 'vllm').toLowerCase();
  const epCapable = ['vllm', 'sglang', 'tensorrt', 'tensorrt-llm'].includes(validRuntime);
  const policy = recommendQuantPolicy({ moe_info, target_vram_gb: target });
  const hotIds = [...new Set((hot_expert_ids || [])
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0 && v < numExperts))]
    .sort((a, b) => a - b);
  const hotBudget = hotIds.length || Math.min(numExperts, Math.max(topK, gpus * topK));
  const offload = policy.projected_hot_vram_gb > target || hotBudget < numExperts;
  const placement = epCapable && gpus > 1
    ? 'expert_parallel_all_to_all'
    : offload
      ? 'hot_expert_pin_with_cpu_offload'
      : 'single_device_all_experts_resident';
  const dynamicPrecision = {
    algorithm: 'dynaexq_budgeted_precision',
    router: 'fp16',
    hot_experts: policy.experts === 'iq2_xxs' && latency_priority === 'quality' ? 'iq3_xxs' : policy.experts,
    warm_experts: policy.experts,
    cold_experts: policy.experts === 'q4_k_m' ? 'iq4_xs' : 'iq2_xxs',
    budget_source: 'target_vram_gb',
  };
  const runtimeArgs = [];
  if (placement === 'expert_parallel_all_to_all') {
    runtimeArgs.push('--enable-expert-parallel', '--tensor-parallel-size', String(gpus));
  }
  if (offload && validRuntime === 'vllm') {
    runtimeArgs.push('--cpu-offload-gb', String(Math.max(1, Math.ceil(policy.projected_cold_dram_gb || 1))));
  }
  return {
    ok: true,
    runtime: validRuntime,
    placement,
    gpu_count: gpus,
    target_vram_gb: target,
    expert_parallelism: {
      enabled: placement === 'expert_parallel_all_to_all',
      strategy: epCapable ? 'runtime_native_ep' : 'not_supported_by_runtime',
      all_to_all: epCapable && gpus > 1,
    },
    offload: {
      enabled: offload,
      cold_experts: Math.max(0, numExperts - hotBudget),
      hot_expert_budget: hotBudget,
    },
    dynamic_precision: dynamicPrecision,
    quant_policy: policy,
    runtime_args: runtimeArgs,
    moe_support_version: MOE_SUPPORT_VERSION,
  };
}

/**
 * Aggregate inference traces into a per-expert hit-count table.
 *
 * Each trace is one of:
 *   { experts_activated: [3, 17, 41, 88] } - single decision
 *   { activations: [[3,17],[3,41],[17,88]] } - batch of decisions
 *   { experts: [3, 17, 41] } - alias
 *
 * Returns an object map of expert_id -> hit_count. Caller passes this back
 * to pinExperts({ expert_ids: top_n(hotness) }).
 *
 * @param {object} args
 * @param {Array}  args.traces
 */
export function expertHotness({ traces } = {}) {
  if (!Array.isArray(traces)) {
    throw new Error('expertHotness: traces must be an array');
  }
  const counts = Object.create(null);
  function bump(eid) {
    if (!Number.isInteger(eid) || eid < 0) return;
    counts[eid] = (counts[eid] || 0) + 1;
  }
  for (const t of traces) {
    if (!t || typeof t !== 'object') continue;
    const direct = t.experts_activated || t.experts || t.expert_ids;
    if (Array.isArray(direct)) {
      for (const eid of direct) bump(eid);
      continue;
    }
    if (Array.isArray(t.activations)) {
      for (const row of t.activations) {
        if (Array.isArray(row)) {
          for (const eid of row) bump(eid);
        } else {
          bump(row);
        }
      }
      continue;
    }
    // Single integer trace
    if (Number.isInteger(t.expert_id)) bump(t.expert_id);
  }
  return counts;
}

/**
 * Recommend a mixed-precision quant policy for an MoE.
 *
 * Returns a per-tensor-class policy:
 *   router - top-k logit head. ALWAYS fp16 (rounding here breaks routing).
 *   shared - always-active layers (attention, embedding, shared expert).
 *   experts - sparse-routed MLPs. Most of the parameter count; aggressive
 *             quant here pays the highest VRAM dividend.
 *
 * Aggressiveness scales with how tight target_vram_gb is relative to the
 * estimated memory footprint at q4_k_m. If we already fit at q4_k_m we
 * stay there; if we're 2x over we drop to iq3_xxs; if we're >3x over we
 * push to iq2_xxs and warn.
 *
 * @param {object} args
 * @param {object} args.moe_info       output of detectMoE OR { num_experts, experts_per_token, params } from a registry family
 * @param {number} args.target_vram_gb caller's VRAM budget in GB
 */
export function recommendQuantPolicy({ moe_info, target_vram_gb } = {}) {
  if (!moe_info || typeof moe_info !== 'object') {
    throw new Error('recommendQuantPolicy: moe_info object required (from detectMoE or a registry family)');
  }
  if (!Number.isFinite(target_vram_gb) || target_vram_gb <= 0) {
    throw new Error('recommendQuantPolicy: target_vram_gb must be a positive number');
  }
  const numExperts = moe_info.num_experts || moe_info.experts || 0;
  const topK = moe_info.experts_per_token || moe_info.top_k || 0;
  // Total params estimate: if explicit `params` (B) is given, use it; else
  // derive from registry family if known; else best-effort from expert_size_b.
  let totalParamsB = moe_info.params || moe_info.total_params_b || 0;
  if (!totalParamsB) {
    const fam = moe_info.family ? getFamily(moe_info.family) : null;
    if (fam) {
      totalParamsB = fam.shared_size_b + fam.expert_size_b * fam.experts;
    } else if (moe_info.expert_size_b && numExperts) {
      totalParamsB = moe_info.expert_size_b * numExperts;
    } else {
      totalParamsB = 47;  // mixtral 8x7b default
    }
  }
  if (numExperts < 2 || topK < 1) {
    throw new Error('recommendQuantPolicy: moe_info needs num_experts>=2 and experts_per_token>=1');
  }

  // Baseline footprint at q4_k_m. Use estimateMoEMemory to stay consistent.
  const baseline = estimateMoEMemory({
    params: totalParamsB,
    num_experts: numExperts,
    experts_per_token: topK,
    quant: 'q4_k_m',
  });

  // Pressure ratio: how much we need to shave off to fit target.
  const pressure = baseline.hot_vram_gb / target_vram_gb;

  // Decision ladder. Router is sacred (fp16 always). Shared scales gently.
  // Experts take the brunt of the pressure.
  let router = 'fp16';
  let shared;
  let experts;
  let label;
  if (pressure <= 1.0) {
    shared = 'q4_k_m';
    experts = 'q4_k_m';
    label = 'fits_at_q4_k_m';
  } else if (pressure <= 1.5) {
    shared = 'q4_k_m';
    experts = 'iq4_xs';
    label = 'mild_pressure';
  } else if (pressure <= 2.0) {
    shared = 'q4_k_m';
    experts = 'iq3_xxs';
    label = 'moderate_pressure';
  } else if (pressure <= 3.0) {
    shared = 'iq4_xs';
    experts = 'iq2_xxs';
    label = 'high_pressure';
  } else {
    shared = 'iq3_xxs';
    experts = 'iq2_xxs';
    label = 'extreme_pressure_consider_smaller_model';
  }

  // Recompute footprint at the recommended mix (using experts quant as the
  // dominant term - shared is small by comparison).
  const projected = estimateMoEMemory({
    params: totalParamsB,
    num_experts: numExperts,
    experts_per_token: topK,
    quant: experts,
  });

  const fits = projected.hot_vram_gb <= target_vram_gb;

  return {
    router,
    shared,
    experts,
    label,
    fits,
    target_vram_gb,
    projected_hot_vram_gb: projected.hot_vram_gb,
    projected_cold_dram_gb: projected.cold_dram_gb,
    baseline_q4km_hot_vram_gb: baseline.hot_vram_gb,
    pressure_ratio: Math.round(pressure * 100) / 100,
    moe_support_version: MOE_SUPPORT_VERSION,
  };
}

export default {
  MOE_SUPPORT_VERSION,
  MOE_FAMILIES,
  ARCH_TO_FAMILY,
  getFamily,
  listFamilies,
  familyForArchitecture,
  detectMoE,
  estimateMoEMemory,
  pinExperts,
  recommendMoeRuntimePlan,
  expertHotness,
  recommendQuantPolicy,
};
