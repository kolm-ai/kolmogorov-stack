const ROLE_RANK = Object.freeze({
  viewer: 10,
  member: 20,
  admin: 30,
  owner: 40,
});

const ACTIONS = Object.freeze({
  'capture:read': { min_role: 'viewer', accepted_scopes: ['capture:read', 'capture:*', 'lake:read', '*'] },
  'capture:write': { min_role: 'member', accepted_scopes: ['capture:write', 'capture:*', '*'] },
  'capture:stream': { min_role: 'viewer', accepted_scopes: ['capture:read', 'capture:stream', 'capture:*', '*'] },
  'lake:export': { min_role: 'admin', accepted_scopes: ['lake:export', 'lake:*', '*'] },
  'namespace:admin': { min_role: 'admin', accepted_scopes: ['namespace:admin', 'team:admin', '*'] },
  'privacy:configure': { min_role: 'admin', accepted_scopes: ['privacy:write', 'team:admin', '*'] },
});

function rank(role) {
  return ROLE_RANK[String(role || 'viewer').toLowerCase()] || 0;
}

function normalizeScopes(scopes) {
  if (typeof scopes === 'string') return scopes.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(scopes)) return scopes.map(String).filter(Boolean);
  return [];
}

function scopeAllows(scopes, accepted) {
  const set = new Set(normalizeScopes(scopes));
  return accepted.some((s) => set.has(s));
}

export function captureRbacPolicy() {
  return {
    ok: true,
    spec: 'kolm-team-capture-rbac/1',
    roles: Object.entries(ROLE_RANK).map(([id, r]) => ({ id, rank: r })),
    actions: ACTIONS,
    tenant_fencing: [
      'capture rows carry tenant_id and corpus_namespace',
      'team_id is optional and must be membership-checked before shared lake reads',
      'API keys need an accepted scope and the member role must meet min_role',
      'export/admin actions are never granted by capture write scope alone',
    ],
    secret_values_included: false,
  };
}

export function authorizeCaptureAction({
  action = 'capture:read',
  tenantId,
  rowTenantId,
  teamId = null,
  memberTeamIds = [],
  memberRole = 'viewer',
  keyScopes = [],
  namespace = 'default',
  allowedNamespaces = ['*'],
} = {}) {
  const rule = ACTIONS[action];
  if (!rule) return { ok: false, action, reason: 'unknown_action' };
  if (!tenantId) return { ok: false, action, reason: 'tenant_required' };
  if (rowTenantId && rowTenantId !== tenantId) {
    return { ok: false, action, reason: 'tenant_mismatch', tenant_fenced: true };
  }
  if (teamId && !new Set(memberTeamIds.map(String)).has(String(teamId))) {
    return { ok: false, action, reason: 'team_membership_required', tenant_fenced: true };
  }
  if (rank(memberRole) < rank(rule.min_role)) {
    return { ok: false, action, reason: 'insufficient_role', required_role: rule.min_role, member_role: memberRole };
  }
  if (!scopeAllows(keyScopes, rule.accepted_scopes)) {
    return { ok: false, action, reason: 'insufficient_scope', accepted_scopes: rule.accepted_scopes };
  }
  const nsSet = new Set((allowedNamespaces || []).map(String));
  if (!nsSet.has('*') && !nsSet.has(String(namespace || 'default'))) {
    return { ok: false, action, reason: 'namespace_not_allowed', namespace };
  }
  return {
    ok: true,
    action,
    tenant_id: tenantId,
    team_id: teamId,
    namespace: namespace || 'default',
    member_role: memberRole,
    matched_scope: rule.accepted_scopes.find((s) => new Set(normalizeScopes(keyScopes)).has(s)) || null,
    tenant_fenced: true,
  };
}

export function teamCaptureEnvelope({
  tenantId,
  teamId = null,
  namespace = 'default',
  actorId = null,
  action = 'capture:write',
  keyScopes = [],
  memberRole = 'member',
} = {}) {
  const authz = authorizeCaptureAction({
    action,
    tenantId,
    rowTenantId: tenantId,
    teamId,
    memberTeamIds: teamId ? [teamId] : [],
    memberRole,
    keyScopes,
    namespace,
  });
  return {
    ok: authz.ok,
    spec: 'kolm-team-capture-envelope/1',
    tenant_id: tenantId || null,
    team_id: teamId || null,
    namespace: namespace || 'default',
    actor_id: actorId || null,
    action,
    authorization: authz,
    persisted_fields: ['tenant_id', 'team_id', 'corpus_namespace', 'actor_id', 'key_scope_hash'],
    secret_values_included: false,
  };
}

export default {
  captureRbacPolicy,
  authorizeCaptureAction,
  teamCaptureEnvelope,
};
