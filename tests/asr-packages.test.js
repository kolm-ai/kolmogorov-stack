// ASR enterprise packages + Continuous onramp - HTTP + webhook integration.
//
// Covers the self-serve money path added for the $15,000 Full Readiness package,
// the $3,500/mo Continuous-Plus subscription, and the Continuous onramp import
// endpoint, end-to-end over real HTTP against a spawned server.js (SQLite store,
// signed Stripe webhooks):
//
//   * POST /v1/audit/package/checkout -> 503 when the product is not wired
//     (env-gated degrade) and a payment-link URL (with the right binding) when it
//     is.
//   * SIGNED webhook (asrpkg_<tenant>) grants a durable asr_packages entitlement,
//     and is idempotent (a distinct event with the same binding never double-
//     grants; a replay of the same event id is a no-op).
//   * 'plus' flows through the existing subscription path and activates.
//   * POST /v1/audit/import ingests inline logs through the SAME scan -> sign path
//     and returns a signed, offline-verifiable report.
//
// Sibling to tests/asr-money-loop-http.test.js; must not break it.

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
const CRON_SECRET = 'cron_test_secret_value_pkg_0987654321';

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
function spawnServer(extraEnv) {
  return (async () => {
    const PORT = await freePort();
    const base = `http://127.0.0.1:${PORT}`;
    const scratch = path.join(os.tmpdir(), `kolm-pkg-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(scratch, { recursive: true });
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        KOLM_DATA_DIR: scratch,
        KOLM_STORE_DRIVER: 'sqlite',
        KOLM_RATE_LIMIT_DISABLED: '1',
        RECIPE_RECEIPT_SECRET: 'test-receipt-secret-test-receipt-secret-32',
        KOLM_REATTEST_DISABLE: '1',
        ANTHROPIC_API_KEY: '',
        NODE_ENV: 'test',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => { if (/FATAL|Error:/.test(String(d))) process.stderr.write(d); });
    await waitForHealth(base);
    return { proc, base, scratch };
  })();
}
async function signup(base, email) {
  const su = await (await fetch(base + '/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json();
  return { key: su.api_key, tenant: su.tenant.id };
}
// Read the asr_packages entitlement rows for a tenant straight from the server's
// SQLite store - the only way to prove the durable grant (there is no HTTP read
// surface for entitlements) and the strongest idempotency assertion.
async function activePackages(scratch, tenant) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(scratch, 'kolm.sqlite'));
  try {
    const rows = db.prepare("SELECT json FROM kolm_store_rows WHERE table_name = 'asr_packages'").all();
    return rows
      .map((r) => { try { return JSON.parse(r.json); } catch { return null; } })
      .filter((p) => p && p.tenant_id === tenant && p.status === 'active');
  } finally { try { db.close(); } catch {} }
}

// --------------------------------------------------------------------------
// 1. Env-gated 503 degrade: no package payment-link configured -> checkout 503.
// --------------------------------------------------------------------------
test('package/checkout degrades to 503 with the exact env names when unconfigured', async () => {
  const s = await spawnServer({ /* deliberately NO ASR payment-link / price envs, NO webhook secret */ });
  try {
    const { key } = await signup(s.base, 'pkg-unconfigured@example.com');
    const res = await fetch(s.base + '/v1/audit/package/checkout', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'full' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(Array.isArray(body.missing), 'lists the missing env vars');
    assert.ok(body.missing.some((m) => /STRIPE_PAYMENT_LINK_ASR_FULL_READINESS/.test(m)), 'names the Full Readiness payment-link env');
    // An invalid product is a clean 400, not a 503.
    const bad = await fetch(s.base + '/v1/audit/package/checkout', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'nope' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    try { s.proc.kill('SIGKILL'); } catch {}
    try { fs.rmSync(s.scratch, { recursive: true, force: true }); } catch {}
  }
});

// --------------------------------------------------------------------------
// 2-5. Configured server: checkout URLs, package fulfillment + idempotency,
//      plus activation, and the import onramp.
// --------------------------------------------------------------------------
let SRV = null;

test('setup - spawn a server with the package + plus payment links configured', async () => {
  SRV = await spawnServer({
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PAYMENT_LINK_ASR_FULL_READINESS: 'https://buy.stripe.com/test_full',
    STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_PLUS: 'https://buy.stripe.com/test_plus',
    KOLM_CRON_SECRET: CRON_SECRET,
  });
});

let KEY = null, TENANT = null;

test('package/checkout returns the payment-link URL with the asrpkg_ binding (full)', async () => {
  const su = await signup(SRV.base, 'pkg@example.com');
  KEY = su.key; TENANT = su.tenant;
  assert.match(KEY, /^ks_/);
  const co = await (await fetch(SRV.base + '/v1/audit/package/checkout', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ product: 'full' }),
  })).json();
  assert.equal(co.ok, true);
  assert.equal(co.source, 'payment_link');
  assert.match(co.url, /buy\.stripe\.com/);
  assert.match(co.url, new RegExp(`client_reference_id=asrpkg_${TENANT}`));
});

test('SIGNED webhook (asrpkg_) grants the Full Readiness entitlement', async () => {
  const res = await postWebhook(SRV.base, {
    id: 'evt_pkg_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_pkg_1', client_reference_id: `asrpkg_${TENANT}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asr, 'package');
  assert.equal(body.product, 'full');
  assert.equal(body.fulfilled, true);
  const pkgs = await activePackages(SRV.scratch, TENANT);
  assert.equal(pkgs.length, 1, 'exactly one active entitlement');
  assert.equal(pkgs[0].product, 'full');
  assert.equal(pkgs[0].stripe_session_id, 'cs_pkg_1');
});

test('package fulfillment is idempotent (replay + distinct event never double-grant)', async () => {
  // Replay of the same event id: router-level idempotency (no-op).
  const replay = await postWebhook(SRV.base, {
    id: 'evt_pkg_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_pkg_1', client_reference_id: `asrpkg_${TENANT}` } },
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent, true);
  // A DISTINCT event carrying the same binding: fulfillment-level idempotency
  // (already-active grant), still fulfilled, still exactly one row.
  const again = await postWebhook(SRV.base, {
    id: 'evt_pkg_2', type: 'checkout.session.completed',
    data: { object: { id: 'cs_pkg_2', client_reference_id: `asrpkg_${TENANT}` } },
  });
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.asr, 'package');
  assert.equal(body.fulfilled, true);
  const pkgs = await activePackages(SRV.scratch, TENANT);
  assert.equal(pkgs.length, 1, 'still exactly one active entitlement after a distinct event');
});

test('Continuous-Plus checkout + webhook activates a subscription (asrsub_plus_)', async () => {
  const co = await (await fetch(SRV.base + '/v1/audit/package/checkout', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ product: 'plus' }),
  })).json();
  assert.equal(co.ok, true);
  assert.equal(co.source, 'payment_link');
  assert.match(co.url, new RegExp(`client_reference_id=asrsub_plus_${TENANT}`));
  const res = await postWebhook(SRV.base, {
    id: 'evt_plus_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_plus_1', subscription: 'sub_plus_1', customer: 'cus_plus_1', client_reference_id: `asrsub_plus_${TENANT}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asr, 'continuous');
  assert.equal(body.product, 'plus');
  assert.equal(body.activated, true);
});

test('POST /v1/audit/import ingests inline logs -> signed, offline-verifiable report', async () => {
  const res = await fetch(SRV.base + '/v1/audit/import', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'inline',
      subject: 'Onramp fleet',
      logs: [
        {
          ts: '2026-06-09T00:00:00Z', agent: 'support-1', key_id: 'k1', request_id: 'r1', model: 'gpt-4o',
          request: { messages: [
            { role: 'user', content: 'refund order 123' },
            { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'db.read', arguments: JSON.stringify({ table: 'orders', url: 'https://api.internal.example.com/orders/123' }) } }] },
          ] },
          response: { choices: [{ message: { role: 'assistant', content: 'done' } }] },
          scopes: { granted: ['db.read'] },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.source, 'inline');
  assert.ok(body.bytes > 0, 'reports the imported byte size');
  assert.equal(body.signed, true);
  assert.ok(body.report && body.report.schema, 'returns the signed envelope');
  assert.ok(body.summary && typeof body.summary.readiness_pct === 'number', 'returns a readiness summary');
  assert.equal(verifyReport(body.report).ok, true, 'the imported report verifies offline');
});

test('POST /v1/audit/import rejects an empty inline payload (400, never throws)', async () => {
  const res = await fetch(SRV.base + '/v1/audit/import', {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'inline', logs: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('POST /v1/audit/import is auth-gated (401 without a key)', async () => {
  const res = await fetch(SRV.base + '/v1/audit/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'inline', logs: [{ ts: '2026-06-09T00:00:00Z', agent: 'a', tool: 't', action: 'call', actor: 'a', event_id: 'x' }] }),
  });
  assert.equal(res.status, 401);
});

test('teardown', () => {
  try { SRV && SRV.proc.kill('SIGKILL'); } catch {}
  try { SRV && fs.rmSync(SRV.scratch, { recursive: true, force: true }); } catch {}
});
