// src/export-exl2.js
//
// S-6 - EXL2 (exllamav2) export chain for ANY artifact.
//
// EXL2 is turboderp's variable-bitrate per-layer quantization format. Unlike
// fixed-bit formats (GPTQ w4, AWQ w4), EXL2 lets you target a fractional
// bits-per-weight number (e.g. 4.65 bpw) and lets the calibrator decide which
// layers get more or fewer bits to hit the target average. The resulting
// model loads in exllamav2 (CUDA-only) and is consumed by tabbyAPI and
// text-generation-webui.
//
// Pipeline:
//   1. Locate the convert.py script that ships with exllamav2 (pip install
//      exllamav2 lays it down as a console script `exllamav2-convert` OR as
//      convert.py inside the package).
//   2. Run convert.py with -i <hf_dir> -o <work_dir> -cf <out_dir> -b <bpw>.
//   3. exllamav2 writes a directory containing config.json + tokenizer files
//      + multi-shard quantized weights + a measurement.json that records the
//      per-layer bit allocation. We treat the directory as the artifact.
//
// Caveats:
//   * exllamav2 quantization REQUIRES a CUDA GPU. There is no CPU fallback.
//   * The default calibration set ships inside the exllamav2 package; we let
//     it pick unless --calibration-dataset is supplied (passed through).
//   * Sub-3 bpw targets degrade noticeably; we accept them in QUANT_LEVELS
//     but the caller should bench K-Score before publishing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXL2_EXPORT_VERSION = 'export-exl2-v1';

// Canonical bpw targets we expose via --quant. exllamav2 itself accepts any
// float in [2.0, 8.0]; this list is the curated ladder we surface in the
// CLI/docs. Callers can still pass any string convertible to a float in
// runExport; previewExport validates against this list.
export const QUANT_LEVELS = Object.freeze([
  '2.4bpw',
  '3.0bpw',
  '3.5bpw',
  '4.0bpw',
  '4.5bpw',
  '5.0bpw',
  '6.0bpw',
  '8.0bpw',
]);

export const RUNTIME_HINT = 'exllamav2';

// Approximate size factor for projected_size_bytes. EXL2 is bit-packed so
// projected size scales roughly with bpw / 16 (vs the FP16 baseline). Add a
// small overhead for the per-layer measurement table + tokenizer + config.
const SIZE_OVERHEAD_BYTES = 8 * 1024 * 1024;

// Estimated wall-time per billion params on a single 24GB-class CUDA card
// (4090 / A6000-tier). The calibration step dominates and scales roughly
// linearly with params and inversely with target bpw (lower bpw = more
// search). These numbers are a planning hint, not a SLA.
const SECONDS_PER_B_PARAM_AT_4BPW = 95;

function _parseBpw(quant) {
  if (typeof quant === 'number') return Number.isFinite(quant) ? quant : null;
  const m = String(quant || '').match(/^([0-9]+(?:\.[0-9]+)?)\s*bpw?$/i);
  if (m) return Number(m[1]);
  const f = Number(quant);
  return Number.isFinite(f) ? f : null;
}

// Locate the exllamav2 convert entrypoint. Order of preference:
//   1. EXLLAMAV2_CONVERT env var pointing to convert.py
//   2. `exllamav2-convert` on PATH (pip install drops this console script)
//   3. python -m exllamav2.conversion.convert (always works if package present)
export function locateConverter() {
  const env = process.env.EXLLAMAV2_CONVERT;
  if (env && fs.existsSync(env)) {
    return { kind: 'file', path: env };
  }
  const isWin = process.platform === 'win32';
  const which = isWin ? 'where' : 'which';
  try {
    const r = spawnSync(which, ['exllamav2-convert'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      const line = (r.stdout || '').split(/\r?\n/).find((l) => l.trim().length > 0);
      if (line) return { kind: 'console', path: line.trim() };
    }
  } catch {} // deliberate: cleanup
  // Always-available fallback if exllamav2 is importable; we let probeToolchain
  // verify importability and return this shape so callers can spawn it.
  return { kind: 'module', module: 'exllamav2.conversion.convert' };
}

// Probe whether the exllamav2 toolchain is installed. Returns
// { ok, components, missing, hint }.
export function probeExl2Toolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, ['-c', 'import exllamav2; print(exllamav2.__version__)'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const exllamav2_ok = r.status === 0;
  const exllamav2_version = exllamav2_ok ? (r.stdout || '').trim() : null;
  const converter = locateConverter();
  const missing = [];
  if (!exllamav2_ok) missing.push('exllamav2');
  return {
    ok: missing.length === 0,
    components: {
      python: py,
      exllamav2: exllamav2_ok,
      exllamav2_version,
      converter,
    },
    missing,
    hint: missing.length
      ? 'pip install exllamav2  (requires CUDA; on Windows pre-built wheels at https://github.com/turboderp/exllamav2/releases)'
      : null,
  };
}

// Project (without running) what runExport would do. Used by the CLI
// --preview path and by S-9 Studio UI's "compile preview" pane.
export function previewExport({ artifact, quant, target_dir }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('previewExport: artifact required');
  }
  if (!quant) throw new Error('previewExport: quant required');
  if (!target_dir) throw new Error('previewExport: target_dir required');
  const bpw = _parseBpw(quant);
  if (bpw == null || bpw < 1.5 || bpw > 8.5) {
    throw new Error(`previewExport: invalid bpw target ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  const projected_size_bytes = Math.round(fp16_bytes * (bpw / 16) + SIZE_OVERHEAD_BYTES);
  const ratio_4bpw = 4 / Math.max(bpw, 0.5);
  const projected_time_s = Math.round(SECONDS_PER_B_PARAM_AT_4BPW * params_b * ratio_4bpw);
  const converter = locateConverter();
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const baseCmd =
    converter.kind === 'console'
      ? [converter.path]
      : converter.kind === 'file'
      ? [py, converter.path]
      : [py, '-m', 'exllamav2.conversion.convert'];
  const command = [
    ...baseCmd,
    '-i', String(artifact.merged_dir || '<hf_dir>'),
    '-o', String(path.join(target_dir, 'work')),
    '-cf', String(target_dir),
    '-b', String(bpw),
  ].join(' ');
  return {
    format: 'exl2',
    quant: `${bpw}bpw`,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: true,
    runtime_hint: RUNTIME_HINT,
    command,
    notes: bpw < 3
      ? 'Sub-3 bpw target; expect material K-Score regression vs FP16.'
      : null,
  };
}

// Actually run the export. Returns a Promise that resolves to an envelope
// matching the GGUF chain's shape. Tool-not-installed cases return
// { ok:false, error, install_hint } WITHOUT raising - the caller handles UX.
export async function runExport({ artifact, quant, target_dir }) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('runExport: artifact required');
  }
  if (!quant) throw new Error('runExport: quant required');
  if (!target_dir) throw new Error('runExport: target_dir required');
  const bpw = _parseBpw(quant);
  if (bpw == null || bpw < 1.5 || bpw > 8.5) {
    return {
      ok: false,
      error: `invalid_bpw_${quant}`,
      hint: `accepted: ${QUANT_LEVELS.join(', ')}`,
    };
  }
  const probe = probeExl2Toolchain();
  if (!probe.ok) {
    return {
      ok: false,
      error: 'toolchain_missing',
      missing: probe.missing,
      install_hint: probe.hint,
    };
  }
  if (!artifact.merged_dir) {
    return {
      ok: false,
      error: 'artifact_missing_merged_dir',
      hint: 'EXL2 export requires artifact.merged_dir (HF directory)',
    };
  }
  if (!fs.existsSync(artifact.merged_dir)) {
    return {
      ok: false,
      error: 'merged_dir_not_found',
      detail: artifact.merged_dir,
    };
  }
  fs.mkdirSync(target_dir, { recursive: true });
  const workDir = path.join(target_dir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const converter = probe.components.converter;
  const py = probe.components.python;
  const baseArgs =
    converter.kind === 'console'
      ? []
      : converter.kind === 'file'
      ? [converter.path]
      : ['-m', 'exllamav2.conversion.convert'];
  const cmdBin = converter.kind === 'console' ? converter.path : py;
  const args = [
    ...baseArgs,
    '-i', artifact.merged_dir,
    '-o', workDir,
    '-cf', target_dir,
    '-b', String(bpw),
  ];
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmdBin, args, {
    encoding: 'utf8',
    timeout: 6 * 60 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const wall_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      error: `convert_exited_${r.status || 'err'}`,
      stderr: (r.stderr || '').slice(-4096),
      wall_ms,
    };
  }
  let measurement = null;
  const measPath = path.join(target_dir, 'measurement.json');
  if (fs.existsSync(measPath)) {
    try { measurement = JSON.parse(fs.readFileSync(measPath, 'utf8')); } catch {} // deliberate: cleanup
  }
  let size_bytes = 0;
  for (const f of fs.readdirSync(target_dir)) {
    try {
      const s = fs.statSync(path.join(target_dir, f));
      if (s.isFile()) size_bytes += s.size;
    } catch {} // deliberate: cleanup
  }
  return {
    ok: true,
    format: 'exl2',
    output_dir: target_dir,
    quant: `${bpw}bpw`,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    measurement,
    forge_version: EXL2_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  EXL2_EXPORT_VERSION,
  previewExport,
  runExport,
  probeExl2Toolchain,
  locateConverter,
};
