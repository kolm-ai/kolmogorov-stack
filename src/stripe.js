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

// Cents → plan id. Numbers must match `cents_monthly` in PLAN_CATALOG.
// Wave4 stripe-fix: indie (2900) + team (9900) + business (49900) +
// enterprise (149900) are first-class self-serve rows that mirror the
// homepage tier grid. Legacy amounts (900 starter, 14900 old-team,
// 49900-as-team, 299900 old-enterprise) stay mapped so existing Payment
// Links / webhooks still resolve. NOTE on 49900: the current canonical
// price for the Business row is $499 (49900 cents). The legacy "Team @
// $499" link (also 49900 cents) is therefore re-bucketed to business
// here — operators with an active Team $499 link should re-provision
// via scripts/stripe-provision.mjs so the metadata reflects the new
// tier mapping, or remap manually with STRIPE_PAYMENT_LINK_TEAMS.
const AMOUNT_TO_PLAN = {
  900:    'pro',         // legacy starter link
  2900:   'indie',       // Indie $29
  4900:   'pro',         // Pro $49
  9900:   'teams',       // Team $99
  14900:  'teams',       // legacy team link
  49900:  'business',    // Business $499 (was Team $499 in pre-wave4 catalog)
  149900: 'enterprise',  // Enterprise $1,499
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
