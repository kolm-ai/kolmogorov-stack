// kolm-audit-verify.js - REAL, dependency-free, fully-offline verification of a
// kolm Agent Security-Review *audit report*'s Ed25519 signature, in the browser,
// using WebCrypto.
//
// This is the buyer-facing proof: a reviewer pastes the signed evidence-report
// JSON the vendor handed them and confirms - with no upload, no kolm server, no
// shared secret, no account - that the bytes were signed by the holder of the
// embedded public key and have NOT been altered since (a downgraded readiness
// number, a deleted finding, a flipped tamper-evident flag all break the check).
//
// It does ACTUAL cryptography. There are no canned "OK" lines: if this browser
// lacks native Ed25519, or the signature does not check, it says so plainly.
//
// The canonicalization here is byte-identical to src/attestation-report-
// builder.js (canonicalize / canonicalizeReport): recursive, key-sorted,
// whitespace-free JSON with the signature block excluded. A report this library
// accepts is the same one the Node builder/verifier accept. Keep the two in
// lock-step - if you change one, change the other.
//
// Usage:
//   import { verifyAuditReport } from '/kolm-audit-verify.js';
//   const result = await verifyAuditReport(reportObject);
//   // result = { ok, reason?, key_fingerprint?, checks: [{name, ok, detail}] }
//
// Also exposed as window.kolmAuditVerify for plain <script> pages.

export const AUDIT_REPORT_SCHEMA = 'kolm-audit-report-1';
export const ED25519_SPEC = 'kolm-ed25519-v1';
export const ED25519_ALG = 'ed25519';

// ---------------------------------------------------------------------------
// Canonicalization - MUST be byte-identical to src/attestation-report-builder.js.
// Recursive, key-sorted, whitespace-free JSON. Sorting keys makes the bytes
// independent of property order, so this browser code and the Node signer agree
// without sharing a field list. `undefined` is dropped (matching JSON.stringify);
// non-finite numbers serialize to 'null'.
// ---------------------------------------------------------------------------
export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return 'null';
}

export function canonicalizeReport(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('canonicalizeReport: envelope must be an object');
  }
  // Object rest-destructuring (CopyDataProperties) - byte-identical to the Node
  // builder's `const { signature_ed25519, ...rest } = envelope`. A plain
  // `rest[k] = envelope[k]` loop would diverge on a hostile `__proto__` key: the
  // assignment hits the Object.prototype __proto__ setter and silently drops the
  // key, whereas the Node spread copies it as an own data property. Using the
  // same construct on both sides keeps the signed bytes in lock-step.
  const { signature_ed25519, ...rest } = envelope;
  return canonicalize(rest);
}

// Normalize a PEM for whitespace-insensitive equality (line-ending / trailing-
// newline differences must not change identity).
export function normalizePem(pem) {
  return String(pem == null ? '' : pem).replace(/\s+/g, '');
}

// issuerProvenance - does the report's embedded signing key belong to a known
// kolm issuer? Pure, synchronous (PEM compare, no async digest), never throws.
// This is the second tier of trust: tier 1 (verifyAuditReport) proves "signed by
// the holder of the embedded key, untampered"; this proves "and that key is one
// kolm publishes" - without it, an attacker can re-sign a tampered report with
// their OWN key and tier 1 alone would still pass.
//
// keyring: { issuers: [{ kid, label, status, public_key }] }
// returns { recognized, kid?, label?, status?, embedded_key? }
export function issuerProvenance(report, keyring) {
  const out = { recognized: false };
  try {
    const block = report && typeof report === 'object' ? report.signature_ed25519 : null;
    const pem = block && typeof block === 'object' ? block.public_key : null;
    if (typeof pem !== 'string' || !pem) return out;
    const list = keyring && Array.isArray(keyring.issuers) ? keyring.issuers : [];
    const target = normalizePem(pem);
    for (const iss of list) {
      if (iss && typeof iss.public_key === 'string' && normalizePem(iss.public_key) === target) {
        return { recognized: true, kid: iss.kid || null, label: iss.label || null, status: iss.status || null, embedded_key: pem };
      }
    }
    out.embedded_key = pem;
  } catch (_) { /* never throw */ }
  return out;
}

// ---------------------------------------------------------------------------
// byte / key helpers (shared shape with public/kolm-verify.js).
// ---------------------------------------------------------------------------
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(b64url) {
  let s = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

export function pemToDer(pem) {
  if (typeof pem !== 'string') throw new Error('pemToDer: public_key must be a PEM string');
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!b64) throw new Error('pemToDer: no key body found in PEM');
  return base64ToBytes(b64);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 over the SPKI DER, first 32 hex chars (128-bit) - matches
// src/ed25519.js keyFingerprint() byte-for-byte.
export async function keyFingerprintFromPem(publicKeyPem) {
  const der = pemToDer(publicKeyPem);
  const digest = await crypto.subtle.digest('SHA-256', der);
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

function ed25519Available() {
  return !!(globalThis.crypto && crypto.subtle && typeof crypto.subtle.importKey === 'function');
}

// ---------------------------------------------------------------------------
// verifyAuditReport - the real check. Returns { ok, reason?, key_fingerprint?,
// checks[] }. Every entry in `checks` is the outcome of a genuine operation;
// none are pre-filled. NEVER throws - bad input yields ok:false with a reason.
//
// opts.pinnedPublicKeyPem (optional): require the report's embedded key to equal
// a key you trust. Without it, the check proves "signed by the holder of THIS
// key, untampered"; pin to also prove "and that key is the one I expected".
// ---------------------------------------------------------------------------
export async function verifyAuditReport(report, opts = {}) {
  const checks = [];
  const fail = (reason) => ({ ok: false, reason, checks });

  if (typeof report === 'string') {
    try { report = JSON.parse(report); }
    catch (e) { return fail('input is not valid JSON: ' + e.message); }
  }
  if (!report || typeof report !== 'object') return fail('report must be a JSON object');

  if (report.schema && report.schema !== AUDIT_REPORT_SCHEMA) {
    return fail(`unexpected schema: ${report.schema} (expected ${AUDIT_REPORT_SCHEMA})`);
  }
  checks.push({ name: 'schema', ok: true, detail: report.schema || '(none)' });

  const block = report.signature_ed25519;
  if (!block || typeof block !== 'object') return fail('report has no signature_ed25519 block');
  checks.push({ name: 'signature block present', ok: true, detail: `alg=${block.alg || '?'} spec=${block.spec || '?'}` });

  if (block.spec && block.spec !== ED25519_SPEC) return fail(`unexpected spec: ${block.spec}`);
  if (block.alg && block.alg !== ED25519_ALG) return fail(`unexpected alg: ${block.alg}`);
  if (typeof block.public_key !== 'string' || !block.public_key) return fail('signature block missing public_key');
  if (typeof block.signature !== 'string' || !block.signature) return fail('signature block missing signature');

  if (!ed25519Available()) {
    checks.push({ name: 'native Ed25519', ok: false, detail: 'this browser lacks WebCrypto Ed25519' });
    return { ok: false, reason: 'native Ed25519 unavailable in this browser (need Chrome 137+ / Safari 17+ / Firefox 129+); signature was NOT checked', checks };
  }

  // 1. Rebuild the exact signed bytes.
  let canonical;
  try { canonical = canonicalizeReport(report); }
  catch (e) { return fail('cannot canonicalize report: ' + e.message); }
  checks.push({ name: 'canonical payload rebuilt', ok: true, detail: `${canonical.length} bytes` });

  // 2. Independently recompute the key fingerprint and cross-check the claim.
  let der, fp;
  try {
    der = pemToDer(block.public_key);
    fp = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', der))).slice(0, 32);
  } catch (e) { return fail('cannot read public_key: ' + e.message); }
  // Coerce to string before compare/slice - a hostile report can put a number,
  // boolean or object here, and this function must never throw.
  const claimedFp = block.key_fingerprint == null ? null : String(block.key_fingerprint);
  if (claimedFp && claimedFp !== fp) {
    checks.push({ name: 'key fingerprint matches public_key', ok: false, detail: `claimed ${claimedFp.slice(0, 12)}… vs actual ${fp.slice(0, 12)}…` });
    return { ok: false, reason: 'key_fingerprint claim does not match public_key bytes', key_fingerprint: fp, checks };
  }
  checks.push({ name: 'key fingerprint matches public_key', ok: true, detail: fp });

  // 3. Optional pinning against a trusted issuer key.
  if (opts.pinnedPublicKeyPem) {
    const norm = (s) => s.replace(/\s+/g, '');
    if (norm(opts.pinnedPublicKeyPem) !== norm(block.public_key)) {
      checks.push({ name: 'pinned issuer key', ok: false, detail: 'embedded key != pinned key' });
      return { ok: false, reason: 'public_key does not match pinned issuer key', key_fingerprint: fp, checks };
    }
    checks.push({ name: 'pinned issuer key', ok: true, detail: 'matches expected issuer' });
  }

  // 4. The real Ed25519 verification.
  let ok;
  try {
    const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    const sig = base64UrlToBytes(block.signature);
    const msg = new TextEncoder().encode(canonical);
    ok = await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch (e) {
    checks.push({ name: 'Ed25519 signature', ok: false, detail: 'verify error: ' + e.message });
    return { ok: false, reason: 'Ed25519 verification raised: ' + e.message, key_fingerprint: fp, checks };
  }
  checks.push({ name: 'Ed25519 signature valid', ok, detail: ok ? 'signature matches payload' : 'signature does NOT match payload' });
  if (!ok) return { ok: false, reason: 'Ed25519 signature does not verify against the canonical payload', key_fingerprint: fp, checks };

  // 5. signed_at consistency. block.signed_at is NOT covered by the signature
  // (it lives in the block the signature excludes); generated_at IS. They are
  // equal at signing time, so a mismatch means the shown timestamp was edited
  // after signing - fail rather than display a clean pass over a forged date.
  if (block.signed_at != null && report.generated_at != null
      && String(block.signed_at) !== String(report.generated_at)) {
    checks.push({ name: 'signed_at matches signed generated_at', ok: false, detail: `block.signed_at=${String(block.signed_at)} ≠ generated_at=${String(report.generated_at)}` });
    return { ok: false, reason: 'signed_at does not match the signed generated_at (timestamp altered after signing)', key_fingerprint: fp, checks };
  }
  checks.push({ name: 'signed_at matches signed generated_at', ok: true, detail: String(report.generated_at || '(none)') });

  return { ok: true, key_fingerprint: fp, checks };
}

// UMD-ish global for plain <script src> pages.
if (typeof window !== 'undefined') {
  window.kolmAuditVerify = { verifyAuditReport, canonicalize, canonicalizeReport, keyFingerprintFromPem, pemToDer, normalizePem, issuerProvenance, AUDIT_REPORT_SCHEMA };
}
