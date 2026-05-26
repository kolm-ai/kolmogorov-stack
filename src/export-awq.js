// src/export-awq.js
//
// S-6 — AWQ (autoawq) export chain for ANY artifact.
//
// AWQ (Activation-aware Weight Quantization) from Lin et al. (2023). The key
// idea: identify the 1% of weight channels that matter most based on
// activation magnitude, then keep them at higher precision while aggressively
// quantizing the rest. The result is a HuggingFace-style directory consumed
// natively by vLLM and transformers (via the `quantization_config` block in
// config.json).
//
// Pipeline:
//   1. Locate the autoawq python package.
//   2. Spawn a python one-liner that loads the artifact, runs activation-
//      profiling over the calibration dataset (mit-han-lab/pile-val-backup
//      default), then quantizes and saves to target_dir.
//   3. Surface the resulting quantization_config so the runtime_passport
//      builder can record `quant_method=awq`.
//
// Caveats:
//   * AWQ quantization requires a CUDA GPU.
//   * w3 mode is experimental in autoawq; we expose it but the test surface
//     warns.
//   * autoawq's quant_config also takes `version` ("GEMM"|"GEMV"); we default
//     to GEMM (faster on most workloads) and surface it in the envelope.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const AWQ_EXPORT_VERSION = 'export-awq-v1';

// Canonical quant strings. Format is wX[-gY]; group size defaults to 128.
// Bare "w4" is equivalent to "w4-g128", the standard AWQ recipe.
export const QUANT_LEVELS = Object.freeze([
  'w3',
  'w4',
  'w4-g32',
  'w4-g64',
  'w4-g128',
  'w8',
]);

export const RUNTIME_HINT = 'vllm+autoawq';

const DEFAULT_CALIBRATION = 'mit-han-lab/pile-val-backup';
const DEFAULT_CALIBRATION_NSAMPLES = 128;
const DEFAULT_VERSION = 'GEMM';

const SECONDS_PER_B_PARAM = 100;

function _parseQuant(quant) {
  const s = String(quant || '').toLowerCase();
  const m = s.match(/^w(\d+)(?:-g(-?\d+))?$/);
  if (!m) return null;
  const bits = Number(m[1]);
  const group_size = m[2] != null ? Number(m[2]) : 128;
  if (![3, 4, 8].includes(bits)) return null;
  return { bits, group_size };
}

export function locateAutoawqPackage() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, ['-c', 'import awq; print(awq.__version__)'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status === 0) return { module: 'awq', version: (r.stdout || '').trim() };
  return null;
}

export function probeAwqToolchain() {
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const pkg = locateAutoawqPackage();
  const missing = [];
  if (!pkg) missing.push('autoawq');
  return {
    ok: missing.length === 0,
    components: { python: py, package: pkg },
    missing,
    hint: missing.length
      ? 'pip install autoawq  (requires CUDA + torch >= 2.0)'
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
    throw new Error(`previewExport: invalid AWQ quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const params_b = Number(artifact.params_b) || Number(artifact.params_billion) || 7;
  const fp16_bytes = params_b * 2 * 1e9;
  // AWQ keeps a small fraction of channels at FP16 (~1%); the rest at `bits`.
  // Effective bitrate = bits * 0.99 + 16 * 0.01.
  const effective_bits = parsed.bits * 0.99 + 16 * 0.01;
  const weight_bytes = fp16_bytes * (effective_bits / 16);
  const num_weights = fp16_bytes / 2;
  const num_groups = parsed.group_size > 0 ? num_weights / parsed.group_size : 1;
  const group_overhead = num_groups * 4;
  const projected_size_bytes = Math.round(weight_bytes + group_overhead);
  const projected_time_s = Math.round(SECONDS_PER_B_PARAM * params_b);
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const command = [
    py, '-c',
    `"from awq import AutoAWQForCausalLM; m=AutoAWQForCausalLM.from_pretrained('${artifact.merged_dir || '<hf_dir>'}'); m.quantize(tokenizer, quant_config={'w_bit':${parsed.bits},'q_group_size':${parsed.group_size},'version':'${DEFAULT_VERSION}'}); m.save_quantized('${target_dir}')"`,
  ].join(' ');
  return {
    format: 'awq',
    quant: parsed.bits === 4 && parsed.group_size === 128 ? 'w4' : `w${parsed.bits}-g${parsed.group_size}`,
    bits: parsed.bits,
    group_size: parsed.group_size,
    version: DEFAULT_VERSION,
    projected_size_bytes,
    projected_time_s,
    requires_gpu: true,
    runtime_hint: RUNTIME_HINT,
    command,
    notes: parsed.bits === 3
      ? 'w3 is experimental in autoawq; bench K-Score before publishing.'
      : null,
  };
}

export async function runExport({ artifact, quant, target_dir, calibration = DEFAULT_CALIBRATION, nsamples = DEFAULT_CALIBRATION_NSAMPLES, version = DEFAULT_VERSION }) {
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
  const probe = probeAwqToolchain();
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
    'import json, sys, traceback',
    'from awq import AutoAWQForCausalLM',
    'from transformers import AutoTokenizer',
    `model = AutoAWQForCausalLM.from_pretrained(${JSON.stringify(artifact.merged_dir)}, safetensors=True)`,
    `tok = AutoTokenizer.from_pretrained(${JSON.stringify(artifact.merged_dir)}, trust_remote_code=True)`,
    `quant_config = {"zero_point": True, "q_group_size": ${parsed.group_size}, "w_bit": ${parsed.bits}, "version": ${JSON.stringify(version)}}`,
    'try:',
    `    model.quantize(tok, quant_config=quant_config, calib_data=${JSON.stringify(calibration)}, n_parallel_calib_samples=${nsamples})`,
    `    model.save_quantized(${JSON.stringify(target_dir)})`,
    `    tok.save_pretrained(${JSON.stringify(target_dir)})`,
    '    print(json.dumps({"ok": True, "bits": quant_config["w_bit"], "group_size": quant_config["q_group_size"]}))',
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
    } catch {}
    return {
      ok: false,
      error: `awq_exited_${r.status || 'err'}`,
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
  } catch {}
  let qcfg = null;
  const cfgPath = path.join(target_dir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const full = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      qcfg = full.quantization_config || null;
    } catch {}
  }
  return {
    ok: true,
    format: 'awq',
    output_dir: target_dir,
    quant: parsed.bits === 4 && parsed.group_size === 128 ? 'w4' : `w${parsed.bits}-g${parsed.group_size}`,
    bits: parsed.bits,
    group_size: parsed.group_size,
    version,
    size_bytes,
    wall_ms,
    runtime_hint: RUNTIME_HINT,
    quantization_config: qcfg,
    forge_version: AWQ_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  RUNTIME_HINT,
  AWQ_EXPORT_VERSION,
  previewExport,
  runExport,
  probeAwqToolchain,
  locateAutoawqPackage,
};
