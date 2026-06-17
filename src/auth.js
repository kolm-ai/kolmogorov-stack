// API key + tenant resolution. One key per tenant.
// Adds per-tenant token-bucket rate limiting and monthly quota enforcement.

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findOne, insert, all, update, withTransaction } from './store.js';
import { isProductionRuntime } from './env.js';

export { isProductionRuntime };

// Token bucket: tenant_id → { tokens, last, capacity, refillPerSec }
const buckets = new Map();
const DEFAULT_RATE = parseInt(process.env.RATE_LIMIT_PER_SEC || '20'); // req/s sustained
const DEFAULT_BURST = parseInt(process.env.RATE_LIMIT_BURST || '60');

// W708-5 - Export-control geo-fence. The list of US OFAC comprehensive-sanctions
// jurisdictions (ISO 3166-1 alpha-2) is no longer hardcoded: it lives in a
// versioned config file, src/ofac-denylist.json, which carries a `version_date`,
// `source_url`, `review_cadence_days`, and the `countries` array. This makes the
// list auditable (when was it last reviewed?) and refreshable without a code
// change, and lets ofacDenylistStaleness() warn operators when the list has not
// been reviewed inside the cadence window. A baseline fallback is kept inline so
// the geo-fence never silently fails open if the file is missing/corrupt.
//
// Operators MUST review the list against current OFAC programs with their own
// legal counsel - sanctions change, and obligations depend on what you ship.
const _OFAC_FALLBACK = ['CU', 'IR', 'KP', 'SY', 'RU', 'BY'];

// Load src/ofac-denylist.json once at module load. Resolved relative to this
// file so it works from any cwd / bundler layout. On any failure (missing file,
// bad JSON, empty countries) we fall back to the inline baseline and record the
// reason so ofacDenylistStaleness() can surface it - we never leave the
// geo-fence empty (which would let every sanctioned jurisdiction through).
function _loadOfacDenylist() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, 'ofac-denylist.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const countries = Array.isArray(cfg.countries)
      ? cfg.countries.map(c => String(c || '').trim().toUpperCase()).filter(c => c.length === 2)
      : [];
    if (!countries.length) throw new Error('ofac-denylist.json has no valid countries');
    return {
      countries,
      version_date: typeof cfg.version_date === 'string' ? cfg.version_date : null,
      source_url: typeof cfg.source_url === 'string' ? cfg.source_url : null,
      review_cadence_days: Number.isFinite(cfg.review_cadence_days) ? cfg.review_cadence_days : 90,
      loaded: true,
      error: null,
    };
  } catch (e) {
    return {
      countries: _OFAC_FALLBACK.slice(),
      version_date: null,
      source_url: null,
      review_cadence_days: 90,
      loaded: false,
      error: (e && e.message) || 'load_failed',
    };
  }
}

const _OFAC = _loadOfacDenylist();

// Public, frozen view of the active denylist. Kept as a plain string[] so all
// existing callers (isGeoFenced, signup handler, tests) keep working unchanged.
export const EXPORT_CONTROL_DENYLIST = Object.freeze(_OFAC.countries.slice());

// Metadata + staleness verdict for the active OFAC denylist. Surfaced at startup
// (see ofacDenylistStartupCheck) and consumable by /health so operators can see
// when the list was last reviewed. `stale` is true when version_date is older
// than review_cadence_days (default 90), or when the file failed to load.
export function ofacDenylistStaleness(nowMs = Date.now()) {
  const cadence = _OFAC.review_cadence_days || 90;
  let ageDays = null;
  let stale = false;
  let reason = null;
  if (!_OFAC.loaded) {
    stale = true;
    reason = `ofac-denylist.json failed to load (${_OFAC.error}); using inline baseline`;
  } else if (!_OFAC.version_date) {
    stale = true;
    reason = 'ofac-denylist.json has no version_date';
  } else {
    const vd = new Date(_OFAC.version_date).getTime();
    if (!Number.isFinite(vd)) {
      stale = true;
      reason = `ofac-denylist.json version_date is not a valid date: ${_OFAC.version_date}`;
    } else {
      ageDays = Math.floor((nowMs - vd) / (24 * 3600 * 1000));
      if (ageDays > cadence) {
        stale = true;
        reason = `OFAC denylist last reviewed ${ageDays}d ago (> ${cadence}d cadence) - review against current sanctions programs`;
      }
    }
  }
  return {
    loaded: _OFAC.loaded,
    version_date: _OFAC.version_date,
    source_url: _OFAC.source_url,
    review_cadence_days: cadence,
    country_count: _OFAC.countries.length,
    age_days: ageDays,
    stale,
    reason,
  };
}

// Startup hook: log a WARNING when the denylist is stale or failed to load so an
// operator notices a 2-year-old list in the boot logs. Returns the staleness
// object so the caller (server.js) can also expose it. Never throws.
export function ofacDenylistStartupCheck(logger = console) {
  const s = ofacDenylistStaleness();
  try {
    if (s.stale) {
      logger.warn(`[auth] WARNING: OFAC export-control denylist is stale: ${s.reason}. ` +
        `Edit src/ofac-denylist.json (bump version_date) per ${s.source_url || 'your OFAC source'}.`);
    } else {
      logger.log(`[auth] OFAC denylist v${s.version_date} ok (${s.country_count} jurisdictions, reviewed ${s.age_days}d ago)`);
    }
  } catch { /* deliberate: cleanup */ }
  return s;
}

// True if the given ISO 3166-1 alpha-2 country code is on the export-control
// denylist. Comparison is case-insensitive; null/undefined/empty returns false
// (an unknown country never blocks - see signup handler for the "stamp
// geo_check:unknown" branch).
export function isGeoFenced(countryCode) {
  if (!countryCode) return false;
  const code = String(countryCode).trim().toUpperCase();
  if (code.length !== 2) return false;
  return EXPORT_CONTROL_DENYLIST.includes(code);
}

function mintApiKey(kind = 'user') {
  const prefix = kind === 'anon' ? 'kao_' : 'ks_';
  return prefix + crypto.randomBytes(16).toString('hex');
}

export function hashApiKey(key) {
  return 'sha256:' + crypto.createHash('sha256').update(key).digest('hex');
}

function keyFields(key) {
  return {
    api_key_hash: hashApiKey(key),
    api_key_prefix: key.slice(0, 10),
  };
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export { constantTimeEqual };

function tenantKeyMatches(tenant, key) {
  if (!tenant || !key) return false;
  // api_key_hash is the only authoritative store. Legacy plain-key column was
  // migrated to hashed form by migrateAllPlainKeysOnce() at module-load time;
  // any row that still has a non-empty api_key column at lookup time is a
  // pre-migration leftover that can no longer authenticate (the equivalent of
  // a lost password - owner must rotate via /v1/account/rotate-key after a
  // separate identity-verified recovery flow).
  if (!tenant.api_key_hash) return false;
  return constantTimeEqual(tenant.api_key_hash, hashApiKey(key));
}

export function findTenantByApiKey(key) {
  const direct = findOne('tenants', x => !x._deleted && tenantKeyMatches(x, key)) || null;
  if (direct) return direct;
  // W888-L fallback: scoped keys minted via mintScopedKey() and OAuth/magic-link
  // session keys live in a separate `api_keys` table. The authoritative row
  // shape is exactly { id, tenant_id, hash, key_prefix, scopes[], label,
  // created_at, last_used_at, revoked_at, expires_at } (see mintScopedKey).
  // `hash` is the raw sha256 hex digest of the key (no 'sha256:' prefix); the
  // 'sha256:'-prefixed comparison is a defensive accommodation for any legacy
  // fixture that stored the prefixed form. There is NO `api_key_hash` column on
  // this table - that was dead copy-paste from the tenants schema and is gone.
  try {
    const rawHex = crypto.createHash('sha256').update(String(key || '')).digest('hex');
    const row = findOne('api_keys', x => x && !x._deleted && !x.revoked_at && !_scopedKeyExpired(x) && (
      x.hash === rawHex || x.hash === ('sha256:' + rawHex)
    ));
    if (row && row.tenant_id) {
      const t = findOne('tenants', x => x && !x._deleted && x.id === row.tenant_id);
      if (t) return t;
    }
  } catch (_) {} // deliberate: cleanup
  return null;
}

// One-shot migration: any tenant minted before api_key_hash was a column has
// a plain api_key string. This walks the tenant table once at module load
// and computes api_key_hash + api_key_prefix for those rows, then clears the
// plain api_key column. Idempotent - subsequent boots are no-ops because the
// filter (api_key && !api_key_hash) matches zero rows.
export function migrateAllPlainKeysOnce() {
  let migrated = 0;
  try {
    for (const t of all('tenants')) {
      if (t._deleted) continue;
      if (typeof t.api_key === 'string' && t.api_key.length > 0 && !t.api_key_hash) {
        update('tenants', x => x.id === t.id, {
          ...keyFields(t.api_key),
          api_key: undefined,
          key_migrated_at: t.key_migrated_at || new Date().toISOString(),
        });
        migrated++;
      } else if (typeof t.api_key === 'string' && t.api_key.length > 0 && t.api_key_hash) {
        // Stale plain column on an already-hashed row - clear it.
        update('tenants', x => x.id === t.id, { api_key: undefined });
        migrated++;
      }
    }
  } catch (e) {
    // Never block startup on migration failure - surface but continue.
    console.warn('[auth] plain-key migration error:', e && e.message);
  }
  if (migrated > 0) console.log('[auth] migrated', migrated, 'tenant plain-key column(s) to hash');
}
migrateAllPlainKeysOnce();

export function provisionTenant(name, { quota = 10000, plan = 'free', kind = 'user', expires_at = null, email = null, country_code = null, geo_check = null } = {}) {
  // P2 (Auth): the name-collision check and the insert must be one atomic unit.
  // Two concurrent provisionTenant(same_name) calls could both pass the
  // `.find()` and both insert, producing duplicate tenant rows (the JSON store
  // has no UNIQUE constraint). withTransaction (BEGIN IMMEDIATE in sqlite mode)
  // serializes the check+insert so the second caller re-reads the now-committed
  // row and returns it instead of inserting a duplicate.
  return withTransaction(() => {
    const existing = all('tenants').find(t => t.name === name);
    if (existing) return existing;
    const key = mintApiKey(kind);
    const t = {
      id: 'tenant_' + crypto.randomBytes(6).toString('hex'),
      name,
      ...keyFields(key),
      kind,                 // 'user' | 'anon'
      expires_at,           // ISO string for anon tenants; null otherwise
      email,                // null until claimed
      plan,
      quota,
      used: 0,
      rate_per_sec: DEFAULT_RATE,
      burst: DEFAULT_BURST,
      // W708-5 - export-control attribution. country_code is the ISO 3166-1
      // alpha-2 code provided at signup (header or body), null if unknown.
      // geo_check is one of: 'allowed' | 'unknown' | 'denied' (denied tenants
      // never reach provisionTenant - they're rejected upstream with HTTP 451).
      country_code: country_code || null,
      geo_check: geo_check || (country_code ? 'allowed' : 'unknown'),
      created_at: new Date().toISOString(),
    };
    insert('tenants', t);
    return { ...t, api_key: key };
  });
}

// Mint an anonymous tenant. No email required. 30-day TTL. Lower quota.
// Designed for autonomous CLIs / agents that need to start working immediately.
export function provisionAnonTenant({ ttl_days = 30, quota = 1000 } = {}) {
  const slug = 'anon-' + crypto.randomBytes(4).toString('hex');
  const expires_at = new Date(Date.now() + ttl_days * 24 * 3600 * 1000).toISOString();
  return provisionTenant(slug, { quota, plan: 'anon', kind: 'anon', expires_at });
}

// Claim an anonymous tenant: transfer it to a real account.
// - If an existing real tenant exists for this email, merges anon's recipes/versions into it,
//   then deletes the anon tenant. Returns existing tenant.
// - Otherwise upgrades the anon tenant in-place: rotates key to ks_*, clears expiry, raises quota,
//   marks as 'user'.
//
// P1 (Auth): the multi-step merge/upgrade below MUST be atomic. Two concurrent
// claimAnonTenant calls on the same anon token (or a claim racing a
// findOrCreateTenantByEmail that creates the email tenant mid-flight) could
// otherwise double-reassign concepts/observations, soft-delete an anon tenant
// without migrating its rows, or rotate the existing tenant's key twice. The
// real work now lives in claimAnonTenantAtomic(), which re-reads `anon` and
// `existing` INSIDE the transaction and bails (no-op) if a concurrent caller
// already claimed the anon tenant. claimAnonTenant() stays as the validated
// public entry point and delegates the write to the atomic helper.
export function claimAnonTenant(anonToken, { email, name }) {
  const anon = findTenantByApiKey(anonToken);
  if (!anon || anon.kind !== 'anon') return { ok: false, reason: 'anon token not found or already claimed' };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'valid email required' };
  }
  return claimAnonTenantAtomic(anon.id, { email, name });
}

// Atomic claim-and-merge. All store mutations run inside a single
// withTransaction (BEGIN IMMEDIATE serializes writers in sqlite mode), and the
// anon row + existing-tenant row are RE-READ inside the transaction so a
// concurrent claim that already flipped `kind` away from 'anon' or set
// `_deleted` is detected and turned into a clean no-op rather than a
// double-migration. anonId is the tenant id (not the raw token) so the
// re-read is a stable primary-key lookup.
export function claimAnonTenantAtomic(anonId, { email, name }) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'valid email required' };
  }
  return withTransaction(() => {
    // Re-read inside the txn: a concurrent claim may have already consumed it.
    const anon = findOne('tenants', x => x.id === anonId);
    if (!anon || anon._deleted || anon.kind !== 'anon') {
      return { ok: false, reason: 'anon token not found or already claimed' };
    }
    // Re-read the email-owner inside the txn so we observe a tenant that a
    // racing findOrCreateTenantByEmail/provisionTenant committed just before us.
    const existing = all('tenants').find(t => !t._deleted && t.email === email && t.kind !== 'anon' && t.id !== anon.id);
    if (existing) {
      const newKey = mintApiKey('user');
      // Reassign concepts/observations from anon -> existing, THEN soft-delete
      // the anon row, THEN rotate the existing tenant's key. Ordering matters:
      // the soft-delete is the last gate that proves the migration finished, and
      // because the whole block is one transaction a crash rolls all of it back.
      update('concepts', c => c.tenant === anon.name, { tenant: existing.name });
      update('observations', o => o.tenant === anon.name, { tenant: existing.name });
      update('tenants', x => x.id === anon.id, { _deleted: true, claimed_into: existing.id, claimed_at: new Date().toISOString() });
      update('tenants', x => x.id === existing.id, {
        ...keyFields(newKey),
        api_key: undefined,
        key_rotated_at: new Date().toISOString(),
      });
      return { ok: true, mode: 'merged', api_key: newKey, tenant: { ...existing, api_key: newKey } };
    }
    // Otherwise upgrade in place.
    const newKey = mintApiKey('user');
    const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'user';
    const uniq = `${slug}-${Date.now().toString(36).slice(-4)}`;
    update('tenants', x => x.id === anon.id, {
      ...keyFields(newKey),
      api_key: undefined,
      name: uniq,
      kind: 'user',
      plan: 'free',
      quota: 10000,
      expires_at: null,
      email,
      claimed_at: new Date().toISOString(),
    });
    // Reassign tenant-tagged rows to the new name (concepts, observations).
    update('concepts', c => c.tenant === anon.name, { tenant: uniq });
    update('observations', o => o.tenant === anon.name, { tenant: uniq });
    return { ok: true, mode: 'upgraded', api_key: newKey, tenant: { ...anon, name: uniq, api_key: newKey } };
  });
}

// Find an existing tenant by email or create a fresh one. Used by OAuth
// callbacks: a Google/GitHub login should sign you in if you've signed up
// before, or sign you up if you haven't. Returns { tenant, api_key, created }.
//
// Note: api_key is only returned on first creation. For an EXISTING tenant an
// OAuth sign-in mints a 30-day full-scope SESSION key (a row in the api_keys
// table) for the browser cookie, and leaves the tenant's PRIMARY key untouched.
// This is the fix for the key-rotation footgun: previously every web OAuth login
// rotated the primary key, silently invalidating any ks_*** key the user had
// stored in their CLI / CI / server integration. Now those keep working; the
// cookie carries a separate, revocable, auto-expiring session credential.
export function findOrCreateTenantByEmail({ email, name, provider, provider_id }) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('valid email required');
  }
  const existing = all('tenants').find(t => !t._deleted && t.email === email && t.kind !== 'anon');
  if (existing) {
    // P1 (Auth) account-linking / provider_id trust. Pure email-equality is not
    // sufficient: a provider asserting an email signs the caller into the
    // matching tenant. We require the trusted path (OAuth verified-email checks
    // in oauth.js + the magic-link ownership proof) to have already vetted the
    // email, and we ADDITIONALLY refuse to silently sign in when the existing
    // tenant is already bound to a DIFFERENT provider account id under the same
    // provider. That binding mismatch means a different provider account is
    // claiming an email this tenant already established under another identity -
    // it must go through an explicit link step (a logged-in user adds the
    // provider), not an implicit overwrite.
    //
    // provider:'email' (magic-link) is treated as the email-ownership proof it
    // is - it can sign into any tenant for that email and never trips the
    // binding check (there is no email_id to mismatch). An OAuth provider whose
    // id differs from the one already pinned on the tenant is refused.
    const incomingId = provider_id ? String(provider_id) : '';
    const boundId = existing[`${provider}_id`] ? String(existing[`${provider}_id`]) : '';
    if (provider && provider !== 'email' && boundId && incomingId && boundId !== incomingId) {
      const err = new Error(`account already linked to a different ${provider} identity`);
      err.code = 'provider_id_mismatch';
      err.provider = provider;
      throw err;
    }
    // Non-credential update only — record the provider id + login time. The
    // primary api_key_hash is NOT touched, so every out-of-band caller's key
    // survives the web login. Never DOWNGRADE an existing binding to null: keep
    // the pinned id when this sign-in did not carry one (e.g. magic-link).
    update('tenants', x => x.id === existing.id, {
      [`${provider}_id`]: incomingId || boundId || null,
      last_login_at: new Date().toISOString(),
    });
    // Mint a full-scope, 30-day session key for the cookie. It authenticates
    // through the api_keys-table fallback in findTenantByApiKey and resolves to
    // this same tenant; '*' scope passes every route gate. Auto-expires; can be
    // listed/revoked via the scoped-keys surface.
    const sessionKey = mintScopedKey(existing.id, {
      scopes: ['*'],
      label: `oauth:${provider}`,
      ttl_days: 30,
    }).key;
    return {
      tenant: existing,
      api_key: sessionKey,
      created: false,
    };
  }
  const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'user';
  const uniq = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const key = mintApiKey('user');
  const t = {
    id: 'tenant_' + crypto.randomBytes(6).toString('hex'),
    name: uniq,
    ...keyFields(key),
    kind: 'user',
    expires_at: null,
    email,
    plan: 'free',
    quota: 10000,
    seats: 1,
    used: 0,
    rate_per_sec: DEFAULT_RATE,
    burst: DEFAULT_BURST,
    [`${provider}_id`]: provider_id || null,
    auth_provider: provider,
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  };
  insert('tenants', t);
  return {
    tenant: t,
    api_key: key,
    created: true,
  };
}

// Look up a tenant by email - used by webhook fallback when client_reference_id
// is missing but customer email is present.
export function findTenantByEmail(email) {
  if (!email) return null;
  return all('tenants').find(t => !t._deleted && t.email === email && t.kind !== 'anon') || null;
}

export function rotateTenantKey(tenant_id) {
  const newKey = mintApiKey('user');
  update('tenants', x => x.id === tenant_id, {
    ...keyFields(newKey),
    api_key: undefined,
    key_rotated_at: new Date().toISOString(),
  });
  return newKey;
}

// P2 (Auth) plain-key lockout detection. A tenant is "locked out" when it has
// NO usable authoritative credential: api_key_hash is unset (a pre-migration
// row whose plain key was lost, or a migration that cleared api_key without
// computing the hash). Such a tenant cannot authenticate and so cannot reach
// rotate-key the normal way. recoverKeyByEmail() is the self-serve escape hatch
// (driven by the email-verified magic-link primitive in auth-email.js); for
// email-less legacy tenants an operator must use the ADMIN_KEY path.
export function tenantIsLockedOut(tenant) {
  if (!tenant || tenant._deleted) return false;
  return !tenant.api_key_hash;
}

// P2 (Auth) email-verified key recovery. Called ONLY after the caller has
// proven ownership of `email` (the magic-link verify flow in auth-email.js).
// Resolves the real (non-anon) tenant for that email and rotates its key,
// returning a fresh ks_ key. This makes the lockout-recovery path documented in
// tenantKeyMatches()/migrateAllPlainKeysOnce real instead of vapor: a tenant
// whose plain key was lost before migration can verify their email and get a
// new working key. Returns { ok:false, reason } when no eligible tenant exists.
//
// Atomic: the resolve + rotate run inside one withTransaction so a concurrent
// recovery (double-click on the recovery link) re-reads the committed row and
// both land on the SAME final key for the same tenant rather than racing two
// rotations against a stale snapshot.
export function recoverKeyByEmail(email) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'valid email required' };
  }
  return withTransaction(() => {
    const tenant = all('tenants').find(t => !t._deleted && t.email === email && t.kind !== 'anon');
    if (!tenant) return { ok: false, reason: 'no account for that email' };
    const newKey = mintApiKey('user');
    update('tenants', x => x.id === tenant.id, {
      ...keyFields(newKey),
      api_key: undefined,
      key_rotated_at: new Date().toISOString(),
      key_recovered_at: new Date().toISOString(),
    });
    return { ok: true, api_key: newKey, tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan } };
  });
}

// Rotate a tenant's receipt-signing secret. The previous secret is preserved
// in tenant.previous_receipt_secrets[] so existing artifacts and audit-chain
// rows signed with the old key continue to verify. Verifiers walk the list
// and accept the first match - see env.tenantReceiptVerificationKeys.
export function rotateTenantReceiptSecret(tenant_id) {
  const tenant = findOne('tenants', x => x.id === tenant_id);
  if (!tenant) throw new Error('tenant not found');
  const newSecret = 'ks_receipt_' + crypto.randomBytes(24).toString('hex');
  const newKeyId = `tk_${tenant_id.slice(-8)}_${crypto.randomBytes(3).toString('hex')}`;
  const previous = Array.isArray(tenant.previous_receipt_secrets) ? tenant.previous_receipt_secrets.slice() : [];
  if (tenant.receipt_secret) {
    previous.unshift({
      secret: tenant.receipt_secret,
      key_id: tenant.receipt_key_id || 'previous',
      retired_at: new Date().toISOString(),
    });
  }
  // Keep at most 3 historical keys (current + 3 previous = 4 total verification keys).
  while (previous.length > 3) previous.pop();
  update('tenants', x => x.id === tenant_id, {
    receipt_secret: newSecret,
    receipt_key_id: newKeyId,
    receipt_rotated_at: new Date().toISOString(),
    previous_receipt_secrets: previous,
  });
  return { key_id: newKeyId, rotated_at: new Date().toISOString(), previous_count: previous.length };
}

// Return current + previous key metadata for a tenant. Secrets are NEVER
// returned, only the key_id, rotated_at, and retired_at timestamps so the
// caller can audit what's in the verification fallback ring.
export function listTenantReceiptSecrets(tenant_id) {
  const tenant = findOne('tenants', x => x.id === tenant_id);
  if (!tenant) throw new Error('tenant not found');
  const current = tenant.receipt_secret
    ? {
        key_id: tenant.receipt_key_id || 'current',
        rotated_at: tenant.receipt_rotated_at || null,
        status: 'current',
      }
    : null;
  const previous = Array.isArray(tenant.previous_receipt_secrets)
    ? tenant.previous_receipt_secrets.map(p => ({
        key_id: p.key_id || 'previous',
        retired_at: p.retired_at || null,
        status: 'previous',
      }))
    : [];
  return { current, previous, total: (current ? 1 : 0) + previous.length };
}

// Drop a specific previous key from the verification ring. Once pruned,
// receipts signed with that key will no longer verify against this tenant.
// Refuses to prune the current key - rotate first if you want to retire it.
export function pruneTenantReceiptSecret(tenant_id, key_id) {
  const tenant = findOne('tenants', x => x.id === tenant_id);
  if (!tenant) throw new Error('tenant not found');
  if (tenant.receipt_key_id === key_id) throw new Error('cannot prune the current key; rotate first');
  const previous = Array.isArray(tenant.previous_receipt_secrets) ? tenant.previous_receipt_secrets : [];
  const remaining = previous.filter(p => p.key_id !== key_id);
  if (remaining.length === previous.length) throw new Error('key_id not found in previous_receipt_secrets');
  update('tenants', x => x.id === tenant_id, { previous_receipt_secrets: remaining });
  return { pruned: key_id, remaining_count: remaining.length };
}

function takeToken(t) {
  const now = Date.now();
  let b = buckets.get(t.id);
  if (!b) {
    b = { tokens: t.burst || DEFAULT_BURST, last: now, cap: t.burst || DEFAULT_BURST, refill: t.rate_per_sec || DEFAULT_RATE };
    buckets.set(t.id, b);
  }
  // refill
  const dt = (now - b.last) / 1000;
  b.tokens = Math.min(b.cap, b.tokens + dt * b.refill);
  b.last = now;
  if (b.tokens < 1) {
    const wait = Math.ceil((1 - b.tokens) / b.refill * 1000);
    return { ok: false, retry_after_ms: wait };
  }
  b.tokens -= 1;
  return { ok: true };
}

const PUBLIC_PAGES = new Set(['/', '/dashboard', '/playground', '/docs', '/registry', '/health', '/signup', '/pricing', '/why', '/status', '/specialists']);
// Read-only public endpoints: list/run public recipes, /v1/public/featured, /v1/public/concepts, /v1/public/run.
// Submission (/v1/public/submit) requires auth because it touches a tenant-owned recipe.
// /v1/anon/bootstrap is no-auth so robots can mint a workspace; /v1/anon/claim authenticates
// through its body field (anon_token), so it is also no-auth at the middleware layer.
const PUBLIC_API = (p) =>
  (p.startsWith('/v1/public/') && p !== '/v1/public/submit') ||
  p === '/v1/signup' ||
  p === '/v1/signin' ||
  p === '/v1/signout' ||
  p === '/v1/specialists/waitlist' ||
  p === '/v1/anon/bootstrap' ||
  p === '/v1/anon/claim' ||
  p === '/v1/registry/public' ||
  p === '/v1/hub' ||
  p === '/v1/lead/enterprise' ||                                        // KOLM-102: structured intake post; GET /:id stays admin-gated
  p === '/v1/sales/demo-request' ||                                     // W889-6.1: Book-Demo intake post; rate-limited 10/IP/24h in router.js
  /^\/v1\/hub\/[^/]+\/[^/]+(?:\/download)?$/.test(p) ||
  /^\/v1\/receipts\/[A-Za-z0-9._\-]{8,128}\/public$/.test(p) ||         // public receipt-by-hash lookup, no auth (KOLM-109)
  p === '/v1/stripe/webhook' ||
  p === '/v1/oauth/providers' ||
  p === '/v1/byoc/attestation' ||
  p === '/v1/byoc/targets' ||
  p === '/v1/target-profiles' ||                                        // W892-C5 device→target lookup catalog, public read
  /^\/v1\/target-profiles\/[A-Za-z0-9_\-]+$/.test(p) ||                 // single profile lookup
  /^\/v1\/teams\/invites\/[A-Za-z0-9_\-]+$/.test(p) ||                  // preview is public; /accept is its own path
  /^\/v1\/oauth\/(google|github)\/(start|callback)$/.test(p) ||
  /^\/v1\/auth\/email\/(start|verify)$/.test(p) ||                       // passwordless magic-link sign-in
  p === '/v1/auth/email/recover-key' ||                                  // AUTH-06 email-verified key recovery (lockout escape)
  // W889-8.4 - short OAuth aliases. /v1/auth/github + /v1/auth/github/callback
  // are 302 redirects to the canonical /v1/oauth/github/* routes above. They
  // must be public so the redirect itself does not need an API key.
  p === '/v1/auth/github' ||
  p === '/v1/auth/github/callback' ||
  /^\/v1\/tunnel\/agent\/[A-Za-z0-9_\-]+(?:\/response)?$/.test(p) ||
  // wave-144 stateless validators / catalogs (no tenant state read, pure compute).
  // Trace/IR-compile/FL-round/aggregate stay auth-gated above because they touch tenant data.
  p.startsWith('/v1/device/') ||                                        // profiles catalog + probe/check are stateless
  p.startsWith('/v1/cc/') ||                                            // confidential-compute kinds/shape/verify
  p === '/v1/fl/strategies' ||                                          // FL strategy catalog (round/contribution/aggregate stay authed)
  p.startsWith('/v1/capability/') ||                                    // capability build/validate are stateless
  p.startsWith('/v1/lineage/') ||                                       // lineage build/validate are stateless
  p === '/v1/ir/stats' ||                                               // IR stats over body-supplied IR
  p === '/v1/ir/validate' ||                                            // IR shape validation over body
  p === '/v1/ir/replay' ||                                              // IR cache-seed replay over body
  // W342 marketplace catalog is public (it's a published catalog of signed
  // artifacts). All routes are read-only metadata + download; the download
  // path enforces a productionReady() gate (409 unless ?force=true).
  // publish-request remains queue-write-only (audit ledger), so we keep it
  // bound here too - it doesn't touch tenant rows.
  p === '/v1/marketplace' ||
  p === '/v1/marketplace/list' ||
  p === '/v1/marketplace/catalog.json' ||
  p === '/v1/marketplace/publish-request' ||
  // W889-10.1 - public email-capture for the v2 premium marketplace
  // teaser on /marketplace. Same policy as /v1/specialists/waitlist:
  // public POST, IP-rate-limited inside the route handler, no tenant
  // scoping (the email IS the dedupe key).
  p === '/v1/marketplace/interest' ||
  // W737 - faceted search + public review-read are public; listing-register +
  // review-submit stay auth-gated above. The reviews/:cid path uses a
  // dedicated regex so /v1/marketplace/:slug/download (existing route below)
  // is unambiguous - reviews/:cid only matches when the second segment is
  // literal 'reviews'.
  p === '/v1/marketplace/search' ||
  /^\/v1\/marketplace\/reviews\/[A-Za-z0-9._:-]{1,128}$/.test(p) ||
  /^\/v1\/marketplace\/[A-Za-z0-9._-]+(?:\/download)?$/.test(p) ||
  // W751-W755 - vertical foundation-student catalog. Listing + per-id detail
  // are public (marketing/discovery; mirrors /v1/marketplace policy). The
  // register-stubs POST and the per-id fingerprint GET stay auth-gated above.
  p === '/v1/verticals' ||
  /^\/v1\/verticals\/[A-Za-z0-9_-]+$/.test(p) ||
  // W436 - public artifact verification. /v1/verify/:cid surfaces the
  // recompute-cid-from-manifest-hashes verdict so an auditor can verify
  // provenance without an account; /v1/artifact/verify-manifest is the
  // stateless POST variant for callers that already have the hashes block.
  /^\/v1\/verify\/[A-Za-z0-9:_-]+$/.test(p) ||
  p === '/v1/artifact/verify-manifest' ||
  // W409g/W409k - GET /v1/models is OpenAI-compatible model discovery. Public
  // so SDKs that call client.models.list() before authenticating get a usable
  // envelope; the soft-auth block above will still populate req.tenant when a
  // valid key is present, so the handler can decide whether to surface
  // tenant-specific compiled .kolm artifacts (private rows).
  p === '/v1/models' ||
  p === '/v1/models/manifest' ||
  p === '/v1/models/pull' ||
  p === '/v1/models/cache' ||
  p === '/v1/models/recommend' ||
  /^\/v1\/models\/info\/[A-Za-z0-9._~:/@-]{1,256}$/.test(p) ||
  p === '/v1/distill/onpolicy/doctor' ||
  p === '/v1/distill/preference/doctor' ||
  // W384 - sync inbox accepts pushes from peer daemons; the sender supplies
  // an Authorization: Bearer <key> via the body/headers and validates it itself
  // (the body's source_device_id + state envelope acts as the auth contract).
  p === '/v1/sync/inbox' ||
  // W456 - /v1/changelog is the public marketing surface backing /changelog
  // and the `kolm changelog` CLI verb. Mirrors /v1/spec / /v1/registry/public:
  // identical response for every caller, no tenant scoping, no auth.
  p === '/v1/changelog' ||
  // W384 - accept-invite is invite-token-authenticated (the URL token IS the
  // credential); the workspace lookup happens inside team.js with explicit
  // expiry + consumed checks. Public so a new member with no api_key can join.
  p === '/v1/team/accept-invite' ||
  // W560 - SAML SP metadata + SCIM SP config are spec-mandated public
  // documents (RFC 7644 §4 + SAML 2.0 §5.2). IdPs MUST be able to fetch them
  // without an API key during federation setup. The tenant-scoped SSO
  // configure + SCIM Users endpoints stay auth-gated.
  p === '/v1/account/saml/metadata' ||
  p === '/v1/scim/v2/ServiceProviderConfig' ||
  // W-SSO-LIVE - the SAML 2.0 ACS receives an IdP-initiated POST from the user's
  // browser, which carries NO kolm API key. The handler self-authenticates: it
  // resolves the tenant from the assertion Issuer and verifies the XML signature
  // against that tenant's pinned x509 cert before trusting any claim, then mints
  // a session. Public so the browser POST is not rejected at the gate.
  p === '/v1/account/saml/acs' ||
  // W-SSO-LIVE - SCIM 2.0 resource endpoints are authenticated INSIDE the
  // handler by _scimGuard, which accepts either the tenant API key or a
  // dedicated per-tenant SCIM bearer token (so an IdP can be given a
  // provisioning-only credential). Every handler is tenant-fenced. Public here
  // so a SCIM-token-only request (not a full API key) reaches the guard rather
  // than being rejected by the API-key gate.
  p === '/v1/scim/v2/Users' ||
  /^\/v1\/scim\/v2\/Users\/[A-Za-z0-9:._-]{1,128}$/.test(p) ||
  p === '/v1/scim/v2/Groups' ||
  /^\/v1\/scim\/v2\/Groups\/[A-Za-z0-9:._-]{1,128}$/.test(p) ||
  // W756 - KolmBench v1 spec + leaderboard are public marketing/discovery
  // surfaces (same policy as /v1/verticals + /v1/changelog). validate +
  // submit stay auth-gated above; submit additionally requires confirm:true.
  p === '/v1/kolmbench/spec' ||
  p === '/v1/kolmbench/leaderboard' ||
  // W844 - public chat for the homepage free-tier and the post-auth console.
  // Same pipe; rate limiter inside the route enforces the 20/IP/day cap when
  // no key is attached. With a valid key the soft-auth above promotes the
  // call to the full snapshotContext path (same as /v1/intent/ask).
  p === '/v1/free/chat' ||
  // W888-R - public docs-search assistant. Rate-limited inside the route
  // via docsAssistantLimiter at 60/IP/24h. Per-turn budget capped at $0.005.
  // Capture namespace is 'public/docs-search' so we can audit public usage.
  p === '/v1/assistant/chat-docs' ||
  // W854 - public CLI runner for the homepage chat. Strict allowlist of
  // read-only verbs is enforced inside the route handler; the same rate
  // limiter pool as /v1/free/chat caps anonymous calls at 20/IP/day.
  p === '/v1/free/cli' ||
  p === '/v1/free/cli/allowlist' ||
  // W866 - Forge read-only compute routes (hardware/inspect/fit/experts).
  // These are pure compute over caller-supplied or server-side data, with no
  // tenant scoping. Rate-limited inside the routes via forgeLimiter. Same
  // policy as /v1/device/* and /v1/cc/* (stateless validators).
  p === '/v1/hardware' ||
  p === '/v1/inspect' ||
  p === '/v1/fit' ||
  p === '/v1/experts' ||
  // W869 - teacher-chat health probe publishes only booleans (which vendors
  // have a server-side key configured). Used by local distill workers to
  // decide whether to route through the proxy before burning a real call.
  // The actual POST /v1/teacher/chat remains auth-gated.
  p === '/v1/teacher/chat/health' ||
  // W891 - gateway health probe surfaces upstream model-provider booleans for
  // the same reason as teacher-chat/health: SDKs and the homepage status panel
  // need to render a live readiness pill without burning an authed budget call.
  // Body is provider-bool only - no per-tenant quota or pricing leak.
  p === '/v1/gateway/health' ||
  // W910 Track B - public routes powering the no-code /account/create-model
  // wizard. Each is rate-limited inside the route handler. Templates is a
  // pure catalog; estimate/preview/start are stateless heuristics; the SSE
  // stream returns deterministic stub events; connector-notify appends to a
  // single-file waitlist; capture/snippet renders a copy-paste snippet with
  // tenant key when present and a placeholder when not; draft/save echoes
  // for anon (page also persists to localStorage).
  p === '/v1/recipes/templates' ||
  /^\/v1\/recipes\/templates\/[a-z0-9][a-z0-9-]{0,63}$/.test(p) ||
  p === '/v1/compile/estimate' ||
  p === '/v1/compile/preview' ||
  p === '/v1/compile/start' ||
  /^\/v1\/compile\/stream\/[A-Za-z0-9._-]{1,64}$/.test(p) ||
  p === '/v1/connectors/notify' ||
  p === '/v1/draft/save' ||
  p === '/v1/capture/snippet' ||
  /^\/v1\/playground\/proxy\/[A-Za-z0-9._-]{1,64}$/.test(p) ||
  // Agent Security-Review audit - offline verification of a signed evidence
  // report. Public so a buyer's review group can verify the Ed25519 signature
  // with no kolm account. Pure compute over the posted envelope; touches no
  // tenant data (mirrors /v1/verify/:cid + /v1/artifact/verify-manifest).
  p === '/v1/audit/report/verify' ||
  // The live issuer PUBLIC key this server signs reports with. Public so a
  // buyer / the /verify keyring can pin against the authoritative source.
  // Returns only the public half; no tenant data.
  p === '/v1/audit/issuer-key' ||
  // The per-key status (live / rotated / revoked) for the issuer keyring. Public
  // so an offline verifier can refuse a report signed by a revoked key without a
  // kolm account. The :fp segment is a hex fingerprint. The /revoke counterpart
  // stays admin-gated (ADMIN_KEY Bearer) above, never here.
  /^\/v1\/audit\/issuer-key\/[A-Za-z0-9:_-]{1,128}\/status$/.test(p) ||
  // The public, append-only transparency log (RFC 9162 style): tree size, the
  // entry list / single entry, an inclusion proof, and signed checkpoints. All
  // read-only, no tenant data - a buyer (or a witness) can audit the log and
  // verify any report's inclusion proof offline. The witness-cosign and append
  // paths are not exposed here (append is server-internal at sign time).
  /^\/v1\/transparency-log\/(size|entries|proof|checkpoints)(\/[A-Za-z0-9_-]{1,64})?$/.test(p) ||
  // The public shareable Trust link a buyer hands their review group: renders
  // the paid signed report (html / json / pdf) and verifies offline. The slug
  // is an unguessable capability token (crypto.randomBytes), so possession of
  // the link is the grant - no account needed. Audit + subscription slugs both
  // resolve here. The optional /export suffix serves the same paid report as a
  // procurement artifact (CSV / .xls / Drata / Vanta / exec / crosswalk) so a
  // buyer's GRC team can ingest it without a kolm account.
  /^\/v1\/trust\/[A-Za-z0-9_-]{1,64}(?:\/export|\/delta)?$/.test(p) ||
  // G-routes: an embeddable status badge (SVG) for the shareable Trust link, so a
  // vendor can drop the live "Agent Security: NN% ready" pill into a README /
  // status page with no kolm account. Same capability level as GET /v1/trust/:slug
  // (possession of the unguessable slug is the grant); an unresolved slug serves a
  // grey "unknown" badge, never tenant data. The POST .../sessions/:id/delta route
  // is its sibling but stays AUTH-gated (deliberately NOT matched here).
  /^\/v1\/trust\/[A-Za-z0-9_-]{1,64}\/badge\.svg$/.test(p) ||
  // S8: the buyer's reviewer pre-fills a security questionnaire straight from the
  // SIGNED report behind the Trust Link. Possession of the unguessable slug is the
  // grant - the same capability level as the report it derives from - so this
  // matches the GET /v1/trust/:slug policy above. The seller-side counterpart
  // (POST /v1/audit/sessions/:id/questionnaire) stays auth-gated, never here.
  /^\/v1\/trust\/[A-Za-z0-9_-]{1,64}\/questionnaire$/.test(p) ||
  // S7: a viewer of a GATED Trust Link submits an email + accept-terms and gets an
  // unlock token. PUBLIC because the buyer has no kolm account. The seller-only
  // GET /v1/trust/:slug/views + GET /v1/trust-center analytics stay AUTH-gated
  // (deliberately NOT matched here), so the global authMiddleware fences them.
  /^\/v1\/trust\/[A-Za-z0-9_-]{1,64}\/unlock$/.test(p) ||
  // The continuous re-attestation tick is gated by KOLM_CRON_SECRET (a request
  // header), not tenant auth, so it must bypass the API-key gate; the route
  // handler itself rejects any call without the correct secret.
  p === '/v1/audit/continuous/tick';

export function isPublicApiPath(p) {
  return PUBLIC_API(String(p || ''));
}

export function adminApiKey() {
  return process.env.ADMIN_KEY || null;
}

// --- W936 scoped member API keys ---------------------------------------
// A first-class multi-key surface alongside the single tenant-primary key.
// Each row: { id, tenant_id, hash(sha256 hex), key_prefix, scopes[], label,
// created_at, last_used_at, revoked_at }. scopes like 'capture:read',
// 'lake:export', 'namespace:<slug>', or '*'. A request authenticated by one of
// these keys carries req.key_scopes (an array); the tenant-primary key carries
// req.key_scopes = null, meaning full access.
// M15 - credential TTL. Resolve an optional expiry from either an explicit ISO
// `expires_at` or a `ttl_days` number. Returns null (never expires) when neither
// is supplied, so existing keyless-expiry rows are unaffected.
function _resolveExpiry({ expires_at = null, ttl_days = null } = {}) {
  if (expires_at) {
    const t = new Date(expires_at);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  if (ttl_days != null) {
    const days = Number(ttl_days);
    if (Number.isFinite(days) && days > 0) return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  }
  return null;
}

// M15 - true iff a scoped-key row has a non-null expires_at in the past. A null/
// absent expires_at means "never expires" (the pre-M15 behavior), so legacy rows
// keep authenticating forever.
export function _scopedKeyExpired(row, atMs = Date.now()) {
  if (!row || !row.expires_at) return false;
  const t = new Date(row.expires_at).getTime();
  return Number.isFinite(t) && t < atMs;
}

export function mintScopedKey(tenant_id, { scopes = [], label = '', ttl_days = null, expires_at = null } = {}) {
  if (!tenant_id) throw Object.assign(new Error('tenant required'), { code: 'no_tenant' });
  const key = 'ks_' + crypto.randomBytes(24).toString('hex');
  const rawHex = crypto.createHash('sha256').update(key).digest('hex');
  const exp = _resolveExpiry({ expires_at, ttl_days });
  insert('api_keys', {
    id: 'key_' + crypto.randomBytes(8).toString('hex'),
    tenant_id, hash: rawHex, key_prefix: key.slice(0, 12),
    scopes: Array.isArray(scopes) ? scopes.map(String).filter(Boolean) : [],
    label: String(label || '').slice(0, 80),
    created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
    expires_at: exp,            // M15: null = never expires
  });
  return { key, key_prefix: key.slice(0, 12), expires_at: exp };
}
export function listScopedKeys(tenant_id) {
  const now = Date.now();
  return all('api_keys')
    .filter((k) => k && !k._deleted && k.tenant_id === tenant_id)
    .map((k) => {
      const expired = _scopedKeyExpired(k, now);
      const expiresInDays = k.expires_at
        ? Math.max(0, Math.ceil((new Date(k.expires_at).getTime() - now) / (24 * 3600 * 1000)))
        : null;
      return {
        id: k.id, key_prefix: k.key_prefix, scopes: k.scopes || [], label: k.label || '',
        created_at: k.created_at, last_used_at: k.last_used_at || null, revoked: !!k.revoked_at,
        expires_at: k.expires_at || null,                 // null = never
        expires_in_days: k.expires_at ? expiresInDays : null,
        expired,
        active: !k.revoked_at && !expired,
      };
    });
}
export function revokeScopedKey(tenant_id, id) {
  const n = update('api_keys', (k) => k && k.tenant_id === tenant_id && k.id === id && !k.revoked_at, { revoked_at: new Date().toISOString() });
  return { ok: true, revoked: n > 0 };
}
// M15 - renew (extend) a scoped key's TTL. Tenant-fenced; refuses a revoked key.
// Pass ttl_days (extend from now) or an explicit expires_at; omit both to clear
// the expiry (make it never-expire). Returns the new expires_at.
export function renewScopedKey(tenant_id, id, { ttl_days = null, expires_at = null } = {}) {
  const row = findOne('api_keys', (k) => k && !k._deleted && k.tenant_id === tenant_id && k.id === id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  const exp = (ttl_days == null && expires_at == null) ? null : _resolveExpiry({ expires_at, ttl_days });
  update('api_keys', (k) => k && k.tenant_id === tenant_id && k.id === id, { expires_at: exp, renewed_at: new Date().toISOString() });
  return { ok: true, expires_at: exp };
}
// Returns the scope array for a raw key authenticated via the api_keys table,
// or null when the key is the tenant-primary key (full access).
export function scopesForKey(key) {
  try {
    const rawHex = crypto.createHash('sha256').update(String(key || '')).digest('hex');
    const row = findOne('api_keys', (x) => x && !x._deleted && !x.revoked_at && !_scopedKeyExpired(x) && (x.hash === rawHex || x.hash === 'sha256:' + rawHex));
    return row ? (Array.isArray(row.scopes) ? row.scopes : []) : null;
  } catch (_) { return null; }
}
// --- M-AUDIT scoped-key last_used_at tracking (opt-in) ---------------------
// Writing last_used_at on every authenticated request is expensive on the hot
// path (a store write per call), so by default we do NOT track it. Operators who
// need an audit trail (which keys are active vs abandoned, for rotation /
// compliance) can opt in with KOLM_KEY_LAST_USED_TRACKING=1. When enabled, the
// raw key hash is queued and a coalesced batch is flushed by
// flushKeyLastUsed() - called on a low-frequency background interval from
// server.js startup, NOT inline - so the request never pays the write latency.
//
// The queue is a Map(hash -> latest-iso) so repeated calls with the same key
// collapse to a single write per flush. Bounded at 5000 distinct keys per window
// to cap memory; beyond that we drop new entries (the existing ones still flush).
const _lastUsedQueue = new Map();
const _LAST_USED_QUEUE_MAX = 5000;

export function keyLastUsedTrackingEnabled() {
  return process.env.KOLM_KEY_LAST_USED_TRACKING === '1';
}

// Record that the scoped key with sha256-hex `rawHex` was used at `at` (ISO).
// No-op unless tracking is enabled. Cheap: an in-memory Map.put, no store write.
export function recordKeyLastUsed(rawHex, at = new Date().toISOString()) {
  if (!keyLastUsedTrackingEnabled()) return;
  if (!rawHex) return;
  if (!_lastUsedQueue.has(rawHex) && _lastUsedQueue.size >= _LAST_USED_QUEUE_MAX) return;
  _lastUsedQueue.set(rawHex, at);
}

// Flush the coalesced last_used_at queue to the api_keys table in one
// transaction. Returns { flushed } (number of distinct keys updated). Safe to
// call when the queue is empty (returns { flushed: 0 }). Intended to be driven
// by a background interval in server.js, e.g. every KOLM_KEY_LAST_USED_FLUSH_MS.
export function flushKeyLastUsed() {
  if (_lastUsedQueue.size === 0) return { flushed: 0 };
  const batch = Array.from(_lastUsedQueue.entries());
  _lastUsedQueue.clear();
  let flushed = 0;
  withTransaction(() => {
    for (const [rawHex, at] of batch) {
      const n = update('api_keys', (k) => k && !k._deleted && !k.revoked_at && (k.hash === rawHex || k.hash === 'sha256:' + rawHex), { last_used_at: at });
      if (n > 0) flushed += 1;
    }
  });
  return { flushed };
}

// AUTH-03 - background flusher wiring. The flush is USELESS unless something
// drives it on an interval; previously nothing did, so last_used_at stayed null
// forever and the queue grew unbounded in memory (a false 'never used' signal,
// worse than absent). server.js calls startKeyLastUsedFlusher() once at startup
// (only when tracking is enabled) and stopKeyLastUsedFlusher() on graceful
// shutdown so the final window is not lost. Kept here, in the auth lane, so the
// interval/shutdown semantics live next to the queue they drain.
let _lastUsedTimer = null;

// Start the background flush interval. No-op (returns null) unless tracking is
// enabled. The timer is unref'd so it never holds the event loop open. Flush
// cadence is KOLM_KEY_LAST_USED_FLUSH_MS (default 30000). Idempotent: a second
// call returns the existing timer rather than stacking a second interval.
export function startKeyLastUsedFlusher(logger = console) {
  if (!keyLastUsedTrackingEnabled()) return null;
  if (_lastUsedTimer) return _lastUsedTimer;
  const ms = Number(process.env.KOLM_KEY_LAST_USED_FLUSH_MS || 30000);
  const everyMs = Number.isFinite(ms) && ms >= 1000 ? ms : 30000;
  const tick = () => {
    try {
      const { flushed } = flushKeyLastUsed();
      if (flushed > 0 && logger && typeof logger.debug === 'function') {
        logger.debug(`[auth] flushed last_used_at for ${flushed} scoped key(s)`);
      }
    } catch (e) {
      try { (logger || console).error('[auth] last_used flush error:', e && e.message); } catch { /* deliberate: cleanup */ }
    }
  };
  _lastUsedTimer = setInterval(tick, everyMs);
  if (_lastUsedTimer.unref) _lastUsedTimer.unref();
  return _lastUsedTimer;
}

// Stop the flusher and drain the final window so the last batch is not lost on
// a graceful shutdown (SIGTERM/SIGINT). Returns { flushed } from the final
// flush. Safe to call when the flusher was never started.
export function stopKeyLastUsedFlusher() {
  if (_lastUsedTimer) {
    clearInterval(_lastUsedTimer);
    _lastUsedTimer = null;
  }
  try { return flushKeyLastUsed(); } catch { return { flushed: 0 }; }
}

function _scopeAllowsAction(granted, action) {
  const g = String(granted || '').trim();
  const a = String(action || '').trim();
  if (!g || !a) return false;
  if (g === '*') return true;
  if (g === a) return true;
  if (a === '*') return false;
  // Hierarchical wildcard support: account:* matches account:keys:write,
  // account:keys:* matches account:keys:read, lake:* matches lake:export.
  if (g.endsWith(':*')) {
    const prefix = g.slice(0, -1);
    return a.startsWith(prefix);
  }
  return false;
}

// Convenience for routes: a full (null-scope) key passes everything; a scoped
// key passes only when '*', the exact action scope, or an action-family wildcard
// is present.
export function keyHasScope(req, action) {
  const sc = req && req.key_scopes;
  if (sc == null) return true;
  return Array.isArray(sc) && sc.some((scope) => _scopeAllowsAction(scope, action));
}

export function authMiddleware(req, res, next) {
  const p = req.path;
  // Non-API paths bypass auth entirely (page routes, static, 404 fallback handle them)
  if (!p.startsWith('/v1/')) return next();
  // W258-SEC-1: ?api_key=... lands in CDN access logs, Referer chains, and
  // browser history. The query-param fallback is removed for tenant API
  // keys. CLI / server-to-server callers already use Authorization or
  // X-API-Key; the browser dashboard uses the httpOnly cookie. Anonymous
  // ?anon=<token> bootstrap (short-lived, scoped) still uses its own
  // dedicated route - it never hits this fallback.
  if (PUBLIC_API(p)) {
    // Soft-auth: never reject, but if the caller sent a valid key, populate
    // req.tenant_record so the route can differentiate anon vs owner reads
    // (e.g. /v1/hub/:owner/:name returning private rows only to their owner).
    const header = req.headers.authorization || '';
    const xApi = req.headers['x-api-key'] || '';
    const cookieKey = (req.cookies && req.cookies.kolm_session) || '';
    const key = cookieKey || header.replace(/^Bearer\s+/i, '').trim() || xApi;
    if (key) {
      const t = findTenantByApiKey(key);
      if (t && !(t.kind === 'anon' && t.expires_at && new Date(t.expires_at) < new Date())) {
        req.tenant_record = t;
        req.tenant = t.id;
      }
    }
    return next();
  }
  const adminKey = adminApiKey();
  const header = req.headers.authorization || '';
  const xApi = req.headers['x-api-key'] || '';
  const cookieKey = (req.cookies && req.cookies.kolm_session) || '';
  // S7 + W258-SEC-1: cookie > Authorization > X-API-Key. Query-param api_key
  // was removed because it leaks credentials through CDN access logs and
  // Referer headers. If a caller sends ?api_key=... we now reject with 401
  // and a hint to use a header, so the regression is loud not silent.
  const queryKey = req.query && req.query.api_key ? String(req.query.api_key) : '';
  if (queryKey) {
    return res.status(401).json({
      error: 'api_key_in_query_unsupported',
      hint: 'pass the key via Authorization: Bearer <key> or X-API-Key header. The ?api_key= form was removed to keep credentials out of CDN logs.',
    });
  }
  const key = cookieKey || header.replace(/^Bearer\s+/i, '').trim() || xApi;

  if (adminKey && key === adminKey) {
    req.tenant = process.env.DEFAULT_TENANT || 'demo';
    req.is_admin = true;
    return next();
  }

  if (!key) return res.status(401).json({ error: 'missing api key', hint: 'set Authorization: Bearer <key> or X-API-Key header' });
  const t = findTenantByApiKey(key);
  if (!t) return res.status(401).json({ error: 'invalid api key' });

  // Anon tokens expire - deny + nudge to claim
  if (t.kind === 'anon' && t.expires_at && new Date(t.expires_at) < new Date()) {
    return res.status(401).json({
      error: 'anonymous workspace expired',
      hint: 'run `recipe claim --email you@co.com` to convert to a permanent account',
      expired_at: t.expires_at,
    });
  }

  // rate limit
  const tk = takeToken(t);
  res.set('X-RateLimit-Limit', String(t.rate_per_sec || DEFAULT_RATE));
  res.set('X-RateLimit-Burst', String(t.burst || DEFAULT_BURST));
  if (!tk.ok) {
    res.set('Retry-After', String(Math.ceil(tk.retry_after_ms / 1000)));
    res.set('X-RateLimit-Remaining', '0');
    return res.status(429).json({ error: 'rate limit exceeded', retry_after_ms: tk.retry_after_ms });
  }
  res.set('X-RateLimit-Remaining', String(Math.max(0, Math.floor(buckets.get(t.id)?.tokens || 0))));

  // quota check (count per call where billing applies)
  if (typeof t.quota === 'number') {
    res.set('X-Quota-Limit', String(t.quota));
    res.set('X-Quota-Used', String(t.used || 0));
    res.set('X-Quota-Remaining', String(Math.max(0, t.quota - (t.used || 0))));
    if (t.used >= t.quota) {
      return res.status(429).json({ error: 'monthly quota exceeded', used: t.used, quota: t.quota });
    }
  }

  req.tenant = t.name;
  req.tenant_record = t;
  // Stash the verified raw key so handlers can use it (e.g. /v1/account
  // mirroring api_key into a sliding-session cookie). Tenants store only
  // api_key_hash post-migration, so without this the raw key is unrecoverable.
  req.api_key = key;
  // W936 - scoped keys: null for the tenant-primary key (full access), an array
  // of scopes for keys minted via mintScopedKey. Routes gate with keyHasScope /
  // authorizeCaptureAction({ keyScopes: req.key_scopes || ['*'] }).
  req.key_scopes = scopesForKey(key);
  // M-AUDIT: opt-in last_used_at tracking. Only does in-memory work when a
  // scoped key authenticated (req.key_scopes != null) AND tracking is enabled;
  // the actual store write is deferred to flushKeyLastUsed() on a background
  // interval, so the hot path never pays a per-request write.
  if (req.key_scopes != null && keyLastUsedTrackingEnabled()) {
    try { recordKeyLastUsed(crypto.createHash('sha256').update(String(key)).digest('hex')); } catch { /* deliberate: cleanup */ }
  }
  next();
}

// Lightweight billing increment. Call from billable handlers.
// W258-BE-4: previously did a read-modify-write off the stale tenant_record
// snapshot the middleware captured at request entry. Two concurrent billable
// requests on the same tenant would both read `used=N`, both write `N+units`,
// and the second increment was lost - paying-plan tenants drifted past quota
// and we under-billed. Wrap the read-modify-write in withTransaction so
// SQLite's BEGIN IMMEDIATE serializes the increment. Re-read the row inside
// the transaction so we increment from the latest committed value, not the
// possibly-stale tenant_record handed to the middleware.
export function chargeUsage(tenant_record, units = 1) {
  if (!tenant_record) return;
  withTransaction(() => {
    const fresh = findOne('tenants', x => x.id === tenant_record.id) || tenant_record;
    update('tenants', x => x.id === tenant_record.id, {
      used: (fresh.used || 0) + units,
      last_used_at: new Date().toISOString(),
    });
  });
}

// Plan-tier entitlement gate. Use as middleware on routes that should only be
// available to a subset of plans (e.g. /v1/teams, /v1/tunnels, /v1/byoc).
// Admin tokens always pass. Returns 402 with a hint to upgrade when the
// tenant's plan is not in the allowed set; pending paid plans get a 402 with
// `pending=true` instead of being silently denied.
//
// Usage:
//   const requireTeams = requirePlan(['teams','business','enterprise'], 'teams workspace');
//   r.post('/v1/teams', requireTeams, (req, res) => { ... });
export function requirePlan(allowedPlans, feature = 'this feature') {
  const allowed = new Set((allowedPlans || []).map(p => String(p).toLowerCase()));
  return function entitlementMiddleware(req, res, next) {
    if (req.is_admin) return next();
    const t = req.tenant_record;
    if (!t) {
      return res.status(401).json({
        error: 'authentication required',
        feature,
        hint: 'set Authorization: Bearer <api_key>',
      });
    }
    const plan = String(t.plan || 'free').toLowerCase();
    if (allowed.has(plan)) return next();
    // Pending upgrade - show as "payment pending" rather than "upgrade".
    if (t.pending_plan && allowed.has(String(t.pending_plan).toLowerCase())) {
      return res.status(402).json({
        error: 'plan upgrade pending payment',
        feature,
        current_plan: plan,
        pending_plan: t.pending_plan,
        hint: 'complete checkout to unlock',
      });
    }
    return res.status(402).json({
      error: 'plan upgrade required',
      feature,
      current_plan: plan,
      allowed_plans: Array.from(allowed),
      hint: `POST /v1/account/change-plan with one of: ${Array.from(allowed).join(', ')}`,
    });
  };
}

export function rateLimitStats() {
  const out = [];
  for (const [tid, b] of buckets) out.push({ tenant_id: tid, tokens: Math.floor(b.tokens), cap: b.cap });
  return out;
}
