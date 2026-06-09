// src/trust-center.js
//
// S7 Trust Center + shareable Trust Link analytics.
//
// THE WEDGE'S DEAL-CLOSING HANDOFF
//   A buyer receives a Trust Link (GET /v1/trust/:slug - the unguessable
//   capability token minted by the paid loop in src/asr-fulfillment.js). The
//   buyer opens it, verifies the signed report offline, and the SELLER can now
//   SEE that their buyer engaged: how many views, how many distinct viewers,
//   first + last touch, and (optionally) the email of a viewer who accepted an
//   NDA gate before the report was revealed. That visible engagement is what
//   closes the deal.
//
// PRIVACY DISCIPLINE
//   * The Trust Link READ stays public (possession of the slug is the grant),
//     exactly as today. This module never widens that capability: a view row is
//     fenced to the slug's OWNER tenant, and a seller can only ever list views
//     for slugs their tenant owns. No call surfaces another tenant's data.
//   * We NEVER store a raw IP. Every viewer identifier is hashed with SHA-256
//     (salted) at the boundary; only the digest is persisted. Unique-viewer
//     counts are computed over the digest, so the analytic is pseudonymous.
//   * The optional share gate is OFF by default - when no gate row exists the
//     link behaves exactly as it does today (open). Existing links keep working.
//
// STORAGE
//   Pure store-backed (src/store.js); tables auto-create on first insert:
//     trust_views    - one row per Trust Link view (hashed viewer, no raw IP)
//     trust_gates    - optional per-slug share gate (require_email / nda_text)
//     trust_unlocks  - one row per gate unlock (captured email + unlock token)
//   Every write carries the owner tenant_id; every list re-filters by tenant_id
//   in the inner loop (never trusts the index alone - the W411 fence).
//
// LEAF MODULE: imports only ./store.js + node:crypto (no route/auth/fulfillment
// import, so there is no cycle with src/audit-routes.js which mounts us).
//
// register(r, deps) mirrors src/transparency-log-routes.js: it calls r.get /
// r.post directly. deps may carry an authMiddleware that the integrator wants
// applied to the authenticated /views + /trust-center routes; when absent the
// handlers fall back to req.tenant_record (set by the global authMiddleware).

import crypto from 'node:crypto';
import {
  id as storeId,
  insert,
  update,
  findOne,
  findByField,
  withTransaction,
} from './store.js';

export const TRUST_CENTER_VERSION = 'kolm-trust-center-v1';

const TRUST_VIEWS = 'trust_views';
const TRUST_GATES = 'trust_gates';
const TRUST_UNLOCKS = 'trust_unlocks';

// Source-of-truth tables that own a public_slug. Mirrors the constants in
// src/asr-fulfillment.js (AUDITS / SUBSCRIPTIONS); declared locally so this
// stays a leaf module with no import cycle back into fulfillment.
const AUDITS_TABLE = 'agent_audits';
const SUBSCRIPTIONS_TABLE = 'asr_subscriptions';

// Stable, deterministic salt so a viewer hashes to the SAME digest across
// requests (unique-viewer counting needs determinism) while the raw IP is never
// recoverable. Operators can rotate per deployment with KOLM_TRUST_VIEW_SALT.
const SALT = process.env.KOLM_TRUST_VIEW_SALT || 'kolm.trust.view.v1';

// Slug length matches the PUBLIC_API allowlist regex in src/auth.js
// (/^\/v1\/trust\/[A-Za-z0-9_-]{1,64}.../): never persist or query a longer one.
const SLUG_MAX = 64;

// ---------------------------------------------------------------------------
// small, never-throw helpers
// ---------------------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }

function _iso(now) {
  if (now == null) return nowIso();
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
  const d = new Date(now);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}

function _slug(s) {
  return (s == null ? '' : String(s)).slice(0, SLUG_MAX);
}

// SHA-256 of the viewer identifier. Accepts whatever the caller has (a raw IP,
// an already-hashed value, anything) and ALWAYS returns a digest, so a raw IP
// can never be persisted even if one is passed in.
function _hashViewer(raw) {
  return crypto.createHash('sha256').update(`${SALT}:${raw == null ? '' : String(raw)}`).digest('hex');
}

function _mintToken() {
  return 'tul_' + crypto.randomBytes(24).toString('hex'); // 48 hex chars of entropy
}

// User-Agent: strip control chars, collapse whitespace, cap length.
function _ua(ua) {
  if (ua == null) return null;
  const clean = String(ua)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, 256) : null;
}

// Referer: store the HOST ONLY (never the full path + query, which can leak the
// buyer's internal URLs). null when unparseable / absent.
function _refHost(referer) {
  if (!referer || typeof referer !== 'string') return null;
  const raw = referer.trim();
  if (!raw) return null;
  try {
    const h = new URL(raw).hostname;
    return h ? h.slice(0, 253) : null;
  } catch {
    const bare = raw.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].split('@').pop();
    return bare ? bare.slice(0, 253) : null;
  }
}

function _email(raw) {
  if (raw == null) return null;
  const e = String(raw).trim().toLowerCase().slice(0, 254);
  // Pragmatic ASCII email shape; the report-embedded canonical is untouched, so
  // this is a UX validator, not a spec-grade parser.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function _truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function _publicBase() {
  return (process.env.PUBLIC_BASE || process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '');
}

function _trustUrl(slug) {
  return slug ? `${_publicBase()}/v1/trust/${slug}` : null;
}

function _tenantOf(req) {
  if (!req) return null;
  const trec = req.tenant_record;
  if (trec && trec.id) return trec.id;
  if (req.tenant && req.tenant.id) return req.tenant.id;
  if (req.tenant_id) return req.tenant_id;
  if (req.auth && req.auth.tenant_id) return req.auth.tenant_id;
  return null;
}

function _clientIp(req) {
  try {
    const hdrs = req && req.headers;
    const xff = hdrs && (hdrs['x-forwarded-for'] || hdrs['X-Forwarded-For']);
    if (xff) return String(xff).split(',')[0].trim();
    if (req && req.ip) return req.ip;
    if (req && req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
    if (req && req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  } catch { /* never throw at the boundary */ }
  return '';
}

// ---------------------------------------------------------------------------
// resolveSlugOwner(slug) -> { tenant_id, kind, subject } | null
//
// The Trust Link's owner tenant is whoever owns the agent_audits row (paid +
// public_slug) or the asr_subscriptions row (stable public_slug) that minted
// the slug. This is the fence: views/gates/unlocks for a slug belong to that
// tenant and no other. NEVER throws.
// ---------------------------------------------------------------------------
export function resolveSlugOwner(slug) {
  const s = _slug(slug);
  if (!s) return null;
  try {
    const audits = findByField(AUDITS_TABLE, 'public_slug', s);
    const a = audits.find((r) => r && r.public_slug === s && r.tenant_id);
    if (a) return { tenant_id: a.tenant_id, kind: 'report', subject: a.subject || null };
    const subs = findByField(SUBSCRIPTIONS_TABLE, 'public_slug', s);
    const sub = subs.find((r) => r && r.public_slug === s && r.tenant_id);
    if (sub) return { tenant_id: sub.tenant_id, kind: 'continuous', subject: sub.subject || sub.product_key || null };
  } catch { /* never throw across the resolve boundary */ }
  return null;
}

// ===========================================================================
// 1) ACCESS ANALYTICS
// ===========================================================================

// recordTrustView({ slug, tenant_id?, ip?, ip_hash?, ua?, referer?, now? })
//   Append one view row. The IP is hashed with SHA-256 at the boundary and the
//   RAW IP IS NEVER STORED. The owner tenant is resolved from the slug (or taken
//   from an explicit tenant_id the caller already has). ua is truncated; only
//   the referer HOST is kept. NEVER throws; returns { ok, view } | { ok:false }.
export function recordTrustView({ slug, tenant_id, ip, ip_hash, ua, referer, now } = {}) {
  try {
    const s = _slug(slug);
    if (!s) return { ok: false, reason: 'no_slug' };
    let owner = tenant_id || null;
    if (!owner) {
      const resolved = resolveSlugOwner(s);
      owner = resolved ? resolved.tenant_id : null;
    }
    // Prefer a raw ip when present; fall back to whatever was passed as ip_hash.
    // Either way it is re-hashed, so nothing raw is ever persisted.
    const rawId = (ip != null && ip !== '') ? ip : (ip_hash != null ? ip_hash : '');
    const row = {
      id: storeId('tvw'),
      slug: s,
      tenant_id: owner,
      ip_hash: _hashViewer(rawId),
      ua: _ua(ua),
      referer_host: _refHost(referer),
      ts: _iso(now),
      version: TRUST_CENTER_VERSION,
    };
    insert(TRUST_VIEWS, row);
    return { ok: true, view: row };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// listTrustViews(tenant_id, slug?, { limit }) -> newest-first view rows for the
// seller dashboard. Tenant-fenced in the inner loop (never trusts the index).
// Pass a slug to scope to a single Trust Link; omit it to list the tenant's
// whole Trust Center. Returns [] for a missing tenant. NEVER throws.
export function listTrustViews(tenant_id, slug = null, { limit = 1000 } = {}) {
  try {
    if (!tenant_id) return [];
    const s = slug != null ? _slug(slug) : null;
    const base = s
      ? findByField(TRUST_VIEWS, 'slug', s)
      : findByField(TRUST_VIEWS, 'tenant_id', tenant_id);
    const out = [];
    for (const r of base) {
      if (!r || String(r.tenant_id) !== String(tenant_id)) continue; // W411 inner fence
      if (s && r.slug !== s) continue;
      out.push(r);
    }
    out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return out.slice(0, Math.max(1, (limit | 0) || 1000));
  } catch {
    return [];
  }
}

// summarizeTrustViews(slug) -> { views, unique_viewers, first_view, last_view }
// Pure roll-up over every view of one slug. unique_viewers dedupes by the hashed
// viewer id. NEVER throws.
export function summarizeTrustViews(slug) {
  const empty = { views: 0, unique_viewers: 0, first_view: null, last_view: null };
  try {
    const s = _slug(slug);
    if (!s) return empty;
    const rows = findByField(TRUST_VIEWS, 'slug', s);
    if (!rows.length) return empty;
    const viewers = new Set();
    let first = null;
    let last = null;
    for (const r of rows) {
      if (r && r.ip_hash) viewers.add(r.ip_hash);
      const ts = r && r.ts ? r.ts : null;
      if (ts) {
        if (first === null || ts < first) first = ts;
        if (last === null || ts > last) last = ts;
      }
    }
    return { views: rows.length, unique_viewers: viewers.size, first_view: first, last_view: last };
  } catch {
    return empty;
  }
}

// ===========================================================================
// 3) OPTIONAL GATED SHARE (OFF by default)
// ===========================================================================

// createTrustGate({ slug, tenant_id, require_email?, nda_text? }) -> { ok, gate }
//   Enable (or update) a share gate on a slug the tenant OWNS. Idempotent per
//   (slug). Ownership is enforced when the slug resolves to an owner: a tenant
//   can never gate another tenant's link. With no gate row a link stays open.
//   NEVER throws.
export function createTrustGate({ slug, tenant_id, require_email = true, nda_text = null } = {}) {
  try {
    const s = _slug(slug);
    if (!s || !tenant_id) return { ok: false, reason: 'missing_fields' };
    const owner = resolveSlugOwner(s);
    if (owner && String(owner.tenant_id) !== String(tenant_id)) {
      return { ok: false, reason: 'not_owner' };
    }
    return withTransaction(() => {
      const existing = findOne(TRUST_GATES, (g) => g && g.slug === s && String(g.tenant_id) === String(tenant_id));
      const ts = nowIso();
      const fields = {
        require_email: require_email !== false,
        nda_text: nda_text != null ? String(nda_text).slice(0, 5000) : null,
        enabled: true,
        updated_at: ts,
      };
      if (existing) {
        update(TRUST_GATES, (g) => g.id === existing.id, fields);
        return { ok: true, gate: findOne(TRUST_GATES, (g) => g.id === existing.id) };
      }
      const row = {
        id: storeId('tgate'),
        slug: s,
        tenant_id,
        ...fields,
        created_at: ts,
        version: TRUST_CENTER_VERSION,
      };
      insert(TRUST_GATES, row);
      return { ok: true, gate: row };
    });
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// getTrustGate(slug) -> the ENABLED gate row, or null when none (open link).
// NEVER throws.
export function getTrustGate(slug) {
  try {
    const s = _slug(slug);
    if (!s) return null;
    const rows = findByField(TRUST_GATES, 'slug', s);
    return rows.find((g) => g && g.enabled !== false) || null;
  } catch {
    return null;
  }
}

// removeTrustGate({ slug, tenant_id }) -> { ok, disabled } - disable a gate
// (tenant-fenced), reverting the link to open. NEVER throws.
export function removeTrustGate({ slug, tenant_id } = {}) {
  try {
    const s = _slug(slug);
    if (!s || !tenant_id) return { ok: false, reason: 'missing_fields' };
    const n = update(
      TRUST_GATES,
      (g) => g && g.slug === s && String(g.tenant_id) === String(tenant_id),
      { enabled: false, updated_at: nowIso() },
    ) || 0;
    return { ok: true, disabled: n };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// recordTrustUnlock({ slug, email, accepted_terms, ip?, ip_hash?, ua?, referer?, now? })
//   Record a viewer's unlock of a gated link and mint an unlock token. When a
//   gate requires an email and none/invalid is supplied -> { ok:false,
//   reason:'email_required' }. When the gate carries nda_text the viewer must
//   accept terms -> else { ok:false, reason:'terms_required' }. When NO gate
//   exists the unlock still succeeds (gated:false) and captures the lead, so
//   the front-end flow is uniform. The IP is hashed; the raw IP is never stored.
//   NEVER throws.
export function recordTrustUnlock({ slug, email, accepted_terms, ip, ip_hash, ua, referer, now } = {}) {
  try {
    const s = _slug(slug);
    if (!s) return { ok: false, reason: 'no_slug' };
    const gate = getTrustGate(s);
    const normEmail = _email(email);
    const accepted = _truthy(accepted_terms);
    if (gate) {
      if (gate.require_email && !normEmail) return { ok: false, reason: 'email_required', gated: true };
      if (gate.nda_text && !accepted) return { ok: false, reason: 'terms_required', gated: true };
    }
    const owner = resolveSlugOwner(s);
    const rawId = (ip != null && ip !== '') ? ip : (ip_hash != null ? ip_hash : '');
    const token = _mintToken();
    const row = {
      id: storeId('tulrow'),
      token,
      slug: s,
      tenant_id: owner ? owner.tenant_id : null,
      email: normEmail,
      accepted_terms: accepted,
      ip_hash: _hashViewer(rawId),
      ua: _ua(ua),
      referer_host: _refHost(referer),
      ts: _iso(now),
      version: TRUST_CENTER_VERSION,
    };
    insert(TRUST_UNLOCKS, row);
    return { ok: true, token, gated: !!gate, unlock: row };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// verifyTrustUnlock(slug, token) -> { ok, unlock } | { ok:false, reason }
//   The integrator calls this from GET /v1/trust/:slug to decide whether a
//   presented unlock token grants access to a gated link. NEVER throws.
export function verifyTrustUnlock(slug, token) {
  try {
    const s = _slug(slug);
    if (!s || !token) return { ok: false, reason: 'missing' };
    const rows = findByField(TRUST_UNLOCKS, 'token', String(token));
    const u = rows.find((r) => r && r.slug === s);
    if (!u) return { ok: false, reason: 'not_found' };
    return { ok: true, unlock: u };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// listTrustUnlocks(tenant_id, slug?, { limit }) -> captured leads for the seller
// dashboard, newest-first, tenant-fenced. NEVER throws.
export function listTrustUnlocks(tenant_id, slug = null, { limit = 1000 } = {}) {
  try {
    if (!tenant_id) return [];
    const s = slug != null ? _slug(slug) : null;
    const base = s
      ? findByField(TRUST_UNLOCKS, 'slug', s)
      : findByField(TRUST_UNLOCKS, 'tenant_id', tenant_id);
    const out = [];
    for (const r of base) {
      if (!r || String(r.tenant_id) !== String(tenant_id)) continue;
      if (s && r.slug !== s) continue;
      out.push(r);
    }
    out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return out.slice(0, Math.max(1, (limit | 0) || 1000));
  } catch {
    return [];
  }
}

// ===========================================================================
// 4) SELLER-FACING TRUST CENTER INDEX
// ===========================================================================

// listTrustCenter(tenant_id) -> the tenant's published Trust Links with view
// roll-ups, for the seller dashboard. Reads ONLY the requesting tenant's audits
// + subscriptions (tenant-fenced inner loop). NEVER throws.
export function listTrustCenter(tenant_id) {
  try {
    if (!tenant_id) return [];
    const out = [];
    const seen = new Set();
    const push = (slug, base) => {
      const s = _slug(slug);
      if (!s || seen.has(s)) return;
      seen.add(s);
      const summary = summarizeTrustViews(s);
      out.push({
        slug: s,
        trust_url: _trustUrl(s),
        gated: !!getTrustGate(s),
        ...base,
        ...summary,
      });
    };
    for (const a of findByField(AUDITS_TABLE, 'tenant_id', tenant_id)) {
      if (!a || String(a.tenant_id) !== String(tenant_id)) continue;
      if (!a.public_slug || a.public !== true) continue;
      push(a.public_slug, { subject: a.subject || null, kind: 'report', status: null });
    }
    for (const sub of findByField(SUBSCRIPTIONS_TABLE, 'tenant_id', tenant_id)) {
      if (!sub || String(sub.tenant_id) !== String(tenant_id)) continue;
      if (!sub.public_slug) continue;
      push(sub.public_slug, { subject: sub.subject || sub.product_key || null, kind: 'continuous', status: sub.status || null });
    }
    out.sort((a, b) => (b.views - a.views) || String(b.last_view || '').localeCompare(String(a.last_view || '')));
    return out;
  } catch {
    return [];
  }
}

// renderTrustCenterIndex(reports) -> ASCII HTML for a seller-facing Trust Center
// summary. Pure (no store reads): pass the array from listTrustCenter (or any
// array of { slug, subject, kind, views, unique_viewers, last_view, trust_url,
// gated }). Inline minimal styles, no external CSS dependency, every dynamic
// value HTML-escaped, ASCII-only output. NEVER throws.
export function renderTrustCenterIndex(reports) {
  const list = Array.isArray(reports) ? reports : [];
  const wrap = (inner) => `<section class="kolm-trust-center" style="font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b0e14;max-width:880px;margin:0 auto">${inner}</section>`;
  if (!list.length) {
    return wrap(
      '<h2 style="font-size:18px;margin:0 0 6px">Trust Center</h2>'
      + '<p style="color:#5b6472;margin:0">No published Trust Links yet. Purchase a signed report or start Continuous to mint a shareable Trust Link, then track who opens it here.</p>',
    );
  }
  const head = '<thead><tr style="text-align:left;border-bottom:2px solid #e6e8ec;color:#5b6472;font-size:12px;text-transform:uppercase;letter-spacing:.04em">'
    + '<th style="padding:8px 10px">Report</th>'
    + '<th style="padding:8px 10px">Type</th>'
    + '<th style="padding:8px 10px">Views</th>'
    + '<th style="padding:8px 10px">Unique</th>'
    + '<th style="padding:8px 10px">Last view</th>'
    + '<th style="padding:8px 10px">Link</th></tr></thead>';
  const body = list.map((r) => {
    const subject = _esc((r && (r.subject || r.slug)) || 'Agent security report');
    const kind = _esc(r && r.kind === 'continuous' ? 'Continuous' : 'Report');
    const views = r && Number.isFinite(r.views) ? r.views : 0;
    const uniq = r && Number.isFinite(r.unique_viewers) ? r.unique_viewers : 0;
    const last = r && r.last_view
      ? _esc(String(r.last_view).replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, ' UTC'))
      : 'never';
    const url = _esc((r && r.trust_url) || '#');
    const gated = r && r.gated
      ? ' <span style="font-size:11px;color:#92400e;border:1px solid #f0c98a;border-radius:4px;padding:1px 5px;vertical-align:1px">gated</span>'
      : '';
    return '<tr style="border-bottom:1px solid #eef0f3">'
      + `<td style="padding:9px 10px;font-weight:600">${subject}${gated}</td>`
      + `<td style="padding:9px 10px;color:#5b6472">${kind}</td>`
      + `<td style="padding:9px 10px;font-variant-numeric:tabular-nums">${views}</td>`
      + `<td style="padding:9px 10px;font-variant-numeric:tabular-nums">${uniq}</td>`
      + `<td style="padding:9px 10px;color:#5b6472">${last}</td>`
      + `<td style="padding:9px 10px"><a href="${url}" style="color:#b3431f;text-decoration:none">open</a></td>`
      + '</tr>';
  }).join('');
  const totalViews = list.reduce((n, r) => n + (r && Number.isFinite(r.views) ? r.views : 0), 0);
  return wrap(
    '<h2 style="font-size:18px;margin:0 0 4px">Trust Center</h2>'
    + `<p style="color:#5b6472;margin:0 0 14px">${list.length} published Trust Link${list.length === 1 ? '' : 's'}, `
    + `${totalViews} total view${totalViews === 1 ? '' : 's'}. Each link is an unguessable capability token; possession is the grant.</p>`
    + `<table style="width:100%;border-collapse:collapse;font-size:13px">${head}<tbody>${body}</tbody></table>`,
  );
}

// View row shaped for the seller API: exposes the hashed viewer (safe) plus the
// truncated ua + referer host + timestamp. Never the raw IP (we do not store it).
function _publicViewRow(r) {
  return {
    id: r && r.id,
    ts: r && r.ts,
    viewer_hash: r && r.ip_hash ? r.ip_hash : null,
    ua: (r && r.ua) || null,
    referer_host: (r && r.referer_host) || null,
  };
}

// ===========================================================================
// ROUTES - register(r, deps)
// ===========================================================================
export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('trust-center.register: router with get/post required');
  }
  const auth = deps && typeof deps.authMiddleware === 'function' ? deps.authMiddleware : null;
  const withAuth = (path, handler) => (auth ? r.get(path, auth, handler) : r.get(path, handler));

  // -------------------------------------------------------------------------
  // GET /v1/trust/:slug/views  (AUTH, tenant-fenced)
  // The seller sees who viewed their Trust Link: counts + a hashed-viewer
  // timeline. A slug owned by another tenant returns 404 (we never confirm the
  // existence of another tenant's link).
  // -------------------------------------------------------------------------
  withAuth('/v1/trust/:slug/views', (req, res) => {
    try {
      const tenant = _tenantOf(req);
      if (!tenant) {
        return res.status(401).json({ ok: false, error: 'auth_required', hint: 'send Authorization: Bearer <ks_* key>' });
      }
      const slug = _slug(req.params && req.params.slug);
      if (!slug) return res.status(400).json({ ok: false, error: 'no_slug' });
      const owner = resolveSlugOwner(slug);
      if (!owner || String(owner.tenant_id) !== String(tenant)) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const summary = summarizeTrustViews(slug);
      const views = listTrustViews(tenant, slug).map(_publicViewRow);
      const gate = getTrustGate(slug);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, slug, gated: !!gate, summary, views });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'trust_views_failed', detail: e && e.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/trust-center  (AUTH) - the seller's index of published Trust Links
  // with view roll-ups. ?format=html renders renderTrustCenterIndex; default is
  // JSON. Tenant-fenced (reads only the caller's own slugs).
  // -------------------------------------------------------------------------
  withAuth('/v1/trust-center', (req, res) => {
    try {
      const tenant = _tenantOf(req);
      if (!tenant) {
        return res.status(401).json({ ok: false, error: 'auth_required', hint: 'send Authorization: Bearer <ks_* key>' });
      }
      const reports = listTrustCenter(tenant);
      const fmt = (req.query && String(req.query.format || 'json')).toLowerCase();
      res.setHeader('Cache-Control', 'no-store');
      if (fmt === 'html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(renderTrustCenterIndex(reports));
      }
      return res.json({ ok: true, count: reports.length, reports });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'trust_center_failed', detail: e && e.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/trust/:slug/unlock  (PUBLIC) - a viewer of a GATED link submits an
  // email + accept-terms and receives an unlock token. When no gate exists the
  // link is open: the call still succeeds (gated:false) and captures the lead.
  // The integrator adds this path to PUBLIC_API in src/auth.js.
  // -------------------------------------------------------------------------
  r.post('/v1/trust/:slug/unlock', (req, res) => {
    try {
      const slug = _slug(req.params && req.params.slug);
      if (!slug) return res.status(400).json({ ok: false, error: 'no_slug' });
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const out = recordTrustUnlock({
        slug,
        email: body.email,
        accepted_terms: body.accept_terms != null ? body.accept_terms : body.accepted_terms,
        ip: _clientIp(req),
        ua: req.headers && req.headers['user-agent'],
        referer: req.headers && (req.headers.referer || req.headers.referrer),
      });
      res.setHeader('Cache-Control', 'no-store');
      if (!out.ok) {
        const known = out.reason === 'email_required' || out.reason === 'terms_required' || out.reason === 'no_slug';
        return res.status(known ? 400 : 500).json({ ok: false, error: out.reason || 'unlock_failed', gated: out.gated === true });
      }
      return res.json({ ok: true, token: out.token, gated: out.gated });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'unlock_failed', detail: e && e.message });
    }
  });

  return r;
}

export default register;

export const TRUST_CENTER_SPEC = {
  version: TRUST_CENTER_VERSION,
  tables: [TRUST_VIEWS, TRUST_GATES, TRUST_UNLOCKS],
  routes: [
    'GET /v1/trust/:slug/views (auth, tenant-fenced)',
    'GET /v1/trust-center (auth, tenant-fenced)',
    'POST /v1/trust/:slug/unlock (public)',
  ],
  public_api_to_allowlist: [
    'POST /v1/trust/:slug/unlock',
  ],
};
