// Wave4 stripe-fix — pin the canonical billing tier matrix.
//
// The audit found three drifts: (1) Indie ($29) was missing from PLAN_CATALOG
// so canonicalPlanId('indie') returned null and the signup silently dropped
// to free; (2) PLAN_ALIASES.business was 'enterprise' which forced self-serve
// $499 buyers into the sales-led path; (3) AMOUNT_TO_PLAN in src/stripe.js
// had no entries for 2900 / 9900 / 49900 cents so webhook plan-flip silently
// failed on completed Payment Links at those prices.
//
// This test pins each fix as a file-text assertion against src/router.js,
// src/stripe.js, and src/billing-upgrade.js. Booting the router is not
// required — the assertions are structural and run in <50 ms with zero
// network or filesystem fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planFromAmount } from '../src/stripe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const ROUTER_SRC  = fs.readFileSync(path.join(REPO, 'src', 'router.js'), 'utf8');
const STRIPE_SRC  = fs.readFileSync(path.join(REPO, 'src', 'stripe.js'), 'utf8');
const UPGRADE_SRC = fs.readFileSync(path.join(REPO, 'src', 'billing-upgrade.js'), 'utf8');

// ---------- PLAN_CATALOG rows --------------------------------------------

test('Wave4 #1 — PLAN_CATALOG declares an "indie" row at $29 self-serve', () => {
  assert.match(ROUTER_SRC, /indie:\s*\{[^}]*id:\s*'indie'[^}]*\}/,
    'PLAN_CATALOG.indie row is missing');
  assert.match(ROUTER_SRC, /indie:\s*\{[^}]*cents_monthly:\s*2900[^}]*\}/,
    'PLAN_CATALOG.indie must set cents_monthly: 2900');
  assert.match(ROUTER_SRC, /indie:\s*\{[^}]*price_usd_month:\s*29[^}]*\}/,
    'PLAN_CATALOG.indie must set price_usd_month: 29');
  assert.match(ROUTER_SRC, /indie:\s*\{[^}]*self_serve:\s*true[^}]*\}/,
    'PLAN_CATALOG.indie must be self_serve: true');
  assert.match(ROUTER_SRC, /indie:\s*\{[^}]*STRIPE_PAYMENT_LINK_INDIE[^}]*\}/,
    'PLAN_CATALOG.indie must wire STRIPE_PAYMENT_LINK_INDIE');
});

test('Wave4 #2 — PLAN_CATALOG declares a "business" row at $499 self-serve', () => {
  assert.match(ROUTER_SRC, /business:\s*\{[^}]*id:\s*'business'[^}]*\}/,
    'PLAN_CATALOG.business row is missing');
  assert.match(ROUTER_SRC, /business:\s*\{[^}]*cents_monthly:\s*49900[^}]*\}/,
    'PLAN_CATALOG.business must set cents_monthly: 49900');
  assert.match(ROUTER_SRC, /business:\s*\{[^}]*price_usd_month:\s*499[^}]*\}/,
    'PLAN_CATALOG.business must set price_usd_month: 499');
  assert.match(ROUTER_SRC, /business:\s*\{[^}]*self_serve:\s*true[^}]*\}/,
    'PLAN_CATALOG.business must be self_serve: true (no longer aliased to sales-led enterprise)');
  assert.match(ROUTER_SRC, /business:\s*\{[^}]*STRIPE_PAYMENT_LINK_BUSINESS[^}]*\}/,
    'PLAN_CATALOG.business must wire STRIPE_PAYMENT_LINK_BUSINESS');
});

test('Wave4 #3 — PLAN_ALIASES no longer maps business -> enterprise', () => {
  // The pre-wave4 alias forced every self-serve $499 buyer through the
  // sales-led Enterprise contact flow. With Business now a first-class
  // self-serve row, the alias MUST be gone.
  assert.doesNotMatch(ROUTER_SRC, /PLAN_ALIASES\s*=\s*\{[^}]*business\s*:\s*['"]enterprise['"][^}]*\}/,
    'PLAN_ALIASES.business must NOT be set to enterprise — that alias hides the self-serve Business row');
  assert.doesNotMatch(ROUTER_SRC, /^\s*business\s*:\s*['"]enterprise['"]/m,
    'No standalone `business: \'enterprise\'` mapping is allowed anywhere in router.js');
});

test('Wave4 #4 — enterprise stays sales-led (self_serve: false) at $1,499', () => {
  // Enterprise stays the sales-led row for regulated / BAA / SAML buyers.
  // Don't accidentally flip it to self_serve while wiring Business.
  assert.match(ROUTER_SRC, /enterprise:\s*\{[^}]*self_serve:\s*false[^}]*\}/,
    'PLAN_CATALOG.enterprise must remain self_serve: false');
  assert.match(ROUTER_SRC, /enterprise:\s*\{[^}]*price_usd_month:\s*1499[^}]*\}/,
    'PLAN_CATALOG.enterprise must set price_usd_month: 1499');
});

// ---------- AMOUNT_TO_PLAN cents → plan id --------------------------------

test('Wave4 #5 — AMOUNT_TO_PLAN maps the four wave4 canonical cents amounts', () => {
  assert.equal(planFromAmount(2900),   'indie',
    '2900 cents must resolve to indie (was: null pre-wave4)');
  assert.equal(planFromAmount(4900),   'pro',
    '4900 cents stays mapped to pro');
  assert.equal(planFromAmount(9900),   'teams',
    '9900 cents must resolve to teams (was: null pre-wave4)');
  assert.equal(planFromAmount(49900),  'business',
    '49900 cents must resolve to business (was: teams pre-wave4 — Team-at-$499 re-bucketed to Business)');
  assert.equal(planFromAmount(149900), 'enterprise',
    '149900 cents stays mapped to enterprise');
});

test('Wave4 #6 — legacy AMOUNT_TO_PLAN entries still resolve (no orphaned Payment Links)', () => {
  // Pre-wave4 deploys may still have Payment Links at 900 (legacy starter)
  // and 14900 (legacy team) and 299900 (legacy enterprise) in production.
  // Keep these mapped so an existing webhook event doesn't silently drop.
  assert.equal(planFromAmount(900),    'pro',        'legacy starter $9 still flips to pro');
  assert.equal(planFromAmount(14900),  'teams',      'legacy team $149 still flips to teams');
  assert.equal(planFromAmount(299900), 'enterprise', 'legacy enterprise $2,999 still flips to enterprise');
});

test('Wave4 #7 — planFromAmount still returns null for unknown amounts', () => {
  assert.equal(planFromAmount(0),        null);
  assert.equal(planFromAmount(1),        null);
  assert.equal(planFromAmount(12345),    null);
  assert.equal(planFromAmount(null),     null);
  assert.equal(planFromAmount('29900'),  null, 'string inputs are not coerced');
  assert.equal(planFromAmount(NaN),      null);
});

// ---------- billing-upgrade.js price-id env wiring ------------------------

test('Wave4 #8 — billing-upgrade.js wires KOLM_STRIPE_PRICE_INDIE for the Checkout API path', () => {
  // When the operator sets STRIPE_SECRET_KEY + KOLM_STRIPE_PRICE_INDIE
  // but no STRIPE_PAYMENT_LINK_INDIE, the upgrade flow should create a
  // Checkout Session on the fly. STRIPE_PRICE_ENVS.indie has to exist.
  assert.match(UPGRADE_SRC, /indie:\s*['"]KOLM_STRIPE_PRICE_INDIE['"]/,
    'STRIPE_PRICE_ENVS.indie must point at KOLM_STRIPE_PRICE_INDIE');
});

test('Wave4 #9 — billing-upgrade.js wires KOLM_STRIPE_PRICE_BUSINESS for the Checkout API path', () => {
  assert.match(UPGRADE_SRC, /business:\s*['"]KOLM_STRIPE_PRICE_BUSINESS['"]/,
    'STRIPE_PRICE_ENVS.business must point at KOLM_STRIPE_PRICE_BUSINESS');
});

// ---------- stripe.js source-comment sanity check -------------------------

test('Wave4 #10 — src/stripe.js AMOUNT_TO_PLAN source declares the four wave4 entries inline', () => {
  // Read the source verbatim so a regression that adds the mapping at
  // runtime but leaves the literal stale is caught here too.
  assert.match(STRIPE_SRC, /2900:\s*['"]indie['"]/,    'literal 2900: \'indie\' must appear in AMOUNT_TO_PLAN');
  assert.match(STRIPE_SRC, /9900:\s*['"]teams['"]/,    'literal 9900: \'teams\' must appear in AMOUNT_TO_PLAN');
  assert.match(STRIPE_SRC, /49900:\s*['"]business['"]/,'literal 49900: \'business\' must appear in AMOUNT_TO_PLAN');
  assert.match(STRIPE_SRC, /149900:\s*['"]enterprise['"]/,'literal 149900: \'enterprise\' must appear in AMOUNT_TO_PLAN');
});
