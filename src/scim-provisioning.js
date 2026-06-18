// SCIM 2.0 provisioning + deprovisioning (RFC 7644) - P0.
//
// The existing /v1/scim/v2/Users GET (list) + POST (create) routes live inline
// in src/router.js and persist to the `scim_users` table via store.insert with
// CAMELCASE columns (matching router._scimUserFromRow):
//   { id, tenant_id, externalId, userName, active, name, displayName,
//     emails, groups, created_at, updated_at }
//
// This module adds the per-resource lifecycle operations an IdP (Okta / Azure
// AD / OneLogin) drives for deprovisioning, plus Groups CRUD mapped onto kolm
// rbac roles. It reuses src/store.js primitives only (no dependency on
// helper modules whose export surface might drift), so the seat/key revocation
// is a real, tenant-fenced side effect:
//
//   getUser(tenant, id)            GET    /Users/:id
//   patchUser(tenant, id, ops)     PATCH  /Users/:id   (active:false -> revoke seat + keys)
//   replaceUser(tenant, id, body)  PUT    /Users/:id   (full replace; active:false same)
//   deleteUser(tenant, id)         DELETE /Users/:id   (hard deprovision -> revoke + remove)
//
//   listGroups / getGroup / createGroup / patchGroup / replaceGroup / deleteGroup
//     SCIM Group <-> kolm rbac role binding. A Group whose displayName matches
//     a kolm rbac role (owner/admin/member/billing - see src/rbac.js ROLES)
//     grants that role to its members; removing a member or deleting the Group
//     revokes the grant.
//
// Tenant fencing: `tenant` here is the tenant_id (req.tenant_record.id). Every
// store predicate pins tenant_id, so cross-tenant access is impossible.
//
// Deprovisioning side effects, expressed directly over store.js tables:
//   * Seat release: org membership rows (org_members) for this tenant whose
//     member email matches the user's seat email are removed; if the tenant
//     row tracks a `seats_used` counter it is decremented (never below 0).
//   * Key revocation: rows in the `api_keys` table for this tenant whose
//     member binding (member_email / member / email / label) matches the seat
//     email are tombstoned with revoked_at = now (the auth.js multi-key
//     fallback already treats revoked_at as "no longer authenticates").
//
// Errors: throws a ScimError carrying an RFC 7644 §3.12 status + scimType so
// the router can translate to the SCIM Error envelope. ScimError.toJSON()
// matches the shape the router's _scimError already emits.

import {
  id as storeId,
  insert,
  findOne,
  findByField,
  update,
  remove,
} from './store.js';
import { isValidRole, ROLES } from './rbac.js';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_LISTRESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

const USERS = 'scim_users';
const GROUPS = 'scim_groups';
const ORG_MEMBERS = 'org_members';
const API_KEYS = 'api_keys';
const TENANTS = 'tenants';

// SCIM Group displayNames that bind to a kolm rbac role. Matched
// case-insensitively against src/rbac.js ROLES (owner/admin/member/billing).
// A Group with any other displayName is stored as a plain group, role=null.
const ROLE_NAMES = Object.values(ROLES); // ['owner','admin','member','billing']
// Lowest-privilege role to demote to when a role grant is revoked but the seat
// itself must survive (a Group only governs the GRANT, not seat lifecycle).
const DEMOTE_ROLE = ROLES.MEMBER;

export const SCIM_PROVISIONING_CONTRACT_VERSION = 'w730-scim-v1';
export const SCIM_PROVISIONING_LIMITS = Object.freeze({
  max_tenant_id_chars: 160,
  max_scim_id_chars: 160,
  max_external_id_chars: 256,
  max_display_name_chars: 160,
  max_email_chars: 320,
  max_user_emails: 16,
  max_name_field_chars: 120,
  max_patch_operations: 32,
  max_group_members: 256,
  max_filter_chars: 256,
});

const SAFE_SCIM_ID_RE = /^[A-Za-z0-9._:@+-]+$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const NAME_FIELDS = ['formatted', 'familyName', 'givenName', 'middleName', 'honorificPrefix', 'honorificSuffix'];

// ── Typed error → SCIM Error envelope (RFC 7644 §3.12) ──────────────────────
export class ScimError extends Error {
  constructor(status, detail, scimType) {
    super(detail);
    this.name = 'ScimError';
    this.status = status;
    this.detail = detail;
    this.scimType = scimType; // optional detail keyword: invalidValue, mutability, uniqueness, ...
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

function cleanText(value, field, max, { required = false } = {}) {
  if (value == null) {
    if (required) throw scimError(400, `${field} is required`, 'invalidValue');
    return null;
  }
  if (typeof value === 'object') {
    throw scimError(400, `${field} must be a string`, 'invalidValue');
  }
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) {
    if (required) throw scimError(400, `${field} is required`, 'invalidValue');
    return null;
  }
  if (text.length > max) {
    throw scimError(400, `${field} exceeds maximum length`, 'invalidValue');
  }
  return text;
}

function requireSafeId(value, field, max = SCIM_PROVISIONING_LIMITS.max_scim_id_chars) {
  const text = cleanText(value, field, max, { required: true });
  if (!SAFE_SCIM_ID_RE.test(text)) {
    throw scimError(400, `${field} must be a safe SCIM identifier`, 'invalidValue');
  }
  return text;
}

function requireTenantId(tenantId) {
  if (!tenantId) throw scimError(401, 'auth_required');
  return requireSafeId(tenantId, 'tenant_id', SCIM_PROVISIONING_LIMITS.max_tenant_id_chars);
}

function requireScimId(scimId) {
  if (!scimId) throw scimError(400, 'missing id', 'invalidValue');
  return requireSafeId(scimId, 'id', SCIM_PROVISIONING_LIMITS.max_scim_id_chars);
}

function normalizeEmail(value, field = 'email') {
  const text = cleanText(value, field, SCIM_PROVISIONING_LIMITS.max_email_chars, { required: true }).toLowerCase();
  if (!EMAIL_RE.test(text)) {
    throw scimError(400, `${field} must be a valid email address`, 'invalidValue');
  }
  return text;
}

function normalizeOptionalText(value, field, max) {
  return cleanText(value, field, max, { required: false });
}

function normalizeDisplayName(value, { required = false } = {}) {
  return cleanText(value, 'displayName', SCIM_PROVISIONING_LIMITS.max_display_name_chars, { required });
}

function normalizeExternalId(value) {
  return normalizeOptionalText(value, 'externalId', SCIM_PROVISIONING_LIMITS.max_external_id_chars);
}

function normalizeName(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw scimError(400, 'name must be an object', 'invalidValue');
  }
  const out = {};
  for (const field of NAME_FIELDS) {
    if (value[field] != null) {
      const clean = normalizeOptionalText(value[field], `name.${field}`, SCIM_PROVISIONING_LIMITS.max_name_field_chars);
      if (clean) out[field] = clean;
    }
  }
  return out;
}

function normalizeEmails(emails) {
  if (emails == null) return [];
  if (!Array.isArray(emails)) throw scimError(400, 'emails must be an array', 'invalidValue');
  if (emails.length > SCIM_PROVISIONING_LIMITS.max_user_emails) {
    throw scimError(400, 'emails exceeds maximum entries', 'tooMany');
  }
  const seen = new Set();
  const out = [];
  for (const entry of emails) {
    const value = typeof entry === 'string' ? entry : entry && entry.value;
    const email = normalizeEmail(value, 'emails.value');
    if (seen.has(email)) continue;
    seen.add(email);
    const normalized = { value: email };
    if (entry && typeof entry === 'object') {
      if (entry.primary != null) normalized.primary = coerceBool(entry.primary, false);
      if (entry.type != null) {
        const type = normalizeOptionalText(entry.type, 'emails.type', 64);
        if (type) normalized.type = type;
      }
    }
    out.push(normalized);
  }
  return out;
}

function assertPatchOperationCount(operations) {
  if (operations.length > SCIM_PROVISIONING_LIMITS.max_patch_operations) {
    throw scimError(400, 'PatchOp exceeds maximum Operations entries', 'tooMany');
  }
}

function normalizeMemberValue(value) {
  const text = cleanText(value, 'members.value', SCIM_PROVISIONING_LIMITS.max_email_chars, { required: true });
  if (text.includes('@')) return normalizeEmail(text, 'members.value');
  if (text.length > SCIM_PROVISIONING_LIMITS.max_scim_id_chars || !SAFE_SCIM_ID_RE.test(text)) {
    throw scimError(400, 'members.value must be a safe SCIM identifier or email', 'invalidValue');
  }
  return text;
}

// Strip the optional schema-URN prefix Okta/Azure AD sometimes put on a PATCH
// path (e.g. "urn:...:User:active" -> "active").
function normalizePath(p) {
  if (!p) return '';
  const text = cleanText(p, 'path', 256, { required: false });
  if (!text) return '';
  return text
    .replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, '')
    .trim();
}

// ── User row <-> SCIM resource shaping (mirrors router._scimUserFromRow) ────
function userResource(row, host) {
  const created = row.created_at || nowIso();
  const updated = row.updated_at || created;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    externalId: row.externalId || undefined,
    userName: row.userName,
    active: row.active !== false,
    name: row.name || {},
    displayName: row.displayName || undefined,
    emails: Array.isArray(row.emails) ? row.emails : [],
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

// The email used for seat binding. SCIM userName for kolm is always an email
// (the create route enforces it). Fall back to the primary email if needed.
function seatEmail(row) {
  if (row.userName && String(row.userName).includes('@')) return String(row.userName).toLowerCase();
  if (Array.isArray(row.emails) && row.emails.length) {
    const primary = row.emails.find((e) => e && e.primary) || row.emails[0];
    if (primary && primary.value) return String(primary.value).toLowerCase();
  }
  return row.userName ? String(row.userName).toLowerCase() : null;
}

// ── The actual deprovisioning side effect ───────────────────────────────────
// Release the seat + revoke API keys bound to this user's email. Best-effort,
// idempotent, tenant-fenced. Returns a structured summary for the audit log.
function revokeUserAccess(tenantId, row) {
  const summary = { email: null, seat_released: false, keys_revoked: 0, memberships_removed: 0 };
  const email = seatEmail(row);
  summary.email = email;
  if (!email) return summary;

  // 1) Release org seats: remove every membership row for this tenant whose
  //    email matches. (org_members rows carry tenant_id + email + role.)
  try {
    const seatRows = findByField(ORG_MEMBERS, 'tenant_id', tenantId)
      .filter((m) => m && String(m.email || '').toLowerCase() === email);
    if (seatRows.length) {
      const removed = remove(
        ORG_MEMBERS,
        (m) => m.tenant_id === tenantId && String(m.email || '').toLowerCase() === email,
      );
      summary.memberships_removed = removed;
      summary.seat_released = removed > 0;
      // Decrement the tenant seat counter if present (never below 0).
      const tenant = findOne(TENANTS, (t) => t.id === tenantId);
      if (tenant && typeof tenant.seats_used === 'number') {
        update(TENANTS, (t) => t.id === tenantId, {
          seats_used: Math.max(0, tenant.seats_used - removed),
        });
      }
    }
  } catch { /* best-effort */ }

  // 2) Revoke API keys bound to this seat (member-scoped keys only - never the
  //    tenant's default/owner key, which is not a per-user credential).
  try {
    const keyRows = findByField(API_KEYS, 'tenant_id', tenantId);
    for (const k of keyRows) {
      if (!k || k.revoked_at || k.revoked === true) continue;
      const bound = k.member_email || k.member || k.email || k.label;
      if (bound && String(bound).toLowerCase() === email) {
        const n = update(
          API_KEYS,
          (x) => x.id === k.id && x.tenant_id === tenantId,
          { revoked: true, revoked_at: nowIso(), revoked_by: 'scim' },
        );
        if (n > 0) summary.keys_revoked += 1;
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
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);
  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);
  return userResource(row, host);
}

// PATCH /v1/scim/v2/Users/:id  (RFC 7644 §3.5.2)
//
// The deprovisioning path. Both forms set active=false and revoke access:
//   { Operations: [{ op:"replace", path:"active", value:false }] }
//   { Operations: [{ op:"replace", value:{ active:false } }] }   (no path)
export function patchUser(tenantId, scimId, ops, host) {
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);

  const body = ops || {};
  const operations = Array.isArray(body.Operations) ? body.Operations : [];
  if (!operations.length) throw scimError(400, 'PatchOp requires a non-empty Operations array', 'invalidValue');
  assertPatchOperationCount(operations);

  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);

  const activeBefore = row.active !== false;
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
        if ('userName' in value) patch.userName = normalizeEmail(value.userName, 'userName');
        if ('externalId' in value) patch.externalId = normalizeExternalId(value.externalId);
        if ('name' in value) patch.name = normalizeName(value.name);
        if ('displayName' in value) patch.displayName = normalizeDisplayName(value.displayName);
        if ('emails' in value) patch.emails = normalizeEmails(value.emails);
      }
      continue;
    }

    switch (pathHead) {
      case 'active':
        patch.active = coerceBool(value);
        break;
      case 'userName':
        patch.userName = normalizeEmail(value, 'userName');
        break;
      case 'externalId':
        patch.externalId = normalizeExternalId(value);
        break;
      case 'name':
        patch.name = normalizeName(value);
        break;
      case 'displayName':
        patch.displayName = normalizeDisplayName(value);
        break;
      case 'emails':
        patch.emails = normalizeEmails(value);
        break;
      default:
        // Unknown attribute - accept silently (forward-compatible).
        break;
    }
  }

  update(USERS, (u) => u.id === scimId && u.tenant_id === tenantId, patch);
  const next = getUserRow(tenantId, scimId);

  // Deprovision only on a true -> false transition.
  const activeAfter = next.active !== false;
  let revocation = null;
  if (activeBefore && !activeAfter) {
    revocation = revokeUserAccess(tenantId, next);
  }

  return { resource: userResource(next, host), deprovisioned: !!revocation, revocation };
}

// PUT /v1/scim/v2/Users/:id  (full replace, RFC 7644 §3.5.1)
export function replaceUser(tenantId, scimId, resource, host) {
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);

  const body = resource || {};
  const row = getUserRow(tenantId, scimId);
  if (!row) throw scimError(404, `User ${scimId} not found`);

  const activeBefore = row.active !== false;
  const activeAfter = coerceBool(body.active, true); // absent => active (RFC 7643 §4.1.1)

  const patch = {
    userName: body.userName != null ? normalizeEmail(body.userName, 'userName') : row.userName,
    externalId: 'externalId' in body ? normalizeExternalId(body.externalId) : row.externalId,
    name: 'name' in body ? normalizeName(body.name) : row.name,
    displayName: 'displayName' in body ? normalizeDisplayName(body.displayName) : row.displayName,
    emails: 'emails' in body ? normalizeEmails(body.emails) : row.emails,
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
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);

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
// scim_groups row: { id, tenant_id, displayName, externalId, role,
//                    members:[{value,display}], created_at, updated_at }
// `role` is the bound rbac role (or null). `members[].value` is a SCIM User id;
// we resolve it to a seat email to grant/revoke the role on the org membership.

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
    displayName: row.displayName,
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

function normalizeMembers(members) {
  if (!Array.isArray(members)) return [];
  if (members.length > SCIM_PROVISIONING_LIMITS.max_group_members) {
    throw scimError(400, 'members exceeds maximum entries', 'tooMany');
  }
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const value = m && (m.value || m);
    if (!value) continue;
    const normalizedValue = normalizeMemberValue(value);
    if (seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    const normalized = { value: normalizedValue };
    if (m && typeof m === 'object' && m.display != null) {
      const display = normalizeOptionalText(m.display, 'members.display', SCIM_PROVISIONING_LIMITS.max_display_name_chars);
      if (display) normalized.display = display;
    }
    out.push(normalized);
  }
  return out;
}

// Resolve a member ref (a SCIM User id) to a seat email for role binding.
function memberEmail(tenantId, member) {
  const uid = member && (member.value || member);
  if (!uid) return null;
  const urow = getUserRow(tenantId, uid);
  if (urow) return seatEmail(urow);
  if (typeof uid === 'string' && uid.includes('@')) return String(uid).toLowerCase();
  return null;
}

// Grant or revoke the group's rbac role for a set of members. The grant is
// applied to the org_members row (upserted) - never the seat lifecycle.
function applyRole(tenantId, role, members, grant) {
  if (!role) return;
  for (const m of members || []) {
    const email = memberEmail(tenantId, m);
    if (!email) continue;
    try {
      const existing = findByField(ORG_MEMBERS, 'tenant_id', tenantId)
        .find((row) => String(row.email || '').toLowerCase() === email);
      if (grant) {
        if (existing) {
          update(ORG_MEMBERS, (row) => row.id === existing.id && row.tenant_id === tenantId, {
            role, updated_at: nowIso(),
          });
        } else {
          insert(ORG_MEMBERS, {
            id: storeId('member'),
            tenant_id: tenantId,
            email,
            role,
            source: 'scim',
            created_at: nowIso(),
            updated_at: nowIso(),
          });
        }
      } else if (existing) {
        // Revoke the GRANT by demoting to the lowest role - do NOT remove the
        // seat (seat lifecycle belongs to the User resource, not the group).
        update(ORG_MEMBERS, (row) => row.id === existing.id && row.tenant_id === tenantId, {
          role: DEMOTE_ROLE, updated_at: nowIso(),
        });
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
  tenantId = requireTenantId(tenantId);
  let rows = findByField(GROUPS, 'tenant_id', tenantId);
  if (filter) {
    const filterText = cleanText(filter, 'filter', SCIM_PROVISIONING_LIMITS.max_filter_chars, { required: false });
    const m = filterText && filterText.match(/(\w+)\s+eq\s+"([^"]*)"/i);
    if (m) {
      const field = m[1];
      if (['id', 'displayName', 'externalId'].includes(field)) {
        rows = rows.filter((g) => String(g[field] || '') === m[2]);
      }
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
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);
  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);
  return groupResource(row, host);
}

// POST /v1/scim/v2/Groups
export function createGroup(tenantId, resource, host) {
  tenantId = requireTenantId(tenantId);
  const body = resource || {};
  const displayName = normalizeDisplayName(body.displayName, { required: true });
  const externalId = normalizeExternalId(body.externalId);

  const existing = findByField(GROUPS, 'tenant_id', tenantId)
    .find((g) => String(g.displayName || '').toLowerCase() === displayName.toLowerCase());
  if (existing) throw scimError(409, 'a Group with this displayName already exists for this tenant', 'uniqueness');

  const members = normalizeMembers(body.members);
  const now = nowIso();
  const row = {
    id: storeId('scim_group'),
    tenant_id: tenantId,
    displayName,
    externalId,
    role: roleForDisplayName(displayName),
    members,
    created_at: now,
    updated_at: now,
  };
  insert(GROUPS, row);
  if (row.role) applyRole(tenantId, row.role, members, true);
  return groupResource(row, host);
}

// PATCH /v1/scim/v2/Groups/:id  (member add/remove/replace; displayName replace)
export function patchGroup(tenantId, scimId, ops, host) {
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);
  const body = ops || {};
  const operations = Array.isArray(body.Operations) ? body.Operations : [];
  if (!operations.length) throw scimError(400, 'PatchOp requires a non-empty Operations array', 'invalidValue');
  assertPatchOperationCount(operations);

  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);

  const oldMembers = Array.isArray(row.members) ? row.members.slice() : [];
  const oldRole = row.role;
  let members = oldMembers.slice();
  let displayName = row.displayName;
  let role = row.role;
  let roleChanged = false;
  const granted = [];
  const revoked = [];

  for (const op of operations) {
    if (!op || typeof op !== 'object') throw scimError(400, 'malformed PatchOp operation', 'invalidSyntax');
    const verb = String(op.op || '').toLowerCase();
    const pathRaw = String(op.path || '');
    const pathHead = normalizePath(op.path);
    const value = op.value;

    if (verb !== 'add' && verb !== 'replace' && verb !== 'remove') {
      throw scimError(400, `unsupported op: ${op.op}`, 'invalidValue');
    }

    // displayName replace also re-binds the role.
    if (pathHead === 'displayName' && verb === 'replace') {
      displayName = normalizeDisplayName(value, { required: true });
      role = roleForDisplayName(displayName);
      roleChanged = role !== oldRole;
      continue;
    }

    // members[value eq "<id>"] filtered removal (Azure AD style).
    const filterMatch = pathRaw.match(/members\[\s*value\s+eq\s+"([^"]+)"\s*\]/i);
    if (verb === 'remove' && filterMatch) {
      const target = normalizeMemberValue(filterMatch[1]);
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
    // Unknown path - accept silently (forward-compatible).
  }

  update(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId, {
    displayName,
    role,
    members,
    updated_at: nowIso(),
  });

  // Reconcile role bindings.
  if (roleChanged) {
    if (oldRole) applyRole(tenantId, oldRole, oldMembers, false);
    if (role) applyRole(tenantId, role, members, true);
  } else if (role) {
    if (granted.length) applyRole(tenantId, role, granted, true);
    if (revoked.length) applyRole(tenantId, role, revoked, false);
  }

  return groupResource(getGroupRow(tenantId, scimId), host);
}

// PUT /v1/scim/v2/Groups/:id  (full replace)
export function replaceGroup(tenantId, scimId, resource, host) {
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);
  const body = resource || {};
  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);

  const oldMembers = Array.isArray(row.members) ? row.members : [];
  const oldRole = row.role;
  const newDisplay = body.displayName != null ? normalizeDisplayName(body.displayName, { required: true }) : row.displayName;
  const newRole = roleForDisplayName(newDisplay);
  const newMembers = normalizeMembers(body.members);

  update(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId, {
    displayName: newDisplay,
    externalId: 'externalId' in body ? normalizeExternalId(body.externalId) : row.externalId,
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
  tenantId = requireTenantId(tenantId);
  scimId = requireScimId(scimId);
  const row = getGroupRow(tenantId, scimId);
  if (!row) throw scimError(404, `Group ${scimId} not found`);

  // Revoke the role grant from all members before removing the binding.
  if (row.role) applyRole(tenantId, row.role, row.members || [], false);
  remove(GROUPS, (g) => g.id === scimId && g.tenant_id === tenantId);
  return { deleted: true };
}

// Exported for the router's _scimError translation + tests.
export { scimError, userResource, groupResource, USERS, GROUPS, ROLE_NAMES };
