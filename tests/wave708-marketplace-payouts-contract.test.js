// W708 - direct contract/security test for src/marketplace-payouts.js.
//
// The payout surface is forecast-only, but it is still a money-facing ledger.
// These tests pin bounded accounting, hash-bound revenue rows, publisher
// conflict handling, audit-chain payloads, and idempotent payout-cycle replay.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w708-marketplace-payouts-'));
process.env.KOLM_DATA_DIR = path.join(TEST_HOME, '.kolm');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.KOLM_STORE_DRIVER = 'jsonl';
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
process.env.RECIPE_RECEIPT_SECRET = 'w708_marketplace_payouts_test_secret_32b';

after(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.KOLM_DATA_DIR;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.KOLM_STORE_DRIVER;
  delete process.env.KOLM_EVENT_STORE_DRIVER;
  delete process.env.RECIPE_RECEIPT_SECRET;
});

let moduleCache = null;
async function modules() {
  if (!moduleCache) {
    const [payouts, eventStore, audit, store] = await Promise.all([
      import('../src/marketplace-payouts.js'),
      import('../src/event-store.js'),
      import('../src/audit.js'),
      import('../src/store.js'),
    ]);
    moduleCache = { payouts, eventStore, audit, store };
  }
  return moduleCache;
}

async function resetStores() {
  const mods = await modules();
  mods.eventStore._resetForTests();
  mods.store.reset();
  fs.rmSync(process.env.KOLM_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  mods.eventStore._resetForTests();
  mods.store.reset();
  return mods;
}

test('W708 source pins payout constants, hash binding, and package depth wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'marketplace-payouts.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(src, /MARKETPLACE_PAYOUTS_CONTRACT_VERSION\s*=\s*'w708-v1'/);
  assert.match(src, /MARKETPLACE_PAYOUTS_LIMITS/);
  assert.match(src, /MAX_REVENUE_MICRO_USD:\s*9_000_000_000_000_000/);
  assert.match(src, /request_hash:\s*payload\.revenue_body_sha256/);
  assert.match(src, /response_hash:\s*hashRevenueAppendResponse\(payload\)/);
  assert.match(src, /payload:\s*\{/);
  assert.doesNotMatch(src, /attributes:\s*\{[\s\S]{0,800}marketplace\.payout/);
  assert.doesNotMatch(src, /audit best-effort; never fail the cycle/);
  assert.equal(
    pkg.scripts['verify:marketplace-payouts'],
    'node --test --test-concurrency=1 tests/wave708-marketplace-payouts-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:pii-bakeoff-scan && npm run verify:marketplace-payouts && npm run verify:marketplace-routes/,
  );
});

test('W708 calcPayout preserves totals and refuses non-finite accounting drift', async () => {
  const { payouts } = await resetStores();

  const split = payouts.calcPayout({ id: 'listing-A', publisher_tenant_id: 'pub-A' }, 101);
  assert.equal(split.revenue_micro_usd, 101);
  assert.equal(split.publisher_micro_usd, 70);
  assert.equal(split.platform_micro_usd, 31);
  assert.equal(split.publisher_micro_usd + split.platform_micro_usd, split.revenue_micro_usd);
  assert.equal(split.contract_version, 'w708-v1');

  const hostile = payouts.calcPayout({ id: '../bad', publisher_tenant_id: 'pub-A' }, Number.POSITIVE_INFINITY);
  assert.equal(hostile.listing_id, null);
  assert.equal(hostile.revenue_micro_usd, 0);
  assert.equal(Number.isFinite(hostile.publisher_micro_usd), true);

  const capped = payouts.calcPayout(
    { id: 'listing-cap', publisher_tenant_id: 'pub-cap' },
    payouts.MARKETPLACE_PAYOUTS_LIMITS.MAX_REVENUE_MICRO_USD + 1000,
  );
  assert.equal(capped.revenue_micro_usd, payouts.MARKETPLACE_PAYOUTS_LIMITS.MAX_REVENUE_MICRO_USD);
  assert.equal(capped.publisher_micro_usd + capped.platform_micro_usd, capped.revenue_micro_usd);
});

test('W708 recordRevenue writes bounded hash-receipted event-store rows', async () => {
  const { payouts, eventStore } = await resetStores();

  const payload = await payouts.recordRevenue({
    listing_id: 'listing_hash_001',
    publisher_tenant_id: 'pub_hash_001',
    micro_usd: '123.9',
  });

  assert.equal(payload.listing_id, 'listing_hash_001');
  assert.equal(payload.publisher_tenant_id, 'pub_hash_001');
  assert.equal(payload.micro_usd, 123);
  assert.equal(payload.contract_version, 'w708-v1');
  assert.match(payload.revenue_body_sha256, /^[a-f0-9]{64}$/);

  const rows = await eventStore.listEvents({
    provider: payouts.MARKETPLACE_REVENUE_PROVIDER,
    limit: 0,
    order: 'asc',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].namespace, payouts.MARKETPLACE_REVENUE_NAMESPACE);
  assert.equal(rows[0].tenant_id, 'pub_hash_001');
  assert.equal(rows[0].request_hash, payload.revenue_body_sha256);
  assert.match(rows[0].response_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(rows[0].feedback), payload);

  assert.equal(await payouts.recordRevenue({ listing_id: '../escape', publisher_tenant_id: 'pub', micro_usd: 1 }), null);
  assert.equal(await payouts.recordRevenue({
    listing_id: 'listing_overflow',
    publisher_tenant_id: 'pub',
    micro_usd: payouts.MARKETPLACE_PAYOUTS_LIMITS.MAX_REVENUE_MICRO_USD + 1,
  }), null);
  assert.equal((await eventStore.listEvents({ provider: payouts.MARKETPLACE_REVENUE_PROVIDER, limit: 0 })).length, 1);
});

test('W708 payoutCycle skips tamper/conflicts, audits payloads, and is idempotent', async () => {
  const { payouts, eventStore, audit } = await resetStores();

  await payouts.recordRevenue({ listing_id: 'listing-a', publisher_tenant_id: 'pub_a', micro_usd: 101 });
  await payouts.recordRevenue({ listing_id: 'listing-a', publisher_tenant_id: 'pub_a', micro_usd: 99 });
  await payouts.recordRevenue({ listing_id: 'listing-b', publisher_tenant_id: 'pub_b', micro_usd: 101 });
  await payouts.recordRevenue({ listing_id: 'listing-conflict', publisher_tenant_id: 'pub_conflict_a', micro_usd: 500 });
  await payouts.recordRevenue({ listing_id: 'listing-conflict', publisher_tenant_id: 'pub_conflict_b', micro_usd: 500 });
  await eventStore.appendEvent({
    tenant_id: 'pub_tamper',
    namespace: payouts.MARKETPLACE_REVENUE_NAMESPACE,
    provider: payouts.MARKETPLACE_REVENUE_PROVIDER,
    status: 'ok',
    feedback: JSON.stringify({
      listing_id: 'listing-tamper',
      publisher_tenant_id: 'pub_tamper',
      micro_usd: 999,
      revenue_body_sha256: '0'.repeat(64),
      version: payouts.MARKETPLACE_PAYOUTS_VERSION,
      contract_version: payouts.MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
    }),
  });

  const out = await payouts.payoutCycle('*');
  assert.equal(out.ok, true);
  assert.equal(out.contract_version, 'w708-v1');
  assert.equal(out.dispatched, false);
  assert.equal(out.listing_count, 2);
  assert.equal(out.audit_rows_appended, 2);
  assert.equal(out.audit_rows_existing, 0);
  assert.equal(out.skipped.integrity_mismatch, 1);
  assert.equal(out.skipped.publisher_conflict, 1);
  assert.deepEqual(out.rows.map((row) => row.listing_id), ['listing-a', 'listing-b']);
  assert.match(out.cycle_digest, /^[a-f0-9]{64}$/);

  const [a, b] = out.rows;
  assert.equal(a.revenue_micro_usd, 200);
  assert.equal(a.publisher_micro_usd, 140);
  assert.equal(a.platform_micro_usd, 60);
  assert.equal(a.revenue_event_count, 2);
  assert.match(a.payout_id, /^[a-f0-9]{64}$/);
  assert.equal(b.publisher_micro_usd + b.platform_micro_usd, b.revenue_micro_usd);

  const auditA = audit.listAuditEvents('pub_a', { op: payouts.AUDIT_OPS.MARKETPLACE_PAYOUT });
  assert.equal(auditA.length, 1);
  assert.equal(auditA[0].payload.payout_id, a.payout_id);
  assert.equal(auditA[0].payload.dispatched, false);
  assert.equal(auditA[0].payload.revenue_event_count, 2);
  assert.equal(audit.verifyAuditChain('pub_a').ok, true);
  assert.equal(audit.verifyAuditChain('pub_b').ok, true);

  const replay = await payouts.payoutCycle('*');
  assert.equal(replay.ok, true);
  assert.equal(replay.audit_rows_appended, 0);
  assert.equal(replay.audit_rows_existing, 2);
  assert.equal(audit.listAuditEvents('pub_a', { op: payouts.AUDIT_OPS.MARKETPLACE_PAYOUT }).length, 1);
  assert.equal(audit.listAuditEvents('pub_b', { op: payouts.AUDIT_OPS.MARKETPLACE_PAYOUT }).length, 1);
});

test('W708 payoutCycle rejects invalid periods without writing audit rows', async () => {
  const { payouts, audit } = await resetStores();
  await payouts.recordRevenue({ listing_id: 'listing-period', publisher_tenant_id: 'pub_period', micro_usd: 100 });

  const out = await payouts.payoutCycle('2026-99');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_period');
  assert.equal(out.dispatched, false);
  assert.deepEqual(out.rows, []);
  assert.equal(audit.listAuditEvents('pub_period', { op: payouts.AUDIT_OPS.MARKETPLACE_PAYOUT }).length, 0);
});
