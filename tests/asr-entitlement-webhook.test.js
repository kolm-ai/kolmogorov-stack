// ASR ENTITLEMENT webhook fulfillment tests (G3).
//
// Proves the Stripe webhook activates the two tenant-bound ENTITLEMENT SKUs end
// to end over real HTTP, on the metadata-less Payment-Link path (the path prod
// runs, since prod has no Stripe secret key - only a webhook secret + links):
//
//   signup -> SIGNED checkout.session.completed with client_reference_id
//   'asrent_redteam_<tenant>'  -> Deep Red-Team ($10k) entitlement ACTIVE
//   'asrent_reviewed_<tenant>' -> Reviewed Attestation ($25k) entitlement ACTIVE
//
// Activation is asserted both from the webhook response (asr/fulfilled) AND from
// the persisted asr_entitlements store row (the durable money-bearing record).
// A bad-signature webhook is rejected (400). Replaying the same event is a no-op.
//
// Runs on the JSON driver so the test can read the persisted asr_entitlements.json
// row directly and confirm the durable grant (status:'active', the right kind).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEBHOOK_SECRET = 'whsec_test_' + 'y'.repeat(24);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForHealth(base, retries = 100) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch { /* deliberate: retry */ }
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
// Read the persisted entitlements collection (JSON driver writes <name>.json).
function readEntitlements(dataDir) {
  const f = path.join(dataDir, 'asr_entitlements.json');
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

let proc = null, base = null, scratch = null, KEY = null, TENANT = null;

test('setup - spawn server (JSON store) with redteam + reviewed payment links + webhook secret', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratch = path.join(os.tmpdir(), `kolm-ent-${process.pid}-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: scratch,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      RECIPE_RECEIPT_SECRET: 'test-receipt-secret-test-receipt-secret-32',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PAYMENT_LINK_ASR_DEEP_REDTEAM: 'https://buy.stripe.com/test_redteam',
      STRIPE_PAYMENT_LINK_ASR_REVIEWED: 'https://buy.stripe.com/test_reviewed',
      KOLM_REATTEST_DISABLE: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { if (/FATAL|Error:/.test(String(d))) process.stderr.write(d); });
  await waitForHealth(base);

  const su = await (await fetch(base + '/v1/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'entitlement@example.com' }),
  })).json();
  KEY = su.api_key; TENANT = su.tenant.id;
  assert.match(KEY, /^ks_/);
  assert.ok(TENANT);
});

test('SIGNED webhook fulfills asr_redteam (Deep Red-Team) -> entitlement ACTIVE', async () => {
  const res = await postWebhook(base, {
    id: 'evt_redteam_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_redteam_1', client_reference_id: `asrent_redteam_${TENANT}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asr, 'redteam');
  assert.equal(body.fulfilled, true, 'redteam entitlement fulfilled');
  assert.equal(body.tenant, TENANT);

  // Durable record: an ACTIVE deep_redteam entitlement row for this tenant.
  const rows = readEntitlements(scratch);
  const row = rows.find((e) => e.tenant_id === TENANT && e.kind === 'deep_redteam');
  assert.ok(row, 'deep_redteam entitlement row persisted');
  assert.equal(row.status, 'active');
  assert.equal(row.kolm_product, 'asr_redteam');
  assert.equal(row.stripe_session_id, 'cs_redteam_1');
});

test('SIGNED webhook fulfills asr_reviewed (Reviewed Attestation) -> entitlement ACTIVE', async () => {
  const res = await postWebhook(base, {
    id: 'evt_reviewed_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_reviewed_1', client_reference_id: `asrent_reviewed_${TENANT}` } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asr, 'reviewed');
  assert.equal(body.fulfilled, true, 'reviewed entitlement fulfilled');
  assert.equal(body.tenant, TENANT);

  const rows = readEntitlements(scratch);
  const row = rows.find((e) => e.tenant_id === TENANT && e.kind === 'reviewed_attestation');
  assert.ok(row, 'reviewed_attestation entitlement row persisted');
  assert.equal(row.status, 'active');
  assert.equal(row.kolm_product, 'asr_reviewed');
  assert.equal(row.stripe_session_id, 'cs_reviewed_1');
});

test('webhook with a bad signature is rejected (400) - no forged entitlement', async () => {
  const raw = JSON.stringify({
    id: 'evt_bad', type: 'checkout.session.completed',
    data: { object: { id: 'cs_bad', client_reference_id: `asrent_redteam_${TENANT}` } },
  });
  const res = await fetch(base + '/v1/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: raw,
  });
  assert.equal(res.status, 400);
});

test('replaying a fulfilled entitlement event is idempotent (no duplicate grant)', async () => {
  const res = await postWebhook(base, {
    id: 'evt_redteam_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_redteam_1', client_reference_id: `asrent_redteam_${TENANT}` } },
  });
  assert.equal(res.status, 200);
  // Exactly one active deep_redteam row remains for this tenant.
  const rows = readEntitlements(scratch).filter((e) => e.tenant_id === TENANT && e.kind === 'deep_redteam' && e.status === 'active');
  assert.equal(rows.length, 1, 'replay never double-grants the entitlement');
});

test('teardown', () => {
  try { proc && proc.kill('SIGKILL'); } catch { /* best effort */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});
