// src/region-aware-sampler.js
//
// W769-3 - Region-aware distillation sampler.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 609-614):
//   [W769-3] Region-aware distillation (only captures from target region)
//
// Design contract:
//   - PURE filter. NEVER throws on bad input. Heavy distillation logic stays
//     OUT of this module - its only job is to narrow a candidate pool to the
//     captures whose residency tag matches a target region.
//   - HONESTY FLOOR: filterCapturesByRegion is FAIL-CLOSED. An untagged
//     capture is EXCLUDED from any non-GLOBAL target, never silently
//     included with an "assumed GLOBAL" interpretation. The only way to
//     include an untagged capture is to set target_region=GLOBAL, which
//     opts out of region enforcement explicitly.
//   - TENANT FENCE (W411 law): sampleForDistillation passes tenant_id
//     to listEvents AND filters again per-row before invoking the
//     downstream sampling step.
//   - Distillation rank: not opinionated here. The sampler returns the
//     filtered subset in newest-first order so a downstream curriculum
//     module (W720+) can apply its own ranking - region filter is the
//     hard residency gate, not a quality signal.
//
// Public surface:
//   - REGION_SAMPLER_VERSION
//   - filterCapturesByRegion(captures, target_region)
//   - sampleForDistillation({tenant_id, namespace, target_region,
//                            max_n, storeMod, eventStore})

import { DEFAULT_REGION, REGIONS } from './data-residency.js';
import * as defaultEventStore from './event-store.js';

export const REGION_SAMPLER_VERSION = 'w769-v1';
export const REGION_SAMPLER_LIMITS = Object.freeze({
  max_scan_rows: 50000,
  max_sample_rows: 10000,
  max_namespace_chars: 128,
  max_id_chars: 160,
});

// Internal - pick the event-store driver. opts.eventStore lets tests inject
// a fresh module instance (useful when KOLM_DATA_DIR was just rerolled).
function _eventStore(opts) {
  return (opts && opts.eventStore) || defaultEventStore;
}

function _safeNamespace(value) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, REGION_SAMPLER_LIMITS.max_namespace_chars);
  if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') return null;
  return s;
}

function _safeId(value) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, REGION_SAMPLER_LIMITS.max_id_chars);
  if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') return null;
  return s;
}

function _validRegionTag(value) {
  if (!value || typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(REGIONS, value) ? value : null;
}

// ---------------------------------------------------------------------------
// filterCapturesByRegion(captures, target_region): pure subset filter.
//
// Truth table:
//
//   capture.region            target_region          included?
//   ─────────────────────────────────────────────────────────
//   missing/null              GLOBAL                 YES
//   missing/null              EU_WEST (any non-GLOBAL) NO   ← fail-closed
//   GLOBAL                    EU_WEST                YES   (GLOBAL captures
//                                                         are eligible for
//                                                         any region pipeline)
//   EU_WEST                   EU_WEST                YES
//   EU_WEST                   US_EAST                NO
//   EU_WEST                   GLOBAL                 YES
//
// HONESTY: the fail-closed rule for untagged-captures-into-non-GLOBAL is
// the load-bearing safety property. A naïve "if no tag assume GLOBAL"
// would let an untagged EU capture slip into a US-only distillation run
// because the assumption silently flipped the residency claim. We refuse
// to silent-include.
// ---------------------------------------------------------------------------
export function filterCapturesByRegion(captures, target_region) {
  if (!Array.isArray(captures)) return [];
  if (!target_region || typeof target_region !== 'string') {
    // Bad target - fail-closed (return empty).
    return [];
  }
  if (!Object.prototype.hasOwnProperty.call(REGIONS, target_region)) {
    // Unknown target - fail-closed (return empty). Callers SHOULD validate
    // upstream; we double-check here as the honesty floor.
    return [];
  }
  const out = [];
  for (const c of captures) {
    if (!c || typeof c !== 'object') continue;
    const tag = _validRegionTag(c.region);
    if (target_region === 'GLOBAL') {
      // GLOBAL target accepts every capture (tagged or untagged).
      out.push(c);
      continue;
    }
    if (!tag) {
      // Untagged capture into a non-GLOBAL target - FAIL-CLOSED, excluded.
      continue;
    }
    if (tag === target_region) {
      out.push(c);
      continue;
    }
    if (tag === 'GLOBAL') {
      // GLOBAL captures opt in to any region pipeline.
      out.push(c);
      continue;
    }
    // Region mismatch (e.g. tag=EU_WEST, target=US_EAST) - excluded.
  }
  return out;
}

// ---------------------------------------------------------------------------
// sampleForDistillation({tenant_id, namespace, target_region, max_n,
//                        storeMod, eventStore}): full pipeline.
//
// Steps:
//   1. Pull candidate captures from event-store (tenant-fenced + namespace).
//   2. Join in residency tags (provider='kolm_data_residency') by
//      capture_id (we use request_hash as the capture_id pointer to match
//      how src/data-residency.js writes the tag rows).
//   3. Filter via filterCapturesByRegion against target_region.
//   4. Trim to max_n (default 100; max 10000 to protect server memory).
//
// HONESTY: when no captures match the region filter we return a
// structured envelope {ok:false, error:'no_captures_in_region', hint:...}
// instead of an empty samples list. Empty samples + ok:true would let a
// caller think the distillation pool was simply empty rather than
// region-filtered to zero.
// ---------------------------------------------------------------------------
export async function sampleForDistillation({
  tenant_id,
  namespace = null,
  target_region,
  max_n = 100,
  storeMod,
  eventStore,
} = {}) {
  void storeMod;
  if (!tenant_id) {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: REGION_SAMPLER_VERSION,
    };
  }
  if (!target_region || !Object.prototype.hasOwnProperty.call(REGIONS, target_region)) {
    return {
      ok: false,
      error: 'unknown_region',
      hint: 'pass a region from REGIONS taxonomy (e.g. EU_WEST, US_EAST, GLOBAL).',
      valid_regions: Object.keys(REGIONS),
      version: REGION_SAMPLER_VERSION,
    };
  }
  const tenant = _safeId(tenant_id);
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: REGION_SAMPLER_VERSION,
    };
  }
  const ns = namespace == null ? null : _safeNamespace(namespace);
  if (namespace != null && !ns) {
    return {
      ok: false,
      error: 'bad_namespace',
      version: REGION_SAMPLER_VERSION,
    };
  }
  const limit = Math.max(1, Math.min(REGION_SAMPLER_LIMITS.max_sample_rows, Math.trunc(Number(max_n)) || 100));

  const es = _eventStore({ eventStore });

  // Pull candidate captures from this tenant + (optionally) namespace. We
  // exclude the residency-tag rows themselves by skipping namespace
  // 'kolm.residency' below.
  const captureQuery = { tenant_id: tenant, limit: REGION_SAMPLER_LIMITS.max_scan_rows };
  if (ns) captureQuery.namespace = ns;
  let allRows = [];
  try {
    allRows = await es.listEvents(captureQuery);
  } catch (_) {
    allRows = [];
  }
  allRows = (Array.isArray(allRows) ? allRows : []).slice(0, REGION_SAMPLER_LIMITS.max_scan_rows);
  // W411 defense-in-depth tenant fence.
  const tenantRows = allRows.filter((r) => r && r.tenant_id === tenant);
  const candidateCaptures = tenantRows.filter((r) =>
    r && r.namespace !== 'kolm.residency'
      && r.provider !== 'kolm_data_residency'
  );

  // Pull residency tags for this tenant + (optionally) the same namespace
  // scope. We index by request_hash (which is the capture_id pointer the
  // tagCapture writer used).
  let tagRows = [];
  try {
    tagRows = await es.listEvents({
      tenant_id: tenant,
      namespace: 'kolm.residency',
      provider: 'kolm_data_residency',
      limit: REGION_SAMPLER_LIMITS.max_scan_rows,
    });
  } catch (_) {
    tagRows = [];
  }
  tagRows = (Array.isArray(tagRows) ? tagRows : []).slice(0, REGION_SAMPLER_LIMITS.max_scan_rows);
  const tenantTags = tagRows.filter((r) => r && r.tenant_id === tenant);
  const tagByCapture = new Map();
  for (const t of tenantTags) {
    if (!t || t.model !== 'capture-tag') continue;
    const cid = _safeId(t.request_hash);
    const tag = _validRegionTag(t.response_redacted);
    if (!cid || !tag) continue;
    // listEvents returns newest-first - first write wins so we keep
    // the latest tag.
    if (!tagByCapture.has(cid)) {
      tagByCapture.set(cid, tag);
    }
  }

  // Build the joined capture list with .region populated from the tag
  // index. Captures without a tag carry region:null which the
  // filterCapturesByRegion fail-closed rule will exclude unless
  // target_region===GLOBAL.
  const joined = candidateCaptures.map((c) => ({
    capture_id: _safeId(c.event_id),
    namespace: _safeNamespace(c.namespace) || 'default',
    created_at: c.created_at,
    region: tagByCapture.get(_safeId(c.event_id)) || null,
    tenant_id: tenant,
  })).filter((c) => c.capture_id);

  const filtered = filterCapturesByRegion(joined, target_region);

  if (filtered.length === 0) {
    return {
      ok: false,
      error: 'no_captures_in_region',
      hint: 'either tag captures via /v1/residency/tag-capture, or pick target_region=GLOBAL to opt out of region enforcement (which will include untagged captures).',
      target_region,
      count_total: joined.length,
      count_after_region_filter: 0,
      count_after_sampling: 0,
      version: REGION_SAMPLER_VERSION,
    };
  }

  const sampled = filtered.slice(0, limit);

  return {
    ok: true,
    target_region,
    count_total: joined.length,
    count_after_region_filter: filtered.length,
    count_after_sampling: sampled.length,
    samples: sampled.map((s) => s.capture_id),
    version: REGION_SAMPLER_VERSION,
    default_region: DEFAULT_REGION,
  };
}
