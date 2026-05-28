// W918 P5.1 + P5.2 — Lock-in for src/orgs.js + src/rbac.js.
//
// Pins:
//   1) rbac.isValidRole positive + negative
//   2) rbac.can owner-only action
//   3) rbac.requireRole throws on forbidden action
//   4) orgs.createOrg shape + owner is sole member
//   5) addMember authorization gate
//   6) removeMember refuses owner
//   7) setRole demotion ok, admin-promote-to-owner blocked
//   8) transferOwnership swaps roles
//   9) inviteMember + acceptInvite lands the member, consumes the invite
//  10) audit ledger captures org.create + member.add rows
//
// Isolation note: orgs.js reads KOLM_DATA_DIR at call time (lazy resolver),
// so we set the env var BEFORE the dynamic imports and the test still gets a
// per-run tmpdir even if anything else in the process touched the module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.tmpdir(), 'kolm-wave918-orgs-' + Date.now() + '-' + process.pid);
process.env.KOLM_DATA_DIR = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const rbac = await import('../src/rbac.js');
const orgs = await import('../src/orgs.js');

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* deliberate */ }
});

function freshOrg(suffix = '') {
  const ownerId = 'user_owner_' + suffix + '_' + Math.random().toString(36).slice(2, 8);
  const org = orgs.createOrg({
    name: 'Acme ' + suffix,
    ownerUserId: ownerId,
    ownerEmail: ownerId + '@example.com',
  });
  return { org, ownerId };
}

// 1
test('W918 P5.2-1 rbac.isValidRole accepts known roles, rejects unknown', () => {
  assert.equal(rbac.isValidRole('owner'), true);
  assert.equal(rbac.isValidRole('admin'), true);
  assert.equal(rbac.isValidRole('member'), true);
  assert.equal(rbac.isValidRole('billing'), true);
  assert.equal(rbac.isValidRole('xyz'), false);
  assert.equal(rbac.isValidRole(''), false);
  assert.equal(rbac.isValidRole(null), false);
});

// 2
test('W918 P5.2-2 rbac.can gates owner:transfer to owner only', () => {
  assert.equal(rbac.can('owner', 'owner:transfer'), true);
  assert.equal(rbac.can('admin', 'owner:transfer'), false);
  assert.equal(rbac.can('member', 'owner:transfer'), false);
  assert.equal(rbac.can('billing', 'owner:transfer'), false);
});

// 3
test('W918 P5.2-3 rbac.requireRole throws on forbidden action', () => {
  assert.throws(
    () => rbac.requireRole('member', 'member:add'),
    /forbidden:.*member.*member:add/,
  );
  assert.equal(rbac.requireRole('owner', 'member:add'), true);
});

// 4
test('W918 P5.1-4 createOrg returns member_count:1 + owner is sole member', () => {
  const { org, ownerId } = freshOrg('createOrg');
  assert.ok(org.org_id && org.org_id.startsWith('org_'), 'org_id minted with prefix');
  assert.equal(org.member_count, 1);
  assert.equal(org.owner_user_id, ownerId);
  const members = orgs.listMembers(org.org_id);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, ownerId);
  assert.equal(members[0].role, 'owner');
});

// 5
test('W918 P5.1-5 addMember by owner succeeds, addMember by member throws forbidden', () => {
  const { org, ownerId } = freshOrg('addMember');
  const memberId = 'user_member_' + Math.random().toString(36).slice(2, 8);
  const added = orgs.addMember(org.org_id, {
    user_id: memberId,
    email: 'mem@example.com',
    role: 'member',
    acting_user_id: ownerId,
  });
  assert.equal(added.user_id, memberId);
  assert.equal(added.role, 'member');
  assert.equal(orgs.getOrg(org.org_id).member_count, 2);

  assert.throws(
    () => orgs.addMember(org.org_id, {
      user_id: 'user_other',
      email: 'other@example.com',
      role: 'member',
      acting_user_id: memberId,
    }),
    /forbidden:.*member.*member:add/,
  );
});

// 6
test('W918 P5.1-6 removeMember of the owner throws (owner cannot be removed)', () => {
  const { org, ownerId } = freshOrg('removeOwner');
  assert.throws(
    () => orgs.removeMember(org.org_id, ownerId, ownerId),
    /cannot remove the owner/,
  );
  assert.throws(
    () => orgs.removeMember(org.org_id, ownerId + '@example.com', ownerId),
    /cannot remove the owner/,
  );
});

// 7
test('W918 P5.1-7 setRole admin->member by owner ok, admin->owner by admin throws', () => {
  const { org, ownerId } = freshOrg('setRole');
  const adminId = 'user_admin_' + Math.random().toString(36).slice(2, 8);
  orgs.addMember(org.org_id, {
    user_id: adminId,
    email: 'admin@example.com',
    role: 'admin',
    acting_user_id: ownerId,
  });
  const demoted = orgs.setRole(org.org_id, adminId, 'member', ownerId);
  assert.equal(demoted.role, 'member');

  // Re-promote so we can test that the admin cannot promote anyone to owner.
  orgs.setRole(org.org_id, adminId, 'admin', ownerId);
  // Add a second admin so the first admin has a peer to attempt promoting.
  const peerId = 'user_peer_' + Math.random().toString(36).slice(2, 8);
  orgs.addMember(org.org_id, {
    user_id: peerId,
    email: 'peer@example.com',
    role: 'member',
    acting_user_id: ownerId,
  });
  assert.throws(
    () => orgs.setRole(org.org_id, peerId, 'owner', adminId),
    /cannot promote to owner|transfer/i,
  );
});

// 8
test('W918 P5.1-8 transferOwnership by owner swaps roles, prior owner becomes admin', () => {
  const { org, ownerId } = freshOrg('transfer');
  const heirId = 'user_heir_' + Math.random().toString(36).slice(2, 8);
  orgs.addMember(org.org_id, {
    user_id: heirId,
    email: 'heir@example.com',
    role: 'admin',
    acting_user_id: ownerId,
  });
  const updated = orgs.transferOwnership(org.org_id, heirId, ownerId);
  assert.equal(updated.owner_user_id, heirId);
  const members = Object.fromEntries(orgs.listMembers(org.org_id).map(m => [m.user_id, m.role]));
  assert.equal(members[heirId], 'owner');
  assert.equal(members[ownerId], 'admin');
});

// 9
test('W918 P5.1-9 inviteMember + acceptInvite adds member + consumes invite', () => {
  const { org, ownerId } = freshOrg('invite');
  const inv = orgs.inviteMember(org.org_id, {
    email: 'guest@example.com',
    role: 'member',
    actingUserId: ownerId,
  });
  assert.ok(inv.token && inv.token.length >= 24, 'invite token minted');
  assert.equal(inv.consumed_at, null);

  const guestId = 'user_guest_' + Math.random().toString(36).slice(2, 8);
  const accepted = orgs.acceptInvite(inv.token, {
    user_id: guestId,
    email: 'guest@example.com',
  });
  assert.equal(accepted.user_id, guestId);
  assert.equal(accepted.role, 'member');

  const members = orgs.listMembers(org.org_id).map(m => m.user_id);
  assert.ok(members.includes(guestId), 'guest is now a member');

  // Replaying the same token must fail (invite is consumed).
  assert.throws(
    () => orgs.acceptInvite(inv.token, { user_id: 'user_other', email: 'guest@example.com' }),
    /already consumed/,
  );

  // Email mismatch must fail (token bound to email).
  const inv2 = orgs.inviteMember(org.org_id, {
    email: 'second@example.com',
    role: 'member',
    actingUserId: ownerId,
  });
  assert.throws(
    () => orgs.acceptInvite(inv2.token, { user_id: 'user_x', email: 'someone-else@example.com' }),
    /email does not match/,
  );
});

// 10
test('W918 P5.1-10 audit ledger captures org.create + member.add rows', () => {
  const { org, ownerId } = freshOrg('audit');
  orgs.addMember(org.org_id, {
    user_id: 'user_audited_' + Math.random().toString(36).slice(2, 8),
    email: 'audited@example.com',
    role: 'member',
    acting_user_id: ownerId,
  });

  const auditFile = path.join(DATA_DIR, 'orgs-audit.jsonl');
  assert.ok(fs.existsSync(auditFile), 'audit ledger file exists');
  const rows = fs.readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(r => r.org_id === org.org_id);

  const kinds = rows.map(r => r.kind);
  assert.ok(kinds.includes('org.create'), 'org.create row present: ' + kinds.join(','));
  assert.ok(kinds.includes('member.add'), 'member.add row present: ' + kinds.join(','));

  const createRow = rows.find(r => r.kind === 'org.create');
  assert.equal(createRow.actor_user_id, ownerId);
  assert.equal(createRow.target, org.org_id);
});
