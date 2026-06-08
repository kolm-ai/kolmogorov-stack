// src/autopilot-savings.js
//
// W775 - autopilot savings telemetry.
//
// The autopilot daemon (src/autopilot-daemon.js) silently re-routes matching
// queries to the local distilled model via the W807 confidence router. The
// landing page (/kolm-auto-pilot.html) needs to show the user, in dollars,
// what the autopilot has actually saved them.
//
// "Savings" here is intentionally CONSERVATIVE and HONEST:
//
//   For every routing-decision row with route in {student, mixed}, the
//   `teacher_cost_micro_usd` field holds the cost that would have been paid
//   if the router had escalated to the teacher. That is the saved spend.
//   For route='teacher' rows there is no saving - the escalation actually
//   happened. We never claim savings on rows that did not exist (e.g.
//   "what if you had used the autopilot from day 1") - that would be
//   fabrication, not telemetry.
//
//   `baseline_micro_usd` is the sum of (student + teacher) cost on every
//   row in the window - i.e. what the workload would have cost if EVERY
//   call had hit the teacher at the rate observed during this window.
//   This gives the user a denominator: "you saved $X out of a possible
//   $Y baseline." Without it the savings number is meaningless.
//
// Why a separate module from billing-breakdown.js (W465):
//
//   billing-breakdown.js aggregates by namespace and provider for the
//   billing page. It does NOT segment by routing decision (student vs
//   teacher vs mixed) and it does NOT compute "savings" - that is a
//   W775-specific concept that only makes sense for autopilot users.
//   Keeping the two modules separate means a future refactor of either
//   one cannot regress the other.
//
// Why we read from routing-events.js instead of event-store directly:
//
//   The routing_decisions table (src/routing-events.js) is the authoritative
//   first-class source for routing rows. The lake row written into the
//   event-store carries the same fields buried in the `feedback` JSON, but
//   round-tripping JSON for every row is wasteful and makes the join
//   brittle. The routing_decisions table is keyed by tenant + ts and
//   already tenant-fenced via findByTenant.
//
// Honest envelope:
//
//   - When no routing rows exist in the window, returns:
//       {ok:true, total_saved_micro_usd:0, baseline_micro_usd:0,
//        breakdown_by_day:[], n:0, version}
//     (NOT an error - a fresh tenant with no autopilot activity is valid.)
//
//   - When tenant_id is missing, returns:
//       {ok:false, error:'tenant_id_required', version}
//     (NEVER throws into the route handler - the route catches and 401s.)
//
//   - When window_days is non-finite or out of range, falls back to 30 and
//     stamps `window_days_clamped:<original>` so the caller can debug.

import { findByTenant } from './store.js';
import { ROUTING_DECISIONS_TABLE, ROUTES } from './routing-events.js';

export const AUTOPILOT_SAVINGS_VERSION = 'w775-v1';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 1;

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Format a Date into YYYY-MM-DD in UTC. We bucket by UTC day so the
// breakdown matches the W465 billing period bounds (also UTC).
function _utcDayKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function _clampWindowDays(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return { value: DEFAULT_WINDOW_DAYS, clamped_from: input == null ? null : String(input) };
  if (n < MIN_WINDOW_DAYS) return { value: MIN_WINDOW_DAYS, clamped_from: String(n) };
  if (n > MAX_WINDOW_DAYS) return { value: MAX_WINDOW_DAYS, clamped_from: String(n) };
  return { value: Math.trunc(n), clamped_from: null };
}

/**
 * Compute autopilot savings for one tenant over a rolling N-day window.
 *
 * Returns:
 *   {
 *     ok: true,
 *     total_saved_micro_usd: number,    // sum of teacher_cost_micro_usd on
 *                                       //   non-teacher rows in the window
 *     baseline_micro_usd:   number,     // sum of (student+teacher) cost on
 *                                       //   ALL rows in the window
 *     breakdown_by_day: [
 *       { day: 'YYYY-MM-DD',
 *         saved_micro_usd: number,
 *         baseline_micro_usd: number,
 *         routes: { student: int, teacher: int, mixed: int } },
 *       ...
 *     ],
 *     n: number,                        // total routing rows in window
 *     window_days: number,
 *     window_days_clamped?: string,
 *     namespace_filter?: string,
 *     since: ISO,
 *     until: ISO,
 *     version: 'w775-v1'
 *   }
 *
 * On missing tenant_id: { ok:false, error:'tenant_id_required', version }.
 *
 * Never throws.
 */
export async function computeSavings(opts = {}) {
  const tenant_id = opts && opts.tenant_id ? String(opts.tenant_id) : null;
  if (!tenant_id) {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'autopilot savings is per-tenant; pass tenant_id from the auth middleware',
      version: AUTOPILOT_SAVINGS_VERSION,
    };
  }
  const namespace = opts && opts.namespace ? String(opts.namespace).slice(0, 128) : null;
  const clamp = _clampWindowDays(opts && opts.window_days != null ? opts.window_days : DEFAULT_WINDOW_DAYS);
  const window_days = clamp.value;

  const now = Date.now();
  const since_ms = now - (window_days * 24 * 60 * 60 * 1000);
  const until = new Date(now).toISOString();
  const since = new Date(since_ms).toISOString();

  let rows = [];
  try {
    rows = findByTenant(ROUTING_DECISIONS_TABLE, tenant_id) || [];
  } catch (_) {
    rows = [];
  }
  if (!Array.isArray(rows)) rows = [];

  // Tenant fence - defense in depth.
  rows = rows.filter(r => r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
  if (namespace) rows = rows.filter(r => r && r.namespace === namespace);

  // Window filter (UTC half-open: [since, now]).
  rows = rows.filter(r => {
    const t = new Date(r.ts || r.created_at || 0).getTime();
    return Number.isFinite(t) && t >= since_ms && t <= now;
  });

  const byDay = new Map();
  let totalSaved = 0;
  let baseline = 0;

  for (const r of rows) {
    if (!r) continue;
    const route = ROUTES.includes(r.route) ? r.route : 'student';
    const studentCost = Math.max(0, _num(r.student_cost_micro_usd, 0));
    const teacherCost = Math.max(0, _num(r.teacher_cost_micro_usd, 0));

    // Savings: teacher cost AVOIDED on non-teacher routes.
    const savedThisRow = (route === 'teacher') ? 0 : teacherCost;
    totalSaved += savedThisRow;
    baseline += (studentCost + teacherCost);

    const day = _utcDayKey(new Date(r.ts || r.created_at || now));
    let acc = byDay.get(day);
    if (!acc) {
      acc = {
        day,
        saved_micro_usd: 0,
        baseline_micro_usd: 0,
        routes: { student: 0, teacher: 0, mixed: 0 },
      };
      byDay.set(day, acc);
    }
    acc.saved_micro_usd += savedThisRow;
    acc.baseline_micro_usd += (studentCost + teacherCost);
    acc.routes[route] += 1;
  }

  // Sort ascending by day so the dashboard sparkline reads left-to-right.
  const breakdown_by_day = Array.from(byDay.values()).sort((a, b) => {
    if (a.day < b.day) return -1;
    if (a.day > b.day) return 1;
    return 0;
  });

  const out = {
    ok: true,
    total_saved_micro_usd: totalSaved,
    total_saved_usd: totalSaved / 1_000_000,
    baseline_micro_usd: baseline,
    baseline_usd: baseline / 1_000_000,
    breakdown_by_day,
    n: rows.length,
    window_days,
    namespace_filter: namespace,
    since,
    until,
    version: AUTOPILOT_SAVINGS_VERSION,
  };
  if (clamp.clamped_from != null) {
    out.window_days_clamped = clamp.clamped_from;
  }
  return out;
}

export default {
  AUTOPILOT_SAVINGS_VERSION,
  computeSavings,
};
