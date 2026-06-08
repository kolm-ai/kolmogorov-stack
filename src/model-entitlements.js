// Employee model-access entitlements (P1).
//
// Lets an org decide which employees or teams may access which models, and at
// what access role. This is the authorization layer between the model registry
// (which models exist) and chargeback (who spent what): before a principal
// invokes a model we check an entitlement grants access; when they do, the
// usage-attribution hook writes a tenant-fenced event the chargeback report
// rolls up per user / team / namespace.
//
// IDENTITY MODEL (matches src/teams.js): in this codebase an "employee" is a
// TENANT (tenant_id) and a "team/group" is a team_<rand> from teams.js. A
// tenant's team memberships live in the `team_members` table. So a grant's
// subject is either:
//   - a user  : the member tenant_id          (e.g. tenant_abc)
//   - a group : a team id                      (e.g. team_xyz)
// We detect a group subject by the `team_`/`grp_`/`group_` id prefix, or via an
// explicit { kind } override.
//
// TENANT FENCING: every entitlement row carries `tenant_id` = the OWNING org
// tenant (the org that administers the grant). All reads filter on it, exactly
// like src/groups.js scopes to tenant_id and soft-deletes via `_deleted`.
//
// ACCESS-ROLE LADDER (this module's own, separate from team roles):
//   viewer < user < admin
//   - viewer : may READ/list the model
//   - user   : may READ and USE (invoke) the model
//   - admin  : may READ, USE, and is flagged a model steward
// One grant therefore covers both read and use without a second record.
//
// USAGE ATTRIBUTION: attributeUsage() enforces use-access then appendEvent()s a
// tenant-fenced row (provider 'kolm-model-access'); src/chargeback.js reads the
// same event-store so per-team / per-user spend rolls up for free.

import { id as storeId, insert, findOne, update, all } from './store.js';
import { appendEvent } from './event-store.js';
import { membershipOf, listTeamsForTenant } from './teams.js';
import { FRONTIER_MODELS, CANDIDATE_MODELS, BACKBONES } from './model-registry.js';

const TABLE = 'model_entitlements';

// Ordered access-role ladder. Index = rank (higher = more access).
export const ACCESS_ROLES = Object.freeze(['viewer', 'user', 'admin']);
const DEFAULT_ROLE = 'user';

const SUBJECT_USER = 'user';
const SUBJECT_GROUP = 'group';

function _now() {
  return new Date().toISOString();
}

function _rank(role) {
  const i = ACCESS_ROLES.indexOf(String(role || '').toLowerCase());
  return i < 0 ? -1 : i;
}

function _normRole(role) {
  const r = String(role || '').toLowerCase();
  return ACCESS_ROLES.includes(r) ? r : DEFAULT_ROLE;
}

function _err(message, code, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

// Classify a subject id. Team/group ids are prefixed `team_` (teams.js),
// `grp_`, or `group_`; anything else is a user (member tenant) id. An explicit
// kind overrides.
function _subjectKind(subjectId, explicitKind) {
  if (explicitKind === SUBJECT_GROUP || explicitKind === SUBJECT_USER) return explicitKind;
  const s = String(subjectId || '');
  return (s.startsWith('team_') || s.startsWith('grp_') || s.startsWith('group_'))
    ? SUBJECT_GROUP
    : SUBJECT_USER;
}

// ---------------------------------------------------------------------------
// Model-registry helpers. The registry is a static catalog keyed by string id
// across three lists; a model "exists" if its id appears in any of them.
// ---------------------------------------------------------------------------
function _catalog() {
  return [
    ...(Array.isArray(FRONTIER_MODELS) ? FRONTIER_MODELS : []),
    ...(Array.isArray(CANDIDATE_MODELS) ? CANDIDATE_MODELS : []),
    ...(Array.isArray(BACKBONES) ? BACKBONES : []),
  ];
}

// Resolve a catalog row by id. Catalog ids are global (not tenant-scoped);
// tenant fencing applies to ENTITLEMENTS, not to which base models exist. A
// tenant may also grant access to a tenant-private model id absent from the
// static catalog (e.g. a compiled artifact id) - see opts.requireKnownModel.
export function getCatalogModel(modelId) {
  if (!modelId) return null;
  const want = String(modelId);
  return _catalog().find((m) => m && m.id === want) || null;
}

export function modelExists(modelId) {
  return !!getCatalogModel(modelId);
}

// ---------------------------------------------------------------------------
// Membership resolution against teams.js. A grant to a team_ id matches a user
// if that user (member tenant) has an active membership in the team. We resolve
// the user's team ids from teams.js (server-side, authoritative) so callers
// cannot spoof group access by supplying fake ids.
// ---------------------------------------------------------------------------
function _userId(user) {
  if (!user) return null;
  // The principal IS a tenant in this codebase; accept several field names.
  return user.tenant_id || user.id || user.user_id || null;
}

function _teamIdsForUser(user) {
  const uid = _userId(user);
  if (!uid) return new Set();
  try {
    const teams = listTeamsForTenant(uid) || [];
    return new Set(teams.map((t) => t.id));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Live-grant fold. grant inserts/updates a row; revoke soft-deletes it
// (_deleted, mirroring groups.deleteGroup). A grant for an existing
// (subject, model) key UPDATES the role in place so live rows never duplicate.
// ---------------------------------------------------------------------------
function _liveGrants(tenant) {
  return all(TABLE).filter((r) => r && !r._deleted && r.tenant_id === tenant);
}

function _findLive(tenant, subjectId, modelId) {
  return findOne(TABLE, (r) =>
    r
    && !r._deleted
    && r.tenant_id === tenant
    && r.subject_id === String(subjectId)
    && r.model_id === String(modelId),
  ) || null;
}

/**
 * Grant a team or user access to a model at a given access role.
 *
 * @param {string} tenant        OWNING org tenant id (required; fences storage)
 * @param {string} groupOrUser   subject id - a `team_` group id or a user/member tenant id
 * @param {string} modelId       model id from the registry (or a tenant-private id)
 * @param {string} [role]        access role: viewer|user|admin (default 'user')
 * @param {object} [opts]
 * @param {'group'|'user'} [opts.kind]    explicit subject kind override
 * @param {string} [opts.granted_by]      principal id recording who granted it
 * @param {boolean} [opts.requireKnownModel=false]  reject unknown model ids when true
 * @returns {object} the live grant row
 */
export function grantModelAccess(tenant, groupOrUser, modelId, role, opts = {}) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!groupOrUser) throw _err('subject (group or user) required', 'bad_request', 400);
  if (!modelId) throw _err('model_id required', 'bad_request', 400);

  if (opts.requireKnownModel && !modelExists(modelId)) {
    throw _err(`model '${modelId}' not found in registry`, 'not_found', 404);
  }

  const subject_kind = _subjectKind(groupOrUser, opts.kind);
  const normRole = _normRole(role);
  const now = _now();

  // Update-in-place if a live grant already exists for this (subject, model).
  const existing = _findLive(tenant, groupOrUser, modelId);
  if (existing) {
    update(TABLE, (r) => r.id === existing.id, {
      role: normRole,
      granted_by: opts.granted_by ? String(opts.granted_by) : (existing.granted_by || null),
      updated_at: now,
    });
    return _findLive(tenant, groupOrUser, modelId);
  }

  const row = {
    id: storeId('ent'),
    tenant_id: tenant,
    subject_kind,
    subject_id: String(groupOrUser),
    model_id: String(modelId),
    role: normRole,
    granted_by: opts.granted_by ? String(opts.granted_by) : null,
    created_at: now,
    updated_at: now,
  };
  insert(TABLE, row);
  return row;
}

/**
 * Revoke a subject's access to a model. Soft-deletes the live grant row.
 * Idempotent: revoking a non-existent grant returns { revoked: false }.
 *
 * @returns {{ revoked: boolean, grant?: object }}
 */
export function revokeModelAccess(tenant, groupOrUser, modelId, _opts = {}) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!groupOrUser) throw _err('subject (group or user) required', 'bad_request', 400);
  if (!modelId) throw _err('model_id required', 'bad_request', 400);

  const existing = _findLive(tenant, groupOrUser, modelId);
  if (!existing) return { revoked: false };
  update(TABLE, (r) => r.id === existing.id, { _deleted: true, deleted_at: _now() });
  return { revoked: true, grant: { ...existing, _deleted: true } };
}

/**
 * Effective access role a user holds on a model within an org tenant,
 * considering BOTH direct user grants AND grants to any team the user belongs
 * to. Returns the highest-ranked role across matching live grants, or null.
 */
export function effectiveRole(tenant, user, modelId) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!modelId) return null;
  const uid = _userId(user);
  const teamIds = _teamIdsForUser(user);

  let best = null;
  for (const g of _liveGrants(tenant)) {
    if (g.model_id !== String(modelId)) continue;
    const matches =
      (g.subject_kind === SUBJECT_USER && uid != null && g.subject_id === String(uid)) ||
      (g.subject_kind === SUBJECT_GROUP && teamIds.has(g.subject_id));
    if (!matches) continue;
    if (best === null || _rank(g.role) > _rank(best)) best = g.role;
  }
  return best;
}

/**
 * Decide whether a user may access a model.
 * Returns { allowed, role, can_read, can_use, reason }.
 *
 * The org admin/owner of the OWNING tenant implicitly has full access (the
 * principal's `org_role`/`role` of owner|admin short-circuits). Entitlements
 * are an additive grant layer on top of base org-admin capability.
 *
 * @param {string} tenant   owning org tenant id
 * @param {object} user     principal { tenant_id|id, role?/org_role? }
 * @param {string} modelId
 */
export function checkModelAccess(tenant, user, modelId) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!modelId) {
    return { allowed: false, role: null, can_read: false, can_use: false, reason: 'model_id required' };
  }

  const orgRole = String((user && (user.org_role || user.role)) || '').toLowerCase();
  if (orgRole === 'owner' || orgRole === 'admin') {
    return { allowed: true, role: 'admin', can_read: true, can_use: true, reason: 'org_admin' };
  }

  const role = effectiveRole(tenant, user, modelId);
  if (!role) {
    return { allowed: false, role: null, can_read: false, can_use: false, reason: 'no_entitlement' };
  }
  const can_read = _rank(role) >= _rank('viewer');
  const can_use = _rank(role) >= _rank('user');
  return { allowed: can_read, role, can_read, can_use, reason: 'entitled' };
}

/**
 * List the live entitlements for an org tenant, annotated with resolved model
 * name (best-effort from the catalog). Tenant-fenced.
 *
 * @param {string} tenant
 * @param {object} [filter]
 * @param {string} [filter.model_id]    restrict to one model
 * @param {string} [filter.subject_id]  restrict to one subject (team or user)
 */
export function listEntitlements(tenant, filter = {}) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  let live = _liveGrants(tenant);
  if (filter.model_id) live = live.filter((g) => g.model_id === String(filter.model_id));
  if (filter.subject_id) live = live.filter((g) => g.subject_id === String(filter.subject_id));
  return live
    .map((g) => {
      const m = getCatalogModel(g.model_id);
      return {
        id: g.id,
        tenant_id: g.tenant_id,
        subject_kind: g.subject_kind,
        subject_id: g.subject_id,
        model_id: g.model_id,
        model_name: m ? (m.id || null) : null,
        model_known: !!m,
        role: g.role,
        granted_by: g.granted_by || null,
        created_at: g.created_at,
        updated_at: g.updated_at,
      };
    })
    .sort((a, b) => String(a.model_id).localeCompare(String(b.model_id))
      || String(a.subject_id).localeCompare(String(b.subject_id)));
}

/**
 * Models the given user can access within an org tenant, annotated with
 * effective role + read/use flags. Tenant-fenced.
 *
 * Org admins/owners see the full catalog (implicit full access). Other users
 * see only models for which they hold a live entitlement (directly or via a
 * team), plus catalog metadata we can resolve.
 */
export function modelsForUser(tenant, user) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);

  const orgRole = String((user && (user.org_role || user.role)) || '').toLowerCase();
  if (orgRole === 'owner' || orgRole === 'admin') {
    return _catalog().map((m) => ({
      model_id: m.id,
      model: m,
      model_known: true,
      access_role: 'admin',
      can_read: true,
      can_use: true,
      via: 'org_admin',
    }));
  }

  const out = [];
  const seen = new Set();
  for (const g of _liveGrants(tenant)) {
    if (seen.has(g.model_id)) continue;
    const role = effectiveRole(tenant, user, g.model_id);
    if (!role) continue;
    seen.add(g.model_id);
    const m = getCatalogModel(g.model_id);
    out.push({
      model_id: g.model_id,
      model: m || null,
      model_known: !!m,
      access_role: role,
      can_read: _rank(role) >= _rank('viewer'),
      can_use: _rank(role) >= _rank('user'),
      via: 'entitlement',
    });
  }
  return out.sort((a, b) => String(a.model_id).localeCompare(String(b.model_id)));
}

/**
 * Usage-attribution hook. Call at the moment a user invokes a model to
 * (a) ENFORCE the entitlement and (b) attribute the spend through the
 * event-store so src/chargeback.js rolls it up per user / team / namespace.
 *
 * Throws a 403 (code 'forbidden') if the user lacks USE access. Returns the
 * persisted event row.
 *
 * @param {string} tenant            owning org tenant id
 * @param {object} user              principal { tenant_id|id, role?/org_role? }
 * @param {string} modelId
 * @param {object} [usage]
 * @param {number} [usage.tokens_in=0]
 * @param {number} [usage.tokens_out=0]
 * @param {number} [usage.cost_usd=0]
 * @param {string} [usage.namespace]   defaults to 'model-access'
 * @param {string} [usage.group_id]    explicit team to attribute to (else first membership)
 * @param {object} [usage.metadata]    extra context merged into the event metadata
 */
export async function attributeUsage(tenant, user, modelId, usage = {}) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  const uid = _userId(user);
  if (!uid) throw _err('user required for usage attribution', 'unauthorized', 401);
  if (!modelId) throw _err('model_id required', 'bad_request', 400);

  const decision = checkModelAccess(tenant, user, modelId);
  if (!decision.can_use) {
    throw _err(`forbidden: no use-access entitlement for model ${modelId}`, 'forbidden', 403);
  }

  // Attribute to an explicit team, else the user's first team membership.
  let group_id = usage.group_id || null;
  if (!group_id) {
    const teamIds = _teamIdsForUser(user);
    group_id = teamIds.size ? Array.from(teamIds)[0] : null;
  }

  // The event-store canonicalises to a fixed column set; `metadata` is best-
  // effort (it does not round-trip on every driver) but the first-class
  // columns (namespace, estimated_cost_usd, prompt/completion_tokens) always
  // do, and src/chargeback.js groups on those. To keep per-user / per-team
  // chargeback reliable WITHOUT depending on metadata persistence, we encode
  // the attribution into the namespace as `model-access/<group>/<user>` (the
  // chargeback project/department mappers split on the first segment, so this
  // still rolls up cleanly under "model-access"). We ALSO stamp metadata for
  // richer stores. We do not read the returned event back for these fields - 
  // the caller gets whatever the store returns.
  const baseNs = usage.namespace || 'model-access';
  const attributionNs = `${baseNs}/${group_id || 'no-team'}/${uid}`;
  const cost = Number(usage.cost_usd) || 0;
  const attribution = {
    kind: 'model_usage',
    user_id: uid,
    group_id,
    model_id: String(modelId),
    access_role: decision.role,
  };
  const ev = await appendEvent({
    tenant_id: tenant,
    namespace: attributionNs,
    provider: 'kolm-model-access',
    model: String(modelId),
    status: 'ok',
    estimated_cost_usd: cost,
    prompt_tokens: Number(usage.tokens_in) || 0,
    completion_tokens: Number(usage.tokens_out) || 0,
    metadata: {
      ...attribution,
      ...(usage.metadata && typeof usage.metadata === 'object' ? usage.metadata : {}),
    },
  });
  // Return a normalized result that always carries the attribution fields the
  // caller asked us to record, regardless of how the store canonicalised them.
  return {
    ok: true,
    event_id: ev && ev.event_id ? ev.event_id : null,
    tenant_id: tenant,
    namespace: attributionNs,
    estimated_cost_usd: cost,
    prompt_tokens: Number(usage.tokens_in) || 0,
    completion_tokens: Number(usage.tokens_out) || 0,
    attribution,
    event: ev,
  };
}

export default {
  ACCESS_ROLES,
  getCatalogModel,
  modelExists,
  grantModelAccess,
  revokeModelAccess,
  effectiveRole,
  checkModelAccess,
  listEntitlements,
  modelsForUser,
  attributeUsage,
};
