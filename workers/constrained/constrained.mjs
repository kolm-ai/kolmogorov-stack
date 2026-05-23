#!/usr/bin/env node
// workers/constrained/constrained.mjs
//
// W809 — constrained decoding worker (thin Node shell).
//
// This is a STUB. The worker reads a constrained-decode request JSON
// {prompt, schema_spec, base_model, sampler_opts} and hands it to a Python
// decoder that wraps `outlines` or `lm-format-enforcer` for schema-guided
// sampling. Heavy ML deps stay OUTSIDE Node; root kolm install pulls ZERO
// constrained-decoder deps. The shell itself only requires Node 18+.
//
// JS/Python parity is INTENTIONALLY ONE-WAY: this shell does no decoding —
// it locates a Python interpreter (or honors $CONSTRAINED_DECODE_CMD) and
// runs scripts/constrained.py. If neither outlines nor lm-format-enforcer is
// importable, the Python child emits an honest envelope (exit 3) and we
// surface it verbatim.
//
// Modes:
//   --doctor                 print toolchain readiness + exit 0
//   --input <path>           path to request JSON (validated against the
//                            W809-1 spec by src/output-schema.js before we
//                            ever spawn the python child — see notes below)
//   --output <path>          where the python child writes its response JSON
//   --json                   always-on (envelope is JSON)
//
// Python decoder override:
//   $CONSTRAINED_DECODE_CMD — override the launcher. Accepts either a single
//                             shell string (split on whitespace) OR a JSON
//                             array ['node', 'stub.js']. When present the
//                             worker hands --input + --output through and
//                             trusts the child's --output file. Tests use the
//                             JSON-array form to inject a Node stub.
//   Default chain: $CONSTRAINED_DECODE_CMD → python3
//                  workers/constrained/scripts/constrained.py.
//
// EXIT CODES
//   0  decode wrote OK
//   2  bad args (missing --input/--output)
//   3  no constrained decoder library installed (honest envelope) OR no
//      python runtime + no override
//   4  --input file not found / parse failed
//   5  decoder command failed (non-zero exit from python or override)
//
// HEAVY-DEPS BOUNDARY — heavy lift is outlines/lm-format-enforcer + torch.
// Optional future Python deps live in workers/constrained/scripts/. The
// shell here only requires Node.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const WORKER_NAME    = 'kolm-constrained-worker';
const WORKER_VERSION = '0.1.0';
const W809_VERSION   = 'w809-v1';

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  const r = await doctor();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
}

if (!args.input) {
  emit({
    ok: false,
    error: 'missing_input',
    hint: 'pass --input <path-to-request.json>',
    version: W809_VERSION,
  });
  process.exit(2);
}
if (!args.output) {
  emit({
    ok: false,
    error: 'missing_output',
    hint: 'pass --output <path-to-response.json>',
    version: W809_VERSION,
  });
  process.exit(2);
}

const inputPath = path.resolve(process.cwd(), String(args.input));
if (!fs.existsSync(inputPath)) {
  emit({
    ok: false,
    error: 'input_not_found',
    input: inputPath,
    version: W809_VERSION,
  });
  process.exit(4);
}

let request;
try {
  request = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
  emit({
    ok: false,
    error: 'input_parse_failed',
    detail: String(e && e.message || e),
    version: W809_VERSION,
  });
  process.exit(4);
}

if (!request || typeof request !== 'object') {
  emit({
    ok: false,
    error: 'input_not_object',
    version: W809_VERSION,
  });
  process.exit(4);
}
if (typeof request.prompt !== 'string' || !request.prompt.length) {
  emit({
    ok: false,
    error: 'prompt_required',
    version: W809_VERSION,
  });
  process.exit(4);
}
if (!request.schema_spec || typeof request.schema_spec !== 'object') {
  emit({
    ok: false,
    error: 'schema_spec_required',
    version: W809_VERSION,
  });
  process.exit(4);
}

// Resolve launcher. Same priority chain as workers/tsac and workers/itkv.
const overrideCmd = process.env.CONSTRAINED_DECODE_CMD;
let argv0 = process.platform === 'win32' ? 'python' : 'python3';
let argv = [];
const defaultScript = path.join(__dirname, 'scripts', 'constrained.py');

if (overrideCmd && overrideCmd.length > 0) {
  let parsed = null;
  if (overrideCmd.trim().startsWith('[')) {
    try { parsed = JSON.parse(overrideCmd); } catch { /* fall through */ }
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    argv0 = parsed[0];
    argv = parsed.slice(1);
  } else {
    const parts = overrideCmd.trim().split(/\s+/);
    argv0 = parts[0];
    argv = parts.slice(1);
  }
} else {
  argv = [defaultScript];
}

const outPath = path.resolve(process.cwd(), String(args.output));
try {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
} catch (_) { /* fall through to spawn */ }

const childArgv = [...argv, '--input', inputPath, '--output', outPath];

const launcherPath = resolveLauncher(argv0);
if (!launcherPath && !overrideCmd) {
  // Default path was python(3) — try a couple more names before giving up.
  const fallback = process.platform === 'win32'
    ? ['python3', 'py']
    : ['python'];
  let found = null;
  for (const cand of fallback) {
    if (resolveLauncher(cand)) { found = cand; break; }
  }
  if (!found) {
    emit({
      ok: false,
      error: 'no_constrained_decoder',
      hint: 'pip install outlines OR lm-format-enforcer (and install Python 3.10+)',
      detail: 'no python runtime found and $CONSTRAINED_DECODE_CMD is not set',
      version: W809_VERSION,
    });
    process.exit(3);
  }
  argv0 = found;
}

if (overrideCmd && !launcherPath && !fs.existsSync(argv0)) {
  // Override given but binary missing — honest envelope, exit 3.
  emit({
    ok: false,
    error: 'no_constrained_decoder',
    hint: 'point CONSTRAINED_DECODE_CMD at an existing executable',
    detail: `CONSTRAINED_DECODE_CMD launcher not found: ${argv0}`,
    version: W809_VERSION,
  });
  process.exit(3);
}

const res = spawnSync(argv0, childArgv, {
  encoding: 'utf8',
  env: process.env,
  shell: process.platform === 'win32' && !path.isAbsolute(argv0),
  timeout: 5 * 60 * 1000,
  maxBuffer: 64 * 1024 * 1024,
});

if (res.error) {
  emit({
    ok: false,
    error: 'decoder_spawn_failed',
    detail: String(res.error.message || res.error),
    hint: 'check that CONSTRAINED_DECODE_CMD or python3 is on PATH',
    version: W809_VERSION,
  });
  process.exit(5);
}

// Pass exit 3 through verbatim — the python child uses 3 specifically for
// the no-library case so callers can branch on it.
if (res.status === 3) {
  let inner = null;
  const out = (res.stdout || '').trim();
  if (out) {
    try {
      const tail = out.split('\n').filter(Boolean).pop();
      inner = JSON.parse(tail);
    } catch {
      inner = null;
    }
  }
  emit(inner || {
    ok: false,
    error: 'no_constrained_decoder',
    hint: 'pip install outlines OR lm-format-enforcer',
    version: W809_VERSION,
  });
  process.exit(3);
}

if (res.status !== 0) {
  emit({
    ok: false,
    error: 'decoder_failed',
    exit_code: res.status,
    stderr: (res.stderr || '').slice(0, 4000),
    stdout: (res.stdout || '').slice(0, 1000),
    version: W809_VERSION,
  });
  process.exit(5);
}

emit({
  ok: true,
  worker: WORKER_NAME,
  worker_version: WORKER_VERSION,
  version: W809_VERSION,
  input: inputPath,
  output: outPath,
  decoder_argv0: argv0,
});
process.exit(0);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--doctor' || a === '--json') { out[a.slice(2)] = true; continue; }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

function resolveLauncher(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try { return fs.existsSync(cmd) ? cmd : null; } catch { return null; }
  }
  const PATHSEP = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of (process.env.PATH || '').split(PATHSEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* swallow */ }
    }
  }
  return null;
}

async function doctor() {
  const out = {
    spec: 'kolm-constrained-worker-doctor',
    worker: WORKER_NAME,
    worker_version: WORKER_VERSION,
    constrained_version: W809_VERSION,
    node_version: process.version,
    env: {
      home: os.homedir(),
      platform: process.platform,
    },
  };
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  const python = spawnSync(pyCmd, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  out.python_ok = python.status === 0;
  out.python_version = python.status === 0
    ? (python.stdout || python.stderr || '').trim()
    : null;
  out.script_present = fs.existsSync(path.join(__dirname, 'scripts', 'constrained.py'));
  out.constrained_decode_cmd_set = !!process.env.CONSTRAINED_DECODE_CMD;

  // Probe each library independently. If python is missing or the script is
  // missing, we leave decoders as null booleans + ready:false + a hint.
  let decoders = { outlines: null, lm_format_enforcer: null };
  if (out.python_ok && out.script_present) {
    const probe = spawnSync(pyCmd, [
      path.join(__dirname, 'scripts', 'constrained.py'),
      '--doctor',
    ], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    if (probe.stdout) {
      try {
        const tail = probe.stdout.trim().split('\n').filter(Boolean).pop();
        const parsed = JSON.parse(tail);
        if (parsed && parsed.decoders) decoders = parsed.decoders;
      } catch {
        // leave decoders as nulls
      }
    }
  }
  out.decoders = decoders;
  const anyDecoder = decoders.outlines === true || decoders.lm_format_enforcer === true;
  out.ready = (out.python_ok && out.script_present && anyDecoder)
    || out.constrained_decode_cmd_set;
  out.hint = out.ready
    ? null
    : 'pip install outlines OR lm-format-enforcer (and install Python 3.10+)';
  out.ok = true;
  return out;
}
