// C8 - durable compute scheduler.
//
// This module is the shared queue/lease primitive for compute-oriented jobs:
// broker runs, cloud distill, quantize/train work, and future worker pools.
// It is intentionally file-backed and dependency-free so local/self-hosted
// installs get the same idempotency and retry semantics as hosted workers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const COMPUTE_SCHEDULER_VERSION = 'c8-compute-scheduler-v1';

export const SCHEDULER_STATES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
]);

export const TERMINAL_SCHEDULER_STATES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
]);

export const SCHEDULER_PRIORITY_LANES = Object.freeze([
  'enterprise',
  'team',
  'pro',
  'free',
]);

export const SCHEDULER_FAMILIES = Object.freeze([
  'compute',
  'cloud-distill',
  'compile',
  'distill',
  'eval',
  'quantize',
  'serve',
]);

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 1000;
const MAX_HISTORY = 80;

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function baseDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(homeDir(), '.kolm');
}

export function schedulerDir() {
  return process.env.KOLM_COMPUTE_SCHEDULER_DIR
    ? path.resolve(process.env.KOLM_COMPUTE_SCHEDULER_DIR)
    : path.join(baseDir(), 'compute-scheduler');
}

function jobsDir() {
  return path.join(schedulerDir(), 'jobs');
}

function ensureDirs() {
  fs.mkdirSync(jobsDir(), { recursive: true });
}

function jobPath(jobId) {
  return path.join(jobsDir(), `${jobId}.json`);
}

function nowMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function newJobId() {
  return 'csj_' + crypto.randomBytes(10).toString('hex');
}

function isObj(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function requireTenant(value) {
  const tenant = typeof value === 'string' ? value.trim() : '';
  if (!tenant) throw new Error('tenant_required');
  if (tenant.length > 160) throw new Error('tenant_too_long');
  return tenant;
}

function normalizeFamily(value) {
  const family = typeof value === 'string' && value.trim() ? value.trim() : 'compute';
  if (!SCHEDULER_FAMILIES.includes(family)) throw new Error(`invalid_family:${family}`);
  return family;
}

function normalizePriority(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (SCHEDULER_PRIORITY_LANES.includes(raw)) return raw;
  if (raw === 'business') return 'team';
  if (raw === 'starter' || raw === 'member') return 'pro';
  return 'free';
}

function normalizeLane(value) {
  const lane = typeof value === 'string' ? value.trim() : '';
  return lane ? lane.slice(0, 120) : null;
}

function normalizeWorkerId(value) {
  const worker = typeof value === 'string' ? value.trim() : '';
  if (!worker) throw new Error('worker_id_required');
  return worker.slice(0, 160);
}

function normalizeIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key ? key.slice(0, 240) : null;
}

function finiteNonNegative(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function priorityRank(priority) {
  const idx = SCHEDULER_PRIORITY_LANES.indexOf(priority);
  return idx === -1 ? SCHEDULER_PRIORITY_LANES.length : idx;
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (isObj(value)) {
    return '{' + Object.keys(value).sort().map((k) =>
      JSON.stringify(k) + ':' + canonicalStringify(value[k])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function sensitiveKey(key) {
  return /(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)/i.test(String(key || ''));
}

function redactSecrets(value, depth = 0) {
  if (depth > 8) return '[max_depth]';
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (!isObj(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sensitiveKey(k) ? '[redacted]' : redactSecrets(v, depth + 1);
  }
  return out;
}

function readJobFile(file) {
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    return job && job.job_id ? job : null;
  } catch (_) {
    return null;
  }
}

function writeJob(job) {
  ensureDirs();
  const p = jobPath(job.job_id);
  const tmp = p + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function readAllJobsUnsafe() {
  ensureDirs();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(jobsDir()); } catch (_) { names = []; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const job = readJobFile(path.join(jobsDir(), name));
    if (job) out.push(job);
  }
  return out;
}

function getJobUnsafe(jobId) {
  if (!jobId) return null;
  const p = jobPath(jobId);
  if (!fs.existsSync(p)) return null;
  return readJobFile(p);
}

function withEvent(job, event, atMs) {
  const history = Array.isArray(job.history) ? job.history.slice(-MAX_HISTORY + 1) : [];
  history.push({
    at: iso(atMs),
    type: event.type,
    worker_id: event.worker_id || null,
    reason: event.reason || null,
    state: event.state || job.state,
  });
  return { ...job, history };
}

function terminal(state) {
  return TERMINAL_SCHEDULER_STATES.includes(state);
}

function queueEligible(job, atMs) {
  return job.state === 'queued'
    && (!job.not_before_at || (Date.parse(job.not_before_at) || 0) <= atMs);
}

function staleRunning(job, atMs) {
  return job.state === 'running'
    && job.lease
    && (Date.parse(job.lease.expires_at) || 0) <= atMs;
}

function canWorkerRun(job, lanes, families) {
  if (families && families.size && !families.has(job.family)) return false;
  if (!lanes || lanes.size === 0) return true;
  return !job.lane || lanes.has(job.lane);
}

function sortedCandidates(jobs) {
  return jobs.sort((a, b) => {
    const p = priorityRank(a.priority) - priorityRank(b.priority);
    if (p !== 0) return p;
    const an = Date.parse(a.not_before_at || a.created_at || '') || 0;
    const bn = Date.parse(b.not_before_at || b.created_at || '') || 0;
    if (an !== bn) return an - bn;
    const ac = Date.parse(a.created_at || '') || 0;
    const bc = Date.parse(b.created_at || '') || 0;
    if (ac !== bc) return ac - bc;
    return String(a.job_id).localeCompare(String(b.job_id));
  });
}

function budgetEnvelope(estimatedCostUsd, budgetUsd) {
  if (budgetUsd != null && estimatedCostUsd != null && estimatedCostUsd > budgetUsd) {
    return {
      ok: false,
      error: 'budget_exceeded',
      estimated_cost_usd: estimatedCostUsd,
      budget_usd: budgetUsd,
      version: COMPUTE_SCHEDULER_VERSION,
    };
  }
  return null;
}

export function listSchedulerJobs(opts = {}) {
  const tenant = requireTenant(opts.tenant);
  let jobs = readAllJobsUnsafe().filter((j) => j.tenant_id === tenant);
  if (opts.family) {
    const family = normalizeFamily(opts.family);
    jobs = jobs.filter((j) => j.family === family);
  }
  if (opts.state) {
    const state = String(opts.state);
    if (!SCHEDULER_STATES.includes(state)) throw new Error(`invalid_state:${state}`);
    jobs = jobs.filter((j) => j.state === state);
  }
  const limit = Math.min(1000, Math.max(1, Math.trunc(Number(opts.limit) || 100)));
  jobs.sort((a, b) => (Date.parse(b.updated_at || b.created_at || '') || 0)
    - (Date.parse(a.updated_at || a.created_at || '') || 0));
  return {
    ok: true,
    tenant_id: tenant,
    count: Math.min(jobs.length, limit),
    total_for_tenant: jobs.length,
    jobs: jobs.slice(0, limit),
    version: COMPUTE_SCHEDULER_VERSION,
  };
}

export function getSchedulerJob(opts = {}) {
  const tenant = requireTenant(opts.tenant);
  const jobId = typeof opts.job_id === 'string' ? opts.job_id : '';
  if (!jobId) return { ok: false, error: 'job_id_required', version: COMPUTE_SCHEDULER_VERSION };
  const job = getJobUnsafe(jobId);
  if (!job || job.tenant_id !== tenant) {
    return { ok: false, error: 'not_found', version: COMPUTE_SCHEDULER_VERSION };
  }
  return { ok: true, job, version: COMPUTE_SCHEDULER_VERSION };
}

export function submitSchedulerJob(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const tenant = requireTenant(opts.tenant);
  const family = normalizeFamily(opts.family);
  const idempotencyKey = normalizeIdempotencyKey(opts.idempotency_key);
  const priority = normalizePriority(opts.priority);
  const lane = normalizeLane(opts.lane);
  const payload = redactSecrets(opts.payload || {});
  const lineage = redactSecrets(opts.lineage || {});
  const labels = redactSecrets(opts.labels || {});
  const maxAttempts = Math.max(1, Math.min(20, Math.trunc(Number(opts.max_attempts) || DEFAULT_MAX_ATTEMPTS)));
  const leaseMs = Math.max(1000, Math.trunc(Number(opts.lease_ms) || DEFAULT_LEASE_MS));
  const estimatedCostUsd = finiteNonNegative(opts.estimated_cost_usd, null);
  const budgetUsd = finiteNonNegative(opts.budget_usd, null);
  const budgetErr = budgetEnvelope(estimatedCostUsd, budgetUsd);
  if (budgetErr) return budgetErr;

  if (idempotencyKey) {
    const existing = readAllJobsUnsafe().find((j) =>
      j.tenant_id === tenant
      && j.family === family
      && j.idempotency_key === idempotencyKey);
    if (existing) {
      return {
        ok: true,
        created: false,
        idempotent_replay: true,
        job_id: existing.job_id,
        job: existing,
        version: COMPUTE_SCHEDULER_VERSION,
      };
    }
  }

  const notBeforeMs = opts.not_before_ms != null ? nowMs(opts.not_before_ms) : atMs;
  const job = {
    version: COMPUTE_SCHEDULER_VERSION,
    job_id: newJobId(),
    tenant_id: tenant,
    family,
    operation: typeof opts.operation === 'string' && opts.operation.trim()
      ? opts.operation.trim().slice(0, 120)
      : family,
    state: 'queued',
    priority,
    lane,
    idempotency_key: idempotencyKey,
    payload,
    payload_sha256: sha256Json(payload),
    labels,
    lineage,
    attempts: 0,
    max_attempts: maxAttempts,
    lease_ms: leaseMs,
    lease: null,
    retry: {
      retry_base_ms: Math.max(100, Math.trunc(Number(opts.retry_base_ms) || DEFAULT_RETRY_BASE_MS)),
      last_error: null,
      next_retry_at: null,
    },
    cost: {
      estimated_usd: estimatedCostUsd,
      budget_usd: budgetUsd,
      reserved_usd: estimatedCostUsd == null ? 0 : estimatedCostUsd,
      reservation_state: estimatedCostUsd == null ? 'unquoted' : 'reserved',
    },
    created_at: iso(atMs),
    updated_at: iso(atMs),
    not_before_at: iso(notBeforeMs),
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
    history: [],
  };
  const withSubmitEvent = withEvent(job, { type: 'submitted', state: 'queued' }, atMs);
  writeJob(withSubmitEvent);
  return {
    ok: true,
    created: true,
    idempotent_replay: false,
    job_id: withSubmitEvent.job_id,
    job: withSubmitEvent,
    version: COMPUTE_SCHEDULER_VERSION,
  };
}

export function sweepExpiredLeases(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const tenant = opts.tenant ? requireTenant(opts.tenant) : null;
  const jobs = readAllJobsUnsafe();
  const recovered = [];
  const dead_lettered = [];
  for (const job of jobs) {
    if (tenant && job.tenant_id !== tenant) continue;
    if (!staleRunning(job, atMs)) continue;
    if ((job.attempts || 0) >= (job.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
      const next = withEvent({
        ...job,
        state: 'dead_letter',
        lease: null,
        updated_at: iso(atMs),
        finished_at: iso(atMs),
        error: job.error || 'lease_expired',
      }, { type: 'dead_letter', reason: 'lease_expired' }, atMs);
      writeJob(next);
      dead_lettered.push(next.job_id);
    } else {
      const next = withEvent({
        ...job,
        state: 'queued',
        lease: null,
        updated_at: iso(atMs),
        retry: {
          ...(job.retry || {}),
          last_error: 'lease_expired',
          next_retry_at: iso(atMs),
        },
      }, { type: 'lease_expired', reason: 'requeued' }, atMs);
      writeJob(next);
      recovered.push(next.job_id);
    }
  }
  return {
    ok: true,
    recovered,
    dead_lettered,
    version: COMPUTE_SCHEDULER_VERSION,
  };
}

export function claimNextSchedulerJob(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const tenant = requireTenant(opts.tenant);
  const workerId = normalizeWorkerId(opts.worker_id);
  const leaseMs = Math.max(1000, Math.trunc(Number(opts.lease_ms) || DEFAULT_LEASE_MS));
  const lanes = Array.isArray(opts.worker_lanes) && opts.worker_lanes.length
    ? new Set(opts.worker_lanes.map(normalizeLane).filter(Boolean))
    : null;
  const families = Array.isArray(opts.families) && opts.families.length
    ? new Set(opts.families.map(normalizeFamily))
    : null;

  const jobs = sortedCandidates(readAllJobsUnsafe().filter((job) =>
    job.tenant_id === tenant
    && canWorkerRun(job, lanes, families)
    && (queueEligible(job, atMs) || staleRunning(job, atMs))));

  for (const job of jobs) {
    if (staleRunning(job, atMs) && (job.attempts || 0) >= (job.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
      const dead = withEvent({
        ...job,
        state: 'dead_letter',
        lease: null,
        updated_at: iso(atMs),
        finished_at: iso(atMs),
        error: job.error || 'lease_expired',
      }, { type: 'dead_letter', reason: 'lease_expired' }, atMs);
      writeJob(dead);
      continue;
    }
    const leaseToken = crypto.randomBytes(16).toString('hex');
    const next = withEvent({
      ...job,
      state: 'running',
      attempts: (job.attempts || 0) + 1,
      updated_at: iso(atMs),
      started_at: job.started_at || iso(atMs),
      lease: {
        token: leaseToken,
        worker_id: workerId,
        claimed_at: iso(atMs),
        heartbeat_at: iso(atMs),
        expires_at: iso(atMs + leaseMs),
      },
    }, { type: 'claimed', worker_id: workerId, state: 'running' }, atMs);
    writeJob(next);
    return {
      ok: true,
      claimed: true,
      job_id: next.job_id,
      lease_token: leaseToken,
      job: next,
      version: COMPUTE_SCHEDULER_VERSION,
    };
  }

  return {
    ok: true,
    claimed: false,
    job: null,
    version: COMPUTE_SCHEDULER_VERSION,
  };
}

function loadLeasedJob(opts) {
  const tenant = requireTenant(opts.tenant);
  const jobId = typeof opts.job_id === 'string' ? opts.job_id : '';
  if (!jobId) return { error: 'job_id_required' };
  const job = getJobUnsafe(jobId);
  if (!job || job.tenant_id !== tenant) return { error: 'not_found' };
  if (job.state !== 'running' || !job.lease) return { error: 'not_running', job };
  if (!opts.lease_token || job.lease.token !== opts.lease_token) return { error: 'lease_mismatch', job };
  return { job };
}

export function heartbeatSchedulerJob(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const leaseMs = Math.max(1000, Math.trunc(Number(opts.lease_ms) || DEFAULT_LEASE_MS));
  const loaded = loadLeasedJob(opts);
  if (loaded.error) return { ok: false, error: loaded.error, version: COMPUTE_SCHEDULER_VERSION };
  const job = loaded.job;
  const next = withEvent({
    ...job,
    updated_at: iso(atMs),
    lease: {
      ...job.lease,
      heartbeat_at: iso(atMs),
      expires_at: iso(atMs + leaseMs),
    },
  }, { type: 'heartbeat', worker_id: job.lease.worker_id, state: 'running' }, atMs);
  writeJob(next);
  return { ok: true, job_id: next.job_id, lease: next.lease, version: COMPUTE_SCHEDULER_VERSION };
}

export function completeSchedulerJob(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const loaded = loadLeasedJob(opts);
  if (loaded.error) return { ok: false, error: loaded.error, version: COMPUTE_SCHEDULER_VERSION };
  const job = loaded.job;
  const next = withEvent({
    ...job,
    state: 'succeeded',
    updated_at: iso(atMs),
    finished_at: iso(atMs),
    lease: null,
    result: redactSecrets(opts.result || {}),
    error: null,
  }, { type: 'completed', worker_id: job.lease.worker_id, state: 'succeeded' }, atMs);
  writeJob(next);
  return { ok: true, job_id: next.job_id, state: next.state, job: next, version: COMPUTE_SCHEDULER_VERSION };
}

export function failSchedulerJob(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const loaded = loadLeasedJob(opts);
  if (loaded.error) return { ok: false, error: loaded.error, version: COMPUTE_SCHEDULER_VERSION };
  const job = loaded.job;
  const retryable = opts.retryable !== false;
  const error = typeof opts.error === 'string' && opts.error
    ? opts.error.slice(0, 1000)
    : 'worker_failed';
  const attempts = job.attempts || 0;
  const maxAttempts = job.max_attempts || DEFAULT_MAX_ATTEMPTS;
  if (retryable && attempts < maxAttempts) {
    const base = Math.max(100, Math.trunc(Number(job.retry?.retry_base_ms) || DEFAULT_RETRY_BASE_MS));
    const delay = Math.min(60 * 60 * 1000, base * Math.pow(2, Math.max(0, attempts - 1)));
    const nextRun = atMs + delay;
    const next = withEvent({
      ...job,
      state: 'queued',
      updated_at: iso(atMs),
      not_before_at: iso(nextRun),
      lease: null,
      error,
      retry: {
        ...(job.retry || {}),
        last_error: error,
        next_retry_at: iso(nextRun),
      },
    }, { type: 'retry_scheduled', worker_id: job.lease.worker_id, reason: error, state: 'queued' }, atMs);
    writeJob(next);
    return {
      ok: true,
      job_id: next.job_id,
      state: next.state,
      retry_scheduled: true,
      next_retry_at: next.retry.next_retry_at,
      job: next,
      version: COMPUTE_SCHEDULER_VERSION,
    };
  }

  const next = withEvent({
    ...job,
    state: 'dead_letter',
    updated_at: iso(atMs),
    finished_at: iso(atMs),
    lease: null,
    error,
    retry: {
      ...(job.retry || {}),
      last_error: error,
      next_retry_at: null,
    },
  }, { type: 'dead_letter', worker_id: job.lease.worker_id, reason: error, state: 'dead_letter' }, atMs);
  writeJob(next);
  return {
    ok: true,
    job_id: next.job_id,
    state: next.state,
    retry_scheduled: false,
    job: next,
    version: COMPUTE_SCHEDULER_VERSION,
  };
}

export function cancelSchedulerJob(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const tenant = requireTenant(opts.tenant);
  const jobId = typeof opts.job_id === 'string' ? opts.job_id : '';
  if (!jobId) return { ok: false, error: 'job_id_required', version: COMPUTE_SCHEDULER_VERSION };
  const job = getJobUnsafe(jobId);
  if (!job || job.tenant_id !== tenant) {
    return { ok: false, error: 'not_found', version: COMPUTE_SCHEDULER_VERSION };
  }
  if (terminal(job.state)) {
    return {
      ok: false,
      error: 'terminal_state',
      state: job.state,
      version: COMPUTE_SCHEDULER_VERSION,
    };
  }
  const reason = typeof opts.reason === 'string' ? opts.reason.slice(0, 500) : '';
  const next = withEvent({
    ...job,
    state: 'cancelled',
    updated_at: iso(atMs),
    finished_at: iso(atMs),
    lease: null,
    error: reason || job.error,
  }, { type: 'cancelled', reason, state: 'cancelled' }, atMs);
  writeJob(next);
  return { ok: true, job_id: next.job_id, state: next.state, job: next, version: COMPUTE_SCHEDULER_VERSION };
}

export function advanceSchedulerJobState(opts = {}) {
  const atMs = nowMs(opts.now_ms);
  const tenant = requireTenant(opts.tenant);
  const jobId = typeof opts.job_id === 'string' ? opts.job_id : '';
  if (!jobId) return { ok: false, error: 'job_id_required', version: COMPUTE_SCHEDULER_VERSION };
  const state = typeof opts.state === 'string' ? opts.state : '';
  if (!SCHEDULER_STATES.includes(state)) {
    return { ok: false, error: 'invalid_state', version: COMPUTE_SCHEDULER_VERSION };
  }
  const job = getJobUnsafe(jobId);
  if (!job || job.tenant_id !== tenant) {
    return { ok: false, error: 'not_found', version: COMPUTE_SCHEDULER_VERSION };
  }
  if (terminal(job.state) && job.state !== state) {
    return {
      ok: false,
      error: 'terminal_state',
      state: job.state,
      version: COMPUTE_SCHEDULER_VERSION,
    };
  }
  const next = withEvent({
    ...job,
    state,
    updated_at: iso(atMs),
    started_at: job.started_at || (state === 'running' ? iso(atMs) : job.started_at),
    finished_at: terminal(state) ? iso(atMs) : job.finished_at,
    lease: terminal(state) ? null : job.lease,
    result: opts.result ? redactSecrets(opts.result) : job.result,
    error: typeof opts.error === 'string' ? opts.error.slice(0, 1000) : job.error,
  }, {
    type: 'external_state',
    reason: typeof opts.reason === 'string' ? opts.reason : null,
    state,
  }, atMs);
  writeJob(next);
  return { ok: true, job_id: next.job_id, state: next.state, job: next, version: COMPUTE_SCHEDULER_VERSION };
}

export function queueStats(opts = {}) {
  const tenant = requireTenant(opts.tenant);
  const jobs = readAllJobsUnsafe().filter((j) => j.tenant_id === tenant);
  const by_state = Object.fromEntries(SCHEDULER_STATES.map((s) => [s, 0]));
  const by_priority = Object.fromEntries(SCHEDULER_PRIORITY_LANES.map((p) => [p, 0]));
  for (const job of jobs) {
    if (by_state[job.state] != null) by_state[job.state] += 1;
    if (by_priority[job.priority] != null && !terminal(job.state)) by_priority[job.priority] += 1;
  }
  return {
    ok: true,
    tenant_id: tenant,
    total: jobs.length,
    by_state,
    by_priority,
    version: COMPUTE_SCHEDULER_VERSION,
  };
}

export function _resetSchedulerForTests() {
  try { fs.rmSync(schedulerDir(), { recursive: true, force: true }); } catch (_) {}
}

export default {
  COMPUTE_SCHEDULER_VERSION,
  SCHEDULER_STATES,
  TERMINAL_SCHEDULER_STATES,
  SCHEDULER_PRIORITY_LANES,
  SCHEDULER_FAMILIES,
  schedulerDir,
  submitSchedulerJob,
  listSchedulerJobs,
  getSchedulerJob,
  claimNextSchedulerJob,
  heartbeatSchedulerJob,
  completeSchedulerJob,
  failSchedulerJob,
  cancelSchedulerJob,
  advanceSchedulerJobState,
  sweepExpiredLeases,
  queueStats,
  _resetSchedulerForTests,
};
