#!/usr/bin/env node
// workers/tsac/tsac.mjs
//
// W707 - bounded Node shell for the Task-Specific Attention Compiler (TSAC)
// kernel-selector contract.
//
// The worker reads a validated TSAC profile and emits a per-(layer, head)
// kernel-name selection table. Runtime CUDA / Metal / CPU sparse-attention
// dispatch is intentionally handled by downstream runtimes; this worker ships
// the deterministic contract that a real kernel lookup table plugs into.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const WORKER_NAME = 'kolm-tsac-worker';
const TSAC_WORKER_VERSION = 'w707-tsac-worker-shell-v1';
const TSAC_WORKER_CONTRACT_VERSION = 'w707-v1';
const TSAC_VERSION = 'w721-v1';

const TSAC_WORKER_LIMITS = Object.freeze({
  MAX_ARG_CHARS: 4096,
  MAX_PROFILE_BYTES: 2 * 1024 * 1024,
  MAX_RUNTIME_CMD_CHARS: 8192,
  MAX_RUNTIME_ARGS: 32,
  MAX_RUNTIME_ARG_CHARS: 2048,
  MAX_DETAIL_CHARS: 1000,
  MAX_STDOUT_CHARS: 4000,
  TIMEOUT_MS: 5 * 60 * 1000,
  MAX_BUFFER_BYTES: 16 * 1024 * 1024,
});

const args = parseArgs(process.argv.slice(2));

if (args._errors.length > 0) {
  emit({
    ok: false,
    worker: WORKER_NAME,
    contract_version: TSAC_WORKER_CONTRACT_VERSION,
    error: 'bad_args',
    errors: args._errors,
  });
  process.exit(2);
}

if (args.doctor) {
  emitPretty(await doctor());
  process.exit(0);
}

const result = await main(args);
emit(result);
process.exit(exitCode(result));

async function main(a) {
  if (!a.profile) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'missing_profile',
      hint: 'pass --profile <path-to-tsac-profile.json>',
      _exit_code: 2,
    };
  }

  const profilePath = normalizePathArg(a.profile, 'profile', { mustExist: true });
  if (profilePath.error) return profilePath.error;

  let outputPath = null;
  if (a.output) {
    outputPath = normalizePathArg(a.output, 'output', { parentMustExist: true });
    if (outputPath.error) return outputPath.error;
  }

  const loaded = loadProfile(profilePath.path);
  if (loaded.error) return loaded.error;
  const profile = loaded.profile;

  const validate = await loadValidator();
  if (validate.error) return validate.error;
  const v = validate.validateProfile(profile);
  if (!v.ok) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'profile_invalid',
      profile_sha256: pathDigest(profilePath.path),
      profile_basename: path.basename(profilePath.path),
      validation_errors: (v.errors || []).slice(0, 20).map((err) => cleanText(err, 240)),
      _exit_code: 4,
    };
  }

  if (a.task && profile.task && profile.task !== a.task) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'task_mismatch',
      expected_task: cleanText(a.task, 160),
      profile_task: cleanText(profile.task, 160),
      _exit_code: 2,
    };
  }

  const runtime = resolveRuntime(process.env.TSAC_KERNEL_CMD);
  if (!runtime) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'no_kernel_runtime',
      hint: 'install Python 3.10+ or set TSAC_KERNEL_CMD as a JSON array override',
      _exit_code: 3,
    };
  }

  const childArgv = [...runtime.args, '--profile', profilePath.path];
  if (outputPath) childArgv.push('--output', outputPath.path);
  if (a.task) childArgv.push('--task', String(a.task));

  let res;
  try {
    res = spawnSync(runtime.cmd, childArgv, {
      encoding: 'utf8',
      env: childEnv(),
      shell: false,
      timeout: TSAC_WORKER_LIMITS.TIMEOUT_MS,
      maxBuffer: TSAC_WORKER_LIMITS.MAX_BUFFER_BYTES,
    });
  } catch (err) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'selector_spawn_failed',
      detail: cleanText(err?.message || err),
      hint: 'check that TSAC_KERNEL_CMD or python3 is executable',
      _exit_code: 5,
    };
  }

  if (res.error) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'selector_spawn_failed',
      detail: cleanText(res.error.message || res.error),
      hint: 'check that TSAC_KERNEL_CMD or python3 is executable',
      _exit_code: 5,
    };
  }

  if (res.status !== 0) {
    return {
      ok: false,
      worker: WORKER_NAME,
      contract_version: TSAC_WORKER_CONTRACT_VERSION,
      error: 'selector_failed',
      exit_code: res.status,
      stderr: cleanText(res.stderr, TSAC_WORKER_LIMITS.MAX_STDOUT_CHARS),
      stdout: cleanText(res.stdout, TSAC_WORKER_LIMITS.MAX_STDOUT_CHARS),
      _exit_code: 5,
    };
  }

  return {
    ok: true,
    worker: WORKER_NAME,
    worker_version: TSAC_WORKER_VERSION,
    contract_version: TSAC_WORKER_CONTRACT_VERSION,
    tsac_version: TSAC_VERSION,
    profile_sha256: pathDigest(profilePath.path),
    profile_basename: path.basename(profilePath.path),
    output: outputPath ? outputPath.path : null,
    selector_source: runtime.source,
    selector_stdout: cleanText(res.stdout, TSAC_WORKER_LIMITS.MAX_STDOUT_CHARS),
    selector_inner: parseJsonTail(res.stdout),
  };
}

function exitCode(result) {
  if (result.ok) return 0;
  if (result._exit_code) return result._exit_code;
  if (result.error === 'no_kernel_runtime') return 3;
  if (result.error === 'profile_not_found' || result.error === 'profile_parse_failed' || result.error === 'profile_invalid') return 4;
  if (result.error === 'bad_args' || result.error === 'missing_profile' || result.error === 'task_mismatch') return 2;
  return 5;
}

function emit(obj) {
  const { _exit_code, ...publicObj } = obj;
  process.stdout.write(JSON.stringify(publicObj) + '\n');
}

function emitPretty(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function parseArgs(argv) {
  const out = { _errors: [] };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      out._errors.push({ flag, error: 'missing_value' });
      return [null, index];
    }
    if (String(value).length > TSAC_WORKER_LIMITS.MAX_ARG_CHARS || /[\x00-\x1f\x7f]/.test(String(value))) {
      out._errors.push({ flag, error: 'invalid_value' });
      return [null, index + 1];
    }
    return [value, index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      out._errors.push({ flag: cleanText(raw, 80), error: 'unknown_arg' });
      continue;
    }
    if (raw === '--doctor' || raw === '--json') {
      out[raw.slice(2)] = true;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq > 0) {
      const key = raw.slice(2, eq);
      const value = raw.slice(eq + 1);
      if (!['profile', 'task', 'output'].includes(key)) {
        out._errors.push({ flag: `--${key}`, error: 'unknown_arg' });
      } else if (!value || value.length > TSAC_WORKER_LIMITS.MAX_ARG_CHARS || /[\x00-\x1f\x7f]/.test(value)) {
        out._errors.push({ flag: `--${key}`, error: 'invalid_value' });
      } else {
        out[key] = value;
      }
      continue;
    }
    const key = raw.slice(2);
    if (!['profile', 'task', 'output'].includes(key)) {
      out._errors.push({ flag: raw, error: 'unknown_arg' });
      continue;
    }
    const [value, next] = takeValue(raw, i);
    if (value != null) out[key] = value;
    i = next;
  }
  return out;
}

function cleanText(value, max = TSAC_WORKER_LIMITS.MAX_DETAIL_CHARS) {
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
    worker: WORKER_NAME,
    contract_version: TSAC_WORKER_CONTRACT_VERSION,
    error: code,
    path_sha256: pathDigest(filePath),
    path_basename: path.basename(String(filePath || '')),
    ...extra,
    _exit_code: code.startsWith('profile_') ? 4 : 2,
  };
}

function normalizePathArg(filePath, label, { mustExist = false, parentMustExist = false } = {}) {
  const raw = String(filePath || '');
  if (!raw || raw.length > TSAC_WORKER_LIMITS.MAX_ARG_CHARS || /[\x00-\x1f\x7f]/.test(raw)) {
    return { error: fileError(`invalid_${label}_path`, raw) };
  }
  const abs = path.resolve(process.cwd(), raw);
  if (mustExist) {
    try {
      if (!fs.statSync(abs).isFile()) return { error: fileError(`${label}_not_found`, raw) };
    } catch {
      return { error: fileError(`${label}_not_found`, raw) };
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

function loadProfile(profilePath) {
  let st;
  try { st = fs.statSync(profilePath); } catch {
    return { error: fileError('profile_not_found', profilePath) };
  }
  if (!st.isFile()) return { error: fileError('profile_not_found', profilePath) };
  if (st.size > TSAC_WORKER_LIMITS.MAX_PROFILE_BYTES) {
    return {
      error: fileError('profile_too_large', profilePath, { max_bytes: TSAC_WORKER_LIMITS.MAX_PROFILE_BYTES }),
    };
  }
  try {
    return { profile: JSON.parse(fs.readFileSync(profilePath, 'utf8')) };
  } catch (err) {
    return {
      error: fileError('profile_parse_failed', profilePath, { detail: cleanText(err?.message || err) }),
    };
  }
}

async function loadValidator() {
  try {
    const schemaUrl = pathToFileURL(path.join(ROOT, 'src', 'tsac-profile.js')).href;
    const mod = await import(schemaUrl);
    if (typeof mod.validateProfile !== 'function') throw new Error('validateProfile export missing');
    return { validateProfile: mod.validateProfile };
  } catch (err) {
    return {
      error: {
        ok: false,
        worker: WORKER_NAME,
        contract_version: TSAC_WORKER_CONTRACT_VERSION,
        error: 'schema_import_failed',
        detail: cleanText(err?.message || err),
        hint: 'workers/tsac/tsac.mjs requires src/tsac-profile.js',
        _exit_code: 4,
      },
    };
  }
}

function resolveRuntime(rawOverride) {
  const defaultScript = path.join(__dirname, 'scripts', 'tsac.py');
  if (rawOverride) {
    const parsed = parseRuntimeOverride(rawOverride);
    if (!parsed) return null;
    const launcher = resolveLauncher(parsed.cmd);
    if (!launcher) return null;
    return { cmd: launcher, args: parsed.args, source: 'env:TSAC_KERNEL_CMD' };
  }

  const candidates = process.platform === 'win32' ? ['python.exe', 'python', 'py.exe', 'py'] : ['python3', 'python'];
  for (const candidate of candidates) {
    const launcher = resolveLauncher(candidate);
    if (launcher && isExecutableCandidate(defaultScript)) {
      return { cmd: launcher, args: [defaultScript], source: 'python+default-script' };
    }
  }
  return null;
}

function parseRuntimeOverride(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > TSAC_WORKER_LIMITS.MAX_RUNTIME_CMD_CHARS || /[\x00-\x1f\x7f]/.test(value)) {
    return null;
  }
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value);
      if (!Array.isArray(arr) || arr.length === 0 || arr.length > TSAC_WORKER_LIMITS.MAX_RUNTIME_ARGS + 1) return null;
      const parts = arr.map((part) => String(part));
      if (parts.some((part) => !part || part.length > TSAC_WORKER_LIMITS.MAX_RUNTIME_ARG_CHARS || /[\x00-\x1f\x7f]/.test(part))) {
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

function resolveLauncher(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return isExecutableCandidate(cmd) ? cmd : null;
  }
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of String(process.env.PATH || '').split(pathSep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (isExecutableCandidate(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableCandidate(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
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

function parseJsonTail(stdout) {
  const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep walking
    }
  }
  return null;
}

async function doctor() {
  const defaultScript = path.join(__dirname, 'scripts', 'tsac.py');
  const runtime = resolveRuntime(process.env.TSAC_KERNEL_CMD);
  return {
    spec: 'kolm-tsac-worker-doctor',
    worker: WORKER_NAME,
    worker_version: TSAC_WORKER_VERSION,
    contract_version: TSAC_WORKER_CONTRACT_VERSION,
    tsac_version: TSAC_VERSION,
    node_version: process.version,
    platform: process.platform,
    script_present: isExecutableCandidate(defaultScript),
    tsac_kernel_cmd_set: !!process.env.TSAC_KERNEL_CMD,
    runtime: runtime
      ? { ok: true, source: runtime.source, argv_count: runtime.args.length }
      : { ok: false, source: null, argv_count: 0 },
    ready: !!runtime,
    hint: runtime ? null : 'install Python 3.10+ or set TSAC_KERNEL_CMD as a JSON array override',
  };
}
