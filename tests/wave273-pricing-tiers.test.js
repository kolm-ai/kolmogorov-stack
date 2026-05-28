// W273 - pricing tiers restructure.
//
// Historical pricing lock-ins, now aligned to the current four-plan model.
// public/pricing.html keeps legacy starter/business data-tier aliases for
// backwards compatibility, but the buyer-facing model is:
//   Free Local / Pro $49 / Team $499 / Enterprise Custom
// and adds:
//   - a usage-based credits row (post-cap pricing)
//   - a client-side ROI calculator widget
//   - a "currently doing $X/mo on OpenAI" comparison strip
//
// Tests assert behavior, not byte-exact copy:
//   - five tier cards exist, each with data-tier="<slug>"
//   - ROI calculator script attached (window-scoped fn or inline IIFE)
//   - usage-based credits row present
//   - existing data-w260 markers still present (W260 #9, #11 regression lock)
//   - canonical link intact
//   - sw.js cache wave-floor >= 273

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const PRICING = fs.readFileSync(path.join(PUBLIC, 'pricing.html'), 'utf8');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

// =====================================================================
// Tier cards: all five present with data-tier markers
// =====================================================================

test('W273 #1 - tier card data-tier="free" exists', () => {
  assert.match(PRICING, /data-tier="free"/,
    'pricing.html must contain a tier card with data-tier="free"');
});

test('W273 #2 - tier card data-tier="starter" exists', () => {
  assert.match(PRICING, /data-tier="starter"/,
    'pricing.html must contain a tier card with data-tier="starter"');
});

test('W273 #3 - tier card data-tier="team" exists', () => {
  assert.match(PRICING, /data-tier="team"/,
    'pricing.html must contain a tier card with data-tier="team"');
});

test('W273 #4 - tier card data-tier="business" exists', () => {
  assert.match(PRICING, /data-tier="business"/,
    'pricing.html must contain a tier card with data-tier="business"');
});

test('W273 #5 - tier card data-tier="enterprise" exists', () => {
  assert.match(PRICING, /data-tier="enterprise"/,
    'pricing.html must contain a tier card with data-tier="enterprise"');
});

test('W273 #6 - all 5 data-tier markers present in expected order (Free, Starter, Team, Business, Enterprise)', () => {
  // Behavior: the primary grid must order the five tiers cheapest-to-priciest.
  // We index-of each marker and assert strict monotonic ordering.
  const order = ['free', 'starter', 'team', 'business', 'enterprise'];
  const positions = order.map((slug) =>
    PRICING.indexOf(`data-tier="${slug}"`)
  );
  for (let i = 0; i < positions.length; i++) {
    assert.ok(positions[i] > 0, `data-tier="${order[i]}" must appear in pricing.html`);
  }
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      `data-tier="${order[i]}" must appear after data-tier="${order[i - 1]}"`);
  }
});

// =====================================================================
// Tier specifics: enforce the per-tier inputs from the W273 brief.
// =====================================================================

test('W273 #7 - Free tier names 100 compiles / 1k captures / 1 GB / community support', () => {
  const m = PRICING.match(/data-tier="free"[\s\S]{0,2000}/);
  assert.ok(m, 'free tier block must be findable');
  const block = m[0];
  assert.match(block, /\b100\b/, 'Free tier must name 100 compiles');
  assert.match(block, /\b1k\b/i, 'Free tier must name 1k captures');
  assert.match(block, /1\s*GB/i, 'Free tier must name 1 GB storage');
  assert.match(block, /community/i, 'Free tier must name community support');
});

test('W273 #8 - legacy Starter alias maps to Pro $49 with email support', () => {
  // W889/W891 (commit cc9f6ea7): the pricing model deliberately migrated from
  // "unlimited compiles" to a published metered compile-credit allotment
  // (data-w889="compile-credits"). The Pro/Starter slot now names "50 compile
  // credits" instead of "unlimited compiles" — assert the current metered model.
  const m = PRICING.match(/data-tier="starter"[\s\S]{0,2000}/);
  assert.ok(m, 'starter tier block must be findable');
  const block = m[0];
  assert.match(block, /maps to Pro/i, 'Starter alias must explicitly map to Pro');
  assert.match(block, /\$49\b/, 'Pro alias must name $49');
  assert.match(block, /\d+\s*compile credits/i, 'Pro alias must name its compile-credit allotment (W889 metered model)');
  assert.match(block, /10\s*GB/i, 'Starter tier must name 10 GB storage');
  assert.match(block, /priority K-score/i, 'Pro alias must name priority K-score');
  assert.match(block, /email/i, 'Starter tier must name email support');
});

test('W273 #9 - Team tier names $99, five seats, registry, approvals, audit log, and CI/CD', () => {
  // V1-launch (2026-05-26): Team re-priced from $499 to $99 to make the
  // 5-seat collaboration tier accessible. The $499 slot is now Business.
  const m = PRICING.match(/data-tier="team"[\s\S]{0,2500}/);
  assert.ok(m, 'team tier block must be findable');
  const block = m[0];
  assert.match(block, /\$99\b/, 'Team tier must name $99 (V1-launch ladder)');
  assert.match(block, /five-seat|\b5\b[\s\S]{0,80}seats?/i, 'Team tier must name five seats');
  assert.match(block, /private registry/i, 'Team tier must name private registry');
  assert.match(block, /approvals/i, 'Team tier must name approvals');
  assert.match(block, /audit log/i, 'Team tier must name audit log');
  assert.match(block, /CI\/CD/i, 'Team tier must name CI/CD');
});

test('W273 #10 - Business is a first-class self-serve $499 tier (V1-launch)', () => {
  // V1-launch (2026-05-26): Business was promoted from a legacy "alias for
  // Enterprise custom" to a first-class self-serve tier at $499/mo. It sits
  // between Team ($99, 5 seats) and Enterprise ($1,499 sales-led, BAA + SAML).
  // The slot is for scaled product teams past 5 seats but not yet in a
  // procurement-led process.
  const m = PRICING.match(/data-tier="business"[\s\S]{0,2500}/);
  assert.ok(m, 'business tier block must be findable');
  const block = m[0];
  assert.match(block, /\$499\b/, 'Business tier must name $499 (V1-launch self-serve)');
  assert.match(block, /25\s*million|25M/i, 'Business tier must name 25 million gateway calls');
  assert.match(block, /20\s*seats/i, 'Business tier must name 20 seats');
  assert.match(block, /private (artifact )?registry/i, 'Business tier must name private registry');
  assert.match(block, /SSO|sso/, 'Business tier must name SSO');
  assert.match(block, /audit/i, 'Business tier must name audit (log/exports)');
});

test('W273 #11 - Enterprise tier names $1,499 sales-led, BYOC/air-gap/self-hosted, BAA, dedicated CSM (V1-launch)', () => {
  // V1-launch (2026-05-26): Enterprise floor raised from "custom" to a
  // published sales-led $1,499/mo starting price for procurement clarity. The
  // hidden contract span (data-w273="enterprise-contract") still uses the word
  // "custom" alongside the $1,499 floor for legacy SEO + procurement search.
  const m = PRICING.match(/data-tier="enterprise"[\s\S]{0,2500}/);
  assert.ok(m, 'enterprise tier block must be findable');
  const block = m[0];
  assert.match(block, /\$1,499|sales-led/i,
    'Enterprise tier must name $1,499 sales-led floor (V1-launch)');
  assert.match(block, /on-prem|air-gap|self-hosted|BYOC/i,
    'Enterprise tier must name on-prem / air-gap / self-hosted / BYOC');
  assert.match(block, /BAA/, 'Enterprise tier must name BAA');
  assert.match(block, /CSM|white[- ]glove|named SRE/i,
    'Enterprise tier must name CSM / named SRE / white-glove');
});

// =====================================================================
// ROI calculator + OpenAI-vs strip + usage credits
// =====================================================================

test('W273 #12 - ROI calculator widget is present (data-w273="roi-calculator")', () => {
  assert.match(PRICING, /data-w273="roi-calculator"/,
    'pricing.html must contain a div marked data-w273="roi-calculator"');
});

test('W273 #13 - ROI calculator script attached (window.kolmROI OR inline IIFE)', () => {
  // The calculator must wire its inputs. Accept either a window-scoped
  // function (window.kolmROI = ...) or an inline IIFE (function(){...})()
  // referencing the W273 input ids.
  const roiBlock = PRICING.match(/data-w273="roi-calculator"[\s\S]{0,12000}/);
  assert.ok(roiBlock, 'roi-calculator block must be findable');
  const block = roiBlock[0];
  const exposesWindow = /window\.kolmROI\s*=/.test(block);
  const hasIife = /\(function\s*\(\s*\)\s*\{[\s\S]*?\}\)\s*\(\s*\)/.test(block);
  assert.ok(exposesWindow || hasIife,
    'ROI calculator must expose window.kolmROI OR be wrapped in an inline IIFE');
  // And it must reference at least one of the W273 input ids so we know
  // it actually wires to the inputs above.
  assert.match(block, /w273-compiles|w273-perprompt|w273-prompts|w273-churn/,
    'ROI calculator script must reference at least one w273-* input id');
});

test('W273 #14 - ROI calculator inputs cover compiles/mo, cost/prompt, churn savings', () => {
  // The W273 brief requires three input axes minimum.
  assert.match(PRICING, /id=["']w273-compiles["']/i, 'ROI must have a compiles/mo input');
  assert.match(PRICING, /id=["']w273-perprompt["']/i, 'ROI must have an avg cost/prompt input');
  assert.match(PRICING, /id=["']w273-churn["']/i, 'ROI must have a churn savings input');
});

test('W273 #15 - ROI calculator outputs cover monthly savings and payback months', () => {
  assert.match(PRICING, /id=["']w273-savings["']/i, 'ROI must surface a monthly savings output node');
  assert.match(PRICING, /id=["']w273-payback["']/i, 'ROI must surface a payback months output node');
});

test('W273 #16 - "currently doing $X/mo on OpenAI" comparison strip exists', () => {
  assert.match(PRICING, /data-w273="openai-vs"/,
    'pricing.html must contain a data-w273="openai-vs" comparison strip');
  // And the strip must literally name OpenAI in the surfaced copy.
  const m = PRICING.match(/data-w273="openai-vs"[\s\S]{0,2000}/);
  assert.ok(m, 'openai-vs block must be findable');
  assert.match(m[0], /OpenAI/, 'openai-vs strip must name OpenAI');
});

test('W273 #17 - usage-based credits row present with $0.001/compile and $0.0001/capture', () => {
  assert.match(PRICING, /data-w273="usage-credits"/,
    'pricing.html must contain a data-w273="usage-credits" row');
  const m = PRICING.match(/data-w273="usage-credits"[\s\S]{0,2000}/);
  assert.ok(m, 'usage-credits block must be findable');
  const block = m[0];
  assert.match(block, /\$0\.001\b/, 'usage-credits row must name $0.001 / compile');
  assert.match(block, /\$0\.0001\b/, 'usage-credits row must name $0.0001 / capture');
});

// =====================================================================
// Preservation: existing W260 markers + JSON-LD + canonical
// =====================================================================

test('W273 #18 - W260 marker data-w260="three-tier" still present (no regression)', () => {
  assert.match(PRICING, /data-w260="three-tier"/,
    'W260 three-tier marker must remain after W273 restructure');
});

test('W273 #19 - W260 marker data-w260="enterprise-baa" still present (no regression)', () => {
  assert.match(PRICING, /data-w260="enterprise-baa"/,
    'W260 enterprise-baa marker must remain after W273 restructure');
});

test('W273 #20 - canonical link intact', () => {
  assert.match(PRICING, /<link\s+rel=["']canonical["']\s+href=["']https:\/\/kolm\.ai\/pricing["']\s*\/?>/i,
    'canonical link to https://kolm.ai/pricing must remain');
});

test('W273 #21 - JSON-LD Product block preserved (Offers array intact)', () => {
  // Behavior: the application/ld+json Product schema must still exist with
  // at least one Offer object. We do not pin the exact Offer set so the
  // schema can be updated separately; we just enforce existence.
  assert.match(PRICING, /<script\s+type=["']application\/ld\+json["']/i,
    'JSON-LD <script> block must remain');
  assert.match(PRICING, /"@type"\s*:\s*"Product"/,
    'Product schema must remain');
  assert.match(PRICING, /"offers"\s*:\s*\[/,
    'offers array must remain in JSON-LD');
});

test('W273 #22 - JSON-LD FAQPage block preserved', () => {
  assert.match(PRICING, /"@type"\s*:\s*"FAQPage"/,
    'FAQPage schema must remain in JSON-LD');
});

test('W273 #23 - JSON-LD BreadcrumbList block preserved', () => {
  assert.match(PRICING, /"@type"\s*:\s*"BreadcrumbList"/,
    'BreadcrumbList schema must remain in JSON-LD');
});

test('W273 #24 - brand-anchor span deliberately stripped (W903 override of W273 brief)', () => {
  // W903 (commit 966457dd, scripts/w903-strip-brand-anchor.cjs): the hidden
  // "Not Kolm therapeutics" brand-anchor SEO disambiguation span was removed
  // from every public/**/*.html page under explicit user mandate
  // ("served its purpose but looks unprofessional now. Remove entirely").
  // This supersedes the earlier W273 "do-not-strip" instruction, so lock in
  // the deliberate removal instead of the stale preservation pin.
  assert.doesNotMatch(PRICING, /class=["']brand-anchor["']/,
    'brand-anchor span must be absent (deliberately stripped in W903)');
});

// =====================================================================
// sw.js cache slug wave-floor
// =====================================================================

test('W273 #25 - sw.js CACHE slug wave-floor >= 273', () => {
  // Regex+threshold convention (W604/W829 family-lock): the slug moves forward
  // every wave, so never pin a literal suffix. The slug format also migrated
  // past the old "frontend-vN" segment (dropped ~W144/W910) and now references
  // waves as wNNN (e.g. w917). Extract the wave token from the ACTIVE
  // const CACHE = '...' declaration (not history comments) allowing both
  // "wave" and "w" prefixes, and assert the floor.
  const cacheDecl = SW.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(cacheDecl, 'sw.js must declare const CACHE = "..."');
  const slug = cacheDecl[1];
  const waveMatch = slug.match(/w(?:ave)?(\d{3,4})/);
  assert.ok(waveMatch, `CACHE slug "${slug}" must include a wave token like wNNN/waveNNN`);
  const waveN = parseInt(waveMatch[1], 10);
  assert.ok(waveN >= 273, `sw.js CACHE slug wave token must be >= 273 (saw ${waveN} in "${slug}")`);
});

// =====================================================================
// Em-dash budget: must not increase em-dash count
// =====================================================================

test('W273 #26 - em-dash budget on pricing.html <= 7 (W205 / W260 lock preserved)', () => {
  const raw = (PRICING.match(/—/g) || []).length;
  const ent = (PRICING.match(/&mdash;/g) || []).length;
  const total = raw + ent;
  assert.ok(total <= 7,
    `pricing.html em-dash count ${total} > W205 / W260 budget 7`);
});
