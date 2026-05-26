#!/usr/bin/env node
'use strict';

// scripts/compile-cloud.cjs — wave3-s8 cloud compile scaffold.
//
// Purpose
//   Drive a Modal-hosted GPU runner to quantize / compile a model when the
//   user has no local CUDA box (or wants something larger than fits in 24 GB).
//   This script is the Node-side entry point invoked by `kolm compile --cloud
//   modal ...` (CLI wiring is a follow-up — see docs/cloud-compile.md).
//
// What this script does
//   1. Parses --model, --quant, --out, --gpu, --dry-run, --help, --json.
//   2. Resolves the Modal companion script (scripts/compile-cloud-modal.py).
//   3. Verifies the `modal` CLI is installed (`modal --version`). If missing,
//      emits a doctor-style hint and exits with code 3 (the doctor exit code
//      kolm reserves for "tool missing / not configured").
//   4. Verifies a Modal token is available (env or ~/.modal.toml). If absent,
//      emits the same exit code 3 with a `modal token new` hint.
//   5. Builds the `modal run` invocation (does NOT execute it unless --run is
//      passed AND both prior checks passed). V1 is a ready-to-fire scaffold:
//      print the command, exit 0, let the user invoke it manually OR pass
//      --run to spawn it.
//
// Caveats / Limitations
//   - This script does not bill or meter; Modal bills the caller directly.
//   - No artifact stitch-back. The Modal function uploads to a modal.Volume;
//      pulling the resulting .gguf locally is a follow-up wave (we will likely
//      shell `modal volume get kolm-compile-out <remote> <local>`).
//   - No retry / resume. If Modal cold-start times out the user re-runs.
//   - Live invocation requires `pip install modal` and `modal token new` first.
//
// Exit codes
//   0  ok (dry-run printed, or live run completed cleanly)
//   1  bad usage (missing required flag, unknown flag value, etc.)
//   2  Modal subprocess failed (only reachable with --run)
//   3  doctor exit — modal CLI not installed OR token not configured
//
// This file has zero runtime dependencies beyond Node 20 stdlib.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MODAL_PY = path.join(ROOT, 'scripts', 'compile-cloud-modal.py');

const KNOWN_QUANTS = new Set([
  'nf4-int4',
  'int4',
  'int8',
  'fp8',
  'gguf-q4_k_m',
  'gguf-q5_k_m',
  'gguf-q8_0',
]);

const DEFAULT_GPU = 'A100';
const KNOWN_GPUS = new Set(['A100', 'A100-80GB', 'H100', 'L4', 'T4', 'A10G']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    model: '',
    quant: 'nf4-int4',
    out: '',
    gpu: DEFAULT_GPU,
    dryRun: true, // V1 default: print the command, do not spawn.
    run: false,
    help: false,
    json: false,
    unknown: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--run') {
      out.run = true;
      out.dryRun = false;
    } else if (a === '--dry-run') {
      out.dryRun = true;
      out.run = false;
    } else if (a === '--model') {
      out.model = args[i + 1] || '';
      i += 1;
    } else if (a.startsWith('--model=')) {
      out.model = a.slice('--model='.length);
    } else if (a === '--quant') {
      out.quant = args[i + 1] || '';
      i += 1;
    } else if (a.startsWith('--quant=')) {
      out.quant = a.slice('--quant='.length);
    } else if (a === '--out') {
      out.out = args[i + 1] || '';
      i += 1;
    } else if (a.startsWith('--out=')) {
      out.out = a.slice('--out='.length);
    } else if (a === '--gpu') {
      out.gpu = args[i + 1] || DEFAULT_GPU;
      i += 1;
    } else if (a.startsWith('--gpu=')) {
      out.gpu = a.slice('--gpu='.length);
    } else if (a === '--cloud') {
      // Tolerated for CLI parity; only "modal" is valid in this script.
      const v = (args[i + 1] || '').toLowerCase();
      if (v && v !== 'modal') out.unknown.push(`--cloud ${v} (this script only supports modal)`);
      i += 1;
    } else {
      out.unknown.push(a);
    }
  }
  return out;
}

function helpText() {
  return [
    'kolm compile-cloud (modal) — scaffold for cloud GPU quantize',
    '',
    'Usage:',
    '  node scripts/compile-cloud.cjs --model <hf-id> --quant <profile> --out <local-path> [flags]',
    '',
    'Required:',
    '  --model <id>     HuggingFace model id (e.g. deepseek-ai/DeepSeek-R1-Distill-Qwen-32B)',
    '',
    'Optional:',
    '  --quant <p>      Quant profile. Default: nf4-int4.',
    `                   One of: ${[...KNOWN_QUANTS].join(', ')}`,
    '  --out <path>     Local destination for the pulled artifact (stitch-back is a follow-up)',
    `  --gpu <type>     Modal GPU class. Default: ${DEFAULT_GPU}. One of: ${[...KNOWN_GPUS].join(', ')}`,
    '  --dry-run        Print the modal command; do NOT spawn. (default)',
    '  --run            Actually invoke `modal run` against scripts/compile-cloud-modal.py',
    '  --json           Emit JSON instead of human-formatted output',
    '  --help, -h       Show this message',
    '',
    'Caveats:',
    '  - Live cloud compile requires `pip install modal` and `modal token new` first.',
    '  - This V1 scaffold prints the modal command by default; pass --run to fire it.',
    '  - Modal bills the caller directly. See docs/cloud-compile.md for cost notes.',
    '  - Artifact pull-back is a follow-up; the Modal function writes to a modal.Volume.',
    '',
    'Exit codes:',
    '  0  ok        2  modal subprocess failed (only with --run)',
    '  1  usage     3  doctor exit — modal CLI missing or token unconfigured',
  ].join('\n');
}

function emit(opts, payload) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    if (payload.message) process.stdout.write(payload.message + '\n');
    if (payload.hint) process.stdout.write(payload.hint + '\n');
    if (payload.command) process.stdout.write('\n$ ' + payload.command + '\n');
  }
}

function modalInstalled() {
  // `modal --version` exits 0 if installed. We do NOT shell-out unless we can.
  const r = spawnSync('modal', ['--version'], { encoding: 'utf8', shell: true });
  if (r.error || r.status !== 0) {
    return { ok: false, version: null };
  }
  return { ok: true, version: (r.stdout || r.stderr || '').trim() };
}

function modalTokenConfigured() {
  // Modal accepts either env vars (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) OR
  // a `~/.modal.toml` written by `modal token new`. We check both without
  // reading the secret value.
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    return { ok: true, source: 'env' };
  }
  const candidates = [
    path.join(os.homedir() || '', '.modal.toml'),
    path.join(process.env.USERPROFILE || '', '.modal.toml'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { ok: true, source: p };
  }
  return { ok: false, source: null };
}

function buildModalCommand(opts) {
  // `modal run` syntax: modal run <file>::<function> --arg=value
  // The companion script exposes a function named `quantize_and_upload`.
  const args = [
    'run',
    `${MODAL_PY}::quantize_and_upload`,
    `--model=${opts.model}`,
    `--quant=${opts.quant}`,
    `--gpu=${opts.gpu}`,
  ];
  return { bin: 'modal', args };
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    process.stdout.write(helpText() + '\n');
    process.exit(0);
  }

  if (opts.unknown.length) {
    emit(opts, {
      ok: false,
      error: 'unknown_args',
      message: `unknown arguments: ${opts.unknown.join(', ')}`,
      hint: 'see --help',
    });
    process.exit(1);
  }

  if (!opts.model) {
    emit(opts, {
      ok: false,
      error: 'missing_model',
      message: '--model is required (e.g. --model deepseek-ai/DeepSeek-R1-Distill-Qwen-32B)',
      hint: 'see --help',
    });
    process.exit(1);
  }

  if (opts.quant && !KNOWN_QUANTS.has(opts.quant)) {
    emit(opts, {
      ok: false,
      error: 'unknown_quant',
      message: `unknown --quant value: ${opts.quant}`,
      hint: `one of: ${[...KNOWN_QUANTS].join(', ')}`,
    });
    process.exit(1);
  }

  if (opts.gpu && !KNOWN_GPUS.has(opts.gpu)) {
    emit(opts, {
      ok: false,
      error: 'unknown_gpu',
      message: `unknown --gpu value: ${opts.gpu}`,
      hint: `one of: ${[...KNOWN_GPUS].join(', ')}`,
    });
    process.exit(1);
  }

  if (!fs.existsSync(MODAL_PY)) {
    emit(opts, {
      ok: false,
      error: 'missing_companion',
      message: `companion script not found at ${MODAL_PY}`,
      hint: 'this is a packaging bug — please file an issue',
    });
    process.exit(1);
  }

  const tool = modalInstalled();
  if (!tool.ok) {
    emit(opts, {
      ok: false,
      error: 'modal_not_installed',
      message: 'modal not installed; install with: pip install modal',
      hint: 'after install, run `modal token new` to configure credentials',
    });
    process.exit(3);
  }

  const token = modalTokenConfigured();
  if (!token.ok) {
    emit(opts, {
      ok: false,
      error: 'modal_token_missing',
      message: 'modal token not configured',
      hint: 'run: modal token new   (or set MODAL_TOKEN_ID + MODAL_TOKEN_SECRET env vars)',
      modal_version: tool.version,
    });
    process.exit(3);
  }

  const cmd = buildModalCommand(opts);
  const printable = `${cmd.bin} ${cmd.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;

  if (opts.dryRun) {
    emit(opts, {
      ok: true,
      mode: 'dry_run',
      model: opts.model,
      quant: opts.quant,
      gpu: opts.gpu,
      modal_version: tool.version,
      token_source: token.source,
      command: printable,
      message: 'dry-run — would invoke modal with the command below. Pass --run to fire it.',
    });
    process.exit(0);
  }

  // --run: actually spawn.
  emit(opts, {
    ok: true,
    mode: 'running',
    command: printable,
    message: 'spawning modal run …',
  });
  const r = spawnSync(cmd.bin, cmd.args, { stdio: 'inherit', shell: true });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    emit(opts, {
      ok: false,
      error: 'modal_subprocess_failed',
      exit: r.status,
      message: `modal exited with status ${r.status}`,
      hint: 'check Modal dashboard for logs',
    });
    process.exit(2);
  }
  process.exit(0);
}

// Allow this file to be required for shape-only lock-in without executing.
if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  helpText,
  modalInstalled,
  modalTokenConfigured,
  buildModalCommand,
  KNOWN_QUANTS,
  KNOWN_GPUS,
  DEFAULT_GPU,
};
