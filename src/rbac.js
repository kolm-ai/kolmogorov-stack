// W918 P5.2 — Role-based access control capability matrix for orgs.

export const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
  BILLING: 'billing',
});

const VALID_ROLES = new Set([ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER, ROLES.BILLING]);

// Capability matrix. Keys are action strings; values are Sets of role strings
// permitted to perform the action. Anything not in the table is denied.
const CAPABILITIES = Object.freeze({
  'member:add': new Set([ROLES.OWNER, ROLES.ADMIN]),
  'member:remove': new Set([ROLES.OWNER, ROLES.ADMIN]),
  'member:role:change': new Set([ROLES.OWNER, ROLES.ADMIN]),
  'owner:transfer': new Set([ROLES.OWNER]),
  'invite:create': new Set([ROLES.OWNER, ROLES.ADMIN]),
  'invite:revoke': new Set([ROLES.OWNER, ROLES.ADMIN]),
  'billing:read': new Set([ROLES.OWNER, ROLES.BILLING]),
  'billing:write': new Set([ROLES.OWNER, ROLES.BILLING]),
  'audit:read': new Set([ROLES.OWNER, ROLES.ADMIN]),
  'tenant:read': new Set([ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER, ROLES.BILLING]),
  'tenant:write': new Set([ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER]),
});

export function isValidRole(r) {
  return typeof r === 'string' && VALID_ROLES.has(r);
}

export function can(role, action) {
  if (!isValidRole(role)) return false;
  const allowed = CAPABILITIES[action];
  if (!allowed) return false;
  return allowed.has(role);
}

export function requireRole(role, action) {
  if (!can(role, action)) {
    throw new Error(`forbidden: ${role} cannot ${action}`);
  }
  return true;
}

export function roleHierarchy() {
  return [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER, ROLES.BILLING];
}
