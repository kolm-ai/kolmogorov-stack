// W889-6.1 — Pricing overhaul + Enterprise = "Contact Sales".
//
// 10 lock-in invariants. All assertions are file-content checks against the
// repo; no server boot needed. Run with:
//
//   node --test --test-concurrency=1 tests/wave889-6-pricing-overhaul.test.js
//
//   #1  public/pricing.html contains "Contact Sales" (case-insensitive)
//       under the Enterprise card scope.
//   #2  public/pricing.html does NOT advertise the old hardcoded Enterprise
//       price "$1,499" anywhere visible (Stripe legacy comments are allowed
//       in stripe-audit only — guarded by the pricing.html file scope).
//   #3  public/pricing.html ships the existing Monthly / Annual toggle
//       (#bill-monthly + #bill-annual). Annual = -17% per W889-6.1.
//   #4  public/pricing.html carries compile-credits microcopy on at least
//       3 tier cards. Greppable via data-w889="compile-credits".
//   #5  public/book-demo.html exists, contains a <form> element, and posts
//       to /v1/sales/demo-request.
//   #6  src/router.js declares POST /v1/sales/demo-request and the route is
//       wired through the dedicated demoRequestLimiter.
//   #7  demoRequestLimiter is configured at 10 hits per IP per 24h (60*60*24
//       seconds * 1000 ms; 'max' value 10).
//   #8  PLAN_CATALOG in src/router.js carries compile_credits_monthly on
//       every tier (>= 5 occurrences across the catalog object). serializer
//       also exposes the field.
//   #9  Across public/**/*.html, no page advertises the old "$1,499" /
//       "$1499" Enterprise SKU. Stripe audit notes under
//       public/billing/stripe-audit-*.md are allowlisted.
//   #10 public/sw.js carries the W889 cache slug ("wave889" or
//       "pricing-overhaul") and CACHE_VERSION has been bumped past 111.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRICING_HTML  = readFile('public/pricing.html');
const BOOK_DEMO     = readFile('public/book-demo.html');
const ROUTER_JS     = readFile('src/router.js');
const SW_JS         = readFile('public/sw.js');

function walkHtml(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, ent.name).replace(/\\/g, '/');
    if (ent.isDirectory()) walkHtml(rel, out);
    else if (ent.isFile() && ent.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

test('#1 pricing.html declares Contact Sales for Enterprise', () => {
  // Slice the Enterprise tier card by anchor id.
  const idx = PRICING_HTML.indexOf('id="tier-enterprise"');
  assert.ok(idx > 0, 'tier-enterprise anchor must exist');
  const segment = PRICING_HTML.slice(idx, idx + 4000);
  assert.match(segment, /contact[\s-]*sales/i, 'enterprise card should announce Contact Sales');
});

test('#2 pricing.html does not advertise $1,499 for Enterprise', () => {
  // Allow occurrence inside the Wave4 stripe-fix comment (talks about W889
  // SKU removal); but ban any visible price="$1,499" / $1499 attribute or
  // textual price string in the Enterprise card region.
  const idx = PRICING_HTML.indexOf('id="tier-enterprise"');
  const segment = PRICING_HTML.slice(idx, idx + 4000);
  assert.doesNotMatch(segment, /\$\s*1,?499/, 'enterprise card must not show $1,499 anywhere');
});

test('#3 pricing.html ships Monthly / Annual toggle (-17%)', () => {
  assert.match(PRICING_HTML, /id=["']bill-monthly["']/, 'monthly toggle button id');
  assert.match(PRICING_HTML, /id=["']bill-annual["']/,  'annual toggle button id');
  assert.match(PRICING_HTML, /17\s*%/, 'annual savings -17% advertised');
});

test('#4 pricing.html has compile-credits microcopy on >=3 tier cards', () => {
  const matches = PRICING_HTML.match(/data-w889=["']compile-credits["']/g) || [];
  assert.ok(matches.length >= 3, `expected >=3 data-w889="compile-credits" markers, got ${matches.length}`);
});

test('#5 book-demo.html exists, has a <form>, and posts to /v1/sales/demo-request', () => {
  assert.match(BOOK_DEMO, /<form\b/i, 'book-demo.html must contain a <form>');
  assert.match(BOOK_DEMO, /\/v1\/sales\/demo-request/, 'must post to /v1/sales/demo-request');
});

test('#6 router.js declares POST /v1/sales/demo-request via demoRequestLimiter', () => {
  // The route handler line itself.
  assert.match(
    ROUTER_JS,
    /r\.post\(['"]\/v1\/sales\/demo-request['"]\s*,\s*demoRequestLimiter\b/,
    'route must be wired with demoRequestLimiter'
  );
});

test('#7 demoRequestLimiter is configured at 10/IP/24h', () => {
  const idx = ROUTER_JS.indexOf('const demoRequestLimiter');
  assert.ok(idx > 0, 'demoRequestLimiter constant must exist');
  const block = ROUTER_JS.slice(idx, idx + 1200);
  // 24h = 60*60*24*1000 = 86_400_000 ms. Accept either the arithmetic or the
  // literal so the limiter can be reformatted without breaking the lock-in.
  const has24hWindow =
    /windowMs\s*:\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*1000/.test(block) ||
    /windowMs\s*:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(block) ||
    /windowMs\s*:\s*86_?400_?000/.test(block);
  assert.ok(has24hWindow, 'demoRequestLimiter windowMs must be 24h');
  assert.match(block, /max\s*:\s*10\b/, 'demoRequestLimiter max must be 10');
});

test('#8 PLAN_CATALOG in router.js carries compile_credits_monthly (>=5 hits)', () => {
  const matches = ROUTER_JS.match(/compile_credits_monthly/g) || [];
  assert.ok(matches.length >= 5, `expected >=5 compile_credits_monthly hits in router.js, got ${matches.length}`);
});

test('#9 no public/*.html page advertises the old $1,499 Enterprise SKU', () => {
  const offenders = [];
  const files = walkHtml('public');
  for (const rel of files) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    if (/\$\s*1,?499/.test(src)) offenders.push(rel);
  }
  // Allowlist: stripe audit markdown does not match because we only walk
  // .html. The pricing.html legacy stripe comment was rewritten by W889-6.1.
  assert.deepEqual(offenders, [], 'these pages still advertise $1,499:\n  ' + offenders.join('\n  '));
});

test('#10 sw.js carries W889 cache slug and CACHE_VERSION advanced past 111', () => {
  assert.match(SW_JS, /wave889|pricing-overhaul/i, 'sw.js CACHE slug must mention wave889 or pricing-overhaul');
  const m = SW_JS.match(/const\s+CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(m, 'CACHE_VERSION constant must exist');
  const v = Number(m[1]);
  assert.ok(v >= 112, `CACHE_VERSION ${v} must be advanced past 111 for W889-6.1 invalidation`);
});
