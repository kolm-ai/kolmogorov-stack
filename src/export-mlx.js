// src/export-mlx.js
//
// S-6 — MLX (Apple Silicon) export chain for ANY artifact.
//
// MLX is Apple's open-source array framework for unified-memory Macs (M1/M2/
// M3/M4). The `mlx-lm` package provides a `mlx_lm.convert` entrypoint that
// takes a HuggingFace directory and produces an MLX-format directory with
// quantized weights + a config.json that lm-studio (MLX backend) and the
// `mlx_lm.generate` / `mlx_lm.server` runners consume directly.
//
// Pipeline:
//   1. Locate the mlx-lm python package.
//   2. Spawn `python -m mlx_lm convert --hf-path <hf_dir> --mlx-path <out>
//      --quantize -q-bits <bits>`.
//   3. mlx-lm writes a model.safetensors + config.json + tokenizer files into
//      target_dir.
//
// Caveats:
//   * macOS only. On Linux/Windows the toolchain probe fails fast with an
//     install hint that explains the constraint.
//   * Mixed-precision (mixed-4-8) requires mlx-lm >= 0.20; older versions
//     accept the flag but emit uniform 4-bit.
//   * fp16 is a no-quant convert path (just reformats the safetensors for
//     MLX's expected layout).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MLX_EXPORT_VERSION = 'export-mlx-v1';

export const QUANT_LEVELS = Object.freeze([
  '4bit',
  '8bit',
  'mixed-4-8',
  'fp16',
]);

export const RUNTIME_HINT = 'mlx-lm';

// MLX quant on a M2 Max / M3 Pro completes much faster than GPU quant elsewhere
// because the unified memory makes the convert step single-shot rather than
// stream-from-disk. Per-billion-param wall times below assume M-series Pro.
const SECONDS_PER_B_PARAM = 22;

function _normalizeQuant(quant) {
  const s = String(quant || '').toLowerCase().trim();
  if (!QUANT_LEVELS.includes(s)) return null;
  if (s === 'fp16') return { mode: 'fp16', bits: 16, mixed: false };
  if (s === '4bit') return { mode: '4bit', bits: 4, mixed: false };
  if (s === '8bit') return { mode: '8bit', bits: 8, mixed: false };
  if (s === 'mixed-4-8') return { mode: 'mixed-4-8', bits: 6, mixed: true };
  return null;
}

export function locateMlxPackage() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, ['-c', 'import mlx_lm; print(getattr(mlx_lm,"__version__","unknown"))'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status === 0) return { module: 'mlx_lm', version: (r.stdout || '').trim() };
  return null;
}

export function probeMlxToolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const platform_supported = process.platform === 'darwin';
  const pkg = platform_supported ? locateMlxPackage() : null;
  const missing = [];
  if (!platform_supported) missing.push('macos_platform');
  if (platform_supported && !pkg) missing.push('mlx-lm');
  return {
    ok: missing.length === 0,
    components: {
      python: py,
      package: pkg,
      platform: process.platform,
      platform_supported,
    },
    missing,
    hint: missing.length
      ? (!platform_supported
          ? 'MLX is macOS-only (Apple Silicon required). Use GGUF or another format on this platform.'
          : 'pip install mlx mlx-lm  (requires macOS 13.3+ on M-series silicon)')
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
    throw new Error(`previewExport: invalid MLX quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  const projected_size_bytes = Math.round(fp16_bytes * (parsed.bits / 16) + 8 * 1024 * 1024);
  const time_multiplier = parsed.mode === 'fp16' ? 0.3 : 1.0;
  const projected_time_s = Math.round(SECONDS_PER_B_PARAM * params_b * time_multiplier);
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const baseArgs = [py, '-m', 'mlx_lm', 'convert', '--hf-path', String(artifact.merged_dir || '<hf_dir>'), '--mlx-path', target_dir];
  if (parsed.mode !== 'fp16') {
    baseArgs.push('-q');
    baseArgs.push('--q-bits', String(parsed.bits));
  }
  return {
    format: 'mlx',
    quant: parsed.mode,
    bits: parsed.bits,
    mixed: parsed.mixed,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: false,
    runtime_hint: RUNTIME_HINT,
    command: baseArgs.join(' '),
    notes: process.platform === 'darwin'
      ? null
      : 'MLX export only runs on macOS Apple Silicon; this preview is informational on the current host.',
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
  const probe = probeMlxToolchain();
  if (!probe.ok) {
    return {
      ok: false,
      error: 'toolchain_missing',
      missing: probe.missing,
      install_hint: probe.hint,
      platform: process.platform,
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
  const args = ['-m', 'mlx_lm', 'convert',
    '--hf-path', artifact.merged_dir,
    '--mlx-path', target_dir,
  ];
  if (parsed.mode !== 'fp16') {
    args.push('-q');
    args.push('--q-bits', String(parsed.bits));
  }
  if (parsed.mixed) {
    // mlx-lm >= 0.20 supports --quant-predicate for per-layer mixing; older
    // versions silently ignore. We pass it best-effort.
    args.push('--quant-predicate', 'mixed_4_8');
  }
  const t0 = process.hrtime.bigint();
  const r = spawnSync(py, args, {
    encoding: 'utf8',
    timeout: 4 * 60 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const wall_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      error: `mlx_convert_exited_${r.status || 'err'}`,
      stderr: (r.stderr || '').slice(-4096),
      stdout: (r.stdout || '').slice(-2048),
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
  let mlxConfig = null;
  const cfgPath = path.join(target_dir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { mlxConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {} // deliberate: cleanup
  }
  return {
    ok: true,
    format: 'mlx',
    output_dir: target_dir,
    quant: parsed.mode,
    bits: parsed.bits,
    mixed: parsed.mixed,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    config: mlxConfig,
    forge_version: MLX_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  MLX_EXPORT_VERSION,
  previewExport,
  runExport,
  probeMlxToolchain,
  locateMlxPackage,
};
