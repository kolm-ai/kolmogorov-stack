// kolm-verify.js - REAL, dependency-free, fully-offline verification of a
// kolm-audit receipt's Ed25519 signature, in the browser, using WebCrypto.
//
// This is the product-led proof for kolm: a buyer pastes the signed evidence
// JSON we hand them and confirms - with no upload, no kolm server, no shared
// secret - that the bytes were signed by the holder of the embedded public key
// and have not been altered since. Asymmetric signatures mean the verifier
// needs only the public key, which travels inside the receipt.
//
// It does ACTUAL cryptography. There are no canned "OK" lines: if this browser
// lacks native Ed25519, or the signature does not check, it says so. The
// canonicalization here is byte-identical to src/receipt-schema.js
// (canonicalForSigning) and the signing path in src/gateway-receipt.js, so a
// receipt this library accepts is the same one the CLI / SDK accept.
//
// Usage:
//   import { verifyReceipt } from '/kolm-verify.js';
//   const result = await verifyReceipt(receiptObject, { pinnedPublicKeyPem });
//   // result = { ok, reason?, key_fingerprint?, checks: [{name, ok, detail}] }
//
// Also exposed as window.kolmVerify for plain <script> pages.

// Canonical field order - MUST match src/receipt-schema.js ALL_FIELDS exactly.
// The signature covers JSON.stringify of these keys (present ones only), in
// this order, with no whitespace. signature_ed25519 is not in this list, so it
// is naturally excluded from the signed payload (a signature can't cover
// itself).
export const ALL_FIELDS = [
  'schema', 'receipt_id', 'timestamp', 'namespace_id', 'route_decision',
  'provider', 'model', 'artifact_id', 'confidence', 'fallback_reason',
  'input_hash', 'output_hash', 'capture_eligible', 'capture_id',
  'redaction_applied', 'input_tokens', 'output_tokens', 'cost_usd',
  'signing_key_id', 'verify_url',
];

export const ED25519_SPEC = 'kolm-ed25519-v1';
export const ED25519_ALG = 'ed25519';

export function canonicalForSigning(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('canonicalForSigning: receipt must be an object');
  }
  const out = {};
  for (const k of ALL_FIELDS) {
    if (k in receipt) out[k] = receipt[k];
  }
  return JSON.stringify(out);
}

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

// Strip PEM armor and decode the SPKI DER bytes.
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

// keyFingerprint - SHA-256 over the SPKI DER, first 32 hex chars (128-bit).
// Matches src/ed25519.js keyFingerprint() byte-for-byte so the value a buyer
// reads here equals the signing_key_id printed by the CLI.
export async function keyFingerprintFromPem(publicKeyPem) {
  const der = pemToDer(publicKeyPem);
  const digest = await crypto.subtle.digest('SHA-256', der);
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

function ed25519Available() {
  return !!(globalThis.crypto && crypto.subtle && typeof crypto.subtle.importKey === 'function');
}

// verifyReceipt - the real check. Returns { ok, reason?, key_fingerprint?, checks[] }.
// Every entry in `checks` is the outcome of a genuine operation; none are
// pre-filled. NEVER throws - bad input yields ok:false with a reason.
//
// opts.pinnedPublicKeyPem (optional): require the receipt's embedded key to
// equal a key you trust (e.g. kolm's published issuer key). Without it, the
// check proves "signed by the holder of THIS key, untampered" - pin to also
// prove "and that key is the one I expected".
export async function verifyReceipt(receipt, opts = {}) {
  const checks = [];
  const fail = (reason) => ({ ok: false, reason, checks });

  if (typeof receipt === 'string') {
    try { receipt = JSON.parse(receipt); }
    catch (e) { return fail('input is not valid JSON: ' + e.message); }
  }
  if (!receipt || typeof receipt !== 'object') return fail('receipt must be a JSON object');

  const block = receipt.signature_ed25519;
  if (!block || typeof block !== 'object') return fail('receipt has no signature_ed25519 block');
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
  try { canonical = canonicalForSigning(receipt); }
  catch (e) { return fail('cannot canonicalize receipt: ' + e.message); }
  checks.push({ name: 'canonical payload rebuilt', ok: true, detail: `${canonical.length} bytes over ${ALL_FIELDS.filter((k) => k in receipt).length} fields` });

  // 2. Independently recompute the key fingerprint and cross-check the claim.
  let der, fp;
  try {
    der = pemToDer(block.public_key);
    fp = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', der))).slice(0, 32);
  } catch (e) { return fail('cannot read public_key: ' + e.message); }
  if (block.key_fingerprint && block.key_fingerprint !== fp) {
    checks.push({ name: 'key fingerprint matches public_key', ok: false, detail: `claimed ${block.key_fingerprint.slice(0, 12)}… vs actual ${fp.slice(0, 12)}…` });
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

  return { ok: true, key_fingerprint: fp, checks };
}

// UMD-ish global for plain <script src> pages.
if (typeof window !== 'undefined') {
  window.kolmVerify = { verifyReceipt, canonicalForSigning, keyFingerprintFromPem, pemToDer, ALL_FIELDS };
}
