// W910 Track E2 — Compile groups.
//
// Pins src/groups.js as the data layer for `kolm group ...` + `kolm compile
// --group <name>`. Tests bypass HTTP and call the groups module directly so
// the contract is locked in (slug uniqueness within tenant, soft-delete,
// passport-ready descriptor shape, error codes for empty groups + missing
// references).
//
// Isolation: src/store.js captures DATA_DIR at module-load time. We set it
// BEFORE the first import so the JSON store points at a per-run tmpdir, then
// call store.remove() between tests to start each one empty.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w910-groups-'));
process.env.KOLM_DATA_DIR = DATA_DIR;
process.env.KOLM_STORE_DRIVER = 'json';

const { test, after, beforeEach } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const groups = await import('../src/groups.js');
const store = await import('../src/store.js');

beforeEach(() => {
  store.remove('groups', () => true);
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

// 1
test('W910-E2.1 createGroup mints a row with slug + namespaces[] + tenant scope', () => {
  const g = groups.createGroup({
    tenantId: 'tenant_alice',
    name: 'Support All',
    namespaces: 'retail-support, b2b-support, billing-support',
  });
  assert.ok(g.id && g.id.startsWith('group_'), 'group.id minted with group_ prefix');
  assert.equal(g.tenant_id, 'tenant_alice');
  assert.equal(g.name, 'Support All');
  assert.equal(g.slug, 'support-all', 'name slugified to url-safe form');
  assert.deepEqual(g.namespaces, ['retail-support', 'b2b-support', 'billing-support']);
  assert.ok(g.created_at && g.updated_at, 'timestamps populated');
});

// 2
test('W910-E2.2 listGroups returns rows scoped to caller tenant only', () => {
  groups.createGroup({ tenantId: 'tenant_alice', name: 'Alpha', namespaces: ['a'] });
  groups.createGroup({ tenantId: 'tenant_alice', name: 'Beta',  namespaces: ['b'] });
  groups.createGroup({ tenantId: 'tenant_bob',   name: 'Carol', namespaces: ['c'] });

  const aliceList = groups.listGroups('tenant_alice');
  assert.equal(aliceList.length, 2, 'tenant_alice sees its 2 groups');
  assert.deepEqual(aliceList.map(g => g.slug).sort(), ['alpha', 'beta']);

  const bobList = groups.listGroups('tenant_bob');
  assert.equal(bobList.length, 1, 'tenant_bob sees its 1 group');
  assert.equal(bobList[0].slug, 'carol');
});

// 3
test('W910-E2.3 updateGroup supports name + namespaces + add/remove flags', () => {
  const g = groups.createGroup({
    tenantId: 'tenant_alice',
    name: 'Support',
    namespaces: ['retail'],
  });

  let r = groups.updateGroup('tenant_alice', g.slug, { addNamespaces: 'b2b' });
  assert.deepEqual(r.namespaces, ['retail', 'b2b']);

  r = groups.updateGroup('tenant_alice', g.slug, { addNamespaces: ['billing', 'partners'] });
  assert.deepEqual(r.namespaces.sort(), ['b2b', 'billing', 'partners', 'retail']);

  r = groups.updateGroup('tenant_alice', g.slug, { removeNamespaces: 'partners' });
  assert.ok(!r.namespaces.includes('partners'));

  r = groups.updateGroup('tenant_alice', g.slug, { namespaces: ['only-this'] });
  assert.deepEqual(r.namespaces, ['only-this'], '--namespaces wholesale-replaces the set');

  r = groups.updateGroup('tenant_alice', g.slug, { name: 'Renamed Support' });
  assert.equal(r.name, 'Renamed Support');
});

// 4
test('W910-E2.4 deleteGroup soft-deletes and removes from list', () => {
  const g = groups.createGroup({ tenantId: 'tenant_alice', name: 'Doomed' });
  assert.equal(groups.deleteGroup('tenant_alice', g.slug), true);
  assert.equal(groups.getGroup('tenant_alice', g.slug), null, 'deleted group hidden from get');
  assert.equal(groups.listGroups('tenant_alice').length, 0, 'deleted group not in list');
});

// 5
test('W910-E2.5 resolveGroupForCompile returns namespaces + pair counts + total', () => {
  groups.createGroup({
    tenantId: 'tenant_alice',
    name: 'Support All',
    namespaces: ['retail', 'b2b'],
  });
  const fakeCounts = { retail: 240, b2b: 110 };
  const resolved = groups.resolveGroupForCompile('tenant_alice', 'support-all', {
    countPairs: (ns) => fakeCounts[ns],
  });
  assert.equal(resolved.group.slug, 'support-all');
  assert.equal(resolved.group.name, 'Support All');
  assert.deepEqual(resolved.namespaces, ['retail', 'b2b']);
  assert.deepEqual(resolved.pairs_per_namespace, { retail: 240, b2b: 110 });
  assert.equal(resolved.total_pairs, 350);
});

// 6
test('W910-E2.6 resolveGroupForCompile throws code:not_found for missing group', () => {
  assert.throws(
    () => groups.resolveGroupForCompile('tenant_alice', 'never-existed', { countPairs: () => 0 }),
    (e) => e.code === 'not_found' && /not found/.test(e.message),
  );
});

// 7
test('W910-E2.7 passportSourceFromGroup returns the exact passport-ready shape', () => {
  groups.createGroup({
    tenantId: 'tenant_alice',
    name: 'Support All',
    namespaces: ['retail-support', 'b2b-support'],
  });
  const resolved = groups.resolveGroupForCompile('tenant_alice', 'support-all', {
    countPairs: (ns) => ns === 'retail-support' ? 300 : 50,
  });
  const desc = groups.passportSourceFromGroup(resolved);
  assert.equal(desc.source, 'group', 'passport source field === "group"');
  assert.equal(desc.group, 'support-all', 'group slug recorded');
  assert.equal(desc.group_name, 'Support All', 'group name recorded');
  assert.deepEqual(desc.namespaces, ['retail-support', 'b2b-support']);
  assert.deepEqual(desc.pairs_per_namespace, { 'retail-support': 300, 'b2b-support': 50 });
  assert.equal(desc.total_pairs, 350);
});

// 8
test('W910-E2.8 resolveGroupForCompile throws code:empty_group when namespaces is []', () => {
  groups.createGroup({ tenantId: 'tenant_alice', name: 'Empty' });
  assert.throws(
    () => groups.resolveGroupForCompile('tenant_alice', 'empty', { countPairs: () => 0 }),
    (e) => e.code === 'empty_group' && /no namespaces/.test(e.message),
  );
});

// 9
test('W910-E2.9 createGroup auto-disambiguates colliding slugs within a tenant', () => {
  const a = groups.createGroup({ tenantId: 'tenant_alice', name: 'Support' });
  const b = groups.createGroup({ tenantId: 'tenant_alice', name: 'Support' });
  assert.equal(a.slug, 'support');
  assert.notEqual(a.slug, b.slug, 'second group with same name gets a unique slug');
  assert.ok(/^support-/.test(b.slug), 'collision suffix preserves the original stem');
});

// 10
test('W910-E2.10 cross-tenant getGroup is blocked (tenant scoping)', () => {
  const g = groups.createGroup({ tenantId: 'tenant_alice', name: 'Private' });
  assert.ok(groups.getGroup('tenant_alice', g.slug), 'owner can read');
  assert.equal(groups.getGroup('tenant_bob', g.slug), null, 'other tenant gets null');
});

// 11
test('W910-E2.11 src/groups.js exports the full compile-group API surface', () => {
  for (const k of [
    'createGroup', 'getGroup', 'listGroups', 'updateGroup', 'deleteGroup',
    'resolveGroupForCompile', 'passportSourceFromGroup',
  ]) {
    assert.equal(typeof groups[k], 'function', `groups.${k} must be exported as a function`);
  }
});
