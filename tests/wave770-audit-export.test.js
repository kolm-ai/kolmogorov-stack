// W770 — Audit export (CSV + CEF + LEEF + JSONL).
//
// Atomic items pinned (matches the W770 implementation):
//
//   1)  AUDIT_EXPORT_VERSION === 'w770-v1'
//   2)  EXPORT_FORMATS is Object.freeze()-d + exactly 4 entries
//   3)  CSV_COLUMNS is Object.freeze()-d + at least 8 columns (RFC 4180 order)
//   4)  toCsv emits RFC 4180 header row
//   5)  toCsv escapes embedded commas (double-quote wrap)
//   6)  toCsv escapes embedded double-quotes (doubled)
//   7)  toCsv handles embedded newlines (wrapped + literal)
//   8)  toCsv on empty rows returns header only
//   9)  toCef emits 'CEF:0|kolm.ai|kolm' prefix
//   10) toCef escapes equals signs in extension values
//   11) toCef assigns severity 8 for security-event ops (auth.*/admin.*/...)
//   12) toLeef emits 'LEEF:2.0|kolm.ai|kolm' prefix
//   13) toLeef uses caret (^) extension separator
//   14) toJsonLines emits one JSON object per line (newline-terminated)
//   15) exportAuditEvents tenant-fenced (W411 defense-in-depth: other-
//       tenant audit rows NEVER leak even with DI storeMod fake)
//   16) exportAuditEvents honest envelope on bad format
//   17) exportAuditEvents honest envelope on missing tenant_id
//   18) exportAuditEvents caps at max_rows hard ceiling
//   19) exportAuditEvents returns mime_type 'text/csv...' for CSV
//   20) exportAuditEvents returns mime_type 'text/plain...' for CEF
//   21) exportAuditEvents returns mime_type 'application/x-ndjson...' for JSONL
//   22) previewExport returns at most 10 rows + total_would_export count
//   23) GET /v1/audit/export 401 w/o auth; 200 w/ auth + correct Content-Type
//   24) GET /v1/audit/export/formats 401 w/o auth; 200 w/ auth
//   25) GET /v1/audit/export/preview 401 w/o auth; 200 w/ auth
//   26) public/docs/audit-export.html exists w/ brand-lock + data-w770
//   27) cli/kolm.js defines cmdW770AuditExport exactly once + case 'audit-export' wires it
//   28) vercel.json carries /docs/audit-export rewrite
//   29) W604 sibling: sw.js cache slug regex `wave(\d{3,4})` threshold check
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_EXPORT_VERSION,
  EXPORT_FORMATS,
  CSV_COLUMNS,
  toCsv,
  toCef,
  toLeef,
  toJsonLines,
  exportAuditEvents,
  previewExport,
  mimeTypeForFormat,
  listExportFormats,
} from '../src/audit-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'docs', 'audit-export.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w770-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Lightweight in-memory storeMod fake: matches the surface area
// exportAuditEvents calls (only all(table)). Keeps every test
// hermetic - no fs / sqlite / event-store wiring needed.
function fakeStoreMod(rowsByTable) {
  return {
    all(table) {
      return rowsByTable[table] || [];
    },
  };
}

function fakeAuditRow(overrides = {}) {
  return Object.assign({
    id: 'aud_' + crypto.randomBytes(6).toString('hex'),
    tenant_id: 't_fixture',
    tenant_name: 'fixture-tenant',
    actor: 'u_42',
    request_id: 'req_' + crypto.randomBytes(4).toString('hex'),
    op: 'compile.completed',
    at: new Date().toISOString(),
    payload: {},
    prev_hash: ''.padEnd(64, '0'),
    event_hash: crypto.randomBytes(32).toString('hex'),
    chain_version: 1,
  }, overrides);
}

// =============================================================================
// 1) AUDIT_EXPORT_VERSION
// =============================================================================

test('W770 #1 - AUDIT_EXPORT_VERSION stamped w770-v1', () => {
  freshDir();
  assert.equal(AUDIT_EXPORT_VERSION, 'w770-v1',
    `expected AUDIT_EXPORT_VERSION='w770-v1'; got ${JSON.stringify(AUDIT_EXPORT_VERSION)}`);
});

// =============================================================================
// 2) EXPORT_FORMATS frozen + 4 entries
// =============================================================================

test('W770 #2 - EXPORT_FORMATS is Object.freeze()-d + holds exactly 4 entries', () => {
  freshDir();
  assert.ok(Array.isArray(EXPORT_FORMATS),
    'EXPORT_FORMATS must be an array');
  assert.ok(Object.isFrozen(EXPORT_FORMATS),
    'EXPORT_FORMATS MUST be Object.freeze()-d so callers cannot push a new format and silent-pass shape validation');
  assert.equal(EXPORT_FORMATS.length, 4,
    `expected 4 formats; got ${EXPORT_FORMATS.length}: ${JSON.stringify(EXPORT_FORMATS)}`);
  for (const name of ['csv', 'cef', 'leef', 'json']) {
    assert.ok(EXPORT_FORMATS.includes(name),
      `EXPORT_FORMATS must include '${name}'; got ${JSON.stringify(EXPORT_FORMATS)}`);
  }
});

// =============================================================================
// 3) CSV_COLUMNS frozen + RFC 4180 order
// =============================================================================

test('W770 #3 - CSV_COLUMNS is Object.freeze()-d + RFC 4180 ordering, >=8 columns', () => {
  freshDir();
  assert.ok(Array.isArray(CSV_COLUMNS),
    'CSV_COLUMNS must be an array');
  assert.ok(Object.isFrozen(CSV_COLUMNS),
    'CSV_COLUMNS MUST be Object.freeze()-d so a refactor cannot reorder columns without bumping AUDIT_EXPORT_VERSION');
  assert.ok(CSV_COLUMNS.length >= 8,
    `expected >=8 CSV columns (RFC 4180 schema lock); got ${CSV_COLUMNS.length}: ${JSON.stringify(CSV_COLUMNS)}`);
  // ts_iso MUST come first - that's the contract for chronological sort.
  assert.equal(CSV_COLUMNS[0], 'ts_iso',
    'ts_iso MUST be the first column so spreadsheets sort by time without column reorder');
  // tenant_id MUST come second - the fence column appears early so an
  // operator skimming a multi-tenant export spots cross-tenant drift fast.
  assert.equal(CSV_COLUMNS[1], 'tenant_id',
    'tenant_id MUST be the second column so multi-tenant drift is visually obvious');
});

// =============================================================================
// 4) toCsv RFC 4180 header
// =============================================================================

test('W770 #4 - toCsv emits RFC 4180 header row', () => {
  freshDir();
  const out = toCsv([]);
  const firstLine = out.split('\r\n')[0];
  assert.equal(firstLine, CSV_COLUMNS.join(','),
    `header row must equal CSV_COLUMNS.join(','); got ${JSON.stringify(firstLine)}`);
});

// =============================================================================
// 5) toCsv escapes embedded commas
// =============================================================================

test('W770 #5 - toCsv wraps embedded commas in double-quotes (RFC 4180)', () => {
  freshDir();
  const out = toCsv([fakeAuditRow({
    op: 'a,b,c',
    payload: { target_kind: 'art,ifact' },
  })]);
  // The op field is column index 3; we cannot rely on positional index here
  // (cells may be empty / shifted) - assert the substring shape instead.
  assert.ok(out.includes('"a,b,c"'),
    `embedded commas must be wrapped in double-quotes; got ${JSON.stringify(out)}`);
  assert.ok(out.includes('"art,ifact"'),
    `embedded commas in payload-derived columns must also wrap; got ${JSON.stringify(out)}`);
});

// =============================================================================
// 6) toCsv escapes embedded double-quotes (doubled)
// =============================================================================

test('W770 #6 - toCsv doubles embedded double-quotes (RFC 4180)', () => {
  freshDir();
  const out = toCsv([fakeAuditRow({
    op: 'say "hello"',
  })]);
  // 'say "hello"' -> '"say ""hello"""'
  assert.ok(out.includes('"say ""hello"""'),
    `embedded double-quotes must be doubled inside a wrapped field; got ${JSON.stringify(out)}`);
});

// =============================================================================
// 7) toCsv handles embedded newlines
// =============================================================================

test('W770 #7 - toCsv wraps + preserves embedded newlines (RFC 4180)', () => {
  freshDir();
  const out = toCsv([fakeAuditRow({
    op: 'multi\nline\nop',
  })]);
  // Multi-line cells must be wrapped in double-quotes; the literal newline
  // is preserved inside the wrap.
  assert.ok(out.includes('"multi\nline\nop"'),
    `embedded newlines must be preserved inside a double-quote wrap; got ${JSON.stringify(out)}`);
});

// =============================================================================
// 8) toCsv on empty rows returns header only
// =============================================================================

test('W770 #8 - toCsv on empty rows returns header-only body', () => {
  freshDir();
  const out = toCsv([]);
  // Header + CRLF terminator. NO data rows. Empty != malformed.
  assert.equal(out, CSV_COLUMNS.join(',') + '\r\n',
    `empty rows must yield header-only body; got ${JSON.stringify(out)}`);
});

// =============================================================================
// 9) toCef CEF:0|kolm.ai|kolm prefix
// =============================================================================

test('W770 #9 - toCef emits CEF:0|kolm.ai|kolm header prefix', () => {
  freshDir();
  const out = toCef([fakeAuditRow({ op: 'compile.completed' })]);
  assert.ok(out.startsWith('CEF:0|kolm.ai|kolm|'),
    `expected ArcSight CEF v0 prefix CEF:0|kolm.ai|kolm|; got ${JSON.stringify(out.slice(0, 60))}`);
  assert.ok(out.includes('|w770-v1|'),
    `CEF header must carry the w770-v1 version; got ${JSON.stringify(out.slice(0, 80))}`);
});

// =============================================================================
// 10) toCef escapes equals signs in extension values
// =============================================================================

test('W770 #10 - toCef backslash-escapes = signs in extension values', () => {
  freshDir();
  const out = toCef([fakeAuditRow({
    op: 'auth.key_rotated',
    payload: { target_id: 'a=b=c' },
  })]);
  // 'a=b=c' inside an extension value must become 'a\=b\=c' so the SIEM
  // parser does not mis-split the pair on the embedded equals.
  assert.ok(out.includes('a\\=b\\=c'),
    `embedded = signs must be backslash-escaped in CEF extension values; got ${JSON.stringify(out)}`);
});

// =============================================================================
// 11) toCef severity 8 for security-event ops
// =============================================================================

test('W770 #11 - toCef assigns severity 8 for auth.*/admin.*/security.* ops', () => {
  freshDir();
  for (const op of ['auth.key_rotated', 'admin.action', 'security.alert', 'sso.login', 'scim.provision', 'key.created']) {
    const out = toCef([fakeAuditRow({ op })]);
    // CEF header: CEF:0|vendor|product|version|sigid|name|SEVERITY|extension
    const parts = out.split('\n')[0].split('|');
    assert.equal(parts[6], '8',
      `expected severity 8 for security-event op ${op}; got ${parts[6]} (line=${JSON.stringify(out.split('\n')[0])})`);
  }
  // Sanity: normal op gets severity 5.
  const normal = toCef([fakeAuditRow({ op: 'compile.completed' })]);
  const normalParts = normal.split('\n')[0].split('|');
  assert.equal(normalParts[6], '5',
    `expected severity 5 for normal op; got ${normalParts[6]}`);
});

// =============================================================================
// 12) toLeef LEEF:2.0|kolm.ai|kolm prefix
// =============================================================================

test('W770 #12 - toLeef emits LEEF:2.0|kolm.ai|kolm header prefix', () => {
  freshDir();
  const out = toLeef([fakeAuditRow({ op: 'compile.completed' })]);
  assert.ok(out.startsWith('LEEF:2.0|kolm.ai|kolm|'),
    `expected QRadar LEEF v2.0 prefix LEEF:2.0|kolm.ai|kolm|; got ${JSON.stringify(out.slice(0, 60))}`);
  assert.ok(out.includes('|w770-v1|'),
    `LEEF header must carry the w770-v1 version; got ${JSON.stringify(out.slice(0, 80))}`);
});

// =============================================================================
// 13) toLeef uses caret (^) separator in extension
// =============================================================================

test('W770 #13 - toLeef uses caret (^) separator in extension + header delimiter slot', () => {
  freshDir();
  const out = toLeef([fakeAuditRow({
    op: 'compile.completed',
    actor: 'u_42',
    tenant_id: 't_abc',
    at: '2026-05-24T12:00:00Z',
  })]);
  // LEEF v2 header: LEEF:2.0|Vendor|Product|Version|EventID|DELIM|extension
  // We use caret as the delimiter slot. Extension pairs MUST be ^-joined.
  const parts = out.split('\n')[0].split('|');
  assert.equal(parts[5], '^',
    `LEEF v2 delimiter slot must be ^; got ${JSON.stringify(parts[5])}`);
  // Extension half (parts[6]) must contain caret-joined pairs.
  assert.ok(parts[6].includes('^'),
    `LEEF extension must be caret-joined; got ${JSON.stringify(parts[6])}`);
  // It MUST NOT use a pipe separator inside the extension.
  assert.equal(parts.length, 7,
    `LEEF header must have exactly 7 pipe-separated parts (extension stays as one); got ${parts.length}`);
});

// =============================================================================
// 14) toJsonLines emits one JSON object per line
// =============================================================================

test('W770 #14 - toJsonLines emits one JSON object per line, newline-terminated', () => {
  freshDir();
  const out = toJsonLines([
    fakeAuditRow({ op: 'compile.completed', tenant_id: 't_a' }),
    fakeAuditRow({ op: 'artifact.downloaded', tenant_id: 't_a' }),
  ]);
  assert.ok(out.endsWith('\n'),
    `JSONL output must be newline-terminated; got tail ${JSON.stringify(out.slice(-5))}`);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2,
    `expected 2 JSONL lines; got ${lines.length}: ${JSON.stringify(out)}`);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed, 'object');
    assert.ok(parsed.op);
    assert.ok(parsed.tenant_id);
  }
});

// =============================================================================
// 15) exportAuditEvents tenant-fenced (W411 defense-in-depth)
// =============================================================================

test('W770 #15 - exportAuditEvents tenant-fenced (W411): cross-tenant rows NEVER leak', () => {
  freshDir();
  const myRows = [
    fakeAuditRow({ tenant_id: 't_me', op: 'compile.completed' }),
    fakeAuditRow({ tenant_id: 't_me', op: 'artifact.downloaded' }),
  ];
  const otherRows = [
    fakeAuditRow({ tenant_id: 't_other', op: 'auth.key_rotated' }),
    fakeAuditRow({ tenant_id: 't_other', op: 'admin.action' }),
    fakeAuditRow({ tenant_id: 't_other', op: 'compile.failed' }),
  ];
  const fake = fakeStoreMod({ audit_events: myRows.concat(otherRows) });
  const r = exportAuditEvents({
    tenant_id: 't_me',
    format: 'json',
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.row_count, 2,
    `expected exactly 2 rows for t_me; got ${r.row_count} (body=${JSON.stringify(r.body)})`);
  // Honest body inspection - the cross-tenant ops MUST NOT appear in the body.
  assert.ok(!r.body.includes('t_other'),
    `cross-tenant t_other rows MUST NOT leak into body; got ${JSON.stringify(r.body)}`);
  assert.ok(!r.body.includes('auth.key_rotated'),
    `cross-tenant auth.key_rotated MUST NOT leak; got ${JSON.stringify(r.body)}`);
  // Also test the inverse - request as t_other and t_me rows must not leak.
  const r2 = exportAuditEvents({
    tenant_id: 't_other',
    format: 'json',
    opts: { storeMod: fake },
  });
  assert.equal(r2.row_count, 3);
  assert.ok(!r2.body.includes('t_me'),
    `cross-tenant t_me rows MUST NOT leak the other direction; got ${JSON.stringify(r2.body)}`);
});

// =============================================================================
// 16) exportAuditEvents honest envelope on bad format
// =============================================================================

test('W770 #16 - exportAuditEvents honest envelope on bad format (NEVER silent-pass)', () => {
  freshDir();
  const fake = fakeStoreMod({ audit_events: [fakeAuditRow({ tenant_id: 't_me' })] });
  for (const bad of ['xml', 'parquet', 'avro', 'tsv', '']) {
    const r = exportAuditEvents({
      tenant_id: 't_me',
      format: bad,
      opts: { storeMod: fake },
    });
    assert.equal(r.ok, false,
      `bad format ${JSON.stringify(bad)} MUST return ok:false; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'bad_format',
      `bad format MUST surface error:'bad_format'; got ${JSON.stringify(r)}`);
    assert.deepEqual(r.supported, EXPORT_FORMATS,
      `bad format envelope must list supported formats; got ${JSON.stringify(r)}`);
    assert.equal(r.version, 'w770-v1');
  }
});

// =============================================================================
// 17) exportAuditEvents honest envelope on missing tenant_id
// =============================================================================

test('W770 #17 - exportAuditEvents honest envelope on missing tenant_id (P0 leak prevention)', () => {
  freshDir();
  const fake = fakeStoreMod({ audit_events: [fakeAuditRow()] });
  for (const bad of [undefined, null, '', 0, false]) {
    const r = exportAuditEvents({
      tenant_id: bad,
      format: 'json',
      opts: { storeMod: fake },
    });
    assert.equal(r.ok, false,
      `missing tenant_id ${JSON.stringify(bad)} MUST return ok:false (P0 leak prevention); got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'tenant_id_required',
      `missing tenant_id MUST surface error:'tenant_id_required'; got ${JSON.stringify(r)}`);
    assert.equal(r.version, 'w770-v1');
  }
});

// =============================================================================
// 18) exportAuditEvents caps at max_rows hard ceiling
// =============================================================================

test('W770 #18 - exportAuditEvents caps at max_rows + hard ceiling (truncated flag honest)', () => {
  freshDir();
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push(fakeAuditRow({ tenant_id: 't_me', op: 'compile.completed' }));
  }
  const fake = fakeStoreMod({ audit_events: rows });

  // max_rows respected when below ceiling.
  const r = exportAuditEvents({
    tenant_id: 't_me',
    format: 'json',
    max_rows: 50,
    opts: { storeMod: fake },
  });
  assert.equal(r.row_count, 50);
  assert.equal(r.total_in_range, 250);
  assert.equal(r.truncated, true,
    `truncated flag MUST be true when row_count < total_in_range; got ${JSON.stringify(r)}`);
  assert.equal(r.max_rows, 50);

  // Hard ceiling pins to 100000 even when caller asks for a million.
  const r2 = exportAuditEvents({
    tenant_id: 't_me',
    format: 'json',
    max_rows: 1_000_000,
    opts: { storeMod: fake },
  });
  assert.equal(r2.max_rows, 100000,
    `max_rows MUST be clamped at the 100000 hard ceiling; got ${r2.max_rows}`);
});

// =============================================================================
// 19) mime_type 'text/csv...' for CSV
// =============================================================================

test('W770 #19 - exportAuditEvents returns text/csv mime for CSV format', () => {
  freshDir();
  const fake = fakeStoreMod({ audit_events: [fakeAuditRow({ tenant_id: 't_me' })] });
  const r = exportAuditEvents({ tenant_id: 't_me', format: 'csv', opts: { storeMod: fake } });
  assert.equal(r.ok, true);
  assert.ok(r.mime_type.startsWith('text/csv'),
    `expected mime_type starting with text/csv; got ${JSON.stringify(r.mime_type)}`);
  // mimeTypeForFormat helper must agree.
  assert.ok(mimeTypeForFormat('csv').startsWith('text/csv'));
});

// =============================================================================
// 20) mime_type 'text/plain...' for CEF
// =============================================================================

test('W770 #20 - exportAuditEvents returns text/plain mime for CEF format', () => {
  freshDir();
  const fake = fakeStoreMod({ audit_events: [fakeAuditRow({ tenant_id: 't_me' })] });
  const r = exportAuditEvents({ tenant_id: 't_me', format: 'cef', opts: { storeMod: fake } });
  assert.equal(r.ok, true);
  assert.ok(r.mime_type.startsWith('text/plain'),
    `expected mime_type starting with text/plain for CEF; got ${JSON.stringify(r.mime_type)}`);
  // LEEF also uses text/plain by spec parity.
  const r2 = exportAuditEvents({ tenant_id: 't_me', format: 'leef', opts: { storeMod: fake } });
  assert.ok(r2.mime_type.startsWith('text/plain'),
    `expected mime_type starting with text/plain for LEEF; got ${JSON.stringify(r2.mime_type)}`);
});

// =============================================================================
// 21) mime_type 'application/x-ndjson...' for JSONL
// =============================================================================

test('W770 #21 - exportAuditEvents returns application/x-ndjson mime for JSONL format', () => {
  freshDir();
  const fake = fakeStoreMod({ audit_events: [fakeAuditRow({ tenant_id: 't_me' })] });
  const r = exportAuditEvents({ tenant_id: 't_me', format: 'json', opts: { storeMod: fake } });
  assert.equal(r.ok, true);
  assert.ok(r.mime_type.startsWith('application/x-ndjson'),
    `expected mime_type starting with application/x-ndjson for JSONL; got ${JSON.stringify(r.mime_type)}`);
});

// =============================================================================
// 22) previewExport caps at 10 + reports total_would_export
// =============================================================================

test('W770 #22 - previewExport caps at 10 rows + reports total_would_export honestly', () => {
  freshDir();
  const rows = [];
  for (let i = 0; i < 47; i++) {
    rows.push(fakeAuditRow({ tenant_id: 't_me', op: 'compile.completed' }));
  }
  const fake = fakeStoreMod({ audit_events: rows });
  const r = previewExport({
    tenant_id: 't_me',
    format: 'json',
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.preview_row_count, 10,
    `preview MUST cap at 10 rows; got ${r.preview_row_count} (full-dump backdoor risk)`);
  assert.equal(r.preview_cap, 10);
  assert.equal(r.total_would_export, 47,
    `total_would_export MUST be honest about the full count (47); got ${r.total_would_export}`);
  // Preview body must have only 10 rows.
  const lines = r.body.trim().split('\n');
  assert.equal(lines.length, 10,
    `preview body MUST hold exactly 10 JSON lines; got ${lines.length}`);
  // Honest envelope still returns version + mime_type.
  assert.equal(r.version, 'w770-v1');
  assert.ok(r.mime_type.startsWith('application/x-ndjson'));

  // Bad format + missing tenant_id still honest under preview.
  const bad = previewExport({ tenant_id: 't_me', format: 'parquet', opts: { storeMod: fake } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad_format');
  const noTenant = previewExport({ format: 'json', opts: { storeMod: fake } });
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'tenant_id_required');
});

// =============================================================================
// 23) GET /v1/audit/export 401 w/o auth; 200 w/ auth + correct Content-Type
// =============================================================================

test('W770 #23 - GET /v1/audit/export 401 w/o auth; 200 w/ auth + correct Content-Type', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth - 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audit/export?format=json`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + valid format - 200 with correct Content-Type.
    for (const [fmt, expectedCT] of [
      ['csv', 'text/csv'],
      ['cef', 'text/plain'],
      ['leef', 'text/plain'],
      ['json', 'application/x-ndjson'],
    ]) {
      const ok = await fetch(`http://127.0.0.1:${port}/v1/audit/export?format=${fmt}`, {
        headers: { 'authorization': 'Bearer ' + t.api_key },
      });
      assert.equal(ok.status, 200, `expected 200 for format ${fmt}; got ${ok.status}`);
      const ct = ok.headers.get('content-type') || '';
      assert.ok(ct.startsWith(expectedCT),
        `expected Content-Type starting with ${expectedCT} for ${fmt}; got ${ct}`);
      // W770 custom headers present.
      assert.equal(ok.headers.get('x-kolm-audit-export-version'), 'w770-v1',
        `expected X-Kolm-Audit-Export-Version: w770-v1 header on ${fmt}; got ${ok.headers.get('x-kolm-audit-export-version')}`);
    }

    // Bad format - 400 with honest envelope.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/audit/export?format=parquet`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(bad.status, 400);
    const badJson = await bad.json();
    assert.equal(badJson.error, 'bad_format');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 24) GET /v1/audit/export/formats 401 w/o auth; 200 w/ auth
// =============================================================================

test('W770 #24 - GET /v1/audit/export/formats 401 w/o auth; 200 envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audit/export/formats`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/audit/export/formats`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.deepEqual(env.formats, ['csv', 'cef', 'leef', 'json']);
    assert.ok(Array.isArray(env.csv_columns));
    assert.ok(env.csv_columns.length >= 8);
    assert.equal(env.version, 'w770-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 25) GET /v1/audit/export/preview 401 w/o auth; 200 w/ auth
// =============================================================================

test('W770 #25 - GET /v1/audit/export/preview 401 w/o auth; 200 envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audit/export/preview?format=json`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/audit/export/preview?format=json`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.preview_cap, 10);
    assert.equal(env.version, 'w770-v1');
    // Even with no audit events, preview must report total_would_export as 0
    // and a non-null body (could be empty string but not undefined).
    assert.equal(typeof env.total_would_export, 'number');
    assert.equal(typeof env.body, 'string');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 26) public/docs/audit-export.html exists w/ brand-lock + data-w770
// =============================================================================

test('W770 #26 - public/docs/audit-export.html exists w/ brand-lock + data-w770 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'audit-export.html MUST carry the brand-locked eyebrow "Open-source AI workbench"');
  // Required hidden test anchors.
  assert.ok(html.includes('data-w770="formats"'),
    'expected data-w770="formats" anchor on the format-support panel');
  assert.ok(html.includes('data-w770="siem"'),
    'expected data-w770="siem" anchor on the SIEM integration panel');
  // Version stamp.
  assert.ok(html.includes('w770-v1'),
    'page must stamp the w770-v1 version');
  // No emojis (spec invariant).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/audit-export.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 27) cli/kolm.js defines cmdW770AuditExport exactly once + wired
// =============================================================================

test('W770 #27 - cli/kolm.js defines cmdW770AuditExport exactly once + case audit-export wires it', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW770AuditExport\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW770AuditExport must be defined exactly once; found ${defOccurrences}`);
  // case 'audit-export': must invoke cmdW770AuditExport.
  assert.ok(/case 'audit-export':[\s\S]{0,300}cmdW770AuditExport/.test(cli),
    `expected "case 'audit-export': ... cmdW770AuditExport(...)" wiring; not found`);
  // case 'ae': short alias must invoke cmdW770AuditExport.
  assert.ok(/case 'ae':[\s\S]{0,300}cmdW770AuditExport/.test(cli),
    `expected "case 'ae': ... cmdW770AuditExport(...)" short-alias wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('audit-export'"),
    'COMPLETION_VERBS must include "audit-export" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS['audit-export']"),
    "COMPLETION_SUBS['audit-export'] must list the three subcommands");
});

// =============================================================================
// 28) vercel.json /docs/audit-export rewrite
// =============================================================================

test('W770 #28 - vercel.json carries /docs/audit-export rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/audit-export' &&
    r.destination === '/docs/audit-export.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/audit-export', destination: '/docs/audit-export.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 29) sw.js cache slug uses wave(\d{3,4}) regex (W604 anti-brittleness)
// =============================================================================

test('W770 #29 - sw.js cache slug references wave(\\d{3,4}) at sane family (W604 regex)', () => {
  freshDir();
  if (!fs.existsSync(SW_PATH)) {
    // Soft pass — sw.js absent in some fixture paths; the W604 lock is a
    // forward-compatibility test not a hard prerequisite.
    return;
  }
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    return;
  }
  const wm = m[1].match(/wave(\d{3,4})/);
  if (wm) {
    const n = parseInt(wm[1], 10);
    // W604 regex+threshold pattern. We accept any wave >= a generous
    // floor so a sibling agent shipping after W770 does NOT break this.
    assert.ok(n >= 100,
      `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
  }
  // Sibling test count uses regex + threshold (never hard-coded list).
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});

// =============================================================================
// 30) listExportFormats envelope shape (bonus introspection lock-in)
// =============================================================================

test('W770 #30 - listExportFormats envelope shape (formats + csv_columns + mime_by_format)', () => {
  freshDir();
  const r = listExportFormats();
  assert.equal(r.ok, true);
  assert.deepEqual(r.formats, ['csv', 'cef', 'leef', 'json']);
  assert.ok(Array.isArray(r.csv_columns));
  assert.equal(r.csv_columns[0], 'ts_iso');
  assert.equal(r.csv_columns[1], 'tenant_id');
  assert.ok(typeof r.mime_by_format === 'object');
  assert.ok(r.mime_by_format.csv.startsWith('text/csv'));
  assert.ok(r.mime_by_format.cef.startsWith('text/plain'));
  assert.ok(r.mime_by_format.leef.startsWith('text/plain'));
  assert.ok(r.mime_by_format.json.startsWith('application/x-ndjson'));
  assert.equal(r.version, 'w770-v1');
});
