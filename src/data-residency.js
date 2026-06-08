// src/data-residency.js
//
// W769 - Data Residency + Geo-Fence.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 609-614):
//   [W769-1] Data residency tagging on every capture (EU stays EU)
//   [W769-2] Region-specific .kolm artifacts (manifest region field)
//   [W769-3] Region-aware distillation (only captures from target region)
//   [W769-4] Geo-fencing already in W708-5 (src/auth.js EXPORT_CONTROL_DENYLIST)
//
// Design contract:
//   - Pure JS. No external dependencies. Region tags persist as canonical
//     event-store rows (provider='kolm_data_residency') so the same lake
//     readers used by capture-stats / bakeoff can attribute by region
//     without learning a second storage schema.
//   - HONESTY FLOOR:
//       * inferRegionFromTenant defaults to DEFAULT_REGION when undetermined.
//         Never silently guesses EU just because the tenant carries an
//         ambiguous country code - DEFAULT_REGION is GLOBAL, the explicit
//         "we don't know, treat as unrestricted" sentinel.
//       * enforceRegionPolicy NEVER silent-passes a cross-region request.
//         A capture tagged EU_WEST against target_region=US_EAST returns
//         {allowed:false, reason:'region_mismatch'} with a hint to
//         re-shard the capture or to flip the target to GLOBAL.
//       * tagCapture rejects an unknown region with an honest
//         {ok:false, error:'unknown_region'} envelope listing the valid keys.
//   - TENANT FENCE (W411 law): every read goes through listEvents with an
//     explicit tenant_id filter PLUS a defence-in-depth per-row filter so
//     a foreign-tenant tag can never surface even if a store driver bug
//     dropped the WHERE clause.
//   - GEO-FENCE vs RESIDENCY: W708-5 EXPORT_CONTROL_DENYLIST in src/auth.js
//     blocks sign-up by country code (a perimeter control); W769 tags
//     where data LIVES at capture time (a data-locality control). Both
//     are required for a credible regulated-industry posture but they
//     cover orthogonal threat models. The /compliance/data-residency
//     landing page surfaces the cross-reference explicitly.
//
// Public surface:
//   - DATA_RESIDENCY_VERSION
//   - REGIONS                       (Object.freeze taxonomy)
//   - DEFAULT_REGION                ('GLOBAL')
//   - inferRegionFromTenant(tenant_record)
//   - tagCapture({tenant_id, capture_id, region, confirm:true})
//   - getCaptureRegion({tenant_id, capture_id})
//   - configureNamespaceRegion({tenant_id, namespace, region, confirm:true})
//   - getNamespaceDefaultRegion({tenant_id, namespace})
//   - enforceRegionPolicy({tenant_id, capture, target_region})

import * as defaultEventStore from './event-store.js';

export const DATA_RESIDENCY_VERSION = 'w769-v1';

// ---------------------------------------------------------------------------
// Region taxonomy. Frozen so a downstream caller cannot mutate the contract.
// Each entry binds:
//   - id                     stable key (must match the Object.keys() entry)
//   - display_name           human-friendly label for UI / receipts
//   - regulatory_framework[] array of frameworks that ANCHOR this region's
//                            data-residency expectations
//   - iso_3166_codes[]       ISO 3166-1 alpha-2 country codes inside the
//                            region. inferRegionFromTenant lookups walk
//                            this list to map a tenant's signup country
//                            to the most-restrictive matching region.
//
// Nine entries (>= 8 required by spec): EU_WEST, EU_CENTRAL, US_EAST,
// US_WEST, UK, CANADA, AUSTRALIA, JAPAN, GLOBAL. GLOBAL is the explicit
// "no residency commitment" sentinel; any capture tagged GLOBAL is
// eligible for any target_region in enforceRegionPolicy.
// ---------------------------------------------------------------------------

export const REGIONS = Object.freeze({
  EU_WEST: Object.freeze({
    id: 'EU_WEST',
    display_name: 'European Union (West)',
    regulatory_framework: Object.freeze(['gdpr', 'eu_ai_act']),
    iso_3166_codes: Object.freeze(['IE', 'FR', 'BE', 'NL', 'LU', 'PT', 'ES', 'IT']),
  }),
  EU_CENTRAL: Object.freeze({
    id: 'EU_CENTRAL',
    display_name: 'European Union (Central)',
    regulatory_framework: Object.freeze(['gdpr', 'eu_ai_act']),
    iso_3166_codes: Object.freeze(['DE', 'AT', 'PL', 'CZ', 'SK', 'HU', 'SI', 'HR']),
  }),
  US_EAST: Object.freeze({
    id: 'US_EAST',
    display_name: 'United States (East)',
    regulatory_framework: Object.freeze(['ccpa', 'hipaa', 'sox', 'glba']),
    iso_3166_codes: Object.freeze(['US']),
  }),
  US_WEST: Object.freeze({
    id: 'US_WEST',
    display_name: 'United States (West)',
    regulatory_framework: Object.freeze(['ccpa', 'hipaa', 'sox', 'glba']),
    iso_3166_codes: Object.freeze(['US']),
  }),
  UK: Object.freeze({
    id: 'UK',
    display_name: 'United Kingdom',
    regulatory_framework: Object.freeze(['uk_gdpr', 'dpa_2018']),
    iso_3166_codes: Object.freeze(['GB']),
  }),
  CANADA: Object.freeze({
    id: 'CANADA',
    display_name: 'Canada',
    regulatory_framework: Object.freeze(['pipeda', 'phipa']),
    iso_3166_codes: Object.freeze(['CA']),
  }),
  AUSTRALIA: Object.freeze({
    id: 'AUSTRALIA',
    display_name: 'Australia',
    regulatory_framework: Object.freeze(['privacy_act_1988', 'consumer_data_right']),
    iso_3166_codes: Object.freeze(['AU']),
  }),
  JAPAN: Object.freeze({
    id: 'JAPAN',
    display_name: 'Japan',
    regulatory_framework: Object.freeze(['appi']),
    iso_3166_codes: Object.freeze(['JP']),
  }),
  GLOBAL: Object.freeze({
    id: 'GLOBAL',
    display_name: 'Global (no residency commitment)',
    regulatory_framework: Object.freeze([]),
    iso_3166_codes: Object.freeze([]),
  }),
});

// The default region is the explicit "we have not yet stamped a residency
// claim" sentinel. Honesty: never silently default to EU_WEST just because
// GDPR is the most-restrictive framework. The point of the default is to
// surface UNTAGGED data so a tenant can decide whether to backfill.
export const DEFAULT_REGION = Object.freeze('GLOBAL');

// Provider tag used for both per-capture residency rows and per-namespace
// configuration rows. Keeping them under the same provider lets a tenant
// query `listEvents({provider:'kolm_data_residency'})` and recover the full
// audit trail in one round trip.
const RESIDENCY_PROVIDER = 'kolm_data_residency';
const RESIDENCY_MODEL_TAG = 'capture-tag';
const RESIDENCY_MODEL_NS_DEFAULT = 'namespace-default-region';

// Internal - pick the event-store driver. opts.eventStore lets tests inject
// a fresh module instance (useful when KOLM_DATA_DIR was just rerolled).
function _eventStore(opts) {
  return (opts && opts.eventStore) || defaultEventStore;
}

// ---------------------------------------------------------------------------
// inferRegionFromTenant(tenant_record): pure JS lookup with honest fallback.
//
// Walks REGIONS.iso_3166_codes for each region in order, matching the
// tenant's country_code (case-insensitive). Returns the first match's id,
// or DEFAULT_REGION when nothing matches. Multiple regions can claim the
// same ISO code (US_EAST + US_WEST both list 'US') - the resolution order
// is the Object.keys() iteration order of REGIONS, which falls back to
// US_EAST first. Tenants that want US_WEST must explicitly opt in via
// configureNamespaceRegion or tagCapture.
//
// Honest fallback: when tenant_record is null/undefined/missing
// country_code, we return DEFAULT_REGION (GLOBAL) - never guess.
// ---------------------------------------------------------------------------
export function inferRegionFromTenant(tenant_record) {
  if (!tenant_record || typeof tenant_record !== 'object') return DEFAULT_REGION;
  const cc = tenant_record.country_code || tenant_record.country || null;
  if (!cc || typeof cc !== 'string') return DEFAULT_REGION;
  const norm = cc.trim().toUpperCase();
  if (norm.length !== 2) return DEFAULT_REGION;
  for (const id of Object.keys(REGIONS)) {
    if (id === 'GLOBAL') continue;
    const r = REGIONS[id];
    if (r.iso_3166_codes.includes(norm)) return id;
  }
  return DEFAULT_REGION;
}

function _validateRegion(region) {
  if (!region || typeof region !== 'string') {
    return { ok: false, error: 'region_required', hint: 'pass region as a string id (e.g. EU_WEST)' };
  }
  if (!Object.prototype.hasOwnProperty.call(REGIONS, region)) {
    return {
      ok: false,
      error: 'unknown_region',
      hint: 'valid regions: ' + Object.keys(REGIONS).join(', '),
      valid_regions: Object.keys(REGIONS),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// tagCapture({tenant_id, capture_id, region, confirm:true}): persists a
// residency tag for one capture. The tag is keyed by (tenant_id, capture_id)
// and the latest-write-wins rule of the event-store applies - calling
// tagCapture twice for the same (tenant, capture) replaces the prior tag.
//
// confirm:true REQUIRED. The flag matches the W765 / W764 confirm pattern:
// residency tags are an externally-visible compliance claim, so we refuse
// to write one without the caller acknowledging the durable side-effect.
//
// HONESTY: when the region is unknown, we return a structured envelope
// instead of silently coercing to GLOBAL. Silent coercion would let a
// caller think they tagged EU when in fact the tag was never persisted.
// ---------------------------------------------------------------------------
export async function tagCapture({
  tenant_id,
  capture_id,
  region,
  confirm = false,
  storeMod,
  eventStore,
} = {}) {
  void storeMod;
  if (!tenant_id) {
    return { ok: false, error: 'tenant_id_required', version: DATA_RESIDENCY_VERSION };
  }
  if (!capture_id || typeof capture_id !== 'string') {
    return { ok: false, error: 'capture_id_required', version: DATA_RESIDENCY_VERSION };
  }
  if (confirm !== true) {
    return {
      ok: false,
      error: 'confirm_required',
      hint: 'pass confirm:true to acknowledge the residency tag is durably persisted.',
      version: DATA_RESIDENCY_VERSION,
    };
  }
  const v = _validateRegion(region);
  if (!v.ok) return { ...v, version: DATA_RESIDENCY_VERSION };
  const es = _eventStore({ eventStore });
  const tagged_at = new Date().toISOString();
  // namespace: 'kolm.residency.<capture_id>' so listEvents queries can
  // narrow to the residency namespace per-capture. event_id is a stable
  // composite of (tenant, capture) so subsequent writes overwrite the
  // previous tag via the W411 last-write-wins dedupe.
  const ev = await es.appendEvent({
    event_id: 'w769_tag_' + tenant_id + '_' + capture_id,
    tenant_id,
    namespace: 'kolm.residency',
    provider: RESIDENCY_PROVIDER,
    model: RESIDENCY_MODEL_TAG,
    request_hash: capture_id,
    response_redacted: region,
    source_type: 'real',
    created_at: tagged_at,
  });
  return {
    ok: true,
    tenant_id,
    capture_id,
    region,
    tagged_at: ev.created_at,
    version: DATA_RESIDENCY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// getCaptureRegion({tenant_id, capture_id}): reads back a tag.
//
// TENANT FENCE: we pass tenant_id to listEvents AND filter again on the
// returned rows (W411 defense-in-depth). If the row's tenant_id does not
// match the caller's tenant_id, we exclude it even if the store driver
// somehow returned it.
//
// HONESTY: when no tag exists for the (tenant, capture) pair, we return
// {ok:false, error:'untagged'} with a hint to call /v1/residency/tag-capture
// - never silently return GLOBAL. The caller may interpret untagged as
// implicit GLOBAL but the API must surface the distinction.
// ---------------------------------------------------------------------------
export async function getCaptureRegion({
  tenant_id,
  capture_id,
  storeMod,
  eventStore,
} = {}) {
  void storeMod;
  if (!tenant_id) {
    return { ok: false, error: 'tenant_id_required', version: DATA_RESIDENCY_VERSION };
  }
  if (!capture_id || typeof capture_id !== 'string') {
    return { ok: false, error: 'capture_id_required', version: DATA_RESIDENCY_VERSION };
  }
  const es = _eventStore({ eventStore });
  const rows = await es.listEvents({
    tenant_id,
    namespace: 'kolm.residency',
    provider: RESIDENCY_PROVIDER,
    limit: 0,
  });
  // W411 defense-in-depth: per-row filter even though we already passed
  // tenant_id to the driver. If a driver bug dropped the WHERE clause we
  // still refuse to return foreign-tenant rows.
  const mine = rows.filter((r) =>
    r && r.tenant_id === tenant_id
      && r.provider === RESIDENCY_PROVIDER
      && r.model === RESIDENCY_MODEL_TAG
      && r.request_hash === capture_id
  );
  if (mine.length === 0) {
    return {
      ok: false,
      error: 'untagged',
      hint: 'call POST /v1/residency/tag-capture with {capture_id, region, confirm:true}',
      tenant_id,
      capture_id,
      version: DATA_RESIDENCY_VERSION,
    };
  }
  // listEvents returns newest-first by default, so mine[0] is the latest
  // tag for this capture_id.
  const latest = mine[0];
  return {
    ok: true,
    tenant_id,
    capture_id,
    region: latest.response_redacted,
    tagged_at: latest.created_at,
    version: DATA_RESIDENCY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// configureNamespaceRegion({tenant_id, namespace, region, confirm:true}):
// pins the default region for a namespace. Does NOT retroactively tag
// existing captures - only future captures inherit the new default via
// inferRegionFromTenant + namespace lookup. This is intentional: rewriting
// historical residency claims is itself a compliance event that needs a
// separate migration audit trail.
//
// confirm:true REQUIRED. Same rationale as tagCapture.
// ---------------------------------------------------------------------------
export async function configureNamespaceRegion({
  tenant_id,
  namespace,
  region,
  confirm = false,
  storeMod,
  eventStore,
} = {}) {
  void storeMod;
  if (!tenant_id) {
    return { ok: false, error: 'tenant_id_required', version: DATA_RESIDENCY_VERSION };
  }
  if (!namespace || typeof namespace !== 'string') {
    return { ok: false, error: 'namespace_required', version: DATA_RESIDENCY_VERSION };
  }
  if (confirm !== true) {
    return {
      ok: false,
      error: 'confirm_required',
      hint: 'pass confirm:true to acknowledge the default region is durably persisted.',
      version: DATA_RESIDENCY_VERSION,
    };
  }
  const v = _validateRegion(region);
  if (!v.ok) return { ...v, version: DATA_RESIDENCY_VERSION };
  const es = _eventStore({ eventStore });
  const ev = await es.appendEvent({
    event_id: 'w769_nsdef_' + tenant_id + '_' + namespace,
    tenant_id,
    namespace: 'kolm.residency',
    provider: RESIDENCY_PROVIDER,
    model: RESIDENCY_MODEL_NS_DEFAULT,
    request_hash: namespace,
    response_redacted: region,
    source_type: 'real',
  });
  return {
    ok: true,
    tenant_id,
    namespace,
    region,
    configured_at: ev.created_at,
    note: 'applies to FUTURE captures; existing captures keep their per-capture tag (or untagged status).',
    version: DATA_RESIDENCY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// getNamespaceDefaultRegion({tenant_id, namespace}): returns the configured
// default for a namespace, or DEFAULT_REGION when none has been set.
//
// Same tenant fence rules as getCaptureRegion (W411 defense-in-depth).
// ---------------------------------------------------------------------------
export async function getNamespaceDefaultRegion({
  tenant_id,
  namespace,
  storeMod,
  eventStore,
} = {}) {
  void storeMod;
  if (!tenant_id || !namespace) return DEFAULT_REGION;
  const es = _eventStore({ eventStore });
  const rows = await es.listEvents({
    tenant_id,
    namespace: 'kolm.residency',
    provider: RESIDENCY_PROVIDER,
    limit: 0,
  });
  const mine = rows.filter((r) =>
    r && r.tenant_id === tenant_id
      && r.provider === RESIDENCY_PROVIDER
      && r.model === RESIDENCY_MODEL_NS_DEFAULT
      && r.request_hash === namespace
  );
  if (mine.length === 0) return DEFAULT_REGION;
  return mine[0].response_redacted || DEFAULT_REGION;
}

// ---------------------------------------------------------------------------
// enforceRegionPolicy({tenant_id, capture, target_region}): returns
// {ok:true, allowed:boolean, reason}. The allow matrix:
//
//   * capture.region === target_region          → allowed (exact match)
//   * target_region === GLOBAL                  → allowed (GLOBAL accepts any)
//   * capture.region === GLOBAL                 → allowed (GLOBAL captures
//                                                 are eligible for any
//                                                 region-scoped pipeline)
//   * region mismatch                           → NOT allowed, with hint
//
// HONESTY: we NEVER silent-pass a mismatch. The {allowed:false} envelope
// carries reason='region_mismatch' plus a hint suggesting either
// re-tagging the capture (if mistagged) or flipping target_region to
// GLOBAL (if cross-region training is the explicit intent).
// ---------------------------------------------------------------------------
export function enforceRegionPolicy({ tenant_id, capture, target_region } = {}) {
  if (!tenant_id) {
    return { ok: false, error: 'tenant_id_required', version: DATA_RESIDENCY_VERSION };
  }
  if (!capture || typeof capture !== 'object') {
    return { ok: false, error: 'capture_required', version: DATA_RESIDENCY_VERSION };
  }
  const tv = _validateRegion(target_region);
  if (!tv.ok) return { ...tv, version: DATA_RESIDENCY_VERSION };
  const captureRegion = capture.region || DEFAULT_REGION;
  // W411 defense-in-depth: if the capture carries a tenant_id, it must
  // match the caller's tenant_id. A cross-tenant enforcement query is a
  // misuse pattern and we refuse it loudly.
  if (capture.tenant_id && capture.tenant_id !== tenant_id) {
    return {
      ok: false,
      error: 'tenant_mismatch',
      hint: 'capture belongs to a different tenant; enforceRegionPolicy refuses cross-tenant queries.',
      version: DATA_RESIDENCY_VERSION,
    };
  }
  // Exact match - always allowed.
  if (captureRegion === target_region) {
    return {
      ok: true,
      allowed: true,
      reason: 'exact_region_match',
      capture_region: captureRegion,
      target_region,
      version: DATA_RESIDENCY_VERSION,
    };
  }
  // GLOBAL target accepts any capture region (the "no residency
  // commitment" target).
  if (target_region === 'GLOBAL') {
    return {
      ok: true,
      allowed: true,
      reason: 'target_is_global',
      capture_region: captureRegion,
      target_region,
      version: DATA_RESIDENCY_VERSION,
    };
  }
  // GLOBAL capture is eligible for any region-scoped pipeline (the
  // capture has not pinned a region so it inherits the target).
  if (captureRegion === 'GLOBAL') {
    return {
      ok: true,
      allowed: true,
      reason: 'capture_is_global',
      capture_region: captureRegion,
      target_region,
      version: DATA_RESIDENCY_VERSION,
    };
  }
  // Region mismatch - fail-closed with hint.
  return {
    ok: true,
    allowed: false,
    reason: 'region_mismatch',
    capture_region: captureRegion,
    target_region,
    hint: 're-tag the capture via /v1/residency/tag-capture, or flip target_region to GLOBAL to opt out of region enforcement.',
    version: DATA_RESIDENCY_VERSION,
  };
}
