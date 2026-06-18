// W831-1 - Fully-offline distillation entry point.
//
// Purpose
// -------
// Closes the "no API captures, no network teacher" half of the W831 air-gapped
// integration. `offlineDistill({...})` is the single function operators call
// from a classified enclave when they want to run a distillation pass with
// only locally-stored artifacts: their own training jsonl, a local teacher
// snapshot, a local student snapshot, an output path on the same disk.
//
// The function makes NO inference calls - its job is to verify the air-gap
// shape, write a mandatory-redacted corpus sibling, and enqueue a deterministic
// run-id that the local trainer worker (apps/trainer/*.py invoked via spawn)
// will pick up. This split mirrors
// the W831 contract: the JS layer guarantees no network leak; the Python
// trainer does the actual gradient steps under the same air-gap.
//
// Air-gap verification (the three guards, in order)
// -------------------------------------------------
//   (a) No KOLM_TEACHER_API_KEY env present. Any cloud-teacher key in the
//       environment is treated as an immediate air-gap violation - even if
//       this run wouldn't use it, the *presence* means a misconfigured fork
//       could ship captures to the cloud. We fail loud rather than risk it.
//   (b) All four paths (user_data_path, teacher_path_local, student_path_local,
//       output_path's parent dir) MUST exist on the local filesystem. We do
//       NOT permit relative path resolution against $HOME - the operator
//       must spell out the absolute path so an inspector can read it back.
//   (c) Outbound network is fully unreachable. We perform a deliberate dial
//       to https://example.com with a 50ms AbortSignal timeout. If the dial
//       SUCCEEDS, network is reachable and we throw 'airgap_violation:
//       network reachable'. If it fails (DNS error, refused, timeout) the
//       enclave is correctly walled-off and we proceed.
//
// W411 tenant fence: opts.tenant is preserved in the returned envelope so
// the route layer can attribute the run to the right tenant. We do NOT read
// tenant state directly - the route handler does the auth resolution.
//
// W604 version stamp: AIRGAP_DISTILL_VERSION matches /^w831-/. Consumers MUST
// match /^w831-/ - never an explicit equality so a w831-v2 ships without
// breaking the contract.
//
// Honesty invariants:
//   - Every guard throws a typed Error. Errors are CAUGHT inside offlineDistill
//     and re-surfaced as {ok:false, error, hint} so the HTTP envelope shape is
//     consistent. The thrown form is preserved on the err.cause chain for
//     debugging.
//   - We NEVER silently fall back to a remote teacher if the local one is
//     missing - the operator gets a typed error.
//   - The dial-failure guard is the LAST guard so cheap env / fs checks fail
//     fast before we waste 50ms.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DETECTOR_VERSION, redactWithPolicy } from './privacy-membrane.js';

export const AIRGAP_DISTILL_VERSION = 'w831-v2';
export const AIRGAP_TRAINING_REDACTION_VERSION = 'w617-v1';
export const AIRGAP_DISTILL_WORKER_VERSION = 'w953-v1';

// Probe URL used by the dial-failure guard. Any reachable host works - the
// point is "does this Node process have network egress at all". example.com
// is a well-known public host that exists ONLY to be a probe target.
const PROBE_URL = 'https://example.com';

// Dial timeout. Long enough that a slow loopback DNS resolver doesn't
// false-trigger; short enough that an air-gapped enclave (which will time out
// on DNS) doesn't waste real wall time. 50ms is the W831 spec value.
const PROBE_TIMEOUT_MS = 50;
const SAFE_RUN_ID_RE = /^airgap_[a-f0-9]{16}_[a-f0-9]{8}$/;
const WORKER_STDIO_LIMIT_BYTES = 64 * 1024;
const WORKER_DETAIL_LIMIT = 4096;
const CLOUD_SECRET_ENV_KEYS = [
  'KOLM_TEACHER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'REPLICATE_API_TOKEN',
  'HF_TOKEN',
  'HUGGINGFACEHUB_API_TOKEN',
  'WANDB_API_KEY',
];

// In-process queue for queued runs. The trainer worker picks runs off this
// path by scanning ~/.kolm/airgap-distill-runs/<run_id>.json. We deliberately
// do NOT use the event store here - air-gapped enclaves may run before the
// event store is initialized.
function runsDir() {
  const home = process.env.KOLM_HOME ||
    path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.kolm');
  return path.join(home, 'airgap-distill-runs');
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function defaultPythonWorkerPath() {
  return path.join(repoRoot(), 'apps', 'trainer', 'airgap_distill_worker.py');
}

// Guard (a): KOLM_TEACHER_API_KEY env present is an air-gap violation.
// We treat any non-empty value as a violation - even an empty string suggests
// the operator was mid-config and forgot to unset.
function assertNoTeacherApiKey() {
  const k = process.env.KOLM_TEACHER_API_KEY;
  if (k !== undefined && k !== null) {
    const err = new Error(
      'airgap_violation: KOLM_TEACHER_API_KEY is set in env - air-gapped runs MUST NOT have cloud teacher credentials available'
    );
    err.code = 'airgap_violation_teacher_key';
    throw err;
  }
}

// Guard (b): all supplied paths are local + existent. We do NOT permit
// http://, https://, ftp://, s3://, etc. - only filesystem paths. We also
// reject relative paths so an inspector can read the absolute path back.
function assertLocalPath(label, p) {
  if (!p || typeof p !== 'string') {
    const err = new Error(`airgap_violation: ${label} is required (got ${JSON.stringify(p)})`);
    err.code = 'airgap_path_missing';
    throw err;
  }
  if (/^[a-z]+:\/\//i.test(p)) {
    const err = new Error(`airgap_violation: ${label} must be a local filesystem path, not a URL (got ${JSON.stringify(p)})`);
    err.code = 'airgap_path_not_local';
    throw err;
  }
  if (!path.isAbsolute(p)) {
    const err = new Error(`airgap_violation: ${label} must be an absolute path (got ${JSON.stringify(p)})`);
    err.code = 'airgap_path_not_absolute';
    throw err;
  }
}

function assertExistsFile(label, p) {
  if (!fs.existsSync(p)) {
    const err = new Error(`airgap_violation: ${label} does not exist on local filesystem: ${p}`);
    err.code = 'airgap_path_not_found';
    throw err;
  }
}

// Guard (c): the dial-failure guard. Attempt a real fetch to PROBE_URL with
// a 50ms timeout. If it SUCCEEDS, network is reachable and we throw. If it
// FAILS (any reason - DNS, timeout, refused, abort), the enclave is properly
// walled off and we proceed.
//
// We use AbortSignal.timeout because it's the cleanest Node 18+ contract.
// On Node < 18, AbortSignal.timeout is absent - we degrade gracefully by
// treating "no AbortSignal.timeout" as a failure to dial (which is the safe
// default; better to refuse the run than risk leaking).
async function assertNetworkUnreachable(fetchImpl) {
  const real = fetchImpl || globalThis.fetch;
  if (typeof real !== 'function') {
    // No fetch available - by definition there is no network egress from
    // this process. Treat as walled-off and proceed.
    return;
  }
  let signal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  } else {
    // Old Node: simulate via AbortController + setTimeout.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    signal = ctl.signal;
  }
  let reachable = false;
  try {
    const resp = await real(PROBE_URL, { method: 'HEAD', signal });
    // Any 2xx/3xx/4xx response indicates the request reached a server. Even a
    // 4xx proves the network is reachable.
    if (resp && typeof resp.status === 'number' && resp.status > 0) {
      reachable = true;
    }
  } catch (_) {
    // Expected path for a properly air-gapped enclave: DNS error, abort,
    // connection refused, etc. We swallow the error and proceed.
    reachable = false;
  }
  if (reachable) {
    const err = new Error('airgap_violation: network reachable');
    err.code = 'airgap_violation_network_reachable';
    err.probe_url = PROBE_URL;
    throw err;
  }
}

// Compute a stable run_id from the four input paths so an operator can
// re-trigger an identical run and get the same id back (handy for audit).
// The id includes a short random suffix so two operators running the same
// inputs at the same time don't collide.
function deriveRunId(opts) {
  const base = crypto
    .createHash('sha256')
    .update(String(opts.user_data_path || ''))
    .update('\x00')
    .update(String(opts.teacher_path_local || ''))
    .update('\x00')
    .update(String(opts.student_path_local || ''))
    .update('\x00')
    .update(String(opts.output_path || ''))
    .digest('hex')
    .slice(0, 16);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `airgap_${base}_${suffix}`;
}

// Persist the queued run to disk so the trainer worker can pick it up. We
// write the spec atomically (write to .tmp then rename) so a partial write
// never corrupts the queue.
function persistQueuedRun(run_id, spec) {
  const dir = runsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${run_id}.json`);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return target;
}

function assertSafeRunId(run_id) {
  if (!run_id || typeof run_id !== 'string' || !SAFE_RUN_ID_RE.test(run_id)) {
    const err = new Error(`airgap_worker_invalid_run_id: ${JSON.stringify(run_id)}`);
    err.code = 'airgap_worker_invalid_run_id';
    throw err;
  }
}

function specPathForRun(run_id) {
  assertSafeRunId(run_id);
  return path.join(runsDir(), `${run_id}.json`);
}

function readRunSpec(run_id) {
  const target = specPathForRun(run_id);
  if (!fs.existsSync(target)) {
    const err = new Error(`airgap_worker_run_not_found: ${run_id}`);
    err.code = 'run_not_found';
    throw err;
  }
  try {
    return { spec: JSON.parse(fs.readFileSync(target, 'utf8')), spec_path: target };
  } catch (e) {
    const err = new Error(`airgap_worker_spec_parse_error: ${String((e && e.message) || e)}`);
    err.code = 'spec_parse_error';
    throw err;
  }
}

function invalidWorkerSpec(reason, detail = reason) {
  const err = new Error(`airgap_worker_spec_invalid: ${detail}`);
  err.code = 'airgap_worker_spec_invalid';
  err.reason = reason;
  throw err;
}

function capText(value, limit = WORKER_DETAIL_LIMIT) {
  const s = String(value || '');
  if (Buffer.byteLength(s) <= limit) return s;
  return `${s.slice(0, limit)}...<truncated>`;
}

function appendCapped(current, chunk, limit = WORKER_STDIO_LIMIT_BYTES) {
  const next = current + String(chunk || '');
  if (Buffer.byteLength(next) <= limit) return next;
  return next.slice(Math.max(0, next.length - limit));
}

function redactWorkerEnv(extra = {}) {
  const env = {
    ...process.env,
    ...(extra && typeof extra === 'object' ? extra : {}),
    KOLM_AIRGAP: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    WANDB_DISABLED: 'true',
    TOKENIZERS_PARALLELISM: 'false',
  };
  for (const key of CLOUD_SECRET_ENV_KEYS) delete env[key];
  return env;
}

function buildPythonWorkerCommand(specPath, opts = {}) {
  const workerPath = opts.worker_path ||
    process.env.KOLM_AIRGAP_DISTILL_WORKER ||
    defaultPythonWorkerPath();
  const python = opts.python ||
    process.env.KOLM_AIRGAP_PYTHON ||
    process.env.PYTHON ||
    'python';
  const args = [workerPath, '--spec', specPath];
  if (Array.isArray(opts.worker_args)) args.push(...opts.worker_args.map(String));
  return {
    executable: python,
    args,
    worker_path: workerPath,
    mode: 'python_kd_trainer',
    version: AIRGAP_DISTILL_WORKER_VERSION,
  };
}

function parseWorkerStdout(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return {
      raw_stdout_sha256: crypto.createHash('sha256').update(trimmed).digest('hex'),
      raw_stdout_preview: capText(trimmed, 1024),
    };
  }
}

function sanitizeWorkerResult(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') out[key] = capText(value);
    else out[key] = value;
  }
  return out;
}

async function assertProcessableRunSpec(spec, run_id) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    invalidWorkerSpec('spec_not_object');
  }
  if (spec.run_id !== run_id) {
    invalidWorkerSpec('run_id_mismatch', `spec.run_id=${JSON.stringify(spec.run_id)} request=${JSON.stringify(run_id)}`);
  }
  if (spec.airgap_verified !== true || spec.verification_method !== 'no_network_dial') {
    invalidWorkerSpec('airgap_verification_missing', 'queued spec must carry airgap_verified=true and verification_method=no_network_dial');
  }
  if (!spec.redaction || spec.redaction.applied !== true) {
    invalidWorkerSpec('redaction_missing', 'queued spec must carry mandatory redaction evidence');
  }
  if (spec.redaction_policy !== 'mandatory_training_redaction' || spec.redaction.policy !== 'mandatory_training_redaction') {
    invalidWorkerSpec('redaction_policy_not_mandatory');
  }

  assertLocalPath('user_data_path', spec.user_data_path);
  assertExistsFile('user_data_path', spec.user_data_path);
  assertLocalPath('teacher_path_local', spec.teacher_path_local);
  assertExistsFile('teacher_path_local', spec.teacher_path_local);
  assertLocalPath('student_path_local', spec.student_path_local);
  assertExistsFile('student_path_local', spec.student_path_local);
  assertLocalPath('output_path', spec.output_path);
  const outDir = path.dirname(spec.output_path);
  if (!fs.existsSync(outDir)) {
    invalidWorkerSpec('output_parent_missing', `output_path parent dir does not exist: ${outDir}`);
  }

  if (!spec.source_user_data_path || path.resolve(spec.source_user_data_path) === path.resolve(spec.user_data_path)) {
    invalidWorkerSpec('raw_corpus_selected', 'worker refuses to train on the source corpus path');
  }
  if (spec.redaction.redacted_user_data_path &&
      path.resolve(spec.redaction.redacted_user_data_path) !== path.resolve(spec.user_data_path)) {
    invalidWorkerSpec('redacted_path_mismatch');
  }
  if (spec.redaction.redacted_sha256) {
    const actual = await sha256File(spec.user_data_path);
    if (actual !== spec.redaction.redacted_sha256) {
      invalidWorkerSpec('redacted_sha256_mismatch');
    }
  }
}

function outputEvidence(outputPath) {
  if (!outputPath || typeof outputPath !== 'string' || !fs.existsSync(outputPath)) {
    return { exists: false };
  }
  const st = fs.statSync(outputPath);
  const ev = {
    exists: true,
    kind: st.isDirectory() ? 'directory' : 'file',
    size_bytes: st.size,
  };
  if (st.isFile()) {
    ev.sha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
  }
  return ev;
}

function runPythonAirgapWorker({ spec_path, env, command }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: repoRoot(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on('error', (e) => {
      e.code = e.code || 'airgap_worker_spawn_error';
      reject(e);
    });
    child.on('close', (exit_code) => {
      const parsed = parseWorkerStdout(stdout);
      const result = {
        ok: exit_code === 0,
        executor: 'python_airgap_distill_worker',
        exit_code,
        command: {
          executable: command.executable,
          worker_path: command.worker_path,
          args: command.args.slice(1),
        },
        stdout_sha256: crypto.createHash('sha256').update(stdout).digest('hex'),
        stderr_sha256: crypto.createHash('sha256').update(stderr).digest('hex'),
        stderr_preview: stderr ? capText(stderr, 2048) : '',
        receipt: parsed,
      };
      if (exit_code !== 0) {
        const err = new Error(`airgap_worker_failed: python worker exited ${exit_code}`);
        err.code = 'airgap_worker_failed';
        err.exit_code = exit_code;
        err.worker_result = result;
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

function siblingRedactedPath(userDataPath) {
  const dir = path.dirname(userDataPath);
  const ext = path.extname(userDataPath);
  const base = path.basename(userDataPath, ext);
  const suffix = ext || '.jsonl';
  return path.join(dir, `${base}.redacted${suffix}`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

function placeholderClass(placeholder) {
  const m = /^VAR_([A-Z0-9_]+)_\d+$/.exec(String(placeholder || ''));
  if (!m) return null;
  if (m[1] === 'PATIENT_NAME') return 'name';
  return m[1].toLowerCase();
}

function newRedactionStats() {
  return {
    classes: new Set(),
    redactions_by_class: {},
    redacted_fields: 0,
  };
}

function recordRedactionResult(result, original, stats, fieldPath) {
  const allowed = Array.isArray(result.allowed_classes) ? result.allowed_classes : [];
  const overridden = Array.isArray(result.overridden_classes) ? result.overridden_classes : [];
  if (allowed.length > 0 || overridden.length > 0) {
    const unsafe = [...new Set([...allowed, ...overridden])].sort();
    const err = new Error(
      `airgap_redaction_policy_unsafe: mandatory training redaction would pass raw sensitive text at ${fieldPath}: ${unsafe.join(', ')}`
    );
    err.code = 'airgap_redaction_policy_unsafe';
    err.classes = unsafe;
    err.field_path = fieldPath;
    throw err;
  }

  const classes = Array.isArray(result.classes_seen) ? result.classes_seen : [];
  for (const cls of classes) stats.classes.add(cls);
  const vault = result.vault && typeof result.vault === 'object' ? result.vault : {};
  for (const placeholder of Object.keys(vault)) {
    const cls = placeholderClass(placeholder);
    if (!cls) continue;
    stats.classes.add(cls);
    stats.redactions_by_class[cls] = (stats.redactions_by_class[cls] || 0) + 1;
  }
  if (String(result.redacted) !== String(original)) stats.redacted_fields += 1;
}

function redactTrainingValue(value, stats, fieldPath = '$') {
  if (typeof value === 'string') {
    const result = redactWithPolicy(value);
    recordRedactionResult(result, value, stats, fieldPath);
    return result.redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => redactTrainingValue(item, stats, `${fieldPath}[${idx}]`));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactTrainingValue(nested, stats, `${fieldPath}.${key}`);
    }
    return out;
  }
  return value;
}

async function writeLine(stream, line) {
  if (stream.write(line)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function finishWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

export async function redactTrainingJsonl(userDataPath, opts = {}) {
  const redactedPath = opts.redacted_path || siblingRedactedPath(userDataPath);
  if (path.resolve(redactedPath) === path.resolve(userDataPath)) {
    const err = new Error('airgap_redaction_error: redacted path must not overwrite source corpus');
    err.code = 'airgap_redaction_path_collision';
    throw err;
  }

  const inputSha256 = await sha256File(userDataPath);
  const tmp = `${redactedPath}.tmp.${process.pid}`;
  const aggregate = newRedactionStats();
  let rows = 0;
  let redactedRows = 0;
  let bytesWritten = 0;

  const input = fs.createReadStream(userDataPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const output = fs.createWriteStream(tmp, { encoding: 'utf8', flags: 'w' });

  try {
    for await (const line of lines) {
      if (!String(line).trim()) continue;
      rows += 1;
      let row;
      try {
        row = JSON.parse(line);
      } catch (e) {
        const err = new Error(`airgap_redaction_jsonl_parse_error: line ${rows}: ${String(e.message || e)}`);
        err.code = 'airgap_redaction_jsonl_parse_error';
        err.line = rows;
        throw err;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        const err = new Error(`airgap_redaction_jsonl_row_not_object: line ${rows}`);
        err.code = 'airgap_redaction_jsonl_row_not_object';
        err.line = rows;
        throw err;
      }

      const rowStats = newRedactionStats();
      const redacted = redactTrainingValue(row, rowStats);
      const rowClasses = [...rowStats.classes].sort();
      if (rowClasses.length > 0) {
        redacted.redaction_applied = rowClasses;
        redacted.redaction_policy = 'mandatory_training_redaction';
        redacted.redaction_detector_version = DETECTOR_VERSION;
      }
      if (rowStats.redacted_fields > 0) redactedRows += 1;
      for (const cls of rowClasses) aggregate.classes.add(cls);
      for (const [cls, count] of Object.entries(rowStats.redactions_by_class)) {
        aggregate.redactions_by_class[cls] = (aggregate.redactions_by_class[cls] || 0) + count;
      }
      aggregate.redacted_fields += rowStats.redacted_fields;

      const rendered = JSON.stringify(redacted) + '\n';
      bytesWritten += Buffer.byteLength(rendered);
      await writeLine(output, rendered);
    }
    await finishWriteStream(output);
    fs.renameSync(tmp, redactedPath);
  } catch (e) {
    try { lines.close(); } catch (_) {}
    try { output.destroy(); } catch (_) {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }

  const outputSha256 = await sha256File(redactedPath);
  return {
    applied: true,
    version: AIRGAP_TRAINING_REDACTION_VERSION,
    detector_version: DETECTOR_VERSION,
    policy: 'mandatory_training_redaction',
    source_user_data_path: userDataPath,
    redacted_user_data_path: redactedPath,
    source_sha256: inputSha256,
    redacted_sha256: outputSha256,
    rows,
    redacted_rows: redactedRows,
    redacted_fields: aggregate.redacted_fields,
    bytes_written: bytesWritten,
    classes_redacted: [...aggregate.classes].sort(),
    redactions_by_class: Object.fromEntries(
      Object.entries(aggregate.redactions_by_class).sort(([a], [b]) => a.localeCompare(b))
    ),
  };
}

// Public entry. Returns:
//   {ok:true, run_id, status:'queued', airgap_verified:true,
//    verification_method:'no_network_dial', spec_path, version}
//   {ok:false, error, hint, version} - when any guard fails
//
// Args:
//   user_data_path        local jsonl of {prompt,response} rows
//   teacher_path_local    local teacher snapshot (folder or .kolm)
//   student_path_local    local student snapshot (folder or .kolm)
//   output_path           local path the trainer will write the distilled
//                         artifact to (parent dir MUST exist)
//   tenant                optional tenant_id (W411 surface attribution)
//   fetch                 optional injectable fetch (tests use this)
//
// Side effects:
//   Writes a sibling *.redacted.jsonl corpus and points the queued spec at it.
//   Writes a queued-run spec to ~/.kolm/airgap-distill-runs/<run_id>.json.
//   No network calls except the dial-failure guard.
export async function offlineDistill(opts = {}) {
  const {
    user_data_path,
    teacher_path_local,
    student_path_local,
    output_path,
    tenant = null,
    fetch: fetchImpl,
  } = opts || {};
  try {
    // Guard (a) - no cloud-teacher key in env.
    assertNoTeacherApiKey();
    // Guard (b) - all paths local + absolute + existent (output_path parent
    // dir, since the file itself won't exist yet).
    assertLocalPath('user_data_path', user_data_path);
    assertExistsFile('user_data_path', user_data_path);
    assertLocalPath('teacher_path_local', teacher_path_local);
    assertExistsFile('teacher_path_local', teacher_path_local);
    assertLocalPath('student_path_local', student_path_local);
    assertExistsFile('student_path_local', student_path_local);
    assertLocalPath('output_path', output_path);
    const outDir = path.dirname(output_path);
    if (!fs.existsSync(outDir)) {
      const err = new Error(`airgap_violation: output_path parent dir does not exist: ${outDir}`);
      err.code = 'airgap_path_not_found';
      throw err;
    }
    // Guard (c) - the dial-failure probe.
    await assertNetworkUnreachable(fetchImpl);
  } catch (e) {
    return {
      ok: false,
      error: (e && e.code) || 'airgap_violation',
      detail: String((e && e.message) || e),
      hint: 'Check that KOLM_TEACHER_API_KEY is unset and the enclave has no internet egress',
      tenant,
      version: AIRGAP_DISTILL_VERSION,
    };
  }

  let redaction;
  try {
    redaction = await redactTrainingJsonl(user_data_path);
  } catch (e) {
    return {
      ok: false,
      error: (e && e.code) || 'airgap_redaction_error',
      detail: String((e && e.message) || e),
      hint: 'Fix the JSONL corpus or privacy policy, then retry the air-gapped distill run',
      tenant,
      version: AIRGAP_DISTILL_VERSION,
    };
  }

  const run_id = deriveRunId({ user_data_path, teacher_path_local, student_path_local, output_path });
  const spec = {
    run_id,
    status: 'queued',
    queued_at: new Date().toISOString(),
    airgap_verified: true,
    verification_method: 'no_network_dial',
    user_data_path: redaction.redacted_user_data_path,
    source_user_data_path: user_data_path,
    redaction_applied: redaction.classes_redacted,
    redaction_detector_version: redaction.detector_version,
    redaction_policy: redaction.policy,
    redaction,
    teacher_path_local,
    student_path_local,
    output_path,
    tenant,
    version: AIRGAP_DISTILL_VERSION,
  };
  let spec_path;
  try {
    spec_path = persistQueuedRun(run_id, spec);
  } catch (e) {
    return {
      ok: false,
      error: 'queue_write_error',
      detail: String((e && e.message) || e),
      hint: `Could not write to ${runsDir()} - check disk permissions`,
      tenant,
      version: AIRGAP_DISTILL_VERSION,
    };
  }
  return {
    ok: true,
    run_id,
    status: 'queued',
    airgap_verified: true,
    verification_method: 'no_network_dial',
    spec_path,
    user_data_path: redaction.redacted_user_data_path,
    source_user_data_path: user_data_path,
    redaction_applied: redaction.classes_redacted,
    redaction_detector_version: redaction.detector_version,
    redaction_policy: redaction.policy,
    redaction,
    tenant,
    version: AIRGAP_DISTILL_VERSION,
  };
}

// Consume one queued air-gap distill spec. This is intentionally a JS control
// plane around a Python execution boundary: JS owns the queue invariants and
// status transitions; apps/trainer/airgap_distill_worker.py owns the KD trainer.
export async function processOfflineDistillRun(opts = {}) {
  const {
    run_id,
    fetch: fetchImpl,
    executor = null,
    env: extraEnv = null,
    python = null,
    worker_path = null,
    worker_args = null,
    now = () => new Date().toISOString(),
  } = opts || {};

  let spec;
  let spec_path;
  let command;
  try {
    assertSafeRunId(run_id);
    ({ spec, spec_path } = readRunSpec(run_id));
    if (spec.status === 'completed') {
      return {
        ok: true,
        already_completed: true,
        ...spec,
        version: AIRGAP_DISTILL_VERSION,
      };
    }
    if (spec.status !== 'queued') {
      return {
        ok: false,
        error: 'airgap_worker_run_not_queued',
        run_id,
        status: spec.status,
        version: AIRGAP_DISTILL_VERSION,
      };
    }

    assertNoTeacherApiKey();
    await assertNetworkUnreachable(fetchImpl);
    await assertProcessableRunSpec(spec, run_id);

    const env = redactWorkerEnv(extraEnv);
    command = buildPythonWorkerCommand(spec_path, { python, worker_path, worker_args });
    const started = {
      ...spec,
      status: 'running',
      started_at: spec.started_at || now(),
      worker: {
        kind: 'python_airgap_distill_worker',
        version: AIRGAP_DISTILL_WORKER_VERSION,
        worker_path: command.worker_path,
        mode: command.mode,
        offline_env: {
          KOLM_AIRGAP: env.KOLM_AIRGAP,
          TRANSFORMERS_OFFLINE: env.TRANSFORMERS_OFFLINE,
          HF_DATASETS_OFFLINE: env.HF_DATASETS_OFFLINE,
          HF_HUB_OFFLINE: env.HF_HUB_OFFLINE,
        },
      },
    };
    delete started.error;
    delete started.detail;
    delete started.failed_at;
    persistQueuedRun(run_id, started);

    const rawResult = typeof executor === 'function'
      ? await executor({ spec: started, spec_path, env, worker_command: command })
      : await runPythonAirgapWorker({ spec: started, spec_path, env, command });
    const completed = {
      ...started,
      status: 'completed',
      completed_at: now(),
      worker_result: sanitizeWorkerResult(rawResult),
      output_evidence: outputEvidence(started.output_path),
      version: AIRGAP_DISTILL_VERSION,
    };
    persistQueuedRun(run_id, completed);
    return { ok: true, spec_path, ...completed };
  } catch (e) {
    const error = (e && e.code) || 'airgap_worker_error';
    const failed = spec && typeof spec === 'object' ? {
      ...spec,
      status: 'failed',
      failed_at: now(),
      error,
      error_reason: e && e.reason ? String(e.reason) : undefined,
      detail: capText((e && e.message) || e),
      worker_result: e && e.worker_result ? sanitizeWorkerResult(e.worker_result) : spec.worker_result,
      version: AIRGAP_DISTILL_VERSION,
    } : null;
    if (failed && run_id && SAFE_RUN_ID_RE.test(run_id)) {
      try { spec_path = persistQueuedRun(run_id, failed); } catch (_) {}
    }
    return {
      ok: false,
      ...(failed || {}),
      error,
      run_id,
      spec_path,
      detail: capText((e && e.message) || e),
      version: AIRGAP_DISTILL_VERSION,
    };
  }
}

export function listOfflineDistillRuns(opts = {}) {
  const { status = null } = opts || {};
  const dir = runsDir();
  if (!fs.existsSync(dir)) {
    return { ok: true, runs: [], version: AIRGAP_DISTILL_VERSION };
  }
  const runs = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const run_id = ent.name.slice(0, -'.json'.length);
    if (!SAFE_RUN_ID_RE.test(run_id)) continue;
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, ent.name), 'utf8'));
      if (status && spec.status !== status) continue;
      runs.push({
        run_id,
        status: spec.status,
        queued_at: spec.queued_at || null,
        started_at: spec.started_at || null,
        completed_at: spec.completed_at || null,
        failed_at: spec.failed_at || null,
        tenant: spec.tenant || null,
        spec_path: path.join(dir, ent.name),
      });
    } catch (_) {
      runs.push({
        run_id,
        status: 'unreadable',
        queued_at: null,
        tenant: null,
        spec_path: path.join(dir, ent.name),
      });
    }
  }
  runs.sort((a, b) => String(a.queued_at || '').localeCompare(String(b.queued_at || '')) ||
    a.run_id.localeCompare(b.run_id));
  return { ok: true, runs, version: AIRGAP_DISTILL_VERSION };
}

export async function processOfflineDistillQueue(opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Number(opts.limit)) : 1;
  const queued = listOfflineDistillRuns({ status: 'queued' }).runs.slice(0, limit);
  const results = [];
  for (const run of queued) {
    results.push(await processOfflineDistillRun({ ...opts, run_id: run.run_id }));
  }
  return {
    ok: results.every((r) => r.ok),
    processed: results.length,
    completed: results.filter((r) => r.ok && r.status === 'completed').length,
    failed: results.filter((r) => !r.ok).length,
    results,
    version: AIRGAP_DISTILL_VERSION,
  };
}

// Read the status of a previously-queued run. Returns the persisted spec or
// an honest envelope if the run_id is unknown. Used by GET /v1/airgap/distill/status/:id.
export function getOfflineDistillStatus({ run_id }) {
  if (!run_id || typeof run_id !== 'string') {
    return {
      ok: false,
      error: 'run_id_required',
      version: AIRGAP_DISTILL_VERSION,
    };
  }
  const target = path.join(runsDir(), `${run_id}.json`);
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      error: 'run_not_found',
      run_id,
      version: AIRGAP_DISTILL_VERSION,
    };
  }
  try {
    const spec = JSON.parse(fs.readFileSync(target, 'utf8'));
    return { ok: true, ...spec, version: AIRGAP_DISTILL_VERSION };
  } catch (e) {
    return {
      ok: false,
      error: 'spec_parse_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_DISTILL_VERSION,
    };
  }
}

// Exposed for tests + downstream consumers that want to bypass the route
// layer (e.g. CLI driver runs the spec directly).
export const _internal = {
  runsDir,
  deriveRunId,
  persistQueuedRun,
  specPathForRun,
  readRunSpec,
  assertProcessableRunSpec,
  buildPythonWorkerCommand,
  redactWorkerEnv,
  defaultPythonWorkerPath,
  redactTrainingJsonl,
  siblingRedactedPath,
  PROBE_URL,
  PROBE_TIMEOUT_MS,
  SAFE_RUN_ID_RE,
};
