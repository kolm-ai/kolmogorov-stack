// W695 - direct contract/security test for src/audit-export.js.
//
// Audit exports sit on a proof/compliance boundary: they must be tenant-fenced,
// SIEM-ingestible, secret-safe, and hash-backed without live store state.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUDIT_EXPORT_PROOF_VERSION,
  AUDIT_EXPORT_REDACTION_POLICY,
  AUDIT_EXPORT_VERSION,
  exportAuditEvents,
  listExportFormats,
  previewExport,
  toCef,
  toCsv,
  toLeef,
} from '../src/audit-export.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXED_AT = '2026-06-18T00:00:00.000Z';
const HEX_64 = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function row(overrides = {}) {
  return {
    id: overrides.id || `aud_${Math.random().toString(16).slice(2)}`,
    tenant_id: overrides.tenant_id || 'tenant-a',
    actor: overrides.actor || 'operator-1',
    op: overrides.op || 'compile.completed',
    at: overrides.at || '2026-01-01T00:00:00.000Z',
    request_id: overrides.request_id || 'req-1',
    event_hash: overrides.event_hash || 'a'.repeat(64),
    payload: {
      target_kind: 'artifact',
      target_id: overrides.target_id || 'artifact-1',
      outcome: 'success',
      source_ip: '203.0.113.4',
      user_agent: overrides.user_agent || 'kolm-test/1.0',
      ...(overrides.payload || {}),
    },
    ...overrides.extra,
  };
}

const BASE_ROWS = Object.freeze([
  row({
    id: 'aud-new-secret',
    at: '2026-01-01T02:00:00.000Z',
    actor: 'Bearer sk_testsecret1234567890',
    op: 'auth.key_rotated',
    target_id: 'https://example.test/hook?token=ks_secret1234567890',
    user_agent: 'agent "quoted"',
    request_id: 'req-new',
    event_hash: 'b'.repeat(64),
  }),
  row({
    id: 'aud-other-tenant',
    tenant_id: 'tenant-b',
    actor: 'tenant-b-operator',
    op: 'security.critical',
    at: '2026-01-01T03:00:00.000Z',
    target_id: 'tenant-b-secret',
    request_id: 'req-b',
    event_hash: 'c'.repeat(64),
  }),
  row({
    id: 'aud-old',
    at: '2026-01-01T01:00:00.000Z',
    actor: 'operator-plain',
    op: 'compile.completed',
    request_id: 'req-old',
    event_hash: 'd'.repeat(64),
  }),
]);

function storeWith(rows, onAll = null) {
  return {
    all(table) {
      if (onAll) onAll(table);
      assert.equal(table, 'audit_events');
      return rows.slice();
    },
  };
}

test('W695 audit export source and depth wiring pin proof boundary hardening', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(ROOT, 'src/audit-export.js'), 'utf8');
  const router = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');

  assert.equal(AUDIT_EXPORT_VERSION, 'w770-v1');
  assert.equal(AUDIT_EXPORT_PROOF_VERSION, 'w695-v1');
  assert.equal(AUDIT_EXPORT_REDACTION_POLICY, 'w695-obvious-secret-redaction');
  assert.match(pkg.scripts['verify:audit-export'], /wave695-audit-export-contract\.test\.js/);
  assert.match(pkg.scripts['verify:depth'], /verify:audit-export/);
  assert.match(source, /function _selectAuditRows/);
  assert.match(source, /function _proofFields/);
  assert.match(source, /store_bad_shape/);
  assert.match(source, /A preview must never race itself/);
  assert.match(router, /X-Kolm-Audit-Export-Body-Sha256/);
  assert.match(router, /X-Kolm-Audit-Export-Manifest-Sha256/);
});

test('W695 exportAuditEvents tenant-fences, redacts secrets, and emits deterministic proof hashes', () => {
  const out = exportAuditEvents({
    tenant_id: 'tenant-a',
    format: 'json',
    max_rows: 1,
    opts: { storeMod: storeWith(BASE_ROWS), generated_at: FIXED_AT },
  });

  assert.equal(out.ok, true);
  assert.equal(out.version, AUDIT_EXPORT_VERSION);
  assert.equal(out.proof_version, AUDIT_EXPORT_PROOF_VERSION);
  assert.equal(out.format, 'json');
  assert.equal(out.row_count, 1);
  assert.equal(out.total_in_range, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.generated_at, FIXED_AT);

  const lines = out.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tenant_id, 'tenant-a');
  assert.equal(lines[0].op, 'auth.key_rotated');
  assert.equal(lines[0].operator_id, 'Bearer [redacted_secret]');
  assert.match(lines[0].target_id, /\[redacted_secret\]/);
  assert.doesNotMatch(out.body, /tenant-b|sk_testsecret|ks_secret/);

  assert.equal(out.body_sha256, sha256(out.body));
  assert.match(out.row_set_sha256, HEX_64);
  assert.match(out.manifest_sha256, HEX_64);
  assert.match(out.export_id, /^audexp_[a-f0-9]{24}$/);
  assert.equal(out.proof.manifest.generated_at, FIXED_AT);
  assert.equal(out.proof.manifest.body_sha256, out.body_sha256);
  assert.equal(out.proof.manifest.row_set_sha256, out.row_set_sha256);
  assert.equal(out.proof.manifest.redaction_policy, AUDIT_EXPORT_REDACTION_POLICY);
  assert.ok(out.redaction_count >= 2);
});

test('W695 CSV, CEF, and LEEF encoders preserve ingest escaping after normalization', () => {
  const rows = [
    row({
      actor: 'alpha,beta "quoted"\nline',
      op: 'auth.key_rotated|pipe',
      target_id: 'target=1\nnext',
      user_agent: 'ua^caret',
      event_hash: 'e'.repeat(64),
    }),
  ];

  const csv = toCsv(rows);
  assert.match(csv, /^ts_iso,tenant_id,operator_id,/);
  assert.match(csv, /"alpha,beta ""quoted""\nline"/);
  assert.match(csv, /"target=1\nnext"/);

  const cef = toCef(rows);
  assert.match(cef, /^CEF:0\|kolm\.ai\|kolm\|w770-v1\|auth\.key_rotated\\\|pipe\|/);
  assert.match(cef, /cs3=target\\=1\\nnext cs3Label=target_id/);

  const leef = toLeef(rows);
  assert.match(leef, /^LEEF:2\.0\|kolm\.ai\|kolm\|w770-v1\|auth\.key_rotated\\\|pipe\|\^\|/);
  assert.match(leef, /target_id=target=1\\nnext/);
  assert.match(leef, /userAgent=ua\\\^caret/);
});

test('W695 previewExport reads one snapshot and proof-binds the preview body', () => {
  let reads = 0;
  const manyRows = [
    ...BASE_ROWS,
    ...Array.from({ length: 12 }, (_, i) => row({
      id: `aud-extra-${i}`,
      at: `2026-01-01T00:${String(i + 10).padStart(2, '0')}:00.000Z`,
      request_id: `req-extra-${i}`,
      event_hash: `${i}`.repeat(64).slice(0, 64),
    })),
  ];

  const out = previewExport({
    tenant_id: 'tenant-a',
    format: 'csv',
    opts: {
      storeMod: storeWith(manyRows, () => { reads += 1; }),
      generated_at: FIXED_AT,
    },
  });

  assert.equal(reads, 1);
  assert.equal(out.ok, true);
  assert.equal(out.preview_row_count, 10);
  assert.equal(out.total_would_export, 14);
  assert.equal(out.preview_cap, 10);
  assert.equal(out.body_sha256, sha256(out.body));
  assert.equal(out.proof.manifest.kind, 'audit_export_preview');
  assert.equal(out.proof.manifest.preview_cap, 10);
  assert.equal(out.proof.manifest.truncated, true);
});

test('W695 audit export returns honest envelopes for bad store shape and invalid times', () => {
  const badShape = exportAuditEvents({
    tenant_id: 'tenant-a',
    format: 'json',
    opts: { storeMod: { all: () => ({ rows: [] }) }, generated_at: FIXED_AT },
  });
  assert.equal(badShape.ok, false);
  assert.equal(badShape.error, 'store_bad_shape');
  assert.equal(badShape.proof_version, AUDIT_EXPORT_PROOF_VERSION);

  const readFailed = exportAuditEvents({
    tenant_id: 'tenant-a',
    format: 'json',
    opts: {
      storeMod: { all: () => { throw new Error('boom sk_testsecret1234567890'); } },
      generated_at: FIXED_AT,
    },
  });
  assert.equal(readFailed.ok, false);
  assert.equal(readFailed.error, 'store_read_failed');
  assert.doesNotMatch(readFailed.detail, /sk_testsecret/);
  assert.match(readFailed.detail, /\[redacted_secret\]/);

  const invalidTime = exportAuditEvents({
    tenant_id: 'tenant-a',
    format: 'json',
    from: 'not-a-date',
    opts: { storeMod: storeWith([]), generated_at: FIXED_AT },
  });
  assert.equal(invalidTime.ok, true);
  assert.deepEqual(invalidTime.warnings, ['from_ignored_invalid_time']);
  assert.equal(invalidTime.body_sha256, sha256(''));
});

test('W695 listExportFormats exposes proof and redaction metadata', () => {
  const out = listExportFormats();
  assert.equal(out.ok, true);
  assert.deepEqual(out.formats, Object.freeze(['csv', 'cef', 'leef', 'json']));
  assert.equal(out.proof_version, AUDIT_EXPORT_PROOF_VERSION);
  assert.equal(out.redaction_policy, AUDIT_EXPORT_REDACTION_POLICY);
});
