// W647 - direct contract/security test for src/marketplace-routes.js.
//
// The W825 data modules had helper coverage, but the route layer is the
// money-facing boundary: signed upload, tenant-forced publisher ids, paid
// entitlement, successful-stream-only revenue, and review anti-gaming.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateKeyPair, sign } from '../src/ed25519.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w647-marketplace-routes-'));
process.env.KOLM_DATA_DIR = path.join(TEST_HOME, '.kolm');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.KOLM_STORE_DRIVER = 'jsonl';
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
process.env.RECIPE_RECEIPT_SECRET = 'w647_marketplace_routes_test_secret_32b';

after(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.KOLM_DATA_DIR;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.KOLM_STORE_DRIVER;
  delete process.env.KOLM_EVENT_STORE_DRIVER;
  delete process.env.RECIPE_RECEIPT_SECRET;
});

async function loadModules() {
  const [routes, w825, ratings, eventStore, store] = await Promise.all([
    import('../src/marketplace-routes.js'),
    import('../src/marketplace-w825.js'),
    import('../src/marketplace-ratings.js'),
    import('../src/event-store.js'),
    import('../src/store.js'),
  ]);
  return { routes, w825, ratings, eventStore, store };
}

async function createHarness() {
  const mods = await loadModules();
  mods.w825._resetForTests();
  mods.ratings._resetForTests();
  mods.eventStore._resetForTests();
  mods.store.reset();

  const tenants = new Map();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    const key = req.get('x-test-tenant');
    if (key && tenants.has(key)) req.tenant_record = tenants.get(key);
    next();
  });
  const router = express.Router();
  mods.routes.registerMarketplaceRoutes(router);
  app.use(router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    tenants,
    mods,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function signedListing({ id, artifactPath, paid = false, priceMicroUsd = 0, keypair }) {
  const manifest_sha256 = fs.existsSync(artifactPath)
    ? digest(fs.readFileSync(artifactPath))
    : digest(`${id}:missing-artifact`);
  return {
    id,
    title: `Listing ${id}`,
    vertical: 'code',
    task_type: 'generation',
    k_score: 0.91,
    hardware_targets: ['cpu only'],
    teacher_model: 'w647-teacher',
    artifact_uri: artifactPath,
    manifest_sha256,
    signature_b64: sign(keypair.privateKey, manifest_sha256),
    public_key_pem: keypair.publicKey,
    paid,
    price_micro_usd: priceMicroUsd,
    publisher_tenant_id: 'attacker-supplied-tenant',
  };
}

async function postJson(base, pathName, body, tenantKey = null) {
  const headers = { 'content-type': 'application/json' };
  if (tenantKey) headers['x-test-tenant'] = tenantKey;
  const res = await fetch(base + pathName, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

async function getJson(base, pathName, tenantKey = null) {
  const headers = {};
  if (tenantKey) headers['x-test-tenant'] = tenantKey;
  const res = await fetch(base + pathName, { headers });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

async function revenueEvents(eventStore) {
  return eventStore.listEvents({ provider: 'kolm_marketplace_revenue', limit: 0, order: 'asc' });
}

async function waitFor(fn, label) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
}

test('W647 marketplace routes enforce signed upload, paid entitlement, and successful-stream accounting', async () => {
  const h = await createHarness();
  try {
    const keypair = generateKeyPair();
    const artifactPath = path.join(TEST_HOME, 'paid-ok.kolm');
    fs.writeFileSync(artifactPath, 'paid artifact bytes', 'utf8');

    h.tenants.set('publisher', {
      id: 'tenant_publisher',
      plan: 'pro',
      account_age_days: 30,
      publisher_public_key_pem: keypair.publicKey,
    });
    h.tenants.set('free-buyer', { id: 'tenant_free', plan: 'free', account_age_days: 30 });
    h.tenants.set('paid-buyer', { id: 'tenant_paid', plan: 'pro', account_age_days: 30 });
    h.tenants.set('new-buyer', { id: 'tenant_new', plan: 'pro', account_age_days: 1 });
    h.tenants.set('old-no-download', { id: 'tenant_old_unused', plan: 'pro', account_age_days: 30 });

    const uploadBody = signedListing({
      id: 'paid-ok',
      artifactPath,
      paid: true,
      priceMicroUsd: 12345,
      keypair,
    });

    let out = await postJson(h.base, '/v1/marketplace/upload', uploadBody);
    assert.equal(out.res.status, 401);
    assert.equal(out.body.error, 'auth_required');

    out = await postJson(h.base, '/v1/marketplace/upload', { ...uploadBody, signature_b64: '' }, 'publisher');
    assert.equal(out.res.status, 400);
    assert.equal(out.body.error, 'signature_invalid');
    assert.equal(out.body.reason, 'missing_signature');

    out = await postJson(h.base, '/v1/marketplace/upload', uploadBody, 'publisher');
    assert.equal(out.res.status, 201);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.listing.publisher_tenant_id, 'tenant_publisher');
    assert.notEqual(out.body.listing.publisher_tenant_id, uploadBody.publisher_tenant_id);

    let denied = await getJson(h.base, '/v1/marketplace/download/paid-ok', 'free-buyer');
    assert.equal(denied.res.status, 402);
    assert.equal(denied.body.error, 'payment_required');
    assert.equal(h.mods.w825.getListing('paid-ok').downloads, 0);
    assert.equal((await revenueEvents(h.mods.eventStore)).length, 0);

    const download = await fetch(h.base + '/v1/marketplace/download/paid-ok', {
      headers: { 'x-test-tenant': 'paid-buyer' },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-kolm-listing-id'), 'paid-ok');
    assert.equal(await download.text(), 'paid artifact bytes');

    await waitFor(async () => {
      const listing = h.mods.w825.getListing('paid-ok');
      const events = await revenueEvents(h.mods.eventStore);
      return listing.downloads === 1 && events.length === 1 && events[0].tenant_id === 'tenant_publisher';
    }, 'successful marketplace download should record exactly one revenue event');

    out = await postJson(h.base, '/v1/marketplace/rate', {
      listing_id: 'paid-ok',
      stars: 5,
      review_text: 'solid artifact',
    }, 'paid-buyer');
    assert.equal(out.res.status, 201);
    assert.equal(out.body.rating.tenant_id, 'tenant_paid');

    out = await postJson(h.base, '/v1/marketplace/rate', {
      listing_id: 'paid-ok',
      stars: 5,
      review_text: 'too new',
    }, 'new-buyer');
    assert.equal(out.res.status, 403);
    assert.equal(out.body.error, 'rating_forbidden');
    assert.equal(out.body.reason, 'account_too_new');

    out = await postJson(h.base, '/v1/marketplace/rate', {
      listing_id: 'paid-ok',
      stars: 5,
      review_text: 'never downloaded',
    }, 'old-no-download');
    assert.equal(out.res.status, 403);
    assert.equal(out.body.error, 'rating_forbidden');
    assert.equal(out.body.reason, 'no_prior_download');

    const ratings = await getJson(h.base, '/v1/marketplace/ratings/paid-ok');
    assert.equal(ratings.res.status, 200);
    assert.equal(ratings.body.rating_avg, 5);
    assert.equal(ratings.body.rating_count, 1);

    const missingBody = signedListing({
      id: 'paid-missing',
      artifactPath: path.join(TEST_HOME, 'missing.kolm'),
      paid: true,
      priceMicroUsd: 999,
      keypair,
    });
    out = await postJson(h.base, '/v1/marketplace/upload', missingBody, 'publisher');
    assert.equal(out.res.status, 201);

    const beforeEvents = (await revenueEvents(h.mods.eventStore)).length;
    const missing = await getJson(h.base, '/v1/marketplace/download/paid-missing', 'paid-buyer');
    assert.equal(missing.res.status, 410);
    assert.equal(missing.body.error, 'artifact_gone');
    assert.equal(h.mods.w825.getListing('paid-missing').downloads, 0);
    assert.equal((await revenueEvents(h.mods.eventStore)).length, beforeEvents);
  } finally {
    await h.close();
  }
});
