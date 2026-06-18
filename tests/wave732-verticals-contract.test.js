// W732 - direct contract test for src/verticals.js.
//
// The marketplace and router suites prove their own surfaces. This pins the
// vertical catalog atom itself: bounded IDs, honest pending marketplace stubs,
// sanitized publisher attribution, legacy fingerprint envelopes, and compact
// route error shapes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w732-verticals-'));
const BOOT_DATA_DIR = path.join(DATA_ROOT, 'boot');
fs.mkdirSync(BOOT_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = BOOT_DATA_DIR;
process.env.HOME = DATA_ROOT;
process.env.USERPROFILE = DATA_ROOT;
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ENV = 'test';

const { test, beforeEach, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const verticals = await import('../src/verticals.js');
const marketplaceStore = await import('../src/marketplace-store.js');
const eventStore = await import('../src/event-store.js');
const store = await import('../src/store.js');
const express = (await import('express')).default;
const { buildRouter } = await import('../src/router.js');
const { provisionTenant } = await import('../src/auth.js');
let caseCounter = 0;

beforeEach(() => {
  const caseDir = path.join(DATA_ROOT, `case-${caseCounter++}`);
  fs.mkdirSync(caseDir, { recursive: true });
  process.env.KOLM_DATA_DIR = caseDir;
  marketplaceStore._resetForTests();
  eventStore._resetForTests();
  store.remove('tenants', () => true);
  store.remove('api_keys', () => true);
});

after(() => {
  try { marketplaceStore._resetForTests(); } catch {}
  try { eventStore._resetForTests(); } catch {}
  try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch {}
});

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  return app;
}

function withListening(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const out = await fn(`http://127.0.0.1:${srv.address().port}`);
        srv.close(() => resolve(out));
      } catch (err) {
        srv.close(() => reject(err));
      }
    });
  });
}

async function jsonFetch(base, route, apiKey = null, opts = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(opts.headers || {}),
  };
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;
  const res = await fetch(base + route, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}

test('W732 vertical catalog is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/verticals.js');
  const routerSource = read('src/router.js');

  assert.equal(verticals.VERTICALS_CONTRACT_VERSION, 'w732-verticals-v1');
  assert.ok(verticals.VERTICALS_LIMITS.max_vertical_id_chars <= 64);
  assert.ok(verticals.VERTICALS_LIMITS.max_publisher_id_chars <= 128);
  assert.equal(
    pkg.scripts['verify:verticals'],
    'node --test --test-concurrency=1 tests/wave732-verticals-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:trend-extract && npm run verify:verticals && npm run verify:video-bakeoff && npm run verify:video-capture && npm run verify:vision-capture && npm run verify:vlm-bakeoff && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /normalizeVerticalId/);
  assert.match(source, /normalizeVerticalPublisherId/);
  assert.match(source, /VERTICALS_CONTRACT_VERSION/);
  assert.match(routerSource, /verticals_list_error/);
  assert.match(routerSource, /error_sha256/);
  assert.doesNotMatch(routerSource, /verticals_list_error['"][\s\S]{0,240}detail:/);
  assert.doesNotMatch(routerSource, /vertical_show_error['"][\s\S]{0,240}detail:/);
  assert.doesNotMatch(routerSource, /vertical_fingerprint_error['"][\s\S]{0,240}detail:/);
  assert.doesNotMatch(routerSource, /vertical_register_error['"][\s\S]{0,240}detail:/);
});

test('W732 catalog rows remain frozen, bounded, and exactly ordered', () => {
  assert.equal(Object.isFrozen(verticals.VERTICALS), true);
  assert.deepEqual(verticals.VERTICALS.map((row) => row.id), [
    'legal',
    'medical',
    'code',
    'finance',
    'support',
  ]);

  for (const row of verticals.VERTICALS) {
    assert.equal(Object.isFrozen(row), true);
    assert.equal(Object.isFrozen(row.common_tasks), true);
    assert.match(row.id, /^[a-z][a-z0-9-]{0,63}$/);
    assert.equal(row.model_slug, `kolm-${row.id}-7b`);
    assert.equal(row.marketplace_status, 'pending_distill');
    assert.ok(row.common_tasks.length > 0);
    assert.ok(row.common_tasks.length <= verticals.VERTICALS_LIMITS.max_common_tasks);
    assert.ok(row.target_kscore >= 0.85 && row.target_kscore <= 0.95);
  }

  assert.equal(verticals.normalizeVerticalId(' LEGAL '), 'legal');
  assert.equal(verticals.getVertical(' FINANCE ')?.id, 'finance');
  assert.equal(verticals.getVertical('../medical'), null);
  assert.equal(verticals.getVertical('support\ncustomer@example.com'), null);
  assert.equal(verticals.verticalIdForEnvelope('support\ncustomer@example.com'), 'unknown');
});

test('W732 marketplace stub registration is honest, bounded, and non-leaky', async () => {
  const listing = await verticals.registerVerticalArtifact('LEGAL', '../bad-publisher@example.com');

  assert.equal(listing.cid, 'pending_legal');
  assert.equal(listing.publisher_id, verticals.VERTICALS_DEFAULT_PUBLISHER_ID);
  assert.equal(listing.vertical, 'legal');
  assert.equal(listing.task_type, 'extraction');
  assert.equal(listing.hardware_target, 'rtx');
  assert.equal(listing.price_micro_usd_per_call, 0);
  assert.equal(listing.k_score, null);
  assert.equal(listing.manifest.k_score, null);
  assert.equal(listing.manifest.pending_distill, true);
  assert.equal(listing.manifest.not_kolm_compiled, true);
  assert.deepEqual(listing.manifest.blocked_by, ['W757', 'W715']);
  assert.equal(listing.manifest.contract_version, verticals.VERTICALS_CONTRACT_VERSION);
  assert.equal(listing.manifest.catalog_version, verticals.VERTICALS_VERSION);

  await assert.rejects(
    () => verticals.registerVerticalArtifact('../medical\nalice@example.com'),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_VERTICAL');
      assert.equal(err.message, 'unknown_vertical');
      assert.equal(err.vertical_id, 'unknown');
      assert.equal(String(err.message).includes('alice@example.com'), false);
      return true;
    },
  );
});

test('W732 bulk vertical registration is idempotent across all five stubs', async () => {
  const first = await verticals.registerAllVerticalStubs('publisher.verticals');
  assert.equal(first.ok, true);
  assert.equal(first.version, verticals.VERTICALS_VERSION);
  assert.equal(first.contract_version, verticals.VERTICALS_CONTRACT_VERSION);
  assert.deepEqual(first.registered, [
    'kolm-legal-7b',
    'kolm-medical-7b',
    'kolm-code-7b',
    'kolm-finance-7b',
    'kolm-support-7b',
  ]);
  assert.deepEqual(first.skipped, []);
  assert.equal(first.total, 5);

  const second = await verticals.registerAllVerticalStubs('publisher.verticals');
  assert.deepEqual(second.registered, []);
  assert.deepEqual(second.skipped, first.registered);
  assert.equal(second.total, 5);

  const finance = await marketplaceStore.getListingByCid('pending_finance');
  assert.equal(finance.publisher_id, 'publisher.verticals');
  assert.equal(finance.manifest.contract_version, verticals.VERTICALS_CONTRACT_VERSION);
});

test('W732 legacy fingerprint stub preserves shape without echoing hostile IDs', () => {
  const fp = verticals.verticalFingerprintStub(' Finance ');
  assert.equal(fp.ok, false);
  assert.equal(fp.error, 'w757_not_shipped');
  assert.equal(fp.blocked_by, 'W757');
  assert.equal(fp.vertical, 'finance');
  assert.equal(fp.version, verticals.VERTICALS_VERSION);
  assert.equal(fp.contract_version, verticals.VERTICALS_CONTRACT_VERSION);
  assert.equal(fp.lake_surface_async, 'src/pattern-lake.js#extractVerticalFingerprint');

  const bad = verticals.verticalFingerprintStub('../secret@example.com\n');
  const badJson = JSON.stringify(bad);
  assert.equal(bad.vertical, 'unknown');
  assert.equal(badJson.includes('secret@example.com'), false);
  assert.equal(badJson.includes('../'), false);
});

test('W732 vertical routes pin public discovery and owner-only registration', async () => {
  const app = makeApp();
  const tenant = provisionTenant(`w732-human-${Date.now()}-${Math.random().toString(16).slice(2)}`, {
    plan: 'enterprise',
    quota: 100000,
    kind: 'human',
    email: `w732-${Date.now()}@example.com`,
  });

  await withListening(app, async (base) => {
    const list = await jsonFetch(base, '/v1/verticals');
    assert.equal(list.res.status, 200);
    assert.equal(list.body.ok, true);
    assert.equal(list.body.contract_version, verticals.VERTICALS_CONTRACT_VERSION);
    assert.equal(list.body.total, 5);

    const unknown = await jsonFetch(base, '/v1/verticals/unknown');
    assert.equal(unknown.res.status, 404);
    assert.equal(unknown.body.error, 'unknown_vertical');
    assert.equal(unknown.body.id, 'unknown');
    assert.equal(unknown.body.contract_version, verticals.VERTICALS_CONTRACT_VERSION);

    const anonFingerprint = await jsonFetch(base, '/v1/verticals/finance/fingerprint');
    assert.equal(anonFingerprint.res.status, 401);

    const fingerprint = await jsonFetch(base, '/v1/verticals/finance/fingerprint', tenant.api_key);
    assert.equal(fingerprint.res.status, 200);
    assert.equal(fingerprint.body.error, 'w757_not_shipped');
    assert.equal(fingerprint.body.vertical, 'finance');
    assert.equal(fingerprint.body.contract_version, verticals.VERTICALS_CONTRACT_VERSION);

    const registered = await jsonFetch(base, '/v1/verticals/register-stubs', tenant.api_key, {
      method: 'POST',
      body: JSON.stringify({ publisher: '../bad-publisher@example.com' }),
    });
    assert.equal(registered.res.status, 200);
    assert.equal(registered.body.ok, true);
    assert.equal(registered.body.registered.length, 5);
    assert.equal(registered.body.contract_version, verticals.VERTICALS_CONTRACT_VERSION);

    const legal = await marketplaceStore.getListingByCid('pending_legal');
    assert.equal(legal.publisher_id, verticals.VERTICALS_DEFAULT_PUBLISHER_ID);
    assert.equal(legal.manifest.contract_version, verticals.VERTICALS_CONTRACT_VERSION);
  });
});
