'use strict';
/**
 * src/model-entitlements.js — employee model-access entitlements.
 *
 * Lets an org decide which employees (users) or teams (groups) may
 * access which registered models, and at what access role. This is the
 * authorization layer that sits between the model registry (what models
 * exist) and chargeback (who spent what): before a user may invoke a
 * model we check that an entitlement grants them access; when they do,
 * the usage-attribution hook records the spend back through chargeback.
 *
 * Storage: event-store, tenant-fenced. Each grant is an append-only
 * record under collection 'model_entitlements'. Revocation is itself an
 * append (a tombstone record) so the log stays append-only and auditable;
 * the materialized view (listEntitlements) folds the log into live grants.
 *
 * Conventions mirrored from groups.js / model-registry.js / chargeback.js:
 *   - every exported fn takes (tenant, ...) as first arg
 *   - all reads go through evStore.findByTenant(collection, tenant)
 *   - all writes go through evStore.append(collection, tenant, record)
 *   - ids are prefixed + crypto.randomUUID()
 *
 * Access roles on a grant mirror the rbac role hierarchy
 * (viewer < member < admin < owner). A model-access role of `viewer`
 * means "may read/list this model"; `member` and above means "may use
 * (invoke) this model". This lets a single grant cover both the read
 * and the use capability without a second record.
 */

const crypto = require('crypto');
const evStore = require('./event-store');
const rbac = require('./rbac');
const groups = require('./groups');
const modelRegistry = require('./model-registry');
const chargeback = require('./chargeback');

const ENTITLEMENTS = 'model_entitlements';

// Access roles a grant may carry, reusing the rbac hierarchy.
const ACCESS_ROLES = rbac.ROLE_ORDER; // ['viewer','member','admin','owner']
const DEFAULT_ROLE = 'member';

// Subject kinds an entitlement may target.
const SUBJECT_GROUP = 'group';
const SUBJECT_USER = 'user';

function _now() { return new Date().toISOString(); }

function _genId() { return 'ent_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24); }

function _normRole(role) {
  const r = String(role || '').toLowerCase();
  return ACCESS_ROLES.indexOf(r) >= 0 ? r : DEFAULT_ROLE;
}

/**
 * Classify a subject id. Group ids are prefixed `grp_` (see groups.js);
 * everything else is treated as a user id. Callers may also pass an
 * explicit { kind } to override.
 */
function _subjectKind(subjectId, explicitKind) {
  if (explicitKind === SUBJECT_GROUP || explicitKind === SUBJECT_USER) return explicitKind;
  return String(subjectId || '').startsWith('grp_') ? SUBJECT_GROUP : SUBJECT_USER;
}

/**
 * Fold the append-only log into the set of live grants for a tenant.
 * A grant is identified by (subject_kind, subject_id, model_id). A later
 * revoke tombstone (action: 'revoke') for the same key removes it; a
 * later grant for the same key replaces (re-grants / updates role).
 * Returns an array of live grant records (most-recent state per key).
 */
function _liveGrants(tenant) {
  const log = evStore.findByTenant(ENTITLEMENTS, tenant) || [];
  const byKey = new Map();
  // log is chronological (append order); last write wins per key.
  for (const rec of log) {
    const key = rec.subject_kind + '|' + rec.subject_id + '|' + rec.model_id;
    if (rec.action === 'revoke') {
      byKey.delete(key);
    } else {
      byKey.set(key, rec);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Grant a group or user access to a model at a given access role.
 *
 * @param tenant          tenant id (required, fences all storage)
 * @param groupOrUser     subject id — a `grp_…` group id or a user id
 * @param modelId         model id (`mdl_…`) from the model registry
 * @param role            access role: viewer|member|admin|owner (default member)
 * @param opts.kind       optional explicit subject kind ('group'|'user')
 * @param opts.granted_by optional principal id recording who granted it
 * @returns the appended grant record
 */
function grantModelAccess(tenant, groupOrUser, modelId, role, opts = {}) {
  if (!tenant) throw new Error('tenant required');
  if (!groupOrUser) throw new Error('subject (group or user) required');
  if (!modelId) throw new Error('model_id required');

  // Fence the model: a tenant may only grant access to its own models.
  const model = modelRegistry.getModel(tenant, modelId);
  if (!model) {
    const e = new Error('model not found');
    e.status = 404;
    e.code = 'not_found';
    throw e;
  }

  const subject_kind = _subjectKind(groupOrUser, opts.kind);

  // If the subject is a group, fence it to the tenant too.
  if (subject_kind === SUBJECT_GROUP) {
    const g = groups.getGroup(tenant, groupOrUser);
    if (!g) {
      const e = new Error('group not found');
      e.status = 404;
      e.code = 'not_found';
      throw e;
    }
  }

  const rec = {
    id: _genId(),
    tenant,
    action: 'grant',
    subject_kind,
    subject_id: String(groupOrUser),
    model_id: String(modelId),
    role: _normRole(role),
    granted_by: opts.granted_by ? String(opts.granted_by) : null,
    created_at: _now(),
  };
  evStore.append(ENTITLEMENTS, tenant, rec);
  return rec;
}

/**
 * Revoke a subject's access to a model. Appends a tombstone so the log
 * stays append-only. Idempotent: revoking a non-existent grant is a
 * no-op that still records the intent. Returns the tombstone record.
 */
function revokeModelAccess(tenant, groupOrUser, modelId, opts = {}) {
  if (!tenant) throw new Error('tenant required');
  if (!groupOrUser) throw new Error('subject (group or user) required');
  if (!modelId) throw new Error('model_id required');

  const subject_kind = _subjectKind(groupOrUser, opts.kind);
  const rec = {
    id: _genId(),
    tenant,
    action: 'revoke',
    subject_kind,
    subject_id: String(groupOrUser),
    model_id: String(modelId),
    role: null,
    granted_by: opts.granted_by ? String(opts.granted_by) : null,
    created_at: _now(),
  };
  evStore.append(ENTITLEMENTS, tenant, rec);
  return rec;
}

/**
 * Resolve the effective access role a user has on a model, considering
 * both direct user grants and grants to any group the user belongs to.
 * Returns the highest-ranked role across all matching live grants, or
 * null if the user has no access.
 */
function effectiveRole(tenant, user, modelId) {
  if (!tenant) throw new Error('tenant required');
  if (!user || !user.id) return null;
  if (!modelId) return null;

  const live = _liveGrants(tenant).filter((g) => g.model_id === modelId);
  if (live.length === 0) return null;

  // Build the set of group ids this user belongs to.
  const groupIds = new Set((groups.groupsForUser(tenant, user.id) || []).map((g) => g.id));

  let best = null; // highest rank seen
  for (const g of live) {
    const matches =
      (g.subject_kind === SUBJECT_USER && g.subject_id === user.id) ||
      (g.subject_kind === SUBJECT_GROUP && groupIds.has(g.subject_id));
    if (!matches) continue;
    if (best === null || rbac.roleRank(g.role) > rbac.roleRank(best)) {
      best = g.role;
    }
  }
  return best;
}

/**
 * True if the user may access (read) the model. A model-access role of
 * viewer or higher grants read access. Tenant-fenced.
 *
 * Returns a decision object so callers can branch on read vs. use:
 *   { allowed, role, can_read, can_use, reason }
 */
function checkModelAccess(tenant, user, modelId) {
  if (!tenant) throw new Error('tenant required');
  if (!modelId) {
    return { allowed: false, role: null, can_read: false, can_use: false, reason: 'model_id required' };
  }

  // Fence the model to the tenant.
  const model = modelRegistry.getModel(tenant, modelId);
  if (!model) {
    return { allowed: false, role: null, can_read: false, can_use: false, reason: 'model not found' };
  }

  // Tenant owners/admins implicitly have full access to their own models.
  if (user && rbac.roleAtLeast(user.role, 'admin')) {
    return { allowed: true, role: user.role, can_read: true, can_use: true, reason: 'tenant_admin' };
  }

  const role = effectiveRole(tenant, user, modelId);
  if (!role) {
    return { allowed: false, role: null, can_read: false, can_use: false, reason: 'no_entitlement' };
  }
  const can_read = rbac.roleAtLeast(role, 'viewer');
  const can_use = rbac.roleAtLeast(role, 'member');
  return { allowed: can_read, role, can_read, can_use, reason: 'entitled' };
}

/**
 * List the live entitlements for a tenant. Each record is annotated with
 * the resolved model name (best-effort) for display. Tenant-fenced.
 *
 * @param tenant
 * @param filter.model_id   restrict to one model
 * @param filter.subject_id restrict to one subject (group or user)
 */
function listEntitlements(tenant, filter = {}) {
  if (!tenant) throw new Error('tenant required');
  let live = _liveGrants(tenant);
  if (filter.model_id) live = live.filter((g) => g.model_id === filter.model_id);
  if (filter.subject_id) live = live.filter((g) => g.subject_id === filter.subject_id);

  const modelsById = new Map((modelRegistry.listModels(tenant) || []).map((m) => [m.id, m]));
  return live.map((g) => ({
    ...g,
    model_name: modelsById.has(g.model_id) ? modelsById.get(g.model_id).name : null,
  }));
}

/**
 * List the models the given user can access within a tenant, annotated
 * with the effective access role + read/use flags. Tenant-fenced.
 *
 * Tenant admins/owners see the full catalog (implicit full access);
 * other users see only models for which they hold a live entitlement
 * (directly or via group membership).
 */
function modelsForUser(tenant, user) {
  if (!tenant) throw new Error('tenant required');
  const catalog = modelRegistry.listModels(tenant) || [];

  if (user && rbac.roleAtLeast(user.role, 'admin')) {
    return catalog.map((m) => ({
      ...m,
      access_role: user.role,
      can_read: true,
      can_use: true,
      via: 'tenant_admin',
    }));
  }

  const out = [];
  for (const m of catalog) {
    const role = effectiveRole(tenant, user, m.id);
    if (!role) continue;
    out.push({
      ...m,
      access_role: role,
      can_read: rbac.roleAtLeast(role, 'viewer'),
      can_use: rbac.roleAtLeast(role, 'member'),
      via: 'entitlement',
    });
  }
  return out;
}

/**
 * Usage-attribution hook. Call this at the moment a user invokes a model
 * (e.g. an inference request) to (a) enforce the entitlement and (b)
 * attribute the spend through chargeback. Throws a 403-style error if the
 * user is not entitled to USE the model.
 *
 * Resolves the user's primary group (first group membership, if any) so
 * the usage event carries a group_id for per-team chargeback aggregation.
 *
 * @param tenant
 * @param user        principal { id, role }
 * @param modelId     model being invoked
 * @param usage.units number of units consumed (tokens, requests, …)
 * @param usage.kind  unit kind (default 'tokens')
 * @param usage.group_id optional explicit group to attribute to
 * @param usage.metadata optional extra context
 * @returns the recorded usage event (from chargeback.recordUsage)
 */
function attributeUsage(tenant, user, modelId, usage = {}) {
  if (!tenant) throw new Error('tenant required');
  if (!user || !user.id) {
    const e = new Error('user required for usage attribution');
    e.status = 401;
    e.code = 'unauthorized';
    throw e;
  }

  const decision = checkModelAccess(tenant, user, modelId);
  if (!decision.can_use) {
    const e = new Error('forbidden: no use-access entitlement for model ' + modelId);
    e.status = 403;
    e.code = 'forbidden';
    throw e;
  }

  // Attribute to an explicit group, else the user's first group, else null.
  let group_id = usage.group_id || null;
  if (!group_id) {
    const mine = groups.groupsForUser(tenant, user.id) || [];
    group_id = mine.length ? mine[0].id : null;
  }

  return chargeback.recordUsage(tenant, {
    user_id: user.id,
    group_id,
    model_id: modelId,
    units: Number(usage.units) || 0,
    kind: usage.kind || 'tokens',
    metadata: Object.assign({ access_role: decision.role }, usage.metadata || {}),
  });
}

module.exports = {
  ACCESS_ROLES,
  grantModelAccess,
  revokeModelAccess,
  checkModelAccess,
  effectiveRole,
  listEntitlements,
  modelsForUser,
  attributeUsage,
};
