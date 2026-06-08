// LM-7 - V1 launch product analytics (2026-05-26).
//
// Server-side daily counters for V1 launch instrumentation. No browser SDKs
// (no Mixpanel/Segment/PostHog) and no PII - every row is bucketed on
// (date, tenant, plan_tier, kind, outcome) only. Region + namespace_id are
// optional dimensional tags also bucketed at write time so we never persist
// a raw user input string.
//
// Caveats / Constraints / Limitations:
//   - Best-effort persistence. recordEvent() is fire-and-forget: if the
//     storage backend is missing, throws, or returns null, the call is
//     swallowed silently so a metrics outage NEVER takes down the caller's
//     request path. Failures increment an in-process drop counter that the
//     /v1/metrics/snapshot endpoint reports under `_dropped` so the surface
//     is at least observable.
//   - Daily resolution. The row key is (UTC date | tenant | plan_tier |
//     kind | outcome). Sub-day buckets are intentionally not stored - V1
//     dashboards only chart day-over-day.
//   - Snapshot day-cap is enforced at 90. Callers asking for >90 get 90
//     back; <1 is normalized to 1.
//   - No analytics SDKs in the browser per user privacy directive - this
//     module is server-side ONLY. The frontend should never POST to
//     /v1/metrics/event from page JS. The route is reserved for first-party
//     server-side instrumentation by the kolm router itself.
//
// Storage backend: uses the project's store.js find/insert/update primitives
// (the same JSON/SQLite-toggleable backend that bridges.js + every other
// tenant-scoped surface uses). Table name is METRICS_TABLE; one row per
// (date, tenant, plan_tier, kind, outcome) tuple, count++ semantic.

import * as _store from './store.js';

export const METRICS_TABLE = 'metrics_daily';
export const SNAPSHOT_MAX_DAYS = 90;
export const SNAPSHOT_MIN_DAYS = 1;

// In-process drop counter so caller / operator can see dropped metric writes.
// Resets on process restart - V1 is intentionally not persisting this.
let _droppedTotal = 0;

function _utcDateKey(ms) {
  const d = new Date(typeof ms === 'number' ? ms : Date.now());
  // YYYY-MM-DD in UTC. Avoid toISOString().slice(0,10) round-trip surprises.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _safeStr(v, max = 64) {
  if (v == null) return null;
  const s = String(v);
  if (!s.length) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function _safeStore() {
  // Tolerate the case where store.js failed to load or is missing the
  // primitives we depend on. The caller of recordEvent should never
  // perceive a metrics-layer outage.
  if (!_store || typeof _store !== 'object') return null;
  const hasFind = typeof _store.find === 'function';
  const hasInsert = typeof _store.insert === 'function';
  const hasUpdate = typeof _store.update === 'function';
  const hasAll = typeof _store.all === 'function';
  if (!hasFind || !hasInsert || !hasUpdate || !hasAll) return null;
  return _store;
}

// ---------------------------------------------------------------------------
// recordEvent({tenant, plan_tier, kind, outcome, region?, namespace_id?})
//
// Fire-and-forget aggregate write. Always returns synchronously; never
// throws. Missing required fields silently drop (increments _droppedTotal).
// The persisted row is shape:
//   {
//     date: 'YYYY-MM-DD',
//     tenant: 'tenant_xxx',
//     plan_tier: 'free' | 'indie' | 'team' | 'business' | 'enterprise',
//     kind: 'signup' | 'compile' | 'gateway_dispatch' | 'capture_write' | 'deploy' | <other>,
//     outcome: 'success' | 'failure' | 'rate_limit' | <other>,
//     region: <opt>,
//     namespace_id: <opt>,
//     count: <n>,
//     first_at: <iso>,
//     last_at: <iso>
//   }
// ---------------------------------------------------------------------------
export function recordEvent(opts = {}) {
  try {
    const tenant = _safeStr(opts.tenant);
    const kind = _safeStr(opts.kind, 64);
    if (!tenant || !kind) { _droppedTotal++; return false; }
    const plan_tier = _safeStr(opts.plan_tier, 32) || 'unknown';
    const outcome = _safeStr(opts.outcome, 32) || 'success';
    const region = _safeStr(opts.region, 32);
    const namespace_id = _safeStr(opts.namespace_id, 64);

    const store = _safeStore();
    if (!store) { _droppedTotal++; return false; }

    const date = _utcDateKey();
    const nowIso = new Date().toISOString();

    const matchKey = (r) =>
      r && r.date === date && r.tenant === tenant
      && r.plan_tier === plan_tier && r.kind === kind && r.outcome === outcome
      && ((r.region || null) === (region || null))
      && ((r.namespace_id || null) === (namespace_id || null));

    let existing = null;
    try {
      const rows = store.find(METRICS_TABLE, matchKey);
      existing = Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (_) { existing = null; }

    if (existing) {
      try {
        store.update(METRICS_TABLE, matchKey, {
          count: (Number(existing.count) || 0) + 1,
          last_at: nowIso,
        });
      } catch (_) { _droppedTotal++; return false; }
      return true;
    }

    try {
      store.insert(METRICS_TABLE, {
        id: typeof store.id === 'function' ? store.id('metric') : `metric_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        date,
        tenant,
        plan_tier,
        kind,
        outcome,
        region: region || null,
        namespace_id: namespace_id || null,
        count: 1,
        first_at: nowIso,
        last_at: nowIso,
      });
    } catch (_) { _droppedTotal++; return false; }
    return true;
  } catch (_) {
    _droppedTotal++;
    return false;
  }
}

// ---------------------------------------------------------------------------
// getSnapshot({tenant, days, kind?}) → { ok, days, from, to, rows, totals_by_kind, totals_by_outcome, _dropped }
//
// Tenant-scoped read. Returns aggregated counts across the last N days
// (capped at 90, floored at 1). Rows are the raw daily aggregate rows for
// this tenant; totals_by_kind sums count across kinds; totals_by_outcome
// sums count across outcomes. Caller-supplied `kind` filters at read time
// (write-time bucketing is unchanged).
//
// Returns a clean envelope on missing storage - never throws.
// ---------------------------------------------------------------------------
export function getSnapshot(opts = {}) {
  const tenant = _safeStr(opts.tenant);
  let days = Number(opts.days);
  if (!Number.isFinite(days) || days < SNAPSHOT_MIN_DAYS) days = SNAPSHOT_MIN_DAYS;
  if (days > SNAPSHOT_MAX_DAYS) days = SNAPSHOT_MAX_DAYS;
  const kindFilter = _safeStr(opts.kind, 64);

  const out = {
    ok: true,
    days,
    from: null,
    to: null,
    rows: [],
    totals_by_kind: {},
    totals_by_outcome: {},
    _dropped: _droppedTotal,
  };

  if (!tenant) return out;

  const store = _safeStore();
  if (!store) return out;

  const nowMs = Date.now();
  const toDate = _utcDateKey(nowMs);
  const fromMs = nowMs - ((days - 1) * 24 * 60 * 60 * 1000);
  const fromDate = _utcDateKey(fromMs);
  out.from = fromDate;
  out.to = toDate;

  let rows = [];
  try {
    rows = store.find(METRICS_TABLE, (r) =>
      r && r.tenant === tenant && r.date >= fromDate && r.date <= toDate
      && (!kindFilter || r.kind === kindFilter)
    );
  } catch (_) { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  // Sort newest first so callers can take(N) without re-sorting.
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  for (const r of rows) {
    const c = Number(r.count) || 0;
    if (r.kind) out.totals_by_kind[r.kind] = (out.totals_by_kind[r.kind] || 0) + c;
    if (r.outcome) out.totals_by_outcome[r.outcome] = (out.totals_by_outcome[r.outcome] || 0) + c;
  }
  out.rows = rows;
  return out;
}

// Test / operator hook - read the in-process drop counter without forcing
// a snapshot fetch. Kept tiny on purpose; not a metric itself.
export function _droppedCount() {
  return _droppedTotal;
}

// Test reset hook. NOT used in prod paths.
export function _resetForTests() {
  _droppedTotal = 0;
}

export default { recordEvent, getSnapshot, METRICS_TABLE, SNAPSHOT_MAX_DAYS };
