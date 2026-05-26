#!/usr/bin/env node
// workers/itkv/itkv.mjs
//
// W722 - thin Node shell for the ITKV tier selector.
//
// This file is a STUB. Runtime KV cache tier dispatch is a future wave -
// the real implementation would plug into vLLM PagedAttention / SGLang
// radix cache and route prefix-cache hits according to the ITKV profile.
// What this shell ships TODAY:
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
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = parseArgs(process.argv.slice(2));

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
  const a = { doctor: false, json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--doctor') {
      a.doctor = true;
    } else if (k === '--profile') {
      a.profile = v;
      i += 1;
    } else if (k === '--tokens') {
      a.tokens = v;
      i += 1;
    } else if (k === '--output') {
      a.output = v;
      i += 1;
    } else if (k === '--json') {
      a.json = true;
    }
  }
  return a;
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
    version: '0.1.0',
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
      home: os.homedir(),
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
  if (!fs.existsSync(a.tokens)) {
    return {
      ok: false,
      kind: 'itkv',
      error: 'tokens_file_not_found',
      path: a.tokens,
      _exit_code: 2,
    };
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

  const cargs = [...found.args, '--tokens', a.tokens, '--output', a.output];
  if (a.profile) cargs.push('--profile', a.profile);

  let res;
  try {
    res = spawnSync(found.cmd, cargs, {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'itkv',
      runtime: found.source,
      error: 'runtime_spawn_failed',
      detail: String(e.message || e),
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
      detail: innerErr || stderr.slice(0, 500),
      exit_code: res.status,
      _exit_code: 5,
    };
  }

  return {
    ok: true,
    kind: 'itkv',
    runtime: found.source,
    output: a.output,
    tokens_classified: (inner && inner.tokens_classified) || null,
    inner,
  };
}

// ---------- runtime location ----------

function locateRuntime() {
  // 1. ITKV_TIER_CMD env override (accepts single command OR a JSON array
  //    [cmd, ...args]). Tests inject a Node-based stub via this knob so the
  //    JS/Python parity path can be exercised without python3 on PATH.
  const ovr = process.env.ITKV_TIER_CMD;
  if (ovr && ovr.length > 0) {
    let cmd = ovr;
    let cargs = [];
    if (ovr.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(ovr);
        if (Array.isArray(arr) && arr.length > 0) {
          cmd = String(arr[0]);
          cargs = arr.slice(1).map(String);
        }
      } catch { // deliberate: cleanup
        // fall back to raw string
      }
    }
    // For absolute paths, verify the command exists. For names on PATH,
    // rely on the OS to fail at spawn time.
    if (path.isAbsolute(cmd)) {
      if (!fs.existsSync(cmd)) {
        return null;
      }
    } else if (cmd.includes('/') || cmd.includes('\\')) {
      // a relative path was given but it doesn't resolve - honor honesty
      const abs = path.resolve(cmd);
      if (!fs.existsSync(abs)) return null;
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

function whichSync(bin) {
  if (!bin) return null;
  // Absolute path - check existence directly.
  if (path.isAbsolute(bin)) {
    return fs.existsSync(bin) ? bin : null;
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
        if (fs.existsSync(candidate)) return candidate;
      } catch { // deliberate: cleanup
        // ignore - keep walking
      }
    }
  }
  return null;
}
