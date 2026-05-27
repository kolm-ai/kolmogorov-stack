// W910 Track C3 - webhook notification dispatch contract.
//
// Verifies:
//   - settings round-trip through getWebhookSettings / setWebhookSettings
//   - assertSafeWebhookUrl rejects http://, IPs, localhost, non-Slack hosts
//   - postWithRetry retries on 503 with backoff, stops on 4xx
//   - notify() builds the Slack block layout for each event type
//   - notify() respects per-event toggles (no dispatch when off)
//   - delivery log records each attempt

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  NOTIFICATION_EVENT_TYPES,
  getWebhookSettings,
  setWebhookSettings,
  notify,
  listDeliveries,
  _internals,
} from '../src/notifications.js';

function withServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// =====================================================================
// 1) Settings round-trip
// =====================================================================
test('W910 C3: settings round-trip writes and reads back per tenant', () => {
  const tenant = 't_w910_c3_settings_' + Date.now();
  const initial = getWebhookSettings(tenant);
  assert.equal(initial.slack_webhook_url, null);
  for (const e of NOTIFICATION_EVENT_TYPES) assert.equal(initial.events[e], true);

  const saved = setWebhookSettings(tenant, {
    email_to: 'alerts@example.com',
    events: { artifact_compiled: false, quota_warning: false },
  });
  assert.equal(saved.email_to, 'alerts@example.com');
  assert.equal(saved.events.artifact_compiled, false);
  assert.equal(saved.events.quota_warning, false);
  assert.equal(saved.events.drift_detected, true, 'untouched events stay on');

  const reread = getWebhookSettings(tenant);
  assert.equal(reread.email_to, 'alerts@example.com');
  assert.equal(reread.events.artifact_compiled, false);
});

// =====================================================================
// 2) URL safety
// =====================================================================
test('W910 C3: assertSafeWebhookUrl rejects http://, IPs, localhost', () => {
  const f = _internals.assertSafeWebhookUrl;
  assert.throws(() => f('http://example.com/hook'), /https/i);
  assert.throws(() => f('https://127.0.0.1/hook'), /public/i);
  assert.throws(() => f('https://localhost/hook'), /public/i);
  assert.throws(() => f('https://10.0.0.1/hook'), /public/i);
  assert.equal(f('https://example.com/hook'), 'https://example.com/hook');
});

test('W910 C3: slack webhook URL enforces hooks.slack.com host', () => {
  const f = _internals.assertSafeWebhookUrl;
  assert.throws(() => f('https://example.com/hook', { allowSlack: true }), /slack/i);
  assert.equal(
    f('https://hooks.slack.com/services/T1/B1/abc', { allowSlack: true }),
    'https://hooks.slack.com/services/T1/B1/abc',
  );
});

// =====================================================================
// 3) Retry/backoff on 503; stop on 4xx
// =====================================================================
test('W910 C3: postWithRetry retries on 503 (3 attempts) and finally fails', async () => {
  let calls = 0;
  const { server, url } = await withServer((req, res) => {
    calls++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"busy"}');
  });
  try {
    const r = await _internals.postWithRetry(url, { ping: 1 });
    assert.equal(r.ok, false);
    assert.equal(calls, 3, `expected 3 attempts on 503, got ${calls}`);
    assert.equal(r.attempts.length, 3);
  } finally {
    server.close();
  }
});

test('W910 C3: postWithRetry stops immediately on 4xx (terminal)', async () => {
  let calls = 0;
  const { server, url } = await withServer((req, res) => {
    calls++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"bad"}');
  });
  try {
    const r = await _internals.postWithRetry(url, { ping: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.terminal, true);
    assert.equal(calls, 1, `expected 1 attempt on 4xx, got ${calls}`);
  } finally {
    server.close();
  }
});

test('W910 C3: postWithRetry succeeds on 200 first try', async () => {
  let calls = 0;
  const { server, url } = await withServer((req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    const r = await _internals.postWithRetry(url, { ping: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

// =====================================================================
// 4) Slack block builder per event type
// =====================================================================
test('W910 C3: buildSlackBlocks emits header + section + context for every event type', () => {
  for (const e of NOTIFICATION_EVENT_TYPES) {
    const blocks = _internals.buildSlackBlocks(e, { artifact_id: 'art-1', kscore: 0.9 });
    assert.ok(Array.isArray(blocks.blocks), `${e}: blocks should be array`);
    assert.equal(blocks.blocks[0].type, 'header');
    const header = blocks.blocks[0].text.text;
    assert.ok(header.startsWith('kolm:'), `${e}: header text should start with kolm:`);
    const last = blocks.blocks[blocks.blocks.length - 1];
    assert.equal(last.type, 'context');
    assert.ok(blocks.text && blocks.text.includes('kolm:'));
  }
});

// =====================================================================
// 5) notify() respects event toggle, dispatches to HTTP webhook
// =====================================================================
test('W910 C3: notify() returns event_disabled when toggle is off', async () => {
  const tenant = 't_w910_c3_off_' + Date.now();
  setWebhookSettings(tenant, { http_webhook_url: 'https://example.com/hook', events: { artifact_compiled: false } });
  const out = await notify(tenant, 'artifact_compiled', { artifact_id: 'a' });
  assert.equal(out.reason, 'event_disabled');
});

test('W910 C3: notify() dispatches to a live HTTP webhook server and logs a delivery', async () => {
  const tenant = 't_w910_c3_http_' + Date.now();
  let received = null;
  const { server, url } = await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { received = JSON.parse(body); } catch { received = body; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  try {
    // Bypass safe-url assertion by writing the row directly via setWebhookSettings
    // requires https; for the test we patch the table.
    const settings = setWebhookSettings(tenant, { events: { drift_detected: true } });
    // Manually inject the test URL into the stored settings.
    const { update, findOne } = await import('../src/store.js');
    update('webhook_notification_settings', (r) => r.tenant === tenant, { ...settings, http_webhook_url: url });
    const stored = findOne('webhook_notification_settings', (r) => r.tenant === tenant);
    assert.equal(stored.http_webhook_url, url);

    const out = await notify(tenant, 'drift_detected', { namespace: 'support', delta: 0.05 });
    assert.equal(out.ok, true);
    assert.equal(out.results.http.ok, true);
    assert.equal(out.results.http.status, 200);
    assert.ok(received);
    assert.equal(received.event, 'drift_detected');
    assert.equal(received.payload.namespace, 'support');
    assert.equal(received.tenant, tenant);

    const log = listDeliveries(tenant, { limit: 10 });
    const httpRow = log.find((r) => r.channel === 'http');
    assert.ok(httpRow);
    assert.equal(httpRow.ok, true);
    assert.equal(httpRow.event_type, 'drift_detected');
  } finally {
    server.close();
  }
});

// =====================================================================
// 6) NOTIFICATION_EVENT_TYPES is the documented 7-element list
// =====================================================================
test('W910 C3: NOTIFICATION_EVENT_TYPES is the documented 7-item set', () => {
  assert.deepEqual([...NOTIFICATION_EVENT_TYPES].sort(), [
    'artifact_compiled',
    'compile_failed',
    'device_offline',
    'drift_detected',
    'kscore_drop',
    'quota_warning',
    'recompile_suggested',
  ]);
});
