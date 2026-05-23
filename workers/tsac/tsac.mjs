#!/usr/bin/env node
// workers/tsac/tsac.mjs
//
// W721 — Task-Specific Attention Compiler (TSAC) — kernel-selector stub.
//
// THIS IS A STUB. The worker reads a validated TSAC profile (built by
// src/tsac-compiler.js or hand-authored against src/tsac-profile.js's
// schema) and emits a per-(layer,head) kernel-name selection table that
// a future serve-time kernel dispatcher will consume. Runtime kernel
// dispatch — actual CUDA / Metal / CPU sparse-attention kernels — is a
// FUTURE WAVE. This wave ships the compiler + profile schema + the
// CONTRACT that a real kernel lookup table will plug into.
//
// The selector logic itself is pure compute: it walks the profile entries
// and emits a stable kernel-name string per entry. The name encodes the
// (prefill_pattern, decode_policy) tuple so a downstream kernel registry
// can do an O(1) lookup. No model is loaded, no GPU is touched, no heavy
// Python deps are pulled into the root install.
//
// Modes:
//   --doctor                  print toolchain readiness + exit 0.
//   --profile <path>          path to a TSAC profile JSON file.
//   --task <name>             task name (must match profile.task when present).
//   --output <path>           write selected kernel names to this file
//                             (JSON object {entries:[...], summary:{...}}).
//   --json                    emit JSON envelope on stdout (default true).
//
// Python kernel-selector override:
//   $TSAC_KERNEL_CMD — override the script that performs the per-head
//                      kernel selection. Accepts either a single shell
//                      string (split on whitespace) OR a JSON array
//                      ['/usr/bin/python3', '/path/to/selector.py']. When
//                      present the worker hands the validated profile to
//                      that command via --profile and trusts its --output.
//   Default chain: $TSAC_KERNEL_CMD → python3 workers/tsac/scripts/tsac.py.
//
// EXIT CODES
//   0  selection wrote OK
//   2  bad args (missing --profile, malformed --output dir, etc.)
//   3  no python runtime AND no $TSAC_KERNEL_CMD override (honest envelope)
//   4  profile file not found / could not load / failed validateProfile
//   5  selector command failed (non-zero exit from python or override)
//
// HEAVY-DEPS BOUNDARY — TSAC's heavy lift is GPU-kernel territory. The
// root kolm install pulls ZERO TSAC deps. Optional future Python deps
// live in workers/tsac/scripts/. The shell here only requires Node.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

const WORKER_NAME    = 'kolm-tsac-worker';
const WORKER_VERSION = '0.1.0';

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  const report = await doctor();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

if (!args.profile) {
  emit({
    ok: false,
    error: 'missing_profile',
    hint: 'pass --profile <path-to-tsac-profile.json>',
  });
  process.exit(2);
}

const profilePath = path.resolve(process.cwd(), String(args.profile));
if (!fs.existsSync(profilePath)) {
  emit({
    ok: false,
    error: 'profile_not_found',
    profile: profilePath,
    hint: 'check the --profile path or run `kolm distill sparse-attention compile ...` first',
  });
  process.exit(4);
}

let profile;
try {
  profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
} catch (e) {
  emit({
    ok: false,
    error: 'profile_parse_failed',
    detail: String(e && e.message || e),
    profile: profilePath,
  });
  process.exit(4);
}

// Validate via the schema module. This shell refuses to dispatch a kernel
// selector against an invalid profile — the contract is the schema. On
// Windows the absolute path must be converted to a file:// URL before
// dynamic import; pathToFileURL handles that uniformly across platforms.
let validateProfile;
try {
  const schemaUrl = pathToFileURL(path.join(ROOT, 'src', 'tsac-profile.js')).href;
  ({ validateProfile } = await import(schemaUrl));
} catch (e) {
  emit({
    ok: false,
    error: 'schema_import_failed',
    detail: String(e && e.message || e),
    hint: 'workers/tsac/tsac.mjs requires src/tsac-profile.js — check repo layout',
  });
  process.exit(4);
}
const v = validateProfile(profile);
if (!v.ok) {
  emit({
    ok: false,
    error: 'profile_invalid',
    profile: profilePath,
    validation_errors: v.errors.slice(0, 20),
  });
  process.exit(4);
}

if (args.task && profile.task && profile.task !== args.task) {
  emit({
    ok: false,
    error: 'task_mismatch',
    expected_task: args.task,
    profile_task: profile.task,
  });
  process.exit(2);
}

// Resolve the python kernel selector. Priority: $TSAC_KERNEL_CMD env
// override (string or JSON array) → python3 workers/tsac/scripts/tsac.py.
const overrideCmd = process.env.TSAC_KERNEL_CMD;
let argv0 = 'python3';
let argv = [];
const defaultScript = path.join(__dirname, 'scripts', 'tsac.py');

if (overrideCmd && overrideCmd.length > 0) {
  // JSON array form first (lets tests inject [node, stubPath]).
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

// When using the override but no script path was injected, append the
// default script so e.g. $TSAC_KERNEL_CMD=python3 still resolves.
if (!overrideCmd) argv = [defaultScript];

// Build child argv: pass --profile + (optional) --output and --task through.
const childArgv = [...argv, '--profile', profilePath];
if (args.output) {
  const outPath = path.resolve(process.cwd(), String(args.output));
  // Pre-create the parent dir so the python child does not have to.
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
  } catch (_) { /* fall through to spawn */ }
  childArgv.push('--output', outPath);
}
if (args.task) childArgv.push('--task', String(args.task));

// Probe the launcher exists before spawning. Without this an absent
// python on Windows yields ENOENT with no actionable hint.
const launcherPath = resolveLauncher(argv0);
if (!launcherPath && !overrideCmd) {
  // Default path was python3 — try a couple more names before giving up.
  const fallback = process.platform === 'win32'
    ? ['python', 'py']
    : ['python'];
  let found = null;
  for (const cand of fallback) {
    if (resolveLauncher(cand)) { found = cand; break; }
  }
  if (!found) {
    emit({
      ok: false,
      error: 'no_kernel_runtime',
      hint: 'install Python 3.10+ or set TSAC_KERNEL_CMD to override',
    });
    process.exit(3);
  }
  argv0 = found;
}

if (overrideCmd && !launcherPath && !fs.existsSync(argv0)) {
  // Override was given but the binary does not exist on disk OR on PATH.
  emit({
    ok: false,
    error: 'no_kernel_runtime',
    detail: `TSAC_KERNEL_CMD launcher not found: ${argv0}`,
    hint: 'point TSAC_KERNEL_CMD at an existing executable',
  });
  process.exit(3);
}

const res = spawnSync(argv0, childArgv, {
  encoding: 'utf8',
  env: process.env,
  // shell:true on win32 so .cmd shims (e.g. py.cmd) work; stay shell:false
  // elsewhere so argv quoting is honest.
  shell: process.platform === 'win32',
});

if (res.error) {
  emit({
    ok: false,
    error: 'selector_spawn_failed',
    detail: String(res.error.message || res.error),
    hint: 'check that TSAC_KERNEL_CMD or python3 is on PATH',
  });
  process.exit(5);
}

if (res.status !== 0) {
  // Surface the child stderr as 'detail' so callers see why selection
  // failed without parsing a child JSON blob.
  emit({
    ok: false,
    error: 'selector_failed',
    exit_code: res.status,
    stderr: (res.stderr || '').slice(0, 4000),
    stdout: (res.stdout || '').slice(0, 1000),
  });
  process.exit(5);
}

emit({
  ok: true,
  worker: WORKER_NAME,
  worker_version: WORKER_VERSION,
  profile: profilePath,
  output: args.output ? path.resolve(process.cwd(), String(args.output)) : null,
  selector_argv0: argv0,
  selector_stdout: (res.stdout || '').trim(),
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
  for (let i = 0; i < argv.length; i++) {
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
  // Absolute path or relative path with a separator → existsSync check.
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try { return fs.existsSync(cmd) ? cmd : null; } catch { return null; }
  }
  // Bare name → walk PATH.
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
    spec: 'kolm-tsac-worker-doctor',
    worker: WORKER_NAME,
    worker_version: WORKER_VERSION,
    tsac_version: 'w721-v1',
    node_version: process.version,
  };
  const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { encoding: 'utf8' });
  out.python_ok = python.status === 0;
  out.python_version = python.status === 0 ? (python.stdout || python.stderr || '').trim() : null;
  out.script_present = fs.existsSync(path.join(__dirname, 'scripts', 'tsac.py'));
  out.tsac_kernel_cmd_set = !!process.env.TSAC_KERNEL_CMD;
  out.ready = (out.python_ok && out.script_present) || out.tsac_kernel_cmd_set;
  out.hint = out.ready
    ? null
    : 'install Python 3.10+ OR set $TSAC_KERNEL_CMD to point at an alternate kernel selector';
  return out;
}
