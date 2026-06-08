// Billing completeness — TRACK BILLING (M9-M15).
//
// Covers the procurement-grade commercial surface end-to-end:
//   M9  Stripe Billing Portal route      -> POST /v1/account/billing/portal
//   M10 Pro-rata downgrade credit math   -> stripe.js pure helpers + webhook
//   M11 Invoices / receipts ledger       -> invoice.payment_succeeded + GET list
//   M12 Dunning 3/7/14-day retry ladder  -> dunning.js + invoice.payment_failed
//   M13 Admin refund (auth-gated) + VAT  -> POST /v1/admin/refund + PATCH billing
//   M14 Audit trail                       -> billing.* rows on the audit_events chain
//   M15 Credential TTL (renewable)        -> auth.js scoped-key expires_at + renew
//
// Two layers: pure-unit (stripe.js math + store-backed dunning/auth via a
// dedicated temp data dir) and HTTP-integration against a spawned server.js with
// a SIGNED Stripe webhook (mirrors tests/asr-money-loop-http.test.js). No live
// Stripe account: the portal/refund routes are exercised on the 503 (unconfigured)
// + 403 (auth-gated) paths, and the portal helper is unit-tested with a fetch stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  computeProrataCredit, prorataCreditFromEvent, subscriptionAmountCents,
  createBillingPortalSession, createStripeRefund, applyStripeCustomerCredit,
} from '../src/stripe.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEBHOOK_SECRET = 'whsec_test_' + 'x'.repeat(24);
const CRON_SECRET = 'cron_test_secret_value_1234567890';
const ADMIN_KEY = 'admin_test_key_' + 'z'.repeat(20);

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

// ---------------------------------------------------------------------------
// PURE UNIT — stripe.js billing math (M9 / M10 / M13 helpers). No store, no net.
// ---------------------------------------------------------------------------

test('M10 pro-rata credit math: only downgrades, valued by unused period', () => {
  const now = Math.floor(Date.now() / 1000);
  // $99 -> $29 with exactly half a 30-day period remaining: (9900-2900)/30*15.
  assert.equal(computeProrataCredit({ oldAmountCents: 9900, newAmountCents: 2900, periodEndSec: now + 15 * 86400, nowSec: now }), 3500);
  // Full period remaining = full delta.
  assert.equal(computeProrataCredit({ oldAmountCents: 9900, newAmountCents: 2900, periodEndSec: now + 30 * 86400, nowSec: now }), 7000);
  // Upgrade (new > old) -> no credit.
  assert.equal(computeProrataCredit({ oldAmountCents: 2900, newAmountCents: 9900, periodEndSec: now + 15 * 86400, nowSec: now }), 0);
  // Period already elapsed -> no credit.
  assert.equal(computeProrataCredit({ oldAmountCents: 9900, newAmountCents: 2900, periodEndSec: now - 100, nowSec: now }), 0);
  // Non-numeric inputs -> 0, never throws.
  assert.equal(computeProrataCredit({ oldAmountCents: null, newAmountCents: 2900 }), 0);
});

test('M10 amount extraction handles legacy plan.amount and modern items[]', () => {
  assert.equal(subscriptionAmountCents({ plan: { amount: 4900 } }), 4900);
  assert.equal(subscriptionAmountCents({ items: { data: [{ price: { unit_amount: 2500 }, quantity: 2 }] } }), 5000);
  assert.equal(subscriptionAmountCents({}), null);
  const now = Math.floor(Date.now() / 1000);
  const ev = { data: { object: { id: 'sub_x', plan: { amount: 2900 }, current_period_end: now + 15 * 86400 }, previous_attributes: { plan: { amount: 9900 } } } };
  const pc = prorataCreditFromEvent(ev, { nowSec: now });
  assert.equal(pc.old_amount_cents, 9900);
  assert.equal(pc.new_amount_cents, 2900);
  assert.equal(pc.credit_cents, 3500);
});

test('M9 portal helper returns a url (mock Stripe) + 503 when key absent', async () => {
  let seenUrl = null, seenBody = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url; seenBody = init.body;
    return { ok: true, json: async () => ({ id: 'bps_1', url: 'https://billing.stripe.com/session/abc' }) };
  };
  const out = await createBillingPortalSession({ customer: 'cus_123', returnUrl: 'https://kolm.ai/account-billing', secretKey: 'sk_test_x', fetchImpl });
  assert.equal(out.url, 'https://billing.stripe.com/session/abc');
  assert.match(seenUrl, /\/v1\/billing_portal\/sessions$/);
  assert.match(seenBody, /customer=cus_123/);
  // Missing secret key (and none in env) -> typed 503.
  const prev = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  await assert.rejects(() => createBillingPortalSession({ customer: 'cus_1' }), (e) => e.statusCode === 503 && e.code === 'stripe_not_configured');
  if (prev != null) process.env.STRIPE_SECRET_KEY = prev;
});

test('M13 refund helper posts the charge + maps the reason enum', async () => {
  let body = null;
  const fetchImpl = async (url, init) => { body = init.body; return { ok: true, json: async () => ({ id: 're_1', status: 'succeeded', amount: 500, charge: 'ch_1' }) }; };
  const out = await createStripeRefund({ charge: 'ch_1', amountCents: 500, reason: 'requested_by_customer', secretKey: 'sk_test_x', fetchImpl });
  assert.equal(out.id, 're_1');
  assert.match(body, /charge=ch_1/);
  assert.match(body, /amount=500/);
  assert.match(body, /reason=requested_by_customer/);
  await assert.rejects(() => createStripeRefund({ secretKey: 'sk_test_x', fetchImpl }), (e) => e.code === 'no_charge');
});

test('M10 customer credit is a NEGATIVE balance transaction', async () => {
  let body = null, url = null;
  const fetchImpl = async (u, init) => { url = u; body = init.body; return { ok: true, json: async () => ({ id: 'cbtxn_1', amount: -3500, ending_balance: -3500 }) }; };
  const out = await applyStripeCustomerCredit({ customer: 'cus_9', amountCents: 3500, secretKey: 'sk_test_x', fetchImpl });
  assert.equal(out.ok, true);
  assert.match(url, /\/v1\/customers\/cus_9\/balance_transactions$/);
  assert.match(body, /amount=-3500/);
});

// ---------------------------------------------------------------------------
// STORE-BACKED UNIT — dunning ladder (M12) + credential TTL (M15). Uses a
// dedicated temp data dir on the JSON driver so it never touches repo/data and
// is fully isolated from the spawned server below. store.js is first loaded by
// these dynamic imports (the static imports above are store-free), so setting
// KOLM_DATA_DIR here is honored.
// ---------------------------------------------------------------------------

test('M12 + M15 store-backed: dunning ladder + renewable credential TTL', async () => {
  const dir = path.join(os.tmpdir(), `kolm-billing-unit-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.KOLM_DATA_DIR = dir;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.RECIPE_RECEIPT_SECRET = 'test-receipt-secret-test-receipt-secret-32';

  const dunning = await import('../src/dunning.js');
  const auth = await import('../src/auth.js');

  // --- M12 pure offset ladder ---
  assert.deepEqual(dunning.RETRY_OFFSETS_DAYS, [3, 7, 14]);
  assert.equal(dunning.retryPaymentFailure('cus_1', 1).offset_days, 3);
  assert.equal(dunning.retryPaymentFailure('cus_1', 2).offset_days, 7);
  assert.equal(dunning.retryPaymentFailure('cus_1', 3).offset_days, 14);
  assert.equal(dunning.retryPaymentFailure('cus_1', 4).action, 'suspend');
  assert.equal(dunning.retryPaymentFailure('cus_1', 4).final, true);

  // --- M12 store-backed schedule + idempotent sweep advance to suspension ---
  const TID = 'tenant_dun_' + crypto.randomBytes(4).toString('hex');
  const T0 = Date.now();
  const sched = dunning.scheduleDunning({ tenant_id: TID, stripe_customer_id: 'cus_d', stripe_subscription_id: 'sub_d', stripe_invoice_id: 'in_d' });
  assert.equal(sched.ok, true);
  assert.equal(sched.created, true);
  assert.equal(sched.dunning.attempt, 1);
  // Re-failure for the same open schedule does not double-advance the ladder.
  const again = dunning.scheduleDunning({ tenant_id: TID, stripe_subscription_id: 'sub_d', stripe_invoice_id: 'in_d2' });
  assert.equal(again.already, true);
  assert.equal(again.dunning.attempt, 1);
  // Not yet due -> sweep is a no-op.
  assert.equal(dunning.runDueDunning({ now: T0 + 1 * 86400000 }).processed, 0);
  // Past the first 3-day retry -> advance to attempt 2.
  let sent = 0;
  let sweep = dunning.runDueDunning({ now: T0 + 4 * 86400000, sendFn: () => { sent++; } });
  assert.equal(sweep.processed, 1);
  assert.equal(sweep.results[0].attempt, 2);
  assert.equal(sweep.results[0].suspended, false);
  assert.ok(sent >= 1, 'a dunning reminder was sent');
  // Advance attempt 2 -> 3 (next retry ~ now+7d) then 3 -> suspend (~ now+14d).
  sweep = dunning.runDueDunning({ now: Date.now() + 9 * 86400000 });
  assert.equal(sweep.results[0].attempt, 3);
  assert.equal(sweep.results[0].suspended, false);
  sweep = dunning.runDueDunning({ now: Date.now() + 16 * 86400000 });
  assert.equal(sweep.results[0].attempt, 4);
  assert.equal(sweep.results[0].suspended, true);
  // Once suspended it is no longer due.
  assert.equal(dunning.runDueDunning({ now: Date.now() + 60 * 86400000 }).processed, 0);
  // A recovery closes any open schedule (idempotent).
  const TID2 = 'tenant_dun2_' + crypto.randomBytes(4).toString('hex');
  dunning.scheduleDunning({ tenant_id: TID2, stripe_subscription_id: 'sub_e' });
  assert.equal(dunning.resolveDunning({ tenant_id: TID2 }).closed, 1);
  assert.equal(dunning.runDueDunning({ now: Date.now() + 30 * 86400000 }).results.filter((r) => r.tenant_id === TID2).length, 0);

  // --- M12 templated email is a pure, non-throwing renderer ---
  const tpl = dunning.tEmailDunning({ email: 'x@y.com', attempt: 2, amount_cents: 9900, next_retry_at: new Date().toISOString() });
  assert.match(tpl.subject, /payment failed/i);
  assert.match(tpl.text, /Update payment method/);
  const finalTpl = dunning.tEmailDunning({ email: 'x@y.com', attempt: 4, final: true });
  assert.match(finalTpl.subject, /suspended/i);

  // --- M15 credential TTL: mint expired -> not resolvable -> renew -> resolvable ---
  const t = auth.provisionTenant('ttl-tenant-' + crypto.randomBytes(3).toString('hex'), { plan: 'free' });
  const past = new Date(Date.now() - 1000).toISOString();
  const minted = auth.mintScopedKey(t.id, { scopes: ['*'], label: 'ci', expires_at: past });
  assert.equal(minted.expires_at, past);
  // Expired scoped key does not authenticate.
  assert.equal(auth.findTenantByApiKey(minted.key), null);
  // It is reported as expired/inactive in the listing.
  let listed = auth.listScopedKeys(t.id);
  const row = listed.find((k) => k.key_prefix === minted.key_prefix);
  assert.equal(row.expired, true);
  assert.equal(row.active, false);
  // Renew (extend) -> same key authenticates again.
  const rn = auth.renewScopedKey(t.id, row.id, { ttl_days: 30 });
  assert.equal(rn.ok, true);
  const resolved = auth.findTenantByApiKey(minted.key);
  assert.ok(resolved && resolved.id === t.id);
  // Listing now surfaces "expires in N days".
  listed = auth.listScopedKeys(t.id);
  const row2 = listed.find((k) => k.id === row.id);
  assert.ok(row2.expires_in_days >= 29 && row2.expires_in_days <= 31, `expires_in_days ~30, got ${row2.expires_in_days}`);
  assert.equal(row2.active, true);
  // A key minted with NO ttl never expires (null = never) — legacy behavior intact.
  const forever = auth.mintScopedKey(t.id, { scopes: ['*'] });
  assert.equal(forever.expires_at, null);
  assert.ok(auth.findTenantByApiKey(forever.key));
});

// ---------------------------------------------------------------------------
// HTTP INTEGRATION — spawned server.js with a signed Stripe webhook. No
// STRIPE_SECRET_KEY (Payment-Link-only deployment), so portal/refund exercise
// the unconfigured (503) + auth-gated (403) paths.
// ---------------------------------------------------------------------------

let proc = null, base = null, scratch = null, KEY = null, TENANT = null;

test('setup — spawn server (webhook + payment links + admin key)', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratch = path.join(os.tmpdir(), `kolm-billing-${process.pid}-${Date.now()}`);
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
      KOLM_CRON_SECRET: CRON_SECRET,
      ADMIN_KEY,
      KOLM_REATTEST_DISABLE: '1',
      ANTHROPIC_API_KEY: '',
      STRIPE_SECRET_KEY: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { if (/FATAL|Error:/.test(String(d))) process.stderr.write(d); });
  await waitForHealth(base);

  const su = await (await fetch(base + '/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'billing@example.com' }) })).json();
  KEY = su.api_key; TENANT = su.tenant.id;
  assert.match(KEY, /^ks_/);
});

test('M9 portal route is 503 when Stripe secret key is unconfigured', async () => {
  const r = await fetch(base + '/v1/account/billing/portal', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'billing_not_configured');
});

test('M10 webhook records a pro-rata credit on a real downgrade', async () => {
  // Make the tenant a paid gateway subscriber (teams @ $99) with sub+customer ids.
  let r = await postWebhook(base, {
    id: 'evt_up_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_up_1', client_reference_id: TENANT, amount_total: 9900, subscription: 'sub_gw_1', customer: 'cus_gw_1' } },
  });
  assert.equal(r.status, 200);
  // Downgrade to $29 with 15 days left in the period.
  const periodEnd = Math.floor(Date.now() / 1000) + 15 * 86400;
  r = await postWebhook(base, {
    id: 'evt_dn_1', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_gw_1', status: 'active', current_period_end: periodEnd, plan: { amount: 2900 } }, previous_attributes: { plan: { amount: 9900 } } },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.prorata_credit_cents >= 3500, `credit computed, got ${body.prorata_credit_cents}`);
  const bill = await (await fetch(base + '/v1/account/billing', { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.ok(bill.credit_balance_cents >= 3500, `tenant credit balance, got ${bill.credit_balance_cents}`);
});

test('M11 paid invoice is recorded and listed', async () => {
  const r = await postWebhook(base, {
    id: 'evt_inv_1', type: 'invoice.payment_succeeded',
    data: { object: { id: 'in_1', customer: 'cus_gw_1', subscription: 'sub_gw_1', amount_paid: 2900, currency: 'usd', number: 'KOLM-0001', hosted_invoice_url: 'https://stripe.test/inv/1', invoice_pdf: 'https://stripe.test/inv/1.pdf', status: 'paid' } },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).invoice, 'recorded');
  const list = await (await fetch(base + '/v1/account/invoices', { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.ok(list.invoices.length >= 1);
  const iv = list.invoices.find((x) => x.amount_paid_cents === 2900);
  assert.ok(iv && iv.hosted_invoice_url === 'https://stripe.test/inv/1', 'invoice carries the hosted url');
  // Replay is idempotent (no duplicate receipt).
  await postWebhook(base, { id: 'evt_inv_1', type: 'invoice.payment_succeeded', data: { object: { id: 'in_1', customer: 'cus_gw_1' } } });
  const list2 = await (await fetch(base + '/v1/account/invoices', { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(list2.invoices.filter((x) => x.amount_paid_cents === 2900).length, 1);
});

test('M12 failed payment schedules dunning + marks past_due', async () => {
  const r = await postWebhook(base, {
    id: 'evt_fail_1', type: 'invoice.payment_failed',
    data: { object: { id: 'in_2', customer: 'cus_gw_1', subscription: 'sub_gw_1' } },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).dunning_scheduled, true);
  const bill = await (await fetch(base + '/v1/account/billing', { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(bill.billing_status, 'past_due');
  assert.ok(bill.dunning.length >= 1, 'open dunning schedule surfaced');
  assert.equal(bill.dunning[0].attempt, 1);
});

test('M13 VAT / tax-id field persists (tenant-fenced)', async () => {
  const r = await fetch(base + '/v1/account/billing', {
    method: 'PATCH', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ vat_number: 'DE123456789', tax_id: 'EIN-99', company_name: 'ACME GmbH', country_code: 'de' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tax.vat_number, 'DE123456789');
  assert.equal(j.tax.country_code, 'DE');
  const bill = await (await fetch(base + '/v1/account/billing', { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(bill.tax.vat_number, 'DE123456789');
  assert.equal(bill.tax.company_name, 'ACME GmbH');
});

test('M13 admin refund is auth-gated to owner/admin', async () => {
  // A normal tenant key cannot issue refunds.
  let r = await fetch(base + '/v1/admin/refund', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ stripe_charge_id: 'ch_1', amount_cents: 500 }) });
  assert.equal(r.status, 403);
  // The admin key passes the gate; with no Stripe secret key the refund is 503.
  r = await fetch(base + '/v1/admin/refund', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ stripe_charge_id: 'ch_1', amount_cents: 500 }) });
  assert.equal(r.status, 503);
  // Admin, but missing the charge id -> 400 (validated past the auth gate).
  r = await fetch(base + '/v1/admin/refund', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);
});

test('M13 billing summary renders the Full Readiness entitlement', async () => {
  const bill = await (await fetch(base + '/v1/account/billing', { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.ok(bill.full_readiness && Array.isArray(bill.full_readiness.includes) && bill.full_readiness.includes.length >= 3);
  assert.equal(bill.full_readiness.schedule_review.contact, 'dev@kolm.ai');
  assert.equal(bill.full_readiness.price_usd, 15000);
});

test('M14 billing operations are appended to the audit chain', async () => {
  const adm = await (await fetch(base + '/v1/admin/audit?limit=500', { headers: { authorization: `Bearer ${ADMIN_KEY}` } })).json();
  const ops = adm.events.filter((e) => e.tenant_id === TENANT).map((e) => e.op);
  assert.ok(ops.includes('billing.plan_changed'), 'plan change audited');
  assert.ok(ops.includes('settings.updated'), 'VAT update audited');
  assert.ok(ops.includes('billing.stripe_event'), 'subscription/invoice events audited');
});

test('teardown', () => {
  try { proc && proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});
