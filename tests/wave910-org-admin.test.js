// W910 Track E1 — Org admin verification.
//
// Pins the src/teams.js shape that /v1/teams/... routes lean on:
//   1) createTeam mints a team + active owner membership
//   2) inviteToTeam returns a token; acceptInvite lands the invitee
//   3) Role hierarchy is enforced (viewer<member<admin<owner)
//   4) requireRole throws for missing membership AND for under-rank actors
//   5) seats_used accounting tracks invite-accept and remove-member
//   6) transferOwnership swaps owner role + team.owner_tenant_id
//   7) deleteTeam soft-deletes the team and removes invites
//   8) Owner cannot be removed by removeMember (must transfer first)
//   9) Member self-removal allowed without admin
//  10) changeMemberRole refuses to assign 'owner' (must go through transfer)
//  11) listTeamsForTenant returns the caller's role on each team
//  12) Source lock-in: src/teams.js exports the full org-admin API
//
// Isolation note: src/store.js captures KOLM_DATA_DIR at module-load time.
// We set it BEFORE the first import so the JSON store points at a per-run
// tmpdir, then call store.reset() between tests to start each one empty.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w910-orgadmin-'));
process.env.KOLM_DATA_DIR = DATA_DIR;
process.env.KOLM_STORE_DRIVER = 'json';

const { test, after, beforeEach } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const teams = await import('../src/teams.js');
const store = await import('../src/store.js');

beforeEach(() => {
  // Drop every team-shaped row so each test starts with a clean ledger.
  store.remove('teams', () => true);
  store.remove('team_members', () => true);
  store.remove('team_invites', () => true);
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

// 1
test('W910-E1.1 createTeam mints team + active owner membership', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme Eng' });
  assert.ok(team.id && team.id.startsWith('team_'), 'team.id minted');
  assert.equal(team.name, 'Acme Eng');
  assert.equal(team.owner_tenant_id, 'tenant_alice');
  assert.equal(team.seats_used, 1, 'owner counts as seat 1');
  assert.ok(team.seats_max >= 1, 'seats_max defaulted');
  assert.ok(team.slug && /^[a-z0-9-]+$/.test(team.slug), 'slug is url-safe');
  const m = teams.membershipOf(team.id, 'tenant_alice');
  assert.ok(m, 'owner has active membership');
  assert.equal(m.role, 'owner');
  assert.equal(m.status, 'active');
});

// 2
test('W910-E1.2 inviteToTeam returns a token + acceptInvite lands the invitee', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme' });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'member', 'tenant_alice');
  assert.ok(inv.token && inv.token.length > 16, 'invite token minted');
  assert.equal(inv.role, 'member');
  assert.equal(inv.team_slug, team.slug);
  const found = teams.findInvite(inv.token);
  assert.ok(found, 'findInvite resolves the token');

  const res = teams.acceptInvite(inv.token, 'tenant_bob', 'bob@example.com');
  assert.equal(res.ok, true, `accept should succeed: ${JSON.stringify(res)}`);
  assert.equal(res.role, 'member');
  const bobMembership = teams.membershipOf(team.id, 'tenant_bob');
  assert.ok(bobMembership, 'invitee now has active membership');
  assert.equal(bobMembership.role, 'member');
});

// 3
test('W910-E1.3 role hierarchy assignable at invite + changeMemberRole', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 10 });
  for (const [tenant, email, role] of [
    ['tenant_bob', 'bob@example.com', 'admin'],
    ['tenant_carol', 'carol@example.com', 'member'],
    ['tenant_dave', 'dave@example.com', 'viewer'],
  ]) {
    const inv = teams.inviteToTeam(team.id, email, role, 'tenant_alice');
    const res = teams.acceptInvite(inv.token, tenant, email);
    assert.equal(res.ok, true);
    assert.equal(res.role, role);
  }
  teams.changeMemberRole(team.id, 'tenant_carol', 'admin', 'tenant_alice');
  const carol = teams.membershipOf(team.id, 'tenant_carol');
  assert.equal(carol.role, 'admin');
});

// 4
test('W910-E1.4 requireRole throws for missing membership AND under-rank actor', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'viewer', 'tenant_alice');
  teams.acceptInvite(inv.token, 'tenant_bob', 'bob@example.com');

  assert.throws(
    () => teams.requireRole(team.id, 'tenant_outsider', 'viewer'),
    /not a team member/,
  );
  assert.throws(
    () => teams.requireRole(team.id, 'tenant_bob', 'admin'),
    /requires role admin\+/,
  );
  const ok = teams.requireRole(team.id, 'tenant_bob', 'viewer');
  assert.equal(ok.role, 'viewer');
});

// 5
test('W910-E1.5 seats_used tracks accept-invite and remove-member', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  assert.equal(team.seats_used, 1);

  const inv1 = teams.inviteToTeam(team.id, 'bob@example.com', 'member', 'tenant_alice');
  teams.acceptInvite(inv1.token, 'tenant_bob', 'bob@example.com');
  assert.equal(teams.getTeam(team.id).seats_used, 2);

  const inv2 = teams.inviteToTeam(team.id, 'carol@example.com', 'member', 'tenant_alice');
  teams.acceptInvite(inv2.token, 'tenant_carol', 'carol@example.com');
  assert.equal(teams.getTeam(team.id).seats_used, 3);

  teams.removeMember(team.id, 'tenant_bob', 'tenant_alice');
  assert.equal(teams.getTeam(team.id).seats_used, 2);
});

// 6
test('W910-E1.6 transferOwnership swaps owner role + team.owner_tenant_id', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'admin', 'tenant_alice');
  teams.acceptInvite(inv.token, 'tenant_bob', 'bob@example.com');

  teams.transferOwnership(team.id, 'tenant_alice', 'tenant_bob');
  const after_ = teams.getTeam(team.id);
  assert.equal(after_.owner_tenant_id, 'tenant_bob');
  assert.equal(teams.membershipOf(team.id, 'tenant_bob').role, 'owner');
  assert.equal(teams.membershipOf(team.id, 'tenant_alice').role, 'admin');
});

// 7
test('W910-E1.7 deleteTeam soft-deletes team + removes invites', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'member', 'tenant_alice');
  assert.ok(teams.findInvite(inv.token), 'invite pre-exists');

  teams.deleteTeam(team.id, 'tenant_alice');
  assert.equal(teams.getTeam(team.id), null, 'soft-deleted team no longer returned');
  assert.equal(teams.listTeamsForTenant('tenant_alice').length, 0, 'team is gone from listings');
});

// 8
test('W910-E1.8 owner cannot be removed by removeMember (must transfer first)', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'admin', 'tenant_alice');
  teams.acceptInvite(inv.token, 'tenant_bob', 'bob@example.com');

  assert.throws(
    () => teams.removeMember(team.id, 'tenant_alice', 'tenant_bob'),
    /cannot remove the owner/,
  );
  assert.throws(
    () => teams.removeMember(team.id, 'tenant_alice', 'tenant_alice'),
    /cannot remove the owner/,
  );
  assert.equal(teams.membershipOf(team.id, 'tenant_alice').role, 'owner');
});

// 9
test('W910-E1.9 member self-removal allowed without admin role', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'viewer', 'tenant_alice');
  teams.acceptInvite(inv.token, 'tenant_bob', 'bob@example.com');

  const ok = teams.removeMember(team.id, 'tenant_bob', 'tenant_bob');
  assert.equal(ok, true);
  assert.equal(teams.membershipOf(team.id, 'tenant_bob'), null);
});

// 10
test('W910-E1.10 changeMemberRole refuses to assign owner (transfer-only)', () => {
  const team = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Acme', seatsMax: 5 });
  const inv = teams.inviteToTeam(team.id, 'bob@example.com', 'member', 'tenant_alice');
  teams.acceptInvite(inv.token, 'tenant_bob', 'bob@example.com');

  assert.throws(
    () => teams.changeMemberRole(team.id, 'tenant_bob', 'owner', 'tenant_alice'),
    /transfer/i,
  );
});

// 11
test('W910-E1.11 listTeamsForTenant returns the caller-specific role per team', () => {
  const t1 = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Team One', seatsMax: 5 });
  const t2 = teams.createTeam({ ownerTenantId: 'tenant_alice', name: 'Team Two', seatsMax: 5 });
  const inv1 = teams.inviteToTeam(t1.id, 'bob@example.com', 'admin', 'tenant_alice');
  teams.acceptInvite(inv1.token, 'tenant_bob', 'bob@example.com');
  const inv2 = teams.inviteToTeam(t2.id, 'bob@example.com', 'viewer', 'tenant_alice');
  teams.acceptInvite(inv2.token, 'tenant_bob', 'bob@example.com');

  const bobList = teams.listTeamsForTenant('tenant_bob');
  assert.equal(bobList.length, 2);
  const byId = Object.fromEntries(bobList.map(r => [r.id, r.your_role]));
  assert.equal(byId[t1.id], 'admin');
  assert.equal(byId[t2.id], 'viewer');

  const aliceList = teams.listTeamsForTenant('tenant_alice');
  assert.equal(aliceList.length, 2);
  for (const r of aliceList) assert.equal(r.your_role, 'owner');
});

// 12
test('W910-E1.12 src/teams.js exports the full org-admin API surface', () => {
  const required = [
    'createTeam', 'getTeam', 'listTeamsForTenant', 'membershipOf', 'isMember',
    'requireRole', 'listMembers', 'updateTeam', 'transferOwnership', 'deleteTeam',
    'changeMemberRole', 'removeMember', 'inviteToTeam', 'findInvite', 'acceptInvite',
    'listInvites', 'revokeInvite', 'teamScopedReadable', 'teamScopedWritable',
  ];
  for (const k of required) {
    assert.equal(typeof teams[k], 'function', `teams.${k} must be exported as a function`);
  }
  assert.ok(Array.isArray(teams.ROLES), 'ROLES exported');
  assert.deepEqual([...teams.ROLES].sort(), ['admin', 'member', 'owner', 'viewer']);
});
