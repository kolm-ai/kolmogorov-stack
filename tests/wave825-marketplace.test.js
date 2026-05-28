// W825 — Artifact Marketplace MVP tests.
//
// W737 already shipped src/marketplace.js (curated catalog + reviews +
// computeRoyalty). W825 is the MVP UPGRADE that adds the publisher-driven
// storefront: ~/.kolm/marketplace/listings.jsonl data layer, signed upload,
// download stream + paid 402 gate, anti-gaming rating, transfer-learning
// queue, and a 70/30 payout cycle.
//
// Atomic items pinned (matches the W825 implementation):
//
//   1) MARKETPLACE_W825_VERSION + 70/30 hard-coded constants present
//   2) upsertListing + getListing round-trip (CRUD)
//   3) listListings filters by vertical/task_type/k_score_min/hardware/teacher
//   4) listListings sort modes: newest, top_k_score, most_downloaded, highest_rated
//   5) upsertListing rejects bad manifest_sha256 (LISTING_INVALID)
//   6) POST /v1/marketplace/upload returns 400 signature_invalid on bad sig
//   7) POST /v1/marketplace/upload returns 201 + persists with VALID Ed25519 sig
//   8) GET  /v1/marketplace/download/:id returns 402 on paid+no-entitlement
//   9) GET  /v1/marketplace/download/:id streams local file on free listing
//  10) rate() throws RATING_FORBIDDEN when tenant has no prior download
//  11) rate() throws RATING_FORBIDDEN when account_age_days < 7
//  12) calcPayout 70/30 split — publisher floor(0.70 * rev), platform = remainder
//  13) POST /v1/marketplace/rate returns 403 anti-gaming path
//  14) finetuneFromMarketplace returns {ok:true, run_id, status:'queued'} for known artifact
//  15) registerMarketplaceRoutes wired in src/router.js (single import + call)
//  16) public/sw.js cache token carries wave(\d{3,4}) ≥ 825 (regex+threshold, NOT array)
//  17) public/marketplace/index.html preserves brand lock + has w825 anchors
//
// W604 anti-brittleness: NO explicit-array family lock-in. Wave token check is
// regex `wave(\d{3,4})` with numeric threshold ≥ 825 so future waves don't
// break this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const ROUTER_PATH      = path.join(REPO_ROOT, 'src', 'router.js');
const SW_PATH          = path.join(REPO_ROOT, 'public', 'sw.js');
const MKT_INDEX        = path.join(REPO_ROOT, 'public', 'marketplace', 'index.html');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w825-'));
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
    'events_w825_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

async function resetStores() {
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const w825 = await import('../src/marketplace-w825.js');
  if (w825._resetForTests) w825._resetForTests();
  const ratings = await import('../src/marketplace-ratings.js');
  if (ratings._resetForTests) ratings._resetForTests();
}

// Build a fake-but-real-looking artifact file + return {path, sha256}.
function _fakeArtifact(tmp) {
  const p = path.join(tmp, 'fake-' + crypto.randomBytes(4).toString('hex') + '.kolm');
  const bytes = Buffer.from('kolm-artifact-bytes-' + crypto.randomBytes(16).toString('hex'));
  fs.writeFileSync(p, bytes);
  return { path: p, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// Build a complete valid listing input. Override any field via `opts`.
function _validListing(opts = {}) {
  const sha = opts.manifest_sha256 || crypto.randomBytes(32).toString('hex');
  return {
    id: 'w825-' + crypto.randomBytes(4).toString('hex'),
    publisher_tenant_id: 'tenant_' + crypto.randomBytes(6).toString('hex'),
    title: 'Test Distill',
    vertical: 'support',
    task_type: 'classification',
    k_score: 0.88,
    hardware_targets: ['rtx', 'cpu'],
    teacher_model: 'claude-sonnet-4-5',
    artifact_uri: '/tmp/test.kolm',
    manifest_sha256: sha,
    signature_b64: 'X'.repeat(86),
    paid: false,
    price_micro_usd: 0,
    ...opts,
  };
}

// =============================================================================
// 1) Version stamp + hard-coded 70/30 contract
// =============================================================================

test('W825 #1 — MARKETPLACE_W825_VERSION + PUBLISHER_SHARE/PLATFORM_SHARE hard-coded', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace-w825.js');
  assert.equal(mod.MARKETPLACE_W825_VERSION, 'w825-mvp-v1',
    `expected version 'w825-mvp-v1'; got ${JSON.stringify(mod.MARKETPLACE_W825_VERSION)}`);
  const payouts = await import('../src/marketplace-payouts.js');
  assert.equal(payouts.PUBLISHER_SHARE, 0.70,
    `publisher share must be 0.70 (hard-coded); got ${payouts.PUBLISHER_SHARE}`);
  assert.equal(payouts.PLATFORM_SHARE, 0.30,
    `platform share must be 0.30 (hard-coded); got ${payouts.PLATFORM_SHARE}`);
  // Anti-gaming threshold is hard-coded too.
  const ratings = await import('../src/marketplace-ratings.js');
  assert.equal(ratings.MIN_ACCOUNT_AGE_DAYS, 7,
    `min account age must be 7 days (hard-coded); got ${ratings.MIN_ACCOUNT_AGE_DAYS}`);
});

// =============================================================================
// 2) upsertListing + getListing CRUD
// =============================================================================

test('W825 #2 — upsertListing + getListing round-trip', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace-w825.js');
  const input = _validListing({ id: 'w825-crud-1' });
  const row = mod.upsertListing(input);
  assert.equal(row.id, 'w825-crud-1');
  assert.equal(row.title, 'Test Distill');
  assert.equal(row.vertical, 'support');
  assert.equal(row.k_score, 0.88);
  // Defaults applied honestly (never null).
  assert.equal(row.downloads, 0, `fresh listing must default downloads:0; got ${row.downloads}`);
  assert.equal(row.rating_count, 0, `fresh listing must default rating_count:0; got ${row.rating_count}`);
  // Read-back path uses the same JSONL file.
  const back = mod.getListing('w825-crud-1');
  assert.ok(back, 'getListing must return the row we just upserted');
  assert.equal(back.id, 'w825-crud-1');
  // Update path: upsert again with a new title — created_at preserved.
  const updated = mod.upsertListing({ ..._validListing({ id: 'w825-crud-1' }), title: 'Renamed' });
  assert.equal(updated.title, 'Renamed', 'second upsert must update the title');
  assert.equal(updated.created_at, row.created_at,
    `created_at must be preserved across upserts; orig=${row.created_at} new=${updated.created_at}`);
});

// =============================================================================
// 3) listListings filters
// =============================================================================

test('W825 #3 — listListings filters by vertical/task_type/k_score_min/hardware/teacher', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace-w825.js');
  mod.upsertListing(_validListing({
    id: 'w825-f-1', vertical: 'legal', task_type: 'extraction',
    k_score: 0.95, hardware_targets: ['h100'], teacher_model: 'gpt-5-pro',
  }));
  mod.upsertListing(_validListing({
    id: 'w825-f-2', vertical: 'medical', task_type: 'extraction',
    k_score: 0.70, hardware_targets: ['rtx', 'cpu'], teacher_model: 'claude-opus-4-7',
  }));
  mod.upsertListing(_validListing({
    id: 'w825-f-3', vertical: 'legal', task_type: 'reasoning',
    k_score: 0.40, hardware_targets: ['m-series'], teacher_model: 'claude-opus-4-7',
  }));
  // vertical filter
  const legal = mod.listListings({ vertical: 'legal' });
  assert.equal(legal.total, 2, `legal filter must return 2; got ${legal.total}`);
  // task_type filter
  const extract = mod.listListings({ task_type: 'extraction' });
  assert.equal(extract.total, 2, `extraction filter must return 2; got ${extract.total}`);
  // k_score_min filter (strict >= threshold; null k_score is dropped)
  const hi = mod.listListings({ k_score_min: 0.90 });
  assert.equal(hi.total, 1, `k_score_min=0.90 must return 1; got ${hi.total}`);
  // hardware substring match
  const rtx = mod.listListings({ hardware: 'rtx' });
  assert.equal(rtx.total, 1, `hardware=rtx must return 1; got ${rtx.total}`);
  // teacher substring match
  const claude = mod.listListings({ teacher: 'claude' });
  assert.equal(claude.total, 2, `teacher=claude must return 2; got ${claude.total}`);
});

// =============================================================================
// 4) listListings sort modes
// =============================================================================

test('W825 #4 — listListings sort_by newest/top_k_score/most_downloaded/highest_rated', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace-w825.js');
  mod.upsertListing(_validListing({ id: 'w825-s-low', k_score: 0.40 }));
  // Tiny delay across writes so created_at is monotonically distinct for the
  // newest-sort tiebreaker.
  await new Promise((r) => setTimeout(r, 10));
  mod.upsertListing(_validListing({ id: 'w825-s-mid', k_score: 0.70 }));
  await new Promise((r) => setTimeout(r, 10));
  mod.upsertListing(_validListing({ id: 'w825-s-hi',  k_score: 0.95 }));
  // Bump counters on specific rows so the sort assertions diverge.
  mod.recordDownload('w825-s-mid');
  mod.recordDownload('w825-s-mid');
  mod.recordDownload('w825-s-low');
  mod.updateRatingAggregate('w825-s-low', { avg: 4.8, count: 3 });
  mod.updateRatingAggregate('w825-s-hi',  { avg: 3.2, count: 5 });

  const newest = mod.listListings({ sort_by: 'newest' });
  assert.equal(newest.rows[0].id, 'w825-s-hi',
    `newest first must be the last-written row; got ${newest.rows[0].id}`);

  const topK = mod.listListings({ sort_by: 'top_k_score' });
  assert.equal(topK.rows[0].id, 'w825-s-hi',
    `top_k_score must rank k=0.95 first; got ${topK.rows[0].id} k=${topK.rows[0].k_score}`);

  const mostDl = mod.listListings({ sort_by: 'most_downloaded' });
  assert.equal(mostDl.rows[0].id, 'w825-s-mid',
    `most_downloaded must rank the row with 2 downloads first; got ${mostDl.rows[0].id} dl=${mostDl.rows[0].downloads}`);

  const hiRated = mod.listListings({ sort_by: 'highest_rated' });
  assert.equal(hiRated.rows[0].id, 'w825-s-low',
    `highest_rated must rank avg=4.8 first; got ${hiRated.rows[0].id} avg=${hiRated.rows[0].rating_avg}`);
});

// =============================================================================
// 5) upsertListing rejects malformed manifest_sha256
// =============================================================================

test('W825 #5 — upsertListing rejects bad manifest_sha256 (LISTING_INVALID)', async () => {
  freshDir();
  await resetStores();
  const mod = await import('../src/marketplace-w825.js');
  assert.throws(
    () => mod.upsertListing(_validListing({
      id: 'w825-badsha', manifest_sha256: 'not-a-hex-digest',
    })),
    (e) => e && e.code === 'LISTING_INVALID' && /manifest_sha256/.test(String(e.message)),
    'bad manifest_sha256 must throw LISTING_INVALID with detail mentioning manifest_sha256',
  );
  // Missing artifact_uri also rejected.
  assert.throws(
    () => mod.upsertListing(_validListing({ id: 'w825-nouri', artifact_uri: '' })),
    (e) => e && e.code === 'LISTING_INVALID' && /artifact_uri/.test(String(e.message)),
    'missing artifact_uri must throw LISTING_INVALID',
  );
});

// =============================================================================
// 6) POST /v1/marketplace/upload returns 400 signature_invalid on bad sig
// =============================================================================

test('W825 #6 — POST /v1/marketplace/upload returns 400 signature_invalid on bad sig', async () => {
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
    const sha = crypto.randomBytes(32).toString('hex');
    const r = await fetch(`http://127.0.0.1:${port}/v1/marketplace/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        id: 'w825-up-bad',
        title: 'Test',
        vertical: 'support',
        task_type: 'classification',
        hardware_targets: ['cpu'],
        artifact_uri: '/tmp/x.kolm',
        manifest_sha256: sha,
        signature_b64: 'totally-not-a-real-signature',
        public_key_pem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAQ=\n-----END PUBLIC KEY-----\n',
      }),
    });
    assert.equal(r.status, 400, `bad-sig upload must return 400; got ${r.status}`);
    const env = await r.json();
    assert.equal(env.error, 'signature_invalid',
      `error code must be signature_invalid; got ${env.error}`);
    assert.ok(env.reason, `400 body must carry a reason field; got ${JSON.stringify(env)}`);
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 7) POST /v1/marketplace/upload returns 201 + persists with VALID Ed25519 sig
// =============================================================================

test('W825 #7 — POST /v1/marketplace/upload returns 201 + persists with valid Ed25519 sig', async () => {
  const tmp = freshDir();
  await resetStores();
  process.env.KOLM_STORE_DRIVER = 'json';
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const { generateKeyPair, sign } = await import('../src/ed25519.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const { publicKey, privateKey } = generateKeyPair();

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const fake = _fakeArtifact(tmp);
    const sigB64Url = sign(privateKey, fake.sha256);
    // Convert base64url → standard base64 so the field name signature_b64
    // matches the wire shape the route expects (route flips it back to
    // base64url before calling ed25519.verify).
    const sigB64 = sigB64Url.replace(/-/g, '+').replace(/_/g, '/');
    const r = await fetch(`http://127.0.0.1:${port}/v1/marketplace/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        id: 'w825-up-good',
        title: 'Real Listing',
        vertical: 'support',
        task_type: 'classification',
        k_score: 0.91,
        hardware_targets: ['rtx'],
        teacher_model: 'claude-sonnet-4-5',
        artifact_uri: fake.path,
        manifest_sha256: fake.sha256,
        signature_b64: sigB64,
        public_key_pem: publicKey,
      }),
    });
    assert.equal(r.status, 201, `valid-sig upload must return 201; got ${r.status}`);
    const env = await r.json();
    assert.equal(env.ok, true, `envelope must be ok:true; got ${JSON.stringify(env)}`);
    assert.equal(env.listing.id, 'w825-up-good');
    assert.equal(env.listing.publisher_tenant_id, t.id,
      `publisher_tenant_id must be FORCED to the caller (W411 fence); got ${env.listing.publisher_tenant_id}`);
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 8) GET /v1/marketplace/download/:id returns 402 on paid + no entitlement
// =============================================================================

test('W825 #8 — GET /v1/marketplace/download/:id returns 402 on paid + no entitlement', async () => {
  const tmp = freshDir();
  await resetStores();
  process.env.KOLM_STORE_DRIVER = 'json';
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const w825 = await import('../src/marketplace-w825.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  // Caller tenant is anon (plan='anon') so it is NOT entitled.
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  // Publisher is a DIFFERENT tenant (otherwise self-publisher gate lets the
  // download through).
  const fake = _fakeArtifact(tmp);
  w825.upsertListing(_validListing({
    id: 'w825-paid-1',
    publisher_tenant_id: 'tenant_other_publisher',
    artifact_uri: fake.path,
    manifest_sha256: fake.sha256,
    paid: true,
    price_micro_usd: 1_000_000, // $1
  }));

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/marketplace/download/w825-paid-1`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(r.status, 402, `paid+no-entitlement must return 402; got ${r.status}`);
    const env = await r.json();
    assert.equal(env.error, 'payment_required',
      `error code must be payment_required; got ${env.error}`);
    assert.equal(env.price_micro_usd, 1_000_000,
      `402 body must carry price_micro_usd; got ${env.price_micro_usd}`);
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 9) GET /v1/marketplace/download/:id streams local file on free listing
// =============================================================================

test('W825 #9 — GET /v1/marketplace/download/:id streams local file on free listing', async () => {
  const tmp = freshDir();
  await resetStores();
  process.env.KOLM_STORE_DRIVER = 'json';
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const w825 = await import('../src/marketplace-w825.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const fake = _fakeArtifact(tmp);
  w825.upsertListing(_validListing({
    id: 'w825-free-1',
    publisher_tenant_id: 'tenant_other_publisher',
    artifact_uri: fake.path,
    manifest_sha256: fake.sha256,
    paid: false,
    price_micro_usd: 0,
  }));

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/marketplace/download/w825-free-1`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(r.status, 200, `free download must return 200; got ${r.status}`);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream',
      `download must set octet-stream content-type; got ${r.headers.get('content-type')}`);
    assert.equal(r.headers.get('x-kolm-listing-id'), 'w825-free-1',
      `download must set X-Kolm-Listing-Id; got ${r.headers.get('x-kolm-listing-id')}`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, fs.readFileSync(fake.path).length,
      `streamed bytes length must match the source file; got ${buf.length} vs ${fs.readFileSync(fake.path).length}`);
    // Download counter must be incremented.
    const back = w825.getListing('w825-free-1');
    assert.equal(back.downloads, 1,
      `download counter must be 1 after one stream; got ${back.downloads}`);
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 10) rate() throws RATING_FORBIDDEN when tenant has no prior download
// =============================================================================

test('W825 #10 — rate() throws RATING_FORBIDDEN with reason=no_prior_download', async () => {
  freshDir();
  await resetStores();
  const w825 = await import('../src/marketplace-w825.js');
  const ratings = await import('../src/marketplace-ratings.js');
  w825.upsertListing(_validListing({ id: 'w825-rate-no-dl' }));
  // Synthetic tenant that is OLD enough (gate #1 passes) but has no prior
  // download (gate #2 must fire).
  const oldTenant = {
    id: 'tenant_w825_old',
    created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  };
  assert.throws(
    () => ratings.rate({ tenant: oldTenant, listing_id: 'w825-rate-no-dl', stars: 5, review_text: 'good' }),
    (e) => e && e.code === 'RATING_FORBIDDEN' && e.reason === 'no_prior_download',
    'rating must throw RATING_FORBIDDEN with reason=no_prior_download',
  );
});

// =============================================================================
// 11) rate() throws RATING_FORBIDDEN when account_age_days < 7
// =============================================================================

test('W825 #11 — rate() throws RATING_FORBIDDEN with reason=account_too_new', async () => {
  freshDir();
  await resetStores();
  const w825 = await import('../src/marketplace-w825.js');
  const ratings = await import('../src/marketplace-ratings.js');
  w825.upsertListing(_validListing({ id: 'w825-rate-young' }));
  // Brand-new tenant — created today. Gate #1 must fire first (no need to
  // bother with the download gate since the account-age gate runs ahead).
  const youngTenant = {
    id: 'tenant_w825_young',
    created_at: new Date().toISOString(),
  };
  assert.throws(
    () => ratings.rate({ tenant: youngTenant, listing_id: 'w825-rate-young', stars: 5, review_text: 'hi' }),
    (e) => e && e.code === 'RATING_FORBIDDEN' && e.reason === 'account_too_new',
    'rating must throw RATING_FORBIDDEN with reason=account_too_new',
  );
  // Sanity: with both gates satisfied the rating goes through.
  ratings.recordDownloadEvent({ listing_id: 'w825-rate-young', tenant_id: 'tenant_w825_ok' });
  const okTenant = {
    id: 'tenant_w825_ok',
    created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  };
  const row = ratings.rate({ tenant: okTenant, listing_id: 'w825-rate-young', stars: 4, review_text: 'solid' });
  assert.equal(row.stars, 4, `successful rate() must return the stars; got ${row.stars}`);
});

// =============================================================================
// 12) calcPayout 70/30 split math
// =============================================================================

test('W825 #12 — calcPayout 70/30 split (publisher floor 70%, platform = remainder)', async () => {
  freshDir();
  const payouts = await import('../src/marketplace-payouts.js');
  // $100 = 100_000_000 micro-USD.
  const r1 = payouts.calcPayout({ id: 'L1', publisher_tenant_id: 'pub_a' }, 100_000_000);
  assert.equal(r1.publisher_micro_usd, 70_000_000,
    `publisher share on $100 must be $70 (70_000_000 micro); got ${r1.publisher_micro_usd}`);
  assert.equal(r1.platform_micro_usd, 30_000_000,
    `platform share on $100 must be $30 (30_000_000 micro); got ${r1.platform_micro_usd}`);
  assert.equal(r1.split.publisher, 0.70);
  assert.equal(r1.split.platform, 0.30);
  // No money disappears in rounding: shares MUST sum to revenue exactly.
  assert.equal(
    r1.publisher_micro_usd + r1.platform_micro_usd,
    r1.revenue_micro_usd,
    'publisher + platform shares MUST sum to revenue exactly (no rounding leak)',
  );
  // 1-micro edge case: publisher floor(0.7)=0, platform=1.
  const r1m = payouts.calcPayout({ id: 'L2', publisher_tenant_id: 'pub_a' }, 1);
  assert.equal(r1m.publisher_micro_usd + r1m.platform_micro_usd, 1,
    `1-micro split must sum to 1; got ${r1m.publisher_micro_usd}+${r1m.platform_micro_usd}`);
  // 0 revenue → both 0.
  const r0 = payouts.calcPayout({ id: 'L3', publisher_tenant_id: 'pub_a' }, 0);
  assert.equal(r0.publisher_micro_usd, 0);
  assert.equal(r0.platform_micro_usd, 0);
  // Within 1 micro: floor(0.70 * 1_000_001) = 700_000, remainder = 300_001
  const rOdd = payouts.calcPayout({ id: 'L4', publisher_tenant_id: 'pub_a' }, 1_000_001);
  assert.ok(Math.abs(rOdd.publisher_micro_usd - (1_000_001 * 0.70)) < 1,
    `publisher share within 1 micro of 70%; got ${rOdd.publisher_micro_usd}`);
});

// =============================================================================
// 13) POST /v1/marketplace/rate returns 403 anti-gaming path
// =============================================================================

test('W825 #13 — POST /v1/marketplace/rate returns 403 on anti-gaming path', async () => {
  freshDir();
  await resetStores();
  process.env.KOLM_STORE_DRIVER = 'json';
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const w825 = await import('../src/marketplace-w825.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  // Brand-new tenant (account age 0d) → account_too_new gate fires.
  w825.upsertListing(_validListing({ id: 'w825-r403' }));

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No bearer → 401 first.
    const rNoAuth = await fetch(`http://127.0.0.1:${port}/v1/marketplace/rate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listing_id: 'w825-r403', stars: 5, review_text: 'good' }),
    });
    assert.equal(rNoAuth.status, 401, `unauthenticated rate must return 401; got ${rNoAuth.status}`);
    // Authed but brand-new + no download → 403.
    const r403 = await fetch(`http://127.0.0.1:${port}/v1/marketplace/rate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ listing_id: 'w825-r403', stars: 5, review_text: 'good' }),
    });
    assert.equal(r403.status, 403, `anti-gaming gate must return 403; got ${r403.status}`);
    const env = await r403.json();
    assert.equal(env.error, 'rating_forbidden',
      `error code must be rating_forbidden; got ${env.error}`);
    assert.ok(env.reason, `403 body must carry a reason; got ${JSON.stringify(env)}`);
  } finally {
    await new Promise((r) => srv.close(r));
    await resetStores();
  }
});

// =============================================================================
// 14) finetuneFromMarketplace returns honest queued envelope
// =============================================================================

test('W825 #14 — finetuneFromMarketplace returns {ok:true, run_id, status:"queued"}', async () => {
  freshDir();
  await resetStores();
  const w825 = await import('../src/marketplace-w825.js');
  const ft = await import('../src/marketplace-finetune.js');
  w825.upsertListing(_validListing({ id: 'w825-ft-1' }));
  const env = await ft.finetuneFromMarketplace({
    artifact_id: 'w825-ft-1',
    tenant_id: 'tenant_w825_ft',
    captures_namespace: 'demo',
    k_target: 0.9,
    max_steps: 200,
  });
  assert.equal(env.ok, true, `envelope must be ok:true; got ${JSON.stringify(env)}`);
  assert.equal(env.status, 'queued',
    `status must be 'queued' (never 'running'/'completed' — fine-tune is a worker); got ${env.status}`);
  assert.ok(env.run_id && /^distill_/.test(env.run_id),
    `run_id must look like distill_<id>; got ${env.run_id}`);
  assert.equal(env.base_artifact_id, 'w825-ft-1');
  // Unknown artifact_id → ok:false.
  const bad = await ft.finetuneFromMarketplace({
    artifact_id: 'w825-doesnt-exist',
    tenant_id: 'tenant_w825_ft',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_artifact_id',
    `unknown artifact must yield unknown_artifact_id; got ${bad.error}`);
});

// =============================================================================
// 15) registerMarketplaceRoutes wired in router.js (single import + call)
// =============================================================================

test('W825 #15 — registerMarketplaceRoutes wired in src/router.js (single import + call)', async () => {
  const router = fs.readFileSync(ROUTER_PATH, 'utf8');
  // Single-call mount keeps the router.js diff to two lines so parallel wave
  // agents (WC07, WC14, W822, W824) can't collide on it. The import may be
  // aliased via `as __registerMarketplaceRoutes_w825` to avoid name collisions
  // with other wave modules — we assert the alias suffix `_w825` rather than
  // the bare name to make this test robust to that pattern.
  assert.ok(router.includes("from './marketplace-routes.js'"),
    `router.js must import from ./marketplace-routes.js; got no match`);
  // Accept either bare `registerMarketplaceRoutes(` or the aliased
  // `__registerMarketplaceRoutes_w825(` call site.
  assert.ok(/registerMarketplaceRoutes(_w825)?\s*\(/.test(router) ||
            /__registerMarketplaceRoutes_w825\s*\(/.test(router),
    `router.js must call registerMarketplaceRoutes(...) or its _w825 alias`);
  // Sanity: marketplace-routes.js exports the function.
  const mod = await import('../src/marketplace-routes.js');
  assert.equal(typeof mod.registerMarketplaceRoutes, 'function',
    `src/marketplace-routes.js must export registerMarketplaceRoutes`);
});

// =============================================================================
// 16) public/sw.js cache token carries wave(\d{3,4}) ≥ 825
// =============================================================================

test('W825 #16 — public/sw.js cache token carries wave(\\d{3,4}) ≥ 825 (regex+threshold, not array)', () => {
  freshDir();
  assert.ok(fs.existsSync(SW_PATH), `expected sw.js at ${SW_PATH}`);
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  // Find the CACHE = '...' assignment and ensure at least one wave token in it
  // is >= 825. W604: NO explicit-array sibling assertion.
  const cacheLine = sw.match(/CACHE\s*=\s*['"][^'"]+['"]/);
  assert.ok(cacheLine, `sw.js must declare a CACHE constant; got no match`);
  const tokens = (cacheLine[0].match(/wave(\d{3,4})/g) || []).map((s) => parseInt(s.replace('wave', ''), 10));
  const maxWave = tokens.reduce((m, n) => Math.max(m, n), 0);
  assert.ok(maxWave >= 825,
    `expected at least one wave(\\d{3,4}) >= 825 in CACHE; got max=${maxWave}, tokens=${JSON.stringify(tokens)}`);
  // W604/W829 convention: version pin is regex + numeric threshold ONLY.
  // The literal `wave825` slug is intentionally NOT asserted — sw.js bumps its
  // CACHE token every wave (now wave918), so freezing on wave825 would break
  // this test on the very next bump. The threshold check above is the contract.
});

// =============================================================================
// 17) public/marketplace/index.html preserves brand lock + W825 anchors
// =============================================================================

test('W825 #17 — public/marketplace/index.html preserves brand lock + W825 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(MKT_INDEX), `expected file at ${MKT_INDEX}`);
  const html = fs.readFileSync(MKT_INDEX, 'utf8');
  // Brand lock is the standing directive — eyebrow + H1 byte-for-byte.
  assert.ok(html.includes('Open-source AI workbench'),
    `marketplace/index.html must carry brand eyebrow "Open-source AI workbench"`);
  assert.ok(html.includes('Frontier AI on your own infrastructure'),
    `marketplace/index.html must carry brand H1 "Frontier AI on your own infrastructure"`);
  // W825 fetch targets + test anchors.
  for (const needle of [
    '/v1/marketplace/listings',
    '/v1/marketplace/facets',
    'data-test="w825-marketplace-shell"',
    'data-test="w825-listing-grid"',
    'w825-marketplace-mvp',
  ]) {
    assert.ok(html.includes(needle),
      `marketplace/index.html must mention "${needle}"`);
  }
});
