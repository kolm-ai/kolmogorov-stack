// W688 - direct contract/security test for src/marketplace-store.js.
//
// The W737 store is a money-facing listing ledger. It must not silently lose
// rows through the event-schema feedback cap, let one publisher overwrite
// another publisher's CID, or trust edited event-store JSON as public truth.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w688-marketplace-store-'));
process.env.KOLM_DATA_DIR = path.join(TEST_HOME, '.kolm');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';

after(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.KOLM_DATA_DIR;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.KOLM_EVENT_STORE_DRIVER;
});

let moduleCache = null;
async function modules() {
  if (!moduleCache) {
    const [store, eventStore] = await Promise.all([
      import('../src/marketplace-store.js'),
      import('../src/event-store.js'),
    ]);
    moduleCache = { store, eventStore };
  }
  return moduleCache;
}

async function resetStores() {
  const mods = await modules();
  mods.store._resetForTests();
  mods.eventStore._resetForTests();
  fs.rmSync(process.env.KOLM_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  mods.store._resetForTests();
  mods.eventStore._resetForTests();
  return mods;
}

function baseListing(overrides = {}) {
  return {
    cid: overrides.cid || 'cid_store_ok_001',
    publisher_id: overrides.publisher_id || 'publisher_A',
    vertical: overrides.vertical || 'code',
    task_type: overrides.task_type || 'generation',
    hardware_target: overrides.hardware_target || 'cpu',
    price_micro_usd_per_call: overrides.price_micro_usd_per_call ?? 2500,
    manifest: overrides.manifest || { name: 'Store Test Model', k_score: 0.93 },
  };
}

async function listingEvents(eventStore) {
  const { MARKETPLACE_LISTING_PROVIDER } = await import('../src/marketplace-store.js');
  return eventStore.listEvents({ provider: MARKETPLACE_LISTING_PROVIDER, limit: 0, order: 'asc' });
}

test('W688 marketplace-store static wiring pins version and depth verifier', () => {
  const source = fs.readFileSync(path.join(REPO, 'src', 'marketplace-store.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(source, /MARKETPLACE_STORE_VERSION\s*=\s*'w737-store-v2'/);
  assert.match(source, /MAX_FEEDBACK_CHARS:\s*4096/);
  assert.match(source, /listing_body_sha256/);
  assert.match(source, /LISTING_CONFLICT/);
  assert.match(pkg.scripts['verify:marketplace-store'], /wave688-marketplace-store-contract\.test\.js/);
  assert.match(pkg.scripts['verify:depth'], /verify:marketplace-store/);
});

test('W688 marketplace-store writes bounded hash-receipted public listings', async () => {
  const { store, eventStore } = await resetStores();
  const listing = await store.registerArtifact(baseListing({
    manifest: {
      name: ' Frontier Model \n',
      k_score: { composite: 1.7 },
      api_key: 'sk_should_not_be_public',
      private_key: '-----BEGIN PRIVATE KEY-----',
      nested: {
        safe: 'kept',
        constructor: { polluted: true },
      },
      description: 'a'.repeat(900),
      tags: Array.from({ length: 80 }, (_, i) => `tag-${i}`),
    },
  }));

  assert.equal(listing.store_version, store.MARKETPLACE_STORE_VERSION);
  assert.equal(listing.integrity_status, 'hash_verified');
  assert.equal(listing.k_score, 1);
  assert.equal(listing.name, 'Frontier Model');
  assert.equal(listing.manifest.api_key, undefined);
  assert.equal(listing.manifest.private_key, undefined);
  assert.equal(Object.hasOwn(listing.manifest.nested, 'constructor'), false);
  assert.equal(listing.manifest.nested.safe, 'kept');
  assert.equal(listing.manifest.description.length, store.MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_STRING_CHARS);
  assert.equal(listing.manifest.tags.length, store.MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_ARRAY);
  assert.match(listing.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(listing.listing_body_sha256, /^[a-f0-9]{64}$/);
  assert.match(listing.listing_receipt_sha256, /^[a-f0-9]{64}$/);

  const rows = await listingEvents(eventStore);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].namespace, store.MARKETPLACE_LISTING_NAMESPACE);
  assert.equal(rows[0].request_hash, listing.listing_body_sha256);
  assert.equal(rows[0].response_hash, listing.listing_receipt_sha256);
  assert.ok(rows[0].feedback.length <= store.MARKETPLACE_STORE_LIMITS.MAX_FEEDBACK_CHARS);

  const browse = await store.listArtifactsForBrowse({ tenant_id: 'publisher_A', limit: 5000 });
  assert.equal(browse.total, 1);
  assert.equal(browse.rows[0].cid, listing.cid);
  assert.equal(browse.rows[0].publisher_id, 'publisher_A');
  assert.equal(browse.rows[0].integrity_status, 'hash_verified');
  assert.equal(browse.integrity.hashed, 1);
});

test('W688 marketplace-store enforces idempotency and CID ownership', async () => {
  const { store, eventStore } = await resetStores();
  const first = await store.registerArtifact(baseListing({ cid: 'cid_store_conflict_001' }));
  const replay = await store.registerArtifact(baseListing({ cid: 'cid_store_conflict_001' }));
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.listing_body_sha256, first.listing_body_sha256);
  assert.equal((await listingEvents(eventStore)).length, 1);

  await assert.rejects(
    () => store.registerArtifact(baseListing({
      cid: 'cid_store_conflict_001',
      publisher_id: 'publisher_B',
    })),
    (err) => err && err.code === 'LISTING_CONFLICT',
  );
  assert.equal((await listingEvents(eventStore)).length, 1);

  const updated = await store.registerArtifact(baseListing({
    cid: 'cid_store_conflict_001',
    price_micro_usd_per_call: 9999,
  }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.previous_listing_sha256, first.listing_body_sha256);
  assert.equal(updated.price_micro_usd_per_call, 9999);
  assert.equal((await listingEvents(eventStore)).length, 2);

  const current = await store.getListingByCid('cid_store_conflict_001');
  assert.equal(current.price_micro_usd_per_call, 9999);
  assert.equal(current.revision, 2);
});

test('W688 marketplace-store rejects oversize payloads and unsafe identifiers before append', async () => {
  const { store, eventStore } = await resetStores();
  await assert.rejects(
    () => store.registerArtifact(baseListing({
      cid: '../escape',
    })),
    (err) => err && err.code === 'LISTING_INVALID' && /path/.test(err.message),
  );
  await assert.rejects(
    () => store.registerArtifact(baseListing({
      cid: 'cid_store_oversize_001',
      manifest: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_${i}`, 'x'.repeat(512)])),
    })),
    (err) => err && err.code === 'LISTING_INVALID' && /manifest public JSON/.test(err.message),
  );
  await assert.rejects(
    () => store.registerArtifact(baseListing({
      cid: 'cid_store_negative_001',
      price_micro_usd_per_call: -1,
    })),
    (err) => err && err.code === 'LISTING_INVALID' && /non-negative/.test(err.message),
  );
  assert.equal((await listingEvents(eventStore)).length, 0);
});

test('W688 marketplace-store drops tampered v2 rows on replay', async () => {
  const { store, eventStore } = await resetStores();
  await store.registerArtifact(baseListing({ cid: 'cid_store_tamper_001' }));
  const info = eventStore.storeInfo();
  const jsonlPath = info.jsonl_path;
  assert.ok(jsonlPath && fs.existsSync(jsonlPath), 'jsonl event-store path must exist for tamper test');

  const row = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim());
  const feedback = JSON.parse(row.feedback);
  feedback.price_micro_usd_per_call = 1;
  row.feedback = JSON.stringify(feedback);
  fs.writeFileSync(jsonlPath, JSON.stringify(row) + '\n', 'utf8');

  store._resetForTests();
  const browse = await store.listArtifactsForBrowse();
  assert.equal(browse.total, 0);
  assert.equal(browse.all_count, 0);
  assert.equal(await store.getListingByCid('cid_store_tamper_001'), null);
});
