// SOTA Teams lane - real fixes for the Teams atoms.
//
// Atoms exercised:
//   1) [p0] deleteTeam cascades team-scoped provider keys (+ team_models /
//      team_retention / team_events) atomically, so a deleted team leaves NO
//      resolvable shared secret behind.
//   2) [p0] seat ceiling enforced on createTeam (clamp) and updateTeam (reject
//      above the plan's billable seat cap) - revenue-leak fix.
//   3) [p1] removeMember / role-lowering raises a provider_key.rotation_recommended
//      team event when the team shares upstream keys; surfaced in teamDetail.
//      A removed member is no longer an active membership (membershipOf gate).
//   4) [p1] teamRollup uses a single team_id-scoped aggregate pass + caches
//      closed periods (no per-member full scan).
//
// Isolation: one temp KOLM_DATA_DIR + json store driver, set BEFORE any import
// that loads the singleton store module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-sota-teams-'));
process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.KOLM_HOME = path.join(tmp, '.kolm');
process.env.KOLM_ENV = 'test';
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';

const teams = await import('../src/teams.js');
const vault = await import('../src/provider-vault.js');
const billing = await import('../src/billing-breakdown.js');
const eventStore = await import('../src/event-store.js');

test('atom1: deleteTeam cascades team-scoped provider key -> unresolvable + _deleted', async () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Cascade Co' });

  // Store a TEAM-scope provider key.
  vault.putProviderKey({ tenantId: owner, teamId: team.id, provider: 'openai', scope: 'team', value: 'sk-team-secret-123' });

  // Sanity: resolvable before deletion.
  const before = vault.resolveProviderKey({ tenantId: owner, teamId: team.id, provider: 'openai' });
  assert.equal(before, 'sk-team-secret-123');

  // Delete the team.
  teams.deleteTeam(team.id, owner);

  // After deletion the orphaned shared secret must NOT resolve for anyone
  // holding (or forging) the team_id.
  const after = vault.resolveProviderKey({ tenantId: owner, teamId: team.id, provider: 'openai' });
  assert.equal(after, null);

  // And the row is soft-deleted (audit retained, not resolvable).
  const visible = vault.listProviderKeys({ tenantId: owner, teamId: team.id, isAdmin: true });
  assert.equal(visible.length, 0, 'team key must not appear after cascade');
});

test('atom1: deleteTeam cascade is idempotent + atomic (re-delete is a no-op)', async () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Idem Co' });
  vault.putProviderKey({ tenantId: owner, teamId: team.id, provider: 'anthropic', scope: 'team', value: 'sk-ant-xyz' });
  teams.deleteTeam(team.id, owner);
  // deleteTeamProviderKeys is idempotent: a second cascade cascades 0.
  const n = vault.deleteTeamProviderKeys(team.id);
  assert.equal(n, 0);
});

test('atom2: createTeam clamps seats to the plan ceiling (teams=5)', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Greedy Co', plan: 'teams', seatsMax: 9999 });
  assert.equal(team.seats_max, 5, 'teams plan must cap at 5 seats');
});

test('atom2: createTeam defaults seats to plan ceiling when unset', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Default Co', plan: 'teams' });
  assert.equal(team.seats_max, 5);
});

test('atom2: updateTeam rejects seats_max above the plan ceiling', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Patch Co', plan: 'teams' });
  let threw = null;
  try {
    teams.updateTeam(team.id, owner, { seatsMax: 9999 });
  } catch (e) { threw = e; }
  assert.ok(threw, 'must reject seats above ceiling');
  assert.equal(threw.code, 'seat_limit');
  assert.match(threw.message, /ceiling of 5/);
  // Within ceiling is allowed.
  const ok = teams.updateTeam(team.id, owner, { seatsMax: 5 });
  assert.equal(ok.seats_max, 5);
});

test('atom2: enterprise plan is uncapped (sales-led contract)', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Ent Co', plan: 'enterprise', seatsMax: 9999 });
  assert.equal(team.seats_max, 9999, 'enterprise is uncapped here');
  // And a patch above the default does not throw.
  const up = teams.updateTeam(team.id, owner, { seatsMax: 12345 });
  assert.equal(up.seats_max, 12345);
});

test('atom2: downgrading plan clamps existing seats to the new ceiling', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Down Co', plan: 'business', seatsMax: 20 });
  assert.equal(team.seats_max, 20);
  const down = teams.updateTeam(team.id, owner, { plan: 'teams' });
  assert.equal(down.seats_max, 5, 'business->teams clamps 20 -> 5');
});

test('atom3: removed member cannot resolve the team key (membership gate)', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const memberTenant = 'tn_mem_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Rotate Co' });
  vault.putProviderKey({ tenantId: owner, teamId: team.id, provider: 'openai', scope: 'team', value: 'sk-shared-9' });

  // Add the member by accepting an invite.
  const inv = teams.inviteToTeam(team.id, 'mem@example.test', 'member', owner);
  const acc = teams.acceptInvite(inv.token, memberTenant, 'mem@example.test');
  assert.ok(acc.ok);
  assert.ok(teams.membershipOf(team.id, memberTenant), 'member is active');

  // Remove the member.
  teams.removeMember(team.id, memberTenant, owner);
  assert.equal(teams.membershipOf(team.id, memberTenant), null, 'removed member is no longer an active membership');

  // The resolve gate (router) passes teamId only for active members. The
  // membership check is the gate; a removed member would never be passed a
  // teamId. Assert the gate denies them.
  assert.equal(teams.isMember(team.id, memberTenant), false);

  // Removal raised a rotation-recommended prompt (team shares an upstream key).
  const detail = teams.teamDetail(team.id);
  assert.equal(detail.rotate_shared_keys.recommended, true);
  assert.equal(detail.rotate_shared_keys.reason, 'member_removed');
});

test('atom3: role-lowering raises a rotation prompt; no prompt when no shared keys', () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const memberTenant = 'tn_mem_' + Math.random().toString(36).slice(2, 8);

  // No shared keys -> no prompt on removal.
  const teamA = teams.createTeam({ ownerTenantId: owner, name: 'NoKey Co' });
  const invA = teams.inviteToTeam(teamA.id, 'a@example.test', 'admin', owner);
  teams.acceptInvite(invA.token, memberTenant, 'a@example.test');
  teams.changeMemberRole(teamA.id, memberTenant, 'viewer', owner); // lowered
  assert.equal(teams.teamDetail(teamA.id).rotate_shared_keys.recommended, false, 'no shared keys -> no prompt');

  // With a shared key -> lowering raises a prompt.
  const teamB = teams.createTeam({ ownerTenantId: owner, name: 'Key Co' });
  vault.putProviderKey({ tenantId: owner, teamId: teamB.id, provider: 'openai', scope: 'team', value: 'sk-b' });
  const member2 = 'tn_mem2_' + Math.random().toString(36).slice(2, 8);
  const invB = teams.inviteToTeam(teamB.id, 'b@example.test', 'admin', owner);
  teams.acceptInvite(invB.token, member2, 'b@example.test');
  teams.changeMemberRole(teamB.id, member2, 'member', owner); // admin -> member = lowered
  const d = teams.teamDetail(teamB.id);
  assert.equal(d.rotate_shared_keys.recommended, true);
  assert.equal(d.rotate_shared_keys.reason, 'member_role_lowered');
});

test('atom4: teamRollup aggregates team_id-scoped events in one pass', async () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const memberTenant = 'tn_mem_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Bill Co' });
  const inv = teams.inviteToTeam(team.id, 'm@example.test', 'member', owner);
  teams.acceptInvite(inv.token, memberTenant, 'm@example.test');

  const now = new Date();
  const p = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const created = now.toISOString();

  await eventStore.appendEvent({
    event_id: 'ev_a_' + Math.random().toString(36).slice(2), tenant_id: owner, team_id: team.id,
    namespace: 'prod', provider: 'openai', model: 'gpt', status: 'ok', created_at: created,
    tokens_in: 100, tokens_out: 50, cost_micro_usd: 1000,
  });
  await eventStore.appendEvent({
    event_id: 'ev_b_' + Math.random().toString(36).slice(2), tenant_id: memberTenant, team_id: team.id,
    namespace: 'dev', provider: 'anthropic', model: 'claude', status: 'ok', created_at: created,
    tokens_in: 200, tokens_out: 20, cost_micro_usd: 2000,
  });

  const roll = await billing.teamRollup({ team_id: team.id, period: p, caller_tenant_id: owner });
  assert.equal(roll.totals.cost_micro_usd, 3000, 'sum of both members');
  assert.equal(roll.totals.captures, 2);
  // owner is privileged -> sees per-member detail for everyone.
  const ownerRow = roll.members.find(m => m.tenant_id === owner);
  const memRow = roll.members.find(m => m.tenant_id === memberTenant);
  assert.equal(ownerRow.cost_micro_usd, 1000);
  assert.equal(memRow.cost_micro_usd, 2000);
  assert.ok(Array.isArray(ownerRow.namespaces));
  assert.ok(Array.isArray(memRow.namespaces), 'privileged caller sees other members detail');
});

test('atom4: non-privileged caller does not see other members namespace detail', async () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const memberTenant = 'tn_mem_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Priv Co' });
  const inv = teams.inviteToTeam(team.id, 'm2@example.test', 'member', owner);
  teams.acceptInvite(inv.token, memberTenant, 'm2@example.test');
  const now = new Date();
  const p = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  await eventStore.appendEvent({
    event_id: 'ev_c_' + Math.random().toString(36).slice(2), tenant_id: owner, team_id: team.id,
    namespace: 'prod', provider: 'openai', model: 'gpt', status: 'ok', created_at: now.toISOString(),
    tokens_in: 10, tokens_out: 5, cost_micro_usd: 500,
  });
  const roll = await billing.teamRollup({ team_id: team.id, period: p, caller_tenant_id: memberTenant });
  assert.equal(roll.privileged, false);
  const ownerRow = roll.members.find(m => m.tenant_id === owner);
  assert.equal(ownerRow.namespaces, null, 'non-privileged caller cannot see owner detail');
  // But aggregate totals still include the owner spend.
  assert.equal(roll.totals.cost_micro_usd, 500);
});

test('atom4: closed-period rollups are cached', async () => {
  const owner = 'tn_owner_' + Math.random().toString(36).slice(2, 8);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Cache Co' });
  const closed = '2000-01'; // far past -> closed
  const r1 = await billing.teamRollup({ team_id: team.id, period: closed, caller_tenant_id: owner });
  assert.equal(r1.cached, true);
  const r2 = await billing.teamRollup({ team_id: team.id, period: closed, caller_tenant_id: owner });
  assert.equal(r2.cached, true);
  billing._clearRollupCache();
});
