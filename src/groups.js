// W910-E2 - Compile groups.
//
// A compile group is a named bundle of namespaces that should compile as one
// model. Examples:
//   "support-all"  = [retail-support, b2b-support, billing-support]
//   "ops-tier-1"   = [ops-incidents, ops-runbooks]
//
// `kolm compile --group support-all` pulls captures from every namespace in
// the group, validates the caller has access to each, and threads the list
// (plus pairs_per_namespace) into the passport so downstream verifiers can
// see exactly which corpora went in.
//
// Persistence: rows land in the `groups` table via src/store.js. Each row is
// scoped to `tenant_id`; cross-tenant reads are blocked at the call site.
//
// Identity: stable `id` (group_<rand>) + URL slug. Slug is unique within a
// tenant.

import crypto from 'node:crypto';
import { id, insert, findOne, update, all } from './store.js';

const TABLE = 'groups';

function sanitizeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function sanitizeName(s) {
  return String(s || '').replace(/[<>"']/g, '').slice(0, 80).trim();
}

function uniqueSlug(tenantId, base) {
  const baseSlug = base || 'group';
  const existing = all(TABLE).filter(g => g.tenant_id === tenantId && !g._deleted);
  if (!existing.find(g => g.slug === baseSlug)) return baseSlug;
  for (let i = 2; i < 999; i += 1) {
    const cand = `${baseSlug}-${i}`;
    if (!existing.find(g => g.slug === cand)) return cand;
  }
  return baseSlug + '-' + crypto.randomBytes(2).toString('hex');
}

function normalizeNamespaces(input) {
  if (!input) return [];
  const list = Array.isArray(input)
    ? input
    : String(input).split(/[,\s]+/).filter(Boolean);
  const cleaned = list
    .map(n => String(n).trim())
    .filter(Boolean)
    .map(n => n.toLowerCase());
  return [...new Set(cleaned)];
}

export function createGroup({ tenantId, name, namespaces = [] }) {
  if (!tenantId) throw Object.assign(new Error('tenantId required'), { code: 'bad_request' });
  const cleanName = sanitizeName(name);
  if (!cleanName) throw Object.assign(new Error('group name required'), { code: 'bad_request' });
  const slug = uniqueSlug(tenantId, sanitizeSlug(cleanName));
  const ns = normalizeNamespaces(namespaces);
  const now = new Date().toISOString();
  const row = {
    id: id('group'),
    tenant_id: tenantId,
    slug,
    name: cleanName,
    namespaces: ns,
    created_at: now,
    updated_at: now,
  };
  insert(TABLE, row);
  return row;
}

export function getGroup(tenantId, idOrSlug) {
  if (!tenantId || !idOrSlug) return null;
  const row = findOne(TABLE, g =>
    !g._deleted
    && g.tenant_id === tenantId
    && (g.id === idOrSlug || g.slug === idOrSlug),
  );
  return row || null;
}

export function listGroups(tenantId) {
  if (!tenantId) return [];
  return all(TABLE)
    .filter(g => !g._deleted && g.tenant_id === tenantId)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function updateGroup(tenantId, idOrSlug, { name, namespaces, addNamespaces, removeNamespaces } = {}) {
  const row = getGroup(tenantId, idOrSlug);
  if (!row) throw Object.assign(new Error('group not found'), { code: 'not_found' });
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) {
    const cleanName = sanitizeName(name);
    if (cleanName) patch.name = cleanName;
  }
  let nextNs = row.namespaces || [];
  if (namespaces !== undefined) {
    nextNs = normalizeNamespaces(namespaces);
  }
  if (addNamespaces) {
    const merged = new Set([...nextNs, ...normalizeNamespaces(addNamespaces)]);
    nextNs = [...merged];
  }
  if (removeNamespaces) {
    const drop = new Set(normalizeNamespaces(removeNamespaces));
    nextNs = nextNs.filter(n => !drop.has(n));
  }
  patch.namespaces = nextNs;
  update(TABLE, g => g.id === row.id, patch);
  return getGroup(tenantId, row.id);
}

export function deleteGroup(tenantId, idOrSlug) {
  const row = getGroup(tenantId, idOrSlug);
  if (!row) return false;
  update(TABLE, g => g.id === row.id, { _deleted: true, deleted_at: new Date().toISOString() });
  return true;
}

// Resolve a group reference at compile time into the list of namespaces and a
// per-namespace pair count. Callers must pass `countPairs(ns)` so we don't
// circularly import the capture store from this leaf module.
//
// Throws { code: 'not_found' } if the group does not exist for this tenant.
// Throws { code: 'empty_group' } if the resolved group has zero namespaces.
// Throws { code: 'empty_namespace', namespace } if any namespace has 0 pairs.
//
// Returns { group, namespaces, pairs_per_namespace, total_pairs }.
export function resolveGroupForCompile(tenantId, idOrSlug, { countPairs }) {
  const row = getGroup(tenantId, idOrSlug);
  if (!row) throw Object.assign(new Error(`group '${idOrSlug}' not found`), { code: 'not_found' });
  if (!Array.isArray(row.namespaces) || row.namespaces.length === 0) {
    throw Object.assign(
      new Error(`group '${row.slug}' has no namespaces; add some with: kolm group update ${row.slug} --add-namespace <n>`),
      { code: 'empty_group' },
    );
  }
  const pairs_per_namespace = {};
  let total_pairs = 0;
  for (const ns of row.namespaces) {
    const n = Number(countPairs(ns)) || 0;
    pairs_per_namespace[ns] = n;
    total_pairs += n;
  }
  return {
    group: { id: row.id, slug: row.slug, name: row.name },
    namespaces: [...row.namespaces],
    pairs_per_namespace,
    total_pairs,
  };
}

// Build the passport-ready descriptor used by src/runtime-passport.js when
// the compile pass was driven by a group. Kept separate from
// resolveGroupForCompile so the passport schema can evolve independently.
export function passportSourceFromGroup(resolved) {
  if (!resolved) return null;
  return {
    source: 'group',
    group: resolved.group.slug,
    group_name: resolved.group.name,
    namespaces: [...resolved.namespaces],
    pairs_per_namespace: { ...resolved.pairs_per_namespace },
    total_pairs: resolved.total_pairs,
  };
}
