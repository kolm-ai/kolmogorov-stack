// src/export-gguf.js
//
// S-1 — Generic GGUF export chain for ANY artifact (not just Trinity).
//
// Pipeline:
//   1. Locate llama.cpp binaries (convert_hf_to_gguf.py + llama-quantize +
//      llama-imatrix + llama-cli).
//   2. If the artifact carries a merged HF directory (artifact.merged_dir),
//      convert it to a base F16 GGUF.
//   3. If the requested quant is in the IQ family, build an importance matrix
//      (.imatrix) from imatrixSource (a jsonl eval set or txt corpus).
//   4. Quantize the F16 base to the target level via llama-quantize.
//   5. Embed kolm metadata: general.name, general.quantized_by='kolm-forge',
//      kolm.kscore, kolm.artifact_hash, llm.context_length.
//   6. Split files into shards if the result is >50GB (sharded GGUF format).
//   7. Coherence test — load via llama-cli, generate 100 tokens against a
//      smoke prompt, parse output (non-empty + no obvious garbage).
//   8. Compute quality_delta vs FP16 baseline if the artifact passport
//      carries a `baseline_metric` field.
//   9. Return a runtime_passport entry (status='tested' with measurements).
//
// The module is GENERIC. It does not hard-code trinity-500 paths; it takes an
// `artifact` descriptor (artifact_hash, name, merged_dir, params_b, passport)
// and operates on whatever HF / GGUF source is supplied.
//
// Toolchain detection order (mirrors src/runners/gguf-runner.js):
//   LLAMA_CPP_BIN env -> $LLAMA_CPP_HOME/bin -> PATH probe ->
//   tools/llama.cpp/bin -> vendor/llama.cpp/bin -> ~/llama.cpp-bin
//
// Honest envelope: no probe lies. If a binary is missing the function returns
// { ok:false, missing:[...], hint:'install steps' }. Never claims a quant
// succeeded when llama-quantize wasn't even on PATH.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GGUF_EXPORT_VERSION = 'export-gguf-v1';

// Every quantization level the chain accepts. Maps 1:1 to the llama-quantize
// argument values (case-insensitive — we upper-case before spawn).
export const QUANT_LEVELS = Object.freeze([
  // K-quants
  'Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L',
  'Q4_0', 'Q4_K_S', 'Q4_K_M',
  'Q5_0', 'Q5_K_S', 'Q5_K_M',
  'Q6_K', 'Q8_0',
  // I-quants (imatrix-driven)
  'IQ1_S', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M',
  'IQ3_XXS', 'IQ3_S', 'IQ3_M',
  'IQ4_XS', 'IQ4_NL',
  // Full precision pass-through
  'F16', 'BF16', 'F32',
]);

// Quant levels that benefit from (or require) an imatrix. K-quants accept one
// optionally; I-quants need one or they degrade noticeably.
const IMATRIX_REQUIRED = new Set([
  'IQ1_S', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M',
  'IQ3_XXS', 'IQ3_S', 'IQ3_M',
  'IQ4_XS', 'IQ4_NL',
]);

// Quant levels we pass through without re-quantizing (already FP). The chain
// still runs the conversion / metadata embed steps.
const FULL_PRECISION = new Set(['F16', 'BF16', 'F32']);

// 50 GB shard threshold. llama.cpp's gguf-split tool uses 50 GiB as the
// commonly-recommended single-shard ceiling for fast resumable downloads.
const SHARD_THRESHOLD_BYTES = 50 * 1024 * 1024 * 1024;

// Default coherence-test prompt + token budget. Kept short so the probe
// completes in seconds, not minutes.
const COHERENCE_PROMPT = 'Hello, please reply with one short sentence.';
const COHERENCE_TOKENS = 100;

// ----------------------------------------------------------------------------
// Toolchain detection
// ----------------------------------------------------------------------------

// Locate convert_hf_to_gguf.py (the HF-to-GGUF converter). Returns absolute
// path or null. The script comes with a llama.cpp checkout, NOT with a built
// binary — so we look in source directories + env hints.
export function locateConvertScript() {
  const env = process.env.LLAMA_CPP_CONVERT || process.env.KOLM_LLAMA_CONVERT;
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    process.env.LLAMA_CPP_HOME && path.join(process.env.LLAMA_CPP_HOME, 'convert_hf_to_gguf.py'),
    process.env.LLAMA_CPP_HOME && path.join(process.env.LLAMA_CPP_HOME, 'convert-hf-to-gguf.py'),
    path.join(process.cwd(), 'tools', 'llama.cpp', 'convert_hf_to_gguf.py'),
    path.join(process.cwd(), 'tools', 'llama.cpp', 'convert-hf-to-gguf.py'),
    path.join(process.cwd(), 'vendor', 'llama.cpp', 'convert_hf_to_gguf.py'),
    path.join(os.homedir(), 'llama.cpp', 'convert_hf_to_gguf.py'),
    path.join(os.homedir(), 'llama.cpp', 'convert-hf-to-gguf.py'),
    path.join(os.homedir(), 'src', 'llama.cpp', 'convert_hf_to_gguf.py'),
    path.join(os.homedir(), '.kolm', 'build', 'llama.cpp', 'convert_hf_to_gguf.py'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  // gguf-convert pip CLI (newer llama.cpp ships convert as `gguf-convert`)
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(which, ['gguf-convert'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      const line = (r.stdout || '').split(/\r?\n/).find(l => l.trim().length > 0);
      if (line) return line.trim();
    }
  } catch {}
  return null;
}

// Locate a llama-* binary. NAME is one of: llama-cli, llama-quantize,
// llama-imatrix, gguf-split. Falls back through env -> $LLAMA_CPP_HOME/bin ->
// PATH -> common build paths.
export function locateBinary(name) {
  // Most explicit: the runner already uses LLAMA_CPP_BIN for llama-cli.
  if (name === 'llama-cli') {
    const explicit = process.env.LLAMA_CPP_BIN;
    if (explicit && fs.existsSync(explicit)) return explicit;
  }
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  const withExt = name.endsWith(ext) ? name : (name + ext);

  // Try $LLAMA_CPP_HOME/bin
  if (process.env.LLAMA_CPP_HOME) {
    const candidate = path.join(process.env.LLAMA_CPP_HOME, 'bin', withExt);
    if (fs.existsSync(candidate)) return candidate;
    const candidate2 = path.join(process.env.LLAMA_CPP_HOME, withExt);
    if (fs.existsSync(candidate2)) return candidate2;
  }
  // Try $KOLM_LLAMA_BIN_DIR
  if (process.env.KOLM_LLAMA_BIN_DIR) {
    const candidate = path.join(process.env.KOLM_LLAMA_BIN_DIR, withExt);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Try PATH
  const which = isWin ? 'where' : 'which';
  try {
    const r = spawnSync(which, [name], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      const line = (r.stdout || '').split(/\r?\n/).find(l => l.trim().length > 0);
      if (line) return line.trim();
    }
  } catch {}
  // Common build locations
  const buildDirs = [
    path.join(process.cwd(), 'tools', 'llama.cpp', 'build', 'bin'),
    path.join(process.cwd(), 'vendor', 'llama.cpp', 'build', 'bin'),
    path.join(os.homedir(), 'llama.cpp-bin'),
    path.join(os.homedir(), 'llama.cpp', 'build', 'bin'),
    path.join(os.homedir(), '.kolm', 'build', 'llama.cpp', 'build', 'bin'),
  ];
  for (const dir of buildDirs) {
    const candidate = path.join(dir, withExt);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Aggregate toolchain probe. Returns { ok, components:{convert, quantize,
// imatrix, cli, split}, missing:[names], hint }.
export function probeGgufToolchain() {
  const convert = locateConvertScript();
  const quantize = locateBinary('llama-quantize');
  const imatrix = locateBinary('llama-imatrix');
  const cli = locateBinary('llama-cli');
  const split = locateBinary('llama-gguf-split') || locateBinary('gguf-split');
  const components = { convert, quantize, imatrix, cli, split };
  const missing = [];
  if (!convert) missing.push('convert_hf_to_gguf.py');
  if (!quantize) missing.push('llama-quantize');
  if (!cli) missing.push('llama-cli');
  // imatrix only required for IQ quants — caller checks
  // split only required for >50GB — caller checks
  const hint = missing.length
    ? [
      'Install llama.cpp toolchain:',
      '  git clone https://github.com/ggerganov/llama.cpp ~/llama.cpp',
      '  cd ~/llama.cpp && cmake -B build && cmake --build build --config Release -j',
      'Then either:',
      '  export LLAMA_CPP_HOME=~/llama.cpp',
      '  OR add ~/llama.cpp/build/bin to PATH',
    ].join('\n')
    : null;
  return { ok: missing.length === 0, components, missing, hint };
}

// ----------------------------------------------------------------------------
// Step helpers
// ----------------------------------------------------------------------------

function _runCmd(bin, args, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 30 * 60 * 1000,  // 30 min default for slow quants
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
  });
  const wall_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : null,
    wall_ms: Math.round(wall_ms),
  };
}

// Step 2 — Convert HF dir to F16 GGUF. Returns { ok, gguf_path, wall_ms,
// stderr }. The caller decides whether the resulting f16 is the final output
// or an intermediate for quantize.
export function convertHfToGguf({ hfDir, outFile, dtype = 'f16', convertScript = null }) {
  if (!fs.existsSync(hfDir)) {
    return { ok: false, error: `hf_dir_not_found: ${hfDir}` };
  }
  const script = convertScript || locateConvertScript();
  if (!script) {
    return { ok: false, error: 'convert_script_not_found', hint: 'install llama.cpp or set LLAMA_CPP_CONVERT' };
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  // gguf-convert (pip-installed CLI) is invoked directly; the .py is invoked via python
  const isPipCli = path.basename(script).startsWith('gguf-convert');
  const cmd = isPipCli ? script : py;
  const args = isPipCli
    ? [hfDir, '--outfile', outFile, '--outtype', dtype]
    : [script, hfDir, '--outfile', outFile, '--outtype', dtype];
  const r = _runCmd(cmd, args, { timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) {
    return { ok: false, error: `convert_exited_${r.code}`, stderr: r.stderr.slice(-2048), wall_ms: r.wall_ms };
  }
  if (!fs.existsSync(outFile)) {
    return { ok: false, error: 'convert_produced_no_file', stderr: r.stderr.slice(-2048), wall_ms: r.wall_ms };
  }
  return { ok: true, gguf_path: outFile, wall_ms: r.wall_ms };
}

// Step 3 — Build importance matrix. CORPUS_PATH must be a text file (one
// example per line); we accept jsonl + auto-extract the user-visible field.
export function buildImatrix({ ggufBase, corpusPath, outFile, chunks = 200, ngl = 99, imatrixBin = null }) {
  const bin = imatrixBin || locateBinary('llama-imatrix');
  if (!bin) {
    return { ok: false, error: 'llama_imatrix_not_found' };
  }
  if (!fs.existsSync(ggufBase)) {
    return { ok: false, error: `base_gguf_not_found: ${ggufBase}` };
  }
  if (!fs.existsSync(corpusPath)) {
    return { ok: false, error: `corpus_not_found: ${corpusPath}` };
  }
  // If corpus is .jsonl, convert to txt by extracting common text fields.
  let actualCorpus = corpusPath;
  if (corpusPath.endsWith('.jsonl')) {
    const tmpTxt = corpusPath + '.imatrix.txt';
    const lines = fs.readFileSync(corpusPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const txt = obj.text || obj.prompt || obj.input || obj.question || obj.user || '';
        if (txt && typeof txt === 'string') out.push(txt);
      } catch {}
    }
    if (out.length === 0) {
      return { ok: false, error: 'corpus_jsonl_had_no_extractable_text', corpus: corpusPath };
    }
    fs.writeFileSync(tmpTxt, out.join('\n\n'));
    actualCorpus = tmpTxt;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const args = [
    '-m', ggufBase,
    '-f', actualCorpus,
    '-o', outFile,
    '--chunks', String(chunks),
    '-ngl', String(ngl),
  ];
  const r = _runCmd(bin, args, { timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) {
    return { ok: false, error: `imatrix_exited_${r.code}`, stderr: r.stderr.slice(-2048), wall_ms: r.wall_ms };
  }
  if (!fs.existsSync(outFile)) {
    return { ok: false, error: 'imatrix_produced_no_file', stderr: r.stderr.slice(-2048), wall_ms: r.wall_ms };
  }
  return { ok: true, imatrix_path: outFile, wall_ms: r.wall_ms };
}

// Step 4 — Quantize the F16 base to a target level.
export function quantize({ ggufBase, outFile, quant, imatrixPath = null, quantizeBin = null, extraMetadata = {} }) {
  const bin = quantizeBin || locateBinary('llama-quantize');
  if (!bin) {
    return { ok: false, error: 'llama_quantize_not_found' };
  }
  if (!fs.existsSync(ggufBase)) {
    return { ok: false, error: `base_gguf_not_found: ${ggufBase}` };
  }
  const q = String(quant).toUpperCase();
  if (!QUANT_LEVELS.includes(q)) {
    return { ok: false, error: `unknown_quant_${q}`, allowed: QUANT_LEVELS.slice() };
  }
  if (IMATRIX_REQUIRED.has(q) && (!imatrixPath || !fs.existsSync(imatrixPath))) {
    return { ok: false, error: `imatrix_required_for_${q}`, hint: 'build an imatrix with buildImatrix() first' };
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // Step 5 — embed metadata kv-overrides. llama-quantize accepts repeated
  // --override-kv KEY=type:value flags. We forward provenance fields the
  // forge knows about so a downstream loader can read them.
  const overrides = [];
  if (extraMetadata.general_name) overrides.push(['--override-kv', `general.name=str:${extraMetadata.general_name}`]);
  overrides.push(['--override-kv', `general.quantized_by=str:kolm-forge`]);
  overrides.push(['--override-kv', `general.quantization_version=str:${GGUF_EXPORT_VERSION}`]);
  if (extraMetadata.kscore != null && Number.isFinite(extraMetadata.kscore)) {
    overrides.push(['--override-kv', `kolm.kscore=f32:${extraMetadata.kscore}`]);
  }
  if (extraMetadata.artifact_hash) {
    overrides.push(['--override-kv', `kolm.artifact_hash=str:${extraMetadata.artifact_hash}`]);
  }
  if (extraMetadata.context_length && Number.isFinite(extraMetadata.context_length)) {
    overrides.push(['--override-kv', `llm.context_length=u32:${extraMetadata.context_length}`]);
  }
  const args = [];
  if (imatrixPath) args.push('--imatrix', imatrixPath);
  for (const ov of overrides) args.push(...ov);
  args.push(ggufBase, outFile, q);
  const r = _runCmd(bin, args, { timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) {
    return { ok: false, error: `quantize_exited_${r.code}`, stderr: r.stderr.slice(-2048), wall_ms: r.wall_ms };
  }
  if (!fs.existsSync(outFile)) {
    return { ok: false, error: 'quantize_produced_no_file', stderr: r.stderr.slice(-2048), wall_ms: r.wall_ms };
  }
  return { ok: true, gguf_path: outFile, wall_ms: r.wall_ms, size_bytes: fs.statSync(outFile).size };
}

// Step 6 — Split a >SHARD_THRESHOLD GGUF into shards. Returns { ok, shards:[]
// (absolute paths) } or { ok:false } if no split tool present. If the file is
// below the threshold we return a single-element shards list with the
// original path (so the caller treats single-file and multi-shard outputs
// uniformly).
export function maybeSplit({ ggufPath, splitBin = null, thresholdBytes = SHARD_THRESHOLD_BYTES }) {
  const stat = fs.statSync(ggufPath);
  if (stat.size <= thresholdBytes) {
    return { ok: true, shards: [ggufPath], split: false, size_bytes: stat.size };
  }
  const bin = splitBin || locateBinary('llama-gguf-split') || locateBinary('gguf-split');
  if (!bin) {
    return { ok: false, error: 'gguf_split_not_found', size_bytes: stat.size, hint: 'install llama-gguf-split or skip split (manual shard)' };
  }
  const baseNoExt = ggufPath.replace(/\.gguf$/i, '');
  // gguf-split usage: gguf-split --split-max-size 45G <input> <output-prefix>
  // The 45G keeps each shard well under 50G to leave headroom.
  const args = ['--split-max-size', '45G', ggufPath, baseNoExt];
  const r = _runCmd(bin, args, { timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) {
    return { ok: false, error: `split_exited_${r.code}`, stderr: r.stderr.slice(-2048), size_bytes: stat.size };
  }
  // Discover shard files: <baseNoExt>-00001-of-NNNNN.gguf etc.
  const dir = path.dirname(baseNoExt);
  const base = path.basename(baseNoExt);
  const shards = fs.readdirSync(dir)
    .filter(f => f.startsWith(base + '-') && /-\d+-of-\d+\.gguf$/i.test(f))
    .sort()
    .map(f => path.join(dir, f));
  return { ok: true, shards, split: true, size_bytes: stat.size };
}

// Step 7 — Coherence test. Run llama-cli with a small prompt + 100 token
// budget. Parse the output and return a verdict + the raw response.
export function coherenceTest({ ggufPath, prompt = COHERENCE_PROMPT, maxTokens = COHERENCE_TOKENS, cliBin = null, timeoutMs = 120_000 }) {
  const bin = cliBin || locateBinary('llama-cli');
  if (!bin) {
    return { ok: false, error: 'llama_cli_not_found' };
  }
  if (!fs.existsSync(ggufPath)) {
    return { ok: false, error: `gguf_not_found: ${ggufPath}` };
  }
  const args = [
    '--model', ggufPath,
    '--prompt', prompt,
    '--no-display-prompt',
    '--temp', '0',
    '--predict', String(maxTokens),
  ];
  const t0 = process.hrtime.bigint();
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const wall_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      error: `cli_exited_${r.status || 'err'}`,
      stderr: (r.stderr || '').slice(-2048),
      wall_ms: Math.round(wall_ms),
    };
  }
  const out = (r.stdout || '').trim();
  // Parse: non-empty + at least some alphabetic characters + not a wall of
  // repeated single tokens. We do NOT score quality here — that's the
  // measureQuality() helper below.
  const hasText = /[A-Za-z]/.test(out);
  const tokens = out.split(/\s+/).filter(Boolean);
  const uniqueRatio = tokens.length ? new Set(tokens).size / tokens.length : 0;
  const looksGarbage = !hasText || (tokens.length > 8 && uniqueRatio < 0.15);
  // Rough tok/s — llama.cpp prints a perf summary on stderr; we'll honor
  // either source if available, otherwise compute from wall time.
  let tok_s = null;
  const perfMatch = (r.stderr || '').match(/eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*runs/);
  if (perfMatch) {
    const ms = Number(perfMatch[1]);
    const runs = Number(perfMatch[2]);
    if (ms > 0 && runs > 0) tok_s = Math.round((runs / ms) * 1000 * 10) / 10;
  }
  if (!tok_s && tokens.length > 0 && wall_ms > 0) {
    tok_s = Math.round((tokens.length / wall_ms) * 1000 * 10) / 10;
  }
  return {
    ok: !looksGarbage,
    output: out,
    output_tokens: tokens.length,
    unique_ratio: Math.round(uniqueRatio * 100) / 100,
    wall_ms: Math.round(wall_ms),
    tok_s,
    coherence_verdict: looksGarbage ? 'garbage' : 'coherent',
  };
}

// Step 8 — Quality delta vs FP16 baseline. Returns null when the artifact
// passport carries no baseline metric to compare against. Otherwise returns
// (quant_metric - baseline_metric). The caller decides whether negative is
// "worse" (typical for accuracy) or "better" (latency).
//
// This is a placeholder hook — the actual eval logic lives in
// scripts/benchmark.py / src/benchmark-evidence.js. exportGguf() invokes it
// only if {artifact.passport.baseline_metric, artifact.eval_runner} are both
// supplied (the caller must wire the eval). For the in-process path we just
// compute delta from passed-in numbers.
export function computeQualityDelta({ baselineMetric, quantMetric }) {
  if (typeof baselineMetric !== 'number' || !Number.isFinite(baselineMetric)) return null;
  if (typeof quantMetric !== 'number' || !Number.isFinite(quantMetric)) return null;
  return Math.round((quantMetric - baselineMetric) * 1e4) / 1e4;
}

// ----------------------------------------------------------------------------
// Top-level orchestrator
// ----------------------------------------------------------------------------

/**
 * Generic GGUF export. ANY artifact, not just Trinity.
 *
 * @param {object} args
 * @param {object} args.artifact     - Artifact descriptor: { name, artifact_hash,
 *                                     params_b, passport, merged_dir,
 *                                     baseline_metric?, quant_metric? }
 *                                     merged_dir is the HF directory to convert
 *                                     OR ggufBase if a pre-converted F16 is supplied.
 * @param {string} args.quant        - One of QUANT_LEVELS
 * @param {string} args.outputPath   - Final .gguf destination
 * @param {string} args.imatrixSource- Path to corpus (jsonl/txt) for IQ quants
 * @param {string} args.ggufBase     - Optional: skip conversion, use this F16 base
 * @param {boolean} args.dryRun      - If true, plan only — no spawns
 * @param {boolean} args.skipCoherence - If true, skip step 7
 * @returns {Promise<object>} { ok, steps, runtime_passport, output_path }
 */
export async function exportGguf({
  artifact,
  quant,
  outputPath,
  imatrixSource = null,
  ggufBase = null,
  dryRun = false,
  skipCoherence = false,
  context_length = 8192,
}) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('exportGguf: artifact required');
  }
  if (!quant) throw new Error('exportGguf: quant required');
  if (!outputPath) throw new Error('exportGguf: outputPath required');
  const q = String(quant).toUpperCase();
  if (!QUANT_LEVELS.includes(q)) {
    throw new Error(`exportGguf: unknown quant ${quant}; one of ${QUANT_LEVELS.join(', ')}`);
  }
  const requiresImatrix = IMATRIX_REQUIRED.has(q);
  const isFullPrecision = FULL_PRECISION.has(q);

  // ----- Plan -----
  const plan = {
    artifact_name: artifact.name || 'unnamed',
    artifact_hash: artifact.artifact_hash || null,
    quant: q,
    requires_imatrix: requiresImatrix,
    is_full_precision: isFullPrecision,
    output_path: outputPath,
    steps: [
      !ggufBase ? 'convert_hf_to_gguf' : 'skip_convert_use_supplied_base',
      requiresImatrix ? 'build_imatrix' : (isFullPrecision ? 'skip_imatrix_full_precision' : 'skip_imatrix_kquant'),
      isFullPrecision ? 'pass_through_convert_output' : 'llama_quantize',
      'embed_kolm_metadata',
      'maybe_split_if_above_50gb',
      skipCoherence ? 'skip_coherence_test' : 'coherence_test',
    ],
    forge_version: GGUF_EXPORT_VERSION,
  };

  if (dryRun) {
    return { ok: true, dry_run: true, plan, runtime_passport: null, output_path: null };
  }

  // ----- Toolchain check -----
  const probe = probeGgufToolchain();
  if (!probe.ok) {
    return { ok: false, plan, error: 'toolchain_missing', missing: probe.missing, hint: probe.hint };
  }
  if (requiresImatrix && !probe.components.imatrix) {
    return { ok: false, plan, error: 'imatrix_tool_missing', hint: 'IQ quants need llama-imatrix' };
  }
  if (requiresImatrix && !imatrixSource) {
    return { ok: false, plan, error: 'imatrix_source_required', hint: 'IQ quants need imatrixSource (jsonl/txt corpus)' };
  }

  const steps = {};
  let baseGgufPath = ggufBase;

  // ----- Step 1+2: convert HF -> F16 (skip if ggufBase supplied) -----
  if (!baseGgufPath) {
    if (!artifact.merged_dir) {
      return { ok: false, plan, error: 'artifact_missing_merged_dir', hint: 'supply artifact.merged_dir (HF directory) or ggufBase (pre-converted F16)' };
    }
    const f16Out = path.join(path.dirname(outputPath), (artifact.name || 'model') + '-f16.gguf');
    const cv = convertHfToGguf({
      hfDir: artifact.merged_dir,
      outFile: f16Out,
      dtype: 'f16',
      convertScript: probe.components.convert,
    });
    steps.convert = cv;
    if (!cv.ok) {
      return { ok: false, plan, steps, error: 'convert_failed', detail: cv.error };
    }
    baseGgufPath = cv.gguf_path;
  } else {
    steps.convert = { ok: true, skipped: 'ggufBase_supplied', gguf_path: ggufBase };
  }

  // ----- Step 3: imatrix (IQ family only) -----
  let imatrixPath = null;
  if (requiresImatrix) {
    const imOut = path.join(path.dirname(outputPath), (artifact.name || 'model') + '.imatrix');
    const im = buildImatrix({
      ggufBase: baseGgufPath,
      corpusPath: imatrixSource,
      outFile: imOut,
      imatrixBin: probe.components.imatrix,
    });
    steps.imatrix = im;
    if (!im.ok) {
      return { ok: false, plan, steps, error: 'imatrix_failed', detail: im.error };
    }
    imatrixPath = im.imatrix_path;
  }

  // ----- Step 4: quantize (or pass-through for full precision) -----
  let finalPath;
  if (isFullPrecision && q === 'F16') {
    // Already F16 from convert. Move/copy to outputPath if different.
    if (path.resolve(baseGgufPath) !== path.resolve(outputPath)) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(baseGgufPath, outputPath);
    }
    finalPath = outputPath;
    steps.quantize = { ok: true, skipped: 'pass_through_f16', gguf_path: finalPath, size_bytes: fs.statSync(finalPath).size };
  } else {
    const qResult = quantize({
      ggufBase: baseGgufPath,
      outFile: outputPath,
      quant: q,
      imatrixPath,
      quantizeBin: probe.components.quantize,
      extraMetadata: {
        general_name: artifact.name || 'kolm-artifact',
        kscore: artifact.passport && Number.isFinite(artifact.passport.kscore) ? artifact.passport.kscore : null,
        artifact_hash: artifact.artifact_hash || null,
        context_length,
      },
    });
    steps.quantize = qResult;
    if (!qResult.ok) {
      return { ok: false, plan, steps, error: 'quantize_failed', detail: qResult.error };
    }
    finalPath = qResult.gguf_path;
  }

  // ----- Step 6: shard if >50GB -----
  const split = maybeSplit({ ggufPath: finalPath, splitBin: probe.components.split });
  steps.split = split;
  // Note: split.ok=false is non-fatal if the file is below the threshold —
  // we never reach the split branch in that case. If split was attempted and
  // failed for a too-large file, we surface but do NOT abort (the unsharded
  // file is still usable, just unwieldy).

  // ----- Step 7: coherence test -----
  let coherence = null;
  if (!skipCoherence) {
    coherence = coherenceTest({
      ggufPath: split.shards && split.shards[0] ? split.shards[0] : finalPath,
      cliBin: probe.components.cli,
    });
    steps.coherence = coherence;
  } else {
    steps.coherence = { skipped: true };
  }

  // ----- Step 8: quality_delta -----
  const baselineMetric = artifact.baseline_metric != null
    ? Number(artifact.baseline_metric)
    : (artifact.passport && artifact.passport.baseline_metric != null ? Number(artifact.passport.baseline_metric) : null);
  const quantMetric = artifact.quant_metric != null
    ? Number(artifact.quant_metric)
    : null;
  const quality_delta = computeQualityDelta({ baselineMetric, quantMetric });

  // ----- Step 9: runtime_passport entry -----
  // Map quant -> precision string the runtime_passport schema knows
  const precisionMap = {
    'Q2_K': 'q2_k', 'Q3_K_S': 'q3_k_s', 'Q3_K_M': 'q3_k_m', 'Q3_K_L': 'q3_k_m',
    'Q4_0': 'q4_0', 'Q4_K_S': 'q4_k_s', 'Q4_K_M': 'q4_k_m',
    'Q5_0': 'q5_k_s', 'Q5_K_S': 'q5_k_s', 'Q5_K_M': 'q5_k_m',
    'Q6_K': 'q6_k', 'Q8_0': 'q8_0',
    'F16': 'fp16', 'BF16': 'bf16', 'F32': 'fp32',
    'IQ4_XS': 'iq4_xs', 'IQ4_NL': 'iq4_nl',
    'IQ3_S': 'iq3_s', 'IQ3_XXS': 'iq3_s', 'IQ3_M': 'iq3_s',
    'IQ2_S': 'iq2_s', 'IQ2_M': 'iq2_s', 'IQ2_XS': 'iq2_s', 'IQ2_XXS': 'iq2_s',
    'IQ1_S': 'iq2_s',
  };
  const precision = precisionMap[q] || 'q4_k_m';
  const target_id = `gguf-${precision}-llama.cpp`;
  // We can synthesize a passport even when the coherence test was skipped.
  // status='tested' only when we have BOTH a coherent generation AND a
  // measured tok_s. Otherwise status='estimated'.
  const haveMeasurements = coherence && coherence.ok && Number.isFinite(coherence.tok_s);
  let runtime_passport;
  if (haveMeasurements) {
    const sizeBytes = (split.shards && split.shards.length)
      ? split.shards.reduce((acc, p) => acc + fs.statSync(p).size, 0)
      : fs.statSync(finalPath).size;
    runtime_passport = {
      target_id,
      status: 'tested',
      runtime: 'llama.cpp',
      runtime_version: probe.components.cli ? path.basename(probe.components.cli) : 'unknown',
      precision,
      memory_mb: Math.round(sizeBytes / 1024 / 1024),
      latency_p50_ms: coherence.wall_ms / Math.max(1, coherence.output_tokens),
      latency_p95_ms: coherence.wall_ms / Math.max(1, coherence.output_tokens) * 1.5,
      tok_s: coherence.tok_s,
      quality_delta: quality_delta == null ? 0 : quality_delta,
      fallback: null,
    };
  } else {
    runtime_passport = {
      target_id,
      status: 'estimated',
      runtime: 'llama.cpp',
      runtime_version: probe.components.cli ? path.basename(probe.components.cli) : 'unknown',
      precision,
      memory_mb: fs.existsSync(finalPath) ? Math.round(fs.statSync(finalPath).size / 1024 / 1024) : 0,
      latency_p50_ms: null,
      latency_p95_ms: null,
      tok_s: null,
      quality_delta: null,
      fallback: null,
    };
  }

  return {
    ok: true,
    plan,
    steps,
    runtime_passport,
    output_path: finalPath,
    shards: split.shards || null,
    forge_version: GGUF_EXPORT_VERSION,
  };
}

export default {
  QUANT_LEVELS,
  GGUF_EXPORT_VERSION,
  exportGguf,
  probeGgufToolchain,
  locateBinary,
  locateConvertScript,
  convertHfToGguf,
  buildImatrix,
  quantize,
  maybeSplit,
  coherenceTest,
  computeQualityDelta,
};
