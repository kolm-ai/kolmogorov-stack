// src/billing-breakdown.js
//
// W465 — per-namespace cost attribution + team-level rollup.
//
// Reads from the event-store (the authoritative cost ledger) and produces
// two shapes: per-namespace breakdown for one tenant in a billing period,
// and team-level rollup that sums each member tenant's breakdown.
//
// Design choices:
//
//  1. Reads off the event-store, NOT off src/usage.js period counters. The
//     usage counters are sums; the breakdown needs per-namespace fan-out
//     and the event rows already carry `namespace`, `tenant_id`,
//     `tokens_in`, `tokens_out`, and `cost_micro_usd` (W411 parity fields).
//     Doing this off the meters would have required a schema migration
//     plus rewriting every increment call-site — the event-store carries
//     the same data losslessly.
//
//  2. Tenant-fenced at the source by passing `tenant_id` to listEvents.
//     The route layer is responsible for forcing tenant_id from the auth
//     middleware, never from request body.
//
//  3. The team rollup walks members synchronously (small N — most teams
//     are <25 seats per W409y limits) and aggregates per-member totals.
//     Members the caller is not allowed to read are still included in
//     aggregate counts but their per-tenant detail is omitted unless the
//     caller is owner/admin.

import { listEvents } from './event-store.js';
import { currentPeriod } from './usage.js';
import { getTeam, listMembers, membershipOf } from './teams.js';

// Convert YYYY-MM period → since/until ISO bounds (UTC half-open interval).
export function periodBounds(period) {
  const p = period || currentPeriod();
  const m = /^(\d{4})-(\d{2})$/.exec(String(p));
  if (!m) {
    const err = new Error('invalid_period');
    err.code = 'invalid_period';
    throw err;
  }
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (mo < 1 || mo > 12) {
    const err = new Error('invalid_period');
    err.code = 'invalid_period';
    throw err;
  }
  const since = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
  const until = new Date(Date.UTC(y, mo, 1)).toISOString();
  return { since, until, period: p };
}

function _costMicroFromEvent(ev) {
  if (ev == null) return 0;
  if (Number.isFinite(Number(ev.cost_micro_usd))) return Number(ev.cost_micro_usd);
  if (Number.isFinite(Number(ev.estimated_cost_usd))) {
    return Math.round(Number(ev.estimated_cost_usd) * 1_000_000);
  }
  return 0;
}

function _tokensIn(ev) {
  return Number(ev.tokens_in != null ? ev.tokens_in : (ev.prompt_tokens || 0)) || 0;
}

function _tokensOut(ev) {
  return Number(ev.tokens_out != null ? ev.tokens_out : (ev.completion_tokens || 0)) || 0;
}

// Aggregate per-namespace cost+token+latency for one tenant in a period.
// Returns:
//   {
//     period, tenant_id, totals: { captures, tokens_in, tokens_out, cost_micro_usd, cost_usd },
//     namespaces: [
//       { namespace, captures, tokens_in, tokens_out, cost_micro_usd, cost_usd,
//         latency_ms_avg, providers: { <provider>: { captures, cost_micro_usd } } }
//     ]
//   }
export async function tenantNamespaceBreakdown({ tenant_id, period }) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const { since, until, period: p } = periodBounds(period);
  const rows = await listEvents({ tenant_id, since, until, limit: 0 });
  const byNs = new Map();
  let totalCaptures = 0;
  let totalCostMicro = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  for (const ev of rows) {
    if (!ev) continue;
    // Defense in depth — the route filter already pinned tenant_id, but
    // pin again so this helper is safe to call directly from internal code.
    if (ev.tenant_id && tenant_id && ev.tenant_id !== tenant_id) continue;
    const ns = ev.namespace || 'default';
    let acc = byNs.get(ns);
    if (!acc) {
      acc = {
        namespace: ns,
        captures: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_micro_usd: 0,
        latency_ms_total: 0,
        latency_count: 0,
        providers: Object.create(null),
      };
      byNs.set(ns, acc);
    }
    const cIn = _tokensIn(ev);
    const cOut = _tokensOut(ev);
    const cMicro = _costMicroFromEvent(ev);
    const lat = Number(ev.latency_ms || 0);
    const prov = String(ev.provider || ev.vendor || 'unknown');
    acc.captures += 1;
    acc.tokens_in += cIn;
    acc.tokens_out += cOut;
    acc.cost_micro_usd += cMicro;
    if (lat > 0) {
      acc.latency_ms_total += lat;
      acc.latency_count += 1;
    }
    if (!acc.providers[prov]) acc.providers[prov] = { captures: 0, cost_micro_usd: 0 };
    acc.providers[prov].captures += 1;
    acc.providers[prov].cost_micro_usd += cMicro;
    totalCaptures += 1;
    totalCostMicro += cMicro;
    totalTokensIn += cIn;
    totalTokensOut += cOut;
  }
  // Sort by cost_micro_usd desc so the most expensive namespace surfaces
  // at the top — the dashboard reads namespaces[0] for the call-out.
  const namespaces = Array.from(byNs.values())
    .map(acc => ({
      namespace: acc.namespace,
      captures: acc.captures,
      tokens_in: acc.tokens_in,
      tokens_out: acc.tokens_out,
      cost_micro_usd: acc.cost_micro_usd,
      cost_usd: acc.cost_micro_usd / 1_000_000,
      latency_ms_avg: acc.latency_count > 0 ? acc.latency_ms_total / acc.latency_count : 0,
      providers: acc.providers,
    }))
    .sort((a, b) => b.cost_micro_usd - a.cost_micro_usd);
  return {
    period: p,
    tenant_id,
    totals: {
      captures: totalCaptures,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_micro_usd: totalCostMicro,
      cost_usd: totalCostMicro / 1_000_000,
    },
    namespaces,
  };
}

// Aggregate a team's spend by walking every member tenant.
//
// `caller_tenant_id` (optional) controls per-member detail visibility:
//   - owner/admin: every member's detail is included.
//   - member/viewer: only the caller's own detail is included; other
//     members appear in the aggregate totals but their per-row breakdown
//     is omitted.
//   - non-member: throws { code: 'forbidden' }.
export async function teamRollup({ team_id, period, caller_tenant_id }) {
  if (!team_id) {
    const err = new Error('team_id required');
    err.code = 'team_id_required';
    throw err;
  }
  const team = getTeam(team_id);
  if (!team) {
    const err = new Error('team_not_found');
    err.code = 'team_not_found';
    throw err;
  }
  let callerRole = null;
  if (caller_tenant_id) {
    const m = membershipOf(team.id, caller_tenant_id);
    if (!m) {
      const err = new Error('not_a_team_member');
      err.code = 'forbidden';
      throw err;
    }
    callerRole = m.role;
  }
  const isPrivileged = callerRole === 'owner' || callerRole === 'admin';
  const members = listMembers(team.id);
  const perMember = [];
  const totals = { captures: 0, tokens_in: 0, tokens_out: 0, cost_micro_usd: 0 };
  for (const m of members) {
    const b = await tenantNamespaceBreakdown({ tenant_id: m.tenant_id, period });
    totals.captures += b.totals.captures;
    totals.tokens_in += b.totals.tokens_in;
    totals.tokens_out += b.totals.tokens_out;
    totals.cost_micro_usd += b.totals.cost_micro_usd;
    const showDetail = isPrivileged || m.tenant_id === caller_tenant_id;
    perMember.push({
      tenant_id: m.tenant_id,
      role: m.role,
      captures: b.totals.captures,
      tokens_in: b.totals.tokens_in,
      tokens_out: b.totals.tokens_out,
      cost_micro_usd: b.totals.cost_micro_usd,
      cost_usd: b.totals.cost_micro_usd / 1_000_000,
      namespaces: showDetail ? b.namespaces : null,
    });
  }
  return {
    period: periodBounds(period).period,
    team_id: team.id,
    team_slug: team.slug,
    caller_role: callerRole,
    privileged: isPrivileged,
    members: perMember,
    totals: { ...totals, cost_usd: totals.cost_micro_usd / 1_000_000 },
  };
}

export default {
  periodBounds,
  tenantNamespaceBreakdown,
  teamRollup,
};
