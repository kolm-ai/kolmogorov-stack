// Provider-key vault - per-employee and per-team upstream provider keys
// (OpenAI / Anthropic / Gemini / OpenRouter / ...), encrypted at rest.
//
// This is the core of the "every employee's AI use, in one place you control"
// product: a team member stores their own provider key here, the gateway routes
// their traffic under it, and the call lands in the team lake attributed to them.
//
// Storage split (deliberate):
//   - ciphertext + metadata rows live in the multi-tenant `provider_keys` table
//     via store.js, so they persist on the deployed DB (SQLite / Postgres) and
//     are tenant/team scoped like every other row.
//   - the AES-256-GCM key lives in the secrets-vault.key file (under
//     KOLM_DATA_DIR - the Railway volume), reused from secrets-vault.js.
//
// Scopes:
//   - 'member': usable only by the member who stored it (actor_id match).
//   - 'team':   usable by any active team member; only admins rotate/delete.
// Resolution precedence inside the gateway: member key -> team key -> (caller
// falls through to env / proxy in the router).

import crypto from 'node:crypto';
import { insert, update, remove, findByField } from './store.js';
import { encrypt, decrypt } from './secrets-vault.js';

const TABLE = 'provider_keys';
const PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter', 'groq', 'together', 'fireworks', 'deepseek', 'mistral', 'cohere'];

function cleanProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  if (!s) throw Object.assign(new Error('provider required'), { code: 'bad_provider' });
  return s;
}

function nowIso() { return new Date().toISOString(); }
function genId() { return 'pk_' + crypto.randomBytes(9).toString('hex'); }

function keyPrefix(value) {
  const s = String(value || '');
  // Show enough to recognize (sk-..., ks_...) without leaking the secret.
  return s.length <= 10 ? s.slice(0, 3) + '...' : s.slice(0, 6) + '...' + s.slice(-2);
}
function keySha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

// Redacted view - never returns plaintext, ciphertext, iv, or tag.
export function redactProviderKey(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    team_id: row.team_id || null,
    actor_id: row.actor_id || null,
    provider: row.provider,
    scope: row.scope,
    label: row.label || '',
    key_prefix: row.key_prefix || '',
    key_sha256: row.key_sha256 || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at || null,
    value_included: false,
    encrypted_at_rest: !!(row.enc && row.enc.ciphertext),
  };
}

function rowsForTenant(tenantId) {
  if (!tenantId) return [];
  return findByField(TABLE, 'tenant_id', tenantId).filter((r) => r && !r._deleted);
}

// Store (upsert) a provider key. One row per (tenant, team|null, actor|scope, provider).
export function putProviderKey({ tenantId, teamId = null, actorId = null, provider, scope = 'member', value, label = '' } = {}) {
  if (!tenantId) throw Object.assign(new Error('tenant required'), { code: 'no_tenant' });
  if (value == null || value === '') throw Object.assign(new Error('provider key value required'), { code: 'bad_value' });
  const prov = cleanProvider(provider);
  const sc = scope === 'team' ? 'team' : 'member';
  if (sc === 'team' && !teamId) throw Object.assign(new Error('team scope requires a team'), { code: 'no_team' });
  const enc = encrypt(value);
  const now = nowIso();
  const match = (r) => r.provider === prov && r.scope === sc &&
    (sc === 'team' ? r.team_id === teamId : (r.actor_id === actorId && (r.team_id || null) === (teamId || null)));
  const existing = rowsForTenant(tenantId).find(match);
  const patch = {
    enc, key_prefix: keyPrefix(value), key_sha256: keySha256(value),
    label: String(label || '').slice(0, 80), updated_at: now,
  };
  if (existing) {
    update(TABLE, (r) => r.id === existing.id, patch);
    return redactProviderKey({ ...existing, ...patch });
  }
  const row = {
    id: genId(), tenant_id: tenantId, team_id: teamId || null, actor_id: actorId || null,
    provider: prov, scope: sc, created_at: now, last_used_at: null, ...patch,
  };
  insert(TABLE, row);
  return redactProviderKey(row);
}

// Resolve plaintext for the gateway ONLY. Precedence: this member's key, then
// the team key. Returns null if neither is configured. Stamps last_used_at.
export function resolveProviderKey({ tenantId, teamId = null, actorId = null, provider } = {}) {
  if (!tenantId || !provider) return null;
  const prov = cleanProvider(provider);
  const rows = rowsForTenant(tenantId).filter((r) => r.provider === prov);
  const member = actorId ? rows.find((r) => r.scope === 'member' && r.actor_id === actorId) : null;
  const team = teamId ? rows.find((r) => r.scope === 'team' && r.team_id === teamId) : null;
  const pick = member || team;
  if (!pick || !pick.enc) return null;
  try {
    const value = decrypt(pick.enc);
    update(TABLE, (r) => r.id === pick.id, { last_used_at: nowIso() });
    return value;
  } catch (_) { return null; } // deliberate: a corrupt row must not break dispatch
}

// List redacted keys visible to the caller. A member sees their own member-keys
// plus the team's team-keys; an admin sees all team-keys for the team.
export function listProviderKeys({ tenantId, teamId = null, actorId = null, isAdmin = false } = {}) {
  const rows = rowsForTenant(tenantId);
  const visible = rows.filter((r) => {
    if (r.scope === 'member') return r.actor_id === actorId || isAdmin;
    if (r.scope === 'team') return teamId ? r.team_id === teamId : false;
    return false;
  });
  return visible.map(redactProviderKey).sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
}

export function deleteProviderKey({ tenantId, id, actorId = null, isAdmin = false } = {}) {
  if (!tenantId || !id) return { ok: false, deleted: false, reason: 'bad_request' };
  const row = rowsForTenant(tenantId).find((r) => r.id === id);
  if (!row) return { ok: true, deleted: false };
  // member keys: owner or admin; team keys: admin only.
  const allowed = row.scope === 'team' ? isAdmin : (row.actor_id === actorId || isAdmin);
  if (!allowed) return { ok: false, deleted: false, reason: 'forbidden' };
  remove(TABLE, (r) => r.id === id && r.tenant_id === tenantId);
  return { ok: true, deleted: true, id };
}

export function supportedProviders() { return PROVIDERS.slice(); }

export default { putProviderKey, resolveProviderKey, listProviderKeys, deleteProviderKey, redactProviderKey, supportedProviders };
