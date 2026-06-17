// W785 - Managed-distill cloud expansion.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 737-742):
//   [W785-1] Upload captures -> distill on Kolm-hosted infra -> download .kolm
//   [W785-2] Pay per distillation run, not per inference (separate metering)
//   [W785-3] Useful for users with inference HW but not training HW (landing)
//   [W785-4] /cloud.html landing page
//
// Honesty contract (W347 pattern, also applied W604):
//   Until a real Kolm-hosted worker pool is deployed and KOLM_CLOUD_DISTILL_ENDPOINT
//   points at it, submitJob returns state='queued' + cloud_backend_status='no_pool_configured'.
//   We NEVER pretend a job ran when no backend exists. The TUI / landing page must
//   surface this state honestly so a user paying for a managed distill run knows
//   whether their bytes are actually moving.
//
// Why this is separate from src/distill-pipeline.js:
//   distill-pipeline.js runs LOCALLY on the operator's machine (consumes local
//   GPU, writes artifact to ~/.kolm/artifacts). cloud-distill.js QUEUES a job
//   for a remote pool to consume - the operator's machine never sees the GPU.
//   The two pipelines share the same .kolm output shape but the billing
//   meter is fundamentally different: training $/gpu-hr vs. inference $/1k-tokens.
//
// Why this is separate from src/cloud-compute-broker.js:
//   broker.js is a PLANNER (which lane should I rent?). cloud-distill.js is
//   the RUNTIME orchestrator that actually submits / polls / cancels jobs once
//   the operator has chosen the Kolm-hosted lane.
//
// Why this is separate from src/cloud-sync.js:
//   sync pushes captured rows to a shared namespace for team retrieval.
//   cloud-distill submits a TRAINING JOB - completely different lifecycle,
//   different billing meter, different durability story.
//
// Persistence:
//   ~/.kolm/cloud-distill-jobs.jsonl - append-only. Tenant-scoped reads.
//   Honors KOLM_DATA_DIR override (used by tests + airgap-mode).
//
// W604 anti-brittleness: consumers match /^w785-/ on the version stamp.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  submitSchedulerJob,
  cancelSchedulerJob,
  advanceSchedulerJobState,
  _resetSchedulerForTests,
} from './compute-scheduler.js';

export const CLOUD_DISTILL_VERSION = 'w785-v1';

// Closed set of legal job lifecycle states. Frozen so a refactor cannot
// quietly add a new state without bumping the version stamp. queued is the
// initial state; succeeded / failed / cancelled are terminal.
export const CLOUD_DISTILL_STATES = Object.freeze([
  'queued', 'running', 'succeeded', 'failed', 'cancelled',
]);

// Backend status surfaces whether a real Kolm-hosted worker pool is
// reachable. 'no_pool_configured' is the honest default for self-hosted
// installs; 'reachable' requires KOLM_CLOUD_DISTILL_ENDPOINT to be set.
// 'simulated' is reserved for development envs that wire a stub pool.
export const CLOUD_BACKEND_STATUSES = Object.freeze([
  'no_pool_configured', 'reachable', 'simulated', 'unreachable',
]);

// Training meter is FUNDAMENTALLY different from inference meter:
//   - inference is per-1k-tokens (continuous, low-amplitude)
//   - training is per-gpu-hour (bursty, high-amplitude, single charge)
// Mixing them on one ledger is the bookkeeping trap that bit half the
// hyperscalers. Keep the rate table separate, document the unit, and
// emit a clearly-labeled meter row per run.
export const CLOUD_METER_RATES = Object.freeze({
  // USD per GPU-hour. Calibrated to mid-market managed-train pricing
  // (Together $1.20-2.00/hr H100, Modal $1.10/hr A100, Lambda $1.99/hr H100).
  // We expose the rate at the catalog level so the landing page can quote
  // honestly without reaching into Kolm's internal cost model.
  training_per_gpu_hour_usd: Object.freeze({
    'A100-40GB': 1.10,
    'A100-80GB': 1.65,
    'H100-80GB': 1.99,
    'H100-80GB-NVL': 2.40,
    'L40S-48GB': 1.10,
    'RTX-4090': 0.40,
    'RTX-5090': 0.55,
  }),
  // VRAM tier multipliers used when the chosen recipe needs higher
  // memory than the base SKU (e.g. context_tokens > 32k, batch > 8).
  vram_tier_multiplier: Object.freeze({
    '1x': 1.00,
    '2x': 1.85,  // sub-linear scaling - two GPUs share PCIe + scheduler overhead
    '4x': 3.50,
    '8x': 6.80,
  }),
  // Inference meter is documented here ONLY to make explicit that it is
  // a different ledger; the actual inference rates live in src/usage.js.
  inference_per_1k_tokens_usd_documented_in: 'src/usage.js',
  unit_training: 'gpu_hour',
  unit_inference: '1k_tokens',
});

// =============================================================================
// Filesystem layout
// =============================================================================

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _baseDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
}

function _jobsPath() {
  return path.join(_baseDir(), 'cloud-distill-jobs.jsonl');
}

function _meterPath() {
  return path.join(_baseDir(), 'cloud-distill-meter.jsonl');
}

function _ensureDir() {
  const dir = _baseDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _appendLine(p, row) {
  _ensureDir();
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
}

function _readLines(p) {
  if (!fs.existsSync(p)) return [];
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return rows;
}

// _findRowsForTenant - reads append-only jobs.jsonl, returns rows for one
// tenant with status transitions collapsed (last write per job_id wins).
// W411 defense-in-depth: per-row tenant_id check after the read.
function _findRowsForTenant(tenant) {
  const rows = _readLines(_jobsPath()).filter((r) => r && r.tenant_id === tenant);
  // Status transitions are appended as fresh rows sharing job_id; the most
  // recent row per job_id wins. Walk forward and overwrite.
  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.job_id) continue;
    byId.set(r.job_id, r);
  }
  // Newest first (createdAt descending).
  const out = Array.from(byId.values());
  out.sort((a, b) => {
    const ta = Date.parse(a.updated_at || a.created_at || '') || 0;
    const tb = Date.parse(b.updated_at || b.created_at || '') || 0;
    return tb - ta;
  });
  return out;
}

function _findOne(tenant, job_id) {
  if (!tenant || !job_id) return null;
  return _findRowsForTenant(tenant).find((r) => r.job_id === job_id) || null;
}

function _now() { return new Date().toISOString(); }
function _newJobId() { return 'cdj_' + crypto.randomBytes(8).toString('hex'); }

// _backendStatus - the honesty check. Returns the current backend status
// based on env vars + opts (DI seam for tests). If KOLM_CLOUD_DISTILL_ENDPOINT
// is unset, status is 'no_pool_configured' and submitJob will queue the work
// but flag it openly. If the env var is set to 'simulated://...', we surface
// 'simulated' so tests + dev can route work without pretending it ran.
export function getCloudBackendStatus(opts) {
  const o = opts || {};
  const explicit = (typeof o.backend_endpoint === 'string' && o.backend_endpoint)
    ? o.backend_endpoint
    : (process.env.KOLM_CLOUD_DISTILL_ENDPOINT || '');
  if (!explicit) {
    return {
      status: 'no_pool_configured',
      endpoint: null,
      hint: 'set KOLM_CLOUD_DISTILL_ENDPOINT to enable the managed pool',
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (explicit.startsWith('simulated://')) {
    return {
      status: 'simulated',
      endpoint: explicit,
      hint: 'simulated backend - jobs lifecycle is in-process only',
      version: CLOUD_DISTILL_VERSION,
    };
  }
  return {
    status: 'reachable',
    endpoint: explicit,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// submitJob
//
// Creates a queued job row. Returns the job_id + initial meter row + the
// honest backend status. The job remains in 'queued' state until either
//   (a) a real backend POSTs a /v1/cloud/distill/:job_id status update, or
//   (b) advanceJobState is called locally (for tests / simulated backends).
// =============================================================================
export function submitJob(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : 'default';
  const capture_window = (typeof o.capture_window === 'string' && o.capture_window)
    ? o.capture_window
    : '7d';
  const recipe_id = (typeof o.recipe_id === 'string' && o.recipe_id)
    ? o.recipe_id
    : 'default-distill';
  const billing_token = (typeof o.billing_token === 'string' && o.billing_token)
    ? o.billing_token
    : null;
  // Optional cost-quote knobs. We do NOT charge here - submitJob is
  // 'reserve a slot'. The actual meter row is written by meterRun once
  // the backend reports gpu_seconds.
  const gpu_sku = (typeof o.gpu_sku === 'string' && o.gpu_sku) ? o.gpu_sku : 'H100-80GB';
  const vram_tier = (typeof o.vram_tier === 'string' && o.vram_tier) ? o.vram_tier : '1x';

  if (!CLOUD_METER_RATES.training_per_gpu_hour_usd[gpu_sku]) {
    return {
      ok: false,
      error: 'unknown_gpu_sku',
      hint: 'gpu_sku must be one of ' + Object.keys(CLOUD_METER_RATES.training_per_gpu_hour_usd).join(','),
      supported: Object.keys(CLOUD_METER_RATES.training_per_gpu_hour_usd),
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (!CLOUD_METER_RATES.vram_tier_multiplier[vram_tier]) {
    return {
      ok: false,
      error: 'unknown_vram_tier',
      hint: 'vram_tier must be one of ' + Object.keys(CLOUD_METER_RATES.vram_tier_multiplier).join(','),
      supported: Object.keys(CLOUD_METER_RATES.vram_tier_multiplier),
      version: CLOUD_DISTILL_VERSION,
    };
  }

  const backend = getCloudBackendStatus(o);
  const now = _now();
  const job_id = _newJobId();
  const scheduler_idempotency_key = (typeof o.idempotency_key === 'string' && o.idempotency_key)
    ? o.idempotency_key
    : null;
  const scheduler = submitSchedulerJob({
    tenant,
    family: 'cloud-distill',
    operation: 'distill',
    idempotency_key: scheduler_idempotency_key,
    priority: o.priority || o.plan_tier,
    lane: backend.status === 'no_pool_configured' ? 'managed-distill-pool-unconfigured' : 'managed-distill-pool',
    estimated_cost_usd: o.estimated_cost_usd,
    budget_usd: o.budget_usd,
    max_attempts: o.max_attempts || 3,
    payload: {
      namespace,
      capture_window,
      recipe_id,
      gpu_sku,
      vram_tier,
      cloud_backend_status: backend.status,
      cloud_backend_endpoint: backend.endpoint,
    },
    labels: {
      source: 'cloud-distill',
      backend_status: backend.status,
    },
    lineage: {
      cloud_distill_job_id: job_id,
      meter_ledger: 'training',
    },
  });
  if (!scheduler.ok) {
    return {
      ok: false,
      error: scheduler.error || 'scheduler_rejected',
      scheduler,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (scheduler.idempotent_replay) {
    const existing_id = scheduler.job?.lineage?.cloud_distill_job_id || null;
    const existing = existing_id ? _findOne(tenant, existing_id) : null;
    if (existing) {
      return {
        ok: true,
        created: false,
        idempotent_replay: true,
        job_id: existing.job_id,
        state: existing.state,
        cloud_backend_status: existing.cloud_backend_status,
        cloud_backend_endpoint: existing.cloud_backend_endpoint,
        scheduler_job_id: scheduler.job_id,
        scheduler_state: scheduler.job?.state || null,
        namespace: existing.namespace,
        capture_window: existing.capture_window,
        recipe_id: existing.recipe_id,
        gpu_sku: existing.gpu_sku,
        vram_tier: existing.vram_tier,
        rate_per_gpu_hour_usd: CLOUD_METER_RATES.training_per_gpu_hour_usd[existing.gpu_sku]
          * CLOUD_METER_RATES.vram_tier_multiplier[existing.vram_tier],
        created_at: existing.created_at,
        version: CLOUD_DISTILL_VERSION,
      };
    }
  }
  const row = {
    job_id,
    tenant_id: tenant,
    namespace,
    capture_window,
    recipe_id,
    billing_token,  // we never echo back the secret; persisted for audit only
    gpu_sku,
    vram_tier,
    state: 'queued',
    cloud_backend_status: backend.status,
    cloud_backend_endpoint: backend.endpoint,
    scheduler_job_id: scheduler.job_id,
    scheduler_state: scheduler.job?.state || 'queued',
    artifact_url: null,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
    submitted_by: typeof o.submitted_by === 'string' ? o.submitted_by : tenant,
    version: CLOUD_DISTILL_VERSION,
  };
  _appendLine(_jobsPath(), row);

  // Initial meter row - $0 reserved, units to be filled in by meterRun once
  // the backend reports gpu_seconds. We write this NOW so the meter ledger
  // is paired 1:1 with the job ledger from the start (auditability).
  const meter_initial = {
    job_id: row.job_id,
    tenant_id: tenant,
    namespace,
    kind: 'training_reservation',
    gpu_sku,
    vram_tier,
    gpu_seconds: 0,
    cost_usd: 0,
    rate_per_gpu_hour_usd: CLOUD_METER_RATES.training_per_gpu_hour_usd[gpu_sku]
      * CLOUD_METER_RATES.vram_tier_multiplier[vram_tier],
    ts: now,
    version: CLOUD_DISTILL_VERSION,
  };
  _appendLine(_meterPath(), meter_initial);

  return {
    ok: true,
    job_id: row.job_id,
    state: 'queued',
    cloud_backend_status: backend.status,
    cloud_backend_endpoint: backend.endpoint,
    scheduler_job_id: scheduler.job_id,
    scheduler_state: scheduler.job?.state || 'queued',
    meter_initial,
    namespace,
    capture_window,
    recipe_id,
    gpu_sku,
    vram_tier,
    rate_per_gpu_hour_usd: meter_initial.rate_per_gpu_hour_usd,
    created_at: now,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// getJobStatus
//
// Tenant-fenced read. Returns the latest row for one job_id or
// {ok:false, error:'not_found'}. Foreign-tenant lookups return not_found
// (never reveal that a job exists under another tenant).
// =============================================================================
export function getJobStatus(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const row = _findOne(tenant, job_id);
  if (!row) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  return {
    ok: true,
    job_id,
    tenant_id: row.tenant_id,
    namespace: row.namespace,
    state: row.state,
    cloud_backend_status: row.cloud_backend_status,
    cloud_backend_endpoint: row.cloud_backend_endpoint,
    scheduler_job_id: row.scheduler_job_id || null,
    scheduler_state: row.scheduler_state || null,
    artifact_url: row.artifact_url,
    error: row.error,
    gpu_sku: row.gpu_sku,
    vram_tier: row.vram_tier,
    capture_window: row.capture_window,
    recipe_id: row.recipe_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// cancelJob
//
// Tenant-fenced. Cancels a queued/running job by appending a cancelled row.
// Cannot cancel terminal states (succeeded/failed/already-cancelled).
// =============================================================================
export function cancelJob(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const current = _findOne(tenant, job_id);
  if (!current) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled') {
    return {
      ok: false,
      error: 'invalid_transition',
      hint: 'job is already ' + current.state + '; only queued or running jobs can be cancelled',
      current_state: current.state,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const now = _now();
  const reason = (typeof o.reason === 'string' && o.reason) ? o.reason.slice(0, 500) : '';
  const next = Object.assign({}, current, {
    state: 'cancelled',
    updated_at: now,
    finished_at: now,
    cancel_reason: reason,
  });
  _appendLine(_jobsPath(), next);
  if (current.scheduler_job_id) {
    try {
      cancelSchedulerJob({
        tenant,
        job_id: current.scheduler_job_id,
        reason,
      });
    } catch (_) {
      // The cloud-distill cancellation remains authoritative for this ledger;
      // scheduler cancellation is best-effort if the scheduler file was pruned.
    }
  }
  return {
    ok: true,
    job_id,
    state: 'cancelled',
    cancelled_at: now,
    reason,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// listJobs
//
// Tenant-fenced list with optional status + namespace filter + limit. Newest
// first. status filter must be one of CLOUD_DISTILL_STATES.
// =============================================================================
export function listJobs(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const status = (typeof o.status === 'string' && o.status) ? o.status : null;
  if (status && !CLOUD_DISTILL_STATES.includes(status)) {
    return {
      ok: false,
      error: 'invalid_status_filter',
      hint: 'status must be one of ' + CLOUD_DISTILL_STATES.join(','),
      supported: CLOUD_DISTILL_STATES,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : null;
  const limitRaw = Number(o.limit);
  const limit = (Number.isFinite(limitRaw) && limitRaw > 0)
    ? Math.min(500, Math.trunc(limitRaw))
    : 100;

  let rows = _findRowsForTenant(tenant);
  if (namespace) rows = rows.filter((r) => r.namespace === namespace);
  if (status) rows = rows.filter((r) => r.state === status);
  const sliced = rows.slice(0, limit);
  return {
    ok: true,
    tenant_id: tenant,
    count: sliced.length,
    total_for_tenant: rows.length,
    status_filter: status,
    namespace_filter: namespace,
    jobs: sliced,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// meterRun
//
// Append a meter row for a completed (or partial) run. Computes cost from
// gpu_seconds * rate_per_gpu_hour. Tenant-fenced. NEVER auto-charges - this
// is a ledger write only; downstream billing reconciles against it.
//
// Charges are kept SEPARATE from inference meter (src/usage.js) so a finance
// team can pivot training spend vs inference spend without re-categorizing.
// =============================================================================
export function meterRun(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const gpu_seconds_raw = Number(o.gpu_seconds);
  if (!Number.isFinite(gpu_seconds_raw) || gpu_seconds_raw < 0) {
    return {
      ok: false,
      error: 'invalid_gpu_seconds',
      hint: 'gpu_seconds must be a non-negative number',
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const job = _findOne(tenant, job_id);
  if (!job) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  const rate = CLOUD_METER_RATES.training_per_gpu_hour_usd[job.gpu_sku]
    * CLOUD_METER_RATES.vram_tier_multiplier[job.vram_tier];
  const cost_usd = (gpu_seconds_raw / 3600) * rate;

  // vram_gb is informational - we record it but do not charge on it
  // separately (cost is gpu_sku * vram_tier * gpu_seconds).
  const vram_gb_raw = Number(o.vram_gb);
  const vram_gb = Number.isFinite(vram_gb_raw) ? vram_gb_raw : null;

  const row = {
    job_id,
    tenant_id: tenant,
    namespace: job.namespace,
    kind: 'training_run',
    gpu_sku: job.gpu_sku,
    vram_tier: job.vram_tier,
    gpu_seconds: gpu_seconds_raw,
    vram_gb,
    cost_usd,
    rate_per_gpu_hour_usd: rate,
    ts: _now(),
    version: CLOUD_DISTILL_VERSION,
  };
  _appendLine(_meterPath(), row);
  return {
    ok: true,
    job_id,
    gpu_seconds: gpu_seconds_raw,
    vram_gb,
    cost_usd,
    rate_per_gpu_hour_usd: rate,
    unit: CLOUD_METER_RATES.unit_training,
    ledger: 'training',  // explicit separator from 'inference' ledger
    ts: row.ts,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// readMeter
//
// Tenant-fenced read of all meter rows for one job. Returns the aggregate
// (sum of cost_usd + sum of gpu_seconds) so the dashboard can show
// "spent so far: $4.12 over 12 GPU-min".
// =============================================================================
export function readMeter(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  // Tenant fence: only count rows whose tenant_id matches AND whose job_id matches.
  const rows = _readLines(_meterPath()).filter((r) =>
    r && r.tenant_id === tenant && r.job_id === job_id);
  let total_gpu_seconds = 0;
  let total_cost_usd = 0;
  for (const r of rows) {
    total_gpu_seconds += Number(r.gpu_seconds) || 0;
    total_cost_usd += Number(r.cost_usd) || 0;
  }
  return {
    ok: true,
    job_id,
    rows,
    total_gpu_seconds,
    total_cost_usd,
    unit: CLOUD_METER_RATES.unit_training,
    ledger: 'training',
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// advanceJobState
//
// Test seam + simulated-backend hook. The real backend pushes status via
// HTTP; for now we expose this so tests can drive the lifecycle. Tenant-fenced.
// =============================================================================
export function advanceJobState(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const next_state = (typeof o.state === 'string' && o.state) ? o.state : null;
  if (!next_state || !CLOUD_DISTILL_STATES.includes(next_state)) {
    return {
      ok: false,
      error: 'invalid_state',
      hint: 'state must be one of ' + CLOUD_DISTILL_STATES.join(','),
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const current = _findOne(tenant, job_id);
  if (!current) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  const now = _now();
  const next = Object.assign({}, current, {
    state: next_state,
    updated_at: now,
    started_at: current.started_at || (next_state === 'running' ? now : current.started_at),
    finished_at: (next_state === 'succeeded' || next_state === 'failed' || next_state === 'cancelled')
      ? now
      : current.finished_at,
    artifact_url: typeof o.artifact_url === 'string' ? o.artifact_url : current.artifact_url,
    error: typeof o.error === 'string' ? o.error : current.error,
    scheduler_state: next_state === 'running'
      ? 'running'
      : (next_state === 'succeeded' ? 'succeeded'
        : (next_state === 'failed' ? 'dead_letter'
          : (next_state === 'cancelled' ? 'cancelled' : current.scheduler_state))),
  });
  _appendLine(_jobsPath(), next);
  if (current.scheduler_job_id) {
    const schedulerState = next_state === 'failed' ? 'dead_letter' : next.scheduler_state;
    try {
      advanceSchedulerJobState({
        tenant,
        job_id: current.scheduler_job_id,
        state: schedulerState,
        result: next_state === 'succeeded' ? { artifact_url: next.artifact_url } : null,
        error: next.error || null,
        reason: 'cloud_distill_state_update',
      });
    } catch (_) {
      // Keep the cloud-distill transition append-only even if the scheduler
      // file was pruned or repaired separately.
    }
  }
  return {
    ok: true,
    job_id,
    state: next_state,
    updated_at: now,
    version: CLOUD_DISTILL_VERSION,
  };
}

// Reset hook for tests - wipes only the W785 ledgers, never the broader
// .kolm data dir.
export function _resetForTests() {
  for (const p of [_jobsPath(), _meterPath()]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try { _resetSchedulerForTests(); } catch { /* ignore */ }
}

export default {
  CLOUD_DISTILL_VERSION,
  CLOUD_DISTILL_STATES,
  CLOUD_BACKEND_STATUSES,
  CLOUD_METER_RATES,
  getCloudBackendStatus,
  submitJob,
  getJobStatus,
  cancelJob,
  listJobs,
  meterRun,
  readMeter,
  advanceJobState,
  _resetForTests,
};
