// src/export-hqq.js
//
// S-6 - HQQ (Half-Quadratic Quantization) export chain for ANY artifact.
//
// HQQ from mobiusml is a calibration-free weight-only quantization scheme.
// Unlike GPTQ / AWQ, HQQ runs in seconds because there is no calibration
// pass - the algorithm solves a closed-form half-quadratic problem per layer
// using only the weight tensor itself. Output integrates with transformers
// via the `hqq` package's HQQLinear modules; the saved directory is loaded
// with HQQModelForCausalLM.from_quantized.
//
// Pipeline:
//   1. Locate the `hqq` python package.
//   2. Spawn a python driver that loads the artifact, applies HQQConfig
//      (bits, group_size) per Linear layer, and saves to target_dir.
//   3. The result is a HuggingFace-style directory + an hqq config snippet
//      stored in qmodel.pt or shards thereof.
//
// Caveats:
//   * HQQ can run CPU-only (the calibration-free nature means no GPU needed
//     for quantization) but loading + inference still benefits from CUDA.
//   * Quality vs GPTQ/AWQ: HQQ is generally within 1-2% on standard benches
//     while being 10-100x faster to produce. The trade is worth it for
//     iteration speed during distill -> deploy cycles.
//   * 2-bit HQQ degrades sharply; reserve for memory-pinned hardware.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HQQ_EXPORT_VERSION = 'export-hqq-v1';

// Format: wX_gY where X = bits and Y = group size. Default group sizes follow
// the HQQ paper recommendations.
export const QUANT_LEVELS = Object.freeze([
  'w2_g32',
  'w3_g32',
  'w4_g32',
  'w4_g64',
  'w4_g128',
  'w8_g32',
  'w8_g128',
]);

export const RUNTIME_HINT = 'hqq+transformers';

// HQQ is fast - minutes not hours, even for 70B. Per-B-param wall time on
// CPU is the bottleneck; GPU is 10x faster but rarely needed for quantize.
const SECONDS_PER_B_PARAM_CPU = 35;
const SECONDS_PER_B_PARAM_GPU = 5;

function _parseQuant(quant) {
  const m = String(quant || '').toLowerCase().match(/^w(\d+)_g(-?\d+)$/);
  if (!m) return null;
  const bits = Number(m[1]);
  const group_size = Number(m[2]);
  if (![2, 3, 4, 8].includes(bits)) return null;
  return { bits, group_size };
}

export function locateHqqPackage() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, ['-c', 'import hqq; print(hqq.__version__)'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status === 0) return { module: 'hqq', version: (r.stdout || '').trim() };
  return null;
}

export function probeHqqToolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const pkg = locateHqqPackage();
  const missing = [];
  if (!pkg) missing.push('hqq');
  return {
    ok: missing.length === 0,
    components: { python: py, package: pkg },
    missing,
    hint: missing.length
      ? 'pip install hqq  (CPU works; GPU optional for 10x quantize speedup)'
      : null,
  };
}

export function previewExport({ artifact, quant, target_dir, gpu = false }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('previewExport: artifact required');
  }
  if (!quant) throw new Error('previewExport: quant required');
  if (!target_dir) throw new Error('previewExport: target_dir required');
  const parsed = _parseQuant(quant);
  if (!parsed) {
    throw new Error(`previewExport: invalid HQQ quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  const weight_bytes = fp16_bytes * (parsed.bits / 16);
  const num_weights = fp16_bytes / 2;
  const num_groups = parsed.group_size > 0 ? num_weights / parsed.group_size : 1;
  // HQQ stores per-group scale + zero in fp16 each - 32 bits per group.
  const group_overhead = num_groups * 4;
  const projected_size_bytes = Math.round(weight_bytes + group_overhead);
  const per_b = gpu ? SECONDS_PER_B_PARAM_GPU : SECONDS_PER_B_PARAM_CPU;
  const projected_time_s = Math.round(per_b * params_b);
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const command = [
    py, '-c',
    `"from hqq.engine.hf import HQQModelForCausalLM; from hqq.core.quantize import BaseQuantizeConfig; m=HQQModelForCausalLM.from_pretrained('${artifact.merged_dir || '<hf_dir>'}'); cfg=BaseQuantizeConfig(nbits=${parsed.bits}, group_size=${parsed.group_size}); m.quantize_model(quant_config=cfg); m.save_quantized('${target_dir}')"`,
  ].join(' ');
  return {
    format: 'hqq',
    quant: `w${parsed.bits}_g${parsed.group_size}`,
    bits: parsed.bits,
    group_size: parsed.group_size,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: false,
    runtime_hint: RUNTIME_HINT,
    command,
    notes: parsed.bits === 2
      ? '2-bit HQQ degrades sharply; reserve for memory-pinned hardware.'
      : 'Calibration-free: quantize step completes in seconds-to-minutes regardless of dataset.',
  };
}

export async function runExport({ artifact, quant, target_dir, device = 'cuda' }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('runExport: artifact required');
  }
  if (!quant) throw new Error('runExport: quant required');
  if (!target_dir) throw new Error('runExport: target_dir required');
  const parsed = _parseQuant(quant);
  if (!parsed) {
    return {
      ok: false,
      error: `invalid_quant_${quant}`,
      hint: `accepted: ${QUANT_LEVELS.join(', ')}`,
    };
  }
  const probe = probeHqqToolchain();
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
  const script = [
    'import json, sys, traceback, torch',
    'from hqq.engine.hf import HQQModelForCausalLM, AutoTokenizer',
    'from hqq.core.quantize import BaseQuantizeConfig',
    `model = HQQModelForCausalLM.from_pretrained(${JSON.stringify(artifact.merged_dir)})`,
    `tok = AutoTokenizer.from_pretrained(${JSON.stringify(artifact.merged_dir)}, trust_remote_code=True)`,
    `cfg = BaseQuantizeConfig(nbits=${parsed.bits}, group_size=${parsed.group_size}, quant_zero=False, quant_scale=False, axis=1)`,
    'try:',
    `    model.quantize_model(quant_config=cfg, compute_dtype=torch.float16, device=${JSON.stringify(device)})`,
    `    model.save_quantized(${JSON.stringify(target_dir)})`,
    `    tok.save_pretrained(${JSON.stringify(target_dir)})`,
    `    print(json.dumps({"ok": True, "bits": ${parsed.bits}, "group_size": ${parsed.group_size}, "device": ${JSON.stringify(device)}}))`,
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc()[-2048:]}))',
    '    sys.exit(1)',
  ].join('\n');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(py, ['-c', script], {
    encoding: 'utf8',
    timeout: 4 * 60 * 60 * 1000,
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
      error: `hqq_exited_${r.status || 'err'}`,
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
    format: 'hqq',
    output_dir: target_dir,
    quant: `w${parsed.bits}_g${parsed.group_size}`,
    bits: parsed.bits,
    group_size: parsed.group_size,
    device,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    forge_version: HQQ_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  HQQ_EXPORT_VERSION,
  previewExport,
  runExport,
  probeHqqToolchain,
  locateHqqPackage,
};
