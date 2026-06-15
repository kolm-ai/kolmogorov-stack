// TEAMS (Path to 100%) — team creation, invites, roles, and CROSS-TEAM isolation.
//
// Verifies the core team logic + the security-critical isolation: a non-member
// is excluded from membership/roles, an invite can't be hijacked by a different
// email, and a team-scoped provider key needs the team context (outsiders get
// nothing). The HTTP routes enforce this via teams.membershipOf() (router.js
// /v1/account/provider-keys, /v1/teams/:id/*).

import { test } from 'node:test';
import assert from 'node:assert';
import {
  createTeam, inviteToTeam, acceptInvite, listMembers, membershipOf, isMember, requireRole,
} from '../src/teams.js';
import { putProviderKey, resolveProviderKey, listProviderKeys, deleteProviderKey } from '../src/provider-vault.js';

const A = 'tmA_' + process.pid;
const B = 'tmB_' + process.pid;
const C = 'tmC_' + process.pid;

test('TEAM: create — owner is an active member with the owner role', () => {
  const t = createTeam({ ownerTenantId: A, name: 'Acme ' + process.pid, plan: 'teams', seatsMax: 5 });
  assert.ok(t.id);
  assert.strictEqual(t.plan, 'teams');
  assert.strictEqual(t.seats_max, 5);
  assert.ok(isMember(t.id, A));
  assert.strictEqual(membershipOf(t.id, A).role, 'owner');
});

test('TEAM: invite + accept adds a member; a non-member is excluded (cross-team isolation)', () => {
  const t = createTeam({ ownerTenantId: A, name: 'Beta ' + process.pid });
  const inv = inviteToTeam(t.id, 'b@kolm.test', 'member', A);
  assert.ok(inv.token);
  const res = acceptInvite(inv.token, B, 'b@kolm.test');
  assert.ok(res.ok);
  assert.strictEqual(res.role, 'member');
  assert.strictEqual(listMembers(t.id).length, 2, 'owner + member');
  // The isolation foundation: C is not a member and has no role.
  assert.strictEqual(isMember(t.id, C), false);
  assert.strictEqual(membershipOf(t.id, C), null);
});

test('TEAM: role gate — a member cannot do admin actions; a non-member cannot do anything', () => {
  const t = createTeam({ ownerTenantId: A, name: 'Gamma ' + process.pid });
  acceptInvite(inviteToTeam(t.id, 'm@kolm.test', 'member', A).token, B, 'm@kolm.test');
  assert.throws(() => inviteToTeam(t.id, 'x@kolm.test', 'member', B), /role admin/i, 'member cannot invite');
  assert.throws(() => requireRole(t.id, C, 'member'), /not a team member/i, 'non-member is blocked');
});

test('TEAM: an invite cannot be accepted by a different email (anti-hijack)', () => {
  const t = createTeam({ ownerTenantId: A, name: 'Delta ' + process.pid });
  const inv = inviteToTeam(t.id, 'invited@kolm.test', 'member', A);
  const wrong = acceptInvite(inv.token, B, 'attacker@kolm.test');
  assert.strictEqual(wrong.ok, false, 'wrong-email accept is rejected');
});

test('TEAM: a team-scoped provider key needs the team context; outsiders get nothing', () => {
  const t = createTeam({ ownerTenantId: A, name: 'Vault ' + process.pid });
  acceptInvite(inviteToTeam(t.id, 'mem@kolm.test', 'member', A).token, B, 'mem@kolm.test');
  putProviderKey({ tenantId: A, teamId: t.id, actorId: A, provider: 'anthropic', scope: 'team', value: 'sk-team-shared', label: 'team' });
  try {
    // A member, with the team context (which the route grants only after a
    // membershipOf check), shares the team key.
    assert.strictEqual(
      resolveProviderKey({ tenantId: B, teamId: t.id, actorId: B, provider: 'anthropic' }),
      'sk-team-shared',
      'a member with team context resolves the shared key',
    );
    // An outsider with no team context never sees it.
    assert.strictEqual(
      resolveProviderKey({ tenantId: C, actorId: C, provider: 'anthropic' }),
      null,
      'an outsider with no team context is isolated',
    );
  } finally {
    for (const k of (listProviderKeys({ tenantId: A, teamId: t.id, actorId: A, isAdmin: true }) || [])) {
      try { deleteProviderKey({ tenantId: A, id: k.id, actorId: A, isAdmin: true }); } catch { /* cleanup */ }
    }
  }
});
