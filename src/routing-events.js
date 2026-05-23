// W709-5 — routing-decision event recorder + summary reader.
//
// Wave 709 ships a runtime confidence router that, per request, picks
// {student, teacher, mixed} based on the student's first-token entropy.
// Every such decision lands here as a durable row so users can see the
// local-vs-teacher ratio over time on /account/routing.
//
// Why dual-write to event-store + store('routing_decisions'):
//
//  - The canonical event-store (src/event-store.js) is the lake's cost
//    ledger. Its schema (event-schema.js) is closed — any field outside
//    EVENT_FIELDS is silently dropped by canonicalize(). We still want a
//    canonical lake row so /v1/billing/breakdown can roll routing cost
//    into the same accounting as direct provider calls. The lake row uses
//    the existing schema fields (provider='kolm-router-{route}', vendor,
//    tokens_in/out, cost_micro_usd, workflow_id='routing:<route>').
//
//  - The src/store.js 'routing_decisions' table holds the first-class
//    routing fields (route, reason, threshold_used, entropy_summary,
//    student_tokens, teacher_tokens, student_cost_micro_usd,
//    teacher_cost_micro_usd) without bending the lake schema. This is
//    the same pattern bridges.js uses against the 'observations' table.
//
// The single helper recordRoutingDecision() owns both writes so callers
// can never write one without the other. summarizeRouting() reads from
// the 'routing_decisions' table (full-fidelity) — it does NOT need to
// look at the lake.

import crypto from 'node:crypto';
import { appendEvent } from './event-store.js';
import { findByTenant, insert, remove } from './store.js';

export const ROUTING_DECISIONS_TABLE = 'routing_decisions';
export const ROUTES = Object.freeze(['student', 'teacher', 'mixed']);

function _now() { return new Date().toISOString(); }

function _id() {
  // Stable across one row so we can dedupe if a caller retries.
  return 'rd_' + crypto.randomBytes(8).toString('hex');
}

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _validRoute(r) {
  return ROUTES.includes(r);
}

// recordRoutingDecision({tenant_id, namespace, decision, student_tokens,
//   teacher_tokens, costs, threshold}) — write one routing-decision row.
//
//   decision = {route: 'student'|'teacher'|'mixed', reason: string,
//               entropy_summary?: {max, mean, p95}}
//   costs    = {student_micro_usd: number, teacher_micro_usd: number}
//   threshold = number used for the routing call (e.g. entropy threshold)
//
// Returns the persisted row {id, tenant_id, namespace, route, reason,
// student_tokens, teacher_tokens, student_cost_micro_usd,
// teacher_cost_micro_usd, threshold_used, entropy_summary, ts}.
//
// Throws on missing tenant_id (we never write tenant-less rows because
// the dashboard tenant fence would silently leak data).
export async function recordRoutingDecision({
  tenant_id,
  namespace = 'default',
  decision = {},
  student_tokens = 0,
  teacher_tokens = 0,
  costs = {},
  threshold = null,
} = {}) {
  if (!tenant_id) {
    const err = new Error('routing_decision_missing_tenant_id');
    err.code = 'missing_tenant_id';
    throw err;
  }
  const route = _validRoute(decision.route) ? decision.route : 'student';
  const reason = String(decision.reason || 'no_reason_recorded').slice(0, 256);
  const ts = decision.ts || _now();
  const ns = String(namespace || 'default').slice(0, 128);

  const studentTokens = Math.max(0, Math.trunc(_num(student_tokens, 0)));
  const teacherTokens = Math.max(0, Math.trunc(_num(teacher_tokens, 0)));
  const studentCost = Math.max(0, Math.trunc(_num(costs.student_micro_usd, 0)));
  const teacherCost = Math.max(0, Math.trunc(_num(costs.teacher_micro_usd, 0)));
  const thresholdUsed = threshold == null ? null : _num(threshold, null);

  let entropySummary = null;
  if (decision.entropy_summary && typeof decision.entropy_summary === 'object') {
    entropySummary = {
      max: _num(decision.entropy_summary.max, null),
      mean: _num(decision.entropy_summary.mean, null),
      p95: _num(decision.entropy_summary.p95, null),
    };
  }

  const row = {
    id: _id(),
    kind: 'routing_decision',
    tenant: tenant_id,         // src/store.js findByTenant uses 'tenant'
    tenant_id,                 // mirror for callers that read tenant_id
    namespace: ns,
    route,
    reason,
    student_tokens: studentTokens,
    teacher_tokens: teacherTokens,
    student_cost_micro_usd: studentCost,
    teacher_cost_micro_usd: teacherCost,
    threshold_used: thresholdUsed,
    entropy_summary: entropySummary,
    ts,
  };

  // 1. Durable first-class row (full schema freedom).
  try { insert(ROUTING_DECISIONS_TABLE, row); } catch (_) {
    // Storage backends are expected to never throw; we still don't want
    // a transient flush failure to crash the routing path. The lake row
    // below is the secondary record.
  }

  // 2. Canonical lake row — uses the event-store schema fields so
  //    billing-breakdown + the lake export keep their existing shape.
  //    All routing-specific fields land in `feedback` as JSON (the only
  //    free-form 4096-char field on the schema).
  try {
    await appendEvent({
      tenant_id,
      namespace: ns,
      provider: 'kolm-router-' + route,
      vendor: 'kolm',
      model: 'router/' + route,
      workflow_id: 'routing:' + route,
      prompt_tokens: studentTokens,
      completion_tokens: teacherTokens,
      tokens_in: studentTokens,
      tokens_out: teacherTokens,
      cost_micro_usd: studentCost + teacherCost,
      estimated_cost_usd: (studentCost + teacherCost) / 1_000_000,
      status: 'ok',
      created_at: ts,
      feedback: JSON.stringify({
        kind: 'routing_decision',
        route,
        reason,
        threshold_used: thresholdUsed,
        entropy_summary: entropySummary,
        student_cost_micro_usd: studentCost,
        teacher_cost_micro_usd: teacherCost,
      }),
    });
  } catch (_) {
    // Lake row is non-critical — the durable routing_decisions row above
    // is the source of truth for the dashboard.
  }

  return row;
}

// summarizeRouting(tenant_id, namespace, sinceTimestamp) — read the
// routing_decisions table, filter by tenant + namespace + ts, return:
//
//   { total, by_route: {student, teacher, mixed},
//     local_ratio,                // (student + mixed) / total
//     teacher_calls_saved,        // student + mixed (i.e. NOT teacher)
//     est_cost_saved_usd,         // sum of (teacher_cost_micro_usd) on
//                                 // non-teacher rows / 1_000_000
//     last_decision_at }
//
// All filtering is in-process (the store's findByTenant is the only
// indexed primitive). Foreign-tenant rows can never enter the result
// because findByTenant filters at the source.
export function summarizeRouting(tenant_id, namespace = null, sinceTimestamp = null) {
  const empty = {
    total: 0,
    by_route: { student: 0, teacher: 0, mixed: 0 },
    local_ratio: 0,
    teacher_calls_saved: 0,
    est_cost_saved_usd: 0,
    last_decision_at: null,
  };
  if (!tenant_id) return empty;
  let rows = [];
  try { rows = findByTenant(ROUTING_DECISIONS_TABLE, tenant_id) || []; } catch (_) { rows = []; }
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // Defense in depth — the table is keyed by 'tenant' but we re-check
  // both 'tenant' and 'tenant_id' in case a future writer drops one.
  rows = rows.filter(r => r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
  if (namespace) rows = rows.filter(r => r.namespace === namespace);
  if (sinceTimestamp) {
    const cutoff = new Date(sinceTimestamp).getTime();
    if (Number.isFinite(cutoff)) {
      rows = rows.filter(r => {
        const t = new Date(r.ts || r.created_at || 0).getTime();
        return Number.isFinite(t) && t >= cutoff;
      });
    }
  }

  const by_route = { student: 0, teacher: 0, mixed: 0 };
  let est_cost_saved_micro_usd = 0;
  let last_decision_at = null;
  for (const r of rows) {
    const route = ROUTES.includes(r.route) ? r.route : 'student';
    by_route[route]++;
    if (route !== 'teacher') {
      // The teacher-cost field on a non-teacher row records what would
      // have been spent if the router had escalated. summing it gives a
      // conservative "estimated saved" number.
      est_cost_saved_micro_usd += _num(r.teacher_cost_micro_usd, 0);
    }
    const t = r.ts || r.created_at || null;
    if (t && (!last_decision_at || t > last_decision_at)) last_decision_at = t;
  }
  const total = rows.length;
  const teacher_calls_saved = by_route.student + by_route.mixed;
  const local_ratio = total === 0 ? 0 : teacher_calls_saved / total;
  return {
    total,
    by_route,
    local_ratio,
    teacher_calls_saved,
    est_cost_saved_usd: est_cost_saved_micro_usd / 1_000_000,
    last_decision_at,
  };
}

// recentRoutingDecisions(tenant_id, namespace, limit) — read the last
// `limit` rows newest-first. Used by the dashboard's chart + table.
export function recentRoutingDecisions(tenant_id, namespace = null, limit = 30) {
  if (!tenant_id) return [];
  let rows = [];
  try { rows = findByTenant(ROUTING_DECISIONS_TABLE, tenant_id) || []; } catch (_) { rows = []; }
  rows = rows.filter(r => r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
  if (namespace) rows = rows.filter(r => r.namespace === namespace);
  rows.sort((a, b) => {
    const ta = new Date(a.ts || a.created_at || 0).getTime();
    const tb = new Date(b.ts || b.created_at || 0).getTime();
    return tb - ta;
  });
  const cap = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 30)));
  return rows.slice(0, cap);
}

// _resetForTests(tenant_id) — drop rows from the routing_decisions table for
// one tenant. Tests use this to isolate counts across cases because src/store.js
// captures DATA_DIR at module-load time and tests that run in the same process
// share the underlying JSON file. Production callers should never call this.
export function _resetForTests(tenant_id) {
  try {
    if (tenant_id) {
      remove(ROUTING_DECISIONS_TABLE, (r) => r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
    } else {
      remove(ROUTING_DECISIONS_TABLE, () => true);
    }
  } catch (_) {}
}

export default {
  recordRoutingDecision,
  summarizeRouting,
  recentRoutingDecisions,
  ROUTING_DECISIONS_TABLE,
  ROUTES,
  _resetForTests,
};
