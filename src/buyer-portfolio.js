// src/buyer-portfolio.js
//
// OFFER #7 - the BUYER side of the trust link. A security team that has been
// handed many vendor Trust links (one per AI vendor they buy from) needs ONE
// pane that tracks every vendor's readiness, evidence grade, attestation
// freshness, and the delta since the prior cycle - with a clear lapse / stale
// signal per vendor so a procurement owner knows which vendor to chase.
//
// This module is a READ surface over primitives that already exist:
//   * resolveTrust(slug) (src/asr-fulfillment.js) resolves a public Trust slug
//     to its latest signed report envelope + freshness metadata (lapsed/stale,
//     last_run_at, age_hours, subject, report_id).
//   * the watchlist is a NEW table concept, 'buyer_watchlist', persisted via the
//     same store helpers (insert / update / findByField / id) that every other
//     tenant-scoped table uses. Each row pins ONE watched vendor slug to the
//     buyer's tenant: { id, tenant_id, trust_slug, label }.
//
// It owns NO engine: buildPortfolioView() does not re-ingest or re-sign. It
// reads each watched slug's already-signed latest report through resolveTrust
// and reshapes the SAME signed fields (summary.readiness_pct, evidence_tier.grade,
// generated_at) into a per-vendor row. The delta_since_prev is read off the
// report row's own stored drift / delta when present; this module never
// recomputes a diff (that stays the engine's job).
//
// DEPENDENCY INJECTION: every function takes an explicit `store` so the unit
// tests drive it with a fake store + a fake resolveTrust and never touch the
// real JSON / sqlite tables. A store object MUST expose:
//   store.insert(table, row)            -> row
//   store.update(table, predicate, patch)
//   store.findByField(table, field, value) -> rows[]
//   store.id(prefix)                    -> unique id string
//   store.resolveTrust(slug)            -> resolveTrust() hit (or null)
// In production src/audit-routes.js wires these from src/store.js +
// src/asr-fulfillment.js (see the integration spec). Pure + never throws across
// its boundary: a slug that no longer resolves degrades to an 'unresolved'
// vendor row, never an exception.

export const BUYER_PORTFOLIO_VERSION = 'buyer-portfolio/0.1';

// The watchlist table. Mirrors the agent_audits / asr_subscriptions tenant-fence
// shape: every row carries tenant_id and is only ever read back under the owning
// tenant.
export const BUYER_WATCHLIST_TABLE = 'buyer_watchlist';

// A watched vendor slug is an unguessable capability token in the same alphabet
// the Trust link mints (mintSlug() -> [A-Za-z0-9_-]{1,64}). Validate at the
// boundary so a hostile body can never poison the table with a giant / weird
// value, and so a path-traversal-ish slug can never reach resolveTrust.
const MAX_SLUG_LEN = 128;
const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Defensive cap: a buyer pane lists vendors, not thousands of rows. Far above any
// real procurement portfolio while keeping the resolve loop bounded.
export const MAX_WATCHLIST_PER_TENANT = 500;

// Freshness windows (the buyer-facing lapse signal). A vendor report is:
//   fresh   - re-attested within FRESH_DAYS (Continuous is keeping current)
//   stale   - older than FRESH_DAYS but within STALE_DAYS (drifting, chase it)
//   lapsed  - older than STALE_DAYS, OR the Trust link itself reports lapsed
//             (an inactive Continuous subscription serving its last report)
// The day boundaries match the buyer spec: fresh < 8d, stale < 35d, lapsed beyond.
export const FRESH_DAYS = 8;
export const STALE_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = FRESH_DAYS * DAY_MS;
const STALE_MS = STALE_DAYS * DAY_MS;

// ---------------------------------------------------------------------------
// Pure helpers. None throw; a malformed input degrades to a safe default.
// ---------------------------------------------------------------------------
function _str(x) { return x == null ? '' : String(x); }

// Normalize + validate a caller-supplied slug. Returns the clean slug or null.
function _normSlug(raw) {
  const s = _str(raw).trim();
  if (!s || s.length > MAX_SLUG_LEN) return null;
  return SLUG_RE.test(s) ? s : null;
}

// The attestation timestamp a vendor report was last anchored at. Prefer the
// resolver's last_run_at (set on re-attestation), then the envelope's signed
// generated_at, then null. Returns an epoch-ms number or null.
function _attestedMs(hit, envelope) {
  const candidates = [
    hit && hit.last_run_at,
    envelope && envelope.generated_at,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(_str(c));
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Classify freshness from the attestation age + the resolver's own lapsed flag.
//   * the resolver wins on lapsed: an inactive Continuous subscription is lapsed
//     no matter how recent its last (frozen) report is.
//   * otherwise pure age buckets: fresh < FRESH_DAYS, stale < STALE_DAYS, else
//     lapsed.
//   * an unknown age (no parseable timestamp) is treated as 'lapsed' - the
//     conservative read for a buyer: an attestation we cannot date is not fresh.
function _classifyFreshness(hit, attestedMs, now) {
  if (hit && hit.lapsed === true) return 'lapsed';
  if (attestedMs == null) return 'lapsed';
  const age = now - attestedMs;
  if (age < 0) return 'fresh'; // clock skew - a future timestamp is treated as just-attested
  if (age < FRESH_MS) return 'fresh';
  if (age < STALE_MS) return 'stale';
  return 'lapsed';
}

// Readiness percent off the SIGNED summary (never recomputed). Clamped 0..100,
// rounded; null when the envelope carries no numeric readiness.
function _readinessPct(envelope) {
  const s = envelope && typeof envelope === 'object' ? envelope.summary : null;
  const pct = s && typeof s === 'object' ? s.readiness_pct : null;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Evidence grade off the SIGNED evidence_tier block (A gateway-capture /
// B hash-verified / C asserted). null when absent (a legacy / untiered report).
function _evidenceTier(envelope) {
  const et = envelope && typeof envelope === 'object' ? envelope.evidence_tier : null;
  if (et && typeof et === 'object' && et.grade != null) return _str(et.grade);
  return null;
}

// The signed last-attested ISO string for the row (what the pane displays).
function _attestedIso(attestedMs) {
  return attestedMs == null ? null : new Date(attestedMs).toISOString();
}

// The delta vs the prior cycle, read off the report row's OWN stored drift.
// reattestSub (src/asr-fulfillment.js) stamps `drift` (a computeAuditDelta
// result) on each re-attestation row; resolveTrust does not surface it, so the
// production wiring passes the resolved report ROW (when available) as hit.row
// or the module reads hit.delta_since_prev if the resolver already attached it.
// This module NEVER recomputes a diff - it only surfaces a readiness_change
// number that the engine already signed/derived. null when there is no prior.
function _deltaSincePrev(hit) {
  if (!hit || typeof hit !== 'object') return null;
  // Preferred: an explicit numeric readiness change the caller threaded in.
  if (typeof hit.delta_since_prev === 'number' && Number.isFinite(hit.delta_since_prev)) {
    return hit.delta_since_prev;
  }
  // Otherwise read a stored drift object's readiness_change (the engine's value).
  const drift = hit.drift && typeof hit.drift === 'object' ? hit.drift
    : (hit.row && hit.row.drift && typeof hit.row.drift === 'object' ? hit.row.drift : null);
  if (drift && typeof drift.readiness_change === 'number' && Number.isFinite(drift.readiness_change)) {
    return drift.readiness_change;
  }
  return null;
}

// ---------------------------------------------------------------------------
// addWatch(tenantId, store, { slug, label }) -> { ok, watch } | { ok:false, error }
//
// Pin one vendor Trust slug to the buyer's tenant. Idempotent on (tenant, slug):
// re-adding the same slug updates the label rather than duplicating the row, so a
// buyer can never accumulate two rows for one vendor. Tenant-fenced: the row is
// only ever keyed to the calling tenant; findByField is re-checked in-loop so the
// index is never trusted alone (the same W411 discipline the store helpers use).
// ---------------------------------------------------------------------------
export function addWatch(tenantId, store, { slug, label } = {}) {
  if (!tenantId) return { ok: false, error: 'no_tenant' };
  if (!store || typeof store.insert !== 'function' || typeof store.findByField !== 'function') {
    return { ok: false, error: 'store_unavailable' };
  }
  const cleanSlug = _normSlug(slug);
  if (!cleanSlug) return { ok: false, error: 'invalid_slug' };
  const cleanLabel = _str(label).trim().slice(0, 200) || null;

  let existing = [];
  try { existing = store.findByField(BUYER_WATCHLIST_TABLE, 'tenant_id', tenantId) || []; }
  catch { existing = []; }
  const owned = existing.filter((r) => r && r.tenant_id === tenantId);

  const dup = owned.find((r) => r && r.trust_slug === cleanSlug);
  if (dup) {
    // Idempotent: refresh the label only (never a second row for one vendor).
    if (cleanLabel != null && cleanLabel !== dup.label && typeof store.update === 'function') {
      try { store.update(BUYER_WATCHLIST_TABLE, (r) => r && r.id === dup.id, { label: cleanLabel }); }
      catch { /* best-effort label refresh */ }
    }
    return { ok: true, already: true, watch: { ...dup, label: cleanLabel != null ? cleanLabel : dup.label } };
  }

  if (owned.length >= MAX_WATCHLIST_PER_TENANT) {
    return { ok: false, error: 'watchlist_full' };
  }

  const mkId = typeof store.id === 'function' ? store.id : (() => 'bw_' + Math.random().toString(36).slice(2));
  const row = {
    id: mkId('bw'),
    tenant_id: tenantId,
    trust_slug: cleanSlug,
    label: cleanLabel,
    created_at: new Date().toISOString(),
  };
  try { store.insert(BUYER_WATCHLIST_TABLE, row); }
  catch (e) { return { ok: false, error: 'insert_failed', detail: e && e.message }; }
  return { ok: true, watch: row };
}

// ---------------------------------------------------------------------------
// buildPortfolioView(tenantId, store) ->
//   { vendors: [{ slug, name, readiness_pct, evidence_tier, last_attested_at,
//                 freshness, delta_since_prev }] }
//
// Resolve every watched slug for the buyer's tenant to its latest signed report
// and reshape into one sorted vendor row each. Sort order puts the vendors a
// buyer must act on FIRST: lapsed before stale before fresh, then lowest
// readiness first within a bucket, then by name for a stable tie-break. A slug
// that no longer resolves (revoked / deleted vendor) becomes an 'unresolved' row
// (freshness 'lapsed', null metrics) rather than vanishing silently - the buyer
// still sees the vendor and that the link went dark.
//
// Pure read; NEVER throws. A store / resolver hiccup on one slug degrades that
// single vendor to 'unresolved' and the rest of the pane still renders.
// ---------------------------------------------------------------------------
export function buildPortfolioView(tenantId, store, opts = {}) {
  const out = { vendors: [] };
  if (!tenantId || !store || typeof store.findByField !== 'function') return out;
  const resolveTrust = typeof store.resolveTrust === 'function' ? store.resolveTrust : null;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  let rows = [];
  try { rows = store.findByField(BUYER_WATCHLIST_TABLE, 'tenant_id', tenantId) || []; }
  catch { rows = []; }

  const seen = new Set();
  const vendors = [];
  for (const r of rows) {
    // Inner-loop tenant fence - never trust the index alone (W411).
    if (!r || r.tenant_id !== tenantId) continue;
    const slug = _normSlug(r.trust_slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    let hit = null;
    if (resolveTrust) {
      try { hit = resolveTrust(slug); } catch { hit = null; }
    }

    // Unresolved / not-yet-generated link: the buyer still sees the vendor, with
    // a clear lapsed signal and null metrics, never a dropped row.
    if (!hit || hit.pending === true || !hit.envelope) {
      vendors.push({
        slug,
        name: _str(r.label).trim() || slug,
        readiness_pct: null,
        evidence_tier: null,
        last_attested_at: null,
        freshness: 'lapsed',
        delta_since_prev: null,
      });
      continue;
    }

    const envelope = hit.envelope;
    const attestedMs = _attestedMs(hit, envelope);
    const subjName = (envelope.subject && typeof envelope.subject === 'object' && envelope.subject.name)
      ? _str(envelope.subject.name)
      : (hit.subject != null ? _str(hit.subject) : null);
    vendors.push({
      slug,
      // The buyer's own label wins (that is how THEY filed the vendor); fall back
      // to the signed report subject, then the bare slug.
      name: _str(r.label).trim() || subjName || slug,
      readiness_pct: _readinessPct(envelope),
      evidence_tier: _evidenceTier(envelope),
      last_attested_at: _attestedIso(attestedMs),
      freshness: _classifyFreshness(hit, attestedMs, now),
      delta_since_prev: _deltaSincePrev(hit),
    });
  }

  // Sort: act-on-me-first. lapsed(0) > stale(1) > fresh(2); then lowest readiness
  // first (a null readiness sorts as -1 so an unresolved vendor floats up); then
  // name for a stable, deterministic tie-break.
  const rank = { lapsed: 0, stale: 1, fresh: 2 };
  vendors.sort((a, b) => {
    const fa = rank[a.freshness] ?? 3;
    const fb = rank[b.freshness] ?? 3;
    if (fa !== fb) return fa - fb;
    const ra = a.readiness_pct == null ? -1 : a.readiness_pct;
    const rb = b.readiness_pct == null ? -1 : b.readiness_pct;
    if (ra !== rb) return ra - rb;
    return _str(a.name).localeCompare(_str(b.name));
  });

  out.vendors = vendors;
  return out;
}

export default {
  BUYER_PORTFOLIO_VERSION,
  BUYER_WATCHLIST_TABLE,
  MAX_WATCHLIST_PER_TENANT,
  FRESH_DAYS,
  STALE_DAYS,
  addWatch,
  buildPortfolioView,
};
