// Kolm-Q Oracle.
//
// Deterministic quantization strategy selection for compile/export/worker
// planning. This is not a benchmark claim. It is a constraint solver that
// converts user-visible requirements (device memory, runtime, quality floor,
// context length, calibration availability, privacy mode) into ranked methods
// the actual quantize/export surfaces can execute or honestly mark external.

import { buildFp4CalibPlan } from './fp4-calib-plan.js';
import { detectMoE, recommendQuantPolicy } from './moe-support.js';
import { getFamily } from './moe-registry.js';

// W964 - FP4 quality is model-size sensitive. These are conservative planning
// priors, not benchmark claims. The post-quant accuracy gate remains mandatory.
// They encode the June-2026 FP4 frontier finding captured in the backend spec:
// small models are materially more sensitive to FP4 than 30B/70B+ models.
const FP4_MODEL_SIZE_QUALITY_CURVES = Object.freeze({
  nvfp4: Object.freeze([
    Object.freeze({ max_params_b: 14, quality_loss: 0.04, recovery_hint: '95-98% BF16 recovery band' }),
    Object.freeze({ max_params_b: 34, quality_loss: 0.02, recovery_hint: '97-99% BF16 recovery band' }),
    Object.freeze({ max_params_b: null, quality_loss: 0.01, recovery_hint: '~99% BF16 recovery band' }),
  ]),
  mxfp4: Object.freeze([
    Object.freeze({ max_params_b: 14, quality_loss: 0.05, recovery_hint: 'small-model MXFP4 sensitivity band' }),
    Object.freeze({ max_params_b: 34, quality_loss: 0.03, recovery_hint: 'medium-model MXFP4 sensitivity band' }),
    Object.freeze({ max_params_b: null, quality_loss: 0.018, recovery_hint: 'large-model MXFP4 sensitivity band' }),
  ]),
});

const METHOD_CATALOG = Object.freeze({
  fp16: {
    label: 'FP16/BF16 baseline',
    worker_method: null,
    execution_status: 'baseline',
    bits: 16,
    compression: 1,
    quality_loss: 0,
    latency_gain: 1,
    calibration_required: false,
    runtimes: ['cuda', 'rocm', 'mlx', 'coreml', 'onnx', 'tensorrt', 'vllm', 'sglang', 'tgi'],
    sources: [],
  },
  int8: {
    label: 'bitsandbytes LLM.int8',
    worker_method: 'int8',
    execution_status: 'worker',
    bits: 8,
    compression: 0.52,
    quality_loss: 0.01,
    latency_gain: 1.35,
    calibration_required: false,
    runtimes: ['cuda', 'rocm', 'onnx', 'openvino', 'tensorrt'],
    sources: ['SmoothQuant'],
  },
  smoothquant: {
    label: 'SmoothQuant W8A8',
    worker_method: null,
    execution_status: 'external_toolchain',
    bits: 8,
    compression: 0.52,
    quality_loss: 0.012,
    latency_gain: 1.65,
    calibration_required: true,
    runtimes: ['tensorrt', 'onnx', 'openvino'],
    sources: ['SmoothQuant'],
  },
  int4: {
    label: 'bitsandbytes NF4 double quant',
    worker_method: 'int4',
    execution_status: 'worker',
    bits: 4,
    compression: 0.29,
    quality_loss: 0.05,
    latency_gain: 1.9,
    calibration_required: false,
    runtimes: ['cuda', 'rocm'],
    sources: ['QLoRA/NF4'],
  },
  gptq: {
    label: 'GPTQ 4-bit PTQ',
    worker_method: 'gptq',
    execution_status: 'worker',
    bits: 4,
    compression: 0.27,
    quality_loss: 0.035,
    latency_gain: 2.1,
    calibration_required: true,
    runtimes: ['cuda', 'tensorrt', 'exllama'],
    sources: ['GPTQ'],
  },
  awq: {
    label: 'AWQ 4-bit activation-aware',
    worker_method: 'awq',
    execution_status: 'worker',
    bits: 4,
    compression: 0.27,
    quality_loss: 0.025,
    latency_gain: 2.25,
    calibration_required: true,
    runtimes: ['cuda', 'tensorrt', 'onnx', 'mobile-gpu'],
    sources: ['AWQ'],
  },
  nvfp4: {
    label: 'NVIDIA NVFP4 Blackwell FP4 export',
    worker_method: null,
    execution_status: 'export_nvfp4',
    export_format: 'nvfp4',
    export_quant: 'w4a8',
    blackwell_required: true,
    bits: 4,
    compression: 0.30,
    quality_loss: 0.018,
    quality_loss_model_size_curve: FP4_MODEL_SIZE_QUALITY_CURVES.nvfp4,
    latency_gain: 2.85,
    calibration_required: true,
    runtimes: ['tensorrt', 'vllm'],
    sources: ['NVFP4', 'TensorRT-LLM FP4', 'NVIDIA Model Optimizer'],
  },
  mxfp4: {
    label: 'MXFP4 Blackwell FP4 export',
    worker_method: null,
    execution_status: 'export_nvfp4',
    export_format: 'nvfp4',
    export_quant: 'w4a4',
    blackwell_required: true,
    bits: 4,
    compression: 0.29,
    quality_loss: 0.026,
    quality_loss_model_size_curve: FP4_MODEL_SIZE_QUALITY_CURVES.mxfp4,
    latency_gain: 2.65,
    calibration_required: true,
    runtimes: ['tensorrt', 'vllm'],
    sources: ['MXFP4', 'TensorRT-LLM FP4', 'NVIDIA Model Optimizer'],
  },
  hqq: {
    label: 'HQQ calibration-free 4/3/2-bit',
    worker_method: 'hqq',
    execution_status: 'worker',
    experimental: true,
    bits: 4,
    compression: 0.25,
    quality_loss: 0.04,
    latency_gain: 1.85,
    calibration_required: false,
    runtimes: ['cuda', 'rocm'],
    sources: ['HQQ'],
  },
  exl2: {
    label: 'EXL2 variable-bit runtime quant',
    worker_method: 'exl2',
    execution_status: 'worker',
    experimental: true,
    bits: 4,
    compression: 0.25,
    quality_loss: 0.03,
    latency_gain: 2.45,
    calibration_required: true,
    runtimes: ['cuda', 'exllama'],
    sources: ['ExLlamaV2'],
  },
  exl3: {
    label: 'EXL3 next-gen variable-bit quant',
    worker_method: 'exl3',
    execution_status: 'worker',
    experimental: true,
    bits: 4,
    compression: 0.23,
    quality_loss: 0.028,
    latency_gain: 2.5,
    calibration_required: true,
    runtimes: ['cuda', 'exllama'],
    sources: ['ExLlamaV2'],
  },
  aqlm: {
    label: 'AQLM additive low-bit',
    worker_method: 'aqlm',
    execution_status: 'worker_external_repo',
    experimental: true,
    bits: 2,
    compression: 0.16,
    quality_loss: 0.055,
    latency_gain: 1.6,
    calibration_required: true,
    runtimes: ['cuda'],
    sources: ['AQLM'],
  },
  quip: {
    label: 'QuIP# sub-2-bit',
    worker_method: 'quip',
    execution_status: 'worker_external_repo',
    experimental: true,
    bits: 2,
    compression: 0.14,
    quality_loss: 0.06,
    latency_gain: 1.55,
    calibration_required: true,
    runtimes: ['cuda'],
    sources: ['QuIP#'],
  },
  qat: {
    label: 'EfficientQAT',
    worker_method: 'qat',
    execution_status: 'worker_external_repo',
    experimental: true,
    bits: 4,
    compression: 0.27,
    quality_loss: 0.018,
    latency_gain: 2.1,
    calibration_required: true,
    training_required: true,
    runtimes: ['cuda', 'tensorrt'],
    sources: ['EfficientQAT'],
  },
  spinquant: {
    label: 'SpinQuant learned rotations W4A4KV4',
    worker_method: null,
    execution_status: 'worker_external_repo',
    experimental: true,
    bits: 4,
    compression: 0.24,
    quality_loss: 0.029,
    latency_gain: 1.95,
    calibration_required: true,
    activation_quantization: true,
    kv_quantization: true,
    transform_family: 'learned_global_rotation',
    runtimes: ['cuda'],
    sources: ['SpinQuant', 'W4A4KV4 learned rotations'],
  },
  respinquant: {
    label: 'ReSpinQuant layer-wise fused rotations W4A4/W3A3',
    worker_method: null,
    execution_status: 'worker_external_repo',
    experimental: true,
    bits: 4,
    compression: 0.24,
    quality_loss: 0.024,
    latency_gain: 2.0,
    calibration_required: true,
    activation_quantization: true,
    kv_quantization: true,
    transform_family: 'layer_wise_offline_fused_rotation',
    runtimes: ['cuda'],
    sources: ['ReSpinQuant', 'W4A4/W3A3 residual subspace rotations'],
  },
  infoquant: {
    label: 'InfoQuant PSOT W4A4KV4 distribution shaping',
    worker_method: null,
    execution_status: 'worker_external_repo',
    experimental: true,
    bits: 4,
    compression: 0.24,
    quality_loss: 0.03,
    latency_gain: 1.95,
    calibration_required: true,
    activation_quantization: true,
    kv_quantization: true,
    transform_family: 'peak_suppression_orthogonal_transform',
    runtimes: ['cuda'],
    sources: ['InfoQuant', 'PSOT W4A4KV4'],
  },
  moe_mixed_policy: {
    label: 'MoE router-fp16 / expert-low-bit policy',
    worker_method: null,
    execution_status: 'advisory_policy',
    moe_only: true,
    bits: 2,
    compression: 0.20,
    quality_loss: 0.018,
    latency_gain: 2.05,
    calibration_required: false,
    runtimes: ['cuda', 'rocm', 'vllm', 'sglang', 'tensorrt', 'gguf', 'llama_cpp'],
    sources: ['MoE router-fp16 policy', 'Shard/Mixtral quant studies'],
  },
  mc_moe: {
    label: 'MC-MoE 1.5-2.5-bit expert quant',
    worker_method: null,
    execution_status: 'worker_external_repo',
    experimental: true,
    moe_only: true,
    bits: 2,
    compression: 0.13,
    quality_loss: 0.045,
    latency_gain: 1.75,
    calibration_required: true,
    runtimes: ['cuda', 'vllm', 'sglang'],
    sources: ['MC-MoE'],
  },
  gemq: {
    label: 'GEMQ expert-aware MoE quant',
    worker_method: null,
    execution_status: 'worker_external_repo',
    experimental: true,
    moe_only: true,
    bits: 2,
    compression: 0.12,
    quality_loss: 0.04,
    latency_gain: 1.8,
    calibration_required: true,
    runtimes: ['cuda', 'vllm', 'sglang'],
    sources: ['GEMQ'],
  },
  kivi_kv: {
    label: 'KIVI 2-bit KV cache',
    worker_method: null,
    execution_status: 'runtime_policy',
    bits: 2,
    compression: 0.35,
    quality_loss: 0.018,
    latency_gain: 1.18,
    calibration_required: false,
    kv_cache_only: true,
    runtimes: ['vllm', 'sglang', 'tensorrt'],
    sources: ['KIVI'],
  },
});

const DEVICE_PRESETS = Object.freeze({
  'cpu-16gb': { memory_gb: 16, runtime: 'gguf', target_latency_ms: 900, local: true },
  'm3-pro-18gb': { memory_gb: 18, runtime: 'mlx', target_latency_ms: 120, local: true },
  'rtx-4090-24gb': { memory_gb: 24, runtime: 'cuda', target_latency_ms: 80, local: true },
  'h100-80gb': { memory_gb: 80, runtime: 'tensorrt', target_latency_ms: 35, local: false },
  'b200-180gb': { memory_gb: 180, runtime: 'tensorrt', target_latency_ms: 20, local: false, blackwell: true },
  'gb200-180gb': { memory_gb: 180, runtime: 'tensorrt', target_latency_ms: 18, local: false, blackwell: true },
  'rtx-5090-32gb': { memory_gb: 32, runtime: 'tensorrt', target_latency_ms: 45, local: true, blackwell: true },
  'iphone-8gb': { memory_gb: 8, runtime: 'coreml', target_latency_ms: 140, local: true },
  'android-8gb': { memory_gb: 8, runtime: 'onnx', target_latency_ms: 160, local: true },
  'browser-4gb': { memory_gb: 4, runtime: 'wasm', target_latency_ms: 250, local: true },
  'intel-npu-16gb': { memory_gb: 16, runtime: 'openvino', target_latency_ms: 120, local: true },
});

const TASK_SENSITIVITY = Object.freeze({
  classification: 0.7,
  extraction: 0.8,
  redaction: 0.92,
  summarization: 0.84,
  chat: 0.86,
  code: 0.95,
  legal: 0.96,
  medical: 0.97,
  vision: 0.9,
});

const RUNTIME_ALIASES = Object.freeze({
  gguf: ['cuda', 'rocm', 'cpu', 'mobile-gpu'],
  llama_cpp: ['cuda', 'rocm', 'cpu', 'mobile-gpu'],
  mlx: ['mlx'],
  coreml: ['coreml', 'mobile-gpu'],
  onnx: ['onnx', 'openvino', 'mobile-gpu'],
  openvino: ['openvino', 'onnx'],
  qnn: ['onnx', 'mobile-gpu'],
  tensorrt: ['tensorrt', 'cuda'],
  vllm: ['vllm', 'cuda'],
  sglang: ['sglang', 'cuda'],
  tgi: ['tgi', 'cuda'],
  wasm: ['wasm', 'onnx'],
  cuda: ['cuda'],
  rocm: ['rocm'],
});

// Experimental quantization gate. Methods flagged experimental in the catalog
// (hqq, exl2, exl3, aqlm, quip, qat, spinquant, respinquant, infoquant)
// drive external toolchains/research repos that the customer must install
// themselves, so advertising them as run-now
// creates an expectation mismatch (the catalog lists them, but a plain
// `--quantize aqlm` cannot ship without the upstream optimizer). They stay in
// the catalog for planning + documentation, but the planner only recommends an
// EXECUTABLE command for them when the operator has explicitly opted in via
// KOLM_ENABLE_EXPERIMENTAL_QUANTS=1. Default-off keeps the always-on set to the
// four pip-only worker methods (int4, int8, gptq, awq) plus the baselines.
const EXPERIMENTAL_ENV = 'KOLM_ENABLE_EXPERIMENTAL_QUANTS';

export function experimentalQuantsEnabled(env = process.env) {
  const v = String((env && env[EXPERIMENTAL_ENV]) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isExperimental(method) {
  return method.experimental === true;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n)));
}

function round(n, digits = 4) {
  return Number(Number(n).toFixed(digits));
}

function buildFp4CalibrationPlan(candidate) {
  if (!candidate?.feasible || candidate.execution_status !== 'export_nvfp4') return null;
  const plan = buildFp4CalibPlan({
    target: {
      dtype: candidate.method === 'mxfp4' ? 'mxfp4' : 'nvfp4',
      quant_level: candidate.export_quant,
      weight_dtype: candidate.export_quant === 'w8a8' ? 'fp8_e4m3' : 'nvfp4',
    },
  });
  return plan.enabled ? plan : null;
}

function commandForPrimary(primary, fp4CalibrationPlan) {
  if (!primary?.feasible) return null;
  if (primary.worker_method) {
    return `kolm quantize --local-worker --method=${primary.worker_method} --in <model-dir> --out <out-dir>`;
  }
  if (!primary.export_format) return null;
  const fp4Flags = fp4CalibrationPlan?.enabled
    ? ` ${fp4CalibrationPlan.python_flags.join(' ')}`
    : '';
  return `kolm export <artifact.kolm> --format ${primary.export_format} --quant ${primary.export_quant}${fp4Flags} --out <out-dir>`;
}

function proofForRecommendation(primary, fp4CalibrationPlan) {
  const proof = [
    'run method-specific doctor before execution',
    'record source model hash, calibration hash, method, bits, runtime, and output shard hashes',
    'enforce post-quant accuracy_gate before promoting quantized artifact',
  ];
  if (primary?.moe_policy) {
    proof.unshift('for MoE checkpoints, keep router fp16 and record shared/expert precision policy before quantization');
  }
  if (fp4CalibrationPlan?.enabled) {
    proof.splice(
      2,
      0,
      `run FP4-aware calibration (${fp4CalibrationPlan.python_flags.join(' ')}) before FP4 export`,
    );
  }
  return proof;
}

function normalizeTask(task) {
  const key = String(task || 'chat').toLowerCase();
  return TASK_SENSITIVITY[key] ? key : 'chat';
}

function resolveDevice(input = {}) {
  const preset = DEVICE_PRESETS[input.device || input.device_id] || {};
  return {
    id: input.device || input.device_id || null,
    memory_gb: Number(input.memory_gb ?? input.memoryGb ?? preset.memory_gb ?? 16),
    runtime: String(input.runtime || preset.runtime || 'cuda').toLowerCase(),
    target_latency_ms: Number(input.target_latency_ms ?? input.targetLatencyMs ?? preset.target_latency_ms ?? 150),
    local: input.local ?? preset.local ?? true,
    blackwell: Boolean(input.blackwell ?? input.blackwell_native ?? preset.blackwell ?? false),
  };
}

function runtimeCompatible(method, runtime) {
  const aliases = RUNTIME_ALIASES[runtime] || [runtime];
  return method.runtimes.some((r) => aliases.includes(r));
}

function estimateFp16MemoryGb(paramsB, contextTokens) {
  const weightsGb = paramsB * 2.05;
  const kvGb = Math.max(0, contextTokens / 8192) * paramsB * 0.16;
  return weightsGb + kvGb + 1.2;
}

function estimateMemoryGb(method, paramsB, contextTokens) {
  const base = estimateFp16MemoryGb(paramsB, contextTokens);
  const weight = paramsB * 2.05 * method.compression;
  const kv = Math.max(0, contextTokens / 8192) * paramsB * 0.16 * (method.kv_cache_only ? method.compression : 1);
  return Math.max(0.8, weight + kv + 1.2);
}

function qualityFloorFor(task, floor) {
  const sens = TASK_SENSITIVITY[normalizeTask(task)] || TASK_SENSITIVITY.chat;
  const defaultFloor = 1 - (1 - sens) * 0.5;
  return clamp(floor ?? defaultFloor, 0.7, 0.999);
}

function qualityLossForMethod(method, paramsB) {
  const curve = method?.quality_loss_model_size_curve;
  if (!Array.isArray(curve) || curve.length === 0) {
    return {
      quality_loss: method.quality_loss,
      source: 'catalog_flat_quality_loss',
      band: null,
    };
  }
  const size = Number.isFinite(Number(paramsB)) && Number(paramsB) > 0 ? Number(paramsB) : Infinity;
  const band = curve.find((row) => row.max_params_b == null || size <= Number(row.max_params_b)) || curve[curve.length - 1];
  return {
    quality_loss: Number.isFinite(Number(band.quality_loss)) ? Number(band.quality_loss) : method.quality_loss,
    source: 'model_size_quality_curve',
    band: {
      max_params_b: band.max_params_b == null ? null : Number(band.max_params_b),
      recovery_hint: band.recovery_hint || null,
    },
  };
}

function estimateQuality(method, task, calibrationRows, preferenceTuned, paramsB) {
  const sens = TASK_SENSITIVITY[normalizeTask(task)] || TASK_SENSITIVITY.chat;
  const lossPrior = qualityLossForMethod(method, paramsB);
  let loss = lossPrior.quality_loss * sens;
  if (method.calibration_required && calibrationRows < 64) loss += 0.035;
  if (method.training_required && !preferenceTuned) loss += 0.02;
  return {
    quality: round(clamp(1 - loss, 0, 1), 4),
    loss: round(loss, 4),
    prior_loss: round(lossPrior.quality_loss, 4),
    source: lossPrior.source,
    band: lossPrior.band,
  };
}

function estimateLatencyMs(method, device, paramsB) {
  const paramScale = Math.max(0.35, paramsB / 7);
  const base = device.target_latency_ms * paramScale;
  return round(base / method.latency_gain, 2);
}

function _finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveMoeInfo(input = {}, paramsB = 7) {
  let raw = input.moe_info || input.moeInfo || null;
  let source = raw ? 'input.moe_info' : null;

  const modelPath = input.model_dir || input.modelDir || input.model_path || input.modelPath;
  if (!raw && typeof modelPath === 'string' && modelPath.length > 0) {
    raw = detectMoE(modelPath);
    source = `detectMoE:${raw.reason || raw.source || 'model_path'}`;
  }

  const familyId = input.moe_family || input.moeFamily || (raw && raw.family) || null;
  const family = getFamily(familyId);
  const forced = Boolean(input.moe || input.is_moe || input.isMoe || family);
  const detected = Boolean(raw && (raw.is_moe || raw.num_experts > 1 || raw.experts > 1));
  if (!forced && !detected) return null;

  const numExperts = _finitePositive(raw?.num_experts ?? raw?.experts ?? input.num_experts ?? input.numExperts ?? family?.experts);
  const topK = _finitePositive(raw?.experts_per_token ?? raw?.top_k ?? input.experts_per_token ?? input.expertsPerToken ?? family?.top_k);
  let totalParamsB = _finitePositive(raw?.params ?? raw?.total_params_b ?? input.moe_params_b ?? input.moeParamsB ?? paramsB);
  if (!totalParamsB && family) {
    totalParamsB = family.shared_size_b + family.expert_size_b * family.experts;
  }

  return Object.freeze({
    is_moe: true,
    num_experts: numExperts || 0,
    experts_per_token: topK || 0,
    params: totalParamsB || paramsB,
    family: family ? family.id : (familyId || raw?.family || null),
    source: source || (family ? 'moe_family' : 'input_flag'),
  });
}

function buildMoeQuantPolicy(moeInfo, device) {
  if (!moeInfo) return null;
  try {
    return recommendQuantPolicy({
      moe_info: moeInfo,
      target_vram_gb: device.memory_gb,
    });
  } catch (e) {
    return Object.freeze({
      ok: false,
      error: e.message,
      moe_support_version: 'moe-support-v1',
    });
  }
}

function scoreCandidate({ method, methodId, task, device, paramsB, contextTokens, calibrationRows, qualityFloor, privacyMode, preferenceTuned, experimentalEnabled, moeInfo, moePolicy }) {
  const qualityEstimate = estimateQuality(method, task, calibrationRows, preferenceTuned, paramsB);
  let quality = qualityEstimate.quality;
  let memory = estimateMemoryGb(method, paramsB, contextTokens);
  let latency = estimateLatencyMs(method, device, paramsB);
  const warnings = [];
  let hardFail = false;
  const moeOnly = method.moe_only === true;

  const experimental = isExperimental(method);
  // Experimental methods stay listed for planning, but unless the operator has
  // opted in they are NOT recommendable as an executable command. We mark them
  // gated and (when gated off) hard-fail so feasibility never picks one as the
  // primary worker command. This is the catalog-vs-shippable reconciliation.
  const experimentalGatedOff = experimental && !experimentalEnabled;
  if (experimentalGatedOff) {
    warnings.push(`experimental_requires_${EXPERIMENTAL_ENV}=1`);
    hardFail = true;
  }
  if (moeOnly && !moeInfo) {
    warnings.push('moe_required');
    hardFail = true;
  }
  if (moeOnly && moeInfo && (!moePolicy || moePolicy.ok === false)) {
    warnings.push(`moe_policy_unavailable:${moePolicy?.error || 'missing_topology'}`);
    hardFail = true;
  }
  if (methodId === 'moe_mixed_policy' && moePolicy && moePolicy.ok !== false) {
    memory = Number.isFinite(moePolicy.projected_hot_vram_gb)
      ? moePolicy.projected_hot_vram_gb
      : memory;
    latency = round(latency * 0.92, 2);
    warnings.push('advisory_policy_no_direct_worker_execution');
  }

  if (!runtimeCompatible(method, device.runtime)) {
    warnings.push(`runtime_mismatch:${device.runtime}`);
    hardFail = true;
  }
  if (method.blackwell_required && !device.blackwell) {
    warnings.push('blackwell_required');
    hardFail = true;
  }
  if (memory > device.memory_gb) {
    warnings.push(`memory_exceeds_device:${round(memory, 2)}>${device.memory_gb}`);
    hardFail = true;
  }
  if (quality < qualityFloor) warnings.push(`quality_below_floor:${quality}<${qualityFloor}`);
  if (method.calibration_required && calibrationRows < 64) warnings.push('calibration_set_too_small');
  if (method.execution_status.includes('external_repo')) {
    warnings.push('requires_external_research_repo');
    if (!method.worker_method) {
      warnings.push('external_runner_not_wired');
      hardFail = true;
    }
  }
  if (method.execution_status === 'external_toolchain') warnings.push('not_in_quantize_worker');
  if (privacyMode === 'airgap' && method.execution_status === 'external_toolchain') warnings.push('airgap_needs_preinstalled_toolchain');

  const fit = memory <= device.memory_gb ? 1 : Math.max(0, device.memory_gb / memory);
  const qualityScore = Math.max(0, (quality - 0.7) / 0.3);
  const latencyScore = Math.max(0, Math.min(1.5, device.target_latency_ms / Math.max(1, latency))) / 1.5;
  const compressionScore = Math.max(0, 1 - method.compression);
  const workerScore = method.execution_status === 'worker'
    ? 1
    : method.execution_status === 'export_nvfp4'
      ? 0.9
      : method.execution_status === 'baseline'
        ? 0.55
        : 0.35;
  const nativeHardwareScore = method.blackwell_required && device.blackwell && runtimeCompatible(method, device.runtime)
    ? 0.06
    : 0;
  const warningPenalty = warnings.length * 0.045 + (hardFail ? 0.55 : 0);
  const score = round(clamp(
    fit * 0.28
      + qualityScore * 0.3
      + latencyScore * 0.17
      + compressionScore * 0.15
      + workerScore * 0.1
      + nativeHardwareScore
      - warningPenalty,
    0,
    1,
  ), 4);

  return {
    method: methodId,
    label: method.label,
    worker_method: method.worker_method,
    execution_status: method.execution_status,
    moe_only: Boolean(method.moe_only),
    export_format: method.export_format || null,
    export_quant: method.export_quant || null,
    hardware_native: nativeHardwareScore > 0,
    experimental,
    experimental_gated: experimentalGatedOff,
    score,
    feasible: !hardFail && quality >= qualityFloor,
    estimates: {
      memory_gb: round(memory, 2),
      quality,
      quality_loss: qualityEstimate.loss,
      quality_loss_prior: qualityEstimate.prior_loss,
      quality_loss_source: qualityEstimate.source,
      quality_loss_band: qualityEstimate.band,
      latency_ms: latency,
      compression_ratio: method.compression,
      bits: method.bits,
    },
    moe_policy: methodId === 'moe_mixed_policy' && moePolicy && moePolicy.ok !== false
      ? moePolicy
      : null,
    warnings,
    sources: method.sources,
  };
}

export function rankQuantizationStrategies(input = {}) {
  const device = resolveDevice(input);
  const paramsB = Number(input.params_b ?? input.paramsB ?? input.model_params_b ?? 7);
  const contextTokens = Number(input.context_tokens ?? input.contextTokens ?? 4096);
  const task = normalizeTask(input.task);
  const calibrationRows = Number(input.calibration_rows ?? input.calibrationRows ?? 0);
  const qualityFloor = qualityFloorFor(task, input.quality_floor ?? input.qualityFloor);
  const privacyMode = String(input.privacy_mode || input.privacyMode || 'standard').toLowerCase();
  const preferenceTuned = !!(input.preference_tuned ?? input.preferenceTuned);
  const moeInfo = resolveMoeInfo(input, paramsB);
  const moePolicy = buildMoeQuantPolicy(moeInfo, device);
  // Explicit boolean override wins (used by callers/tests); otherwise read env.
  const experimentalEnabled = (input.experimental_enabled ?? input.experimentalEnabled) != null
    ? Boolean(input.experimental_enabled ?? input.experimentalEnabled)
    : experimentalQuantsEnabled();

  const candidates = Object.entries(METHOD_CATALOG)
    .map(([methodId, method]) => scoreCandidate({
      method,
      methodId,
      task,
      device,
      paramsB,
      contextTokens,
      calibrationRows,
      qualityFloor,
      privacyMode,
      preferenceTuned,
      experimentalEnabled,
      moeInfo,
      moePolicy,
    }))
    .sort((a, b) => b.score - a.score || Number(b.feasible) - Number(a.feasible) || a.method.localeCompare(b.method));

  const feasible = candidates.filter((c) => c.feasible);
  const primary = feasible[0] || candidates[0] || null;
  const fallback = feasible.find((c) => c.method !== primary?.method && c.execution_status === 'worker')
    || feasible.find((c) => c.method !== primary?.method)
    || candidates.find((c) => c.method !== primary?.method)
    || null;
  const kvCache = contextTokens >= 8192 && runtimeCompatible(METHOD_CATALOG.kivi_kv, device.runtime)
    ? candidates.find((c) => c.method === 'kivi_kv')
    : null;
  const fp4CalibrationPlan = buildFp4CalibrationPlan(primary);

  return {
    spec: 'kolm-quantization-oracle-1',
    ok: Boolean(primary),
    input: {
      task,
      params_b: paramsB,
      context_tokens: contextTokens,
      calibration_rows: calibrationRows,
      quality_floor: qualityFloor,
      privacy_mode: privacyMode,
      experimental_enabled: experimentalEnabled,
      moe: moeInfo,
      device,
    },
    experimental_gate: {
      enabled: experimentalEnabled,
      env: EXPERIMENTAL_ENV,
      gated_methods: Object.entries(METHOD_CATALOG)
        .filter(([, m]) => isExperimental(m))
        .map(([id]) => id),
      hint: experimentalEnabled
        ? null
        : `experimental methods (${Object.entries(METHOD_CATALOG).filter(([, m]) => isExperimental(m)).map(([id]) => id).join('/')}) need ${EXPERIMENTAL_ENV}=1 and their external toolchains; default recommendation stays within stable worker/export/advisory methods`,
    },
    recommendation: primary ? {
      primary,
      fallback,
      kv_cache: kvCache && kvCache.feasible ? kvCache : null,
      command: commandForPrimary(primary, fp4CalibrationPlan),
      fp4_calibration_plan: fp4CalibrationPlan,
      moe_quantization: moeInfo ? {
        detected: true,
        info: moeInfo,
        policy: moePolicy && moePolicy.ok !== false ? moePolicy : null,
        external_candidates: candidates
          .filter((c) => c.moe_only && c.method !== 'moe_mixed_policy')
          .map((c) => ({
            method: c.method,
            label: c.label,
            execution_status: c.execution_status,
            feasible: c.feasible,
            warnings: c.warnings,
            sources: c.sources,
          })),
      } : null,
      accuracy_gate: {
        required: true,
        metric: 'kscore',
        max_rel_drop: 0.03,
        baseline: 'fp16_or_highest_bit_profile',
        enforcement: 'quantize-bakeoff.enforceAccuracyFloor',
        fail_closed_without_measured_holdout: true,
      },
      proof: proofForRecommendation(primary, fp4CalibrationPlan),
    } : null,
    candidates,
  };
}

export function quantizationOracleCatalog(env = process.env) {
  const experimentalEnabled = experimentalQuantsEnabled(env);
  return {
    spec: 'kolm-quantization-oracle-catalog-1',
    methods: METHOD_CATALOG,
    devices: DEVICE_PRESETS,
    task_sensitivity: TASK_SENSITIVITY,
    experimental_gate: {
      enabled: experimentalEnabled,
      env: EXPERIMENTAL_ENV,
      gated_methods: Object.entries(METHOD_CATALOG)
        .filter(([, m]) => isExperimental(m))
        .map(([id]) => id),
      always_on_worker_methods: Object.entries(METHOD_CATALOG)
        .filter(([, m]) => m.execution_status === 'worker' && !isExperimental(m))
        .map(([id]) => id),
    },
    // finalized-c5 (turnkey-runners atom) - FLAGGED / DEFAULT-OFF. The turnkey
    // experimental-quant runner surface (src/quant-turnkey-runners.js, AQLM /
    // QuIP# / EXL2 / EXL3 / EfficientQAT) did NOT pass independent verify: its
    // buildTurnkeyCommand() argv is not yet the surface the heavy-dep smoke
    // (quant_turnkey_smoke.py -> quantize.py) actually drives, and the pinned
    // commits are not validated against the checkout. It is therefore exposed
    // ONLY as advisory status, ONLY when BOTH the experimental gate AND the
    // heavy-dep smoke marker are armed, and it NEVER flips a catalog default,
    // never changes a recommendation, and never auto-promotes a method to
    // worker. Operators arming KOLM_QUANT_TURNKEY_SMOKE=1 must reconcile
    // quantize.py's argv with buildTurnkeyCommand() before trusting promotion.
    turnkey_status_advisory: turnkeyAdvisory(env),
  };
}

// FLAGGED helper. Returns a null-ish advisory unless the operator has explicitly
// armed both the experimental gate and the turnkey smoke marker. Dynamically
// imported so the FAILED-verify turnkey module never loads on the green path.
function turnkeyAdvisory(env = process.env) {
  const smokeArmed = String((env && env.KOLM_QUANT_TURNKEY_SMOKE) || '').trim() === '1';
  if (!experimentalQuantsEnabled(env) || !smokeArmed) {
    return {
      enabled: false,
      verified: false,
      env: ['KOLM_ENABLE_EXPERIMENTAL_QUANTS=1', 'KOLM_QUANT_TURNKEY_SMOKE=1'],
      note: 'turnkey runner surface is experimental + UNVERIFIED (independent verify failed: '
        + 'buildTurnkeyCommand argv not yet driven by the heavy-dep smoke; pinned commits '
        + 'unvalidated). Advisory disabled by default; arm both env vars to inspect.',
    };
  }
  return {
    enabled: true,
    verified: false,
    warning: 'EXPERIMENTAL + UNVERIFIED: do not auto-promote based on this advisory; '
      + 'reconcile quantize.py argv with src/quant-turnkey-runners.js buildTurnkeyCommand first.',
    hint: 'import promotionStatus / doctorTurnkey from src/quant-turnkey-runners.js to inspect '
      + 'per-method doctor status under your pinned repo checkouts.',
  };
}

// methodAvailability(methodId) — single-method gate verdict for CLI/router so
// `kolm quantize --method <m>` can fail loud BEFORE spawning the worker when an
// experimental method is requested without the opt-in env. Returns:
//   { method, known, experimental, available, reason, hint }
// available=false with reason='experimental_gated' is the actionable refusal.
export function methodAvailability(methodId, env = process.env) {
  const id = String(methodId || '').toLowerCase();
  const method = METHOD_CATALOG[id];
  if (!method) {
    return {
      method: id,
      known: false,
      experimental: false,
      available: false,
      reason: 'unknown_method',
      hint: `unknown quantization method ${JSON.stringify(id)}; see quantizationOracleCatalog()`,
    };
  }
  const experimental = isExperimental(method);
  const enabled = experimentalQuantsEnabled(env);
  if (experimental && !enabled) {
    return {
      method: id,
      known: true,
      experimental: true,
      available: false,
      reason: 'experimental_gated',
      hint: `${id} is an experimental quantization method requiring external toolchains; set ${EXPERIMENTAL_ENV}=1 to enable it, or use one of int4/int8/gptq/awq`,
    };
  }
  if (method.execution_status === 'worker_external_repo' && !method.worker_method) {
    return {
      method: id,
      known: true,
      experimental,
      available: false,
      reason: 'external_repo_only',
      hint: `${id} is cataloged as an external research plan but has no in-repo worker method yet; use the oracle policy as an external execution plan`,
    };
  }
  return {
    method: id,
    known: true,
    experimental,
    available: true,
    reason: experimental ? 'experimental_enabled' : 'stable',
    hint: null,
  };
}

export default {
  rankQuantizationStrategies,
  quantizationOracleCatalog,
  methodAvailability,
  experimentalQuantsEnabled,
};
