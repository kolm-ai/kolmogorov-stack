// W782 - Team approval workflow for distillation.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 716-720):
//   [W782-1] Distillation requires manager sign-off in regulated environments
//            -> requestApproval / approveApproval / rejectApproval
//   [W782-2] Webhook/email notify -> notifyApprovers
//   [W782-3] /account/approvals.html -> dashboard
//
// Design contract:
//   - Storage uses src/store.js insert/findByField for `distill_approvals` table.
//     We do NOT use findByTenant because some legacy rows on disk may have
//     `tenant_id` (canonical) but the index field is 'tenant'. Per-row filter
//     (W411 defense-in-depth) over findByField('distill_approvals','tenant_id',t).
//   - Status transitions are: pending -> granted | rejected | expired.
//     Double-approval (approving an already-granted row) returns
//     {ok:false, error:'invalid_transition'} - never silently rewrites state.
//   - notifyApprovers is best-effort. Missing webhook/email config returns
//     a per-channel honest envelope; we NEVER throw on a missing channel
//     since the approval row is the source of truth for whether work proceeds.
//   - W604 anti-brittleness: consumers match /^w782-/ on the version stamp.
//
// Public surface:
//   - APPROVAL_QUEUE_VERSION
//   - APPROVAL_STATUSES (frozen tuple)
//   - APPROVAL_TABLE name constant
//   - requestApproval, listApprovals, approveApproval, rejectApproval
//   - getApprovalStatus, notifyApprovers
//   - _resetForTests (test seam)

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as defaultStoreMod from './store.js';

export const APPROVAL_QUEUE_VERSION = 'w782-v1';

// Closed set of legal statuses. Frozen so a refactor cannot quietly add
// a new state without bumping the version stamp.
export const APPROVAL_STATUSES = Object.freeze(['pending', 'granted', 'rejected', 'expired']);

// Single point of change if the table name ever needs to migrate.
export const APPROVAL_TABLE = 'distill_approvals';

// Default approval window in days. After this, the row is considered
// expired and the approver action returns invalid_transition. The
// requester can re-submit; we never silently flip pending to expired
// without a new request.
const DEFAULT_TTL_DAYS = 30;

// Notification channels we know how to dispatch on. Adding a new channel
// requires extending dispatchChannel + the notifyApprovers fan-out.
const CHANNELS = Object.freeze(['webhook', 'email']);

// Best-effort webhook timeout. 5s is enough for slack/teams/pagerduty
// inbound webhooks without holding the request thread hostage if the
// target is dead.
const WEBHOOK_TIMEOUT_MS = 5000;

// In-memory bus for tests + same-process listeners. Production callers
// should poll the GET /v1/approvals route rather than rely on this.
let _testStoreOverride = null;

export function _resetForTests(opts) {
  if (opts && opts.storeMod) {
    _testStoreOverride = opts.storeMod;
  } else {
    _testStoreOverride = null;
  }
}

function _store() {
  return _testStoreOverride || defaultStoreMod;
}

function _now() {
  return new Date().toISOString();
}

function _newId() {
  return 'appr_' + crypto.randomBytes(8).toString('hex');
}

// Read approvals for one tenant, with optional status_filter. Uses
// findByField to leverage the SQLite expression index when present, then
// per-row tenant fence (defense-in-depth).
//
// Status transitions append fresh rows that share id with the original
// pending row; we dedup by id keeping only the most-recent row per id BEFORE
// applying status_filter, otherwise filtering for status='pending' would
// pick up the stale pending sibling of an already-granted row.
function _findRowsForTenant(tenant, status_filter) {
  const store = _store();
  let rows = [];
  if (typeof store.findByField === 'function') {
    rows = store.findByField(APPROVAL_TABLE, 'tenant_id', tenant) || [];
  } else if (typeof store.all === 'function') {
    rows = (store.all(APPROVAL_TABLE) || []).filter((r) => r && r.tenant_id === tenant);
  } else {
    return [];
  }
  // W411 defense-in-depth: per-row tenant fence so a future schema change
  // cannot leak across tenants.
  rows = rows.filter((r) => r && r.tenant_id === tenant);
  // Newest first. Status-transition rows are copies of the pending row with
  // requested_at preserved; tiebreak by the most-recent transition timestamp
  // (granted_at / rejected_at / expired_at) so a granted row sorts ahead of
  // its pending sibling even when they share requested_at.
  function _rowTs(r) {
    const ts = Math.max(
      Date.parse(r && r.expired_at || '') || 0,
      Date.parse(r && r.granted_at || '') || 0,
      Date.parse(r && r.rejected_at || '') || 0,
      Date.parse(r && r.requested_at || '') || 0
    );
    return ts;
  }
  // Non-pending statuses always outrank pending for the same row id (terminal
  // states "win" against the original pending row even when ms timestamps
  // collide under a fast clock).
  function _statusRank(r) {
    return (r && r.status === 'pending') ? 0 : 1;
  }
  rows.sort((a, b) => {
    const ts = _rowTs(b) - _rowTs(a);
    if (ts !== 0) return ts;
    return _statusRank(b) - _statusRank(a);
  });
  // Dedup by id keeping the most-recent row per id (already sorted desc).
  // Filter by status AFTER dedup so e.g. a granted row hides its stale
  // pending sibling from a status='pending' query.
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deduped.push(r);
  }
  if (status_filter) {
    const wanted = String(status_filter).toLowerCase();
    return deduped.filter((r) => String(r.status || '').toLowerCase() === wanted);
  }
  return deduped;
}

function _findOne(tenant, approval_id) {
  const rows = _findRowsForTenant(tenant);
  return rows.find((r) => r && r.id === approval_id) || null;
}

function _persist(row) {
  const store = _store();
  if (typeof store.insert !== 'function') {
    throw new Error('store.insert is not wired - cannot persist approval row');
  }
  // We rely on store.insert appending. For status transitions we re-insert
  // a fresh row carrying the new status; the read layer always sorts
  // descending and the most recent row wins via the find-first semantic.
  store.insert(APPROVAL_TABLE, row);
  return row;
}

// =============================================================================
// requestApproval
//
// Creates a pending approval row. Returns {ok, approval_id, status} or
// honest envelope on bad input.
// =============================================================================
export function requestApproval(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const artifact_id = (typeof o.artifact_id === 'string' && o.artifact_id) ? o.artifact_id : null;
  if (!artifact_id) {
    return {
      ok: false,
      error: 'artifact_id_required',
      hint: 'pass {artifact_id} naming the artifact / run that needs sign-off',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : 'default';
  const requested_by = (typeof o.requested_by === 'string' && o.requested_by) ? o.requested_by : null;
  if (!requested_by) {
    return {
      ok: false,
      error: 'requested_by_required',
      hint: 'pass {requested_by} naming the user / actor id',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 1000) : '';
  const ttlDaysRaw = Number(o.ttl_days);
  const ttl_days = (Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0)
    ? Math.min(365, Math.trunc(ttlDaysRaw))
    : DEFAULT_TTL_DAYS;
  const now = _now();
  const expires_at = new Date(Date.now() + ttl_days * 86400 * 1000).toISOString();

  const row = {
    id: _newId(),
    tenant_id: tenant,
    namespace,
    artifact_id,
    requested_by,
    reason,
    status: 'pending',
    requested_at: now,
    granted_at: null,
    rejected_at: null,
    approver_id: null,
    approver_reason: null,
    expires_at,
    ttl_days,
    version: APPROVAL_QUEUE_VERSION,
  };
  _persist(row);
  return {
    ok: true,
    approval_id: row.id,
    status: 'pending',
    expires_at,
    tenant_id: tenant,
    namespace,
    artifact_id,
    requested_at: now,
    version: APPROVAL_QUEUE_VERSION,
  };
}

// =============================================================================
// listApprovals
//
// Tenant-fenced list with optional status filter. Newest first.
// =============================================================================
export function listApprovals(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const status_filter = (typeof o.status_filter === 'string' && o.status_filter) ? o.status_filter : null;
  if (status_filter && !APPROVAL_STATUSES.includes(status_filter)) {
    return {
      ok: false,
      error: 'invalid_status_filter',
      hint: 'status_filter must be one of ' + APPROVAL_STATUSES.join(','),
      supported: APPROVAL_STATUSES,
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const rows = _findRowsForTenant(tenant, status_filter);
  // Deduplicate by id: keep only the most recent row per approval_id
  // (status transitions append new rows; the read layer always picks
  // the freshest one). The list is already sorted newest first, so
  // walking it once is enough.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return {
    ok: true,
    tenant_id: tenant,
    count: out.length,
    status_filter,
    approvals: out,
    version: APPROVAL_QUEUE_VERSION,
  };
}

// =============================================================================
// approveApproval
//
// Transitions a pending row to granted. Double-approval is rejected with
// honest envelope.
// =============================================================================
export function approveApproval(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: APPROVAL_QUEUE_VERSION };
  }
  const approval_id = (typeof o.approval_id === 'string' && o.approval_id) ? o.approval_id : null;
  if (!approval_id) {
    return { ok: false, error: 'approval_id_required', version: APPROVAL_QUEUE_VERSION };
  }
  const approved_by = (typeof o.approved_by === 'string' && o.approved_by) ? o.approved_by : null;
  if (!approved_by) {
    return {
      ok: false,
      error: 'approved_by_required',
      hint: 'pass {approved_by} naming the manager / actor id',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const current = _findOne(tenant, approval_id);
  if (!current) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'approval_id does not exist for this tenant',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  if (current.status !== 'pending') {
    return {
      ok: false,
      error: 'invalid_transition',
      hint: 'approval is already ' + current.status + '; only pending rows can be granted',
      current_status: current.status,
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  // Check expiry.
  if (current.expires_at && Date.now() > Date.parse(current.expires_at)) {
    // Mark expired durably so the next list reflects reality.
    _persist(Object.assign({}, current, {
      status: 'expired',
      expired_at: _now(),
    }));
    return {
      ok: false,
      error: 'expired',
      hint: 'approval window passed; requester must re-submit',
      current_status: 'expired',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const now = _now();
  const row = Object.assign({}, current, {
    status: 'granted',
    granted_at: now,
    approver_id: approved_by,
    approver_reason: (typeof o.reason === 'string' ? o.reason.slice(0, 1000) : ''),
  });
  _persist(row);
  return {
    ok: true,
    approval_id,
    status: 'granted',
    granted_at: now,
    approver_id: approved_by,
    version: APPROVAL_QUEUE_VERSION,
  };
}

// =============================================================================
// rejectApproval
//
// Transitions a pending row to rejected. Rejection reason is required
// because it lands on the audit trail.
// =============================================================================
export function rejectApproval(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: APPROVAL_QUEUE_VERSION };
  }
  const approval_id = (typeof o.approval_id === 'string' && o.approval_id) ? o.approval_id : null;
  if (!approval_id) {
    return { ok: false, error: 'approval_id_required', version: APPROVAL_QUEUE_VERSION };
  }
  const rejected_by = (typeof o.rejected_by === 'string' && o.rejected_by) ? o.rejected_by : null;
  if (!rejected_by) {
    return {
      ok: false,
      error: 'rejected_by_required',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const reason = (typeof o.reason === 'string' && o.reason) ? o.reason.slice(0, 1000) : '';
  if (!reason) {
    return {
      ok: false,
      error: 'reason_required',
      hint: 'rejection requires a written reason for audit',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const current = _findOne(tenant, approval_id);
  if (!current) {
    return { ok: false, error: 'not_found', version: APPROVAL_QUEUE_VERSION };
  }
  if (current.status !== 'pending') {
    return {
      ok: false,
      error: 'invalid_transition',
      hint: 'approval is already ' + current.status + '; only pending rows can be rejected',
      current_status: current.status,
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const now = _now();
  const row = Object.assign({}, current, {
    status: 'rejected',
    rejected_at: now,
    approver_id: rejected_by,
    approver_reason: reason,
  });
  _persist(row);
  return {
    ok: true,
    approval_id,
    status: 'rejected',
    rejected_at: now,
    approver_id: rejected_by,
    reason,
    version: APPROVAL_QUEUE_VERSION,
  };
}

// =============================================================================
// getApprovalStatus
//
// Returns the latest snapshot for a single approval id, tenant-fenced.
// =============================================================================
export function getApprovalStatus(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: APPROVAL_QUEUE_VERSION };
  }
  const approval_id = (typeof o.approval_id === 'string' && o.approval_id) ? o.approval_id : null;
  if (!approval_id) {
    return { ok: false, error: 'approval_id_required', version: APPROVAL_QUEUE_VERSION };
  }
  const row = _findOne(tenant, approval_id);
  if (!row) {
    return { ok: false, error: 'not_found', version: APPROVAL_QUEUE_VERSION };
  }
  return {
    ok: true,
    approval_id,
    status: row.status,
    tenant_id: row.tenant_id,
    namespace: row.namespace,
    artifact_id: row.artifact_id,
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    granted_at: row.granted_at,
    rejected_at: row.rejected_at,
    approver_id: row.approver_id,
    approver_reason: row.approver_reason,
    expires_at: row.expires_at,
    version: APPROVAL_QUEUE_VERSION,
  };
}

// =============================================================================
// notifyApprovers
//
// Best-effort dispatch over configured channels. Per-channel envelope
// surfaces the success/failure of each independently. NEVER throws on
// missing channel config - the dashboard reads the per-channel envelope
// to decide what to retry.
//
// Channels:
//   - webhook: KOLM_WEBHOOK_URL (POST JSON envelope)
//   - email:   KOLM_EMAIL_NOTIFY_CMD (spawn with payload JSON on stdin)
//
// DI seam: opts.spawnFn / opts.fetchFn override for tests.
// =============================================================================
export async function notifyApprovers(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: APPROVAL_QUEUE_VERSION };
  }
  const approval_id = (typeof o.approval_id === 'string' && o.approval_id) ? o.approval_id : null;
  if (!approval_id) {
    return { ok: false, error: 'approval_id_required', version: APPROVAL_QUEUE_VERSION };
  }
  const status = getApprovalStatus({ tenant, approval_id });
  if (!status.ok) return status;

  const channels = Array.isArray(o.channels) && o.channels.length > 0
    ? o.channels.map((c) => String(c).toLowerCase()).filter((c) => CHANNELS.includes(c))
    : CHANNELS.slice();

  const payload = {
    event: 'approval_notify',
    approval_id,
    status: status.status,
    tenant_id: tenant,
    namespace: status.namespace,
    artifact_id: status.artifact_id,
    requested_by: status.requested_by,
    requested_at: status.requested_at,
    timestamp: _now(),
    version: APPROVAL_QUEUE_VERSION,
  };

  const results = {};
  for (const ch of channels) {
    if (ch === 'webhook') {
      results.webhook = await _dispatchWebhook(payload, o);
    } else if (ch === 'email') {
      results.email = _dispatchEmail(payload, o);
    }
  }
  const anyOk = Object.values(results).some((r) => r && r.ok);
  return {
    ok: true, // notifyApprovers itself always succeeds; per-channel results
              // carry the truth. Returning ok:false on partial dispatch
              // would force callers to special-case "approval was granted
              // but only Slack got the ping" which is rarely the right
              // operational signal.
    approval_id,
    tenant_id: tenant,
    channels: results,
    any_dispatched: anyOk,
    version: APPROVAL_QUEUE_VERSION,
  };
}

async function _dispatchWebhook(payload, opts) {
  const url = process.env.KOLM_WEBHOOK_URL || (opts && opts.webhook_url) || null;
  if (!url) {
    return {
      ok: false,
      error: 'no_webhook_configured',
      hint: 'set KOLM_WEBHOOK_URL to enable webhook notifications',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const fetchFn = (opts && typeof opts.fetchFn === 'function') ? opts.fetchFn : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return {
      ok: false,
      error: 'fetch_unavailable',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, WEBHOOK_TIMEOUT_MS) : null; // deliberate: cleanup
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    const status = resp && typeof resp.status === 'number' ? resp.status : 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      version: APPROVAL_QUEUE_VERSION,
    };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return {
      ok: false,
      error: 'webhook_dispatch_failed',
      detail: String((e && e.message) || e),
      url,
      version: APPROVAL_QUEUE_VERSION,
    };
  }
}

function _dispatchEmail(payload, opts) {
  const cmd = process.env.KOLM_EMAIL_NOTIFY_CMD || (opts && opts.email_cmd) || null;
  if (!cmd) {
    return {
      ok: false,
      error: 'no_email_configured',
      hint: 'set KOLM_EMAIL_NOTIFY_CMD to a script that reads payload JSON on stdin',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  const spawnFn = (opts && typeof opts.spawnFn === 'function') ? opts.spawnFn : spawnSync;
  let argv;
  try {
    argv = JSON.parse(cmd);
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('not_array');
  } catch (_) {
    // Treat as a shell-style argv split on whitespace (best-effort, no
    // quoting; production users should pass JSON arrays).
    argv = String(cmd).split(/\s+/).filter(Boolean);
  }
  if (argv.length === 0) {
    return {
      ok: false,
      error: 'email_cmd_empty',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  let result;
  try {
    result = spawnFn(argv[0], argv.slice(1), {
      input: JSON.stringify(payload),
      timeout: WEBHOOK_TIMEOUT_MS,
      encoding: 'utf8',
    });
  } catch (e) {
    return {
      ok: false,
      error: 'email_spawn_failed',
      detail: String((e && e.message) || e),
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  if (!result) {
    return {
      ok: false,
      error: 'email_spawn_no_result',
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  if (result.error) {
    return {
      ok: false,
      error: 'email_spawn_failed',
      detail: String((result.error && result.error.message) || result.error),
      version: APPROVAL_QUEUE_VERSION,
    };
  }
  return {
    ok: result.status === 0,
    exit_code: result.status,
    stdout_chars: typeof result.stdout === 'string' ? result.stdout.length : 0,
    stderr_chars: typeof result.stderr === 'string' ? result.stderr.length : 0,
    version: APPROVAL_QUEUE_VERSION,
  };
}

export const DEFAULTS = Object.freeze({
  TTL_DAYS: DEFAULT_TTL_DAYS,
  WEBHOOK_TIMEOUT_MS,
  CHANNELS,
});

export default {
  APPROVAL_QUEUE_VERSION,
  APPROVAL_STATUSES,
  APPROVAL_TABLE,
  requestApproval,
  listApprovals,
  approveApproval,
  rejectApproval,
  getApprovalStatus,
  notifyApprovers,
  _resetForTests,
};
