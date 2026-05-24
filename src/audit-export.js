// W770 - Audit export (CSV + CEF + LEEF + JSONL).
//
// Atomic guarantees pinned by tests/wave770-audit-export.test.js:
//
//  - AUDIT_EXPORT_VERSION = 'w770-v1'
//  - EXPORT_FORMATS is Object.freeze()-d, contains exactly 4 entries
//    ('csv', 'cef', 'leef', 'json').
//  - CSV_COLUMNS is Object.freeze()-d, RFC 4180 column ordering, >=8 cols.
//  - toCsv is pure, never mutates input, RFC 4180 escape (embedded commas
//    + double-quotes + newlines all wrapped + doubled).
//  - toCef emits ArcSight CEF:0 v0 with kolm.ai|kolm|<version>|<sigid>|...
//  - toLeef emits QRadar LEEF:2.0 v2 with caret (^) extension separator.
//  - toJsonLines emits one JSON object per line, newline-terminated.
//  - exportAuditEvents tenant-fences with defense-in-depth (W411 law):
//      reads via storeMod.all('audit_events') THEN per-row tenant_id filter.
//      Calling findByTenant would silently miss rows because the index is
//      keyed on 'tenant' but audit.js writes 'tenant_id' (field-key mismatch
//      documented at src/store.js line 415 + src/audit.js line 23).
//  - exportAuditEvents returns honest envelopes for bad format + missing
//    tenant_id - never silent-passes.
//  - exportAuditEvents caps at max_rows (default 10000, hard ceiling 100000).
//    Preview always caps at 10 + reports total_would_export count.
//  - mime_type per format: text/csv | text/plain | application/x-ndjson.
//
// HONESTY INVARIANTS (NEVER violate):
//  - Cross-tenant audit-row leakage is a P0 security incident. Per-row
//    tenant_id !== tenant_id filter runs even after the all() read.
//  - RFC 4180 CSV escape is mandatory. Broken CSV is a silent integrity
//    failure for SIEM ingestion downstream.
//  - CEF + LEEF extension key/value escaping is mandatory. Broken SIEM
//    ingestion is a silent monitoring failure.
//  - previewExport caps at 10 rows. Preview is for UI, not a full-dump
//    backdoor.
//
// W411 defense-in-depth pattern (cross-reference):
//   storeMod.all(TABLE).filter(r => r.tenant_id === tenant_id)
// NOT
//   storeMod.findByTenant(TABLE, tenant_id)
//
// The latter looks at 'tenant' (see src/store.js findByField) and would
// silently return zero rows for the audit table - that would PRESENT AS
// 'no leak' (correct outcome by accident) but on a future store-schema
// change could flip to 'all rows' (catastrophic leak). The explicit per-
// row filter is the defense.

import * as defaultStoreMod from './store.js';

export const AUDIT_EXPORT_VERSION = 'w770-v1';

// All supported export formats. Frozen so callers cannot push a new
// format and have it silently pass exportAuditEvents shape validation.
export const EXPORT_FORMATS = Object.freeze(['csv', 'cef', 'leef', 'json']);

// CSV column ordering. RFC 4180 says column order in the header row is
// the contract for every body row. Frozen so a refactor cannot reorder
// columns without bumping AUDIT_EXPORT_VERSION.
//
// 11 columns deliberately chosen to cover the audit-events shape:
//   ts_iso       row timestamp in ISO-8601
//   tenant_id    the fence column
//   operator_id  who initiated (actor)
//   op           the audit operation code
//   target_kind  category of the target (compile|artifact|key|...)
//   target_id    specific row id when relevant
//   outcome      success|failure|partial|null
//   source_ip    client IP at time of action when captured
//   user_agent   client UA at time of action when captured
//   request_id   correlation id linking back to the request log
//   meta_hash    sha256 of the canonical payload (audit chain anchor)
export const CSV_COLUMNS = Object.freeze([
  'ts_iso',
  'tenant_id',
  'operator_id',
  'op',
  'target_kind',
  'target_id',
  'outcome',
  'source_ip',
  'user_agent',
  'request_id',
  'meta_hash',
]);

// Source-of-truth audit table. Single point of change if audit.js renames.
const AUDIT_TABLE = 'audit_events';

// SIEM severity floor. Ops whose name starts with one of these gets
// elevated severity in CEF (8 vs 5). Catastrophic-only (10) is reserved
// for `_critical` suffix or explicit security_event tags in payload.
const SECURITY_EVENT_PREFIXES = Object.freeze([
  'auth.',
  'admin.',
  'security.',
  'sso.',
  'scim.',
  'key.',
]);

// =============================================================================
// Internal row normalization.
// Audit rows on disk may have heterogeneous shapes (some carry payload.actor
// directly, some carry actor at the top, some have meta_hash from older
// chains and others have event_hash). Normalize at the export boundary so
// downstream emitters never have to guess.
// =============================================================================
function _normalize(row) {
  if (!row || typeof row !== 'object') return null;
  const payload = (row.payload && typeof row.payload === 'object') ? row.payload : {};
  const actor = row.actor || payload.actor || payload.operator || payload.operator_id || null;
  // meta_hash = audit-chain anchor. Some rows carry it as event_hash
  // (the W258 chain field). Tolerate both for export fidelity.
  const meta_hash = row.meta_hash || row.event_hash || payload.meta_hash || null;
  return {
    ts_iso: row.at || row.ts_iso || row.timestamp || null,
    tenant_id: row.tenant_id || null,
    operator_id: actor != null ? String(actor) : null,
    op: row.op || null,
    target_kind: payload.target_kind || row.target_kind || null,
    target_id: payload.target_id || row.target_id || null,
    outcome: payload.outcome || row.outcome || null,
    source_ip: payload.source_ip || row.source_ip || null,
    user_agent: payload.user_agent || row.user_agent || null,
    request_id: row.request_id || payload.request_id || null,
    meta_hash: meta_hash != null ? String(meta_hash) : null,
  };
}

// =============================================================================
// CSV (RFC 4180 compliant).
// =============================================================================

// Pure RFC 4180 field escape. Wraps in double-quotes when the value contains
// a comma, double-quote, CR, or LF. Embedded double-quotes are doubled.
// Pure JS, no allocations beyond String() and replace().
function _csvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.length === 0) return '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Render an array of normalized rows as RFC 4180 CSV. Header row first.
// CRLF line terminator per RFC 4180 section 2.1. NEVER mutates input.
export function toCsv(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = CSV_COLUMNS.join(',');
  if (safeRows.length === 0) {
    return header + '\r\n';
  }
  const lines = [header];
  for (const raw of safeRows) {
    const norm = _normalize(raw);
    if (!norm) continue;
    const cells = CSV_COLUMNS.map((col) => _csvField(norm[col]));
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// =============================================================================
// CEF (ArcSight CEF v0).
// Reference: https://www.microfocus.com/documentation/arcsight/arcsight-smartconnectors-8.4/cef-implementation-standard/Content/CEF/Chapter%201%20What%20is%20CEF.htm
// Header layout:
//   CEF:0|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
// Special chars in header fields: | and \ must be escaped with backslash.
// Extension is key=value pairs joined by spaces; = and \ in values escape.
// =============================================================================

function _cefHeaderField(v) {
  if (v == null) return '';
  return String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function _cefExtensionValue(v) {
  if (v == null) return '';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\r?\n/g, '\\n');
}

function _severityForOp(op) {
  if (typeof op !== 'string' || op.length === 0) return 5;
  if (op.endsWith('_critical') || op.endsWith('.critical')) return 10;
  for (const prefix of SECURITY_EVENT_PREFIXES) {
    if (op.startsWith(prefix)) return 8;
  }
  // The W771-bracket explicit security_event tag bumps to 8.
  if (op === 'security_event' || op.includes('.security_event')) return 8;
  return 5;
}

export function toCef(rows, opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const vendor = _cefHeaderField('kolm.ai');
  const product = _cefHeaderField('kolm');
  const version = _cefHeaderField((opts && opts.version) || AUDIT_EXPORT_VERSION);
  const out = [];
  for (const raw of safeRows) {
    const norm = _normalize(raw);
    if (!norm) continue;
    const op = norm.op || 'audit';
    const sigId = _cefHeaderField(op);
    const name = _cefHeaderField(op);
    const severity = _severityForOp(op);
    const extPairs = [];
    // CEF custom + standard extensions. Standard CEF names (rt, suser,
    // src, requestClientApplication) ride alongside kolm-custom for SIEM
    // operators who key on CEF defaults.
    if (norm.ts_iso) extPairs.push('rt=' + _cefExtensionValue(norm.ts_iso));
    if (norm.tenant_id) extPairs.push('cs1=' + _cefExtensionValue(norm.tenant_id) + ' cs1Label=tenant_id');
    if (norm.operator_id) extPairs.push('suser=' + _cefExtensionValue(norm.operator_id));
    if (norm.target_kind) extPairs.push('cs2=' + _cefExtensionValue(norm.target_kind) + ' cs2Label=target_kind');
    if (norm.target_id) extPairs.push('cs3=' + _cefExtensionValue(norm.target_id) + ' cs3Label=target_id');
    if (norm.outcome) extPairs.push('outcome=' + _cefExtensionValue(norm.outcome));
    if (norm.source_ip) extPairs.push('src=' + _cefExtensionValue(norm.source_ip));
    if (norm.user_agent) extPairs.push('requestClientApplication=' + _cefExtensionValue(norm.user_agent));
    if (norm.request_id) extPairs.push('cs4=' + _cefExtensionValue(norm.request_id) + ' cs4Label=request_id');
    if (norm.meta_hash) extPairs.push('cs5=' + _cefExtensionValue(norm.meta_hash) + ' cs5Label=meta_hash');
    const extension = extPairs.join(' ');
    out.push(`CEF:0|${vendor}|${product}|${version}|${sigId}|${name}|${severity}|${extension}`);
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

// =============================================================================
// LEEF (QRadar LEEF v2.0).
// Reference: https://www.ibm.com/docs/en/dsm?topic=overview-leef-event-components
// Header layout (LEEF v2):
//   LEEF:2.0|Vendor|Product|Version|EventID|<delimiter>|<extension>
// Caret (^) is the canonical custom delimiter when keys may carry `=`.
// Extension is key<delimiter>value separated by the same delimiter again
// for pair-to-pair; we use one delimiter throughout: `key=value^key=value`.
// =============================================================================

function _leefHeaderField(v) {
  if (v == null) return '';
  return String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function _leefExtensionValue(v) {
  if (v == null) return '';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\^/g, '\\^')
    .replace(/\r?\n/g, '\\n');
}

export function toLeef(rows, opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const vendor = _leefHeaderField('kolm.ai');
  const product = _leefHeaderField('kolm');
  const version = _leefHeaderField((opts && opts.version) || AUDIT_EXPORT_VERSION);
  const out = [];
  for (const raw of safeRows) {
    const norm = _normalize(raw);
    if (!norm) continue;
    const op = norm.op || 'audit';
    const eventId = _leefHeaderField(op);
    const pairs = [];
    if (norm.ts_iso) pairs.push('devTime=' + _leefExtensionValue(norm.ts_iso));
    if (norm.tenant_id) pairs.push('tenant_id=' + _leefExtensionValue(norm.tenant_id));
    if (norm.operator_id) pairs.push('usrName=' + _leefExtensionValue(norm.operator_id));
    if (norm.op) pairs.push('cat=' + _leefExtensionValue(norm.op));
    if (norm.target_kind) pairs.push('target_kind=' + _leefExtensionValue(norm.target_kind));
    if (norm.target_id) pairs.push('target_id=' + _leefExtensionValue(norm.target_id));
    if (norm.outcome) pairs.push('outcome=' + _leefExtensionValue(norm.outcome));
    if (norm.source_ip) pairs.push('src=' + _leefExtensionValue(norm.source_ip));
    if (norm.user_agent) pairs.push('userAgent=' + _leefExtensionValue(norm.user_agent));
    if (norm.request_id) pairs.push('request_id=' + _leefExtensionValue(norm.request_id));
    if (norm.meta_hash) pairs.push('meta_hash=' + _leefExtensionValue(norm.meta_hash));
    // LEEF v2 header includes a literal delimiter slot; we use caret.
    out.push(`LEEF:2.0|${vendor}|${product}|${version}|${eventId}|^|${pairs.join('^')}`);
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

// =============================================================================
// JSONL - one JSON object per line. Splunk + Loki + most modern aggregators
// ingest this natively. mime type: application/x-ndjson.
// =============================================================================
export function toJsonLines(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const raw of safeRows) {
    const norm = _normalize(raw);
    if (!norm) continue;
    out.push(JSON.stringify(norm));
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

// =============================================================================
// MIME type table per format. Single source of truth so the HTTP route and
// the CLI report the same Content-Type without drift.
// =============================================================================
const MIME_BY_FORMAT = Object.freeze({
  csv:  'text/csv; charset=utf-8',
  cef:  'text/plain; charset=utf-8',
  leef: 'text/plain; charset=utf-8',
  json: 'application/x-ndjson; charset=utf-8',
});

export function mimeTypeForFormat(format) {
  return MIME_BY_FORMAT[String(format || '').toLowerCase()] || 'application/octet-stream';
}

// =============================================================================
// Time-range filter (inclusive both ends). Tolerant to missing ts_iso rows
// (those rows pass through unconditionally so a half-typed row is not silently
// dropped from export - the operator can spot it in the output).
// =============================================================================
function _withinRange(row, fromMs, toMs) {
  if (fromMs == null && toMs == null) return true;
  const t = Date.parse(row.at || row.ts_iso || row.timestamp || '');
  if (!Number.isFinite(t)) return true;
  if (fromMs != null && t < fromMs) return false;
  if (toMs != null && t > toMs) return false;
  return true;
}

function _parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length === 0) return null;
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(s);
  if (!Number.isNaN(asDate)) return asDate;
  return null;
}

const DEFAULT_MAX_ROWS = 10000;
const HARD_MAX_ROWS = 100000;

// =============================================================================
// exportAuditEvents - orchestrator. Tenant-fenced, format-validated,
// range-filtered, capped. Returns honest envelope or success envelope.
//
// W411 defense-in-depth: reads all + per-row tenant filter. NEVER uses
// findByTenant on audit_events because field-key mismatch (see file
// header comment).
// =============================================================================
export function exportAuditEvents({
  tenant_id,
  format = 'json',
  from = null,
  to = null,
  max_rows = DEFAULT_MAX_ROWS,
  opts = {},
} = {}) {
  // Honesty: empty tenant_id is never okay. Cross-tenant leak is a P0
  // security incident; we refuse rather than guess.
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id: "<id>"}. Audit export is tenant-scoped; the route auto-fills from req.tenant_record.id.',
      version: AUDIT_EXPORT_VERSION,
    };
  }
  // Format defaulting MUST distinguish "caller omitted format" (use default
  // 'json') from "caller passed format='' or other falsy string" (honest
  // bad_format envelope). Using `format || 'json'` would silently coerce
  // '' -> 'json' and mask the bad input - that's a silent-pass and would
  // hide a bug in the caller.
  const fmt = (format == null)
    ? 'json'
    : String(format).toLowerCase();
  if (!EXPORT_FORMATS.includes(fmt)) {
    return {
      ok: false,
      error: 'bad_format',
      hint: `format must be one of ${JSON.stringify(EXPORT_FORMATS)}; got ${JSON.stringify(format)}`,
      supported: EXPORT_FORMATS,
      version: AUDIT_EXPORT_VERSION,
    };
  }
  const fromMs = _parseTime(from);
  const toMs = _parseTime(to);
  // Cap clamp. Floor of 1 (zero would be a silent backdoor: "I asked for
  // export, got empty body, must be empty audit log"). Hard ceiling
  // prevents accidental megaresponse to memory-bounded SIEM agents.
  let cap = Number(max_rows);
  if (!Number.isFinite(cap) || cap < 1) cap = DEFAULT_MAX_ROWS;
  if (cap > HARD_MAX_ROWS) cap = HARD_MAX_ROWS;

  const storeMod = (opts && opts.storeMod) || defaultStoreMod;
  const all = (storeMod && typeof storeMod.all === 'function') ? storeMod.all : null;
  if (!all) {
    return {
      ok: false,
      error: 'store_not_wired',
      hint: 'opts.storeMod must expose all(table) - default is src/store.js',
      version: AUDIT_EXPORT_VERSION,
    };
  }
  const rawRows = all(AUDIT_TABLE) || [];

  // W411 defense-in-depth tenant fence: per-row filter even after we
  // could "trust" the table read. This is the audit-export law because
  // future store schema changes could change all()'s tenant semantics.
  const tenantRows = rawRows.filter((r) => r && r.tenant_id === tenant_id);

  // Time-range filter (no-op when both are null).
  const ranged = (fromMs == null && toMs == null)
    ? tenantRows
    : tenantRows.filter((r) => _withinRange(r, fromMs, toMs));

  // Most-recent-first ordering - matches the audit-log UI + CLI sort so
  // operators see the same head/tail across surfaces.
  const sorted = ranged.slice().sort((a, b) => {
    const ta = Date.parse(a.at || a.ts_iso || '') || 0;
    const tb = Date.parse(b.at || b.ts_iso || '') || 0;
    return tb - ta;
  });

  const total_in_range = sorted.length;
  const capped = sorted.slice(0, cap);

  let body;
  switch (fmt) {
    case 'csv':  body = toCsv(capped); break;
    case 'cef':  body = toCef(capped); break;
    case 'leef': body = toLeef(capped); break;
    case 'json': body = toJsonLines(capped); break;
    default:
      // Defensive - format already validated above. Keep an honest envelope
      // so a future refactor doesn't accidentally silent-pass.
      return {
        ok: false,
        error: 'bad_format',
        version: AUDIT_EXPORT_VERSION,
      };
  }
  return {
    ok: true,
    format: fmt,
    mime_type: mimeTypeForFormat(fmt),
    body,
    row_count: capped.length,
    total_in_range,
    truncated: capped.length < total_in_range,
    max_rows: cap,
    version: AUDIT_EXPORT_VERSION,
    generated_at: new Date().toISOString(),
  };
}

// =============================================================================
// previewExport - first 10 rows + total_would_export.
// HONESTY: caps at 10 hard - preview is a UI helper, never a full-dump
// backdoor. The total_would_export field surfaces how much would ship in
// a full export so the UI can show "showing 10 of 12345".
// =============================================================================
const PREVIEW_HARD_CAP = 10;

export function previewExport({
  tenant_id,
  format = 'json',
  from = null,
  to = null,
  opts = {},
} = {}) {
  // Use the same envelope contract as exportAuditEvents for bad input.
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: AUDIT_EXPORT_VERSION,
    };
  }
  // Same honest-default policy as exportAuditEvents: explicit empty/falsy
  // string is bad_format, not silently coerced to 'json'.
  const fmt = (format == null)
    ? 'json'
    : String(format).toLowerCase();
  if (!EXPORT_FORMATS.includes(fmt)) {
    return {
      ok: false,
      error: 'bad_format',
      supported: EXPORT_FORMATS,
      version: AUDIT_EXPORT_VERSION,
    };
  }
  // Re-use the orchestrator with a giant cap so total_in_range is honest,
  // then slice the body. We deliberately call exportAuditEvents twice-free
  // by passing the max as PREVIEW_HARD_CAP and reading total_in_range from
  // the same envelope so previewExport never silently misreports the count.
  const full = exportAuditEvents({
    tenant_id,
    format: fmt,
    from,
    to,
    max_rows: HARD_MAX_ROWS,
    opts,
  });
  if (!full.ok) return full;

  // Re-encode just the preview-capped slice so the body is small.
  const storeMod = (opts && opts.storeMod) || defaultStoreMod;
  const all = storeMod.all;
  const rawRows = all(AUDIT_TABLE) || [];
  const tenantRows = rawRows.filter((r) => r && r.tenant_id === tenant_id);
  const fromMs = _parseTime(from);
  const toMs = _parseTime(to);
  const ranged = (fromMs == null && toMs == null)
    ? tenantRows
    : tenantRows.filter((r) => _withinRange(r, fromMs, toMs));
  const sorted = ranged.slice().sort((a, b) => {
    const ta = Date.parse(a.at || a.ts_iso || '') || 0;
    const tb = Date.parse(b.at || b.ts_iso || '') || 0;
    return tb - ta;
  });
  const preview = sorted.slice(0, PREVIEW_HARD_CAP);
  let body;
  switch (fmt) {
    case 'csv':  body = toCsv(preview); break;
    case 'cef':  body = toCef(preview); break;
    case 'leef': body = toLeef(preview); break;
    case 'json': body = toJsonLines(preview); break;
  }
  return {
    ok: true,
    format: fmt,
    mime_type: mimeTypeForFormat(fmt),
    body,
    preview_row_count: preview.length,
    total_would_export: sorted.length,
    preview_cap: PREVIEW_HARD_CAP,
    version: AUDIT_EXPORT_VERSION,
    generated_at: new Date().toISOString(),
  };
}

// Lightweight introspection for /v1/audit/export/formats and CLI `formats`.
export function listExportFormats() {
  return {
    ok: true,
    formats: EXPORT_FORMATS,
    csv_columns: CSV_COLUMNS,
    mime_by_format: { ...MIME_BY_FORMAT },
    version: AUDIT_EXPORT_VERSION,
  };
}
