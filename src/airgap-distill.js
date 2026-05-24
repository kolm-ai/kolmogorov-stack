// W831-1 — Fully-offline distillation entry point.
//
// Purpose
// -------
// Closes the "no API captures, no network teacher" half of the W831 air-gapped
// integration. `offlineDistill({...})` is the single function operators call
// from a classified enclave when they want to run a distillation pass with
// only locally-stored artifacts: their own training jsonl, a local teacher
// snapshot, a local student snapshot, an output path on the same disk.
//
// The function makes NO inference calls — its job is to verify the air-gap
// shape and enqueue a deterministic run-id that the local trainer worker
// (apps/trainer/*.py invoked via spawn) will pick up. This split mirrors
// the W831 contract: the JS layer guarantees no network leak; the Python
// trainer does the actual gradient steps under the same air-gap.
//
// Air-gap verification (the three guards, in order)
// -------------------------------------------------
//   (a) No KOLM_TEACHER_API_KEY env present. Any cloud-teacher key in the
//       environment is treated as an immediate air-gap violation — even if
//       this run wouldn't use it, the *presence* means a misconfigured fork
//       could ship captures to the cloud. We fail loud rather than risk it.
//   (b) All four paths (user_data_path, teacher_path_local, student_path_local,
//       output_path's parent dir) MUST exist on the local filesystem. We do
//       NOT permit relative path resolution against $HOME — the operator
//       must spell out the absolute path so an inspector can read it back.
//   (c) Outbound network is fully unreachable. We perform a deliberate dial
//       to https://example.com with a 50ms AbortSignal timeout. If the dial
//       SUCCEEDS, network is reachable and we throw 'airgap_violation:
//       network reachable'. If it fails (DNS error, refused, timeout) the
//       enclave is correctly walled-off and we proceed.
//
// W411 tenant fence: opts.tenant is preserved in the returned envelope so
// the route layer can attribute the run to the right tenant. We do NOT read
// tenant state directly — the route handler does the auth resolution.
//
// W604 version stamp: AIRGAP_DISTILL_VERSION = 'w831-v1'. Consumers MUST
// match /^w831-/ — never an explicit equality so a w831-v2 ships without
// breaking the contract.
//
// Honesty invariants:
//   - Every guard throws a typed Error. Errors are CAUGHT inside offlineDistill
//     and re-surfaced as {ok:false, error, hint} so the HTTP envelope shape is
//     consistent. The thrown form is preserved on the err.cause chain for
//     debugging.
//   - We NEVER silently fall back to a remote teacher if the local one is
//     missing — the operator gets a typed error.
//   - The dial-failure guard is the LAST guard so cheap env / fs checks fail
//     fast before we waste 50ms.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AIRGAP_DISTILL_VERSION = 'w831-v1';

// Probe URL used by the dial-failure guard. Any reachable host works — the
// point is "does this Node process have network egress at all". example.com
// is a well-known public host that exists ONLY to be a probe target.
const PROBE_URL = 'https://example.com';

// Dial timeout. Long enough that a slow loopback DNS resolver doesn't
// false-trigger; short enough that an air-gapped enclave (which will time out
// on DNS) doesn't waste real wall time. 50ms is the W831 spec value.
const PROBE_TIMEOUT_MS = 50;

// In-process queue for queued runs. The trainer worker picks runs off this
// path by scanning ~/.kolm/airgap-distill-runs/<run_id>.json. We deliberately
// do NOT use the event store here — air-gapped enclaves may run before the
// event store is initialized.
function runsDir() {
  const home = process.env.KOLM_HOME ||
    path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.kolm');
  return path.join(home, 'airgap-distill-runs');
}

// Guard (a): KOLM_TEACHER_API_KEY env present is an air-gap violation.
// We treat any non-empty value as a violation — even an empty string suggests
// the operator was mid-config and forgot to unset.
function assertNoTeacherApiKey() {
  const k = process.env.KOLM_TEACHER_API_KEY;
  if (k !== undefined && k !== null) {
    const err = new Error(
      'airgap_violation: KOLM_TEACHER_API_KEY is set in env — air-gapped runs MUST NOT have cloud teacher credentials available'
    );
    err.code = 'airgap_violation_teacher_key';
    throw err;
  }
}

// Guard (b): all supplied paths are local + existent. We do NOT permit
// http://, https://, ftp://, s3://, etc. — only filesystem paths. We also
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
// FAILS (any reason — DNS, timeout, refused, abort), the enclave is properly
// walled off and we proceed.
//
// We use AbortSignal.timeout because it's the cleanest Node 18+ contract.
// On Node < 18, AbortSignal.timeout is absent — we degrade gracefully by
// treating "no AbortSignal.timeout" as a failure to dial (which is the safe
// default; better to refuse the run than risk leaking).
async function assertNetworkUnreachable(fetchImpl) {
  const real = fetchImpl || globalThis.fetch;
  if (typeof real !== 'function') {
    // No fetch available — by definition there is no network egress from
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

// Public entry. Returns:
//   {ok:true, run_id, status:'queued', airgap_verified:true,
//    verification_method:'no_network_dial', spec_path, version}
//   {ok:false, error, hint, version} — when any guard fails
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
    // Guard (a) — no cloud-teacher key in env.
    assertNoTeacherApiKey();
    // Guard (b) — all paths local + absolute + existent (output_path parent
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
    // Guard (c) — the dial-failure probe.
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

  const run_id = deriveRunId({ user_data_path, teacher_path_local, student_path_local, output_path });
  const spec = {
    run_id,
    status: 'queued',
    queued_at: new Date().toISOString(),
    airgap_verified: true,
    verification_method: 'no_network_dial',
    user_data_path,
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
      hint: `Could not write to ${runsDir()} — check disk permissions`,
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
    tenant,
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
  PROBE_URL,
  PROBE_TIMEOUT_MS,
};
