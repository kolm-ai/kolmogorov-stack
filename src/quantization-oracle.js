// Kolm-Q Oracle.
//
// Deterministic quantization strategy selection for compile/export/worker
// planning. This is not a benchmark claim. It is a constraint solver that
// converts user-visible requirements (device memory, runtime, quality floor,
// context length, calibration availability, privacy mode) into ranked methods
// the actual quantize/export surfaces can execute or honestly mark external.

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
// (hqq, exl2, exl3, aqlm, quip, qat) drive external toolchains/research repos
// that the customer must install themselves, so advertising them as run-now
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

function estimateQuality(method, task, calibrationRows, preferenceTuned) {
  const sens = TASK_SENSITIVITY[normalizeTask(task)] || TASK_SENSITIVITY.chat;
  let loss = method.quality_loss * sens;
  if (method.calibration_required && calibrationRows < 64) loss += 0.035;
  if (method.training_required && !preferenceTuned) loss += 0.02;
  return round(clamp(1 - loss, 0, 1), 4);
}

function estimateLatencyMs(method, device, paramsB) {
  const paramScale = Math.max(0.35, paramsB / 7);
  const base = device.target_latency_ms * paramScale;
  return round(base / method.latency_gain, 2);
}

function scoreCandidate({ method, methodId, task, device, paramsB, contextTokens, calibrationRows, qualityFloor, privacyMode, preferenceTuned, experimentalEnabled }) {
  const quality = estimateQuality(method, task, calibrationRows, preferenceTuned);
  const memory = estimateMemoryGb(method, paramsB, contextTokens);
  const latency = estimateLatencyMs(method, device, paramsB);
  const warnings = [];
  let hardFail = false;

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

  if (!runtimeCompatible(method, device.runtime)) {
    warnings.push(`runtime_mismatch:${device.runtime}`);
    hardFail = true;
  }
  if (memory > device.memory_gb) {
    warnings.push(`memory_exceeds_device:${round(memory, 2)}>${device.memory_gb}`);
    hardFail = true;
  }
  if (quality < qualityFloor) warnings.push(`quality_below_floor:${quality}<${qualityFloor}`);
  if (method.calibration_required && calibrationRows < 64) warnings.push('calibration_set_too_small');
  if (method.execution_status.includes('external_repo')) warnings.push('requires_external_research_repo');
  if (method.execution_status === 'external_toolchain') warnings.push('not_in_quantize_worker');
  if (privacyMode === 'airgap' && method.execution_status === 'external_toolchain') warnings.push('airgap_needs_preinstalled_toolchain');

  const fit = memory <= device.memory_gb ? 1 : Math.max(0, device.memory_gb / memory);
  const qualityScore = Math.max(0, (quality - 0.7) / 0.3);
  const latencyScore = Math.max(0, Math.min(1.5, device.target_latency_ms / Math.max(1, latency))) / 1.5;
  const compressionScore = Math.max(0, 1 - method.compression);
  const workerScore = method.execution_status === 'worker' ? 1 : method.execution_status === 'baseline' ? 0.55 : 0.35;
  const warningPenalty = warnings.length * 0.045 + (hardFail ? 0.55 : 0);
  const score = round(clamp(
    fit * 0.28 + qualityScore * 0.3 + latencyScore * 0.17 + compressionScore * 0.15 + workerScore * 0.1 - warningPenalty,
    0,
    1,
  ), 4);

  return {
    method: methodId,
    label: method.label,
    worker_method: method.worker_method,
    execution_status: method.execution_status,
    experimental,
    experimental_gated: experimentalGatedOff,
    score,
    feasible: !hardFail && quality >= qualityFloor,
    estimates: {
      memory_gb: round(memory, 2),
      quality,
      latency_ms: latency,
      compression_ratio: method.compression,
      bits: method.bits,
    },
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
        : `experimental methods (hqq/exl2/exl3/aqlm/quip/qat) need ${EXPERIMENTAL_ENV}=1 and their external toolchains; default recommendation stays within int4/int8/gptq/awq`,
    },
    recommendation: primary ? {
      primary,
      fallback,
      kv_cache: kvCache && kvCache.feasible ? kvCache : null,
      command: primary.feasible && primary.worker_method
        ? `kolm quantize --local-worker --method=${primary.worker_method} --in <model-dir> --out <out-dir>`
        : null,
      proof: [
        'run method-specific doctor before execution',
        'record source model hash, calibration hash, method, bits, runtime, and output shard hashes',
        'run holdout eval before promoting quantized artifact',
      ],
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
