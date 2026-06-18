// src/audit-retention.js
//
// W767-3 - Audit-log retention extension to 12 months (SOC 2 Type II requirement).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 596-601):
//   [W767-3] Audit-log retention extension to 12 months (Type II requirement)
//
// SOC 2 Type II evidence sampling windows assume 12 months of audit data
// available for the audit period. The Trust Services Criteria themselves do
// not pin a numeric floor, but every CPA firm we have spoken with bakes in a
// 365-day operating-effectiveness window. We therefore promote the kolm
// default audit-event retention from "indefinite append-only with no policy"
// to a configurable [MIN..MAX] window where:
//
//   MIN = 90 days   (SOC 2 Type I evidence-window floor commonly cited)
//   DEFAULT = 365 days (SOC 2 Type II operating-effectiveness window)
//   MAX = 2555 days (~7y; matches HIPAA + GDPR right-to-erasure exception cases)
//
// Honesty contract:
//   - getRetentionStatus on missing tenant returns ok:false 'tenant_required'.
//     NEVER fabricates a status row.
//   - enforceRetentionPolicy DEFAULTS to dry-run (opts.dry_run=true) and
//     RETURNS a count of would-be-evicted events. Live eviction requires
//     opts.confirm:true PLUS opts.dry_run:false. Anything else returns
//     {ok:false, error:'confirm_required'} - destruction MUST be opt-in.
//   - Tenant-fenced everywhere - defense-in-depth W411: every row read or
//     count is re-filtered by tenant_id inside the helper even if the caller
//     already passed tenant_id as a query parameter.
//
// W696 hardening:
//   - every status/dry-run/live eviction envelope carries proof_version,
//     event_set_sha256, manifest_sha256, and a deterministic as_of seam
//     (opts.now / opts.now_ms / opts.now_iso) for audit replay.
//   - live eviction calls purgeEvents({tenant_id,before}) and caps reported
//     evicted_count to the tenant-fenced candidate set.
//   - event-store/persist errors are redacted before they leave the module.
//
// DI seam (test injection): the public functions accept an `opts.eventStore`
// to override the default import. Tests pass an in-memory fake; production
// code passes nothing and falls through to the real module.
//
// W604 anti-brittleness: version stamp matches /^w767-/ - callers MUST
// regex-match. Never literal-compare 'w767-v1'.

import crypto from 'node:crypto';
import * as defaultEventStore from './event-store.js';

export const AUDIT_RETENTION_VERSION = 'w767-v1';
export const AUDIT_RETENTION_PROOF_VERSION = 'w696-v1';

// SOC 2 Type II evidence window.
export const DEFAULT_RETENTION_DAYS = 365;

// SOC 2 Type I minimum. Any value below this is a compliance violation for
// orgs claiming Type I controls, so the setter rejects it.
export const MIN_RETENTION_DAYS = 90;

// 7-year ceiling - HIPAA + GDPR right-to-erasure exception cases. Going
// above 7y converts "audit log" into a forever-store which conflicts with
// the right-to-erasure principle of GDPR Art. 17.
export const MAX_RETENTION_DAYS = 2555;

// Provider tag for setRetentionDays override rows in the event-store. We
// re-use the event-store as a settings sink so the override survives daemon
// restarts and ships through the same audit chain as other tenant settings.
const PROVIDER_TAG = 'kolm_audit_retention';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|ghp|gho|ghs|ghu|ghr|xai|ya29|AIza)[_-][A-Za-z0-9_.-]{12,}\b/g,
  /\bks_[A-Za-z0-9_.-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|token|password)=)[^&#\s]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
]);

function _sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function _canonicalJson(value) {
  const seen = new WeakSet();
  const sort = (v) => {
    if (v == null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const key of Object.keys(v).sort()) out[key] = sort(v[key]);
    return out;
  };
  return JSON.stringify(sort(value));
}

function _sha256Json(value) {
  return _sha256(_canonicalJson(value));
}

function _safeText(value, maxChars = 240) {
  let s = String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  for (const pattern of SECRET_PATTERNS) {
    s = s.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string' && prefix.length > 0 && match.startsWith(prefix)) {
        return `${prefix}[redacted_secret]`;
      }
      return '[redacted_secret]';
    });
  }
  return s.slice(0, maxChars);
}

function _tenantId(value) {
  return (typeof value === 'string' && value.trim()) ? value.trim() : null;
}

function _nowMs(opts = {}) {
  const raw = opts.now_ms ?? opts.now ?? opts.now_iso;
  if (raw != null) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function _eventProofRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      event_id: r.event_id || r.id || null,
      tenant_id: r.tenant_id || null,
      namespace: r.namespace || null,
      provider: r.provider || null,
      created_at: r.created_at || null,
      request_hash: r.request_hash || null,
    }))
    .sort((a, b) => {
      const at = String(a.created_at || '').localeCompare(String(b.created_at || ''));
      if (at !== 0) return at;
      return String(a.event_id || '').localeCompare(String(b.event_id || ''));
    });
}

function _proofFields(kind, {
  tenant_id,
  days_configured,
  cutoff_at = null,
  as_of,
  rows = [],
  dry_run = null,
  evicted_count = null,
  would_evict_count = null,
  oldest_kept_at = null,
  remaining_candidate_count = null,
}) {
  const proofRows = _eventProofRows(rows);
  const event_set_sha256 = _sha256Json(proofRows);
  const manifest = {
    kind,
    version: AUDIT_RETENTION_VERSION,
    proof_version: AUDIT_RETENTION_PROOF_VERSION,
    tenant_id_sha256: _sha256(tenant_id),
    days_configured,
    cutoff_at,
    as_of,
    event_count: proofRows.length,
    event_set_sha256,
    dry_run,
    evicted_count,
    would_evict_count,
    oldest_kept_at,
    remaining_candidate_count,
  };
  const manifest_sha256 = _sha256Json(manifest);
  return {
    proof_version: AUDIT_RETENTION_PROOF_VERSION,
    event_set_sha256,
    manifest_sha256,
    proof: {
      algorithm: 'sha256',
      manifest,
      manifest_sha256,
      event_set_sha256,
    },
  };
}

function _errorEnvelope(error, extra = {}) {
  return {
    ok: false,
    error,
    version: AUDIT_RETENTION_VERSION,
    proof_version: AUDIT_RETENTION_PROOF_VERSION,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Read the runtime-effective retention floor from env. Returns DEFAULT when
// unset. Rejects (falls through to DEFAULT with a console.error in debug mode)
// when the parsed value is below MIN - never silently honors a sub-floor
// configuration because that would defeat the SOC 2 Type I claim.
// ---------------------------------------------------------------------------
export function getCurrentRetentionDays() {
  const raw = process.env.KOLM_AUDIT_RETENTION_DAYS;
  if (raw == null || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return DEFAULT_RETENTION_DAYS;
  }
  if (n < MIN_RETENTION_DAYS) {
    if (process.env.KOLM_AUDIT_DEBUG === '1') {
      console.error(`[audit-retention] KOLM_AUDIT_RETENTION_DAYS=${n} below MIN=${MIN_RETENTION_DAYS}; ignoring`);
    }
    return DEFAULT_RETENTION_DAYS;
  }
  if (n > MAX_RETENTION_DAYS) {
    if (process.env.KOLM_AUDIT_DEBUG === '1') {
      console.error(`[audit-retention] KOLM_AUDIT_RETENTION_DAYS=${n} above MAX=${MAX_RETENTION_DAYS}; clamping`);
    }
    return MAX_RETENTION_DAYS;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Persist a per-tenant retention override.
//
// We write a canonical event with provider=PROVIDER_TAG so the override
// survives daemon restarts AND is itself auditable (the audit trail records
// every retention-policy change). The latest row for the tenant is the
// effective policy.
//
// Validation:
//   - tenant_id required (no global-default writes from this entry point).
//   - days must be an integer in [MIN, MAX].
// ---------------------------------------------------------------------------
export async function setRetentionDays(tenant_id, days, opts = {}) {
  const tenant = _tenantId(tenant_id);
  if (!tenant) {
    return _errorEnvelope('tenant_required');
  }
  const n = Number(days);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return _errorEnvelope('days_invalid', {
      hint: `days must be an integer in [${MIN_RETENTION_DAYS}, ${MAX_RETENTION_DAYS}]`,
    });
  }
  if (n < MIN_RETENTION_DAYS) {
    return _errorEnvelope('days_below_min', {
      hint: `days=${n} below MIN_RETENTION_DAYS=${MIN_RETENTION_DAYS} (SOC 2 Type I floor)`,
    });
  }
  if (n > MAX_RETENTION_DAYS) {
    return _errorEnvelope('days_above_max', {
      hint: `days=${n} above MAX_RETENTION_DAYS=${MAX_RETENTION_DAYS} (~7y HIPAA/GDPR ceiling)`,
    });
  }
  const es = opts.eventStore || defaultEventStore;
  try {
    const ev = await es.appendEvent({
      tenant_id: tenant,
      namespace: 'system',
      provider: PROVIDER_TAG,
      model: 'config',
      status: 'ok',
      // Stash the configured days in request_hash for cheap retrieval (the
      // canonical event row has no free-form data field below ev.json, and
      // we want a downstream `listEvents` to pick the value out of a column
      // we already filter on. request_hash is a free string column the
      // event-store does not interpret.)
      request_hash: 'retention_days=' + n,
      estimated_cost_usd: 0,
      latency_ms: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
    });
    return {
      ok: true,
      version: AUDIT_RETENTION_VERSION,
      proof_version: AUDIT_RETENTION_PROOF_VERSION,
      tenant_id: tenant,
      days_configured: n,
      event_id: ev && ev.event_id,
    };
  } catch (e) {
    return _errorEnvelope('persist_failed', {
      detail: _safeText(e && e.message || e),
    });
  }
}

// ---------------------------------------------------------------------------
// Resolve the effective retention days for a tenant: most-recent override row
// wins; fall back to getCurrentRetentionDays() (env or DEFAULT).
//
// Tenant-fenced: even though we pass tenant_id to listEvents, we re-filter
// the result rows by tenant_id (defense-in-depth W411).
// ---------------------------------------------------------------------------
async function _resolveTenantDays(tenant_id, es) {
  const tenant = _tenantId(tenant_id);
  if (!tenant) return getCurrentRetentionDays();
  try {
    const rows = await es.listEvents({
      tenant_id: tenant,
      provider: PROVIDER_TAG,
      limit: 50,
      order: 'desc',
    });
    for (const ev of Array.isArray(rows) ? rows : []) {
      if (!ev || ev.tenant_id !== tenant) continue;
      if (!ev.request_hash || typeof ev.request_hash !== 'string') continue;
      const m = /^retention_days=(\d+)$/.exec(ev.request_hash);
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
      if (n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) continue;
      return n;
    }
  } catch (_) { // deliberate: cleanup
    // event-store unreachable - fall back to env/DEFAULT.
  }
  return getCurrentRetentionDays();
}

// ---------------------------------------------------------------------------
// getRetentionStatus(tenant_id) - read-only snapshot of the tenant's
// effective retention policy plus the audit-event volume currently in that
// window.
//
// Returns:
//   {
//     ok: true,
//     version,
//     tenant_id,
//     days_configured: <effective days>,
//     days_default: DEFAULT_RETENTION_DAYS,
//     days_min: MIN_RETENTION_DAYS,
//     days_max: MAX_RETENTION_DAYS,
//     expires_after_days: <same as days_configured>,
//     total_audit_events_in_window: <integer>,
//     oldest_event_at: <ISO string or null>,
//     newest_event_at: <ISO string or null>,
//     compliance_floor_met: <true when days_configured >= DEFAULT_RETENTION_DAYS>
//   }
//
// HONEST: returns ok:false 'tenant_required' when tenant_id is missing/empty.
// NEVER fabricates a "global" status row - every retention policy is
// per-tenant.
// ---------------------------------------------------------------------------
export async function getRetentionStatus(tenant_id, opts = {}) {
  const tenant = _tenantId(tenant_id);
  if (!tenant) {
    return _errorEnvelope('tenant_required');
  }
  const es = opts.eventStore || defaultEventStore;
  const nowMs = _nowMs(opts);
  const as_of = new Date(nowMs).toISOString();
  const days_configured = await _resolveTenantDays(tenant, es);
  const days_default = DEFAULT_RETENTION_DAYS;
  const sinceMs = nowMs - days_configured * MS_PER_DAY;
  const sinceISO = new Date(sinceMs).toISOString();

  let rowsInWindow = [];
  let status_warning = null;
  try {
    rowsInWindow = await es.listEvents({
      tenant_id: tenant,
      since: sinceISO,
      limit: 0,
      order: 'asc',
    });
  } catch (e) {
    rowsInWindow = [];
    status_warning = 'event_store_unavailable';
  }
  // Defense in depth - re-filter by tenant_id even though listEvents already
  // accepted the filter (W411).
  rowsInWindow = (Array.isArray(rowsInWindow) ? rowsInWindow : [])
    .filter((r) => r && r.tenant_id === tenant);

  let oldest = null;
  let newest = null;
  for (const r of rowsInWindow) {
    const t = r && r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    if (oldest === null || t < Date.parse(oldest)) oldest = r.created_at;
    if (newest === null || t > Date.parse(newest)) newest = r.created_at;
  }

  const proof = _proofFields('audit_retention_status', {
    tenant_id: tenant,
    days_configured,
    cutoff_at: sinceISO,
    as_of,
    rows: rowsInWindow,
    oldest_kept_at: oldest,
  });

  return {
    ok: true,
    version: AUDIT_RETENTION_VERSION,
    proof_version: AUDIT_RETENTION_PROOF_VERSION,
    tenant_id: tenant,
    as_of,
    days_configured,
    days_default,
    days_min: MIN_RETENTION_DAYS,
    days_max: MAX_RETENTION_DAYS,
    expires_after_days: days_configured,
    total_audit_events_in_window: rowsInWindow.length,
    oldest_event_at: oldest,
    newest_event_at: newest,
    compliance_floor_met: days_configured >= DEFAULT_RETENTION_DAYS,
    status_warning,
    ...proof,
  };
}

// ---------------------------------------------------------------------------
// enforceRetentionPolicy(tenant_id, opts) - count events that have aged past
// the tenant's retention window and (in live mode) evict them.
//
// Defaults:
//   - dry_run = true       (NEVER evicts by default)
//   - confirm = false      (live mode requires explicit confirm:true)
//
// Returns one of:
//
//   {ok:false, error:'tenant_required', version}
//
//   {ok:true, version, dry_run:true, would_evict_count, oldest_kept_at,
//    cutoff_at, tenant_id}
//
//   {ok:false, error:'confirm_required', version,
//    hint:'pass {confirm:true, dry_run:false} to perform a live eviction'}
//
//   {ok:true, version, dry_run:false, evicted_count, oldest_kept_at,
//    cutoff_at, tenant_id}                       ← only when confirm:true
//
// Honesty invariants:
//   - dry_run NEVER calls a delete primitive.
//   - confirm:true alone (without dry_run:false) is still a dry run - we
//     require BOTH flags so an accidental confirm cannot trigger destruction.
// ---------------------------------------------------------------------------
export async function enforceRetentionPolicy(tenant_id, opts = {}) {
  const tenant = _tenantId(tenant_id);
  if (!tenant) {
    return _errorEnvelope('tenant_required');
  }
  const es = opts.eventStore || defaultEventStore;
  // The default must be a dry run. Live mode is opt-in.
  const dry_run = opts.dry_run === false ? false : true;
  const confirm = opts.confirm === true;

  const nowMs = _nowMs(opts);
  const as_of = new Date(nowMs).toISOString();
  const days = await _resolveTenantDays(tenant, es);
  const cutoffMs = nowMs - days * MS_PER_DAY;
  const cutoffISO = new Date(cutoffMs).toISOString();

  let rows = [];
  try {
    rows = await es.listEvents({
      tenant_id: tenant,
      until: cutoffISO,
      limit: 0,
      order: 'asc',
    });
  } catch (e) {
    return _errorEnvelope('candidate_read_failed', {
      detail: _safeText(e && e.message || e),
      dry_run,
      cutoff_at: cutoffISO,
      days_configured: days,
    });
  }
  // Defense in depth - re-filter by tenant_id. NEVER trust the upstream
  // alone.
  rows = (Array.isArray(rows) ? rows : []).filter((r) => r && r.tenant_id === tenant);

  // Re-compute oldest_kept_at: the earliest row that is INSIDE the window.
  let oldest_kept_at = null;
  try {
    const insideWindow = await es.listEvents({
      tenant_id: tenant,
      since: cutoffISO,
      limit: 0,
      order: 'asc',
    });
    for (const r of (Array.isArray(insideWindow) ? insideWindow : []).filter((x) => x && x.tenant_id === tenant)) {
      const t = r && r.created_at ? Date.parse(r.created_at) : NaN;
      if (!Number.isFinite(t)) continue;
      if (oldest_kept_at === null || t < Date.parse(oldest_kept_at)) oldest_kept_at = r.created_at;
    }
  } catch (_) {
    oldest_kept_at = null;
  }

  const baseProof = {
    tenant_id: tenant,
    days_configured: days,
    cutoff_at: cutoffISO,
    as_of,
    rows,
    oldest_kept_at,
    would_evict_count: rows.length,
  };

  if (dry_run) {
    const proof = _proofFields('audit_retention_dry_run', {
      ...baseProof,
      dry_run: true,
    });
    return {
      ok: true,
      version: AUDIT_RETENTION_VERSION,
      proof_version: AUDIT_RETENTION_PROOF_VERSION,
      tenant_id: tenant,
      dry_run: true,
      cutoff_at: cutoffISO,
      as_of,
      days_configured: days,
      would_evict_count: rows.length,
      oldest_kept_at,
      ...proof,
    };
  }

  // Live mode requires confirm:true. We reject the call rather than silently
  // dropping to a dry run - that would be a different failure mode operators
  // could miss in noisy logs.
  if (!confirm) {
    return _errorEnvelope('confirm_required', {
      hint: 'pass {confirm:true, dry_run:false} to perform a live eviction; default is dry_run:true',
      dry_run: false,
      cutoff_at: cutoffISO,
      as_of,
      days_configured: days,
      would_evict_count: rows.length,
      ..._proofFields('audit_retention_confirm_required', {
        ...baseProof,
        dry_run: false,
      }),
    });
  }

  // Best-effort live eviction. We attempt purgeEvents if the event-store
  // exposes one; if it does not, return an honest envelope that explains
  // the store driver does not yet support eviction.
  if (typeof es.purgeEvents !== 'function') {
    return _errorEnvelope('eviction_not_supported', {
      hint: 'the configured event-store driver does not expose purgeEvents()',
      would_evict_count: rows.length,
      ..._proofFields('audit_retention_eviction_not_supported', {
        ...baseProof,
        dry_run: false,
      }),
    });
  }
  let evicted_count = 0;
  try {
    const result = await es.purgeEvents({
      tenant_id: tenant,
      before: cutoffISO,
    });
    const rawCount = result && typeof result === 'object'
      ? (result.purged ?? result.deleted ?? result.evicted_count)
      : result;
    if (!Number.isFinite(Number(rawCount))) {
      return _errorEnvelope('eviction_result_bad_shape', {
        detail: 'purgeEvents must return a finite deleted/purged count',
        would_evict_count: rows.length,
      });
    }
    evicted_count = Math.max(0, Math.min(rows.length, Math.trunc(Number(rawCount))));
  } catch (e) {
    return _errorEnvelope('eviction_failed', {
      detail: _safeText(e && e.message || e),
      would_evict_count: rows.length,
    });
  }

  let remaining_candidate_count = null;
  try {
    const remaining = await es.listEvents({
      tenant_id: tenant,
      until: cutoffISO,
      limit: 0,
      order: 'asc',
    });
    remaining_candidate_count = (Array.isArray(remaining) ? remaining : [])
      .filter((r) => r && r.tenant_id === tenant).length;
  } catch (_) {
    remaining_candidate_count = null;
  }

  const proof = _proofFields('audit_retention_live_eviction', {
    ...baseProof,
    dry_run: false,
    evicted_count,
    remaining_candidate_count,
  });
  return {
    ok: true,
    version: AUDIT_RETENTION_VERSION,
    proof_version: AUDIT_RETENTION_PROOF_VERSION,
    tenant_id: tenant,
    dry_run: false,
    cutoff_at: cutoffISO,
    as_of,
    days_configured: days,
    would_evict_count: rows.length,
    evicted_count,
    remaining_candidate_count,
    verification_status: remaining_candidate_count === null
      ? 'not_verified'
      : remaining_candidate_count === 0 ? 'cleared' : 'partial',
    oldest_kept_at,
    ...proof,
  };
}
