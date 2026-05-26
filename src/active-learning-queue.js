// W710-1 — active-learning queue.
//
// Wave 709 ships a confidence router that emits a routing_decisions row on
// every request. Rows where the student model couldn't carry the response on
// its own (route='teacher' or route='mixed') are exactly the prompts the
// student needs MORE training data for — they are the highest-value examples
// for the next distillation pass.
//
// This module is the bridge: every non-'student' routing decision is enqueued
// into store('active_learning_queue'), where the next `kolm distill
// --resume-from-active-queue` run pulls them, hands them to the existing
// distillation pipeline, and marks them consumed. Stuck 'consumed' rows
// (e.g. distill crashed mid-run) can be requeued by olderThan threshold.
//
// Schema (active_learning_queue table):
//   {
//     id:                       'alq_' + 16 hex
//     tenant: <id>              // primary tenant filter (src/store.js findByTenant)
//     tenant_id: <id>           // mirror for callers that read tenant_id
//     namespace: <string>
//     trace_id: <hex32>|null    // populated when the routing decision carried one
//     source_routing_decision: <object>   // the routing_decisions row (frozen copy)
//     status: 'queued' | 'consumed' | 'dropped'
//     priority: number          // higher = more entropy = more valuable
//     enqueued_at_ms: number
//     consumed_at_ms: number|null
//   }
//
// Tenant isolation: every read is fenced via findByTenant() AND re-checks
// (tenant === wanted || tenant_id === wanted) inside the loop. Foreign-tenant
// rows can never enter a return value even if a future writer drops a field.
//
// Honesty contracts:
//   - enqueueFromRoutingDecision throws on missing tenant_id (matches W709
//     recordRoutingDecision behavior — never write tenant-less rows).
//   - consumeQueue is atomic: it reads, marks all candidate rows 'consumed' in
//     a single store mutation pass, then returns them. Two concurrent calls
//     will each only see rows whose status is still 'queued' when the second
//     pass runs (single-process serialization via the synchronous store API).
//   - requeueStale ONLY touches rows whose status is exactly 'consumed' and
//     whose consumed_at_ms is older than the threshold — it never resurrects
//     a 'dropped' row (dropped is a terminal user-visible action).

import crypto from 'node:crypto';
import { insert, update, remove, findByTenant } from './store.js';

export const ACTIVE_LEARNING_QUEUE_TABLE = 'active_learning_queue';

function _id() {
  return 'alq_' + crypto.randomBytes(8).toString('hex');
}

function _now() {
  return Date.now();
}

// Derive a numeric priority from the source routing decision. We want higher
// uncertainty to surface first. entropy_summary.max is the canonical signal;
// if absent we fall back to a route-based default so the row is still ranked.
function _priorityFromDecision(rd) {
  if (!rd || typeof rd !== 'object') return 0;
  const es = rd.entropy_summary;
  if (es && typeof es === 'object') {
    const m = Number(es.max);
    if (Number.isFinite(m) && m > 0) return m;
    const p95 = Number(es.p95);
    if (Number.isFinite(p95) && p95 > 0) return p95;
    const mean = Number(es.mean);
    if (Number.isFinite(mean) && mean > 0) return mean;
  }
  // Fallback ranking: 'mixed' beats 'teacher' beats 'student' because mixed
  // routes pinpoint specific high-uncertainty spans (more pedagogically
  // valuable). But teacher-only is still real signal worth keeping.
  const route = rd.route || rd.decision;
  if (route === 'mixed') return 0.5;
  if (route === 'teacher') return 0.25;
  return 0;
}

// Both 'route' (W709 field name in routing_decisions table) and 'decision'
// (W710 spec naming) are accepted so callers from either wave compose cleanly.
function _routeOf(rd) {
  if (!rd || typeof rd !== 'object') return 'student';
  return rd.route || rd.decision || 'student';
}

function _eligible(route) {
  // The queue exists to capture HIGH-VALUE training rows — the ones the
  // student model couldn't handle alone. Pure-student responses are skipped
  // because they're already covered by the existing checkpoint.
  return route === 'teacher' || route === 'mixed';
}

/**
 * Enqueue a routing decision into the active-learning queue.
 *
 * Returns {ok:true, row} when enqueued, {ok:false, reason:'not_eligible'}
 * when the decision was a pure-student call (the student already handled it),
 * or {ok:false, reason:'duplicate_trace'} when a row for this trace already
 * exists in 'queued' state (prevents double-enqueue from retried requests).
 *
 * Throws on missing tenantId — never silently writes tenant-less rows.
 *
 * @param {string} tenantId
 * @param {string} namespace
 * @param {object} routingDecision  routing_decisions row (W709 shape)
 */
export function enqueueFromRoutingDecision(tenantId, namespace, routingDecision) {
  if (!tenantId) {
    const err = new Error('active_learning_enqueue_missing_tenant_id');
    err.code = 'missing_tenant_id';
    throw err;
  }
  const ns = String(namespace || routingDecision?.namespace || 'default').slice(0, 128);
  const route = _routeOf(routingDecision);
  if (!_eligible(route)) {
    return { ok: false, reason: 'not_eligible', route };
  }

  // Dedupe: if a 'queued' row with the same trace_id already exists, skip.
  // We do NOT dedupe across already-consumed rows — those represent prior
  // training passes that already saw the row, and a re-routing event is a
  // signal that the student still needs the example.
  const trace_id = routingDecision && routingDecision.trace_id
    ? String(routingDecision.trace_id) : null;
  if (trace_id) {
    let existing = [];
    try { existing = findByTenant(ACTIVE_LEARNING_QUEUE_TABLE, tenantId) || []; } catch (_) { existing = []; }
    for (const r of existing) {
      if (!r) continue;
      // Defense in depth: re-fence by tenant + check namespace + trace_id + status.
      if ((r.tenant !== tenantId && r.tenant_id !== tenantId)) continue;
      if (r.namespace !== ns) continue;
      if (r.trace_id !== trace_id) continue;
      if (r.status === 'queued') {
        return { ok: false, reason: 'duplicate_trace', row: r };
      }
    }
  }

  const row = {
    id: _id(),
    kind: 'active_learning_row',
    tenant: tenantId,
    tenant_id: tenantId,
    namespace: ns,
    trace_id,
    source_routing_decision: routingDecision || null,
    status: 'queued',
    priority: _priorityFromDecision(routingDecision),
    enqueued_at_ms: _now(),
    consumed_at_ms: null,
  };
  try { insert(ACTIVE_LEARNING_QUEUE_TABLE, row); }
  catch (e) {
    return { ok: false, reason: 'store_insert_failed', error: e && e.message };
  }
  return { ok: true, row };
}

/**
 * Read the current 'queued' rows for the (tenant, namespace) bucket, newest
 * highest-priority first. Tenant-fenced via findByTenant + defense-in-depth.
 *
 * @param {string} tenantId
 * @param {string} namespace
 * @param {number} limit
 */
export function listQueued(tenantId, namespace, limit = 100) {
  if (!tenantId) return [];
  let rows = [];
  try { rows = findByTenant(ACTIVE_LEARNING_QUEUE_TABLE, tenantId) || []; } catch (_) { rows = []; }
  const ns = String(namespace || 'default');
  const cap = Math.max(1, Math.min(10000, Math.trunc(Number(limit) || 100)));
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    if (r.tenant !== tenantId && r.tenant_id !== tenantId) continue;
    if (r.namespace !== ns) continue;
    if (r.status !== 'queued') continue;
    out.push(r);
  }
  // Highest priority first; tie-break by oldest first so FIFO survives ties.
  out.sort((a, b) => {
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pb !== pa) return pb - pa;
    return (a.enqueued_at_ms || 0) - (b.enqueued_at_ms || 0);
  });
  return out.slice(0, cap);
}

/**
 * Atomically consume up to `max` 'queued' rows, marking them 'consumed'
 * (with consumed_at_ms set), and return the consumed rows.
 *
 * Single-process atomicity guarantee: the underlying src/store.js is a
 * synchronous in-memory + JSON-flush layer. Two consumeQueue calls in the
 * same event loop tick cannot interleave because each `update()` call runs
 * to completion synchronously. After the first call returns, the second
 * call's `listQueued()` snapshot will reflect the post-update state — so
 * the second consumer never re-sees rows the first one took.
 *
 * Tenant-fenced.
 *
 * @param {string} tenantId
 * @param {string} namespace
 * @param {number} max
 */
export function consumeQueue(tenantId, namespace, max) {
  if (!tenantId) return [];
  const cap = Math.max(1, Math.min(10000, Math.trunc(Number(max) || 500)));
  const ns = String(namespace || 'default');
  // Snapshot first so we know the exact ids to update.
  const candidates = listQueued(tenantId, ns, cap);
  if (candidates.length === 0) return [];
  const ids = new Set(candidates.map(r => r.id));
  const now = _now();
  try {
    update(
      ACTIVE_LEARNING_QUEUE_TABLE,
      (r) => r
        && (r.tenant === tenantId || r.tenant_id === tenantId)
        && r.namespace === ns
        && r.status === 'queued'
        && ids.has(r.id),
      { status: 'consumed', consumed_at_ms: now },
    );
  } catch (_) {
    // If the update failed (e.g. transient flush error) we return an empty
    // array rather than handing the caller rows we couldn't persist as
    // consumed — that would let two consumers see the same data.
    return [];
  }
  // Return the candidates with their new status reflected. Re-fetch by id
  // through the store so the caller sees the post-update row (including the
  // updated status/consumed_at_ms).
  let after = [];
  try { after = findByTenant(ACTIVE_LEARNING_QUEUE_TABLE, tenantId) || []; } catch (_) { after = []; }
  const out = [];
  for (const r of after) {
    if (!r) continue;
    if (r.tenant !== tenantId && r.tenant_id !== tenantId) continue;
    if (!ids.has(r.id)) continue;
    out.push(r);
  }
  // Preserve the priority-ordering the consumer expected.
  out.sort((a, b) => {
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pb !== pa) return pb - pa;
    return (a.enqueued_at_ms || 0) - (b.enqueued_at_ms || 0);
  });
  return out;
}

/**
 * Re-enqueue 'consumed' rows whose consumed_at_ms is older than `olderThanMs`
 * ago. Used by the `kolm distill resume` health-check loop to recover rows
 * from a distill run that crashed before finishing.
 *
 * Only touches rows with status==='consumed'. 'dropped' is terminal.
 *
 * Returns the number of rows requeued.
 */
export function requeueStale(tenantId, namespace, olderThanMs) {
  if (!tenantId) return 0;
  const ns = String(namespace || 'default');
  const threshold = Math.max(0, Number(olderThanMs) || 0);
  const cutoff = _now() - threshold;
  try {
    const n = update(
      ACTIVE_LEARNING_QUEUE_TABLE,
      (r) => r
        && (r.tenant === tenantId || r.tenant_id === tenantId)
        && r.namespace === ns
        && r.status === 'consumed'
        && Number.isFinite(r.consumed_at_ms)
        && r.consumed_at_ms <= cutoff,
      { status: 'queued', consumed_at_ms: null },
    );
    return n || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Aggregate counts + p50 priority across a (tenant, namespace?) bucket.
 *
 * Returns {queued, consumed, dropped, total, oldest_queued_ms, p50_priority}.
 * oldest_queued_ms is the enqueued_at_ms of the oldest still-queued row
 * (null when queued===0). p50_priority is the median priority across queued
 * rows (0 when queued===0).
 */
export function summarize(tenantId, namespace = null) {
  const empty = {
    queued: 0, consumed: 0, dropped: 0, total: 0,
    oldest_queued_ms: null, p50_priority: 0,
  };
  if (!tenantId) return empty;
  let rows = [];
  try { rows = findByTenant(ACTIVE_LEARNING_QUEUE_TABLE, tenantId) || []; } catch (_) { rows = []; }
  let queued = 0, consumed = 0, dropped = 0;
  let oldest = null;
  const queuedPriorities = [];
  for (const r of rows) {
    if (!r) continue;
    if (r.tenant !== tenantId && r.tenant_id !== tenantId) continue;
    if (namespace && r.namespace !== namespace) continue;
    const status = r.status;
    if (status === 'queued') {
      queued++;
      const enq = Number(r.enqueued_at_ms);
      if (Number.isFinite(enq)) {
        if (oldest === null || enq < oldest) oldest = enq;
      }
      const pr = Number(r.priority);
      if (Number.isFinite(pr)) queuedPriorities.push(pr);
    } else if (status === 'consumed') {
      consumed++;
    } else if (status === 'dropped') {
      dropped++;
    }
  }
  let p50 = 0;
  if (queuedPriorities.length > 0) {
    queuedPriorities.sort((a, b) => a - b);
    const mid = Math.floor(queuedPriorities.length / 2);
    p50 = queuedPriorities.length % 2 === 0
      ? (queuedPriorities[mid - 1] + queuedPriorities[mid]) / 2
      : queuedPriorities[mid];
  }
  return {
    queued, consumed, dropped,
    total: queued + consumed + dropped,
    oldest_queued_ms: oldest,
    p50_priority: p50,
  };
}

/**
 * Drop a row from the queue (terminal). Tenant-fenced; safe no-op for
 * unknown ids or foreign-tenant rows.
 */
export function dropRow(tenantId, rowId) {
  if (!tenantId || !rowId) return 0;
  try {
    return update(
      ACTIVE_LEARNING_QUEUE_TABLE,
      (r) => r && (r.tenant === tenantId || r.tenant_id === tenantId) && r.id === rowId,
      { status: 'dropped' },
    ) || 0;
  } catch (_) { return 0; }
}

/**
 * Test-only: wipe rows for one tenant (or every tenant when tenantId is
 * falsy). Mirrors the W709 routing-events _resetForTests pattern.
 */
export function _resetForTests(tenantId) {
  try {
    if (tenantId) {
      remove(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && (r.tenant === tenantId || r.tenant_id === tenantId));
    } else {
      remove(ACTIVE_LEARNING_QUEUE_TABLE, () => true);
    }
  } catch (_) {} // deliberate: cleanup
}

export default {
  ACTIVE_LEARNING_QUEUE_TABLE,
  enqueueFromRoutingDecision,
  listQueued,
  consumeQueue,
  requeueStale,
  summarize,
  dropRow,
  _resetForTests,
};
