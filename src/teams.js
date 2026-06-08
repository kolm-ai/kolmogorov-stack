// Teams (orgs) - multi-tenant shared workspaces.
//
// A team is a billing unit that wraps multiple tenants. The team owner pays;
// members get read/write access to team-scoped concepts, recipes, artifacts,
// tunnels, and BYOC deployments via membership.
//
// Roles (low → high): viewer, member, admin, owner.
//   viewer - read team resources
//   member - read + create team resources
//   admin - read + write + invite + remove members
//   owner - admin + transfer ownership + delete team
//
// Team identity: stable `id` (team_<rand>) + URL slug. Slug uniqueness is
// enforced at create time so /teams/<slug> is durable. Renaming changes the
// display name only; slug is permanent unless owner asks for a new slug.

import crypto from 'node:crypto';
import { id, insert, find, findOne, update, remove, all } from './store.js';

const ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(ROLE_RANK);
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function sanitizeSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function sanitizeName(s) {
  return String(s || '').replace(/[<>"']/g, '').slice(0, 80).trim();
}

function uniqueSlug(base) {
  let slug = base || 'team';
  if (!all('teams').find(t => t.slug === slug && !t._deleted)) return slug;
  for (let i = 2; i < 999; i++) {
    const cand = `${base}-${i}`;
    if (!all('teams').find(t => t.slug === cand && !t._deleted)) return cand;
  }
  return base + '-' + crypto.randomBytes(2).toString('hex');
}

function rankOf(role) { return ROLE_RANK[role] || 0; }

export function createTeam({ ownerTenantId, name, plan = 'teams', seatsMax = 5 }) {
  if (!ownerTenantId) throw new Error('ownerTenantId required');
  const cleanName = sanitizeName(name) || 'New Team';
  const slug = uniqueSlug(sanitizeSlug(cleanName));
  const teamId = id('team');
  const team = {
    id: teamId,
    slug,
    name: cleanName,
    owner_tenant_id: ownerTenantId,
    plan,
    seats_max: seatsMax,
    seats_used: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  insert('teams', team);
  insert('team_members', {
    id: id('tm'),
    team_id: teamId,
    tenant_id: ownerTenantId,
    role: 'owner',
    status: 'active',
    invited_by: ownerTenantId,
    invited_at: team.created_at,
    joined_at: team.created_at,
  });
  return team;
}

export function getTeam(idOrSlug) {
  return all('teams').find(t => !t._deleted && (t.id === idOrSlug || t.slug === idOrSlug)) || null;
}

export function listTeamsForTenant(tenantId) {
  const memberships = all('team_members').filter(m => m.tenant_id === tenantId && m.status === 'active');
  const teamIds = new Set(memberships.map(m => m.team_id));
  const teams = all('teams').filter(t => !t._deleted && teamIds.has(t.id));
  return teams.map(t => {
    const m = memberships.find(x => x.team_id === t.id);
    return { ...t, your_role: m?.role || null };
  });
}

export function membershipOf(teamId, tenantId) {
  if (!teamId || !tenantId) return null;
  return findOne('team_members', m => m.team_id === teamId && m.tenant_id === tenantId && m.status === 'active');
}

export function isMember(teamId, tenantId) {
  return !!membershipOf(teamId, tenantId);
}

export function requireRole(teamId, tenantId, minRole) {
  const m = membershipOf(teamId, tenantId);
  if (!m) { const err = new Error('not a team member'); err.code = 'forbidden'; throw err; }
  if (rankOf(m.role) < rankOf(minRole)) {
    const err = new Error(`requires role ${minRole}+; you are ${m.role}`); err.code = 'forbidden'; throw err;
  }
  return m;
}

export function listMembers(teamId) {
  return find('team_members', m => m.team_id === teamId && m.status === 'active')
    .sort((a, b) => rankOf(b.role) - rankOf(a.role));
}

export function updateTeam(teamId, byTenantId, { name, plan, seatsMax }) {
  requireRole(teamId, byTenantId, 'admin');
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) patch.name = sanitizeName(name) || undefined;
  if (plan !== undefined) patch.plan = String(plan).slice(0, 40);
  if (seatsMax !== undefined && Number.isInteger(seatsMax) && seatsMax > 0) patch.seats_max = seatsMax;
  update('teams', t => t.id === teamId, patch);
  return getTeam(teamId);
}

export function transferOwnership(teamId, currentOwnerId, newOwnerTenantId) {
  requireRole(teamId, currentOwnerId, 'owner');
  const target = membershipOf(teamId, newOwnerTenantId);
  if (!target) throw Object.assign(new Error('new owner must already be a team member'), { code: 'bad_request' });
  update('team_members', m => m.team_id === teamId && m.tenant_id === currentOwnerId, { role: 'admin' });
  update('team_members', m => m.team_id === teamId && m.tenant_id === newOwnerTenantId, { role: 'owner' });
  update('teams', t => t.id === teamId, { owner_tenant_id: newOwnerTenantId, updated_at: new Date().toISOString() });
  return getTeam(teamId);
}

export function deleteTeam(teamId, byTenantId) {
  requireRole(teamId, byTenantId, 'owner');
  update('teams', t => t.id === teamId, { _deleted: true, deleted_at: new Date().toISOString() });
  update('team_members', m => m.team_id === teamId, { status: 'removed' });
  update('team_invites', i => i.team_id === teamId && !i.accepted_at, { _deleted: true });
  return true;
}

export function changeMemberRole(teamId, tenantId, newRole, byTenantId) {
  if (!ROLES.includes(newRole)) throw Object.assign(new Error('invalid role'), { code: 'bad_request' });
  requireRole(teamId, byTenantId, 'admin');
  const target = membershipOf(teamId, tenantId);
  if (!target) throw Object.assign(new Error('member not found'), { code: 'not_found' });
  if (target.role === 'owner') throw Object.assign(new Error('owner role can only be reassigned via transfer'), { code: 'forbidden' });
  if (newRole === 'owner') throw Object.assign(new Error('use transfer endpoint to make someone owner'), { code: 'bad_request' });
  update('team_members', m => m.id === target.id, { role: newRole, updated_at: new Date().toISOString() });
  return getTeam(teamId);
}

export function removeMember(teamId, tenantId, byTenantId) {
  const acting = membershipOf(teamId, byTenantId);
  if (!acting) throw Object.assign(new Error('not a team member'), { code: 'forbidden' });
  const target = membershipOf(teamId, tenantId);
  if (!target) throw Object.assign(new Error('member not found'), { code: 'not_found' });
  if (target.role === 'owner') throw Object.assign(new Error('cannot remove the owner'), { code: 'forbidden' });
  // Self-removal allowed; otherwise need admin
  if (tenantId !== byTenantId && rankOf(acting.role) < rankOf('admin')) {
    throw Object.assign(new Error('requires admin role'), { code: 'forbidden' });
  }
  update('team_members', m => m.id === target.id, { status: 'removed', removed_at: new Date().toISOString() });
  const team = getTeam(teamId);
  if (team) update('teams', t => t.id === teamId, { seats_used: Math.max(0, (team.seats_used || 1) - 1), updated_at: new Date().toISOString() });
  return true;
}

export function inviteToTeam(teamId, email, role, byTenantId) {
  requireRole(teamId, byTenantId, 'admin');
  if (!ROLES.includes(role)) role = 'member';
  if (role === 'owner') throw Object.assign(new Error('cannot invite directly as owner'), { code: 'bad_request' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Object.assign(new Error('valid email required'), { code: 'bad_request' });
  }
  const team = getTeam(teamId);
  if (!team) throw Object.assign(new Error('team not found'), { code: 'not_found' });
  if ((team.seats_used || 1) >= (team.seats_max || 1)) {
    throw Object.assign(new Error(`team is at seat limit (${team.seats_max}). Upgrade plan or remove a member first.`), { code: 'seat_limit' });
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const invite = {
    id: id('inv'),
    team_id: teamId,
    email: email.toLowerCase(),
    role,
    token,
    invited_by: byTenantId,
    expires_at: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    accepted_at: null,
    created_at: now.toISOString(),
  };
  insert('team_invites', invite);
  return { token, expires_at: invite.expires_at, role, team_slug: team.slug };
}

export function findInvite(token) {
  if (!token) return null;
  return findOne('team_invites', i => i.token === token && !i._deleted && !i.accepted_at);
}

export function acceptInvite(token, tenantId, tenantEmail) {
  const inv = findInvite(token);
  if (!inv) return { ok: false, reason: 'invite not found or already used' };
  if (new Date(inv.expires_at) < new Date()) return { ok: false, reason: 'invite expired' };
  if (tenantEmail && inv.email !== tenantEmail.toLowerCase()) {
    return { ok: false, reason: `invite was sent to ${inv.email}; sign in with that email to accept` };
  }
  const team = getTeam(inv.team_id);
  if (!team) return { ok: false, reason: 'team no longer exists' };
  if ((team.seats_used || 1) >= (team.seats_max || 1)) {
    return { ok: false, reason: 'team is at seat limit; ask an admin to upgrade or remove a member' };
  }
  const existing = membershipOf(team.id, tenantId);
  if (existing) {
    update('team_invites', i => i.id === inv.id, { accepted_at: new Date().toISOString() });
    return { ok: true, team, role: existing.role, already_member: true };
  }
  insert('team_members', {
    id: id('tm'),
    team_id: team.id,
    tenant_id: tenantId,
    role: inv.role,
    status: 'active',
    invited_by: inv.invited_by,
    invited_at: inv.created_at,
    joined_at: new Date().toISOString(),
  });
  update('teams', t => t.id === team.id, { seats_used: (team.seats_used || 0) + 1, updated_at: new Date().toISOString() });
  update('team_invites', i => i.id === inv.id, { accepted_at: new Date().toISOString() });
  return { ok: true, team, role: inv.role };
}

export function listInvites(teamId, byTenantId) {
  requireRole(teamId, byTenantId, 'admin');
  return find('team_invites', i => i.team_id === teamId && !i._deleted && !i.accepted_at);
}

export function revokeInvite(inviteId, byTenantId) {
  const inv = findOne('team_invites', i => i.id === inviteId);
  if (!inv) throw Object.assign(new Error('invite not found'), { code: 'not_found' });
  requireRole(inv.team_id, byTenantId, 'admin');
  update('team_invites', i => i.id === inviteId, { _deleted: true });
  return true;
}

// Resource sharing helpers - called by registry / compile / tunnel to decide
// whether a resource is readable/writable in a team context.
export function teamScopedReadable(resource, tenantId, tenantName) {
  if (!resource) return false;
  if (resource.tenant === tenantName) return true;
  if (resource.visibility === 'public') return true;
  if (resource.team_id && isMember(resource.team_id, tenantId)) return true;
  return false;
}

export function teamScopedWritable(resource, tenantId, tenantName) {
  if (!resource) return false;
  if (resource.tenant === tenantName) return true;
  if (resource.team_id) {
    const m = membershipOf(resource.team_id, tenantId);
    if (m && rankOf(m.role) >= rankOf('member')) return true;
  }
  return false;
}

export { ROLES, rankOf };
