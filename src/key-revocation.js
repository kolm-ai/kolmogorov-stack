// src/key-revocation.js
//
// TRACK CRYPTO-SERVICES / M5 - issuer key lifecycle (revocation + rotation).
//
// WHY THIS EXISTS
//   An Ed25519 signature is only as trustworthy as the key that made it. If a
//   signing key is compromised, every report it ever signed must STOP being
//   accepted - even though the signature still mathematically verifies. Tier-1
//   verification ("signed by the holder of this key, untampered") cannot answer
//   "is this key still trusted RIGHT NOW". This module is the authoritative,
//   persisted answer:
//
//     - revoke(fp, reason)  -> the key is compromised/withdrawn; reports signed
//                              by it MUST fail verification (issuer_key_revoked).
//     - rotateKey(old,new)  -> routine rotation; the OLD key is no longer the
//                              current signer but reports it signed before
//                              rotation remain valid (rotation != compromise).
//     - status(fp)          -> { fingerprint, valid, status, revoked_at, reason,
//                              next_rotation_at } for the PUBLIC status endpoint.
//
// STORE
//   A single global table 'issuer_key_status' (NOT tenant-scoped: issuer keys
//   are operator/product-level, not customer data). One row per fingerprint.
//   Synchronous src/store.js facade (insert/update/findByField), wrapped in
//   withTransaction for read-modify-write safety under concurrent calls.
//
// FINGERPRINT
//   The kolm Ed25519 key fingerprint: first 32 hex chars of SHA-256 over the
//   SPKI DER (src/ed25519.js keyFingerprint). All inputs are normalized to lower
//   hex so a caller passing an upper/spacey value still matches.

import { findByField, insert, update, withTransaction, remove, all } from './store.js';

export const KEY_REVOCATION_VERSION = 'kolm-key-revocation-v1';
export const ISSUER_KEY_STATUS_TABLE = 'issuer_key_status';

// Status vocabulary. 'live' is the implicit default for any key with no row.
export const KEY_STATUS = Object.freeze({ LIVE: 'live', ROTATED: 'rotated', REVOKED: 'revoked' });

// Optional default rotation cadence. When set (days), status() computes a
// forward next_rotation_at for live keys that have no explicit schedule.
function _defaultRotationDays() {
  const v = parseInt(process.env.KOLM_KEY_ROTATION_DAYS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Normalize a fingerprint to canonical lower-hex (strip non-hex, lowercase).
function _normFp(fp) {
  return String(fp == null ? '' : fp).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}

function _row(fp) {
  const norm = _normFp(fp);
  if (!norm) return null;
  const rows = findByField(ISSUER_KEY_STATUS_TABLE, 'fingerprint', norm);
  // findByField is an indexed equality lookup; re-filter defensively.
  return rows.find((r) => r && _normFp(r.fingerprint) === norm) || null;
}

// ---------------------------------------------------------------------------
// status(fp) -> the public, never-throws status record.
//   { fingerprint, valid, status, revoked_at, reason, next_rotation_at,
//     rotated_at?, updated_at? }
// A key with no stored row is 'live' + valid (the default-trust posture). Only
// an explicit 'revoked' row makes valid:false; 'rotated' stays valid:true
// (rotation is not compromise - historical signatures remain acceptable).
// ---------------------------------------------------------------------------
export function status(fp) {
  const fingerprint = _normFp(fp);
  const base = {
    fingerprint,
    valid: true,
    status: KEY_STATUS.LIVE,
    revoked_at: null,
    reason: null,
    next_rotation_at: null,
  };
  if (!fingerprint) return { ...base, valid: false, status: 'unknown', reason: 'no_fingerprint' };
  let row = null;
  try { row = _row(fingerprint); } catch { row = null; }
  if (!row) {
    const days = _defaultRotationDays();
    if (days) base.next_rotation_at = new Date(Date.now() + days * 24 * 3600_000).toISOString();
    return base;
  }
  const st = row.status === KEY_STATUS.REVOKED ? KEY_STATUS.REVOKED
    : row.status === KEY_STATUS.ROTATED ? KEY_STATUS.ROTATED
    : KEY_STATUS.LIVE;
  return {
    fingerprint,
    valid: st !== KEY_STATUS.REVOKED,
    status: st,
    revoked_at: row.revoked_at || null,
    reason: row.reason || null,
    next_rotation_at: row.next_rotation_at || null,
    rotated_at: row.rotated_at || null,
    updated_at: row.updated_at || null,
  };
}

// isRevoked(fp) -> boolean. Pure, never throws.
export function isRevoked(fp) {
  try { return status(fp).status === KEY_STATUS.REVOKED; } catch { return false; }
}

// Upsert a status row inside a single transactional unit (re-entrant SAVEPOINT
// in sqlite; pass-through in json). Re-reads inside the unit so concurrent
// revoke/rotate calls do not lose each other.
function _upsert(fingerprint, patch) {
  const norm = _normFp(fingerprint);
  const now = new Date().toISOString();
  return withTransaction(() => {
    const existing = _row(norm);
    if (existing) {
      update(ISSUER_KEY_STATUS_TABLE, (r) => _normFp(r.fingerprint) === norm, { ...patch, updated_at: now });
      return { ...existing, ...patch, updated_at: now };
    }
    const row = {
      id: 'iks_' + norm.slice(0, 16) + '_' + Date.now().toString(36),
      fingerprint: norm,
      status: KEY_STATUS.LIVE,
      reason: null,
      revoked_at: null,
      rotated_at: null,
      next_rotation_at: null,
      created_at: now,
      updated_at: now,
      version: KEY_REVOCATION_VERSION,
      ...patch,
    };
    insert(ISSUER_KEY_STATUS_TABLE, row);
    return row;
  });
}

// ---------------------------------------------------------------------------
// revoke(fp, reason, opts) -> the new status record.
// Idempotent: revoking an already-revoked key keeps the original revoked_at +
// reason unless opts.overwrite is set. Throws ONLY on a missing fingerprint
// (a programming error); store failures propagate so the admin route 500s
// loudly rather than silently "succeeding".
// ---------------------------------------------------------------------------
export function revoke(fp, reason, opts = {}) {
  const fingerprint = _normFp(fp);
  if (!fingerprint) throw new Error('revoke: a key fingerprint is required');
  const existing = (() => { try { return _row(fingerprint); } catch { return null; } })();
  if (existing && existing.status === KEY_STATUS.REVOKED && !opts.overwrite) {
    return status(fingerprint);
  }
  _upsert(fingerprint, {
    status: KEY_STATUS.REVOKED,
    reason: reason ? String(reason).slice(0, 500) : 'unspecified',
    revoked_at: opts.revoked_at || new Date().toISOString(),
    next_rotation_at: opts.next_rotation_at || (existing && existing.next_rotation_at) || null,
  });
  return status(fingerprint);
}

// ---------------------------------------------------------------------------
// rotateKey({ old_fp, new_fp?, reason?, next_rotation_at? }) - mark the prior
// fingerprint 'rotated' (still valid for historical signatures) and, when a new
// fingerprint is supplied, record it 'live'. Returns { rotated, live? }.
// ---------------------------------------------------------------------------
export function rotateKey(arg = {}) {
  const oldFp = _normFp(arg.old_fp || arg.from || arg.fp);
  const newFp = _normFp(arg.new_fp || arg.to || '');
  if (!oldFp) throw new Error('rotateKey: old_fp is required');
  const now = new Date().toISOString();
  const out = {};
  // A revoked key must NOT be silently downgraded to 'rotated' (that would
  // re-enable a compromised key). Only rotate a key that is not revoked.
  const prior = (() => { try { return _row(oldFp); } catch { return null; } })();
  if (prior && prior.status === KEY_STATUS.REVOKED) {
    throw new Error('rotateKey: refusing to rotate a revoked key (it stays revoked)');
  }
  _upsert(oldFp, { status: KEY_STATUS.ROTATED, rotated_at: now, reason: arg.reason ? String(arg.reason).slice(0, 500) : (prior && prior.reason) || null });
  out.rotated = status(oldFp);
  if (newFp && newFp !== oldFp) {
    _upsert(newFp, { status: KEY_STATUS.LIVE, next_rotation_at: arg.next_rotation_at || null });
    out.live = status(newFp);
  }
  return out;
}

// markLive(fp, opts) - explicitly record a key as the current live signer (used
// when seeding the production signer's status, or un-rotating in a rollback).
// Refuses to revive a revoked key unless opts.force.
export function markLive(fp, opts = {}) {
  const fingerprint = _normFp(fp);
  if (!fingerprint) throw new Error('markLive: a key fingerprint is required');
  const prior = (() => { try { return _row(fingerprint); } catch { return null; } })();
  if (prior && prior.status === KEY_STATUS.REVOKED && !opts.force) {
    throw new Error('markLive: refusing to revive a revoked key without force');
  }
  _upsert(fingerprint, { status: KEY_STATUS.LIVE, revoked_at: null, rotated_at: null, next_rotation_at: opts.next_rotation_at || null, reason: null });
  return status(fingerprint);
}

// listKeyStatuses() - every stored status row (admin/diagnostic view). Live
// default-trust keys with no row are NOT listed (there is nothing to list).
export function listKeyStatuses() {
  try {
    return all(ISSUER_KEY_STATUS_TABLE)
      .filter((r) => r && r.fingerprint)
      .map((r) => status(r.fingerprint));
  } catch {
    return [];
  }
}

// Test hook - clear the status table.
export function _resetKeyStatusForTests() {
  try { remove(ISSUER_KEY_STATUS_TABLE, () => true); } catch { /* ignore */ }
}

export const KEY_REVOCATION_SPEC = {
  version: KEY_REVOCATION_VERSION,
  table: ISSUER_KEY_STATUS_TABLE,
  statuses: Object.values(KEY_STATUS),
};
