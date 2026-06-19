// src/export-nvfp4.js
//
// S-6 - NVFP4 (NVIDIA Blackwell 4-bit float) export chain for ANY artifact.
//
// NVFP4 is NVIDIA's hardware-native 4-bit floating point format introduced
// with Blackwell (sm_100 / B100 / B200 / GB200). Unlike INT4 quantization,
// NVFP4 uses a micro-scaled FP4 (E2M1) representation with per-block scaling
// factors stored in FP8, giving roughly INT8-quality at INT4 footprint.
//
// Reference toolchain: NVIDIA/TensorRT-Model-Optimizer (the modelopt python
// package). Output is a HuggingFace-style directory + a quantize_config that
// TensorRT-LLM and vLLM (>= 0.6 with NVFP4 backend) can load.
//
// Pipeline:
//   1. Locate nvidia-modelopt python package (modelopt.torch.quantization).
//   2. Spawn a python driver: load model -> mtq.quantize(MTQ_FORMAT) -> save.
//   3. The mode controls per-block scale precision: w4a4 (most aggressive)
//      through w8a8 (closer to FP8, less savings).
//
// Caveats:
//   * NVFP4 requires Blackwell silicon (sm_100) for full inference speedup.
//     On Hopper / Ada the model loads via emulation and runs slower than FP8.
//   * modelopt distributes pre-built wheels for Linux CUDA-12.x only. Windows
//     and CPU-only platforms require build-from-source.
//   * Active research format; numerical recipes are evolving. Bench K-Score
//     before publishing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFp4CalibPlan } from './fp4-calib-plan.js';

export const NVFP4_EXPORT_VERSION = 'export-nvfp4-v1';

// w4a4 - weights + activations both NVFP4 (max savings, max risk)
// w4a8 - weights NVFP4, activations FP8 (balanced default)
// w8a8 - weights + activations both FP8 (lighter quant; falls through to fp8)
export const QUANT_LEVELS = Object.freeze([
  'w4a4',
  'w4a8',
  'w8a8',
]);

export const RUNTIME_HINT = 'tensorrt-llm+nvfp4';

const SECONDS_PER_B_PARAM = 130;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FP4_CALIB_SCRIPT_DIR = path.resolve(__dirname, '..', 'workers', 'quantize', 'scripts');

function _normalizeQuant(quant) {
  const s = String(quant || '').toLowerCase().trim();
  if (!QUANT_LEVELS.includes(s)) return null;
  let weight_dtype = 'nvfp4';
  let activation_dtype = 'nvfp4';
  if (s === 'w4a8') { weight_dtype = 'nvfp4'; activation_dtype = 'fp8_e4m3'; }
  if (s === 'w8a8') { weight_dtype = 'fp8_e4m3'; activation_dtype = 'fp8_e4m3'; }
  return { mode: s, weight_dtype, activation_dtype };
}

function _intOr(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function _resolveFp4CalibrationPlan(parsed, requested) {
  const enabled = requested === true || requested?.enabled === true;
  if (!enabled) return null;
  const block = _intOr(requested?.block ?? requested?.calib_fp4_block, undefined);
  const max_layers = _intOr(requested?.max_layers ?? requested?.calib_fp4_max_layers, undefined);
  const scale_format = requested?.scale_format || requested?.scale_family || parsed.weight_dtype;
  const plan = buildFp4CalibPlan({
    target: {
      weight_dtype: parsed.weight_dtype,
      quant_level: parsed.mode,
      scale_format,
    },
    block,
    max_layers,
  });
  return plan.enabled ? plan : null;
}

export function locateModeloptPackage() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, ['-c', 'import modelopt; print(modelopt.__version__)'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status === 0) return { module: 'modelopt', version: (r.stdout || '').trim() };
  return null;
}

export function probeNvfp4Toolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const pkg = locateModeloptPackage();
  const missing = [];
  if (!pkg) missing.push('nvidia-modelopt');
  return {
    ok: missing.length === 0,
    components: { python: py, package: pkg },
    missing,
    hint: missing.length
      ? 'pip install nvidia-modelopt[torch]  (Linux CUDA-12 wheels; needs Blackwell silicon for full speedup)'
      : null,
  };
}

// W916-I2 - Blackwell-native gate. NVFP4 only delivers its 2-3x throughput
// win on Blackwell (sm_100+). On Hopper/Ada it loads via emulation and is
// SLOWER than FP8. This probe returns a structured object so callers can
// surface a banner and let users override with `force: true`. Returning a
// rich object (not a bool) so /info, previewExport, and runExport can all
// quote the same diagnostic verbatim.
export function probeBlackwellNative() {
  try {
    // Inline nvidia-smi probe (avoids cross-module ESM/CJS issues and
    // keeps this fn sync so previewExport stays sync). nvidia-smi exit
    // status > 0 → no NVIDIA driver / GPU → return non-Blackwell.
    const r = spawnSync('nvidia-smi',
      ['--query-gpu=name,compute_cap', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) {
      return {
        ok: false,
        blackwell_native: false,
        vendor: 'unknown',
        compute_capability: null,
        reason: 'NVFP4 requires NVIDIA Blackwell silicon; nvidia-smi not available or no NVIDIA GPU detected.',
      };
    }
    const firstLine = String(r.stdout).split(/\r?\n/).find(s => s.trim()) || '';
    const parts = firstLine.split(',').map(s => s.trim());
    const deviceName = parts[0] || null;
    const cc = parts[1] || '';
    const major = parseInt(cc.split('.')[0], 10);
    const isBlackwell = Number.isFinite(major) && major >= 10;
    return {
      ok: isBlackwell,
      blackwell_native: isBlackwell,
      vendor: 'nvidia',
      device_name: deviceName,
      compute_capability: cc || null,
      reason: isBlackwell
        ? `Blackwell native (cc ${cc}) - NVFP4 will run at full speed.`
        : `Detected ${deviceName || 'NVIDIA GPU'} (cc ${cc}). NVFP4 calibration will succeed but inference will emulate FP4 - slower than FP8 on this device.`,
    };
  } catch (e) {
    return {
      ok: false,
      blackwell_native: false,
      vendor: 'unknown',
      compute_capability: null,
      reason: `hardware probe failed: ${e.message}`,
    };
  }
}

export function previewExport({ artifact, quant, target_dir, fp4_calibration = null, fp4_calibration_plan = null }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('previewExport: artifact required');
  }
  if (!quant) throw new Error('previewExport: quant required');
  if (!target_dir) throw new Error('previewExport: target_dir required');
  const parsed = _normalizeQuant(quant);
  if (!parsed) {
    throw new Error(`previewExport: invalid NVFP4 quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const fp4Plan = _resolveFp4CalibrationPlan(parsed, fp4_calibration_plan || fp4_calibration);
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  // NVFP4 weight = 4 bits + per-16-element FP8 scale (8 bits / 16 = 0.5 bits)
  // -> effective ~4.5 bits per weight. w4a8/w8a8 fall back to FP8 size for
  // the weight component.
  const bits_per_weight = parsed.weight_dtype === 'nvfp4' ? 4.5 : 8;
  const weight_bytes = (fp16_bytes / 2 / 16) * bits_per_weight; // (#weights) * bits/8
  const projected_size_bytes = Math.round(weight_bytes * 16 + 4 * 1024 * 1024);
  // Activation calibration cost dominates when activations are also quantized.
  const cal_multiplier = parsed.activation_dtype === 'fp8_e4m3' && parsed.weight_dtype === 'nvfp4' ? 1.6 : 1.2;
  const projected_time_s = Math.round(SECONDS_PER_B_PARAM * params_b * cal_multiplier);
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const formatStr = parsed.mode.toUpperCase();
  const command = [
    py, '-c',
    `"import modelopt.torch.quantization as mtq; from transformers import AutoModelForCausalLM; m=AutoModelForCausalLM.from_pretrained('${artifact.merged_dir || '<hf_dir>'}'); mtq.quantize(m, mtq.${formatStr}_CFG, forward_loop=lambda m: None); m.save_pretrained('${target_dir}')"`,
  ].join(' ');
  const blackwell = probeBlackwellNative();
  return {
    format: 'nvfp4',
    quant: parsed.mode,
    weight_dtype: parsed.weight_dtype,
    activation_dtype: parsed.activation_dtype,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: true,
    runtime_hint: RUNTIME_HINT,
    command,
    fp4_calibration_plan: fp4Plan,
    blackwell_gate: blackwell,
    notes: 'NVFP4 needs Blackwell (sm_100) for full speedup; on Hopper/Ada it loads via emulation and is slower than FP8.',
  };
}

export async function runExport({ artifact, quant, target_dir, force = false, fp4_calibration = null, fp4_calibration_plan = null }) {
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
  const fp4Plan = _resolveFp4CalibrationPlan(parsed, fp4_calibration_plan || fp4_calibration);
  // W916-I2 - Blackwell gate. Block by default on non-Blackwell silicon
  // (emulation runs slower than FP8 - no point quantizing). Bypass with
  // `force: true` for benchmark sweeps that intentionally measure the
  // emulation path.
  const blackwell = probeBlackwellNative();
  if (!blackwell.blackwell_native && !force) {
    return {
      ok: false,
      error: 'not_blackwell_native',
      blackwell_gate: blackwell,
      hint: 'NVFP4 export only delivers a speedup on Blackwell silicon (sm_100+). On Hopper/Ada the emulation path is slower than FP8. Use --target fp8 instead, or pass force:true / --force to override.',
    };
  }
  const probe = probeNvfp4Toolchain();
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
  const formatCfg = parsed.mode === 'w4a4'
    ? 'NVFP4_DEFAULT_CFG'
    : parsed.mode === 'w4a8'
      ? 'NVFP4_FP8_KV_CFG'
      : 'FP8_DEFAULT_CFG';
  const script = [
    'import json, sys, traceback, torch',
    'import modelopt.torch.quantization as mtq',
    'from transformers import AutoModelForCausalLM, AutoTokenizer',
    'fp4_calibration = None',
    'fp4_calibration_fusion = None',
    ...(fp4Plan ? [
      `sys.path.insert(0, ${JSON.stringify(FP4_CALIB_SCRIPT_DIR)})`,
      'try:',
      '    from quantize import run_fp4_calibration, apply_fp4_calibration_to_model',
      `    fp4_calibration = run_fp4_calibration(${JSON.stringify(artifact.merged_dir)}, block=${JSON.stringify(fp4Plan.block)}, max_layers=${JSON.stringify(fp4Plan.max_layers)}, scale_format=${JSON.stringify(fp4Plan.scale_family)})`,
      'except Exception as e:',
      '    fp4_calibration = {"ok": False, "error": str(e), "stage": "fp4_calibration"}',
    ] : []),
    `model = AutoModelForCausalLM.from_pretrained(${JSON.stringify(artifact.merged_dir)}, torch_dtype=torch.float16)`,
    `tok = AutoTokenizer.from_pretrained(${JSON.stringify(artifact.merged_dir)}, trust_remote_code=True)`,
    `cfg = getattr(mtq, ${JSON.stringify(formatCfg)})`,
    ...(fp4Plan ? [
      'try:',
      `    fp4_calibration_fusion = apply_fp4_calibration_to_model(model, fp4_calibration, block=${JSON.stringify(fp4Plan.block)}, max_layers=${JSON.stringify(fp4Plan.max_layers)})`,
      'except Exception as e:',
      '    fp4_calibration_fusion = {"ok": False, "applied": False, "error": str(e), "stage": "fp4_calibration_fusion"}',
    ] : []),
    'def calibrate(m):',
    '    inputs = tok("The quick brown fox jumps over the lazy dog.", return_tensors="pt").to(m.device)',
    '    with torch.no_grad(): m(**inputs)',
    'try:',
    '    mtq.quantize(model, cfg, forward_loop=calibrate)',
    `    model.save_pretrained(${JSON.stringify(target_dir)})`,
    `    tok.save_pretrained(${JSON.stringify(target_dir)})`,
    `    print(json.dumps({"ok": True, "cfg": ${JSON.stringify(formatCfg)}, "weight_dtype": ${JSON.stringify(parsed.weight_dtype)}, "activation_dtype": ${JSON.stringify(parsed.activation_dtype)}, "fp4_calibration": fp4_calibration, "fp4_calibration_fusion": fp4_calibration_fusion}))`,
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
      error: `nvfp4_exited_${r.status || 'err'}`,
      detail,
      stderr: (r.stderr || '').slice(-4096),
      wall_ms,
    };
  }
  let detail = null;
  try {
    detail = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop() || '{}');
  } catch {} // deliberate: cleanup
  let size_bytes = 0;
  try {
    for (const f of fs.readdirSync(target_dir)) {
      const s = fs.statSync(path.join(target_dir, f));
      if (s.isFile()) size_bytes += s.size;
    }
  } catch {} // deliberate: cleanup
  return {
    ok: true,
    format: 'nvfp4',
    output_dir: target_dir,
    quant: parsed.mode,
    weight_dtype: parsed.weight_dtype,
    activation_dtype: parsed.activation_dtype,
    cfg: formatCfg,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    blackwell_gate: blackwell,
    forced: force === true && !blackwell.blackwell_native,
    fp4_calibration_plan: fp4Plan,
    fp4_calibration: detail?.fp4_calibration || null,
    fp4_calibration_fusion: detail?.fp4_calibration_fusion || null,
    forge_version: NVFP4_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  NVFP4_EXPORT_VERSION,
  previewExport,
  runExport,
  probeNvfp4Toolchain,
  locateModeloptPackage,
};
