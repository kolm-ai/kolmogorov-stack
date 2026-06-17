import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  FORGET_VERSION,
  markCaptureForgotten,
  isCaptureForgotten,
  filterForgottenCaptures,
  listForgottenCaptures,
} from '../src/capture-forget.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function memoryStore(seed = []) {
  const rows = seed.slice();
  return {
    rows,
    async listEvents(query) {
      assert.equal(query.provider, 'kolm_capture_forget');
      return rows;
    },
    async appendEvent(ev) {
      rows.push(ev);
      return { event_id: ev.event_id };
    },
  };
}

test('W683 capture-forget source pins hashed tombstone certificate controls', () => {
  const source = read('src/capture-forget.js');
  const cliSource = read('src/wrapper-cli.js');
  assert.match(source, /FORGET_VERSION = 'w764-v1'/);
  assert.match(FORGET_VERSION, /^w764-/);
  assert.equal(FORGET_VERSION, 'w764-v1');
  assert.match(source, /REQUEST_HASH_PREFIX = 'forget:v2:'/);
  assert.match(source, /_buildDeletionCertificate/);
  assert.match(source, /certificate_hash/);
  assert.match(source, /tombstone_hash/);
  assert.match(source, /future_training_blocked: true/);
  assert.match(source, /derived_artifacts_status: 'redistill_required'/);
  assert.match(source, /event_store_read_failed/);
  assert.match(source, /event_store_write_failed/);
  assert.match(source, /failed_closed: true/);
  assert.match(source, /_sanitizePrintable/);
  assert.doesNotMatch(source, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  assert.match(cliSource, /id \? \{ capture_id: id, reason, confirm: true \}/);

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['verify:capture-forget'], 'node --test --test-concurrency=1 tests/wave683-capture-forget-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:airgap-routes && npm run verify:capture-forget && npm run verify:finetune-frameworks/);
});

test('W683 markCaptureForgotten writes tenant-fenced hashed deletion certificate', async () => {
  const store = memoryStore();
  const result = await markCaptureForgotten({
    tenant_id: ' tenant-a ',
    capture_id: ' cap-123 ',
    namespace: ' voice ',
    reason: 'gdpr\nrequest',
    requested_by: 'dpo\r@example.invalid',
    storeMod: store,
  });

  assert.equal(result.ok, true);
  assert.equal(result.capture_id, 'cap-123');
  assert.equal(result.requires_redistill, true);
  assert.equal(result.idempotent_hit, false);
  assert.match(result.audit_event_id, /^forget_[a-f0-9]{24}$/);
  assert.match(result.tombstone_hash, /^[a-f0-9]{64}$/);
  assert.equal(result.deletion_certificate.future_training_blocked, true);
  assert.equal(result.deletion_certificate.original_capture_retained_for_forensics, true);
  assert.equal(result.deletion_certificate.derived_artifacts_status, 'redistill_required');
  assert.equal(result.deletion_certificate.certificate_hash, store.rows[0].response_hash);

  const row = store.rows[0];
  assert.equal(row.tenant_id, 'tenant-a');
  assert.equal(row.namespace, 'voice');
  assert.equal(row.provider, 'kolm_capture_forget');
  assert.equal(row.model, 'capture-forget-marker');
  assert.match(row.request_hash, /^forget:v2:[a-f0-9]{64}$/);
  assert.doesNotMatch(row.request_hash, /cap-123/);

  const meta = JSON.parse(row.prompt_redacted);
  assert.equal(meta.capture_id, 'cap-123');
  assert.match(meta.capture_id_hash, /^[a-f0-9]{64}$/);
  assert.equal(meta.reason, 'gdpr request');
  assert.equal(meta.requested_by, 'dpo @example.invalid');
  assert.equal(meta.tombstone_hash, result.tombstone_hash);
});

test('W683 capture forget is idempotent without a second audit write', async () => {
  const store = memoryStore();
  const first = await markCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-abc',
    reason: 'user_request',
    storeMod: store,
  });
  const second = await markCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-abc',
    reason: 'different reason ignored',
    storeMod: store,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent_hit, true);
  assert.equal(second.audit_event_id, first.audit_event_id);
  assert.equal(second.tombstone_hash, first.tombstone_hash);
  assert.equal(store.rows.length, 1);
});

test('W683 forgotten status and list expose certificate fields without cross-tenant leakage', async () => {
  const crossTenant = {
    event_id: 'forget_cross',
    tenant_id: 'tenant-b',
    namespace: 'voice',
    provider: 'kolm_capture_forget',
    request_hash: 'forget:cap-abc',
    response_hash: null,
    created_at: '2026-06-18T00:00:00.000Z',
    prompt_redacted: JSON.stringify({ kind: 'forget_marker', capture_id: 'cap-abc', reason: 'other' }),
  };
  const store = memoryStore([crossTenant]);
  await markCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-abc',
    namespace: 'voice',
    reason: 'license_revoked',
    requested_by: 'ops@example.invalid',
    storeMod: store,
  });

  const status = await isCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-abc',
    storeMod: store,
  });
  assert.equal(status.ok, true);
  assert.equal(status.forgotten, true);
  assert.equal(status.reason, 'license_revoked');
  assert.match(status.tombstone_hash, /^[a-f0-9]{64}$/);
  assert.equal(status.deletion_certificate.capture_id_hash.length, 64);

  const listed = await listForgottenCaptures({
    tenant_id: 'tenant-a',
    namespace: 'voice',
    storeMod: store,
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.n, 1);
  assert.deepEqual(listed.markers.map((m) => m.audit_event_id), [status.audit_event_id]);
  assert.equal(listed.markers[0].capture_id, 'cap-abc');
  assert.match(listed.markers[0].capture_id_hash, /^[a-f0-9]{64}$/);
});

test('W683 filterForgottenCaptures removes marked rows and fails closed on unreadable marker store', async () => {
  const store = memoryStore();
  await markCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-remove',
    storeMod: store,
  });

  const filtered = await filterForgottenCaptures({
    tenant_id: 'tenant-a',
    captures: [{ event_id: 'cap-keep' }, { event_id: 'cap-remove' }],
    storeMod: store,
  });
  assert.equal(filtered.ok, true);
  assert.deepEqual(filtered.filtered.map((r) => r.event_id), ['cap-keep']);
  assert.deepEqual(filtered.removed_ids, ['cap-remove']);

  const unreadable = await filterForgottenCaptures({
    tenant_id: 'tenant-a',
    captures: [{ event_id: 'cap-keep' }],
    storeMod: {
      async listEvents() {
        throw new Error('store offline');
      },
    },
  });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.error, 'event_store_read_failed');
  assert.equal(unreadable.failed_closed, true);
  assert.deepEqual(unreadable.filtered, []);
});

test('W683 invalid scopes and unavailable audit writes fail before persistence', async () => {
  let appended = 0;
  const store = {
    async listEvents() {
      return [];
    },
    async appendEvent() {
      appended += 1;
      throw new Error('disk full');
    },
  };

  const badTenant = await markCaptureForgotten({
    tenant_id: 'tenant\nbad',
    capture_id: 'cap-1',
    storeMod: store,
  });
  assert.equal(badTenant.ok, false);
  assert.equal(badTenant.error, 'invalid_tenant_id');
  assert.equal(appended, 0);

  const badNamespace = await markCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-1',
    namespace: 'bad\nnamespace',
    storeMod: store,
  });
  assert.equal(badNamespace.ok, false);
  assert.equal(badNamespace.error, 'invalid_namespace');
  assert.equal(appended, 0);

  const writeFailure = await markCaptureForgotten({
    tenant_id: 'tenant-a',
    capture_id: 'cap-1',
    storeMod: store,
  });
  assert.equal(writeFailure.ok, false);
  assert.equal(writeFailure.error, 'event_store_write_failed');
  assert.equal(appended, 1);
});
