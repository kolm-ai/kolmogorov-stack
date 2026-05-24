// W761-3 — Cryptographic binding of captures to verified teacher responses.
//
// Why this exists:
//   Capture poisoning attacks fall into two categories that the W808 statistical
//   anomaly detector + W750 copyright heuristic cannot catch:
//     1) MITM injection — an attacker on the wire to the teacher swaps the
//        response body before it reaches the proxy. Statistical anomaly only
//        flags rows that DRIFT from the baseline; a poisoned response carefully
//        crafted to mimic baseline tone slips through.
//     2) Cache poisoning — an attacker who can write to the response cache (or
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
//     NOT silent-pass with an empty key — that would be cryptographic theater.
//   - Keys shorter than 32 bytes are REFUSED with hmac_key_too_short. 32 bytes
//     is the minimum for SHA-256 HMAC to retain full collision resistance.
//   - Verification uses crypto.timingSafeEqual — never `===` on HMAC bytes.
//
// Anti-brittleness (W604):
//   - TEACHER_HMAC_VERSION is `w761-vN.M` and consumers MUST match with a
//     regex `/^w761-/` NOT literal equality.
//   - Algorithm and env var name are exported as constants.

import crypto from 'node:crypto';

export const TEACHER_HMAC_VERSION = 'w761-v1';
export const HMAC_ALGORITHM = 'sha256';
export const TEACHER_HMAC_KEY_ENV = 'KOLM_TEACHER_HMAC_KEY';
export const MIN_KEY_BYTES = 32;

// -----------------------------------------------------------------------------
// Key loader — honest envelopes for misconfiguration.
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
  // Accept hex or raw — the env var is most-commonly hex from openssl rand.
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
// key rotation. We expose first 16 hex chars of sha256(key) — too short for
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
// size — the verifier rehashes the body and compares.
function _hashChainMessage({ teacher_id, request_hash, response_body, timestamp_ms }) {
  const bodyHash = crypto.createHash('sha256')
    .update(String(response_body == null ? '' : response_body))
    .digest('hex');
  return String(teacher_id) + ':'
    + String(request_hash) + ':'
    + bodyHash + ':'
    + String(timestamp_ms);
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
  if (!teacher_id) {
    return {
      ok: false,
      error: 'missing_field',
      field: 'teacher_id',
      hint: 'pass {teacher_id: "<provider:model>"}',
      version: TEACHER_HMAC_VERSION,
    };
  }
  if (!request_hash) {
    return {
      ok: false,
      error: 'missing_field',
      field: 'request_hash',
      hint: 'pass {request_hash: sha256(canonical_request_body)} — the same value capture-store uses for dedupe',
      version: TEACHER_HMAC_VERSION,
    };
  }
  if (response_body == null) {
    return {
      ok: false,
      error: 'missing_field',
      field: 'response_body',
      hint: 'pass {response_body: "<raw body string or canonical JSON>"} — empty string is acceptable if the upstream really returned no body',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const ts = Number.isFinite(Number(timestamp_ms)) ? Number(timestamp_ms) : Date.now();

  let key;
  try { key = _loadKeyOrThrow(); }
  catch (e) {
    return { ok: false, error: e.code, hint: e.hint, version: TEACHER_HMAC_VERSION };
  }
  const msg = _hashChainMessage({ teacher_id, request_hash, response_body, timestamp_ms: ts });
  const response_hmac = crypto.createHmac(HMAC_ALGORITHM, key).update(msg).digest('hex');
  const key_fingerprint = _keyFingerprint(key);

  // response_headers is intentionally NOT covered by the HMAC — middleware
  // routinely adds / strips headers (CDN, gateway, observability) and a
  // header-binding would force a rebind on every hop. We record a HASH of
  // the headers so callers can detect header tampering as a SEPARATE
  // signal without invalidating the body-binding contract.
  let headers_hash = null;
  if (response_headers && typeof response_headers === 'object') {
    const sorted = Object.keys(response_headers).sort()
      .map((k) => k + '=' + String(response_headers[k] == null ? '' : response_headers[k]))
      .join('\n');
    headers_hash = crypto.createHash('sha256').update(sorted).digest('hex');
  }

  return {
    ok: true,
    version: TEACHER_HMAC_VERSION,
    teacher_id: String(teacher_id),
    request_hash: String(request_hash),
    response_hmac,
    signed_at: new Date(ts).toISOString(),
    timestamp_ms: ts,
    key_fingerprint,
    headers_hash,
    algorithm: HMAC_ALGORITHM,
  };
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
  let key;
  try { key = _loadKeyOrThrow(); }
  catch (e) {
    return {
      ok: false,
      valid: false,
      reason: e.code === 'hmac_key_not_configured' ? 'hmac_key_not_configured' : 'binding_missing_fields',
      detail: e.message,
      hint: e.hint,
      version: TEACHER_HMAC_VERSION,
    };
  }
  // Detect key rotation BEFORE we run the expensive HMAC compute. If the
  // active key's fingerprint differs from the binding's fingerprint, the row
  // was bound under a different key — surface that explicitly so the audit
  // trail records the rotation rather than reading "signature mismatch".
  const activeFingerprint = _keyFingerprint(key);
  if (activeFingerprint !== binding.key_fingerprint) {
    return {
      ok: false,
      valid: false,
      reason: 'hmac_key_mismatch_post_rotation',
      detail: 'binding.key_fingerprint does not match the active KOLM_TEACHER_HMAC_KEY — this row was bound under a different key, so the signature cannot be re-derived',
      active_key_fingerprint: activeFingerprint,
      binding_key_fingerprint: binding.key_fingerprint,
      version: TEACHER_HMAC_VERSION,
    };
  }
  const msg = _hashChainMessage({
    teacher_id: binding.teacher_id,
    request_hash: binding.request_hash,
    response_body: response_body == null ? '' : response_body,
    timestamp_ms: binding.timestamp_ms,
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
      verified_at: new Date().toISOString(),
      version: TEACHER_HMAC_VERSION,
    };
  }
  return {
    ok: true,
    valid: false,
    reason: 'signature_mismatch',
    detail: 'response_body does not match the bound HMAC — body was mutated post-binding OR a different body was passed for verification',
    version: TEACHER_HMAC_VERSION,
  };
}

// Attach a binding envelope onto a capture row in-place. Idempotent — if
// capture_row.teacher_binding is already present we leave it alone and
// return the unchanged row.
//
// Returns the (possibly mutated) capture row reference. Pure aside from the
// idempotent attach mutation — no I/O.
export function attachBindingToCapture(capture_row, binding) {
  if (!capture_row || typeof capture_row !== 'object') return capture_row;
  if (capture_row.teacher_binding && typeof capture_row.teacher_binding === 'object') {
    // Idempotent — already bound. Surface a hint flag so the caller knows
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
    response_hmac: binding.response_hmac,
    signed_at: binding.signed_at,
    timestamp_ms: binding.timestamp_ms,
    key_fingerprint: binding.key_fingerprint,
    headers_hash: binding.headers_hash || null,
    algorithm: binding.algorithm || HMAC_ALGORITHM,
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
      detail: 'capture_row.teacher_binding is absent — this row was never bound to a verified teacher response',
      version: TEACHER_HMAC_VERSION,
    };
  }
  const body = capture_row.response != null
    ? (typeof capture_row.response === 'string' ? capture_row.response : JSON.stringify(capture_row.response))
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
  bindTeacherResponse,
  verifyTeacherResponse,
  attachBindingToCapture,
  verifyCaptureBinding,
};
