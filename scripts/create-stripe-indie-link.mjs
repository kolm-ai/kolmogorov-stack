#!/usr/bin/env node
// W921 — create the missing Indie ($29/mo) Stripe payment link and tell you how
// to wire it into Vercel. This closes the lone billing-tiers red: production has
// links for pro/teams/business but not indie, so the Indie tier can't be bought.
//
// SECURITY: this reads STRIPE_SECRET_KEY from YOUR environment. The key is never
// printed, written to a file, or committed. Run it where that env var is set
// (the Stripe key lives in the `proofmarket` Vercel project):
//
//   vercel link            # link this dir to the proofmarket project, OR set the var inline:
//   STRIPE_SECRET_KEY=sk_live_... node scripts/create-stripe-indie-link.mjs
//
//   # dry run (no Stripe calls, just shows what it WOULD create):
//   node scripts/create-stripe-indie-link.mjs --dry-run
//
// It is idempotent-ish: pass --reuse-price <price_id> to skip price creation.

const DRY = process.argv.includes('--dry-run');
const reuseIdx = process.argv.indexOf('--reuse-price');
const REUSE_PRICE = reuseIdx >= 0 ? process.argv[reuseIdx + 1] : null;

const PLAN = { id: 'indie', label: 'Indie', amount_cents: 2900, currency: 'usd', interval: 'month' };

const key = process.env.STRIPE_SECRET_KEY;
if (!DRY && !key) {
  console.error('STRIPE_SECRET_KEY is not set in this environment.');
  console.error('It lives in your Vercel `proofmarket` project (Sensitive). Set it inline for this one command:');
  console.error('  STRIPE_SECRET_KEY=sk_live_... node scripts/create-stripe-indie-link.mjs');
  process.exit(2);
}
if (key && !DRY) {
  const mode = key.startsWith('sk_live') ? 'LIVE' : key.startsWith('sk_test') ? 'TEST' : 'UNKNOWN';
  console.error(`Using a ${mode} Stripe key (…${key.slice(-4)}). This will create a REAL ${mode} price + payment link for ${PLAN.label} $${PLAN.amount_cents / 100}/${PLAN.interval}.`);
}

// Stripe wants application/x-www-form-urlencoded with bracketed nested keys.
function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) p.append(k, String(v));
  return p.toString();
}
async function stripe(path, body) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} -> ${res.status}: ${json.error ? json.error.message : JSON.stringify(json)}`);
  return json;
}

(async () => {
  if (DRY) {
    console.log('[dry-run] would create Price:', { 'product_data[name]': `kolm ${PLAN.label}`, unit_amount: PLAN.amount_cents, currency: PLAN.currency, 'recurring[interval]': PLAN.interval });
    console.log('[dry-run] would create Payment Link from that price (quantity 1)');
    console.log('[dry-run] then: vercel env add STRIPE_PAYMENT_LINK_INDIE production  (paste the link URL)');
    return;
  }

  let priceId = REUSE_PRICE;
  if (!priceId) {
    const price = await stripe('prices', {
      'product_data[name]': `kolm ${PLAN.label}`,
      unit_amount: PLAN.amount_cents,
      currency: PLAN.currency,
      'recurring[interval]': PLAN.interval,
    });
    priceId = price.id;
    console.log('Created price:', priceId);
  }

  const link = await stripe('payment_links', {
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    'after_completion[type]': 'redirect',
    'after_completion[redirect][url]': 'https://kolm.ai/account/overview?welcome=indie',
  });

  console.log('\n✅ Indie payment link created:\n   ' + link.url + '\n');
  console.log('Wire it into the kolm project (NOT proofmarket) so billing-tiers goes green:');
  console.log('   vercel link    # choose the kolm project');
  console.log('   printf "%s" "' + link.url + '" | vercel env add STRIPE_PAYMENT_LINK_INDIE production');
  console.log('   vercel --prod  # or trigger a redeploy so the new env var is picked up');
  console.log('\nThen verify:  node cli/kolm.js billing tiers --json   # stripe.ready should flip to true');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
