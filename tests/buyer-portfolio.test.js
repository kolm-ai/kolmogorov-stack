// tests/buyer-portfolio.test.js
//
// OFFER #7 Buyer Portfolio Dashboard - unit coverage for src/buyer-portfolio.js.
//
// The module is fully dependency-injected: it takes an explicit `store` that
// exposes insert / update / findByField / id / resolveTrust. These tests drive
// it with a FAKE in-memory store + a FAKE resolveTrust, so they never touch the
// real JSON / sqlite tables and stay deterministic with no spawned server.
//
// Coverage:
//   * watched slugs resolve to a portfolio view with the correct per-vendor
//     fields (readiness_pct, evidence_tier, last_attested_at, delta_since_prev);
//   * freshness classification at the exact day boundaries: fresh < 8d,
//     stale < 35d, lapsed beyond - plus the resolver's own `lapsed` flag winning;
//   * the act-on-me-first sort order (lapsed > stale > fresh, then lowest
//     readiness, then name);
//   * tenant fencing (another tenant's watch rows never appear);
//   * an unresolved slug degrades to a visible 'lapsed' vendor, never a drop;
//   * addWatch idempotency on (tenant, slug) + slug validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addWatch,
  buildPortfolioView,
  BUYER_WATCHLIST_TABLE,
} from '../src/buyer-portfolio.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-11T00:00:00.000Z');

// --- A minimal in-memory store matching the injected surface ---------------
function makeFakeStore(trustMap = {}) {
  const tables = new Map();
  let seq = 0;
  const t = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  return {
    _tables: tables,
    id: (prefix = 'id') => `${prefix}_${++seq}`,
    insert: (table, row) => { t(table).push(row); return row; },
    update: (table, predicate, patch) => {
      let n = 0;
      for (const row of t(table)) { if (predicate(row)) { Object.assign(row, patch); n++; } }
      return n;
    },
    findByField: (table, field, value) => t(table).filter((r) => r && r[field] === value),
    // Fake resolveTrust: look the slug up in the supplied map. A missing slug
    // returns null (mirrors the real resolver's "no published report" path).
    resolveTrust: (slug) => (Object.prototype.hasOwnProperty.call(trustMap, slug) ? trustMap[slug] : null),
  };
}

// Build a resolveTrust hit out of a signed-report envelope + freshness inputs.
function hit({ name, readiness, grade, ageDays, lapsed = false, readinessChange = null }) {
  const generated_at = new Date(NOW - ageDays * DAY_MS).toISOString();
  const envelope = {
    summary: { readiness_pct: readiness },
    evidence_tier: grade == null ? null : { grade },
    subject: { name },
    generated_at,
  };
  const h = { envelope, lapsed, last_run_at: generated_at, kind: 'continuous', report_id: 'asrr_x', subject: name };
  if (readinessChange != null) h.drift = { readiness_change: readinessChange };
  return h;
}

test('watched slugs resolve to a sorted portfolio view with correct fields', () => {
  const trust = {
    slugFresh: hit({ name: 'Vendor Fresh', readiness: 91, grade: 'A', ageDays: 2, readinessChange: 4 }),
    slugStale: hit({ name: 'Vendor Stale', readiness: 70, grade: 'B', ageDays: 20 }),
    slugLapsed: hit({ name: 'Vendor Lapsed', readiness: 55, grade: 'C', ageDays: 60 }),
  };
  const store = makeFakeStore(trust);
  const tenant = 'ten_buyer';
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'bw_1', tenant_id: tenant, trust_slug: 'slugFresh', label: 'Fresh Co' });
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'bw_2', tenant_id: tenant, trust_slug: 'slugStale', label: null });
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'bw_3', tenant_id: tenant, trust_slug: 'slugLapsed', label: 'Lapsed LLC' });

  const view = buildPortfolioView(tenant, store, { now: NOW });
  assert.equal(view.vendors.length, 3);

  // Sort: lapsed first, then stale, then fresh.
  assert.deepEqual(view.vendors.map((v) => v.slug), ['slugLapsed', 'slugStale', 'slugFresh']);
  assert.deepEqual(view.vendors.map((v) => v.freshness), ['lapsed', 'stale', 'fresh']);

  const fresh = view.vendors.find((v) => v.slug === 'slugFresh');
  assert.equal(fresh.name, 'Fresh Co');          // buyer label wins
  assert.equal(fresh.readiness_pct, 91);
  assert.equal(fresh.evidence_tier, 'A');
  assert.equal(fresh.delta_since_prev, 4);
  assert.equal(typeof fresh.last_attested_at, 'string');

  const stale = view.vendors.find((v) => v.slug === 'slugStale');
  assert.equal(stale.name, 'Vendor Stale');       // falls back to signed subject
  assert.equal(stale.evidence_tier, 'B');
  assert.equal(stale.delta_since_prev, null);     // no drift -> null
});

test('freshness classification at the exact day boundaries', () => {
  const trust = {
    sBoundFresh: hit({ name: 'A', readiness: 50, grade: 'B', ageDays: 7 }),   // < 8d  -> fresh
    sJustStale: hit({ name: 'B', readiness: 50, grade: 'B', ageDays: 9 }),    // 8..35 -> stale
    sBoundStale: hit({ name: 'C', readiness: 50, grade: 'B', ageDays: 34 }),  // < 35d -> stale
    sJustLapsed: hit({ name: 'D', readiness: 50, grade: 'B', ageDays: 36 }),  // > 35d -> lapsed
  };
  const store = makeFakeStore(trust);
  const tenant = 'ten_b';
  for (const slug of Object.keys(trust)) {
    store.insert(BUYER_WATCHLIST_TABLE, { id: store.id('bw'), tenant_id: tenant, trust_slug: slug, label: slug });
  }
  const view = buildPortfolioView(tenant, store, { now: NOW });
  const byName = (n) => view.vendors.find((v) => v.slug === n).freshness;
  assert.equal(byName('sBoundFresh'), 'fresh');
  assert.equal(byName('sJustStale'), 'stale');
  assert.equal(byName('sBoundStale'), 'stale');
  assert.equal(byName('sJustLapsed'), 'lapsed');
});

test('the resolver lapsed flag overrides a recent timestamp', () => {
  // A just-attested report from an INACTIVE Continuous subscription is lapsed,
  // not fresh - the resolver's lapsed flag wins over the age bucket.
  const trust = { slugA: hit({ name: 'Inactive', readiness: 88, grade: 'A', ageDays: 1, lapsed: true }) };
  const store = makeFakeStore(trust);
  const tenant = 'ten_c';
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'bw_x', tenant_id: tenant, trust_slug: 'slugA', label: 'Inactive' });
  const view = buildPortfolioView(tenant, store, { now: NOW });
  assert.equal(view.vendors[0].freshness, 'lapsed');
});

test('an unresolved slug becomes a visible lapsed vendor, never a dropped row', () => {
  const store = makeFakeStore({ /* slugGone resolves to nothing */ });
  const tenant = 'ten_d';
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'bw_g', tenant_id: tenant, trust_slug: 'slugGone', label: 'Gone Inc' });
  const view = buildPortfolioView(tenant, store, { now: NOW });
  assert.equal(view.vendors.length, 1);
  const v = view.vendors[0];
  assert.equal(v.name, 'Gone Inc');
  assert.equal(v.freshness, 'lapsed');
  assert.equal(v.readiness_pct, null);
  assert.equal(v.evidence_tier, null);
  assert.equal(v.last_attested_at, null);
});

test('sort breaks ties by lowest readiness then by name within a bucket', () => {
  const trust = {
    sHigh: hit({ name: 'Zeta', readiness: 95, grade: 'A', ageDays: 2 }),
    sLow: hit({ name: 'Alpha', readiness: 60, grade: 'A', ageDays: 2 }),
    sMid: hit({ name: 'Mid', readiness: 60, grade: 'A', ageDays: 2 }),
  };
  const store = makeFakeStore(trust);
  const tenant = 'ten_e';
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'b1', tenant_id: tenant, trust_slug: 'sHigh', label: null });
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'b2', tenant_id: tenant, trust_slug: 'sLow', label: null });
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'b3', tenant_id: tenant, trust_slug: 'sMid', label: null });
  const view = buildPortfolioView(tenant, store, { now: NOW });
  // All fresh; lowest readiness first; the two 60s tie-break by name (Alpha < Mid).
  assert.deepEqual(view.vendors.map((v) => v.slug), ['sLow', 'sMid', 'sHigh']);
});

test('tenant fencing: another tenant watch rows never appear', () => {
  const trust = { sMine: hit({ name: 'Mine', readiness: 80, grade: 'A', ageDays: 2 }) };
  const store = makeFakeStore(trust);
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'm1', tenant_id: 'ten_me', trust_slug: 'sMine', label: 'Mine' });
  store.insert(BUYER_WATCHLIST_TABLE, { id: 'o1', tenant_id: 'ten_other', trust_slug: 'sMine', label: 'Theirs' });
  const view = buildPortfolioView('ten_me', store, { now: NOW });
  assert.equal(view.vendors.length, 1);
  assert.equal(view.vendors[0].name, 'Mine');
});

test('addWatch is idempotent on (tenant, slug) and validates the slug', () => {
  const store = makeFakeStore();
  const tenant = 'ten_w';

  const ok = addWatch(tenant, store, { slug: 'abc123_-', label: 'Acme' });
  assert.equal(ok.ok, true);
  assert.equal(ok.watch.trust_slug, 'abc123_-');
  assert.equal(store.findByField(BUYER_WATCHLIST_TABLE, 'tenant_id', tenant).length, 1);

  // Re-add the same slug with a new label: updates, never duplicates.
  const again = addWatch(tenant, store, { slug: 'abc123_-', label: 'Acme Corp' });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  const rows = store.findByField(BUYER_WATCHLIST_TABLE, 'tenant_id', tenant);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Acme Corp');

  // A bad slug (spaces / illegal chars / too long) is rejected.
  assert.equal(addWatch(tenant, store, { slug: 'has space' }).error, 'invalid_slug');
  assert.equal(addWatch(tenant, store, { slug: 'a'.repeat(200) }).error, 'invalid_slug');
  assert.equal(addWatch(tenant, store, { slug: '' }).error, 'invalid_slug');
  assert.equal(addWatch('', store, { slug: 'abc' }).error, 'no_tenant');
});
