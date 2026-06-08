// ASR money loop — HTTP + webhook integration (spawned server).
//
// Exercises the REVENUE PATH end-to-end over real HTTP against a server.js
// process, including a signed Stripe webhook — the path that was previously
// only covered at module level:
//
//   signup -> scan (watermarked) -> report/checkout (payment-link URL + binding)
//   -> SIGNED Stripe webhook (checkout.session.completed, asrrep_) -> report
//   fulfilled+unwatermarked -> GET /v1/trust/:slug (html/json, offline-verifies)
//   -> webhook idempotency (replay is a no-op) -> continuous/checkout -> SIGNED
//   webhook (asrsub_) -> subscription active -> tick (cron-secret 403/200).
//
// Runs on the SQLite driver to exercise the production store (expression
// indexes + nested withTransaction via SAVEPOINT in the webhook).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { verifyReport } from '../src/attestation-report-builder.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEBHOOK_SECRET = 'whsec_test_' + 'x'.repeat(24);
const CRON_SECRET = 'cron_test_secret_value_1234567890';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForHealth(base, retries = 100) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}
function stripeSig(rawBody, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}
async function postWebhook(base, obj) {
  const raw = JSON.stringify(obj);
  return fetch(base + '/v1/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(raw, WEBHOOK_SECRET) },
    body: raw,
  });
}

let proc = null, base = null, scratch = null, KEY = null, TENANT = null;

test('setup — spawn server with Stripe webhook + payment links + cron configured', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratch = path.join(os.tmpdir(), `kolm-money-${process.pid}-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      KOLM_DATA_DIR: scratch,
      KOLM_STORE_DRIVER: 'sqlite',
      KOLM_RATE_LIMIT_DISABLED: '1',
      RECIPE_RECEIPT_SECRET: 'test-receipt-secret-test-receipt-secret-32',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PAYMENT_LINK_ASR_REPORT: 'https://buy.stripe.com/test_report',
      STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_STARTER: 'https://buy.stripe.com/test_starter',
      STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_GROWTH: 'https://buy.stripe.com/test_growth',
      KOLM_CRON_SECRET: CRON_SECRET,
      KOLM_REATTEST_DISABLE: '1',
      ANTHROPIC_API_KEY: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { if (/FATAL|Error:/.test(String(d))) process.stderr.write(d); });
  await waitForHealth(base);
});

let AUDIT_ID = null, SLUG = null;

test('signup -> scan returns a watermarked preview', async () => {
  const su = await (await fetch(base + '/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'money@example.com' }) })).json();
  KEY = su.api_key; TENANT = su.tenant.id;
  assert.match(KEY, /^ks_/);
  const scan = await (await fetch(base + '/v1/audit/scan', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ logs: [{ ts: '2026-06-09T00:00:00Z', agent: 'a1', tool: 'db.delete', action: 'call', actor: 'a1', event_id: 'e1', grants: ['*'] }], subject: 'Money loop' }),
  })).json();
  AUDIT_ID = scan.id;
  assert.equal(scan.report.tier, 'scan');
  assert.equal(scan.report.watermark, true);
});

test('report/checkout returns the payment-link URL with the asrrep_ binding', async () => {
  const co = await (await fetch(base + '/v1/audit/report/checkout', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ audit_id: AUDIT_ID }),
  })).json();
  assert.equal(co.ok, true);
  assert.equal(co.source, 'payment_link');
  assert.match(co.url, /buy\.stripe\.com/);
  assert.match(co.url, new RegExp(`client_reference_id=asrrep_${AUDIT_ID}`));
});

test('SIGNED webhook fulfills the $750 report (paid + unwatermarked + slug)', async () => {
  const res = await postWebhook(base, {
    id: 'evt_report_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_report_1', client_reference_id: `asrrep_${AUDIT_ID}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asr, 'report');
  assert.equal(body.fulfilled, true);
  // dashboard data now shows the report paid with a Trust link
  const rep = await (await fetch(base + '/v1/audit/reports', { headers: { authorization: `Bearer ${KEY}` } })).json();
  const row = rep.reports.find((r) => r.id === AUDIT_ID);
  assert.ok(row && row.paid === true && row.public_slug, 'report is paid with a slug');
  SLUG = row.public_slug;
});

test('rejects a webhook with a bad signature', async () => {
  const raw = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
  const res = await fetch(base + '/v1/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: raw });
  assert.equal(res.status, 400);
});

test('GET /v1/trust/:slug serves the unwatermarked report and verifies offline', async () => {
  const html = await (await fetch(`${base}/v1/trust/${SLUG}`)).text();
  assert.doesNotMatch(html, /UNPAID PREVIEW/);
  const env = await (await fetch(`${base}/v1/trust/${SLUG}?format=json`)).json();
  assert.equal(env.tier, 'report');
  assert.equal(env.watermark, false);
  assert.equal(verifyReport(env).ok, true, 'Trust-link JSON verifies offline');
  // unknown slug -> 404
  assert.equal((await fetch(`${base}/v1/trust/deadbeefdeadbeefdeadbeef`)).status, 404);
});

test('webhook replay is idempotent (no error, no double-processing)', async () => {
  const res = await postWebhook(base, {
    id: 'evt_report_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_report_1', client_reference_id: `asrrep_${AUDIT_ID}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.idempotent, true);
});

test('continuous checkout + webhook activates a subscription with a Trust link', async () => {
  const co = await (await fetch(base + '/v1/audit/continuous/checkout', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'starter' }),
  })).json();
  assert.equal(co.ok, true);
  assert.match(co.url, new RegExp(`client_reference_id=asrsub_starter_${TENANT}`));
  const res = await postWebhook(base, {
    id: 'evt_sub_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_sub_1', subscription: 'sub_test_1', customer: 'cus_1', client_reference_id: `asrsub_starter_${TENANT}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asr, 'continuous');
  assert.equal(body.activated, true);
});

test('continuous tick is cron-secret gated (403 without, 200 with header)', async () => {
  assert.equal((await fetch(base + '/v1/audit/continuous/tick', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/v1/audit/continuous/tick', { method: 'POST', headers: { 'x-kolm-cron-secret': 'wrong' } })).status, 403);
  const ok = await fetch(base + '/v1/audit/continuous/tick', { method: 'POST', headers: { 'x-kolm-cron-secret': CRON_SECRET } });
  assert.equal(ok.status, 200);
  // query-param secret must NOT be accepted (header-only)
  assert.equal((await fetch(`${base}/v1/audit/continuous/tick?secret=${CRON_SECRET}`, { method: 'POST' })).status, 403);
});

test('teardown', () => {
  try { proc && proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});
