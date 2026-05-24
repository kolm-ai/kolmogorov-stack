// W783 - Cost attribution / chargeback.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 721-727):
//   [W783-1] Per-department, per-project, per-namespace cost tracking
//            -> chargebackReport (extends W465 billing-breakdown)
//   [W783-2] Exportable reports for finance teams (uses W770)
//            -> exportChargeback (CSV + JSON)
//   [W783-3] /account/chargeback.html
//
// Design choices:
//
//  1. EXTENDS W465 not modifies. src/billing-breakdown.js stays untouched;
//     we re-read the event-store the same way W465 does and roll up by
//     {namespace, project, department}. The dimension picker lets the
//     finance team pivot.
//  2. project + department are READ from event metadata if present
//     (ev.project / ev.metadata.project / ev.department), otherwise from
//     a tag mapping derived from the namespace string. The mapping is
//     intentional: many tenants only stamp namespace today, and we want
//     a useful chargeback even without metadata back-fill.
//  3. CSV export mirrors W770's RFC 4180 contract (CRLF, double-quote
//     wrap on comma/quote/newline, doubled quotes inside). We don't
//     re-implement the escape; we vendor it inline so this module has
//     zero coupling to audit-export.js's shape (which is row-oriented
//     audit, not column-oriented finance).
//  4. W411 defense-in-depth: per-row tenant_id !== tenant after listEvents.
//
// Public surface:
//   - CHARGEBACK_VERSION
//   - GROUP_BY_DIMENSIONS (frozen)
//   - EXPORT_FORMATS (frozen)
//   - periodBounds (re-exported convenience)
//   - chargebackReport({tenant, period, group_by})
//   - exportChargeback({tenant, period, format})

import { listEvents } from './event-store.js';
import { currentPeriod } from './usage.js';

export const CHARGEBACK_VERSION = 'w783-v1';

// Closed set of legal pivots. Frozen so a refactor cannot quietly add a
// new dimension without bumping the version stamp.
export const GROUP_BY_DIMENSIONS = Object.freeze(['namespace', 'project', 'department']);

// Canonical department vocab used by _departmentKey for namespace-prefix
// mapping. Tenants can also stamp ev.department / ev.metadata.department
// directly; those bypass this list. 'unassigned' is the conservative fallback.
export const DEPARTMENT_VOCAB = Object.freeze([
  'support',
  'sales',
  'marketing',
  'finance',
  'hr',
  'legal',
  'product',
  'unassigned',
]);

// Closed set of legal export formats. CSV is the finance team's lingua
// franca; JSON is for programmatic ingestion (Looker / Snowflake / dbt).
export const EXPORT_FORMATS = Object.freeze(['csv', 'json']);

// CSV column ordering. Like W770's CSV_COLUMNS this is frozen so column
// order stays stable across releases (downstream finance scripts key on
// position, not header name).
const CSV_COLUMNS = Object.freeze([
  'period',
  'group_by',
  'key',
  'cost_micro_usd',
  'cost_usd',
  'call_count',
  'tokens_in',
  'tokens_out',
]);

// Read cap from the event-store. The same cap W781 uses; large enough to
// span a full month of even a chatty tenant.
const READ_LIMIT = 100000;

// =============================================================================
// periodBounds - mirrors W465's helper without importing from
// billing-breakdown.js (we are EXTENDING W465 via a sibling, not coupling
// to its private internals). YYYY-MM -> {since, until, period}.
// =============================================================================
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

// Extract the project key from an event row. Priority order:
//   1. ev.project (explicit top-level)
//   2. ev.metadata.project
//   3. derived from namespace: 'support_chat' -> 'support'
//   4. 'default'
function _projectKey(ev) {
  if (!ev) return 'default';
  if (typeof ev.project === 'string' && ev.project) return ev.project;
  if (ev.metadata && typeof ev.metadata === 'object' && typeof ev.metadata.project === 'string' && ev.metadata.project) {
    return ev.metadata.project;
  }
  const ns = String(ev.namespace || '');
  if (ns.includes('_')) return ns.split('_')[0];
  if (ns.includes('-')) return ns.split('-')[0];
  return ns || 'default';
}

// Extract the department key. Mirrors project but checks .department first
// then falls back to a simpler mapping. Many enterprise tenants stamp a
// dept tag; for those that don't, the conservative default is
// 'engineering' since that's where the bulk of LLM spend lives.
function _departmentKey(ev) {
  if (!ev) return 'unassigned';
  if (typeof ev.department === 'string' && ev.department) return ev.department;
  if (ev.metadata && typeof ev.metadata === 'object' && typeof ev.metadata.department === 'string' && ev.metadata.department) {
    return ev.metadata.department;
  }
  // Common namespace conventions used in the wild for dept-flagging.
  const ns = String(ev.namespace || '').toLowerCase();
  if (ns.startsWith('support')) return 'support';
  if (ns.startsWith('sales')) return 'sales';
  if (ns.startsWith('marketing') || ns.startsWith('mkt')) return 'marketing';
  if (ns.startsWith('finance') || ns.startsWith('fin')) return 'finance';
  if (ns.startsWith('hr')) return 'hr';
  if (ns.startsWith('legal')) return 'legal';
  if (ns.startsWith('product') || ns.startsWith('prod')) return 'product';
  return 'unassigned';
}

function _keyForRow(ev, group_by) {
  if (group_by === 'project') return _projectKey(ev);
  if (group_by === 'department') return _departmentKey(ev);
  return String(ev.namespace || 'default');
}

// =============================================================================
// chargebackReport
//
// Builds a per-dimension cost rollup for one tenant in one period. Returns:
//   {ok:true, period, group_by, groups:[{key, cost_micro_usd, cost_usd,
//                                        call_count, tokens_in, tokens_out}],
//    total:{cost_micro_usd, cost_usd, call_count}, tenant_id, version}
//
// Honest envelopes:
//   - {ok:false, error:'tenant_required'}                  - missing tenant
//   - {ok:false, error:'invalid_period'}                   - bad YYYY-MM
//   - {ok:false, error:'invalid_group_by'}                 - bad dimension
//   - {ok:true, groups:[], total:{...0}, message:'no_events_in_period'}
//     - empty period (NOT an error; surfaces empty totals honestly)
// =============================================================================
export async function chargebackReport(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      version: CHARGEBACK_VERSION,
    };
  }
  const group_by = (typeof o.group_by === 'string' && o.group_by) ? o.group_by : 'namespace';
  if (!GROUP_BY_DIMENSIONS.includes(group_by)) {
    return {
      ok: false,
      error: 'invalid_group_by',
      hint: 'group_by must be one of ' + GROUP_BY_DIMENSIONS.join(','),
      supported: GROUP_BY_DIMENSIONS,
      version: CHARGEBACK_VERSION,
    };
  }
  let bounds;
  try {
    bounds = periodBounds(o.period);
  } catch (e) {
    return {
      ok: false,
      error: 'invalid_period',
      hint: 'period must match YYYY-MM (e.g. 2026-05)',
      version: CHARGEBACK_VERSION,
    };
  }
  let rows = [];
  try {
    rows = await listEvents({
      tenant_id: tenant,
      since: bounds.since,
      until: bounds.until,
      limit: READ_LIMIT,
      order: 'desc',
    });
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_error',
      detail: String((e && e.message) || e),
      version: CHARGEBACK_VERSION,
    };
  }
  // W411 defense-in-depth tenant fence.
  rows = (rows || []).filter((r) => r && r.tenant_id === tenant);
  if (rows.length === 0) {
    return {
      ok: true,
      period: bounds.period,
      group_by,
      groups: [],
      total: {
        cost_micro_usd: 0,
        cost_usd: 0,
        call_count: 0,
        tokens_in: 0,
        tokens_out: 0,
      },
      tenant_id: tenant,
      message: 'no_events_in_period',
      version: CHARGEBACK_VERSION,
    };
  }
  const buckets = new Map();
  let totalCost = 0;
  let totalCalls = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  for (const ev of rows) {
    if (!ev) continue;
    const key = _keyForRow(ev, group_by);
    let acc = buckets.get(key);
    if (!acc) {
      acc = { key, cost_micro_usd: 0, call_count: 0, tokens_in: 0, tokens_out: 0 };
      buckets.set(key, acc);
    }
    const cMicro = _costMicroFromEvent(ev);
    const cIn = _tokensIn(ev);
    const cOut = _tokensOut(ev);
    acc.cost_micro_usd += cMicro;
    acc.call_count += 1;
    acc.tokens_in += cIn;
    acc.tokens_out += cOut;
    totalCost += cMicro;
    totalCalls += 1;
    totalTokensIn += cIn;
    totalTokensOut += cOut;
  }
  const groups = Array.from(buckets.values())
    .map((g) => ({
      key: g.key,
      cost_micro_usd: g.cost_micro_usd,
      cost_usd: g.cost_micro_usd / 1_000_000,
      call_count: g.call_count,
      tokens_in: g.tokens_in,
      tokens_out: g.tokens_out,
    }))
    .sort((a, b) => b.cost_micro_usd - a.cost_micro_usd);
  return {
    ok: true,
    period: bounds.period,
    group_by,
    groups,
    total: {
      cost_micro_usd: totalCost,
      cost_usd: totalCost / 1_000_000,
      call_count: totalCalls,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
    },
    tenant_id: tenant,
    version: CHARGEBACK_VERSION,
  };
}

// =============================================================================
// CSV escape (RFC 4180). Mirrors W770's _csvField to avoid coupling our
// module to audit-export.js (which has a different schema).
// =============================================================================
function _csvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.length === 0) return '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function _toCsv(report) {
  const header = CSV_COLUMNS.join(',');
  const lines = [header];
  for (const g of (report.groups || [])) {
    const cells = [
      _csvField(report.period),
      _csvField(report.group_by),
      _csvField(g.key),
      _csvField(g.cost_micro_usd),
      _csvField(g.cost_usd),
      _csvField(g.call_count),
      _csvField(g.tokens_in),
      _csvField(g.tokens_out),
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function _mimeFor(format) {
  if (format === 'csv') return 'text/csv; charset=utf-8';
  if (format === 'json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

// =============================================================================
// exportChargeback
//
// Wraps chargebackReport + emits {format, body, mime_type, row_count}
// suitable for direct streaming via res.send.
//
// Honest envelopes propagate from chargebackReport. Bad format returns
// {ok:false, error:'bad_format'} without touching the event-store.
// =============================================================================
export async function exportChargeback(opts) {
  const o = opts || {};
  const format = (typeof o.format === 'string' && o.format) ? o.format.toLowerCase() : 'json';
  if (!EXPORT_FORMATS.includes(format)) {
    return {
      ok: false,
      error: 'bad_format',
      hint: 'format must be one of ' + EXPORT_FORMATS.join(','),
      supported: EXPORT_FORMATS,
      version: CHARGEBACK_VERSION,
    };
  }
  const report = await chargebackReport({
    tenant: o.tenant,
    period: o.period,
    group_by: o.group_by,
  });
  if (!report.ok) return report;
  let body;
  if (format === 'csv') {
    body = _toCsv(report);
  } else {
    body = JSON.stringify(report, null, 2);
  }
  return {
    ok: true,
    format,
    body,
    mime_type: _mimeFor(format),
    row_count: (report.groups || []).length,
    period: report.period,
    group_by: report.group_by,
    tenant_id: report.tenant_id,
    version: CHARGEBACK_VERSION,
  };
}

export const DEFAULTS = Object.freeze({
  GROUP_BY_DIMENSIONS,
  EXPORT_FORMATS,
  CSV_COLUMNS,
  READ_LIMIT,
  DEPARTMENT_VOCAB,
});

export default {
  CHARGEBACK_VERSION,
  GROUP_BY_DIMENSIONS,
  EXPORT_FORMATS,
  DEPARTMENT_VOCAB,
  periodBounds,
  chargebackReport,
  exportChargeback,
};
