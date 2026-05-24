// W737 — Artifact Marketplace Expansion tests.
//
// Atomic items pinned (matches the W737 implementation):
//
//   1) MARKETPLACE_VERSION exported and pinned to 'w737-v1'
//   2) searchArtifacts returns honest empty envelope on no listings (not 500)
//   3) searchArtifacts filters by vertical
//   4) searchArtifacts filters by min_kscore
//   5) searchArtifacts faceted counts match results
//   6) submitReview persists via event store + getReviews reads it back
//   7) computeRoyalty 70/30 split math: $100 → publisher=$70, platform=$30
//   8) registerArtifact persists + listArtifactsForBrowse reads back
//   9) GET /v1/marketplace/search returns 200 with honest envelope
//  10) POST /v1/marketplace/reviews requires auth (401 without bearer)
//  11) public/marketplace.html exists with brand-lock + faceted filters
//  12) public/docs/marketplace/publish.html exists with revenue split section
//  13) vercel.json has /marketplace and /docs/marketplace/publish rewrites
//  14) CLI cmdW737Marketplace dispatcher present + wired via case 'marketplace'
//  15) Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)
//
// W604 anti-brittleness: no explicit-array family checks. Assertions key on
// load-bearing tokens (version stamp, envelope codes, file existence, regex
// on cli/kolm.js + router.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const MARKETPLACE_HTML = path.join(REPO_ROOT, 'public', 'marketplace.html');
const PUBLISH_DOC      = path.join(REPO_ROOT, 'public', 'docs', 'marketplace', 'publish.html');
const VERCEL_JSON      = path.join(REPO_ROOT, 'vercel.json');
const CLI_PATH         = path.join(REPO_ROOT, 'cli', 'kolm.js');
const ROUTER_PATH      = path.join(REPO_ROOT, 'src', 'router.js');
const TESTS_DIR        = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w737-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Distinct event-store path per test so per-file isolation holds even
  // when concurrency=1 runs leak rows between files.
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_w737_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

async function resetStores() {
  const eventStore = await import('../src/event-store.js');
  const mpStore = await import('../src/marketplace-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (mpStore._resetForTests) mpStore._resetForTests();
}

// =============================================================================
// 1) Version stamp
// =============================================================================

test('W737 #1 — MARKETPLACE_VERSION is "w737-v1"', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  assert.equal(mod.MARKETPLACE_VERSION, 'w737-v1',
    `expected version 'w737-v1'; got ${JSON.stringify(mod.MARKETPLACE_VERSION)}`);
  // The hard-coded 70/30 split constants are part of the contract — assert them.
  assert.equal(mod.W737_PUBLISHER_SHARE, 0.70,
    `publisher share must be 0.70 (hard-coded); got ${mod.W737_PUBLISHER_SHARE}`);
  assert.equal(mod.W737_PLATFORM_SHARE, 0.30,
    `platform share must be 0.30 (hard-coded); got ${mod.W737_PLATFORM_SHARE}`);
});

// =============================================================================
// 2) Honest empty envelope on no listings (not 500)
// =============================================================================

test('W737 #2 — searchArtifacts returns honest empty envelope when no listings', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  const out = await mod.searchArtifacts({});
  // The module returns ok:true + empty results (the ROUTE wraps to ok:false
  // marketplace_empty). We assert the module surface here.
  assert.equal(out.ok, true, 'module surface returns ok:true even when empty');
  assert.ok(Array.isArray(out.results) && out.results.length === 0,
    `results must be empty array when no listings; got ${JSON.stringify(out.results)}`);
  assert.equal(out.total, 0, 'total must be 0 when empty');
  assert.ok(out.facets && typeof out.facets === 'object',
    `facets must be an object even when empty; got ${JSON.stringify(out.facets)}`);
});

// =============================================================================
// 3) searchArtifacts filters by vertical
// =============================================================================

test('W737 #3 — searchArtifacts filters by vertical', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  await mod.registerArtifact({
    cid: 'w737-cid-medical-1', publisher_id: 'tenant_w737_3',
    vertical: 'medical', task_type: 'extraction', hardware_target: 'm-series',
    manifest: { name: 'PHI Redactor', k_score: 0.92 },
  });
  await mod.registerArtifact({
    cid: 'w737-cid-legal-1', publisher_id: 'tenant_w737_3',
    vertical: 'legal', task_type: 'extraction', hardware_target: 'rtx',
    manifest: { name: 'Clause Extractor', k_score: 0.88 },
  });
  const all = await mod.searchArtifacts({});
  assert.equal(all.total, 2, `expected 2 listings total; got ${all.total}`);
  const medical = await mod.searchArtifacts({ vertical: 'medical' });
  assert.equal(medical.total, 1, `medical filter must return 1; got ${medical.total}`);
  assert.equal(medical.results[0].vertical, 'medical',
    `result vertical must match; got ${medical.results[0].vertical}`);
  const legal = await mod.searchArtifacts({ vertical: 'legal' });
  assert.equal(legal.total, 1, `legal filter must return 1; got ${legal.total}`);
  assert.equal(legal.results[0].vertical, 'legal');
});

// =============================================================================
// 4) searchArtifacts filters by min_kscore
// =============================================================================

test('W737 #4 — searchArtifacts filters by min_kscore', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  await mod.registerArtifact({
    cid: 'w737-cid-hi', publisher_id: 'tenant_w737_4',
    vertical: 'code', task_type: 'generation', hardware_target: 'h100',
    manifest: { k_score: 0.95 },
  });
  await mod.registerArtifact({
    cid: 'w737-cid-mid', publisher_id: 'tenant_w737_4',
    vertical: 'code', task_type: 'generation', hardware_target: 'h100',
    manifest: { k_score: 0.70 },
  });
  await mod.registerArtifact({
    cid: 'w737-cid-low', publisher_id: 'tenant_w737_4',
    vertical: 'code', task_type: 'generation', hardware_target: 'h100',
    manifest: { k_score: 0.40 },
  });
  const hi = await mod.searchArtifacts({ min_kscore: 0.90 });
  assert.equal(hi.total, 1, `expected 1 listing with k_score >=0.90; got ${hi.total}`);
  const mid = await mod.searchArtifacts({ min_kscore: 0.50 });
  assert.equal(mid.total, 2, `expected 2 listings with k_score >=0.50; got ${mid.total}`);
  const lo = await mod.searchArtifacts({ min_kscore: 0.0 });
  assert.equal(lo.total, 3, `expected 3 listings with k_score >=0.0; got ${lo.total}`);
});

// =============================================================================
// 5) Faceted counts match results
// =============================================================================

test('W737 #5 — searchArtifacts faceted counts match results', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  await mod.registerArtifact({
    cid: 'w737-fc-1', publisher_id: 'tenant_w737_5',
    vertical: 'medical', task_type: 'extraction', hardware_target: 'm-series',
    manifest: { k_score: 0.9 },
  });
  await mod.registerArtifact({
    cid: 'w737-fc-2', publisher_id: 'tenant_w737_5',
    vertical: 'medical', task_type: 'reasoning', hardware_target: 'rtx',
    manifest: { k_score: 0.8 },
  });
  await mod.registerArtifact({
    cid: 'w737-fc-3', publisher_id: 'tenant_w737_5',
    vertical: 'legal', task_type: 'extraction', hardware_target: 'rtx',
    manifest: { k_score: 0.85 },
  });
  const all = await mod.searchArtifacts({});
  assert.equal(all.facets.verticals.medical, 2,
    `medical count must be 2; got ${all.facets.verticals.medical}`);
  assert.equal(all.facets.verticals.legal, 1,
    `legal count must be 1; got ${all.facets.verticals.legal}`);
  assert.equal(all.facets.tasks.extraction, 2,
    `extraction count must be 2; got ${all.facets.tasks.extraction}`);
  assert.equal(all.facets.hardware.rtx, 2,
    `rtx count must be 2; got ${all.facets.hardware.rtx}`);
});

// =============================================================================
// 6) submitReview persists + getReviews reads back
// =============================================================================

test('W737 #6 — submitReview persists via event store and getReviews reads it back', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  const cid = 'w737-review-cid-' + Math.random().toString(36).slice(2, 8);
  const r1 = await mod.submitReview({
    artifact_cid: cid,
    tenant_id: 'tenant_w737_6_a',
    rating: 5,
    text: 'Works great on contract addenda.',
  });
  assert.equal(r1.artifact_cid, cid);
  assert.equal(r1.rating, 5);
  assert.equal(r1.tenant_id, 'tenant_w737_6_a');
  await mod.submitReview({
    artifact_cid: cid,
    tenant_id: 'tenant_w737_6_b',
    rating: 3,
    text: 'OK but missed two edge cases.',
  });
  const reviews = await mod.getReviews(cid);
  assert.equal(reviews.ratings_count, 2,
    `expected 2 reviews; got ${reviews.ratings_count}`);
  assert.equal(reviews.ratings_avg, 4,
    `expected avg=4.0 ((5+3)/2); got ${reviews.ratings_avg}`);
  assert.ok(Array.isArray(reviews.reviews) && reviews.reviews.length === 2,
    `reviews array must carry 2 entries; got ${reviews.reviews && reviews.reviews.length}`);
  // Validation — rating must be in [1,5] integer.
  await assert.rejects(
    () => mod.submitReview({ artifact_cid: cid, tenant_id: 't', rating: 6, text: 'x' }),
    /REVIEW_INVALID|integer in \[1,5\]/,
    'rating > 5 must throw REVIEW_INVALID',
  );
  await assert.rejects(
    () => mod.submitReview({ artifact_cid: cid, tenant_id: 't', rating: 5, text: '' }),
    /REVIEW_INVALID|text required/,
    'empty text must throw REVIEW_INVALID',
  );
});

// =============================================================================
// 7) computeRoyalty 70/30 split math
// =============================================================================

test('W737 #7 — computeRoyalty 70/30 split math (publisher=$70, platform=$30 on $100)', async () => {
  freshDir();
  const mod = await import('../src/marketplace.js');
  // $100 = 100 * 1_000_000 micro-USD = 100_000_000.
  const r1 = mod.computeRoyalty({ revenue_micro_usd: 100_000_000, publisher_id: 'tenant_pub' });
  assert.equal(r1.publisher_share_micro_usd, 70_000_000,
    `publisher share on $100 must be $70 (70_000_000 micro); got ${r1.publisher_share_micro_usd}`);
  assert.equal(r1.platform_share_micro_usd, 30_000_000,
    `platform share on $100 must be $30 (30_000_000 micro); got ${r1.platform_share_micro_usd}`);
  assert.equal(r1.split.publisher, 0.70);
  assert.equal(r1.split.platform, 0.30);
  // No money disappears in rounding: shares MUST sum to revenue exactly.
  assert.equal(
    r1.publisher_share_micro_usd + r1.platform_share_micro_usd,
    r1.revenue_micro_usd,
    'publisher + platform shares MUST sum to revenue exactly (no rounding leak)',
  );
  // Edge case: 0 revenue → both shares 0.
  const r0 = mod.computeRoyalty({ revenue_micro_usd: 0 });
  assert.equal(r0.publisher_share_micro_usd, 0);
  assert.equal(r0.platform_share_micro_usd, 0);
  // Edge case: 1 micro-USD → publisher floor(0.7)=0, platform=1 (no leak).
  const r1m = mod.computeRoyalty({ revenue_micro_usd: 1 });
  assert.equal(r1m.publisher_share_micro_usd + r1m.platform_share_micro_usd, 1,
    `1-micro split must sum to 1; got ${r1m.publisher_share_micro_usd}+${r1m.platform_share_micro_usd}`);
});

// =============================================================================
// 8) registerArtifact persists + listArtifactsForBrowse reads back
// =============================================================================

test('W737 #8 — registerArtifact persists + listArtifactsForBrowse reads back', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace.js');
  const listing = await mod.registerArtifact({
    cid: 'w737-reg-cid-' + Math.random().toString(36).slice(2, 8),
    publisher_id: 'tenant_w737_8',
    vertical: 'finance',
    task_type: 'generation',
    hardware_target: 'cpu',
    manifest: { name: 'Invoice Parser', k_score: 0.91 },
    price_micro_usd_per_call: 500,
  });
  assert.equal(listing.vertical, 'finance');
  assert.equal(listing.task_type, 'generation');
  assert.equal(listing.hardware_target, 'cpu');
  assert.equal(listing.k_score, 0.91);
  assert.equal(listing.price_micro_usd_per_call, 500);
  // Reset the module-level cache so the next read truly comes from event-store.
  const mpStore = await import('../src/marketplace-store.js');
  mpStore._resetForTests();
  const browse = await mod.listArtifactsForBrowse({});
  assert.equal(browse.total, 1, `expected 1 listing back from event-store; got ${browse.total}`);
  assert.equal(browse.rows[0].vertical, 'finance');
  // Validation — invalid vertical fails loud. Use a valid-length cid so the
  // cid check passes and the vertical check is the one that actually fires.
  await assert.rejects(
    () => mod.registerArtifact({
      cid: 'w737-invalid-vertical-fixture',
      publisher_id: 'p',
      vertical: 'biotech',
      task_type: 'extraction',
      hardware_target: 'cpu',
    }),
    /LISTING_INVALID|vertical must be one of/,
    'unknown vertical must throw LISTING_INVALID',
  );
});

// =============================================================================
// 9) GET /v1/marketplace/search returns 200 with honest envelope
// =============================================================================

test('W737 #9 — GET /v1/marketplace/search returns 200 with honest envelope', async () => {
  freshDir();
  await resetStores();
  process.env.KOLM_STORE_DRIVER = 'json';
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // Search with no listings — honest empty envelope (NOT 500).
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/marketplace/search`);
    assert.equal(r1.status, 200, `search must return 200; got ${r1.status}`);
    const env1 = await r1.json();
    assert.equal(env1.ok, false, 'empty result must report ok:false');
    assert.equal(env1.error, 'marketplace_empty',
      `error must be marketplace_empty; got ${env1.error}`);
    assert.ok(typeof env1.hint === 'string' && env1.hint.length > 0,
      `hint must be a non-empty string; got ${JSON.stringify(env1.hint)}`);
    assert.ok(Array.isArray(env1.results) && env1.results.length === 0,
      `results must be empty array; got ${JSON.stringify(env1.results)}`);
    // Now register one via the auth-gated listings endpoint then re-search.
    const cidUsed = 'w737-route-cid-' + Math.random().toString(36).slice(2, 8);
    const rReg = await fetch(`http://127.0.0.1:${port}/v1/marketplace/listings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        cid: cidUsed,
        vertical: 'support',
        task_type: 'support',
        hardware_target: 'cpu',
        manifest: { name: 'CS Intent Classifier', k_score: 0.86 },
      }),
    });
    assert.equal(rReg.status, 201, `listings POST must return 201; got ${rReg.status}`);
    const r2 = await fetch(`http://127.0.0.1:${port}/v1/marketplace/search?vertical=support`);
    assert.equal(r2.status, 200);
    const env2 = await r2.json();
    assert.equal(env2.ok, true,
      `non-empty search must return ok:true; got ${JSON.stringify(env2)}`);
    assert.equal(env2.total, 1, `expected 1 result; got ${env2.total}`);
    assert.equal(env2.results[0].vertical, 'support');
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 10) POST /v1/marketplace/reviews requires auth
// =============================================================================

test('W737 #10 — POST /v1/marketplace/reviews requires auth (401 without bearer)', async () => {
  freshDir();
  await resetStores();
  process.env.KOLM_STORE_DRIVER = 'json';
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No bearer → 401.
    const rNoAuth = await fetch(`http://127.0.0.1:${port}/v1/marketplace/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_cid: 'x', rating: 5, text: 'good' }),
    });
    assert.equal(rNoAuth.status, 401,
      `unauthenticated POST must return 401; got ${rNoAuth.status}`);
    const errBody = await rNoAuth.json().catch(() => ({}));
    assert.ok(errBody.error,
      `401 body must carry an error field; got ${JSON.stringify(errBody)}`);
    // With bearer → 201.
    const cid = 'w737-r10-cid-' + Math.random().toString(36).slice(2, 8);
    const rAuth = await fetch(`http://127.0.0.1:${port}/v1/marketplace/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ artifact_cid: cid, rating: 4, text: 'works for our use case' }),
    });
    assert.equal(rAuth.status, 201, `authed POST must return 201; got ${rAuth.status}`);
    // GET /v1/marketplace/reviews/:cid is public — no auth needed.
    const rRead = await fetch(`http://127.0.0.1:${port}/v1/marketplace/reviews/${encodeURIComponent(cid)}`);
    assert.equal(rRead.status, 200, `public read must return 200; got ${rRead.status}`);
    const readEnv = await rRead.json();
    assert.equal(readEnv.ratings_count, 1, `expected 1 review back; got ${readEnv.ratings_count}`);
    assert.equal(readEnv.ratings_avg, 4);
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 11) public/marketplace.html exists with brand-lock content + faceted filters
// =============================================================================

test('W737 #11 — public/marketplace.html exists with brand-lock + W737 faceted filters', () => {
  freshDir();
  assert.ok(fs.existsSync(MARKETPLACE_HTML), `expected file at ${MARKETPLACE_HTML}`);
  const html = fs.readFileSync(MARKETPLACE_HTML, 'utf8');
  for (const needle of [
    'kolm.ai',                         // brand
    'w737-faceted',                    // W737 section id
    'w737-vertical',                   // facet axis #1
    'w737-task',                       // facet axis #2
    'w737-hw',                         // facet axis #3 (hardware)
    'w737-min-kscore',                 // facet axis #4 (k-score)
    '/v1/marketplace/search',          // fetch target
    '/docs/marketplace/publish',       // publisher hand-off link
  ]) {
    assert.ok(html.includes(needle),
      `marketplace.html must mention "${needle}"`);
  }
  // Anchor block lock-in: W737 test-anchor must be present.
  assert.ok(html.includes('data-test="w737-faceted-search"'),
    'marketplace.html must carry the w737-faceted-search test anchor');
});

// =============================================================================
// 12) public/docs/marketplace/publish.html exists with revenue split section
// =============================================================================

test('W737 #12 — /docs/marketplace/publish.html exists with revenue split section', () => {
  freshDir();
  assert.ok(fs.existsSync(PUBLISH_DOC), `expected file at ${PUBLISH_DOC}`);
  const html = fs.readFileSync(PUBLISH_DOC, 'utf8');
  for (const needle of [
    'kolm.ai',                          // brand
    'Publish your .kolm',               // primary section heading
    'Revenue split',                    // revenue split section heading
    '70/30',                            // hard-coded split string
    'publisher',                        // publisher label
    'platform',                         // platform label
    'Reviews and ratings',              // reviews section
    'Transfer learning',                // W737-4 section
    'NOT YET WIRED',                    // honest scaffold note
    '/docs/marketplace/publish',        // self-canonical URL anchor
  ]) {
    assert.ok(html.includes(needle),
      `publish.html must mention "${needle}"`);
  }
  // Anchor block lock-in.
  assert.ok(html.includes('data-test="w737-revenue-split"'),
    'publish.html must carry the w737-revenue-split test anchor');
});

// =============================================================================
// 13) vercel.json has /marketplace + /docs/marketplace/publish rewrites
// =============================================================================

test('W737 #13 — vercel.json has /marketplace + /docs/marketplace/publish rewrites', () => {
  freshDir();
  assert.ok(fs.existsSync(VERCEL_JSON), `expected vercel.json at ${VERCEL_JSON}`);
  const cfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must declare a rewrites array');
  const rewriteSources = cfg.rewrites.map((r) => r.source);
  assert.ok(rewriteSources.includes('/marketplace'),
    `vercel.json rewrites must include /marketplace; got ${JSON.stringify(rewriteSources.filter((s) => s.includes('marketplace')))}`);
  assert.ok(rewriteSources.includes('/docs/marketplace/publish'),
    `vercel.json rewrites must include /docs/marketplace/publish; got ${JSON.stringify(rewriteSources.filter((s) => s.includes('marketplace')))}`);
  // The publish rewrite must target the .html under the docs tree.
  const publishRewrite = cfg.rewrites.find((r) => r.source === '/docs/marketplace/publish');
  assert.equal(publishRewrite.destination, '/docs/marketplace/publish.html',
    `publish rewrite must target /docs/marketplace/publish.html; got ${publishRewrite.destination}`);
});

// =============================================================================
// 14) CLI cmdW737Marketplace dispatcher present + wired via case 'marketplace'
// =============================================================================

test('W737 #14 — cli/kolm.js defines cmdW737Marketplace dispatcher exactly once + wired', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named per the W724/W726/W727/W728/W729/W730/W731/W732/W733/W734/
  // W735 precedent so parallel wave agents can't collide on the symbol.
  const defs = cli.match(/async function cmdW737Marketplace\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW737Marketplace dispatcher definition; got ${defs.length}`);
  // Must be wired from `case 'marketplace'` arm in main() — pre-routing for
  // W737 sub-verbs lives in the case arm.
  assert.ok(cli.includes('cmdW737Marketplace(rest)'),
    `cmdW737Marketplace must be invoked from the marketplace case in main()`);
  // Honest fallbacks: marketplace_empty + missing_api_key are the load-bearing
  // error codes the dispatcher must emit.
  assert.ok(cli.includes('marketplace_empty'),
    `cmdW737Marketplace must emit marketplace_empty envelope on no listings`);
  assert.ok(cli.includes('missing_api_key'),
    `cmdW737Marketplace must emit missing_api_key when KOLM_API_KEY absent`);
  // Router-side has the routes wired too.
  const router = fs.readFileSync(ROUTER_PATH, 'utf8');
  assert.ok(router.includes("/v1/marketplace/search"),
    'router.js must declare /v1/marketplace/search route');
  assert.ok(router.includes("/v1/marketplace/listings"),
    'router.js must declare /v1/marketplace/listings route');
  assert.ok(router.includes("/v1/marketplace/reviews"),
    'router.js must declare /v1/marketplace/reviews route');
});

// =============================================================================
// 15) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W737 #15 — wave737 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  // Walk the tests directory and count files matching wave(\d{3,4}). The
  // W604 anti-brittleness directive FORBIDS explicit-array family checks.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave-test files MUST exist (W737 itself +
  // siblings like W730/W731/W732/W733/W734). Threshold is forward-compat:
  // adding more wave tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
  // And the W737 file itself must be present in the sibling list.
  assert.ok(siblings.some((name) => /^wave737-/.test(name)),
    `wave737-*.test.js must appear in the sibling list`);
});
