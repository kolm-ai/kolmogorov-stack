// src/export-fp8.js
//
// S-6 - FP8 (8-bit float) export chain for ANY artifact.
//
// FP8 is a native 8-bit floating point format that runs at hardware speed on
// NVIDIA Hopper (sm_90 / H100) and Ada (sm_89 / 4090). Two encodings:
//   * e4m3-4 exponent bits, 3 mantissa bits. Higher precision, narrower
//     dynamic range. Standard choice for weights and activations.
//   * e5m2-5 exponent bits, 2 mantissa bits. Lower precision, wider
//     dynamic range. Used for gradients in training and for activations with
//     extreme dynamic range.
//
// The reference toolchain is vllm-project/llm-compressor, the modern
// successor to AutoFP8. Output is a HuggingFace-style directory with FP8
// weights + a config block that vLLM, TensorRT-LLM and Transformer Engine
// all consume.
//
// Pipeline:
//   1. Locate llmcompressor (preferred) or AutoFP8 (legacy) python package.
//   2. Spawn a python driver: load model -> oneshot(SmoothQuant + FP8 recipe)
//      -> save_pretrained(target_dir).
//   3. The recipe controls weight-only vs weight+activation. We map the
//      QUANT_LEVELS strings (e4m3/e5m2/w8a8/w8a16) to recipe parameters.
//
// Caveats:
//   * FP8 inference requires Hopper or newer for full matmul speedup. Ada
//     (4090) has FP8 cores but partial software exposure. Pre-Hopper, FP8
//     models load but run via dequant -> FP16, defeating the point.
//   * llm-compressor needs CUDA and >= 16GB VRAM for >7B models even just to
//     run calibration.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FP8_EXPORT_VERSION = 'export-fp8-v1';

// e4m3 / e5m2 - weight-only or weight+activation FP8 (W8A8 / W8A16).
// w8a8  = weights + activations both FP8 e4m3 (max speedup, more cal)
// w8a16 = weights FP8 e4m3, activations FP16 (recommended default)
export const QUANT_LEVELS = Object.freeze([
  'e4m3',
  'e5m2',
  'w8a8',
  'w8a16',
]);

export const RUNTIME_HINT = 'vllm-fp8';

const SECONDS_PER_B_PARAM = 60;

function _normalizeQuant(quant) {
  const s = String(quant || '').toLowerCase().trim();
  if (!QUANT_LEVELS.includes(s)) return null;
  // Internal flags: include activation quantization yes/no, and which fp8
  // encoding the weights use.
  let weight_dtype = 'e4m3';
  let activation_dtype = 'fp16';
  if (s === 'e5m2') weight_dtype = 'e5m2';
  if (s === 'w8a8') { weight_dtype = 'e4m3'; activation_dtype = 'e4m3'; }
  if (s === 'w8a16') { weight_dtype = 'e4m3'; activation_dtype = 'fp16'; }
  return { mode: s, weight_dtype, activation_dtype };
}

export function locateFp8Package() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = (mod) => {
    const r = spawnSync(py, ['-c', `import ${mod}; print(${mod}.__version__)`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return r.status === 0 ? { module: mod, version: (r.stdout || '').trim() } : null;
  };
  return probe('llmcompressor') || probe('auto_fp8') || null;
}

export function probeFp8Toolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const pkg = locateFp8Package();
  const missing = [];
  if (!pkg) missing.push('llmcompressor');
  return {
    ok: missing.length === 0,
    components: { python: py, package: pkg },
    missing,
    hint: missing.length
      ? 'pip install llmcompressor  (preferred) OR pip install auto-fp8 (legacy)'
      : null,
  };
}

export function previewExport({ artifact, quant, target_dir }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('previewExport: artifact required');
  }
  if (!quant) throw new Error('previewExport: quant required');
  if (!target_dir) throw new Error('previewExport: target_dir required');
  const parsed = _normalizeQuant(quant);
  if (!parsed) {
    throw new Error(`previewExport: invalid FP8 quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  // FP8 = exactly half the size of FP16. Plus a tiny scale table.
  const projected_size_bytes = Math.round(fp16_bytes / 2 + 1024 * 1024);
  // Activation quantization needs a calibration pass; weight-only is fast.
  const cal_multiplier = parsed.activation_dtype === 'fp16' ? 0.5 : 1.4;
  const projected_time_s = Math.round(SECONDS_PER_B_PARAM * params_b * cal_multiplier);
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const recipe = parsed.activation_dtype === 'fp16'
    ? `QuantizationModifier(targets="Linear", scheme="FP8_DYNAMIC", ignore=["lm_head"])`
    : `QuantizationModifier(targets="Linear", scheme="FP8", ignore=["lm_head"])`;
  const command = [
    py, '-c',
    `"from llmcompressor.modifiers.quantization import QuantizationModifier; from llmcompressor.transformers import oneshot; oneshot(model='${artifact.merged_dir || '<hf_dir>'}', recipe=${recipe}, output_dir='${target_dir}')"`,
  ].join(' ');
  return {
    format: 'fp8',
    quant: parsed.mode,
    weight_dtype: parsed.weight_dtype,
    activation_dtype: parsed.activation_dtype,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: true,
    runtime_hint: RUNTIME_HINT,
    command,
    notes: 'Full matmul speedup requires Hopper (H100) or newer; Ada (4090) runs but does not realize peak throughput.',
  };
}

export async function runExport({ artifact, quant, target_dir }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('runExport: artifact required');
  }
  if (!quant) throw new Error('runExport: quant required');
  if (!target_dir) throw new Error('runExport: target_dir required');
  const parsed = _normalizeQuant(quant);
  if (!parsed) {
    return {
      ok: false,
      error: `invalid_quant_${quant}`,
      hint: `accepted: ${QUANT_LEVELS.join(', ')}`,
    };
  }
  const probe = probeFp8Toolchain();
  if (!probe.ok) {
    return {
      ok: false,
      error: 'toolchain_missing',
      missing: probe.missing,
      install_hint: probe.hint,
    };
  }
  if (!artifact.merged_dir) {
    return { ok: false, error: 'artifact_missing_merged_dir' };
  }
  if (!fs.existsSync(artifact.merged_dir)) {
    return { ok: false, error: 'merged_dir_not_found', detail: artifact.merged_dir };
  }
  fs.mkdirSync(target_dir, { recursive: true });
  const py = probe.components.python;
  const scheme = parsed.activation_dtype === 'fp16' ? 'FP8_DYNAMIC' : 'FP8';
  const script = [
    'import json, sys, traceback',
    'from llmcompressor.transformers import oneshot',
    'from llmcompressor.modifiers.quantization import QuantizationModifier',
    `recipe = QuantizationModifier(targets="Linear", scheme=${JSON.stringify(scheme)}, ignore=["lm_head"])`,
    'try:',
    `    oneshot(model=${JSON.stringify(artifact.merged_dir)}, recipe=recipe, output_dir=${JSON.stringify(target_dir)})`,
    `    print(json.dumps({"ok": True, "scheme": ${JSON.stringify(scheme)}, "weight_dtype": ${JSON.stringify(parsed.weight_dtype)}, "activation_dtype": ${JSON.stringify(parsed.activation_dtype)}}))`,
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc()[-2048:]}))',
    '    sys.exit(1)',
  ].join('\n');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(py, ['-c', script], {
    encoding: 'utf8',
    timeout: 6 * 60 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const wall_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error || r.status !== 0) {
    let detail = null;
    try {
      detail = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop() || '{}');
    } catch {} // deliberate: cleanup
    return {
      ok: false,
      error: `fp8_exited_${r.status || 'err'}`,
      detail,
      stderr: (r.stderr || '').slice(-4096),
      wall_ms,
    };
  }
  let size_bytes = 0;
  try {
    for (const f of fs.readdirSync(target_dir)) {
      const s = fs.statSync(path.join(target_dir, f));
      if (s.isFile()) size_bytes += s.size;
    }
  } catch {} // deliberate: cleanup
  return {
    ok: true,
    format: 'fp8',
    output_dir: target_dir,
    quant: parsed.mode,
    weight_dtype: parsed.weight_dtype,
    activation_dtype: parsed.activation_dtype,
    scheme,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    package_used: probe.components.package.module,
    forge_version: FP8_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  FP8_EXPORT_VERSION,
  previewExport,
  runExport,
  probeFp8Toolchain,
  locateFp8Package,
};
