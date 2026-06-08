// src/export-format-registry.js
//
// S-6 - Central registry of every export format the SOTA quantization ladder
// supports. The registry exists so callers (CLI, account UI, runtime passport
// builder, /docs/compile/formats) all agree on:
//   * which quant levels each format accepts
//   * which runtimes consume each format
//   * which toolchain/vendor publishes each format
//   * a one-line install hint when the tool is missing
//
// This module deliberately holds NO conversion logic. It is metadata only.
// Per-format export logic lives in src/export-<format>.js. GGUF is registered
// here too so the registry is the single source of truth (the GGUF chain
// itself lives in src/export-gguf.js and is NOT re-implemented).
//
// Constraint envelope: every entry carries `requires_gpu` and `runtimes` so
// the caller can match the format against the user's available hardware
// before kicking off a multi-minute quantize run.

import {
  QUANT_LEVELS as GGUF_QUANT_LEVELS,
  GGUF_EXPORT_VERSION,
} from './export-gguf.js';
import {
  QUANT_LEVELS as EXL2_QUANT_LEVELS,
  RUNTIME_HINT as EXL2_RUNTIME_HINT,
} from './export-exl2.js';
import {
  QUANT_LEVELS as GPTQ_QUANT_LEVELS,
  RUNTIME_HINT as GPTQ_RUNTIME_HINT,
} from './export-gptq.js';
import {
  QUANT_LEVELS as AWQ_QUANT_LEVELS,
  RUNTIME_HINT as AWQ_RUNTIME_HINT,
} from './export-awq.js';
import {
  QUANT_LEVELS as FP8_QUANT_LEVELS,
  RUNTIME_HINT as FP8_RUNTIME_HINT,
} from './export-fp8.js';
import {
  QUANT_LEVELS as NVFP4_QUANT_LEVELS,
  RUNTIME_HINT as NVFP4_RUNTIME_HINT,
} from './export-nvfp4.js';
import {
  QUANT_LEVELS as HQQ_QUANT_LEVELS,
  RUNTIME_HINT as HQQ_RUNTIME_HINT,
} from './export-hqq.js';
import {
  QUANT_LEVELS as MLX_QUANT_LEVELS,
  RUNTIME_HINT as MLX_RUNTIME_HINT,
} from './export-mlx.js';

export const FORMAT_REGISTRY_VERSION = 'format-registry-v1';

// Each entry shape:
//   id            : canonical lowercase format key (matches --format flag)
//   name          : human-friendly display name
//   quant_levels  : array of acceptable --quant strings
//   runtimes      : array of runtime/server names that consume this format
//   requires_gpu  : true if the toolchain (calibration/quantize) requires CUDA
//   vendor        : upstream project / company that publishes the tool
//   install_hint  : single-line install instruction for missing toolchain
//   notes         : optional caveats string
export const FORMAT_REGISTRY = Object.freeze({
  gguf: Object.freeze({
    id: 'gguf',
    name: 'GGUF (llama.cpp)',
    quant_levels: GGUF_QUANT_LEVELS,
    runtimes: ['llama.cpp', 'llama-cpp-python', 'ollama', 'lm-studio', 'koboldcpp'],
    requires_gpu: false,
    vendor: 'ggerganov/llama.cpp',
    install_hint: 'git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && cmake -B build && cmake --build build --config Release -j',
    notes: 'Universal CPU-friendly format. K-quants run anywhere; IQ quants need an imatrix corpus.',
    version: GGUF_EXPORT_VERSION,
  }),
  exl2: Object.freeze({
    id: 'exl2',
    name: 'EXL2 (exllamav2)',
    quant_levels: EXL2_QUANT_LEVELS,
    runtimes: [EXL2_RUNTIME_HINT, 'tabbyAPI', 'text-generation-webui'],
    requires_gpu: true,
    vendor: 'turboderp/exllamav2',
    install_hint: 'pip install exllamav2',
    notes: 'Variable-bitrate per-layer quant (DAQ). Fractional bpw targets allowed.',
  }),
  gptq: Object.freeze({
    id: 'gptq',
    name: 'GPTQ (auto-gptq)',
    quant_levels: GPTQ_QUANT_LEVELS,
    runtimes: [GPTQ_RUNTIME_HINT, 'transformers', 'text-generation-inference'],
    requires_gpu: true,
    vendor: 'AutoGPTQ/AutoGPTQ',
    install_hint: 'pip install auto-gptq optimum',
    notes: 'Hessian-calibrated weight-only quant. wXgY format = X bits, group size Y.',
  }),
  awq: Object.freeze({
    id: 'awq',
    name: 'AWQ (autoawq)',
    quant_levels: AWQ_QUANT_LEVELS,
    runtimes: [AWQ_RUNTIME_HINT, 'transformers', 'text-generation-inference'],
    requires_gpu: true,
    vendor: 'casper-hansen/AutoAWQ',
    install_hint: 'pip install autoawq',
    notes: 'Activation-aware quant; preserves salient channels at higher precision.',
  }),
  fp8: Object.freeze({
    id: 'fp8',
    name: 'FP8 (Hopper / Ada)',
    quant_levels: FP8_QUANT_LEVELS,
    runtimes: [FP8_RUNTIME_HINT, 'tensorrt-llm', 'transformer-engine'],
    requires_gpu: true,
    vendor: 'vllm-project/llm-compressor',
    install_hint: 'pip install llmcompressor',
    notes: 'Native 8-bit float. e4m3 for weights+activations, e5m2 wider dynamic range. Needs Hopper or newer.',
  }),
  nvfp4: Object.freeze({
    id: 'nvfp4',
    name: 'NVFP4 (Blackwell)',
    quant_levels: NVFP4_QUANT_LEVELS,
    runtimes: [NVFP4_RUNTIME_HINT, 'tensorrt-llm', 'vllm'],
    requires_gpu: true,
    vendor: 'NVIDIA/TensorRT-Model-Optimizer',
    install_hint: 'pip install nvidia-modelopt[torch]',
    notes: 'NVIDIA Blackwell 4-bit float micro-scaled format. Requires sm_100 (B100/B200) for full perf.',
  }),
  hqq: Object.freeze({
    id: 'hqq',
    name: 'HQQ (mobiusml)',
    quant_levels: HQQ_QUANT_LEVELS,
    runtimes: [HQQ_RUNTIME_HINT, 'transformers'],
    requires_gpu: false,
    vendor: 'mobiusml/hqq',
    install_hint: 'pip install hqq',
    notes: 'Calibration-free; per-tensor 1-step quant. Runs on CPU (slow) or GPU (fast).',
  }),
  mlx: Object.freeze({
    id: 'mlx',
    name: 'MLX (Apple Silicon)',
    quant_levels: MLX_QUANT_LEVELS,
    runtimes: [MLX_RUNTIME_HINT, 'mlx-lm', 'lm-studio-mlx'],
    requires_gpu: false,
    vendor: 'ml-explore/mlx',
    install_hint: 'pip install mlx mlx-lm',
    notes: 'Apple unified-memory framework. macOS only; M-series chip required.',
  }),
});

// Returns array of registry entry objects, stable lexicographic order by id.
export function listFormats() {
  return Object.keys(FORMAT_REGISTRY)
    .sort()
    .map((k) => FORMAT_REGISTRY[k]);
}

// Returns a single registry entry by id, or null if the id is unknown. The
// lookup is case-insensitive but the canonical keys are lowercase.
export function getFormat(id) {
  if (!id) return null;
  const key = String(id).toLowerCase().trim();
  return FORMAT_REGISTRY[key] || null;
}

// Returns array of format ids (lowercase). Useful for CLI flag validation.
export function listFormatIds() {
  return Object.keys(FORMAT_REGISTRY).sort();
}

// Returns true if the format accepts the given quant level. Case-insensitive
// comparison against the format's QUANT_LEVELS array.
export function isQuantSupported(formatId, quant) {
  const entry = getFormat(formatId);
  if (!entry) return false;
  if (!quant) return false;
  const q = String(quant).toLowerCase().trim();
  return entry.quant_levels.some((v) => String(v).toLowerCase() === q);
}

// Returns the install hint for a format, or a generic fallback message.
export function getInstallHint(formatId) {
  const entry = getFormat(formatId);
  if (!entry) return `unknown format: ${formatId}`;
  return entry.install_hint;
}

// Convenience: ids of formats that require a CUDA-class GPU to quantize.
export function gpuRequiredFormats() {
  return listFormats().filter((e) => e.requires_gpu).map((e) => e.id);
}

// Convenience: ids of formats whose quantize step runs CPU-only.
export function cpuOnlyFormats() {
  return listFormats().filter((e) => !e.requires_gpu).map((e) => e.id);
}

export default {
  FORMAT_REGISTRY,
  FORMAT_REGISTRY_VERSION,
  listFormats,
  listFormatIds,
  getFormat,
  isQuantSupported,
  getInstallHint,
  gpuRequiredFormats,
  cpuOnlyFormats,
};
