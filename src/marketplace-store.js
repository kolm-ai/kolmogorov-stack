// W737 - marketplace artifact listing store (in-memory + event-store backed).
//
// This is the source-of-truth store for third-party W737 marketplace listings.
// The event-store `feedback` column is only 4096 chars, so every listing is
// deliberately bounded before append and re-verified on read. The public row
// carries hash receipts for the sanitized manifest and listing body so a local
// store edit cannot silently rewrite price, owner, or metadata.

import crypto from 'node:crypto';
import { appendEvent, listEvents } from './event-store.js';

export const MARKETPLACE_STORE_VERSION = 'w737-store-v2';
export const MARKETPLACE_LISTING_PROVIDER = 'kolm_marketplace_listing';
export const MARKETPLACE_LISTING_NAMESPACE = 'kolm_marketplace';

export const MARKETPLACE_STORE_LIMITS = Object.freeze({
  MAX_EVENT_ROWS: 10_000,
  MAX_FEEDBACK_CHARS: 4096,
  MAX_MANIFEST_CANONICAL_CHARS: 2048,
  MAX_MANIFEST_DEPTH: 5,
  MAX_MANIFEST_KEYS: 64,
  MAX_MANIFEST_ARRAY: 32,
  MAX_MANIFEST_STRING_CHARS: 512,
  MAX_CID_CHARS: 160,
  MAX_PUBLISHER_ID_CHARS: 128,
  MAX_NAME_CHARS: 160,
  MAX_PRICE_MICRO_USD_PER_CALL: 10_000_000_000,
  MAX_PAGE_LIMIT: 200,
});

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

const DANGEROUS_MANIFEST_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|private[_-]?key|credential)/i;

// Internal cache. _resetForTests() clears it and the event-store
// _resetForTests() clears the underlying rows; both must be called by tests
// that need a fresh slate.
let _cache = null;

export function _resetForTests() {
  _cache = null;
}

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function _stableJson(value) {
  const sortRecursive = (v) => {
    if (Array.isArray(v)) return v.map(sortRecursive);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = sortRecursive(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortRecursive(value));
}

function _listingError(message, code = 'LISTING_INVALID') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function _cleanText(value, max = 512) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

function _isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _cleanManifestValue(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return _cleanText(value, MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    if (depth >= MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_DEPTH) return [];
    return value
      .slice(0, MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_ARRAY)
      .map((item) => _cleanManifestValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (_isPlainObject(value)) {
    if (depth >= MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_DEPTH) return {};
    const out = {};
    const keys = Object.keys(value).sort().slice(0, MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_KEYS);
    for (const rawKey of keys) {
      const key = _cleanText(rawKey, 96);
      if (!key || DANGEROUS_MANIFEST_KEYS.has(key) || SECRET_KEY_RE.test(key)) continue;
      if (!/^[A-Za-z0-9_.:-]+$/.test(key)) continue;
      const cleaned = _cleanManifestValue(value[rawKey], depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return null;
}

function _sanitizeManifest(input) {
  const manifest = _cleanManifestValue(_isPlainObject(input) ? input : {}, 0) || {};
  const canonical = _stableJson(manifest);
  if (canonical.length > MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_CANONICAL_CHARS) {
    throw _listingError(
      `manifest public JSON must be <=${MARKETPLACE_STORE_LIMITS.MAX_MANIFEST_CANONICAL_CHARS} chars after sanitization`,
    );
  }
  return {
    manifest,
    manifest_canonical: canonical,
    manifest_sha256: _sha256Hex(canonical),
    manifest_bytes: canonical.length,
  };
}

function _normalizeCid(raw) {
  const cid = _cleanText(raw, MARKETPLACE_STORE_LIMITS.MAX_CID_CHARS);
  if (!cid || cid.length < 8) throw _listingError('cid required (>=8 chars)');
  if (/[\\/]/.test(cid) || cid.includes('..')) {
    throw _listingError('cid must not contain path traversal or path separators');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(cid)) {
    throw _listingError('cid contains unsupported characters');
  }
  return cid;
}

function _normalizePublisherId(raw) {
  const publisherId = _cleanText(raw, MARKETPLACE_STORE_LIMITS.MAX_PUBLISHER_ID_CHARS);
  if (!publisherId) throw _listingError('publisher_id required');
  if (!/^[A-Za-z0-9._:@-]+$/.test(publisherId)) {
    throw _listingError('publisher_id contains unsupported characters');
  }
  return publisherId;
}

function _normalizeEnum(raw, allowed, field) {
  const value = _cleanText(raw, 64).toLowerCase();
  if (!allowed.includes(value)) {
    throw _listingError(`${field} must be one of: ${allowed.join(',')}`);
  }
  return value;
}

function _normalizePrice(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw _listingError('price_micro_usd_per_call must be a non-negative finite number');
  }
  const price = Math.trunc(n);
  if (price > MARKETPLACE_STORE_LIMITS.MAX_PRICE_MICRO_USD_PER_CALL) {
    throw _listingError(
      `price_micro_usd_per_call must be <=${MARKETPLACE_STORE_LIMITS.MAX_PRICE_MICRO_USD_PER_CALL}`,
    );
  }
  return price;
}

function _extractKScore(manifest) {
  if (manifest && typeof manifest.k_score === 'number') {
    return Math.max(0, Math.min(1, manifest.k_score));
  }
  if (manifest && manifest.k_score && typeof manifest.k_score.composite === 'number') {
    return Math.max(0, Math.min(1, manifest.k_score.composite));
  }
  return null;
}

function _listingBodyForHash(listing, manifestSha256) {
  return {
    cid: listing.cid,
    publisher_id: listing.publisher_id,
    name: listing.name,
    vertical: listing.vertical,
    task_type: listing.task_type,
    hardware_target: listing.hardware_target,
    k_score: listing.k_score,
    price_micro_usd_per_call: listing.price_micro_usd_per_call,
    manifest_sha256: manifestSha256,
  };
}

function _receiptBodyForHash(listing, listingBodySha256) {
  return {
    listing_id: listing.listing_id,
    cid: listing.cid,
    publisher_id: listing.publisher_id,
    listing_body_sha256: listingBodySha256,
    previous_listing_sha256: listing.previous_listing_sha256 || null,
    revision: listing.revision,
    registered_at: listing.registered_at,
    store_version: listing.store_version,
  };
}

function _computeListingHashes(listing) {
  const manifestCanonical = _stableJson(listing.manifest || {});
  const manifestSha256 = _sha256Hex(manifestCanonical);
  const listingBodySha256 = _sha256Hex(_stableJson(_listingBodyForHash(listing, manifestSha256)));
  const listingReceiptSha256 = _sha256Hex(_stableJson(_receiptBodyForHash(listing, listingBodySha256)));
  return {
    manifest_canonical: manifestCanonical,
    manifest_sha256: manifestSha256,
    manifest_bytes: manifestCanonical.length,
    listing_body_sha256: listingBodySha256,
    listing_receipt_sha256: listingReceiptSha256,
  };
}

function _normalizeLoadedListing(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let manifestInfo;
  let cid;
  let publisherId;
  let vertical;
  let taskType;
  let hardwareTarget;
  let price;
  try {
    cid = _normalizeCid(payload.cid);
    publisherId = _normalizePublisherId(payload.publisher_id);
    vertical = _normalizeEnum(payload.vertical, W737_VERTICALS, 'vertical');
    taskType = _normalizeEnum(payload.task_type, W737_TASK_TYPES, 'task_type');
    hardwareTarget = _normalizeEnum(payload.hardware_target, W737_HARDWARE_TARGETS, 'hardware_target');
    price = _normalizePrice(payload.price_micro_usd_per_call);
    manifestInfo = _sanitizeManifest(_isPlainObject(payload.manifest) ? payload.manifest : {});
  } catch {
    return null;
  }

  const listing = {
    cid,
    publisher_id: publisherId,
    listing_id: _cleanText(payload.listing_id, 96)
      || 'lst_' + _sha256Hex(`${publisherId}:${cid}`).slice(0, 24),
    name: _cleanText(payload.name || manifestInfo.manifest.name || cid.slice(0, 24), MARKETPLACE_STORE_LIMITS.MAX_NAME_CHARS)
      || cid.slice(0, 24),
    vertical,
    task_type: taskType,
    hardware_target: hardwareTarget,
    k_score: _extractKScore(manifestInfo.manifest),
    price_micro_usd_per_call: price,
    manifest: manifestInfo.manifest,
    manifest_sha256: manifestInfo.manifest_sha256,
    manifest_bytes: manifestInfo.manifest_bytes,
    previous_listing_sha256: payload.previous_listing_sha256 || null,
    revision: Math.max(1, Math.trunc(Number(payload.revision) || 1)),
    registered_at: _cleanText(payload.registered_at, 64) || new Date(0).toISOString(),
    store_version: payload.store_version || 'legacy',
  };
  const hashes = _computeListingHashes(listing);
  listing.manifest_sha256 = hashes.manifest_sha256;
  listing.manifest_bytes = hashes.manifest_bytes;
  listing.listing_body_sha256 = hashes.listing_body_sha256;
  listing.listing_receipt_sha256 = hashes.listing_receipt_sha256;
  listing.integrity_status = 'legacy_unhashed';

  if (payload.store_version === MARKETPLACE_STORE_VERSION) {
    if (payload.manifest_sha256 !== hashes.manifest_sha256) return null;
    if (payload.listing_body_sha256 !== hashes.listing_body_sha256) return null;
    if (payload.listing_receipt_sha256 !== hashes.listing_receipt_sha256) return null;
    listing.integrity_status = 'hash_verified';
  }
  return listing;
}

// _loadCache(): lazy rebuild from event-store rows. We funnel every read
// through this so the on-disk JSONL/sqlite is the source of truth even after
// process restart. Newest rows are read first, then replayed chronologically so
// receipt chains and last-write-wins updates stay deterministic.
async function _loadCache() {
  if (_cache !== null) return _cache;
  const newest = await listEvents({
    provider: MARKETPLACE_LISTING_PROVIDER,
    limit: MARKETPLACE_STORE_LIMITS.MAX_EVENT_ROWS,
    order: 'desc',
  });
  const rows = newest.slice().reverse();
  const byCid = new Map();
  for (const ev of rows) {
    if (!ev || typeof ev.feedback !== 'string') continue;
    let payload = null;
    try { payload = JSON.parse(ev.feedback); } catch { continue; }
    const listing = _normalizeLoadedListing(payload);
    if (!listing) continue;

    const existing = byCid.get(listing.cid);
    if (existing && existing.publisher_id !== listing.publisher_id) {
      continue;
    }
    if (
      existing
      && listing.store_version === MARKETPLACE_STORE_VERSION
      && listing.previous_listing_sha256 !== existing.listing_body_sha256
    ) {
      continue;
    }
    byCid.set(listing.cid, listing);
  }
  _cache = Array.from(byCid.values());
  return _cache;
}

// registerArtifact({cid, publisher_id, manifest, hardware_target, vertical,
//                   task_type, price_micro_usd_per_call})
//
// Validates the listing fields against the W737 enum sets, persists via
// appendEvent, and returns the hash-receipted listing. Duplicate CIDs are
// idempotent for the same publisher+body and rejected for different publishers
// so one seller cannot take over another seller's artifact slot.
export async function registerArtifact(opts = {}) {
  const cid = _normalizeCid(opts.cid);
  const publisher_id = _normalizePublisherId(opts.publisher_id);
  const vertical = _normalizeEnum(opts.vertical, W737_VERTICALS, 'vertical');
  const task_type = _normalizeEnum(opts.task_type, W737_TASK_TYPES, 'task_type');
  const hardware_target = _normalizeEnum(opts.hardware_target, W737_HARDWARE_TARGETS, 'hardware_target');
  const price_micro_usd_per_call = _normalizePrice(opts.price_micro_usd_per_call);
  const manifestInfo = _sanitizeManifest(opts.manifest && typeof opts.manifest === 'object' ? opts.manifest : {});
  const name = _cleanText(manifestInfo.manifest.name || cid.slice(0, 24), MARKETPLACE_STORE_LIMITS.MAX_NAME_CHARS)
    || cid.slice(0, 24);
  const existing = await getListingByCid(cid);
  if (existing && existing.publisher_id !== publisher_id) {
    throw _listingError('cid already registered by another publisher', 'LISTING_CONFLICT');
  }

  const baseListing = {
    cid,
    publisher_id,
    listing_id: 'lst_' + _sha256Hex(`${publisher_id}:${cid}`).slice(0, 24),
    name,
    vertical,
    task_type,
    hardware_target,
    k_score: _extractKScore(manifestInfo.manifest),
    price_micro_usd_per_call,
    manifest: manifestInfo.manifest,
    manifest_sha256: manifestInfo.manifest_sha256,
    manifest_bytes: manifestInfo.manifest_bytes,
    previous_listing_sha256: existing ? existing.listing_body_sha256 : null,
    revision: existing ? (Math.trunc(Number(existing.revision) || 1) + 1) : 1,
    registered_at: new Date().toISOString(),
    store_version: MARKETPLACE_STORE_VERSION,
  };
  const hashes = _computeListingHashes(baseListing);
  const listing = {
    ...baseListing,
    manifest_sha256: hashes.manifest_sha256,
    manifest_bytes: hashes.manifest_bytes,
    listing_body_sha256: hashes.listing_body_sha256,
    listing_receipt_sha256: hashes.listing_receipt_sha256,
    integrity_status: 'hash_verified',
  };

  if (existing && existing.listing_body_sha256 === listing.listing_body_sha256) {
    return { ...existing, idempotent_replay: true };
  }

  const feedback = JSON.stringify(listing);
  if (feedback.length > MARKETPLACE_STORE_LIMITS.MAX_FEEDBACK_CHARS) {
    throw _listingError(
      `listing feedback must be <=${MARKETPLACE_STORE_LIMITS.MAX_FEEDBACK_CHARS} chars after sanitization`,
    );
  }

  await appendEvent({
    event_id: 'mkt_' + listing.listing_receipt_sha256.slice(0, 32),
    tenant_id: publisher_id,
    namespace: MARKETPLACE_LISTING_NAMESPACE,
    provider: MARKETPLACE_LISTING_PROVIDER,
    model: MARKETPLACE_STORE_VERSION,
    status: 'ok',
    request_hash: listing.listing_body_sha256,
    response_hash: listing.listing_receipt_sha256,
    feedback,
  });
  // Invalidate so the next read pulls this row back from the store.
  _cache = null;
  return listing;
}

// listArtifactsForBrowse({vertical, task_type, min_kscore, hardware_target,
//                         publisher_id|tenant_id, limit=20, offset=0})
//
// Returns the filtered listing array. Honest empty when no listings exist -
// callers wrap into the W737 envelope.
export async function listArtifactsForBrowse(filter = {}) {
  const all = await _loadCache();
  const vertical = filter.vertical ? String(filter.vertical).toLowerCase() : null;
  const task_type = filter.task_type ? String(filter.task_type).toLowerCase() : null;
  const hardware_target = filter.hardware_target ? String(filter.hardware_target).toLowerCase() : null;
  const publisher_id = filter.publisher_id || filter.tenant_id ? String(filter.publisher_id || filter.tenant_id) : null;
  const min_kscore = Number.isFinite(Number(filter.min_kscore)) ? Number(filter.min_kscore) : null;
  const limit = Math.max(1, Math.min(
    MARKETPLACE_STORE_LIMITS.MAX_PAGE_LIMIT,
    Math.trunc(Number(filter.limit)) || 20,
  ));
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
    version: MARKETPLACE_STORE_VERSION,
    integrity: {
      hashed: all.filter((row) => row.integrity_status === 'hash_verified').length,
      legacy_unhashed: all.filter((row) => row.integrity_status === 'legacy_unhashed').length,
    },
  };
}

// getListingByCid(cid): convenience reader, returns the one listing or null.
// Used by the review submission path to confirm the artifact exists before
// accepting a review.
export async function getListingByCid(cid) {
  if (!cid) return null;
  const normalized = _cleanText(cid, MARKETPLACE_STORE_LIMITS.MAX_CID_CHARS);
  const all = await _loadCache();
  return all.find((r) => r.cid === normalized) || null;
}
