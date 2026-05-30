// SCIM 2.0 provisioning + deprovisioning (RFC 7644) — P0.
//
// The existing /v1/scim/v2/Users GET (list) + POST (create) routes live
// inline in src/router.js and persist to the `scim_users` collection in
// src/store.js with snake_case columns:
//   { id, tenant_id, user_name, external_id, name_json, emails_json,
//     active, created_at, updated_at }
//
// This module adds the per-resource lifecycle operations that the IdP
// (Okta / Azure AD / OneLogin) drives for deprovisioning, plus Groups CRUD
// mapped onto kolm rbac roles. It reuses the same store.js primitives and
// the auth.js seat/key helpers so deprovisioning is a real side effect:
//
//   getUser(tenant, id)            GET    /Users/:id
//   patchUser(tenant, id, ops)     PATCH  /Users/:id   (active:false -> revoke seat + keys)
//   replaceUser(tenant, id, body)  PUT    /Users/:id   (full replace; active:false same)
//   deleteUser(tenant, id)         DELETE /Users/:id   (hard deprovision -> revoke + remove)
//
//   listGroups / getGroup / createGroup / patchGroup / replaceGroup / deleteGroup
//     SCIM Group <-> rbac role binding. A Group whose displayName matches a
//     kolm rbac role (owner/admin/member/viewer) grants that role to its
//     members; removing a member or deleting the Group revokes it.
//
// Tenant fencing: `tenant` here is the tenant_id (req.tenant_record.id). Every
// read/write is scoped by tenant_id; cross-tenant access is impossible because
// the row predicate always pins tenant_id.
//
// Errors: throws a ScimError carrying an RFC 7644 §3.12 status + scimType so
// the router can translate to the SCIM Error envelope (the router already has
// _scimError(res, status, detail); ScimError.toJSON() matches that shape).

import {
  all,
  insert,
  findOne,
  findByField,
  update,
  remove,
  storeId,
} from './store.js';
import {
  revokeKey,
  listKeys,
  removeMember,
  setMemberRole,
  addMember,
} from './auth.js';
import { isValidRole } from './rbac.js';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_LISTRESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

const USERS = 'scim_users';
const GROUPS = 'scim_groups';

// SCIM Group displayNames that bind to a kolm rbac role. Matched
// case-insensitively against rbac.ROLES. A Group with any other displayName
// is stored as a plain group with no role binding (role = null).
const ROLE_NAMES = ['owner', 'admin', 'member', 'viewer'];

// ── Typed error → SCIM Error envelope (RFC 7644 §3.12) ──────────────────────
export class ScimError extends Error {
  constructor(status, detail, scimType) {
    super(detail);
    this.name = 'ScimError';
    this.status = status;
    this.detail = detail;
    this.scimType = scimType; // optional detail keyword: invalidValue, mutability, ...
  }

  toJSON() {
    const body = {
      schemas: [SCIM_ERROR_SCHEMA],
      detail: this.detail,
      status: String(this.status),
    };
    if (this.scimType) body.scimType = this.scimType;
    return body;
  }
}

function scimError(status, detail, scimType) {
  return new ScimError(status, detail, scimType);
}

function nowIso() {
  return new Date().toISOString();
}

function coerceBool(v, dflt = true) {
  if (v == null) return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return Boolean(v);
}

// Strip the optional schema-URN prefix Azure AD/Okta sometimes put on a PATCH
// path (e.g. "urn:...:User:active" -> "active"). Returns a lower-cased head
// token plus the raw path for filter-expression handling.
function normalizePath(p) {
  if (!p) return '';
  return String(p)
    .replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, '')
    .trim();
}

// ── User row <-> SCIM resource shaping (mirrors router._scimUserFromRow) ────
function userResource(row, host) {
  const created = row.created_at || nowIso();
  const updated = row.updated_at || created;
  let name;
  let emails;
  try { name = row.name_json ? JSON.parse(row.name_json) : undefined; } catch { name = undefined; }
  try { emails = row.emails_json ? JSON.parse(row.emails_json) : undefined; } catch { emails = undefined; }
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    externalId: row.external_id || undefined,
    userName: row.user_name,
    name,
    emails,
    active: row.active !== false && row.active !== 0,
    groups: Array.isArray(row.groups) ? row.groups : [],
    meta: {
      resourceType: 'User',
      created,
      lastModified: updated,
      location: `https://${host || 'kolm.ai'}/v1/scim/v2/Users/${row.id}`,
    },
  };
}

function getUserRow(tenantId, scimId) {
  return findOne(USERS, (u) => u.id === scimId && u.tenant_id === tenantId);
}

// The email used for team-seat binding. SCIM userName for kolm is always an
// email (the create route enforces userName.includes('@')). Fall back to the
// primary email if a userName somehow isn't an address.
function seatEmail(row) {
  if (row.user_name && String(row.user_name).includes('@')) return row.user_name;
  try {
    const emails = row.emails_json ? JSON.parse(row.emails_json) : [];
    if (Array.isArray(emails) && emails.length) {
      const primary = emails.find((e) => e && e.primary) || emails[0];
      if (primary && primary.value) return primary.value;
    }
  } catch { /* fall through */ }
  return row.user_name || null;
}

// ── The actual deprovisioning side effect ───────────────────────────────────
// Revoke every active API key the user's seat owns + release the team seat.
// Best-effort + idempotent: returns a structured summary for the audit log.
function revokeUserAccess(tenantId, row) {
  const summary = { seat_released: false, keys_revoked: 0, email: null };
  const email = seatEmail(row);
  summary.email = email;

  // 1) Release the team seat (membership) for this tenant.
  try {
    if (email) {
      const removed = removeMember(tenantId, email);
      summary.seat_released = removed > 0;
    }
  } catch { /* best-effort */ }

  // 2) Revoke API keys bound to this seat. Keys carry an optional `member` /
  //    `member_email` / `label` binding (team-issued keys label themselves
  //    with the member email). We revoke every non-revoked key whose binding
  //    matches the seat email — never the tenant's other keys.
  try {
    if (email) {
      const keys = listKeys(tenantId) || [];
      for (const k of keys) {
        if (k.revoked) continue;
        const bound = k.member_email || k.member || k.email || k.label;
        if (bound && String(bound).toLowerCase() === String(email).toLowerCase()) {
          if (revokeKey(k.id, tenantId)) summary.keys_revoked += 1;
        }
      }
    }
  } catch { /* best-effort */ }

  return summary;
}

// ════════════════════════════════════════════════════════════════════════════
//  Users
// ════════════════════════════════════════════════════════════════════════════

// GET /v1/scim/v2/Users/:id
export function getUser(tenantId, scimId, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');
  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);
  return userResource(row, host);
}

// PATCH /v1/scim/v2/Users/:id  (RFC 7644 §3.5.2)
//
// The deprovisioning path. Both forms set active=false and revoke access:
//   { Operations: [{ op:"replace", path:"active", value:false }] }
//   { Operations: [{ op:"replace", value:{ active:false } }] }  (no path)
export function patchUser(tenantId, scimId, ops, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');

  const body = ops || {};
  const operations = Array.isArray(body.Operations) ? body.Operations : [];
  if (!operations.length) throw scimError(400, 'PatchOp requires a non-empty Operations array', 'invalidValue');

  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);

  const activeBefore = row.active !== false && row.active !== 0;
  const patch = { updated_at: nowIso() };

  for (const op of operations) {
    if (!op || typeof op !== 'object') throw scimError(400, 'malformed PatchOp operation', 'invalidSyntax');
    const verb = String(op.op || '').toLowerCase();
    const pathHead = normalizePath(op.path);
    const value = op.value;

    if (verb !== 'add' && verb !== 'replace' && verb !== 'remove') {
      throw scimError(400, `unsupported op: ${op.op}`, 'invalidValue');
    }

    if (verb === 'remove') {
      // `remove` of `active` is treated as set-inactive (idempotent deprovision).
      if (pathHead === 'active') patch.active = false;
      continue;
    }

    if (!pathHead) {
      // No-path add/replace: value is a partial User resource.
      if (value && typeof value === 'object') {
        if ('active' in value) patch.active = coerceBool(value.active);
        if ('userName' in value) patch.user_name = value.userName;
        if ('externalId' in value) patch.external_id = value.externalId || null;
        if ('name' in value) patch.name_json = value.name ? JSON.stringify(value.name) : null;
        if ('emails' in value) patch.emails_json = value.emails ? JSON.stringify(value.emails) : null;
      }
      continue;
    }

    switch (pathHead) {
      case 'active':
        patch.active = coerceBool(value);
        break;
      case 'userName':
        patch.user_name = value;
        break;
      case 'externalId':
        patch.external_id = value || null;
        break;
      case 'name':
        patch.name_json = value ? JSON.stringify(value) : null;
        break;
      case 'emails':
        patch.emails_json = value ? JSON.stringify(value) : null;
        break;
      default:
        // Unknown attribute — accept silently (forward-compatible).
        break;
    }
  }

  update(USERS, (u) => u.id === scimId && u.tenant_id === tenantId, patch);
  const next = getUserRow(tenantId, scimId);

  // Deprovision only on a true -> false transition.
  const activeAfter = next.active !== false && next.active !== 0;
  let revocation = null;
  if (activeBefore && !activeAfter) {
    revocation = revokeUserAccess(tenantId, next);
  }

  return { resource: userResource(next, host), deprovisioned: !!revocation, revocation };
}

// PUT /v1/scim/v2/Users/:id  (full replace, RFC 7644 §3.5.1)
export function replaceUser(tenantId, scimId, resource, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');

  const body = resource || {};
  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);

  if (body.userName != null && typeof body.userName === 'string' && !body.userName.includes('@')) {
    throw scimError(400, 'userName must be a valid email address', 'invalidValue');
  }

  const activeBefore = row.active !== false && row.active !== 0;
  const activeAfter = coerceBool(body.active, true); // absent => active (RFC 7643 §4.1.1)

  const patch = {
    user_name: body.userName != null ? body.userName : row.user_name,
    external_id: 'externalId' in body ? (body.externalId || null) : row.external_id,
    name_json: 'name' in body ? (body.name ? JSON.stringify(body.name) : null) : row.name_json,
    emails_json: 'emails' in body ? (body.emails ? JSON.stringify(body.emails) : null) : row.emails_json,
    active: activeAfter,
    updated_at: nowIso(),
    // id, tenant_id, created_at are immutable (RFC 7644 §3.5.1).
  };

  update(USERS, (u) => u.id === scimId && u.tenant_id === tenantId, patch);
  const next = getUserRow(tenantId, scimId);

  let revocation = null;
  if (activeBefore && !activeAfter) {
    revocation = revokeUserAccess(tenantId, next);
  }

  return { resource: userResource(next, host), deprovisioned: !!revocation, revocation };
}

// DELETE /v1/scim/v2/Users/:id  (hard deprovision, RFC 7644 §3.6)
export function deleteUser(tenantId, scimId) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');

  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);

  // Always revoke access on delete (the strongest deprovision), then drop row.
  const revocation = revokeUserAccess(tenantId, row);
  // Remove the user from every group's member list within this tenant.
  removeUserFromAllGroups(tenantId, row);
  remove(USERS, (u) => u.id === scimId && u.tenant_id === tenantId);
  return { deleted: true, revocation };
}

// ════════════════════════════════════════════════════════════════════════════
//  Groups  ->  rbac roles
// ════════════════════════════════════════════════════════════════════════════
//
// scim_groups row: { id, tenant_id, display_name, role, members:[{value,display}],
//                    created_at, updated_at }
// `role` is the bound rbac role (or null for a non-role group). `members[].value`
// is a SCIM User id; we resolve it to a seat email to grant/revoke the role.

function roleForDisplayName(displayName) {
  if (!displayName) return null;
  const dn = String(displayName).trim().toLowerCase();
  return ROLE_NAMES.includes(dn) && isValidRole(dn) ? dn : null;
}

function getGroupRow(tenantId, scimId) {
  return findOne(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId);
}

function groupResource(row, host) {
  const created = row.created_at || nowIso();
  const updated = row.updated_at || created;
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: row.id,
    displayName: row.display_name,
    members: (row.members || []).map((m) => ({
      value: m.value || m,
      display: m.display,
      $ref: `https://${host || 'kolm.ai'}/v1/scim/v2/Users/${m.value || m}`,
    })),
    meta: {
      resourceType: 'Group',
      created,
      lastModified: updated,
      location: `https://${host || 'kolm.ai'}/v1/scim/v2/Groups/${row.id}`,
    },
  };
}

// Resolve a member ref (a SCIM User id) to a seat email for role binding.
function memberEmail(tenantId, member) {
  const uid = member && (member.value || member);
  if (!uid) return null;
  const urow = getUserRow(tenantId, uid);
  if (urow) return seatEmail(urow);
  // Some IdPs send the email/userName directly as the member value.
  if (typeof uid === 'string' && uid.includes('@')) return uid;
  return null;
}

// Grant or revoke the group's rbac role for a set of members.
function applyRole(tenantId, role, members, grant) {
  if (!role) return;
  for (const m of members || []) {
    const email = memberEmail(tenantId, m);
    if (!email) continue;
    try {
      if (grant) {
        // Idempotent: addMember upserts the role for an existing member.
        addMember(tenantId, email, role);
      } else {
        // Revoke the role binding. We demote to 'viewer' (lowest privilege)
        // rather than removing the seat outright — seat lifecycle is the
        // User resource's job (active:false / DELETE). A group only governs
        // the role grant, so removal of the grant must not orphan the seat.
        setMemberRole(tenantId, email, 'viewer');
      }
    } catch { /* best-effort; reconciled on next IdP sync */ }
  }
}

function removeUserFromAllGroups(tenantId, userRow) {
  const groups = findByField(GROUPS, 'tenant_id', tenantId);
  for (const g of groups) {
    if (!Array.isArray(g.members) || !g.members.length) continue;
    const before = g.members.length;
    const kept = g.members.filter((m) => String(m.value || m) !== String(userRow.id));
    if (kept.length !== before) {
      if (g.role) applyRole(tenantId, g.role, [{ value: userRow.id }], false);
      update(GROUPS, (x) => x.id === g.id && x.tenant_id === tenantId, { members: kept, updated_at: nowIso() });
    }
  }
}

// GET /v1/scim/v2/Groups  (RFC 7644 §3.4.2 ListResponse)
export function listGroups(tenantId, { startIndex = 1, count = 100, filter } = {}, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  let rows = findByField(GROUPS, 'tenant_id', tenantId);
  if (filter) {
    const m = String(filter).match(/(\w+)\s+eq\s+"([^"]*)"/i);
    if (m) {
      const field = m[1] === 'displayName' ? 'display_name' : m[1];
      rows = rows.filter((g) => String(g[field] || '') === m[2]);
    }
  }
  rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const si = Math.max(1, parseInt(startIndex, 10) || 1);
  const cnt = Math.min(200, Math.max(0, parseInt(count, 10) || 100));
  const page = rows.slice(si - 1, si - 1 + cnt);
  return {
    schemas: [SCIM_LISTRESPONSE_SCHEMA],
    totalResults: rows.length,
    startIndex: si,
    itemsPerPage: page.length,
    Resources: page.map((g) => groupResource(g, host)),
  };
}

// GET /v1/scim/v2/Groups/:id
export function getGroup(tenantId, scimId, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');
  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);
  return groupResource(row, host);
}

// POST /v1/scim/v2/Groups
export function createGroup(tenantId, resource, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  const body = resource || {};
  if (!body.displayName) throw scimError(400, 'displayName is required', 'invalidValue');

  const existing = findByField(GROUPS, 'tenant_id', tenantId)
    .find((g) => String(g.display_name || '').toLowerCase() === String(body.displayName).toLowerCase());
  if (existing) throw scimError(409, 'a Group with this displayName already exists for this tenant', 'uniqueness');

  const members = normalizeMembers(body.members);
  const now = nowIso();
  const row = {
    id: storeId('scim_group'),
    tenant_id: tenantId,
    display_name: body.displayName,
    external_id: body.externalId || null,
    role: roleForDisplayName(body.displayName),
    members,
    created_at: now,
    updated_at: now,
  };
  insert(GROUPS, row);
  if (row.role) applyRole(tenantId, row.role, members, true);
  return groupResource(row, host);
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) return [];
  return members
    .map((m) => {
      const value = m && (m.value || m);
      if (!value) return null;
      return { value: String(value), display: (m && m.display) || undefined };
    })
    .filter(Boolean);
}

// PATCH /v1/scim/v2/Groups/:id  (member add/remove/replace; displayName replace)
export function patchGroup(tenantId, scimId, ops, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');
  const body = ops || {};
  const operations = Array.isArray(body.Operations) ? body.Operations : [];
  if (!operations.length) throw scimError(400, 'PatchOp requires a non-empty Operations array', 'invalidValue');

  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);

  let members = Array.isArray(row.members) ? row.members.slice() : [];
  let displayName = row.display_name;
  let role = row.role;
  const granted = [];
  const revoked = [];

  for (const op of operations) {
    if (!op || typeof op !== 'object') throw scimError(400, 'malformed PatchOp operation', 'invalidSyntax');
    const verb = String(op.op || '').toLowerCase();
    const pathRaw = String(op.path || '');
    const pathHead = normalizePath(op.path);
    const value = op.value;

    // displayName replace also re-binds the role.
    if (pathHead === 'displayName' && verb === 'replace') {
      displayName = value;
      role = roleForDisplayName(value);
      continue;
    }

    // members[value eq "<id>"] filtered removal (Azure AD style).
    const filterMatch = pathRaw.match(/members\[\s*value\s+eq\s+"([^"]+)"\s*\]/i);
    if (verb === 'remove' && filterMatch) {
      const target = filterMatch[1];
      members = members.filter((m) => {
        const keep = String(m.value || m) !== target;
        if (!keep) revoked.push(m);
        return keep;
      });
      continue;
    }

    // members add/replace/remove (path === 'members' or no-path with value.members).
    const isMembers = pathHead === 'members' || (!pathHead && value && value.members);
    if (isMembers) {
      const incoming = pathHead === 'members' ? value : value.members;
      const list = normalizeMembers(Array.isArray(incoming) ? incoming : [incoming]);
      if (verb === 'add') {
        for (const m of list) {
          if (!members.find((x) => String(x.value) === String(m.value))) {
            members.push(m);
            granted.push(m);
          }
        }
      } else if (verb === 'replace') {
        for (const m of members) revoked.push(m);
        members = list;
        for (const m of list) granted.push(m);
      } else if (verb === 'remove') {
        const drop = new Set(list.map((m) => String(m.value)));
        members = members.filter((m) => {
          const keep = !drop.has(String(m.value));
          if (!keep) revoked.push(m);
          return keep;
        });
      }
      continue;
    }
    // Unknown path — accept silently (forward-compatible).
  }

  update(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId, {
    display_name: displayName,
    role,
    members,
    updated_at: nowIso(),
  });

  // Reconcile role bindings.
  if (role) {
    if (granted.length) applyRole(tenantId, role, granted, true);
    if (revoked.length) applyRole(tenantId, role, revoked, false);
  }

  return groupResource(getGroupRow(tenantId, scimId), host);
}

// PUT /v1/scim/v2/Groups/:id  (full replace)
export function replaceGroup(tenantId, scimId, resource, host) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');
  const body = resource || {};
  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);

  const oldMembers = Array.isArray(row.members) ? row.members : [];
  const oldRole = row.role;
  const newDisplay = body.displayName != null ? body.displayName : row.display_name;
  const newRole = roleForDisplayName(newDisplay);
  const newMembers = normalizeMembers(body.members);

  update(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId, {
    display_name: newDisplay,
    external_id: 'externalId' in body ? (body.externalId || null) : row.external_id,
    role: newRole,
    members: newMembers,
    updated_at: nowIso(),
  });

  // Reconcile: revoke the old role from old members, grant the new role to new.
  if (oldRole) applyRole(tenantId, oldRole, oldMembers, false);
  if (newRole) applyRole(tenantId, newRole, newMembers, true);

  return groupResource(getGroupRow(tenantId, scimId), host);
}

// DELETE /v1/scim/v2/Groups/:id
export function deleteGroup(tenantId, scimId) {
  if (!tenantId) throw scimError(401, 'auth_required');
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');
  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);

  // Revoke the role grant from all members before removing the binding.
  if (row.role) applyRole(tenantId, row.role, row.members || [], false);
  remove(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId);
  return { deleted: true };
}

// Exported for the router's _scimError translation + tests.
export { scimError, userResource, groupResource, USERS, GROUPS, ROLE_NAMES };
