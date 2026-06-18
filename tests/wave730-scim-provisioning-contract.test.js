// W730 - direct contract test for src/scim-provisioning.js.
//
// The route-level SAML/SCIM suite proves token auth and HTTP envelopes. This
// test pins the provisioning atom itself: bounded SCIM inputs, tenant-fenced
// deprovision side effects, and deterministic SCIM Group -> RBAC reconciliation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w730-scim-'));
process.env.KOLM_DATA_DIR = DATA_DIR;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ENV = 'test';

const { test, beforeEach, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const scim = await import('../src/scim-provisioning.js');
const store = await import('../src/store.js');

const TENANT_A = 'tenant_w730_a';
const TENANT_B = 'tenant_w730_b';
const USER_A = 'scim_user_w730_a';
const EMAIL_A = 'member.w730@example.com';

beforeEach(() => {
  for (const table of [scim.USERS, scim.GROUPS, 'org_members', 'api_keys', 'tenants']) {
    store.remove(table, () => true);
  }
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

function readPackage() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
}

function readSource() {
  return fs.readFileSync(new URL('../src/scim-provisioning.js', import.meta.url), 'utf8');
}

function seedUser({
  tenantId = TENANT_A,
  id = USER_A,
  userName = EMAIL_A,
  active = true,
} = {}) {
  const now = '2026-06-18T00:00:00.000Z';
  return store.insert(scim.USERS, {
    id,
    tenant_id: tenantId,
    externalId: 'okta-w730',
    userName,
    active,
    name: { givenName: 'Member', familyName: 'W730' },
    displayName: 'Member W730',
    emails: [{ value: userName, primary: true }],
    groups: [],
    created_at: now,
    updated_at: now,
  });
}

function rowById(table, id) {
  return store.findOne(table, (row) => row && row.id === id);
}

function memberFor(tenantId, email) {
  return store.findByField('org_members', 'tenant_id', tenantId)
    .find((row) => String(row.email || '').toLowerCase() === String(email).toLowerCase()) || null;
}

function throwsScim(fn, status, scimType) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'ScimError');
    assert.equal(err.status, status);
    if (scimType) assert.equal(err.scimType, scimType);
    return true;
  });
}

test('W730 SCIM provisioning exposes a direct depth verifier and bounded contract', () => {
  const pkg = readPackage();
  const source = readSource();

  assert.equal(scim.SCIM_PROVISIONING_CONTRACT_VERSION, 'w730-scim-v1');
  assert.ok(scim.SCIM_PROVISIONING_LIMITS.max_patch_operations <= 32);
  assert.ok(scim.SCIM_PROVISIONING_LIMITS.max_group_members <= 256);
  assert.equal(
    pkg.scripts['verify:scim-provisioning'],
    'node --test --test-concurrency=1 tests/wave730-scim-provisioning-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:savings-routes && npm run verify:scim-provisioning && npm run verify:trend-extract && npm run verify:verticals && npm run verify:video-bakeoff && npm run verify:video-capture && npm run verify:vision-capture && npm run verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /SCIM_PROVISIONING_CONTRACT_VERSION/);
  assert.match(source, /requireTenantId/);
  assert.match(source, /normalizeEmails/);
  assert.match(source, /roleChanged/);
});

test('W730 user mutation rejects unsafe SCIM values before persistence', () => {
  seedUser();

  throwsScim(() => scim.getUser(TENANT_A, '../private/alice@example.com'), 400, 'invalidValue');
  throwsScim(() => scim.patchUser(TENANT_A, USER_A, {
    Operations: [{ op: 'replace', path: 'userName', value: 'not-an-email' }],
  }), 400, 'invalidValue');
  throwsScim(() => scim.replaceUser(TENANT_A, USER_A, { userName: { value: EMAIL_A } }), 400, 'invalidValue');
  throwsScim(() => scim.patchUser(TENANT_A, USER_A, {
    Operations: Array.from({ length: scim.SCIM_PROVISIONING_LIMITS.max_patch_operations + 1 }, () => ({
      op: 'replace',
      path: 'active',
      value: true,
    })),
  }), 400, 'tooMany');

  const row = rowById(scim.USERS, USER_A);
  assert.equal(row.userName, EMAIL_A);
  assert.equal(row.active, true);
});

test('W730 active:false deprovision is tenant-fenced and revokes seats plus member keys', () => {
  seedUser();
  store.insert('tenants', { id: TENANT_A, seats_used: 2 });
  store.insert('org_members', { id: 'mem_a', tenant_id: TENANT_A, email: EMAIL_A, role: 'admin' });
  store.insert('org_members', { id: 'mem_b', tenant_id: TENANT_B, email: EMAIL_A, role: 'owner' });
  store.insert('api_keys', { id: 'key_a', tenant_id: TENANT_A, member_email: EMAIL_A, revoked: false });
  store.insert('api_keys', { id: 'key_b', tenant_id: TENANT_B, member_email: EMAIL_A, revoked: false });

  const out = scim.patchUser(TENANT_A, USER_A, {
    Operations: [{ op: 'replace', path: 'active', value: false }],
  });

  assert.equal(out.deprovisioned, true);
  assert.equal(out.revocation.email, EMAIL_A);
  assert.equal(out.revocation.memberships_removed, 1);
  assert.equal(out.revocation.keys_revoked, 1);
  assert.equal(memberFor(TENANT_A, EMAIL_A), null);
  assert.equal(memberFor(TENANT_B, EMAIL_A).role, 'owner');
  assert.equal(rowById('tenants', TENANT_A).seats_used, 1);
  assert.equal(rowById('api_keys', 'key_a').revoked, true);
  assert.equal(rowById('api_keys', 'key_b').revoked, false);
});

test('W730 SCIM groups rebind RBAC roles without cross-tenant mutation', () => {
  seedUser();
  const group = scim.createGroup(TENANT_A, {
    displayName: 'admin',
    members: [{ value: USER_A, display: 'Member W730' }],
  });
  assert.equal(memberFor(TENANT_A, EMAIL_A).role, 'admin');

  throwsScim(() => scim.patchGroup(TENANT_A, group.id, {
    Operations: [{ op: 'move', path: 'members', value: [{ value: USER_A }] }],
  }), 400, 'invalidValue');

  throwsScim(() => scim.patchGroup(TENANT_B, group.id, {
    Operations: [{ op: 'replace', path: 'displayName', value: 'billing' }],
  }), 404);
  assert.equal(memberFor(TENANT_A, EMAIL_A).role, 'admin');

  const rebound = scim.patchGroup(TENANT_A, group.id, {
    Operations: [{ op: 'replace', path: 'displayName', value: 'billing' }],
  });
  assert.equal(rebound.displayName, 'billing');
  assert.equal(memberFor(TENANT_A, EMAIL_A).role, 'billing');

  scim.patchGroup(TENANT_A, group.id, {
    Operations: [{ op: 'remove', path: `members[value eq "${USER_A}"]` }],
  });
  assert.equal(memberFor(TENANT_A, EMAIL_A).role, 'member');
  assert.equal(scim.getGroup(TENANT_A, group.id).members.length, 0);
});

test('W730 group creation rejects hostile member identifiers before role grants', () => {
  seedUser();

  throwsScim(() => scim.createGroup(TENANT_A, {
    displayName: 'admin',
    members: [{ value: '../private/alice@example.com' }],
  }), 400, 'invalidValue');
  throwsScim(() => scim.createGroup(TENANT_A, {
    displayName: 'x'.repeat(scim.SCIM_PROVISIONING_LIMITS.max_display_name_chars + 1),
    members: [{ value: USER_A }],
  }), 400, 'invalidValue');

  assert.equal(memberFor(TENANT_A, EMAIL_A), null);
  assert.equal(store.findByField(scim.GROUPS, 'tenant_id', TENANT_A).length, 0);
});
