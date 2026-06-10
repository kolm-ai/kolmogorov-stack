// Agent Security-Review - 'audit_report_ready' fires on ONE-OFF authed runs.
//
// Before this contract, the event only fired from the Continuous re-attestation
// path (src/asr-fulfillment.js). Now an authed POST /v1/audit/scan (and the
// import / session-run siblings, which share the same _notifyReportReady
// helper) that completes successfully WITH a signed report fires one
// fire-and-forget notify(tenant, 'audit_report_ready', ...) carrying the
// session id, report_id, subject, readiness_pct and evidence tier grade.
//
// Locked properties:
//   1. one delivery row of event 'audit_report_ready' lands after a successful
//      authed scan (asserted against a live local webhook receiver, the same
//      pattern as tests/wave910-notifications.test.js, plus the persisted
//      notification_deliveries store);
//   2. the notify is NON-BLOCKING: a tenant whose webhook is unreachable still
//      gets a 200 scan response (the failure is swallowed in the background);
//   3. an unauthenticated scan attempt fires NOTHING (the route 401s before the
//      handler runs, so no anonymous run can ever announce a report).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

async function waitFor(cond, ms = 10000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

const KEY_OK = 'ks_nrr_ok_' + 'c'.repeat(40);
const KEY_DEAD = 'ks_nrr_dead_' + 'd'.repeat(40);
const TENANT_OK = 't_nrr_ok';
const TENANT_DEAD = 't_nrr_dead';

let serverProc = null;
let base = null;
let scratchDir = null;
let dataDir = null;
let receiver = null;
const received = []; // every JSON body the local webhook receiver got

test('setup - local webhook receiver + server with seeded tenants and webhook settings', async () => {
  // 1. The local receiver the tenant's http webhook points at (the
  //    wave910-notifications pattern: notify() POSTs the event envelope here).
  await new Promise((resolve) => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { received.push(JSON.parse(body)); } catch { received.push(body); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    receiver.listen(0, '127.0.0.1', resolve);
  });
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  // 2. Seed the spawned server's JSON store.
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-nrr-${process.pid}-${Date.now()}`);
  dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: TENANT_OK, name: 'nrr-ok', email: 'ok@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
    { id: TENANT_DEAD, name: 'nrr-dead', email: 'dead@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const h = (k) => crypto.createHash('sha256').update(k).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_nrr_ok', tenant_id: TENANT_OK, hash: h(KEY_OK), label: 'ok', kind: 'user', created_at: now, revoked_at: null },
    { id: 'apik_nrr_dead', tenant_id: TENANT_DEAD, hash: h(KEY_DEAD), label: 'dead', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  // Webhook settings the way src/notifications.js persists them (the table is
  // 'webhook_notification_settings'; seeding the file directly lets a test use
  // a local http:// receiver, which setWebhookSettings would refuse).
  const events = {
    artifact_compiled: true, drift_detected: true, kscore_drop: true,
    device_offline: true, compile_failed: true, quota_warning: true,
    recompile_suggested: true, audit_report_ready: true, reattestation_drift: true,
  };
  fs.writeFileSync(path.join(dataDir, 'webhook_notification_settings.json'), JSON.stringify([
    { tenant: TENANT_OK, slack_webhook_url: null, http_webhook_url: hookUrl, email_to: null, events, updated_at: now },
    // An unreachable endpoint: every attempt fails, which must stay invisible
    // to the scan caller (fire-and-forget).
    { tenant: TENANT_DEAD, slack_webhook_url: null, http_webhook_url: 'http://127.0.0.1:9/unreachable', email_to: null, events, updated_at: now },
  ]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1', DEFAULT_TENANT: 'nrr-ok',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

test('a successful authed scan fires exactly one audit_report_ready delivery', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const t0 = Date.now();
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY_OK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs, subject: 'Notify Co', source: 'litellm' }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true, 'the scan produced a signed report');
  assert.ok(j.report_id, 'report id returned');

  // The webhook lands shortly after (fire-and-forget, so AFTER the response).
  const got = await waitFor(() => received.some((b) => b && b.event === 'audit_report_ready'));
  assert.ok(got, 'the local webhook receiver got the audit_report_ready event');
  const hit = received.find((b) => b && b.event === 'audit_report_ready');
  assert.equal(hit.tenant, TENANT_OK, 'fired for the authed tenant');
  assert.ok(hit.payload && typeof hit.payload === 'object', 'payload present');
  assert.equal(hit.payload.id, j.id, 'payload carries the session id');
  assert.equal(hit.payload.report_id, j.report_id, 'payload carries the report id');
  assert.equal(hit.payload.subject, 'Notify Co', 'payload carries the subject');
  assert.equal(hit.payload.readiness_pct, j.summary.readiness_pct, 'payload carries the readiness pct');
  assert.match(String(hit.payload.evidence_tier_grade || ''), /^[ABC]$/, 'payload carries the evidence tier grade');

  // Exactly ONE delivery row of this event is persisted in the store.
  const ok2 = await waitFor(() => {
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'notification_deliveries.json'), 'utf8'));
      return rows.filter((x) => x && x.event_type === 'audit_report_ready' && x.tenant === TENANT_OK).length === 1;
    } catch { return false; }
  });
  assert.ok(ok2, 'one persisted delivery row of event audit_report_ready');
  const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'notification_deliveries.json'), 'utf8'));
  const mine = rows.filter((x) => x && x.event_type === 'audit_report_ready' && x.tenant === TENANT_OK);
  assert.equal(mine.length, 1, 'exactly one delivery row (one scan -> one event)');
  assert.equal(mine[0].channel, 'http');
  assert.equal(mine[0].ok, true);

  // Sanity on the response path: a webhook round-trip is not in it. The scan
  // itself can be slow on CI, so only assert it did not absorb the retry
  // ladder's full backoff on top (a loose bound; the real lock is the dead-
  // webhook test below).
  assert.ok(elapsed < 60000, `scan responded in ${elapsed}ms`);
});

test('a notify failure can never fail the scan (unreachable webhook, still 200)', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY_DEAD}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs, subject: 'Dead Hook Co', source: 'litellm' }),
  });
  assert.equal(r.status, 200, 'the scan succeeds even though every webhook attempt will fail');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true);
});

test('an unauthenticated scan fires nothing', async () => {
  const before = received.length;
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs, subject: 'Anon Co', source: 'litellm' }),
  });
  assert.equal(r.status, 401, 'no key -> the route rejects before the handler runs');
  // Give a would-be stray notify ample time to land, then assert silence.
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(received.length, before, 'no webhook event for an unauthenticated attempt');
});

test('teardown', async () => {
  if (serverProc) await killAndWait(serverProc);
  if (receiver) await new Promise((res) => receiver.close(res));
  if (scratchDir) rmSyncBestEffort(scratchDir);
});
