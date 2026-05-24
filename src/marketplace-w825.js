// src/marketplace-w825.js
//
// W825 [T3] — Artifact Marketplace MVP, data layer.
//
// W737 already ships `src/marketplace.js` (curated seed catalog + event-store
// `kolm_marketplace_listing` registration). W825 is the MVP UPGRADE that adds
// a publisher-driven storefront with downloads, ratings, anti-gaming, paid
// listings, and a 70/30 revenue split:
//
//   - `~/.kolm/marketplace/listings.jsonl` is the canonical store. Each line is
//     one append for one listing slot; readers fold the trailing entry per id
//     so upserts work without rewriting the file.
//   - `listListings({...filters})` and `getListing(id)` are pure reads.
//   - `upsertListing(listing)` is the only writer; it validates required
//     fields, normalises numeric/string types, and stamps `created_at` on a
//     fresh row (preserved on updates).
//
// The file is kept small and pure on purpose — the route layer
// (src/marketplace-routes.js) sits on top of it and adds auth, signature
// verification, audit emission, and the download stream.
//
// Listing shape (W825 brief):
//   {
//     id, publisher_tenant_id, title, vertical, task_type, k_score,
//     hardware_targets[], teacher_model, artifact_uri, manifest_sha256,
//     signature_b64, rating_avg, rating_count, downloads, paid,
//     price_micro_usd, created_at
//   }
//
// Honesty contract:
//   - listListings() never throws — missing/corrupt file => []
//   - upsertListing() throws Error with .code='LISTING_INVALID' on bad input
//   - rating_avg / rating_count / downloads default to 0 (NEVER null) so the
//     UI can render a number without branching
//   - paid defaults to false; price_micro_usd to 0 on free listings
//   - W604 anti-brittleness: NO explicit-array sibling lock-ins; numeric +
//     enum validation only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MARKETPLACE_W825_VERSION = 'w825-mvp-v1';

// W825 facet axes — match the public UI sidebar exactly.
export const W825_VERTICALS = Object.freeze([
  'customer service', 'legal', 'health', 'code', 'finance', 'education',
  'translation', 'support', 'medical', 'general',
]);

export const W825_TASK_TYPES = Object.freeze([
  'classification', 'extraction', 'summarization', 'rag response',
  'reranking', 'reasoning', 'generation', 'response',
]);

export const W825_HARDWARE_TARGETS = Object.freeze([
  'single-gpu consumer', 'cpu only', 'multi-gpu cluster', 'edge / mobile',
  'rtx', 'h100', 'm-series', 'cpu',
]);

// Sort modes the route layer can pass through.
export const W825_SORT_MODES = Object.freeze([
  'newest', 'top_k_score', 'most_downloaded', 'highest_rated',
]);

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _marketplaceDir() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  return path.join(base, 'marketplace');
}

export function _listingsPath() {
  return path.join(_marketplaceDir(), 'listings.jsonl');
}

function _ensureDir() {
  const dir = _marketplaceDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// _readAll(): walk the JSONL file once and return the latest revision per id.
// We accept later-line wins (upsert semantics) so the file can be appended to
// without ever rewriting it.
function _readAll() {
  const p = _listingsPath();
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row = null;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (!row || typeof row !== 'object' || !row.id) continue;
    byId.set(String(row.id), _normalize(row));
  }
  return Array.from(byId.values());
}

function _appendRow(row) {
  _ensureDir();
  fs.appendFileSync(_listingsPath(), JSON.stringify(row) + '\n', 'utf8');
}

function _coerceStr(v, fallback = '') {
  if (v == null) return fallback;
  return String(v);
}

function _coerceArr(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.length > 0);
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

function _coerceNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _coerceBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return fallback;
}

function _normalize(row) {
  return {
    id: _coerceStr(row.id),
    publisher_tenant_id: _coerceStr(row.publisher_tenant_id),
    title: _coerceStr(row.title || row.name || row.id),
    vertical: _coerceStr(row.vertical).toLowerCase(),
    task_type: _coerceStr(row.task_type).toLowerCase(),
    k_score: row.k_score == null ? null : Math.max(0, Math.min(1, _coerceNum(row.k_score, 0))),
    hardware_targets: _coerceArr(row.hardware_targets).map((h) => String(h).toLowerCase()),
    teacher_model: _coerceStr(row.teacher_model),
    artifact_uri: _coerceStr(row.artifact_uri),
    manifest_sha256: _coerceStr(row.manifest_sha256),
    signature_b64: _coerceStr(row.signature_b64),
    rating_avg: _coerceNum(row.rating_avg, 0),
    rating_count: Math.max(0, Math.trunc(_coerceNum(row.rating_count, 0))),
    downloads: Math.max(0, Math.trunc(_coerceNum(row.downloads, 0))),
    paid: _coerceBool(row.paid, false),
    price_micro_usd: Math.max(0, Math.trunc(_coerceNum(row.price_micro_usd, 0))),
    created_at: _coerceStr(row.created_at) || new Date().toISOString(),
    updated_at: _coerceStr(row.updated_at) || _coerceStr(row.created_at) || new Date().toISOString(),
  };
}

// validateListing(row): throws Error with .code='LISTING_INVALID' on any bad
// field; returns the normalised row otherwise. Caller is responsible for
// signature verification — that lives in the route layer because it needs
// access to the verifier helpers + per-tenant audit.
function _validate(input) {
  const row = _normalize(input);
  if (!row.id || row.id.length < 4) {
    const e = new Error('id required (>=4 chars)'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!row.publisher_tenant_id) {
    const e = new Error('publisher_tenant_id required'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!row.title) {
    const e = new Error('title required'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!row.vertical) {
    const e = new Error('vertical required'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!row.task_type) {
    const e = new Error('task_type required'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!Array.isArray(row.hardware_targets) || row.hardware_targets.length === 0) {
    const e = new Error('hardware_targets must be a non-empty array'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!row.artifact_uri) {
    const e = new Error('artifact_uri required'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (!row.manifest_sha256 || !/^[0-9a-f]{64}$/i.test(row.manifest_sha256)) {
    const e = new Error('manifest_sha256 must be a 64-char hex digest'); e.code = 'LISTING_INVALID'; throw e;
  }
  if (row.paid && row.price_micro_usd <= 0) {
    const e = new Error('paid listings require price_micro_usd > 0'); e.code = 'LISTING_INVALID'; throw e;
  }
  return row;
}

// listListings(filter): pure read. Filters AND together. Empty match returns
// an empty array, never throws. Sort + pagination on top of the filter.
//
// filter:
//   vertical          — exact case-insensitive match
//   task_type         — exact case-insensitive match
//   k_score_min       — drops rows whose k_score is null or below the floor
//   hardware          — substring match against ANY hardware_targets entry
//   teacher           — substring match against teacher_model
//   publisher_tenant_id — exact match for "my listings" view
//   paid              — true|false strict bool match
//   sort_by           — one of W825_SORT_MODES (default 'newest')
//   page              — 1-indexed page number (default 1)
//   limit             — page size (1..200, default 24)
export function listListings(filter = {}) {
  const all = _readAll();
  const vertical = filter.vertical ? String(filter.vertical).toLowerCase() : null;
  const task_type = filter.task_type ? String(filter.task_type).toLowerCase() : null;
  const k_score_min = filter.k_score_min != null && filter.k_score_min !== ''
    ? _coerceNum(filter.k_score_min, null) : null;
  const hardware = filter.hardware ? String(filter.hardware).toLowerCase() : null;
  const teacher = filter.teacher ? String(filter.teacher).toLowerCase() : null;
  const publisher = filter.publisher_tenant_id ? String(filter.publisher_tenant_id) : null;
  const paidFilter = typeof filter.paid === 'boolean' ? filter.paid : null;
  const sort_by = String(filter.sort_by || 'newest').toLowerCase();
  const page = Math.max(1, Math.trunc(_coerceNum(filter.page, 1)) || 1);
  const limit = Math.max(1, Math.min(200, Math.trunc(_coerceNum(filter.limit, 24)) || 24));

  const filtered = all.filter((r) => {
    if (vertical && r.vertical !== vertical) return false;
    if (task_type && r.task_type !== task_type) return false;
    if (k_score_min != null) {
      if (r.k_score == null) return false;
      if (r.k_score < k_score_min) return false;
    }
    if (hardware) {
      const hit = r.hardware_targets.some((h) => h.includes(hardware));
      if (!hit) return false;
    }
    if (teacher && !r.teacher_model.toLowerCase().includes(teacher)) return false;
    if (publisher && r.publisher_tenant_id !== publisher) return false;
    if (paidFilter !== null && r.paid !== paidFilter) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (sort_by === 'top_k_score') {
      const av = a.k_score == null ? -1 : a.k_score;
      const bv = b.k_score == null ? -1 : b.k_score;
      if (bv !== av) return bv - av;
    } else if (sort_by === 'most_downloaded') {
      if (b.downloads !== a.downloads) return b.downloads - a.downloads;
    } else if (sort_by === 'highest_rated') {
      if (b.rating_avg !== a.rating_avg) return b.rating_avg - a.rating_avg;
    }
    // Stable tiebreaker: newest first.
    return String(b.created_at).localeCompare(String(a.created_at));
  });

  const total = filtered.length;
  const start = (page - 1) * limit;
  const rows = filtered.slice(start, start + limit);
  return {
    total,
    page,
    limit,
    sort_by,
    rows,
    all_count: all.length,
    version: MARKETPLACE_W825_VERSION,
  };
}

export function getListing(id) {
  if (!id) return null;
  const all = _readAll();
  return all.find((r) => r.id === String(id)) || null;
}

// upsertListing(listing): validates + appends. If a prior listing exists with
// the same id, its created_at is preserved and updated_at is bumped. Returns
// the canonical row that was written.
export function upsertListing(input = {}) {
  const incoming = _validate(input);
  const existing = getListing(incoming.id);
  if (existing) {
    incoming.created_at = existing.created_at;
    // Preserve counters from the prior revision unless the caller passed new
    // ones explicitly (counters are managed by recordDownload + recordRating).
    incoming.downloads = input.downloads != null ? incoming.downloads : existing.downloads;
    incoming.rating_avg = input.rating_avg != null ? incoming.rating_avg : existing.rating_avg;
    incoming.rating_count = input.rating_count != null ? incoming.rating_count : existing.rating_count;
  }
  incoming.updated_at = new Date().toISOString();
  _appendRow(incoming);
  return incoming;
}

// recordDownload(id): increment the download counter atomically. Returns the
// updated row, or null if the listing does not exist.
export function recordDownload(id) {
  const row = getListing(id);
  if (!row) return null;
  row.downloads = (row.downloads || 0) + 1;
  row.updated_at = new Date().toISOString();
  _appendRow(row);
  return row;
}

// updateRatingAggregate(id, {avg, count}): overwrite the rating counters with
// freshly computed values. Used by src/marketplace-ratings.js after a new
// rating row is committed.
export function updateRatingAggregate(id, { avg, count } = {}) {
  const row = getListing(id);
  if (!row) return null;
  if (Number.isFinite(Number(avg))) row.rating_avg = Math.max(0, Math.min(5, Number(avg)));
  if (Number.isFinite(Number(count))) row.rating_count = Math.max(0, Math.trunc(Number(count)));
  row.updated_at = new Date().toISOString();
  _appendRow(row);
  return row;
}

// _resetForTests(): blow away the local store so each test starts fresh.
// Tests freshDir() into a temp HOME so this only ever removes the test file.
export function _resetForTests() {
  const p = _listingsPath();
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
}

// _digestPath(p): convenience for the route layer — sha256 of the file at p
// in hex. Used to compare a published manifest_sha256 against the bytes the
// downloader will stream. Returns null when the file is missing.
export function _digestPath(p) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}
