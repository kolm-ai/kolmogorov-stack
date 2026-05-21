// Unit coverage for src/stripe.js: signature verify (the round-trip live
// smoke can't easily exercise without setting STRIPE_WEBHOOK_SECRET on the
// deployed server) plus the cents -> plan id mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyStripeSignature, planFromAmount, appendCheckoutParams } from '../src/stripe.js';

function signedHeader(body, secret, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}

test('verifyStripeSignature: valid signature passes', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: 't_1', amount_total: 4900 } } });
  const header = signedHeader(body, secret);
  const r = verifyStripeSignature(body, header, secret);
  assert.equal(r.ok, true, 'expected ok=true for valid signature');
});

test('verifyStripeSignature: tampered body fails with signature mismatch', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const header = signedHeader(body, secret);
  const tampered = body + ' ';
  const r = verifyStripeSignature(tampered, header, secret);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature mismatch');
});

test('verifyStripeSignature: timestamp outside tolerance fails', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({ id: 'evt_2' });
  const oldTs = Math.floor(Date.now() / 1000) - 3600;
  const header = signedHeader(body, secret, oldTs);
  const r = verifyStripeSignature(body, header, secret);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timestamp outside tolerance');
});

test('verifyStripeSignature: malformed header fails', () => {
  const secret = 'whsec_test_secret_value';
  const r = verifyStripeSignature('{}', 'garbage', secret);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed header');
});

test('verifyStripeSignature: missing inputs return early', () => {
  assert.equal(verifyStripeSignature('', 'h', 'k').ok, false);
  assert.equal(verifyStripeSignature('b', '', 'k').ok, false);
  assert.equal(verifyStripeSignature('b', 'h', '').ok, false);
});

test('verifyStripeSignature: idempotency-friendly — same body+secret yields same digest', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_3' });
  const ts = Math.floor(Date.now() / 1000);
  const r1 = verifyStripeSignature(body, signedHeader(body, secret, ts), secret);
  const r2 = verifyStripeSignature(body, signedHeader(body, secret, ts), secret);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
});

test('planFromAmount maps each PLAN_CATALOG cents value', () => {
  assert.equal(planFromAmount(900),    'pro');
  assert.equal(planFromAmount(4900),   'pro');
  assert.equal(planFromAmount(14900),  'teams');
  assert.equal(planFromAmount(49900),  'teams');
  assert.equal(planFromAmount(149900), 'enterprise');
  assert.equal(planFromAmount(299900), 'enterprise');
});

test('planFromAmount returns null for unknown / non-numeric amounts', () => {
  assert.equal(planFromAmount(0), null);
  assert.equal(planFromAmount(1234), null);
  assert.equal(planFromAmount(null), null);
  assert.equal(planFromAmount(undefined), null);
  assert.equal(planFromAmount(NaN), null);
  assert.equal(planFromAmount('4900'), null);
});

test('appendCheckoutParams stitches client_reference_id and prefilled_email', () => {
  const out = appendCheckoutParams('https://buy.stripe.com/test_link', {
    tenantId: 't_abc',
    email: 'user@example.com',
  });
  const u = new URL(out);
  assert.equal(u.searchParams.get('client_reference_id'), 't_abc');
  assert.equal(u.searchParams.get('prefilled_email'), 'user@example.com');
});

test('appendCheckoutParams returns the input untouched on bad URL or null', () => {
  assert.equal(appendCheckoutParams(null, { tenantId: 't' }), null);
  assert.equal(appendCheckoutParams('not a url', { tenantId: 't' }), 'not a url');
});
