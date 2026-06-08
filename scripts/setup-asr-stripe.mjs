#!/usr/bin/env node
// scripts/setup-asr-stripe.mjs
//
// Create (or reuse) the three Agent Security-Review Stripe products, prices, and
// hosted PAYMENT LINKS at the LOCKED amounts, then print the PUBLIC payment-link
// URLs to wire into the backend env:
//   STRIPE_PAYMENT_LINK_ASR_REPORT             $750 one-time
//   STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_STARTER $299 / month
//   STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_GROWTH  $999 / month
//
// Payment links mean the RUNTIME backend needs only these public URLs - the
// Stripe SECRET key never goes onto Railway. The binding (which audit / tenant)
// rides in client_reference_id, appended at checkout time by src/asr-billing.js.
//
// Idempotent: prices carry a stable lookup_key and links carry metadata.kolm_asr,
// so re-running reuses them instead of creating duplicates.
//
// Leak-safe key input: reads the Stripe secret from env (STRIPE_SECRET_KEY /
// stripe_api_key / KOLM_STRIPE_KEY) OR, if none is set, from STDIN - so a caller
// can `printf '%s' "$KEY" | node scripts/setup-asr-stripe.mjs` (printf is a shell
// builtin, so the key never appears in the process argument table). Price ids and
// payment-link URLs are NOT secret.

import fs from 'node:fs';

function loadKey() {
  const fromEnv = process.env.STRIPE_SECRET_KEY || process.env.stripe_api_key || process.env.KOLM_STRIPE_KEY || process.env.STRIPE_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try { const stdin = fs.readFileSync(0, 'utf8'); if (stdin && stdin.trim()) return stdin.trim().split(/\r?\n/)[0].trim(); } catch { /* no stdin */ }
  return null;
}
const KEY = loadKey();
if (!KEY) {
  console.error('FATAL: no Stripe secret key (set STRIPE_SECRET_KEY or pipe it via stdin).');
  process.exit(2);
}
const livemode = /^(sk|rk)_live_/.test(KEY);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || 'https://kolm.ai').replace(/\/+$/, '');

async function stripe(method, p, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const res = await fetch('https://api.stripe.com' + p, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`stripe ${method} ${p} -> ${res.status}: ${json && json.error ? json.error.message : JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const PRODUCTS = [
  { env: 'STRIPE_PAYMENT_LINK_ASR_REPORT', tag: 'report', lookup_key: 'kolm_asr_report',
    name: 'kolm Signed Readiness Report', description: 'One-time Agent Security-Review: a cryptographically signed, offline-verifiable evidence report.',
    unit_amount: 75000, recurring: null, redirect: `${PUBLIC_BASE}/dashboard?asr=report` },
  { env: 'STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_STARTER', tag: 'starter', lookup_key: 'kolm_asr_continuous_starter',
    name: 'kolm Continuous Starter', description: 'Weekly re-attestation with an always-current signed Trust link (up to ~3 agents).',
    unit_amount: 29900, recurring: 'month', redirect: `${PUBLIC_BASE}/dashboard?asr=starter` },
  { env: 'STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_GROWTH', tag: 'growth', lookup_key: 'kolm_asr_continuous_growth',
    name: 'kolm Continuous Growth', description: 'Re-attestation on every deploy plus injection regression, always-current Trust link (up to ~15 agents).',
    unit_amount: 99900, recurring: 'month', redirect: `${PUBLIC_BASE}/dashboard?asr=growth` },
  { env: 'STRIPE_PAYMENT_LINK_ASR_FULL_READINESS', tag: 'full', lookup_key: 'kolm_asr_full_readiness', kolm_product: 'asr_package',
    name: 'kolm Full Readiness', description: 'One-time Agent Security-Review across your whole agent fleet: the full evidence package, a scored red-team battery, and procurement exports for every framework.',
    unit_amount: 1500000, recurring: null, redirect: `${PUBLIC_BASE}/dashboard?asr=full` },
  { env: 'STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_PLUS', tag: 'plus', lookup_key: 'kolm_asr_continuous_plus', kolm_product: 'asr_continuous',
    name: 'kolm Continuous-Plus', description: 'Enterprise continuous re-attestation across the full control set, re-signed on every deploy with a red-team regression each release, no agent cap.',
    unit_amount: 350000, recurring: 'month', redirect: `${PUBLIC_BASE}/dashboard?asr=plus` },
];

async function ensurePrice(spec) {
  const found = await stripe('GET', `/v1/prices?active=true&lookup_keys[]=${encodeURIComponent(spec.lookup_key)}&limit=1`);
  if (found.data && found.data[0]) {
    if (found.data[0].unit_amount !== spec.unit_amount) console.error(`WARN ${spec.lookup_key}: existing price ${found.data[0].id} is ${found.data[0].unit_amount}, expected ${spec.unit_amount}. Reusing.`);
    return found.data[0].id;
  }
  // kolm_product defaults from the cadence (one-time -> asr_report, recurring ->
  // asr_continuous) but a spec can override it: Full Readiness is a one-time
  // charge that fulfills as a PACKAGE (asr_package), not a per-audit report.
  const kolmProduct = spec.kolm_product || (spec.recurring ? 'asr_continuous' : 'asr_report');
  const product = await stripe('POST', '/v1/products', {
    name: spec.name, description: spec.description,
    'metadata[kolm_product]': kolmProduct,
    'metadata[product_key]': spec.tag,
  });
  const priceParams = {
    product: product.id, unit_amount: String(spec.unit_amount), currency: 'usd',
    lookup_key: spec.lookup_key, transfer_lookup_key: 'true',
    'metadata[kolm_product]': kolmProduct, 'metadata[product_key]': spec.tag,
  };
  if (spec.recurring) priceParams['recurring[interval]'] = spec.recurring;
  const price = await stripe('POST', '/v1/prices', priceParams);
  return price.id;
}

async function ensureLink(spec, priceId) {
  // Reuse an existing active link tagged for this product.
  const list = await stripe('GET', '/v1/payment_links?active=true&limit=100');
  const existing = (list.data || []).find((l) => l && l.metadata && l.metadata.kolm_asr === spec.tag);
  if (existing) return existing.url;
  const params = {
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[kolm_asr]': spec.tag,
    'after_completion[type]': 'redirect',
    'after_completion[redirect][url]': spec.redirect,
  };
  const link = await stripe('POST', '/v1/payment_links', params);
  return link.url;
}

(async () => {
  console.log(`[setup-asr-stripe] mode=${livemode ? 'LIVE' : 'TEST'}`);
  const out = [];
  for (const spec of PRODUCTS) {
    const priceId = await ensurePrice(spec);
    const url = await ensureLink(spec, priceId);
    console.log(`  ${spec.tag}: price=${priceId} link=${url}`);
    out.push({ env: spec.env, url });
  }
  console.log('\n--- ENV (public payment-link URLs; set these on Railway) ---');
  for (const r of out) console.log(`${r.env}=${r.url}`);
  console.log('--- END ENV ---');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
