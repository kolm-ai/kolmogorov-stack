// W761-3 - Cryptographic binding of captures to verified teacher responses.
//
// Why this exists:
//   Capture poisoning attacks fall into two categories that the W808 statistical
//   anomaly detector + W750 copyright heuristic cannot catch:
//     1) MITM injection - an attacker on the wire to the teacher swaps the
//        response body before it reaches the proxy. Statistical anomaly only
//        flags rows that DRIFT from the baseline; a poisoned response carefully
//        crafted to mimic baseline tone slips through.
//     2) Cache poisoning - an attacker who can write to the response cache (or
//        the staged_captures store) inserts adversarial rows that were never
//        produced by the configured teacher at all.
//
//   Both attacks are defeated by binding every capture row to an HMAC computed
//   at the moment the teacher response is received, using a tenant-controlled
//   key the attacker does not possess. Any post-bind mutation of the response
//   body invalidates the binding. Any row missing a binding is plainly not from
//   the configured teacher.
//
// Honesty contract (W761 INVARIANT):
//   - HMAC key is REQUIRED. Without KOLM_TEACHER_HMAC_KEY set, the binding API
//     returns { ok:false, error:'hmac_key_not_configured' } HONESTLY. We do
//     NOT silent-pass with an empty key - that would be cryptographic theater.
//   - Keys shorter than 32 bytes are REFUSED with hmac_key_too_short. 32 bytes
//     is the minimum for SHA-256 HMAC to retain full collision resistance.
//   - Verification uses crypto.timingSafeEqual - never `===` on HMAC bytes.
//
// Anti-brittleness (W604):
//   - TEACHER_HMAC_VERSION is `w761-vN.M` and consumers MUST match with a
//     regex `/^w761-/` NOT literal equality.
//   - Algorithm and env var name are exported as constants.

import crypto from 'node:crypto';

export const TEACHER_HMAC_VERSION = 'w761-v2';
export const HMAC_ALGORITHM = 'sha256';
export const TEACHER_HMAC_KEY_ENV = 'KOLM_TEACHER_HMAC_KEY';
export const MIN_KEY_BYTES = 32;
export const TEACHER_HMAC_LIMITS = Object.freeze({
  MAX_TEACHER_ID_CHARS: 256,
  MAX_RESPONSE_BODY_CHARS: 2_000_000,
  MAX_HEADER_KEYS: 64,
  MAX_HEADER_KEY_CHARS: 128,
  MAX_HEADER_VALUE_CHARS: 2048,
});

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const HMAC_HEX_RE = /^[a-f0-9]{64}$/i;
const CANONICALIZATION = 'kolm.teacher_response_hmac.v2';

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

function _cleanScalar(value, maxChars) {
  if (value == null) return { ok: false, error: 'required' };
  if (typeof value !== 'string') return { ok: false, error: 'must_be_string' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'required' };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'control_chars' };
  if (trimmed.length > maxChars) return { ok: false, error: 'too_long' };
  return { ok: true, value: trimmed };
}

function _canonicalResponseBody(response_body) {
  if (response_body == null) {
    return { ok: false, error: 'missing_field', field: 'response_body' };
  }
  const body = typeof response_body === 'string'
    ? response_body
    : _stableJson(response_body);
  if (body.length > TEACHER_HMAC_LIMITS.MAX_RESPONSE_BODY_CHARS) {
    return {
      ok: false,
      error: 'response_body_too_large',
      response_chars: body.length,
      max_response_chars: TEACHER_HMAC_LIMITS.MAX_RESPONSE_BODY_CHARS,
    };
  }
  return {
    ok: true,
    body,
    response_sha256: _sha256Hex(body),
    response_chars: body.length,
  };
}

function _normaliseTeacherId(teacher_id) {
  const clean = _cleanScalar(teacher_id, TEACHER_HMAC_LIMITS.MAX_TEACHER_ID_CHARS);
  if (!clean.ok) return { ok: false, error: `teacher_id_${clean.error}`, field: 'teacher_id' };
  return clean;
}

function _normaliseRequestHash(request_hash) {
  const clean = _cleanScalar(request_hash, 128);
  if (!clean.ok) return { ok: false, error: `request_hash_${clean.error}`, field: 'request_hash' };
  if (!SHA256_HEX_RE.test(clean.value)) {
    return { ok: false, error: 'request_hash_must_be_sha256_hex', field: 'request_hash' };
  }
  return { ok: true, value: clean.value.toLowerCase() };
}

function _normaliseTimestampMs(timestamp_ms) {
  if (timestamp_ms == null) return { ok: true, value: Date.now() };
  const n = Number(timestamp_ms);
  if (!Number.isFinite(n) || Math.abs(n) > 8.64e15) {
    return { ok: false, error: 'timestamp_ms_invalid', field: 'timestamp_ms' };
  }
  return { ok: true, value: Math.trunc(n) };
}

function _headersHash(response_headers) {
  if (response_headers == null) return { ok: true, value: null, header_count: 0 };
  if (typeof response_headers !== 'object' || Array.isArray(response_headers)) {
    return { ok: false, error: 'response_headers_must_be_object', field: 'response_headers' };
  }
  const keys = Object.keys(response_headers).sort();
  if (keys.length > TEACHER_HMAC_LIMITS.MAX_HEADER_KEYS) {
    return { ok: false, error: 'response_headers_too_many', field: 'response_headers' };
  }
  const normalized = {};
  for (const rawKey of keys) {
    const key = _cleanScalar(rawKey, TEACHER_HMAC_LIMITS.MAX_HEADER_KEY_CHARS);
    if (!key.ok) return { ok: false, error: `response_header_key_${key.error}`, field: 'response_headers' };
    const rawValue = response_headers[rawKey];
    const value = Array.isArray(rawValue)
      ? rawValue.map((v) => String(v == null ? '' : v)).join(',')
      : String(rawValue == null ? '' : rawValue);
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      return { ok: false, error: 'response_header_value_control_chars', field: 'response_headers' };
    }
    if (value.length > TEACHER_HMAC_LIMITS.MAX_HEADER_VALUE_CHARS) {
      return { ok: false, error: 'response_header_value_too_long', field: 'response_headers' };
    }
    const normalizedKey = key.value.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) {
      return { ok: false, error: 'response_header_key_duplicate', field: 'response_headers' };
    }
    normalized[normalizedKey] = value;
  }
  return {
    ok: true,
    value: _sha256Hex(_stableJson(normalized)),
    header_count: keys.length,
  };
}

function _isLegacyBindingVersion(version) {
  return String(version || '').startsWith('w761-v1');
}

// -----------------------------------------------------------------------------
// Key loader - honest envelopes for misconfiguration.
// -----------------------------------------------------------------------------

// Returns a Buffer carrying the configured HMAC key, OR throws with an Error
// whose .code is one of: 'hmac_key_not_configured' | 'hmac_key_too_short'.
// The route + binding entry points convert these into honest envelopes.
function _loadKeyOrThrow() {
  const raw = process.env[TEACHER_HMAC_KEY_ENV];
  if (raw == null || raw === '') {
    const e = new Error('hmac_key_not_configured');
    e.code = 'hmac_key_not_configured';
    e.hint = `Set ${TEACHER_HMAC_KEY_ENV} to a 32+ byte random value: openssl rand -hex 32`;
    throw e;
  }
  // Accept hex or raw - the env var is most-commonly hex from openssl rand.
  // Hex 64 chars → 32 bytes; raw 32+ char string is also acceptable.
  let buf;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = Buffer.from(raw, 'utf8');
  }
  if (buf.length < MIN_KEY_BYTES) {
    const e = new Error('hmac_key_too_short');
    e.code = 'hmac_key_too_short';
    e.hint = `${TEACHER_HMAC_KEY_ENV} decodes to ${buf.length} bytes; must be at least ${MIN_KEY_BYTES} bytes. Generate one with: openssl rand -hex 32`;
    throw e;
  }
  return buf;
}

// Short fingerprint of the active key so post-hoc verification can detect
// key rotation. We expose first 16 hex chars of sha256(key) - too short for
// a recovery attack, long enough to distinguish two production keys.
export function _keyFingerprint(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('hex').slice(0, 16);
}

// -----------------------------------------------------------------------------
// Binding chain.
// -----------------------------------------------------------------------------

// Canonical hash chain. The string concatenated under HMAC is deliberately
// minimal: only fields the verifier will replay. response_body is hashed
// separately so the binding can carry a fixed-length token regardless of body
// size - the verifier rehashes the body and compares.
function _legacyHashChainMessage({ teacher_id, request_hash, response_body, timestamp_ms }) {
  const bodyHash = crypto.createHash('sha256')
    .update(String(response_body == null ? '' : response_body))
    .digest('hex');
  return String(teacher_id) + ':'
    + String(request_hash) + ':'
    + bodyHash + ':'
    + String(timestamp_ms);
}

function _v2HashChainMessage({ teacher_id, request_hash, response_sha256, timestamp_ms }) {
  return _stableJson({
    algorithm: HMAC_ALGORITHM,
    canonicalization: CANONICALIZATION,
    request_hash,
    response_sha256,
    teacher_id,
    timestamp_ms,
    version: TEACHER_HMAC_VERSION,
  });
}

function _bindingPublicDigest(binding) {
  return _sha256Hex(_stableJson({
    algorithm: binding.algorithm || HMAC_ALGORITHM,
    canonicalization: binding.canonicalization || null,
    key_fingerprint: binding.key_fingerprint,
    request_hash: binding.request_hash,
    response_hmac: binding.response_hmac,
    response_sha256: binding.response_sha256 || null,
    teacher_id: binding.teacher_id,
    timestamp_ms: binding.timestamp_ms,
    version: binding.version || null,
  }));
}

// Bind a teacher response. Returns either an honest envelope on missing/short
// key OR a populated binding envelope. The binding is what the caller
// persists alongside the capture row.
//
// Returns:
//   { ok:true,  version, teacher_id, request_hash, response_hmac,
//     signed_at, key_fingerprint }
//   { ok:false, error:'hmac_key_not_configured'|'hmac_key_too_short', hint }
//   { ok:false, error:'missing_field', field:<name> }
export function bindTeacherResponse({ teacher_id, request_hash, response_body, response_headers, timestamp_ms } = {}) {
  const teacher = _normaliseTeacherId(teacher_id);
  if (!teacher.ok) {
    return {
      ok: false,
      error: teacher.error === 'teacher_id_required' ? 'missing_field' : teacher.error,
      field: teacher.field,
      hint: 'pass {teacher_id: "<provider:model>"}',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const request = _normaliseRequestHash(request_hash);
  if (!request.ok) {
    return {
      ok: false,
      error: request.error === 'request_hash_required' ? 'missing_field' : request.error,
      field: request.field,
      hint: 'pass {request_hash: sha256(canonical_request_body)} - the same value capture-store uses for dedupe',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const body = _canonicalResponseBody(response_body);
  if (!body.ok) {
    return {
      ok: false,
      error: body.error,
      field: body.field || 'response_body',
      response_chars: body.response_chars,
      max_response_chars: body.max_response_chars,
      hint: 'pass {response_body: "<raw body string or canonical JSON>"} - empty string is acceptable if the upstream really returned no body',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const ts = _normaliseTimestampMs(timestamp_ms);
  if (!ts.ok) {
    return {
      ok: false,
      error: ts.error,
      field: ts.field,
      hint: 'timestamp_ms must be a finite JavaScript epoch millisecond value',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const headers = _headersHash(response_headers);
  if (!headers.ok) {
    return {
      ok: false,
      error: headers.error,
      field: headers.field,
      version: TEACHER_HMAC_VERSION,
    };
  }

  let key;
  try { key = _loadKeyOrThrow(); }
  catch (e) {
    return { ok: false, error: e.code, hint: e.hint, version: TEACHER_HMAC_VERSION };
  }
  const msg = _v2HashChainMessage({
    teacher_id: teacher.value,
    request_hash: request.value,
    response_sha256: body.response_sha256,
    timestamp_ms: ts.value,
  });
  const response_hmac = crypto.createHmac(HMAC_ALGORITHM, key).update(msg).digest('hex');
  const key_fingerprint = _keyFingerprint(key);
  const binding = {
    ok: true,
    version: TEACHER_HMAC_VERSION,
    teacher_id: teacher.value,
    request_hash: request.value,
    response_sha256: body.response_sha256,
    response_chars: body.response_chars,
    response_hmac,
    message_sha256: _sha256Hex(msg),
    signed_at: new Date(ts.value).toISOString(),
    timestamp_ms: ts.value,
    key_fingerprint,
    headers_hash: headers.value,
    header_count: headers.header_count,
    algorithm: HMAC_ALGORITHM,
    canonicalization: CANONICALIZATION,
  };
  binding.binding_sha256 = _bindingPublicDigest(binding);
  return binding;
}

// Verify a previously-bound capture's response body still matches the HMAC.
//
// Returns:
//   { ok:true,  valid:true,  reason:'valid_signature' }
//   { ok:true,  valid:false, reason:'signature_mismatch' }
//   { ok:true,  valid:false, reason:'response_body_mutated' } (alias path)
//   { ok:false, valid:false, reason:'binding_missing_fields' }
//   { ok:false, valid:false, reason:'hmac_key_not_configured' }
//   { ok:false, valid:false, reason:'hmac_key_mismatch_post_rotation' }
//
// We always return a { ok, valid, reason } shape so callers can branch on
// `valid` for the security decision and on `reason` for the diagnostic.
export function verifyTeacherResponse({ binding, response_body } = {}) {
  if (!binding || typeof binding !== 'object') {
    return {
      ok: false,
      valid: false,
      reason: 'binding_missing_fields',
      detail: 'binding arg must be the envelope returned by bindTeacherResponse',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const required = ['teacher_id', 'request_hash', 'response_hmac', 'timestamp_ms', 'key_fingerprint'];
  for (const f of required) {
    if (binding[f] == null) {
      return {
        ok: false,
        valid: false,
        reason: 'binding_missing_fields',
        detail: `binding.${f} is required`,
        missing_field: f,
        version: TEACHER_HMAC_VERSION,
      };
    }
  }
  if (!HMAC_HEX_RE.test(String(binding.response_hmac))) {
    return {
      ok: true,
      valid: false,
      reason: 'signature_mismatch',
      detail: 'binding.response_hmac must be a 64-character sha256 HMAC hex string',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const legacy = _isLegacyBindingVersion(binding.version);
  const legacyBody = legacy ? String(response_body == null ? '' : response_body) : null;
  if (legacy && legacyBody.length > TEACHER_HMAC_LIMITS.MAX_RESPONSE_BODY_CHARS) {
    return {
      ok: false,
      valid: false,
      reason: 'response_body_too_large',
      detail: 'legacy response body exceeds verification limit',
      response_chars: legacyBody.length,
      max_response_chars: TEACHER_HMAC_LIMITS.MAX_RESPONSE_BODY_CHARS,
      version: TEACHER_HMAC_VERSION,
    };
  }
  const body = legacy
    ? null
    : _canonicalResponseBody(response_body == null ? '' : response_body);
  if (body && !body.ok) {
    return {
      ok: false,
      valid: false,
      reason: body.error,
      detail: 'response body could not be canonicalized for HMAC verification',
      response_chars: body.response_chars,
      max_response_chars: body.max_response_chars,
      version: TEACHER_HMAC_VERSION,
    };
  }
  let teacher = null;
  let request = null;
  let ts = null;
  if (!legacy) {
    teacher = _normaliseTeacherId(binding.teacher_id);
    request = _normaliseRequestHash(binding.request_hash);
    ts = _normaliseTimestampMs(binding.timestamp_ms);
    const invalid = !teacher.ok ? teacher : (!request.ok ? request : (!ts.ok ? ts : null));
    if (invalid) {
      return {
        ok: false,
        valid: false,
        reason: 'binding_invalid_fields',
        detail: invalid.error,
        missing_field: invalid.field || null,
        version: TEACHER_HMAC_VERSION,
      };
    }
  }
  let key;
  try { key = _loadKeyOrThrow(); }
  catch (e) {
    return {
      ok: false,
      valid: false,
      reason: e.code || 'hmac_key_unavailable',
      detail: e.message,
      hint: e.hint,
      version: TEACHER_HMAC_VERSION,
    };
  }
  // Detect key rotation BEFORE we run the expensive HMAC compute. If the
  // active key's fingerprint differs from the binding's fingerprint, the row
  // was bound under a different key - surface that explicitly so the audit
  // trail records the rotation rather than reading "signature mismatch".
  const activeFingerprint = _keyFingerprint(key);
  if (activeFingerprint !== binding.key_fingerprint) {
    return {
      ok: false,
      valid: false,
      reason: 'hmac_key_mismatch_post_rotation',
      detail: 'binding.key_fingerprint does not match the active KOLM_TEACHER_HMAC_KEY - this row was bound under a different key, so the signature cannot be re-derived',
      active_key_fingerprint: activeFingerprint,
      binding_key_fingerprint: binding.key_fingerprint,
      version: TEACHER_HMAC_VERSION,
    };
  }
  const msg = legacy
    ? _legacyHashChainMessage({
        teacher_id: binding.teacher_id,
        request_hash: binding.request_hash,
        response_body: legacyBody,
        timestamp_ms: binding.timestamp_ms,
      })
    : _v2HashChainMessage({
        teacher_id: teacher.value,
        request_hash: request.value,
        response_sha256: body.response_sha256,
        timestamp_ms: ts.value,
      });
  const expected = crypto.createHmac(HMAC_ALGORITHM, key).update(msg).digest('hex');

  // CONSTANT-TIME COMPARE (W761 INVARIANT). Buffer.from(hex) yields equal-
  // length buffers because both sides are sha256 hex (64 chars); we still
  // guard with a length check because crypto.timingSafeEqual throws on
  // unequal-length inputs.
  let a, b;
  try {
    a = Buffer.from(String(binding.response_hmac), 'hex');
    b = Buffer.from(String(expected), 'hex');
  } catch (_) {
    return {
      ok: true,
      valid: false,
      reason: 'signature_mismatch',
      detail: 'binding.response_hmac is not valid hex',
      version: TEACHER_HMAC_VERSION,
    };
  }
  if (a.length !== b.length) {
    return {
      ok: true,
      valid: false,
      reason: 'signature_mismatch',
      detail: 'hmac byte length mismatch',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const matches = crypto.timingSafeEqual(a, b);
  if (matches) {
    return {
      ok: true,
      valid: true,
      reason: 'valid_signature',
      teacher_id: binding.teacher_id,
      response_sha256: legacy ? _sha256Hex(legacyBody) : body.response_sha256,
      message_sha256: _sha256Hex(msg),
      binding_sha256: _bindingPublicDigest(binding),
      verified_at: new Date().toISOString(),
      version: TEACHER_HMAC_VERSION,
    };
  }
  return {
    ok: true,
    valid: false,
    reason: 'signature_mismatch',
    detail: 'response_body does not match the bound HMAC - body was mutated post-binding OR a different body was passed for verification',
    version: TEACHER_HMAC_VERSION,
  };
}

// Attach a binding envelope onto a capture row in-place. Idempotent - if
// capture_row.teacher_binding is already present we leave it alone and
// return the unchanged row.
//
// Returns the (possibly mutated) capture row reference. Pure aside from the
// idempotent attach mutation - no I/O.
export function attachBindingToCapture(capture_row, binding) {
  if (!capture_row || typeof capture_row !== 'object') return capture_row;
  if (capture_row.teacher_binding && typeof capture_row.teacher_binding === 'object') {
    // Idempotent - already bound. Surface a hint flag so the caller knows
    // the no-op happened intentionally.
    capture_row._teacher_binding_skipped = 'already_bound';
    return capture_row;
  }
  if (!binding || typeof binding !== 'object' || binding.ok !== true) {
    capture_row._teacher_binding_skipped = 'binding_envelope_invalid';
    return capture_row;
  }
  capture_row.teacher_binding = {
    version: binding.version,
    teacher_id: binding.teacher_id,
    request_hash: binding.request_hash,
    response_sha256: binding.response_sha256 || null,
    response_chars: Number.isFinite(Number(binding.response_chars)) ? Number(binding.response_chars) : null,
    response_hmac: binding.response_hmac,
    message_sha256: binding.message_sha256 || null,
    binding_sha256: binding.binding_sha256 || _bindingPublicDigest(binding),
    signed_at: binding.signed_at,
    timestamp_ms: binding.timestamp_ms,
    key_fingerprint: binding.key_fingerprint,
    headers_hash: binding.headers_hash || null,
    header_count: Number.isFinite(Number(binding.header_count)) ? Number(binding.header_count) : null,
    algorithm: binding.algorithm || HMAC_ALGORITHM,
    canonicalization: binding.canonicalization || null,
  };
  return capture_row;
}

// Verify a previously-bound capture row. Extracts the response body from
// the canonical capture shape (response | response_redacted | output) and
// runs verifyTeacherResponse. Convenience wrapper for the orchestrator.
export function verifyCaptureBinding(capture_row) {
  if (!capture_row || typeof capture_row !== 'object') {
    return {
      ok: false,
      valid: false,
      reason: 'binding_missing_fields',
      detail: 'capture_row arg is required',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const binding = capture_row.teacher_binding;
  if (!binding) {
    return {
      ok: false,
      valid: false,
      reason: 'binding_missing_fields',
      detail: 'capture_row.teacher_binding is absent - this row was never bound to a verified teacher response',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const body = capture_row.response != null
    ? capture_row.response
    : (capture_row.response_redacted != null
        ? capture_row.response_redacted
        : (capture_row.output != null ? capture_row.output : ''));
  return verifyTeacherResponse({ binding, response_body: body });
}

export default {
  TEACHER_HMAC_VERSION,
  HMAC_ALGORITHM,
  TEACHER_HMAC_KEY_ENV,
  MIN_KEY_BYTES,
  TEACHER_HMAC_LIMITS,
  bindTeacherResponse,
  verifyTeacherResponse,
  attachBindingToCapture,
  verifyCaptureBinding,
};
