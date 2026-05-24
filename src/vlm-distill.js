// W829-3 — VLM (Vision-Language Model) distillation entrypoint.
//
// Teaches a smaller VLM to mimic a large VLM teacher (GPT-4V, Claude 3
// Vision, Gemini Vision) on a corpus of captured (image, prompt → response)
// triples. The actual teacher inference is delegated to the user's
// provider account via KOLM_VLM_TEACHER_API_KEY (we never call a teacher
// without the operator explicitly granting credentials).
//
// Honesty contract:
//   When KOLM_VLM_TEACHER_API_KEY is missing the envelope is:
//     { ok:true, status:'queued', queued_at, real_run:false,
//       missing_env:'KOLM_VLM_TEACHER_API_KEY', run_id }
//   The job is durably queued so the operator can come back, set the env
//   var, and resume from `vlmDistillResume(run_id)`. We NEVER silently
//   declare a finished distillation when no teacher was reached.
//
// Job records live at:
//   ~/.kolm/vlm-distill/<run_id>.json
// and are append-friendly (the resume path overwrites with the new status).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VLM_DISTILL_VERSION = 'w829-v1';

export const SUPPORTED_TEACHERS = ['gpt-4v', 'claude-3-vision', 'gemini-vision'];

export const STATUSES = ['queued', 'running', 'finished', 'failed'];

function jobRoot() {
  if (process.env.KOLM_DATA_DIR) {
    return path.resolve(process.env.KOLM_DATA_DIR, 'vlm-distill');
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.resolve(home, '.kolm', 'vlm-distill');
}

function newRunId() {
  return 'vlm_' + crypto.randomBytes(8).toString('hex');
}

function writeJob(run_id, body) {
  const dir = jobRoot();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run_id}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

function readJob(run_id) {
  const file = path.join(jobRoot(), `${run_id}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

// vlmDistillRun({teacher, student_model, dataset_captures}) — enqueue (or
// run) a VLM distillation job.
//
// Inputs:
//   teacher           — one of SUPPORTED_TEACHERS
//   student_model     — string model identifier (e.g. 'Qwen2.5-VL-2B')
//   dataset_captures  — array of capture rows OR a string namespace key
//                       (a downstream wave will resolve the namespace to
//                       actual rows from the W829-1 capture lake).
//   tenant            — optional, stamped on the job record
//
// Output: envelope (see honesty contract above).
export function vlmDistillRun({ teacher, student_model, dataset_captures, tenant } = {}) {
  // Argument validation always runs BEFORE the env-key check so a caller
  // who passes garbage gets a sharp error, not a misleading "missing key."
  if (!teacher || !SUPPORTED_TEACHERS.includes(teacher)) {
    return {
      ok: false,
      error: 'teacher_unsupported',
      detail: `teacher must be one of ${SUPPORTED_TEACHERS.join('|')}, got ${JSON.stringify(teacher)}`,
      version: VLM_DISTILL_VERSION,
    };
  }
  if (!student_model || typeof student_model !== 'string') {
    return {
      ok: false,
      error: 'student_model_required',
      hint: 'pass student_model: a model identifier the runtime can load',
      version: VLM_DISTILL_VERSION,
    };
  }
  if (dataset_captures == null) {
    return {
      ok: false,
      error: 'dataset_captures_required',
      hint: 'pass dataset_captures: an array of capture rows OR a string namespace',
      version: VLM_DISTILL_VERSION,
    };
  }
  const datasetLen = Array.isArray(dataset_captures) ? dataset_captures.length : null;
  const datasetRef = typeof dataset_captures === 'string' ? dataset_captures : null;
  const run_id = newRunId();
  const queued_at = new Date().toISOString();

  // The honesty fork: no teacher key → queued, never finished.
  if (!process.env.KOLM_VLM_TEACHER_API_KEY) {
    const body = {
      run_id,
      teacher,
      student_model,
      tenant: tenant ? String(tenant) : null,
      status: 'queued',
      queued_at,
      real_run: false,
      missing_env: 'KOLM_VLM_TEACHER_API_KEY',
      note: 'requires KOLM_VLM_TEACHER_API_KEY for real run',
      dataset: { capture_count: datasetLen, namespace_ref: datasetRef },
      version: VLM_DISTILL_VERSION,
    };
    try { writeJob(run_id, body); } catch (_) { /* job-record write is best-effort */ }
    return {
      ok: true,
      run_id,
      status: 'queued',
      queued_at,
      real_run: false,
      missing_env: 'KOLM_VLM_TEACHER_API_KEY',
      note: 'requires KOLM_VLM_TEACHER_API_KEY for real run',
      version: VLM_DISTILL_VERSION,
    };
  }

  // Key present → enqueue as 'queued' (the actual teacher-call worker
  // lives outside this module; an upcoming wave will own the runner).
  // We still don't lie about metrics: until a runner reports back, the
  // envelope says status:'queued' + real_run:true.
  const body = {
    run_id,
    teacher,
    student_model,
    tenant: tenant ? String(tenant) : null,
    status: 'queued',
    queued_at,
    real_run: true,
    dataset: { capture_count: datasetLen, namespace_ref: datasetRef },
    version: VLM_DISTILL_VERSION,
  };
  try { writeJob(run_id, body); } catch (_) { /* best-effort */ }
  return {
    ok: true,
    run_id,
    status: 'queued',
    queued_at,
    real_run: true,
    version: VLM_DISTILL_VERSION,
  };
}

// List all known runs (for the dashboard + /v1/vlm-distill/runs GET).
// Optional tenant filter; honest empty array when no jobs exist yet.
export function vlmDistillList({ tenant } = {}) {
  const dir = jobRoot();
  if (!fs.existsSync(dir)) return { ok: true, runs: [], version: VLM_DISTILL_VERSION };
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (_) { return { ok: true, runs: [], version: VLM_DISTILL_VERSION }; }
  const runs = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const body = readJob(e.replace(/\.json$/, ''));
    if (!body) continue;
    if (tenant && body.tenant && String(body.tenant) !== String(tenant)) continue;
    runs.push({
      run_id: body.run_id,
      teacher: body.teacher,
      student_model: body.student_model,
      status: body.status,
      real_run: body.real_run === true,
      queued_at: body.queued_at,
      missing_env: body.missing_env || null,
      metrics: body.metrics || null,
    });
  }
  // Newest queued_at first so the dashboard shows fresh runs at the top.
  runs.sort((a, b) => (b.queued_at || '').localeCompare(a.queued_at || ''));
  return { ok: true, runs, version: VLM_DISTILL_VERSION };
}

// Resume a queued run after the operator has set the env var. Returns the
// updated envelope. Never silently transitions to 'finished'; the runner
// owns that transition.
export function vlmDistillResume(run_id) {
  const body = readJob(run_id);
  if (!body) {
    return { ok: false, error: 'not_found', version: VLM_DISTILL_VERSION };
  }
  if (!process.env.KOLM_VLM_TEACHER_API_KEY) {
    return {
      ok: true,
      run_id,
      status: body.status,
      real_run: false,
      missing_env: 'KOLM_VLM_TEACHER_API_KEY',
      version: VLM_DISTILL_VERSION,
    };
  }
  body.real_run = true;
  body.missing_env = null;
  body.resumed_at = new Date().toISOString();
  try { writeJob(run_id, body); } catch (_) { /* best-effort */ }
  return {
    ok: true,
    run_id,
    status: body.status,
    real_run: true,
    resumed_at: body.resumed_at,
    version: VLM_DISTILL_VERSION,
  };
}

// Test helper: wipe the jobs directory so a unit test that toggles env vars
// doesn't see stale records from a previous run.
export function _resetForTests() {
  try {
    const dir = jobRoot();
    if (fs.existsSync(dir)) {
      for (const e of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, e)); } catch (_) {}
      }
    }
  } catch (_) {}
}
