// W737 - marketplace artifact listing store (in-memory + event-store backed).
//
// W737-1 ("Browse by vertical, task type, K-Score, hardware target") needs a
// catalog that publishers can register into. The W342/W263 marketplace.js
// already ships a curated SEED catalog (the canonical kolm.ai-published .kolm
// files under public/registry-pack/), but third-party publishers cannot
// register their own artifacts there. This module is the honest scaffold for
// that gap: a registration surface that persists via the existing event-store
// (provider='kolm_marketplace_listing') so survives process restarts on a
// host that mounts ~/.kolm.
//
// Honesty contract:
//   - When no listings exist yet, listArtifactsForBrowse() returns an empty
//     array (NOT a 500). The handler wraps this into the W737 honest envelope
//     {ok:false, error:'marketplace_empty', hint:'no artifacts registered yet'}
//     when results are zero.
//   - Tenant-fenced reads: every listing carries publisher_id which doubles as
//     tenant_id; reads accept an optional {tenant_id} filter for owner-only
//     views (eg. "my listings"). Public browse is read-only metadata, not
//     tenant-scoped.
//   - Pure functions where possible; the only side effect is the appendEvent
//     persistence on registerArtifact.
//
// Design rules (W604 anti-brittleness):
//   - Hard-coded valid set checks: vertical, task_type, hardware_target are
//     enumerated against the W737 spec set so a fat-fingered field fails loud
//     at registration time, not at search time.
//   - In-process cache is rebuilt lazily from event-store rows on first read
//     after a _resetForTests(). This keeps tests using the freshDir() pattern
//     deterministic without leaking rows across test files.

import { appendEvent, listEvents } from './event-store.js';

export const MARKETPLACE_STORE_VERSION = 'w737-store-v1';

// W737-1 spec - the four facet axes.
export const W737_VERTICALS = Object.freeze([
  'medical', 'legal', 'code', 'finance', 'support', 'general',
]);

export const W737_TASK_TYPES = Object.freeze([
  'extraction', 'generation', 'reasoning', 'support',
]);

export const W737_HARDWARE_TARGETS = Object.freeze([
  'm-series', 'rtx', 'h100', 'cpu',
]);

// Internal cache. _resetForTests() clears it and the event-store
// _resetForTests() clears the underlying rows; both must be called by tests
// that need a fresh slate.
let _cache = null;

export function _resetForTests() {
  _cache = null;
}

// _loadCache(): lazy rebuild from event-store rows. We funnel every read
// through this so the on-disk JSONL/sqlite is the source of truth even after
// the process restarts. Returns Array<listing>.
//
// Trap: the event-schema `feedback` field is coerced to a STRING (max 4096
// chars) by canonicalize() in src/event-schema.js - passing an object would
// land as "[object Object]" on disk. We stringify JSON on write and parse on
// read so the listing payload roundtrips cleanly.
async function _loadCache() {
  if (_cache !== null) return _cache;
  const rows = await listEvents({ provider: 'kolm_marketplace_listing', limit: 0 });
  const byCid = new Map();
  for (const ev of rows) {
    if (!ev || typeof ev.feedback !== 'string') continue;
    let payload = null;
    try { payload = JSON.parse(ev.feedback); } catch { continue; }
    if (!payload || !payload.cid) continue;
    byCid.set(payload.cid, payload);
  }
  _cache = Array.from(byCid.values());
  return _cache;
}

// registerArtifact({cid, publisher_id, manifest, hardware_target, vertical,
//                   task_type, price_micro_usd_per_call})
//
// Validates the listing fields against the W737 enum sets, then persists via
// appendEvent so the row survives a restart. The cache is invalidated so the
// next listArtifactsForBrowse() pulls a fresh view.
//
// Throws on validation failure with err.code = 'LISTING_INVALID' so the
// handler can map to HTTP 400.
export async function registerArtifact(opts = {}) {
  const cid = String(opts.cid || '').trim();
  const publisher_id = String(opts.publisher_id || '').trim();
  const vertical = String(opts.vertical || '').toLowerCase().trim();
  const task_type = String(opts.task_type || '').toLowerCase().trim();
  const hardware_target = String(opts.hardware_target || '').toLowerCase().trim();
  const manifest = opts.manifest && typeof opts.manifest === 'object' ? opts.manifest : {};
  // Price normalised to integer micro-USD. Default 0 = free listing.
  const price_micro_usd_per_call = Number.isFinite(Number(opts.price_micro_usd_per_call))
    ? Math.max(0, Math.trunc(Number(opts.price_micro_usd_per_call))) : 0;

  if (!cid || cid.length < 8) {
    const e = new Error('cid required (>=8 chars)'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!publisher_id) {
    const e = new Error('publisher_id required'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!W737_VERTICALS.includes(vertical)) {
    const e = new Error('vertical must be one of: ' + W737_VERTICALS.join(',')); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!W737_TASK_TYPES.includes(task_type)) {
    const e = new Error('task_type must be one of: ' + W737_TASK_TYPES.join(',')); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!W737_HARDWARE_TARGETS.includes(hardware_target)) {
    const e = new Error('hardware_target must be one of: ' + W737_HARDWARE_TARGETS.join(',')); e.code = 'LISTING_INVALID'; throw e;
  }

  // K-Score is read from manifest if present; honest null otherwise.
  const k_score = manifest && typeof manifest.k_score === 'number'
    ? Math.max(0, Math.min(1, manifest.k_score))
    : (manifest && manifest.k_score && typeof manifest.k_score.composite === 'number'
      ? Math.max(0, Math.min(1, manifest.k_score.composite))
      : null);
  const name = String((manifest && manifest.name) || cid.slice(0, 24));

  const listing = {
    cid,
    publisher_id,
    name,
    vertical,
    task_type,
    hardware_target,
    k_score,
    price_micro_usd_per_call,
    manifest,
    registered_at: new Date().toISOString(),
    store_version: MARKETPLACE_STORE_VERSION,
  };

  await appendEvent({
    tenant_id: publisher_id,
    namespace: 'kolm_marketplace',
    provider: 'kolm_marketplace_listing',
    status: 'ok',
    // canonicalize() coerces feedback to a string (max 4096) - JSON.stringify
    // the payload so it roundtrips. _loadCache() JSON.parse on read.
    feedback: JSON.stringify(listing),
  });
  // Invalidate so the next read pulls this row back from the store.
  _cache = null;
  return listing;
}

// listArtifactsForBrowse({vertical, task_type, min_kscore, hardware_target,
//                         publisher_id, limit=20, offset=0})
//
// Returns the filtered listing array. Honest empty when no listings exist - 
// callers wrap into the W737 envelope.
export async function listArtifactsForBrowse(filter = {}) {
  const all = await _loadCache();
  const vertical = filter.vertical ? String(filter.vertical).toLowerCase() : null;
  const task_type = filter.task_type ? String(filter.task_type).toLowerCase() : null;
  const hardware_target = filter.hardware_target ? String(filter.hardware_target).toLowerCase() : null;
  const publisher_id = filter.publisher_id ? String(filter.publisher_id) : null;
  const min_kscore = Number.isFinite(Number(filter.min_kscore)) ? Number(filter.min_kscore) : null;
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(filter.limit)) || 20));
  const offset = Math.max(0, Math.trunc(Number(filter.offset)) || 0);

  const filtered = all.filter((row) => {
    if (vertical && row.vertical !== vertical) return false;
    if (task_type && row.task_type !== task_type) return false;
    if (hardware_target && row.hardware_target !== hardware_target) return false;
    if (publisher_id && row.publisher_id !== publisher_id) return false;
    if (min_kscore != null && (row.k_score == null || row.k_score < min_kscore)) return false;
    return true;
  });
  return {
    total: filtered.length,
    rows: filtered.slice(offset, offset + limit),
    all_count: all.length,
  };
}

// getListingByCid(cid): convenience reader, returns the one listing or null.
// Used by the review submission path to confirm the artifact exists before
// accepting a review.
export async function getListingByCid(cid) {
  if (!cid) return null;
  const all = await _loadCache();
  return all.find((r) => r.cid === cid) || null;
}
