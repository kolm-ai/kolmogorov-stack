// W808-3 — Capture proxy: cryptographic origin binding.
//
// Every captured upstream response gets a `teacher_response_signature`
// stamped onto the capture row before persistence. The signature is a
// sha256 over (teacher response headers, first 256 bytes of body, and
// the teacher fingerprint that was supposed to answer this request).
// If KOLM_W808_STRICT_SIGNATURE=1, an unrecognised teacher fingerprint
// rejects the capture (returns null + a reason); otherwise the row is
// passed through with a soft-flag (observability-only default — the
// proxy is in soft mode at launch so a teacher fingerprint roll-out
// does not block legitimate traffic).
//
// This module is intentionally TINY — it does not own routing, only the
// signature-on-capture verb. The HTTP wiring lives in src/router.js
// (intentionally untouched this wave per the W808 owned/forbidden split).
//
// Anti-brittleness (W604):
//   - PROXY_VERSION is `w808-vN.M` and consumers must match with regex
//     /^w808-/ — never literal equality.
//   - Teacher-fingerprint registry is in-memory + appendable so an
//     operator can add a new fingerprint without redeploying.

import crypto from 'node:crypto';

export const PROXY_VERSION = 'w808-v1';
export const SIGNATURE_BODY_BYTES = 256;
export const STRICT_SIGNATURE = (process.env.KOLM_W808_STRICT_SIGNATURE === '1'
  || process.env.KOLM_W808_STRICT_SIGNATURE === 'true');

// W808-3 — known teacher fingerprints. Seeded with the public TLS-cert SPKI
// SHA256 prefixes of the three vendor APIs we currently distill from. The
// `registerTeacherFingerprint` verb lets an operator add a self-hosted
// teacher (vLLM / llama.cpp / TGI) at runtime.
//
// IMPORTANT: these fingerprint VALUES are placeholders — at first wire-up
// the registry is observability-only (STRICT_SIGNATURE=false by default),
// so the actual cert SPKI does not need to match anything in production
// until an operator rotates KOLM_W808_STRICT_SIGNATURE=1. The shape of the
// registry is the load-bearing contract; the values come from an out-of-
// band trust bootstrap that lives outside this file.
const _teacherFingerprints = new Map([
  ['anthropic', new Set(['anthropic-public-spki-placeholder'])],
  ['openai', new Set(['openai-public-spki-placeholder'])],
  ['google', new Set(['google-public-spki-placeholder'])],
]);

// Register a teacher fingerprint. `vendor` is a short slug ('anthropic',
// 'openai', 'local:vllm-prod', etc.); `fingerprint` is an opaque string the
// caller has chosen as authoritative (typically a TLS SPKI-SHA256 or a
// content-attestation hash). Idempotent.
export function registerTeacherFingerprint(vendor, fingerprint) {
  if (!vendor || !fingerprint) {
    throw new Error('registerTeacherFingerprint: vendor + fingerprint are both required');
  }
  const key = String(vendor).toLowerCase();
  if (!_teacherFingerprints.has(key)) _teacherFingerprints.set(key, new Set());
  _teacherFingerprints.get(key).add(String(fingerprint));
}

// Check whether a teacher fingerprint is registered for a vendor. Returns
// true / false. Vendor lookup is case-insensitive.
export function isKnownTeacherFingerprint(vendor, fingerprint) {
  if (!vendor || !fingerprint) return false;
  const key = String(vendor).toLowerCase();
  const set = _teacherFingerprints.get(key);
  if (!set) return false;
  return set.has(String(fingerprint));
}

// Reset hook for tests — empties + re-seeds the placeholder registry.
export function _resetTeacherFingerprintsForTests() {
  _teacherFingerprints.clear();
  _teacherFingerprints.set('anthropic', new Set(['anthropic-public-spki-placeholder']));
  _teacherFingerprints.set('openai', new Set(['openai-public-spki-placeholder']));
  _teacherFingerprints.set('google', new Set(['google-public-spki-placeholder']));
}

// Compute the W808-3 teacher_response_signature. Inputs:
//   headers     — plain object or Headers-like { get(name): string }
//   body        — string OR Buffer OR Uint8Array; only first 256 bytes used
//   vendor      — short slug used to bind the signature to a teacher
//   fingerprint — operator-supplied teacher fingerprint (may be undefined)
//
// Returns a hex sha256 digest. Deterministic given the same inputs. The
// signature does NOT include a timestamp — that would make replay
// detection meaningless. The signature DOES include vendor + fingerprint
// so two different teachers returning the same bytes produce different
// signatures (which is the whole point of origin binding).
export function computeTeacherResponseSignature({ headers = {}, body = '', vendor = null, fingerprint = null } = {}) {
  const h = crypto.createHash('sha256');
  // Canonicalize headers: lowercase keys, sort, join "k:v\n".
  let headerObj = {};
  if (headers && typeof headers.get === 'function') {
    // Headers-like (web Fetch API) — we can only iterate if `entries()` exists.
    if (typeof headers.entries === 'function') {
      for (const [k, v] of headers.entries()) headerObj[String(k).toLowerCase()] = String(v);
    } else {
      // Fall back to a small set of well-known security-relevant headers.
      for (const k of ['content-type', 'x-request-id', 'anthropic-version', 'openai-organization']) {
        try { const v = headers.get(k); if (v != null) headerObj[k] = String(v); } catch (_) {} // deliberate: cleanup
      }
    }
  } else if (headers && typeof headers === 'object') {
    for (const k of Object.keys(headers)) headerObj[String(k).toLowerCase()] = String(headers[k]);
  }
  const headerKeys = Object.keys(headerObj).sort();
  for (const k of headerKeys) h.update(k + ':' + headerObj[k] + '\n');
  h.update('|body|');
  // Coerce body to a buffer and take the first SIGNATURE_BODY_BYTES bytes.
  let buf;
  if (Buffer.isBuffer(body)) buf = body;
  else if (body instanceof Uint8Array) buf = Buffer.from(body);
  else if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
  else if (body == null) buf = Buffer.alloc(0);
  else buf = Buffer.from(JSON.stringify(body), 'utf8');
  const slice = buf.slice(0, SIGNATURE_BODY_BYTES);
  h.update(slice);
  h.update('|vendor|');
  h.update(String(vendor || ''));
  h.update('|fingerprint|');
  h.update(String(fingerprint || ''));
  return h.digest('hex');
}

// =============================================================================
// W808-3 main verb — stamp + (optionally) reject a capture.
//
// Threads the teacher_response_signature into the capture row in place,
// then returns a verdict envelope. The proxy is wired to insert into the
// staged_captures table (W808-2) BEFORE calling captureWithSignature, so
// the signature is computed against the same row the quarantine sees.
//
// Soft-flag default (STRICT_SIGNATURE=false):
//   - Always stamps teacher_response_signature.
//   - Stamps teacher_fingerprint_known: true/false (observability).
//   - Returns { ok:true, rejected:false, ... }.
//
// Strict mode (STRICT_SIGNATURE=true OR opts.strict=true):
//   - Unknown fingerprint → returns { ok:false, rejected:true,
//     error:'unknown_teacher_fingerprint', ... }.
//   - Caller is expected to NOT promote the row.
// =============================================================================
export function captureWithSignature(row, { headers = {}, body = '', vendor = null, fingerprint = null, strict = STRICT_SIGNATURE } = {}) {
  if (!row || typeof row !== 'object') {
    return {
      ok: false,
      rejected: false,
      error: 'missing_capture_row',
      hint: 'pass a capture row object as the first arg',
      version: PROXY_VERSION,
    };
  }
  const signature = computeTeacherResponseSignature({ headers, body, vendor, fingerprint });
  const known = vendor && fingerprint ? isKnownTeacherFingerprint(vendor, fingerprint) : false;
  row.teacher_response_signature = signature;
  row.teacher_vendor = vendor || null;
  row.teacher_fingerprint = fingerprint || null;
  row.teacher_fingerprint_known = known;
  row.w808_proxy_version = PROXY_VERSION;
  if (strict && !known) {
    return {
      ok: false,
      rejected: true,
      error: 'unknown_teacher_fingerprint',
      teacher_response_signature: signature,
      vendor: vendor || null,
      fingerprint: fingerprint || null,
      hint: 'register the teacher via registerTeacherFingerprint(vendor, fingerprint) or unset KOLM_W808_STRICT_SIGNATURE for soft-flag mode',
      version: PROXY_VERSION,
    };
  }
  return {
    ok: true,
    rejected: false,
    teacher_response_signature: signature,
    teacher_fingerprint_known: known,
    strict_mode: strict,
    version: PROXY_VERSION,
  };
}

export default {
  PROXY_VERSION,
  SIGNATURE_BODY_BYTES,
  STRICT_SIGNATURE,
  registerTeacherFingerprint,
  isKnownTeacherFingerprint,
  computeTeacherResponseSignature,
  captureWithSignature,
  _resetTeacherFingerprintsForTests,
};
