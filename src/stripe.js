// Stripe webhook signature verification + plan-mapping helpers.
//
// We do not depend on the Stripe SDK. Stripe webhook signatures are
// HMAC-SHA256 over `${timestamp}.${rawBody}` with the webhook signing secret;
// the result is sent in the `stripe-signature` header as
// `t=<timestamp>,v1=<hex>,...`. Verification is a constant-time compare.
//
// Plan resolution: each Payment Link is provisioned with a known monthly
// price; we map the `amount_total` (cents) on the completed Checkout Session
// back to the canonical plan id. Annual prepay or alternate prices fall
// through to `null` and the webhook records the event without flipping a
// plan.

import crypto from 'node:crypto';

export function verifyStripeSignature(rawBody, sigHeader, secret, tolerance = 300) {
  if (!rawBody || !sigHeader || !secret) return { ok: false, reason: 'missing inputs' };
  const parts = String(sigHeader).split(',').reduce((acc, p) => {
    const idx = p.indexOf('=');
    if (idx <= 0) return acc;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
    return acc;
  }, {});
  const timestamp = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!timestamp || sigs.length === 0) return { ok: false, reason: 'malformed header' };
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Date.now() / 1000 - ts) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const ok = sigs.some(s => {
    let buf;
    try { buf = Buffer.from(s, 'hex'); } catch (_) { return false; }
    if (buf.length !== expectedBuf.length) return false;
    try { return crypto.timingSafeEqual(buf, expectedBuf); } catch (_) { return false; }
  });
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

// Cents → plan id. W889-6.1: Enterprise is now sales-led with cents_monthly:null
// in PLAN_CATALOG; the 149900 / 299900 mappings here remain only so legacy
// Payment Links (provisioned before the Contact-Sales flip) still resolve to
// the enterprise plan on the webhook side. New Enterprise checkouts go through
// /v1/sales/demo-request and never produce a self-serve Stripe charge.
const AMOUNT_TO_PLAN = {
  900:    'pro',         // legacy starter link
  2900:   'indie',       // Indie $29
  4900:   'pro',         // Pro $49
  9900:   'teams',       // Team $99
  14900:  'teams',       // legacy team link
  49900:  'business',    // Business $499 (was Team $499 in pre-wave4 catalog)
  149900: 'enterprise',  // legacy Enterprise $1,499 link - pre-W889-6.1
  299900: 'enterprise',  // legacy enterprise link
};

export function planFromAmount(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  return AMOUNT_TO_PLAN[cents] || null;
}

// Append `client_reference_id` and `prefilled_email` to a Stripe Payment Link
// so the resulting Checkout Session carries the tenant id back to us in the
// webhook payload.
export function appendCheckoutParams(url, { tenantId, email } = {}) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch (_) { return url; }
  if (tenantId) u.searchParams.set('client_reference_id', String(tenantId));
  if (email) u.searchParams.set('prefilled_email', String(email));
  return u.toString();
}

// ---------------------------------------------------------------------------
// Stripe REST helpers (no SDK; global fetch). These power the procurement-grade
// self-serve surface: the Billing Portal (M9), pro-rata downgrade credits (M10),
// invoice retrieval (M11), and admin refunds (M13). Every helper accepts an
// injectable `fetchImpl` + `baseUrl` so the test-suite can drive them against a
// stub without a live Stripe account, and reads STRIPE_SECRET_KEY (+ the two
// historical aliases the rest of the codebase already honors) when a key is not
// passed explicitly. None of these throw a bare string; failures carry a typed
// `.code` + `.statusCode` so the route can map them to a clean HTTP envelope.
// ---------------------------------------------------------------------------

// The Stripe secret key, honoring the same alias chain as billing-activation.js
// (STRIPE_SECRET_KEY -> KOLM_STRIPE_KEY -> STRIPE_API_KEY). Empty strings are
// treated as unset so STRIPE_SECRET_KEY="" never looks configured.
export function stripeSecretKeyFromEnv() {
  for (const name of ['STRIPE_SECRET_KEY', 'KOLM_STRIPE_KEY', 'STRIPE_API_KEY']) {
    const v = process.env[name];
    if (v != null && String(v).trim().length > 0) return String(v).trim();
  }
  return null;
}

function _stripeError(message, code, statusCode, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

// Low-level Stripe REST call. `params` is an object/URLSearchParams for POST
// (form-urlencoded) or null for GET. Returns the parsed JSON body or throws a
// typed error. A missing secret key throws `stripe_not_configured` (503) so the
// caller can degrade to "configure to enable" rather than 500.
async function stripeRequest(method, path, params, { secretKey, baseUrl, fetchImpl, timeoutMs = 10000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw _stripeError('global fetch is unavailable (requires Node >= 18)', 'fetch_unavailable', 500);
  }
  const key = secretKey || stripeSecretKeyFromEnv();
  if (!key) {
    throw _stripeError('STRIPE_SECRET_KEY is not configured', 'stripe_not_configured', 503);
  }
  const base = (baseUrl || 'https://api.stripe.com').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${key}` };
  const init = { method, headers };
  if (params != null && method !== 'GET') {
    const usp = params instanceof URLSearchParams ? params : (() => {
      const u = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) { if (v != null) u.set(k, String(v)); }
      return u;
    })();
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = usp.toString();
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  init.signal = ctl.signal;
  try {
    const resp = await doFetch(base + path, init);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = body && body.error && body.error.message ? body.error.message : `stripe_http_${resp.status}`;
      throw _stripeError(msg, 'stripe_api_error', 502, { stripe_status: resp.status });
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// M9 - Stripe Billing Portal session. Returns { url, id }. The portal is the
// only place a customer can self-serve update a payment method, see invoices,
// or cancel/downgrade outside our own flows; before this they could not.
export async function createBillingPortalSession({ customer, returnUrl, secretKey, baseUrl, fetchImpl } = {}) {
  if (!customer) throw _stripeError('customer (stripe_customer_id) is required', 'no_customer', 409);
  const params = new URLSearchParams();
  params.set('customer', String(customer));
  if (returnUrl) params.set('return_url', String(returnUrl));
  const body = await stripeRequest('POST', '/v1/billing_portal/sessions', params, { secretKey, baseUrl, fetchImpl });
  return { url: body.url || null, id: body.id || null };
}

// M10 - resolve the recurring amount (cents) of a subscription OR a Stripe
// `previous_attributes` overlay. Prefers the modern items[].price.unit_amount
// (summed * quantity) and falls back to the legacy top-level plan.amount. Pure.
export function subscriptionAmountCents(subLike) {
  if (!subLike || typeof subLike !== 'object') return null;
  const items = subLike.items && Array.isArray(subLike.items.data) ? subLike.items.data : null;
  if (items && items.length) {
    let total = 0; let any = false;
    for (const it of items) {
      const price = it && it.price;
      const amt = price && typeof price.unit_amount === 'number' ? price.unit_amount : null;
      const qty = it && typeof it.quantity === 'number' ? it.quantity : 1;
      if (amt != null) { total += amt * qty; any = true; }
    }
    if (any) return total;
  }
  if (subLike.plan && typeof subLike.plan.amount === 'number') {
    const qty = typeof subLike.quantity === 'number' ? subLike.quantity : 1;
    return subLike.plan.amount * qty;
  }
  return null;
}

// M10 - pro-rata credit math. A credit is owed ONLY on a downgrade (new < old):
// the unused fraction of the billing period, valued at the price delta. Pure +
// deterministic (now/period injectable). Returns whole cents, never negative.
export function computeProrataCredit({ oldAmountCents, newAmountCents, periodEndSec, nowSec, billingPeriodDays = 30 } = {}) {
  if (typeof oldAmountCents !== 'number' || typeof newAmountCents !== 'number') return 0;
  if (!(newAmountCents < oldAmountCents)) return 0;
  const now = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
  let daysRemaining = 0;
  if (typeof periodEndSec === 'number' && periodEndSec > now) {
    daysRemaining = (periodEndSec - now) / 86400;
  }
  daysRemaining = Math.min(daysRemaining, billingPeriodDays);
  const dailyDelta = (oldAmountCents - newAmountCents) / billingPeriodDays;
  const credit = Math.round(dailyDelta * daysRemaining);
  return credit > 0 ? credit : 0;
}

// M10 - extract old/new amount from a customer.subscription.updated event and
// compute the credit. `previous_attributes` carries only the CHANGED fields, so
// the OLD subscription is reconstructed by overlaying it on the new object.
export function prorataCreditFromEvent(event, { nowSec, billingPeriodDays } = {}) {
  const sub = (event && event.data && event.data.object) || {};
  const prev = (event && event.data && event.data.previous_attributes) || {};
  const newAmount = subscriptionAmountCents(sub);
  const oldAmount = subscriptionAmountCents({ ...sub, ...prev });
  const periodEndSec = typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
  if (typeof newAmount !== 'number' || typeof oldAmount !== 'number') {
    return { credit_cents: 0, old_amount_cents: oldAmount, new_amount_cents: newAmount, period_end_sec: periodEndSec };
  }
  const credit = computeProrataCredit({ oldAmountCents: oldAmount, newAmountCents: newAmount, periodEndSec, nowSec, billingPeriodDays });
  return { credit_cents: credit, old_amount_cents: oldAmount, new_amount_cents: newAmount, period_end_sec: periodEndSec };
}

// M10 - apply a credit to the customer's Stripe balance. A credit is a NEGATIVE
// customer balance transaction in Stripe (it reduces what they owe on the next
// invoice). Returns { ok, id, amount, ending_balance }.
export async function applyStripeCustomerCredit({ customer, amountCents, currency = 'usd', description, secretKey, baseUrl, fetchImpl } = {}) {
  if (!customer) throw _stripeError('customer is required', 'no_customer', 400);
  const cents = Math.round(Number(amountCents));
  if (!(cents > 0)) throw _stripeError('amountCents must be a positive integer', 'bad_amount', 400);
  const params = new URLSearchParams();
  params.set('amount', String(-Math.abs(cents)));
  params.set('currency', String(currency || 'usd'));
  if (description) params.set('description', String(description).slice(0, 350));
  const body = await stripeRequest('POST', `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`, params, { secretKey, baseUrl, fetchImpl });
  return { ok: true, id: body.id || null, amount: body.amount, ending_balance: body.ending_balance };
}

// M11 - retrieve a Stripe invoice by id (for the hosted_invoice_url + PDF when
// an event only carries the id). Returns the raw Stripe invoice object.
export async function retrieveStripeInvoice({ invoiceId, secretKey, baseUrl, fetchImpl } = {}) {
  if (!invoiceId) throw _stripeError('invoiceId is required', 'no_invoice', 400);
  return stripeRequest('GET', `/v1/invoices/${encodeURIComponent(invoiceId)}`, null, { secretKey, baseUrl, fetchImpl });
}

// M13 - issue a refund against a charge (or payment intent). amountCents is
// optional (omit for a full refund). `reason` is mapped to Stripe's enum;
// anything outside the enum is dropped rather than rejected by Stripe.
export async function createStripeRefund({ charge, paymentIntent, amountCents, reason, secretKey, baseUrl, fetchImpl } = {}) {
  if (!charge && !paymentIntent) throw _stripeError('charge or paymentIntent is required', 'no_charge', 400);
  const params = new URLSearchParams();
  if (charge) params.set('charge', String(charge));
  if (paymentIntent) params.set('payment_intent', String(paymentIntent));
  if (typeof amountCents === 'number' && amountCents > 0) params.set('amount', String(Math.round(amountCents)));
  const allowedReason = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);
  if (reason && allowedReason.has(String(reason))) params.set('reason', String(reason));
  const body = await stripeRequest('POST', '/v1/refunds', params, { secretKey, baseUrl, fetchImpl });
  return { ok: true, id: body.id || null, status: body.status || null, amount: body.amount, charge: body.charge || charge || null };
}
