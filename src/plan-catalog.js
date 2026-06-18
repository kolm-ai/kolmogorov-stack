// W921 - canonical pricing single-source-of-truth.
//
// This is the ONE place tier pricing/quotas/credits are defined. src/router.js
// imports PLAN_CATALOG from here (served by /v1/plans + /v1/billing/tiers), and
// scripts/build-pricing.cjs renders every marketing pricing surface (homepage
// tier row, /pricing cards + comparison matrix + editorial credit row, ROI
// tier-grid labels, and the JSON-LD Offer/AggregateOffer) from the same object
// at build time. A coherence gate (scripts/pricing-coherence.cjs) fails the
// build on any drift - so the HTML can never silently disagree with the backend.
//
// Keep this file dependency-free (plain data + tiny helpers) so both the server
// and the build script can import it without pulling in the router.

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const _PLAN_CATALOG = {
  free:       { id: 'free',       label: 'Free',       price_usd_month: 0,    price_label: '$0/mo',    cents_monthly:      0, gateway_calls_hard:     50000, quota:     50000, seats: 1,  self_serve: true,  compile_credits_monthly: 1,         annual_savings_pct: 0,  billing_env: null,                            stripe_link_env: null,                            billing_url_env: null },
  indie:      { id: 'indie',      label: 'Indie',      price_usd_month: 29,   price_label: '$29/mo',   cents_monthly:   2900, gateway_calls_hard:    500000, quota:    500000, seats: 1,  self_serve: true,  compile_credits_monthly: 10,        annual_savings_pct: 17, billing_env: 'STRIPE_PAYMENT_LINK_INDIE',     stripe_link_env: 'STRIPE_PAYMENT_LINK_INDIE',     billing_url_env: 'STRIPE_PAYMENT_LINK_INDIE' },
  pro:        { id: 'pro',        label: 'Pro',        price_usd_month: 49,   price_label: '$49/mo',   cents_monthly:   4900, gateway_calls_hard:    500000, quota:    500000, seats: 1,  self_serve: true,  compile_credits_monthly: 50,        annual_savings_pct: 17, billing_env: 'STRIPE_PAYMENT_LINK_PRO',       stripe_link_env: 'STRIPE_PAYMENT_LINK_PRO',       billing_url_env: 'STRIPE_PAYMENT_LINK_PRO' },
  teams:      { id: 'teams',      label: 'Team',       price_usd_month: 99,   price_label: '$99/mo',   cents_monthly:   9900, gateway_calls_hard:   5000000, quota:   5000000, seats: 5,  self_serve: true,  compile_credits_monthly: 50,        annual_savings_pct: 17, billing_env: 'STRIPE_PAYMENT_LINK_TEAM',      stripe_link_env: 'STRIPE_PAYMENT_LINK_TEAM',      billing_url_env: 'STRIPE_PAYMENT_LINK_TEAM', stripe_link_envs: ['STRIPE_PAYMENT_LINK_TEAMS'] },
  business:   { id: 'business',   label: 'Business',   price_usd_month: 499,  price_label: '$499/mo',  cents_monthly:  49900, gateway_calls_hard:  25000000, quota:  25000000, seats: 20, self_serve: true,  compile_credits_monthly: 200,       annual_savings_pct: 17, billing_env: 'STRIPE_PAYMENT_LINK_BUSINESS', stripe_link_env: 'STRIPE_PAYMENT_LINK_BUSINESS', billing_url_env: 'STRIPE_PAYMENT_LINK_BUSINESS' },
  enterprise: { id: 'enterprise', label: 'Enterprise', price_usd_month: null, price_label: 'Custom',   cents_monthly:   null, gateway_calls_hard: 250000000, quota: 250000000, seats: 25, self_serve: false, compile_credits_monthly: 'custom', annual_savings_pct: 0,  billing_env: null,                            stripe_link_env: 'STRIPE_PAYMENT_LINK_ENT',       billing_url_env: 'STRIPE_PAYMENT_LINK_ENT' },
};

export const PLAN_CATALOG = deepFreeze(_PLAN_CATALOG);

// Wave4 stripe-fix: removed `business: 'enterprise'` alias that forced
// self-serve buyers into the sales-led path. Business is now its own row.
export const PLAN_ALIASES = Object.freeze({
  developer: 'free',
  starter: 'pro',
  team: 'teams',
  teams: 'teams',
});

// Stable display order for every rendered pricing surface.
export const PLAN_ORDER = Object.freeze(['free', 'indie', 'pro', 'teams', 'business', 'enterprise']);

export function canonicalPlanId(raw) {
  const id = String(raw || 'free').toLowerCase().replace(/[^a-z0-9_-]+/g, '').trim();
  return PLAN_CATALOG[id] ? id : (PLAN_ALIASES[id] || null);
}

// Count of self-serve, fixed-price offers (excludes Enterprise/Custom) - the
// number the homepage + /pricing JSON-LD AggregateOffer.offerCount must match.
export function fixedPriceOfferCount() {
  return PLAN_ORDER.filter((id) => {
    const p = PLAN_CATALOG[id];
    return p && p.self_serve !== false && typeof p.price_usd_month === 'number';
  }).length;
}

// Compact human credit label, e.g. '1 / 10 / 50 / 50 / 200 / custom'.
export function creditRow() {
  return PLAN_ORDER.map((id) => String(PLAN_CATALOG[id].compile_credits_monthly));
}
