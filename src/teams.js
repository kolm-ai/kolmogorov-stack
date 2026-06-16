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
import { id, insert, find, findOne, findByField, update, remove, all, withTransaction } from './store.js';
import { deleteTeamProviderKeys } from './provider-vault.js';
import { deactivateTunnel } from './tunnel.js';
import { PLAN_CATALOG, canonicalPlanId } from './plan-catalog.js';

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
  // 48 bits of entropy (12 hex chars) to match the cryptographic strength of
  // team IDs - 16 bits was insufficient for collision resistance at scale.
  return base + '-' + crypto.randomBytes(6).toString('hex');
}

function rankOf(role) { return ROLE_RANK[role] || 0; }

// Seat ceiling for a plan. The pricing model bills per seat (see file header:
// "A team is a billing unit"), so the per-plan `seats` in PLAN_CATALOG is the
// hard ceiling self-serve tenants may not exceed. enterprise/custom plans are
// sales-led and uncapped here (the contract sets the real ceiling). Unknown /
// non-team plan strings fall back to the canonical `teams` seat count so an
// unrecognized value can never silently grant unlimited seats.
function planSeatCeiling(plan) {
  const canon = canonicalPlanId(plan);
  if (canon === 'enterprise') return Infinity; // sales-led / custom contract
  const entry = canon ? PLAN_CATALOG[canon] : null;
  if (entry && Number.isFinite(entry.seats) && entry.seats > 0) return entry.seats;
  // Unknown plan -> default to the team plan ceiling (never unlimited).
  return PLAN_CATALOG.teams.seats;
}

// Append-only team event log. Surfaces operational prompts (e.g. "rotate the
// shared provider keys after a member left") in the team detail response so the
// dashboard/CLI can show an actionable banner. Pure data row in `team_events`.
export function emitTeamEvent(teamId, type, payload = {}) {
  if (!teamId || !type) return null;
  const row = {
    id: id('tev'),
    team_id: teamId,
    type: String(type).slice(0, 64),
    payload: payload && typeof payload === 'object' ? payload : {},
    created_at: new Date().toISOString(),
    acknowledged_at: null,
  };
  insert('team_events', row);
  return row;
}

// Outstanding (unacknowledged) team events - the dashboard renders these as
// action prompts. Newest first.
export function listTeamEvents(teamId, { includeAcknowledged = false } = {}) {
  if (!teamId) return [];
  return find('team_events', e => e.team_id === teamId && !e._deleted && (includeAcknowledged || !e.acknowledged_at))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function acknowledgeTeamEvent(teamId, eventId, byTenantId) {
  requireRole(teamId, byTenantId, 'admin');
  const ev = findOne('team_events', e => e.id === eventId && e.team_id === teamId && !e._deleted);
  if (!ev) throw Object.assign(new Error('event not found'), { code: 'not_found' });
  update('team_events', e => e.id === ev.id, { acknowledged_at: new Date().toISOString(), acknowledged_by: byTenantId });
  return true;
}

// Whether the team currently has any team-scoped provider keys that a departed
// member could still be holding plaintext for. Cheap, used to gate the rotation
// prompt so we don't nag teams that share no upstream keys.
function teamHasSharedProviderKeys(teamId) {
  return all('provider_keys').some(r => r && !r._deleted && r.team_id === teamId && r.scope === 'team');
}

// Raise a 'rotate the shared upstream keys' prompt when trust boundary shrinks
// (member removed, or role lowered). Idempotent within a short window: collapse
// repeated unacknowledged rotation prompts into the most recent one so a burst
// of removals does not spam the banner.
function recommendKeyRotation(teamId, reason, payload = {}) {
  if (!teamHasSharedProviderKeys(teamId)) return null;
  // Mark prior unacknowledged rotation prompts as superseded (soft-delete) so
  // only the newest one is surfaced.
  update(
    'team_events',
    e => e.team_id === teamId && e.type === 'provider_key.rotation_recommended' && !e.acknowledged_at && !e._deleted,
    { _deleted: true, superseded_at: new Date().toISOString() },
  );
  return emitTeamEvent(teamId, 'provider_key.rotation_recommended', { reason, ...payload });
}

export function createTeam({ ownerTenantId, name, plan = 'teams', seatsMax }) {
  if (!ownerTenantId) throw new Error('ownerTenantId required');
  const cleanName = sanitizeName(name) || 'New Team';
  const slug = uniqueSlug(sanitizeSlug(cleanName));
  const teamId = id('team');
  // Seats are the billing unit: clamp to the plan ceiling so a tenant can't
  // self-provision seats_max=9999 on the $99 team plan (revenue leak). When
  // seatsMax is unset we default to the plan's included seats. A supplied
  // value above the ceiling is clamped down (not rejected) at create time so
  // the team is still created at the correct billable size.
  const ceiling = planSeatCeiling(plan);
  const requested = (seatsMax === undefined || seatsMax === null)
    ? ceiling
    : (Number.isInteger(seatsMax) && seatsMax > 0 ? seatsMax : ceiling);
  const seats = Number.isFinite(ceiling) ? Math.min(requested, ceiling) : requested;
  const team = {
    id: teamId,
    slug,
    name: cleanName,
    owner_tenant_id: ownerTenantId,
    plan,
    seats_max: seats,
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
  const team = getTeam(teamId);
  if (!team) throw Object.assign(new Error('team not found'), { code: 'not_found' });
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) patch.name = sanitizeName(name) || undefined;
  if (plan !== undefined) patch.plan = String(plan).slice(0, 40);
  // The effective plan after this patch decides the seat ceiling - re-derive it
  // when the plan changes in the same request so an admin can't widen seats by
  // downgrading after the fact.
  const effectivePlan = plan !== undefined ? plan : team.plan;
  const ceiling = planSeatCeiling(effectivePlan);
  if (seatsMax !== undefined) {
    if (!Number.isInteger(seatsMax) || seatsMax <= 0) {
      throw Object.assign(new Error('seatsMax must be a positive integer'), { code: 'bad_request' });
    }
    // Plan ceiling enforcement: the per-plan seat count is the billable limit.
    // Reject any value above it unless the plan is enterprise/custom (uncapped
    // here, governed by contract). Without this a $99 team plan could set
    // seats_max=9999 and invite unlimited members - direct revenue leakage.
    if (Number.isFinite(ceiling) && seatsMax > ceiling) {
      throw Object.assign(
        new Error(`seats_max ${seatsMax} exceeds the ${canonicalPlanId(effectivePlan) || effectivePlan} plan ceiling of ${ceiling}. Upgrade the plan to add more seats.`),
        { code: 'seat_limit', ceiling, plan: canonicalPlanId(effectivePlan) || String(effectivePlan) },
      );
    }
    // Do not let an admin reduce the limit below the seats already consumed
    // (active members + outstanding reservations). Otherwise billing state is
    // confusing: future invites are blocked but no member is removed.
    const used = team.seats_used || 1;
    if (seatsMax < used) {
      throw Object.assign(
        new Error(`cannot reduce seats to ${seatsMax}; ${used} seat(s) are in use (active members + pending invites). Remove members or revoke invites first.`),
        { code: 'seat_limit' },
      );
    }
    patch.seats_max = seatsMax;
  } else if (plan !== undefined && Number.isFinite(ceiling) && (team.seats_max || 0) > ceiling) {
    // Plan changed (e.g. downgrade) without an explicit seatsMax: clamp the
    // existing ceiling down to the new plan's limit, but never below the seats
    // already in use.
    patch.seats_max = Math.max(team.seats_used || 1, ceiling);
  }
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
  // Cascade the whole team subtree atomically so a deleted team leaves NO
  // resolvable shared secret or orphaned team resource behind. Wrapped in a
  // single transaction: either every child is tombstoned or none is, so the
  // resolve path (which filters only on !_deleted) can never see a live key
  // attached to a dead team.
  return withTransaction(() => {
    const now = new Date().toISOString();
    update('teams', t => t.id === teamId, { _deleted: true, deleted_at: now });
    update('team_members', m => m.team_id === teamId, { status: 'removed', removed_at: now });
    update('team_invites', i => i.team_id === teamId && !i.accepted_at, { _deleted: true });
    // P0: orphaned-secret cascade. Soft-delete every team-scoped provider key so
    // it is no longer resolvable/chargeable by anyone holding (or forging) the
    // team_id. Idempotent - safe even if already cascaded.
    deleteTeamProviderKeys(teamId);
    // Completeness: tombstone team-owned resources so they stop appearing in
    // listings and stop billing/holding endpoints. team_models also carries an
    // endpoint_tunnel_id; deactivate each model's tunnel BEFORE tombstoning the
    // rows so a deleted team leaves no live shared endpoint resolvable. We read
    // the live rows first (the tombstone update below clears them), deactivate
    // each tunnel by its id (tunnel.deactivateTunnel is idempotent + a no-op for
    // a missing/already-torn-down id), then tombstone the model rows.
    const teamModels = find('team_models', m => m.team_id === teamId && !m._deleted);
    for (const m of teamModels) {
      if (m && m.endpoint_tunnel_id) {
        try { deactivateTunnel(m.endpoint_tunnel_id); }
        catch (_) { /* tunnel teardown must never abort the team-delete cascade */ }
      }
    }
    update('team_models', m => m.team_id === teamId && !m._deleted, { _deleted: true, deleted_at: now, deleted_reason: 'team_deleted' });
    update('team_retention', x => x.team_id === teamId && !x._deleted, { _deleted: true, deleted_at: now, deleted_reason: 'team_deleted' });
    // Tombstone outstanding operational prompts for a dead team.
    update('team_events', e => e.team_id === teamId && !e._deleted, { _deleted: true, deleted_at: now });
    return true;
  });
}

export function changeMemberRole(teamId, tenantId, newRole, byTenantId) {
  if (!ROLES.includes(newRole)) throw Object.assign(new Error('invalid role'), { code: 'bad_request' });
  requireRole(teamId, byTenantId, 'admin');
  const target = membershipOf(teamId, tenantId);
  if (!target) throw Object.assign(new Error('member not found'), { code: 'not_found' });
  if (target.role === 'owner') throw Object.assign(new Error('owner role can only be reassigned via transfer'), { code: 'forbidden' });
  if (newRole === 'owner') throw Object.assign(new Error('use transfer endpoint to make someone owner'), { code: 'bad_request' });
  const lowered = rankOf(newRole) < rankOf(target.role);
  update('team_members', m => m.id === target.id, { role: newRole, updated_at: new Date().toISOString() });
  // Trust boundary shrank: a demoted member who could store/rotate shared keys
  // may still hold plaintext they pulled. Recommend rotation of shared upstream
  // keys (surfaced in the team detail response + dashboard banner).
  if (lowered) {
    recommendKeyRotation(teamId, 'member_role_lowered', { tenant_id: tenantId, from_role: target.role, to_role: newRole });
  }
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
  // Atomic member removal + seat decrement. Without the transaction these two
  // statements race a concurrent inviteToTeam/acceptInvite seat increment: a
  // removeMember that reads seats_used between another writer's increment and
  // commit decrements a stale value, leaking a seat (e.g. 5/5 -> invite makes
  // it 6, this read sees 5 and writes 4, final 4/5 but really 5/5). Re-reading
  // the team inside withTransaction (BEGIN IMMEDIATE) serializes it against
  // inviteToTeam / revokeInvite / acceptInvite, which already wrap their
  // seat writes the same way.
  return withTransaction(() => {
    // Re-read the membership inside the transaction so a concurrent removeMember
    // (or self-removal racing an admin removal) cannot decrement the seat twice
    // for the same member.
    const cur = findOne('team_members', m => m.id === target.id);
    if (!cur || cur.status === 'removed') return true;
    update('team_members', m => m.id === target.id, { status: 'removed', removed_at: new Date().toISOString() });
    const team = getTeam(teamId);
    if (team) update('teams', t => t.id === teamId, { seats_used: Math.max(0, (team.seats_used || 1) - 1), updated_at: new Date().toISOString() });
    // A departed employee may still hold the plaintext of any shared upstream
    // key they pulled before removal. There is no way to revoke the copy in
    // their client, so flag the team to rotate shared provider keys.
    recommendKeyRotation(teamId, 'member_removed', { tenant_id: tenantId });
    return true;
  });
}

// Reclaim seats held by reserved invites that have expired without being
// accepted or revoked. Without this, an expired-but-never-revoked invite would
// leak its reserved seat forever. Runs inside whatever transaction the caller
// is in (acceptInvite / inviteToTeam wrap us). Returns the count reclaimed.
function reclaimExpiredReservations(teamId) {
  const nowMs = Date.now();
  const stale = find('team_invites', i =>
    i.team_id === teamId && i.reserved === true && !i.reservation_released
    && !i.accepted_at && !i._deleted
    && Number.isFinite(Date.parse(i.expires_at || '')) && Date.parse(i.expires_at) < nowMs);
  if (!stale.length) return 0;
  for (const inv of stale) {
    update('team_invites', i => i.id === inv.id, { reservation_released: true, reservation_released_at: new Date().toISOString(), reservation_release_reason: 'expired' });
  }
  const team = getTeam(teamId);
  if (team) {
    update('teams', t => t.id === teamId, {
      seats_used: Math.max(0, (team.seats_used || 0) - stale.length),
      updated_at: new Date().toISOString(),
    });
  }
  return stale.length;
}

export function inviteToTeam(teamId, email, role, byTenantId) {
  requireRole(teamId, byTenantId, 'admin');
  // Reject an unknown role rather than silently coercing it to 'member' - a
  // typo'd role ('admon', 'wizard') must surface as a 400, not quietly downgrade
  // the invitee's intended access. The routes map code:'bad_request' -> 400.
  if (!ROLES.includes(role)) throw Object.assign(new Error('bad role'), { code: 'bad_request' });
  if (role === 'owner') throw Object.assign(new Error('cannot invite directly as owner'), { code: 'bad_request' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Object.assign(new Error('valid email required'), { code: 'bad_request' });
  }
  // Reserve the seat atomically with the limit check. An invite consumes a seat
  // at CREATE time (not accept time) so that N outstanding invites can never
  // exceed seats_max no matter how they are accepted. The reservation is
  // consumed on acceptInvite() and freed on revokeInvite() / expiry.
  return withTransaction(() => {
    reclaimExpiredReservations(teamId);
    // Re-read inside the transaction so the seat check observes the committed
    // seats_used (closes the TOCTOU window with concurrent invites/accepts).
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
      reserved: true,
      reservation_released: false,
    };
    insert('team_invites', invite);
    update('teams', t => t.id === teamId, {
      seats_used: (team.seats_used || 0) + 1,
      updated_at: new Date().toISOString(),
    });
    return { token, expires_at: invite.expires_at, role, team_slug: team.slug };
  });
}

export function findInvite(token) {
  if (!token) return null;
  // Indexed lookup by token (findByField issues a json_extract($.token)=?
  // equality query in sqlite mode, served by an expression index, instead of
  // the linear all('team_invites').filter scan findOne degrades to). Tokens are
  // 24 random bytes so the result set is effectively a single row; we still
  // filter out tombstoned / already-accepted invites in JS to preserve the
  // exact predicate findOne enforced.
  const rows = findByField('team_invites', 'token', token);
  return rows.find(i => i && !i._deleted && !i.accepted_at) || null;
}

export function acceptInvite(token, tenantId, tenantEmail) {
  // Cheap pre-checks outside the transaction (no shared-state mutation). The
  // authoritative seat check + writes happen atomically inside withTransaction
  // below, re-reading the invite + team so concurrent accepts cannot both pass.
  const pre = findInvite(token);
  if (!pre) return { ok: false, reason: 'invite not found or already used' };
  if (new Date(pre.expires_at) < new Date()) return { ok: false, reason: 'invite expired' };
  if (tenantEmail && pre.email !== tenantEmail.toLowerCase()) {
    return { ok: false, reason: `invite was sent to ${pre.email}; sign in with that email to accept` };
  }
  return withTransaction(() => {
    // Re-read the invite inside the transaction. A concurrent accept of the
    // SAME token may have already consumed it.
    const inv = findInvite(token);
    if (!inv) return { ok: false, reason: 'invite not found or already used' };
    if (new Date(inv.expires_at) < new Date()) return { ok: false, reason: 'invite expired' };
    if (tenantEmail && inv.email !== tenantEmail.toLowerCase()) {
      return { ok: false, reason: `invite was sent to ${inv.email}; sign in with that email to accept` };
    }
    const team = getTeam(inv.team_id);
    if (!team) return { ok: false, reason: 'team no longer exists' };

    // Did this invite already reserve a seat at creation time? If so, accepting
    // it CONSUMES the reservation - we must not increment seats_used again, and
    // we must not re-run the limit check (the seat is already ours).
    const reservedSeat = inv.reserved === true && inv.reservation_released !== true;

    const existing = membershipOf(team.id, tenantId);
    if (existing) {
      // Already a member - the invite is redundant. Release any reserved seat
      // so it is not double-counted against an existing membership.
      const patch = { accepted_at: new Date().toISOString() };
      if (reservedSeat) {
        patch.reservation_released = true;
        patch.reservation_released_at = new Date().toISOString();
        patch.reservation_release_reason = 'already_member';
        update('teams', t => t.id === team.id, {
          seats_used: Math.max(0, (team.seats_used || 0) - 1),
          updated_at: new Date().toISOString(),
        });
      }
      update('team_invites', i => i.id === inv.id, patch);
      return { ok: true, team, role: existing.role, already_member: true };
    }

    if (!reservedSeat) {
      // Legacy / unreserved invite: re-read seats_used inside the transaction
      // and enforce the hard limit here (TOCTOU-safe). Then increment.
      if ((team.seats_used || 1) >= (team.seats_max || 1)) {
        return { ok: false, reason: 'team is at seat limit; ask an admin to upgrade or remove a member' };
      }
      update('teams', t => t.id === team.id, { seats_used: (team.seats_used || 0) + 1, updated_at: new Date().toISOString() });
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
    update('team_invites', i => i.id === inv.id, {
      accepted_at: new Date().toISOString(),
      reservation_released: reservedSeat ? true : inv.reservation_released,
      reservation_release_reason: reservedSeat ? 'accepted' : inv.reservation_release_reason,
    });
    return { ok: true, team, role: inv.role };
  });
}

export function listInvites(teamId, byTenantId) {
  requireRole(teamId, byTenantId, 'admin');
  return find('team_invites', i => i.team_id === teamId && !i._deleted && !i.accepted_at);
}

export function revokeInvite(inviteId, byTenantId) {
  const inv = findOne('team_invites', i => i.id === inviteId);
  if (!inv) throw Object.assign(new Error('invite not found'), { code: 'not_found' });
  requireRole(inv.team_id, byTenantId, 'admin');
  return withTransaction(() => {
    // Re-read inside the transaction so two concurrent revokes (or a revoke
    // racing an accept) cannot both free the same reserved seat.
    const cur = findOne('team_invites', i => i.id === inviteId);
    if (!cur || cur._deleted) return true;
    const freeSeat = cur.reserved === true && cur.reservation_released !== true && !cur.accepted_at;
    update('team_invites', i => i.id === inviteId, {
      _deleted: true,
      reservation_released: freeSeat ? true : cur.reservation_released,
      reservation_released_at: freeSeat ? new Date().toISOString() : cur.reservation_released_at,
      reservation_release_reason: freeSeat ? 'revoked' : cur.reservation_release_reason,
    });
    if (freeSeat) {
      const team = getTeam(cur.team_id);
      if (team) {
        update('teams', t => t.id === cur.team_id, {
          seats_used: Math.max(0, (team.seats_used || 0) - 1),
          updated_at: new Date().toISOString(),
        });
      }
    }
    return true;
  });
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

// Team detail enriched with operational prompts for the dashboard/CLI. The
// router merges `pending_events` and `rotate_shared_keys` into its team detail
// response so a departed-member rotation prompt is visible without a separate
// poll. `seat_ceiling` advertises the plan's billable seat cap so the UI can
// show "5 / 5 seats - upgrade to add more".
export function teamDetail(idOrSlug) {
  const team = getTeam(idOrSlug);
  if (!team) return null;
  const pending = listTeamEvents(team.id);
  const rotation = pending.find(e => e.type === 'provider_key.rotation_recommended') || null;
  return {
    ...team,
    seat_ceiling: planSeatCeiling(team.plan),
    pending_events: pending,
    rotate_shared_keys: rotation
      ? { recommended: true, reason: rotation.payload && rotation.payload.reason, since: rotation.created_at, event_id: rotation.id }
      : { recommended: false },
  };
}

export { ROLES, rankOf, planSeatCeiling };
