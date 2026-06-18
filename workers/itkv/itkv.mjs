#!/usr/bin/env node
// workers/itkv/itkv.mjs
//
// W722 - thin Node shell for the ITKV tier selector.
//
// This file is a reference worker shell. Runtime KV cache tier dispatch is
// intentionally scoped to downstream runtimes; the production executor would
// plug into vLLM PagedAttention / SGLang radix cache and route prefix-cache
// hits according to the ITKV profile. What this shell ships today:
//
//   1. Locates a Python interpreter (priority: $ITKV_TIER_CMD env override
//      then python3 workers/itkv/scripts/itkv.py).
//   2. Spawns the Python script with --profile, --tokens, --output passed
//      straight through.
//   3. On missing runtime: honest envelope, exit 3 + {ok:false,
//      error:'no_tier_runtime', hint, ...}. NEVER silent fallthrough.
//
// JS/Python parity: workers/itkv/scripts/itkv.py is a verbatim port of
// src/itkv-profile.js classifyToken. If you must diverge, document the
// reason in the header of BOTH files.
//
// HEAVY-DEPS BOUNDARY: this worker has NO Node deps and a single Python
// dep (the stdlib argparse + json). Root kolm install stays light.
//
// CLI
//   --doctor                     print toolchain readiness, exit 0
//   --profile <path>             ITKV profile JSON (optional)
//   --tokens <path>              JSONL of token rows (required)
//   --output <path>              JSONL of classified rows (required)
//   --json                       always-on (envelope is JSON)
//
// EXIT CODES
//   0   ok - python classifier ran, output written
//   2   bad args
//   3   no python runtime (honest envelope, install_hint set)
//   5   python script crashed

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ITKV_WORKER_VERSION = 'w706-itkv-worker-shell-v1';
const ITKV_WORKER_CONTRACT_VERSION = 'w706-v1';
const ITKV_WORKER_LIMITS = Object.freeze({
  MAX_ARG_CHARS: 4096,
  MAX_RUNTIME_CMD_CHARS: 8192,
  MAX_RUNTIME_ARGS: 32,
  MAX_RUNTIME_ARG_CHARS: 2048,
  MAX_DETAIL_CHARS: 500,
  TIMEOUT_MS: 5 * 60 * 1000,
  MAX_BUFFER_BYTES: 16 * 1024 * 1024,
});

const args = parseArgs(process.argv.slice(2));

if (args._errors.length > 0) {
  process.stdout.write(JSON.stringify({
    ok: false,
    kind: 'itkv',
    error: 'bad_args',
    errors: args._errors,
    _exit_code: 2,
  }) + '\n');
  process.exit(2);
}

if (args.doctor) {
  const r = await doctor();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
}

try {
  const env = await main(args);
  process.stdout.write(JSON.stringify(env) + '\n');
  process.exit(envExitCode(env));
} catch (e) {
  const fail = {
    ok: false,
    kind: 'itkv',
    error: String((e && e.message) || e),
    error_stage: (e && e._stage) || 'unknown',
  };
  process.stdout.write(JSON.stringify(fail) + '\n');
  process.exit((e && e._exit) || 5);
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const a = { doctor: false, json: true, _errors: [] };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      a._errors.push({ flag, error: 'missing_value' });
      return [null, index];
    }
    if (String(value).length > ITKV_WORKER_LIMITS.MAX_ARG_CHARS || /[\x00-\x1f\x7f]/.test(String(value))) {
      a._errors.push({ flag, error: 'invalid_value' });
      return [null, index + 1];
    }
    return [value, index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--doctor') {
      a.doctor = true;
    } else if (k === '--profile') {
      const [v, next] = takeValue(k, i);
      a.profile = v;
      i = next;
    } else if (k === '--tokens') {
      const [v, next] = takeValue(k, i);
      a.tokens = v;
      i = next;
    } else if (k === '--output') {
      const [v, next] = takeValue(k, i);
      a.output = v;
      i = next;
    } else if (k === '--json') {
      a.json = true;
    } else {
      a._errors.push({ flag: cleanText(k, 80), error: 'unknown_arg' });
    }
  }
  return a;
}

function cleanText(value, max = ITKV_WORKER_LIMITS.MAX_DETAIL_CHARS) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function pathDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function fileError(code, filePath, extra = {}) {
  return {
    ok: false,
    kind: 'itkv',
    error: code,
    path_sha256: pathDigest(filePath),
    path_basename: path.basename(String(filePath || '')),
    ...extra,
    _exit_code: 2,
  };
}

function normalizePathArg(filePath, label, { mustExist = false, parentMustExist = false } = {}) {
  const raw = String(filePath || '');
  if (!raw || raw.length > ITKV_WORKER_LIMITS.MAX_ARG_CHARS || /[\x00-\x1f\x7f]/.test(raw)) {
    return { error: fileError(`invalid_${label}_path`, raw) };
  }
  const abs = path.resolve(raw);
  if (mustExist) {
    try {
      if (!fs.statSync(abs).isFile()) return { error: fileError(`${label}_file_not_found`, raw) };
    } catch {
      return { error: fileError(`${label}_file_not_found`, raw) };
    }
  }
  if (parentMustExist) {
    try {
      if (!fs.statSync(path.dirname(abs)).isDirectory()) return { error: fileError(`${label}_parent_not_found`, raw) };
    } catch {
      return { error: fileError(`${label}_parent_not_found`, raw) };
    }
  }
  return { path: abs };
}

function envExitCode(env) {
  if (env.ok) return 0;
  if (env._exit_code) return env._exit_code;
  if (env.error === 'no_tier_runtime') return 3;
  return 5;
}

// ---------- doctor ----------

async function doctor() {
  const found = locateRuntime();
  const r = {
    spec: 'kolm-itkv-tier-selector-doctor',
    version: ITKV_WORKER_VERSION,
    contract_version: ITKV_WORKER_CONTRACT_VERSION,
    wave: 'W722',
    kind: 'itkv-doctor',
    runtime: found
      ? { ok: true, cmd: found.cmd, args: found.args, source: found.source }
      : {
          ok: false,
          cmd: null,
          install_hint:
            'no python runtime wired. install one of: '
            + '(a) python3 on PATH (3.10+); '
            + '(b) set $ITKV_TIER_CMD to an executable accepting '
            + '--tokens <jsonl> --output <jsonl> [--profile <json>] '
            + '(JSON array form supported, e.g. ITKV_TIER_CMD=\'["node","stub.js"]\').',
        },
    env: {
      node: process.version,
      platform: process.platform,
      home_present: !!os.homedir(),
    },
    install_hint: null,
    ready: !!found,
    ok: true,
  };
  if (!found) {
    r.ok = false;
    r.install_hint = r.runtime.install_hint;
  }
  return r;
}

// ---------- main ----------

async function main(a) {
  if (!a.tokens || !a.output) {
    return {
      ok: false,
      kind: 'itkv',
      error: 'bad_args',
      hint: '--tokens <jsonl> and --output <jsonl> are required',
      _exit_code: 2,
    };
  }
  const tokensPath = normalizePathArg(a.tokens, 'tokens', { mustExist: true });
  if (tokensPath.error) return tokensPath.error;
  const outputPath = normalizePathArg(a.output, 'output', { parentMustExist: true });
  if (outputPath.error) return outputPath.error;
  let profilePath = null;
  if (a.profile) {
    profilePath = normalizePathArg(a.profile, 'profile', { mustExist: true });
    if (profilePath.error) return profilePath.error;
  }

  const found = locateRuntime();
  if (!found) {
    const d = await doctor();
    return {
      ok: false,
      kind: 'itkv',
      error: 'no_tier_runtime',
      install_hint: d.install_hint,
      _exit_code: 3,
    };
  }

  const cargs = [...found.args, '--tokens', tokensPath.path, '--output', outputPath.path];
  if (profilePath) cargs.push('--profile', profilePath.path);

  let res;
  try {
    res = spawnSync(found.cmd, cargs, {
      stdio: 'pipe',
      timeout: ITKV_WORKER_LIMITS.TIMEOUT_MS,
      maxBuffer: ITKV_WORKER_LIMITS.MAX_BUFFER_BYTES,
      env: childEnv(),
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'itkv',
      runtime: found.source,
      error: 'runtime_spawn_failed',
      detail: cleanText(e.message || e),
      _exit_code: 5,
    };
  }

  // The python script writes a single JSON envelope to stdout on success;
  // on failure it writes structured JSON to stderr + non-zero exit.
  let inner = null;
  const stdout = String(res.stdout || '').trim();
  if (stdout) {
    try {
      const tail = stdout.split('\n').filter(Boolean).pop();
      inner = JSON.parse(tail);
    } catch {
      inner = null;
    }
  }
  let innerErr = null;
  const stderr = String(res.stderr || '').trim();
  if (stderr) {
    try {
      const tail = stderr.split('\n').filter(Boolean).pop();
      innerErr = JSON.parse(tail);
    } catch {
      innerErr = null;
    }
  }

  if (res.status !== 0) {
    return {
      ok: false,
      kind: 'itkv',
      runtime: found.source,
      error: (innerErr && innerErr.error) || 'runtime_failed',
      detail: innerErr || cleanText(stderr),
      exit_code: res.status,
      _exit_code: 5,
    };
  }

  return {
    ok: true,
    kind: 'itkv',
    contract_version: ITKV_WORKER_CONTRACT_VERSION,
    runtime: found.source,
    output: outputPath.path,
    tokens_classified: (inner && inner.tokens_classified) || null,
    inner,
  };
}

function childEnv() {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ];
  const out = { PYTHONUTF8: '1' };
  for (const key of keep) {
    if (typeof process.env[key] === 'string' && process.env[key]) out[key] = process.env[key];
  }
  return out;
}

// ---------- runtime location ----------

function locateRuntime() {
  // 1. ITKV_TIER_CMD env override (accepts single command OR a JSON array
  //    [cmd, ...args]). Tests inject a Node-based stub via this knob so the
  //    JS/Python parity path can be exercised without python3 on PATH.
  const ovr = process.env.ITKV_TIER_CMD;
  if (ovr && ovr.length > 0) {
    const parsed = parseRuntimeOverride(ovr);
    if (!parsed) return null;
    let { cmd } = parsed;
    const cargs = parsed.args;
    // For absolute paths, verify the command exists. For names on PATH,
    // rely on the OS to fail at spawn time.
    if (path.isAbsolute(cmd)) {
      if (!isExecutableCandidate(cmd)) {
        return null;
      }
    } else if (cmd.includes('/') || cmd.includes('\\')) {
      // a relative path was given but it doesn't resolve - honor honesty
      const abs = path.resolve(cmd);
      if (!isExecutableCandidate(abs)) return null;
      cmd = abs;
    }
    return { cmd, args: cargs, source: 'env:ITKV_TIER_CMD' };
  }

  // 2. python3 workers/itkv/scripts/itkv.py (the default path).
  const py = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (py) {
    const script = path.join(__dirname, 'scripts', 'itkv.py');
    if (fs.existsSync(script)) {
      return { cmd: py, args: [script], source: 'python3+stub' };
    }
  }
  const py2 = whichSync(process.platform === 'win32' ? 'py.exe' : 'python');
  if (py2) {
    const script = path.join(__dirname, 'scripts', 'itkv.py');
    if (fs.existsSync(script)) {
      return { cmd: py2, args: [script], source: 'python+stub' };
    }
  }

  return null;
}

function parseRuntimeOverride(raw) {
  const value = String(raw || '').trim();
  if (
    !value
    || value.length > ITKV_WORKER_LIMITS.MAX_RUNTIME_CMD_CHARS
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    return null;
  }
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value);
      if (!Array.isArray(arr) || arr.length === 0 || arr.length > ITKV_WORKER_LIMITS.MAX_RUNTIME_ARGS + 1) {
        return null;
      }
      const parts = arr.map((part) => String(part));
      if (parts.some((part) => !part || part.length > ITKV_WORKER_LIMITS.MAX_RUNTIME_ARG_CHARS || /[\x00-\x1f\x7f]/.test(part))) {
        return null;
      }
      return { cmd: parts[0], args: parts.slice(1) };
    } catch {
      return null;
    }
  }
  if (/\s/.test(value)) return null;
  return { cmd: value, args: [] };
}

function isExecutableCandidate(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function whichSync(bin) {
  if (!bin) return null;
  // Absolute path - check existence directly.
  if (path.isAbsolute(bin)) {
    return isExecutableCandidate(bin) ? bin : null;
  }
  const pathEnv = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (isExecutableCandidate(candidate)) return candidate;
      } catch { // deliberate: cleanup
        // ignore - keep walking
      }
    }
  }
  return null;
}
