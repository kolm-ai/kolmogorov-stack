// src/marketplace-ratings.js
//
// W825-5 - Rating + review for the W825 Artifact Marketplace MVP.
//
// Storage: ~/.kolm/marketplace/ratings.jsonl. Each row is one tenant's rating
// for one listing. A tenant may overwrite their own prior rating (later row
// wins, same {listing_id, tenant} pair).
//
// Anti-gaming gates (W825-5 brief):
//   - req.tenant_record.account_age_days >= 7 → blocks brand-new accounts
//     spinning up fake reviews. account_age_days is computed from the
//     tenant.created_at ISO string.
//   - >= 1 prior download by the same tenant for the listing → blocks
//     "review without using it" gaming.
//
// Both gates throw Error with .code='RATING_FORBIDDEN' so the route layer can
// map to HTTP 403 without leaking which gate failed (we DO surface the
// failed gate name on the error message for debug - the HTTP body picks the
// generic code).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateRatingAggregate, getListing } from './marketplace-w825.js';

export const MARKETPLACE_RATINGS_VERSION = 'w825-ratings-v1';
export const MIN_ACCOUNT_AGE_DAYS = 7;

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _dir() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  return path.join(base, 'marketplace');
}
function _ratingsPath() {
  return path.join(_dir(), 'ratings.jsonl');
}
function _downloadsPath() {
  return path.join(_dir(), 'downloads.jsonl');
}
function _ensureDir() {
  fs.mkdirSync(_dir(), { recursive: true });
}

// _readJsonl(path): returns [] for missing/corrupt files. Per-row JSON.parse
// is tolerant - a malformed line is skipped.
function _readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip bad row */ }
  }
  return out;
}

function _appendJsonl(p, row) {
  _ensureDir();
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
}

// recordDownloadEvent({listing_id, tenant_id}): persisted by the download
// route handler so the anti-gaming check below can see prior downloads. We
// keep this in a separate JSONL from the listing-store counter for clarity
// (the listing counter is aggregate; this is per-tenant).
export function recordDownloadEvent({ listing_id, tenant_id }) {
  if (!listing_id || !tenant_id) return null;
  const row = {
    listing_id: String(listing_id),
    tenant_id: String(tenant_id),
    at: new Date().toISOString(),
  };
  _appendJsonl(_downloadsPath(), row);
  return row;
}

export function tenantHasDownloaded({ listing_id, tenant_id }) {
  if (!listing_id || !tenant_id) return false;
  const rows = _readJsonl(_downloadsPath());
  return rows.some((r) => r.listing_id === String(listing_id) && r.tenant_id === String(tenant_id));
}

// _accountAgeDays(tenant): compute how many full days since tenant.created_at.
// Returns Infinity if created_at is missing - auth.js stamps this on every
// new tenant so a missing field is treated as "old enough" rather than
// "block forever". (Old tenants minted pre-W411 may carry no created_at.)
export function _accountAgeDays(tenant) {
  if (!tenant) return 0;
  if (typeof tenant.account_age_days === 'number') return tenant.account_age_days;
  const iso = tenant.created_at;
  if (!iso) return Infinity;
  const created = Date.parse(iso);
  if (!Number.isFinite(created)) return Infinity;
  const ms = Date.now() - created;
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

// rate({tenant, listing_id, stars, review_text}): persist a rating after the
// anti-gaming gates pass.
//
// tenant is the full req.tenant_record (we need both .id and .created_at /
// .account_age_days for the gate).
export function rate({ tenant, listing_id, stars, review_text }) {
  if (!tenant || !tenant.id) {
    const e = new Error('tenant required'); e.code = 'RATING_INVALID'; throw e;
  }
  if (!listing_id) {
    const e = new Error('listing_id required'); e.code = 'RATING_INVALID'; throw e;
  }
  const starsNum = Number(stars);
  if (!Number.isFinite(starsNum) || starsNum < 1 || starsNum > 5 || Math.trunc(starsNum) !== starsNum) {
    const e = new Error('stars must be an integer in [1,5]'); e.code = 'RATING_INVALID'; throw e;
  }
  const text = typeof review_text === 'string' ? review_text.trim() : '';
  // The listing MUST exist before a rating is accepted (no orphan reviews).
  if (!getListing(listing_id)) {
    const e = new Error('listing not found'); e.code = 'RATING_INVALID'; throw e;
  }

  // Anti-gaming gate #1: account age.
  const age = _accountAgeDays(tenant);
  if (age < MIN_ACCOUNT_AGE_DAYS) {
    const e = new Error(`account too new (age=${age}d, min=${MIN_ACCOUNT_AGE_DAYS}d)`);
    e.code = 'RATING_FORBIDDEN';
    e.reason = 'account_too_new';
    throw e;
  }
  // Anti-gaming gate #2: prior download required.
  if (!tenantHasDownloaded({ listing_id, tenant_id: tenant.id })) {
    const e = new Error('no prior download by this tenant for this listing');
    e.code = 'RATING_FORBIDDEN';
    e.reason = 'no_prior_download';
    throw e;
  }

  const row = {
    listing_id: String(listing_id),
    tenant_id: tenant.id,
    stars: starsNum,
    review_text: text,
    at: new Date().toISOString(),
    version: MARKETPLACE_RATINGS_VERSION,
  };
  _appendJsonl(_ratingsPath(), row);

  // Recompute aggregate for the listing and persist back into the listing row.
  const agg = getRatings(listing_id);
  updateRatingAggregate(listing_id, { avg: agg.rating_avg, count: agg.rating_count });
  return row;
}

// getRatings(listing_id): public read, returns {rating_avg, rating_count, ratings}.
// rating_avg is null when there are no ratings (UI distinguishes from 0.0).
export function getRatings(listing_id) {
  if (!listing_id) {
    return { rating_avg: null, rating_count: 0, ratings: [] };
  }
  const rows = _readJsonl(_ratingsPath());
  // Latest-row-wins per (listing_id, tenant_id) so a tenant updating their
  // rating doesn't get counted twice.
  const byTenant = new Map();
  for (const r of rows) {
    if (r.listing_id !== String(listing_id)) continue;
    if (!r.tenant_id) continue;
    byTenant.set(r.tenant_id, r);
  }
  const ratings = Array.from(byTenant.values());
  if (ratings.length === 0) {
    return { rating_avg: null, rating_count: 0, ratings: [] };
  }
  const sum = ratings.reduce((a, r) => a + Number(r.stars), 0);
  return {
    rating_avg: sum / ratings.length,
    rating_count: ratings.length,
    ratings,
  };
}

export function _resetForTests() {
  for (const p of [_ratingsPath(), _downloadsPath()]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
  }
}
