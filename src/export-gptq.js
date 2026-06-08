// src/export-gptq.js
//
// S-6 - GPTQ (auto-gptq / GPTQModel) export chain for ANY artifact.
//
// GPTQ is the classic Hessian-calibrated weight-only quantization scheme from
// Frantar et al. (2022). The current maintained implementation is GPTQModel
// (the AutoGPTQ successor); both share the same on-disk format. Output is a
// HuggingFace-style directory with quantized weights + a quantize_config.json
// that vLLM / TGI / transformers all consume natively.
//
// Pipeline:
//   1. Locate gptqmodel (preferred) or auto_gptq (legacy) python package.
//   2. Spawn a python one-liner that loads the artifact, runs a calibration
//      forward pass over the supplied dataset (or wikitext-2 default), and
//      saves the quantized model into target_dir.
//   3. The python wrapper writes quantize_config.json with bits + group_size
//      + sym/asym + desc_act. We surface those in the result envelope.
//
// Caveats:
//   * GPTQ calibration requires a CUDA GPU; CPU-only mode is supported by
//     GPTQModel but is impractically slow (>10x).
//   * The calibration dataset matters. Default is wikitext-2 (the upstream
//     default); for support-bot artifacts we recommend passing a 256-row
//     sample of the namespace's own captures.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GPTQ_EXPORT_VERSION = 'export-gptq-v1';

// Canonical quant strings. Shape is wXgY where X = weight bits and Y = group
// size for the per-group scale. wXgY=-1 means "per-tensor". The CLI accepts
// short forms (w4 = w4g128).
export const QUANT_LEVELS = Object.freeze([
  'w2g16',
  'w3g32',
  'w4g32',
  'w4g64',
  'w4g128',
  'w8g32',
  'w8g128',
]);

export const RUNTIME_HINT = 'vllm+autogptq';

// Default calibration dataset name passed into GPTQModel. The package ships
// a built-in fetcher that pulls wikitext-2-raw-v1 over HTTP on first run.
const DEFAULT_CALIBRATION = 'wikitext2';
const DEFAULT_CALIBRATION_NSAMPLES = 128;
const DEFAULT_CALIBRATION_SEQLEN = 2048;

// Wall-time estimate (seconds per billion params on a 24GB-class GPU). GPTQ
// calibration is the dominant cost; quantization itself is fast.
const SECONDS_PER_B_PARAM = 110;

// Parse "w4g128" -> { bits: 4, group_size: 128 }. Accepts shorthand "w4"
// (group_size defaults to 128 which is the GPTQModel default).
function _parseQuant(quant) {
  const m = String(quant || '').toLowerCase().match(/^w(\d+)(?:g(-?\d+))?$/);
  if (!m) return null;
  const bits = Number(m[1]);
  const group_size = m[2] != null ? Number(m[2]) : 128;
  if (![2, 3, 4, 8].includes(bits)) return null;
  return { bits, group_size };
}

// Locate the GPTQ python package. Returns { module: 'gptqmodel' | 'auto_gptq',
// version: '...' } or null.
export function locateGptqPackage() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = (mod) => {
    const r = spawnSync(py, ['-c', `import ${mod}; print(${mod}.__version__)`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return r.status === 0 ? { module: mod, version: (r.stdout || '').trim() } : null;
  };
  return probe('gptqmodel') || probe('auto_gptq') || null;
}

export function probeGptqToolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const pkg = locateGptqPackage();
  const missing = [];
  if (!pkg) missing.push('gptqmodel');
  return {
    ok: missing.length === 0,
    components: { python: py, package: pkg },
    missing,
    hint: missing.length
      ? 'pip install gptqmodel  (preferred) OR pip install auto-gptq optimum (legacy)'
      : null,
  };
}

export function previewExport({ artifact, quant, target_dir }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('previewExport: artifact required');
  }
  if (!quant) throw new Error('previewExport: quant required');
  if (!target_dir) throw new Error('previewExport: target_dir required');
  const parsed = _parseQuant(quant);
  if (!parsed) {
    throw new Error(`previewExport: invalid GPTQ quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  // GPTQ stores quantized weights + per-group scales + zero-points. Total
  // footprint ~ (bits/16)*fp16 + per-group overhead. Group overhead is
  // 16 bits per group (scale + zero), one group per (group_size * 1) weights.
  const weight_bytes = fp16_bytes * (parsed.bits / 16);
  const num_weights = fp16_bytes / 2;
  const num_groups = parsed.group_size > 0 ? num_weights / parsed.group_size : 1;
  const group_overhead = num_groups * 4; // 32 bits per group (scale fp16 + zero u16)
  const projected_size_bytes = Math.round(weight_bytes + group_overhead);
  const projected_time_s = Math.round(SECONDS_PER_B_PARAM * params_b);
  const pkg = locateGptqPackage();
  const moduleName = pkg && pkg.module === 'auto_gptq' ? 'auto_gptq' : 'gptqmodel';
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const command = [
    py, '-c',
    `"from ${moduleName} import GPTQModel, QuantizeConfig; cfg=QuantizeConfig(bits=${parsed.bits},group_size=${parsed.group_size},desc_act=True); m=GPTQModel.load('${artifact.merged_dir || '<hf_dir>'}', cfg); m.quantize(calibration='${DEFAULT_CALIBRATION}'); m.save('${target_dir}')"`,
  ].join(' ');
  return {
    format: 'gptq',
    quant: `w${parsed.bits}g${parsed.group_size}`,
    bits: parsed.bits,
    group_size: parsed.group_size,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: true,
    runtime_hint: RUNTIME_HINT,
    command,
    notes: parsed.bits === 2
      ? '2-bit GPTQ has aggressive accuracy loss; bench K-Score before publishing.'
      : null,
  };
}

export async function runExport({ artifact, quant, target_dir, calibration = DEFAULT_CALIBRATION, nsamples = DEFAULT_CALIBRATION_NSAMPLES, seqlen = DEFAULT_CALIBRATION_SEQLEN }) {
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
  const probe = probeGptqToolchain();
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
  const moduleName = probe.components.package.module;
  // Build a multi-line python driver and pipe via stdin. Keeps quoting sane.
  const script = [
    'import json, sys, os, traceback',
    `from ${moduleName} import GPTQModel, QuantizeConfig`,
    `cfg = QuantizeConfig(bits=${parsed.bits}, group_size=${parsed.group_size}, desc_act=True, sym=True)`,
    `model = GPTQModel.load(${JSON.stringify(artifact.merged_dir)}, cfg)`,
    'try:',
    `    model.quantize(calibration=${JSON.stringify(calibration)}, nsamples=${nsamples}, seqlen=${seqlen})`,
    `    model.save(${JSON.stringify(target_dir)})`,
    '    print(json.dumps({"ok": True, "bits": cfg.bits, "group_size": cfg.group_size}))',
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
      error: `gptq_exited_${r.status || 'err'}`,
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
  let qcfg = null;
  const qcfgPath = path.join(target_dir, 'quantize_config.json');
  if (fs.existsSync(qcfgPath)) {
    try { qcfg = JSON.parse(fs.readFileSync(qcfgPath, 'utf8')); } catch {} // deliberate: cleanup
  }
  return {
    ok: true,
    format: 'gptq',
    output_dir: target_dir,
    quant: `w${parsed.bits}g${parsed.group_size}`,
    bits: parsed.bits,
    group_size: parsed.group_size,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    quantize_config: qcfg,
    package_used: moduleName,
    forge_version: GPTQ_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  GPTQ_EXPORT_VERSION,
  previewExport,
  runExport,
  probeGptqToolchain,
  locateGptqPackage,
};
