// W699 - direct contract for src/drift-alert-w813.js.
//
// Focus: bounded tenant/namespace inputs, unified drift_detected notification
// dispatch, digest-backed persistence, and tenant-fenced sanitized reads.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DRIFT_ALERT_CONTRACT_VERSION,
  DRIFT_ALERT_PROVIDER,
  DRIFT_ALERT_VERSION,
  DRIFT_EVENT_TYPE,
  MAX_RECENT_ALERT_LIMIT,
  emitDriftAlert,
  listRecentAlerts,
} from '../src/drift-alert-w813.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function driftResult(patch = {}) {
  return {
    ok: true,
    drift_detected: true,
    severity: 'moderate',
    kl_divergence: 0.42,
    kl_threshold: 0.1,
    fallback_rate_delta: 0.24,
    suggested_action_text: 'refund traffic shifted\nre-distill now',
    ...patch,
  };
}

test('W699 source pins W813 alert wrapper controls and package wiring', () => {
  const source = read('src/drift-alert-w813.js');
  const pkg = readJson('package.json');

  assert.equal(DRIFT_ALERT_VERSION, 'w813-v1');
  assert.equal(DRIFT_ALERT_CONTRACT_VERSION, 'w699-v1');
  assert.equal(DRIFT_EVENT_TYPE, 'drift_detected');
  assert.equal(DRIFT_ALERT_PROVIDER, 'kolm_drift_alert');
  assert.match(source, /notifMod\.notify/);
  assert.match(source, /DRIFT_EVENT_TYPE/);
  assert.match(source, /payload_sha256/);
  assert.match(source, /MAX_RECENT_ALERT_LIMIT/);
  assert.match(source, /_sanitizeStoredPayload/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);

  assert.equal(
    pkg.scripts['verify:drift-alert-w813'],
    'node --test --test-concurrency=1 tests/wave699-drift-alert-w813-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /npm run verify:drift-alert && npm run verify:drift-alert-w813 && npm run verify:failure-modes-w745 && npm run verify:openai-finetune-importer && node --test/);
});

test('W699 emitDriftAlert dispatches drift_detected through unified notifications and persists digest-backed payload', async () => {
  const events = [];
  let notified = null;
  const notificationsModule = {
    notify: async (tenant, eventType, payload) => {
      notified = { tenant, eventType, payload };
      return { ok: true, sent: 1, succeeded: 1 };
    },
  };
  const eventStore = {
    appendEvent: async (row) => {
      events.push(row);
      return { event_id: 'event-1', created_at: '2026-06-18T00:00:01.000Z' };
    },
  };

  const out = await emitDriftAlert({
    tenant_id: ' tenant-a ',
    namespace: ' support ',
    drift_result: driftResult(),
    opts: {
      eventStore,
      notificationsModule,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      now_iso: '2026-06-18T00:00:00.000Z',
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.tenant_id, 'tenant-a');
  assert.equal(out.namespace, 'support');
  assert.equal(out.alert_id, 'da_11111111-1111-4111-8111-111111111111');
  assert.equal(out.notification_attempted, true);
  assert.equal(out.notification_sent, true);
  assert.equal(out.notification_error, null);
  assert.equal(out.persisted, true);
  assert.match(out.payload_sha256, HEX64_RE);
  assert.match(out.payload.payload_sha256, HEX64_RE);
  assert.equal(out.payload.suggested_action_text.includes('\n'), false);

  assert.deepEqual(notified.tenant, 'tenant-a');
  assert.equal(notified.eventType, 'drift_detected');
  assert.equal(notified.payload.tenant_id, undefined);
  assert.equal(notified.payload.namespace, 'support');
  assert.match(notified.payload.payload_sha256, HEX64_RE);

  assert.equal(events.length, 1);
  assert.equal(events[0].tenant_id, 'tenant-a');
  assert.equal(events[0].namespace, 'support');
  assert.equal(events[0].provider, 'kolm_drift_alert');
  assert.equal(events[0].status, 'drift');
  const persistedPayload = JSON.parse(events[0].feedback);
  assert.equal(persistedPayload.tenant_id, 'tenant-a');
  assert.equal(persistedPayload.namespace, 'support');
  assert.match(persistedPayload.payload_sha256, HEX64_RE);
});

test('W699 emitDriftAlert rejects unsafe IDs and fails closed on missing notification channels', async () => {
  const badTenant = await emitDriftAlert({
    tenant_id: 'tenant\nbad',
    drift_result: driftResult(),
    opts: { notificationsModule: { notify: async () => ({ ok: true }) } },
  });
  assert.equal(badTenant.ok, false);
  assert.equal(badTenant.error, 'tenant_id_invalid');

  const badNamespace = await emitDriftAlert({
    tenant_id: 'tenant-a',
    namespace: 'x'.repeat(300),
    drift_result: driftResult(),
    opts: { notificationsModule: { notify: async () => ({ ok: true }) } },
  });
  assert.equal(badNamespace.ok, false);
  assert.equal(badNamespace.error, 'namespace_too_large');

  const noChannels = await emitDriftAlert({
    tenant_id: 'tenant-a',
    drift_result: driftResult(),
    opts: {
      eventStore: { appendEvent: async () => ({ event_id: 'event-2' }) },
      notificationsModule: { notify: async () => ({ ok: true, sent: 0, succeeded: 0 }) },
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
      now_iso: '2026-06-18T00:00:00.000Z',
    },
  });
  assert.equal(noChannels.ok, true);
  assert.equal(noChannels.notification_attempted, true);
  assert.equal(noChannels.notification_sent, false);
  assert.equal(noChannels.notification_error, 'notification_channels_not_configured');
});

test('W699 listRecentAlerts tenant-fences rows and sanitizes persisted payloads', async () => {
  const rows = [
    {
      event_id: 'event-good',
      tenant_id: 'tenant-a',
      namespace: 'support',
      status: 'drift',
      created_at: '2026-06-18T00:00:02.000Z',
      feedback: JSON.stringify({
        alert_id: 'alert\nbad',
        event_type: 'drift_detected',
        tenant_id: 'victim-tenant',
        namespace: 'other',
        drift_detected: true,
        severity: 'SEVERE',
        kl_divergence: Infinity,
        kl_threshold: 0.1,
        fallback_rate_delta: 0.3,
        suggested_action_text: 'line one\nline two',
        created_at: '2026-06-18T00:00:01.000Z',
      }),
    },
    {
      event_id: 'event-cross-tenant',
      tenant_id: 'tenant-b',
      namespace: 'support',
      status: 'drift',
      created_at: '2026-06-18T00:00:03.000Z',
      feedback: JSON.stringify({ tenant_id: 'tenant-b', secret: 'must-not-leak' }),
    },
  ];
  const eventStore = {
    listEvents: async () => rows,
  };

  const out = await listRecentAlerts({
    tenant_id: ' tenant-a ',
    namespace: ' support ',
    limit: 9999,
    opts: { eventStore },
  });

  assert.equal(out.ok, true);
  assert.equal(out.limit, MAX_RECENT_ALERT_LIMIT);
  assert.equal(out.count, 1);
  assert.equal(out.alerts[0].tenant_id, 'tenant-a');
  assert.equal(out.alerts[0].namespace, 'support');
  assert.equal(out.alerts[0].payload.tenant_id, 'tenant-a');
  assert.equal(out.alerts[0].payload.namespace, 'support');
  assert.equal(out.alerts[0].payload.severity, 'severe');
  assert.equal(out.alerts[0].payload.kl_divergence, null);
  assert.equal(out.alerts[0].payload.suggested_action_text.includes('\n'), false);
  assert.match(out.alerts[0].payload.payload_sha256, HEX64_RE);
  assert.equal(JSON.stringify(out).includes('victim-tenant'), false);
  assert.equal(JSON.stringify(out).includes('must-not-leak'), false);
});
