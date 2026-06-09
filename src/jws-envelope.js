// src/jws-envelope.js
//
// TRACK CRYPTO-STD / S4 - represent a SIGNED kolm Agent Security-Review report
// as a standards-conformant JWS (RFC 7515, JSON Web Signature) so any off-the-
// shelf JOSE verifier can check it WITHOUT importing kolm code.
//
// WHY AN ALTERNATE REPRESENTATION
//   Every delivered report already carries a primary, offline-verifiable
//   Ed25519 signature (signature_ed25519 in src/attestation-report-builder.js).
//   That block is bespoke - a buyer verifies it with public/kolm-audit-verify.js
//   or one of the SDK ports. JWS does the same job in a format the wider
//   ecosystem (jose, node-jose, jwt libraries, KMS verifiers) already speaks: a
//   reviewer can paste the JWS into their existing JOSE tooling and get a green
//   check with no kolm-specific logic. The native signature_ed25519 stays
//   PRIMARY; this JWS is an ALTERNATE representation a caller can request.
//
// WHAT IS SIGNED
//   The JWS payload is canonicalizeReport(report) - the EXACT bytes the native
//   Ed25519 signature covers (signature_ed25519 + the detached evidence are
//   excluded, see attestation-report-builder.js). The JWS produces its own
//   Ed25519 signature over the RFC 7515 JWS Signing Input
//   (BASE64URL(protected) . BASE64URL(payload)), so the JWS signature bytes
//   differ from the native ones while binding the same report content.
//
// COSE / CBOR MIRROR (described, no dependency pulled - see docs/crypto-
//   standards.md): the same EdDSA signature maps to a COSE_Sign1 structure
//   (RFC 9052) with protected header { 1: -8 } (alg = EdDSA) and the canonical
//   report bytes as the COSE payload; Sig_structure ("Signature1") replaces the
//   JWS Signing Input. We do not ship a CBOR encoder; the mapping is documented
//   so an embedded / IoT verifier can reproduce it.

import {
  sign,
  verify,
  keyFingerprint,
  publicKeyJwk,
  loadOrCreateDefaultSigner,
} from './ed25519.js';
import { canonicalizeReport } from './attestation-report-builder.js';

export const JWS_ENVELOPE_VERSION = 'kolm-jws-v1';

// RFC 7515 protected-header `alg` for Ed25519 (RFC 8037 EdDSA).
export const JWS_ALG = 'EdDSA';
// JWT-style media type for the protected header `typ`. The payload is the JSON
// canonical report, so a JOSE/JWT verifier treats it as a JSON body.
export const JWS_TYP = 'JWT';

// ---------------------------------------------------------------------------
// Resolve a signer. Prefer an explicitly supplied { privateKey, publicKey,
// key_fingerprint }; otherwise fall back to the default per-machine / env
// signer (the same loader the report builder uses). Never throws here - callers
// that require a signer raise NO_SIGNER themselves.
// ---------------------------------------------------------------------------
function resolveSigner(signer) {
  if (signer && signer.privateKey && signer.publicKey) return signer;
  try { return loadOrCreateDefaultSigner(); } catch { return null; }
}

const _b64urlOfUtf8 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');

// ---------------------------------------------------------------------------
// toJwsGeneralJson(report, signer?) -> JWS General JSON Serialization
// (RFC 7515 section 7.2.1):
//
//   {
//     "payload": "<base64url(canonicalizeReport(report))>",
//     "signatures": [
//       { "protected": "<base64url({alg,typ,kid})>", "signature": "<base64url>" }
//     ]
//   }
//
// The protected header carries { alg:'EdDSA', typ:'JWT', kid:<fingerprint> }.
// The signature is Ed25519 over ASCII(protected '.' payload), per RFC 7515
// section 5.1. Throws NO_SIGNER when no signing key is available (mirrors
// signReport); canonicalizeReport throws only on a non-object report.
// ---------------------------------------------------------------------------
export function toJwsGeneralJson(report, signer) {
  const s = resolveSigner(signer);
  if (!s || !s.privateKey || !s.publicKey) {
    const err = new Error('toJwsGeneralJson: no Ed25519 signer available (set KOLM_ED25519_PRIVATE_KEY or allow a cached key)');
    err.code = 'NO_SIGNER';
    throw err;
  }
  const payloadStr = canonicalizeReport(report);
  const payloadB64 = _b64urlOfUtf8(payloadStr);
  const kid = s.key_fingerprint || keyFingerprint(s.publicKey);
  const protectedHeader = { alg: JWS_ALG, typ: JWS_TYP, kid };
  const protectedB64 = _b64urlOfUtf8(JSON.stringify(protectedHeader));
  const signingInput = protectedB64 + '.' + payloadB64;
  const signature = sign(s.privateKey, signingInput); // base64url
  return {
    payload: payloadB64,
    signatures: [
      { protected: protectedB64, signature },
    ],
  };
}

// ---------------------------------------------------------------------------
// verifyJws(jws, publicKeyPem) -> bool. Pure, offline, never throws.
//
// Accepts the General JSON object (or its JSON string), and tolerantly accepts
// a Flattened JSON form ({ payload, protected, signature }). Recomputes the
// RFC 7515 Signing Input from the carried base64url strings (NOT by re-
// canonicalizing the report), so a tampered payload fails. Requires the
// protected header alg to be EdDSA. Returns true if ANY signature verifies
// against the supplied public key.
// ---------------------------------------------------------------------------
export function verifyJws(jws, publicKeyPem) {
  try {
    let obj = jws;
    if (typeof obj === 'string') obj = JSON.parse(obj);
    if (!obj || typeof obj !== 'object') return false;
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) return false;
    if (typeof obj.payload !== 'string') return false;

    const sigs = Array.isArray(obj.signatures)
      ? obj.signatures
      : (typeof obj.protected === 'string' && typeof obj.signature === 'string'
          ? [{ protected: obj.protected, signature: obj.signature }]
          : []);
    if (!sigs.length) return false;

    for (const entry of sigs) {
      if (!entry || typeof entry.protected !== 'string' || typeof entry.signature !== 'string') continue;
      let hdr;
      try { hdr = JSON.parse(Buffer.from(entry.protected, 'base64url').toString('utf8')); }
      catch { continue; }
      if (!hdr || hdr.alg !== JWS_ALG) continue;
      const signingInput = entry.protected + '.' + obj.payload;
      if (verify(publicKeyPem, signingInput, entry.signature)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Decode the JWS payload back to the canonical report string. Convenience for a
// verifier that wants the bytes after a successful verifyJws (e.g. to re-derive
// the report digest). Never throws; returns null on bad input.
// ---------------------------------------------------------------------------
export function decodeJwsPayload(jws) {
  try {
    let obj = jws;
    if (typeof obj === 'string') obj = JSON.parse(obj);
    if (!obj || typeof obj.payload !== 'string') return null;
    return Buffer.from(obj.payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OKP JWK for the public key (RFC 8037): { kty:'OKP', crv:'Ed25519', x, ... }.
// A standards-conformant verifier imports this JWK directly into its JOSE
// library, or kolm publishes it at /.well-known/jwks.json.
// ---------------------------------------------------------------------------
export function publicJwk(publicKeyPem, kid) {
  return publicKeyJwk(publicKeyPem, kid);
}

// Convenience: pull the OKP JWK straight from a signed report's embedded public
// key, keyed by its fingerprint. Returns null when the report carries no key.
export function reportPublicJwk(report) {
  const block = report && typeof report === 'object' ? report.signature_ed25519 : null;
  const pem = block && typeof block.public_key === 'string' ? block.public_key : null;
  if (!pem) return null;
  try { return publicKeyJwk(pem, block.key_fingerprint); }
  catch { return null; }
}

export const JWS_ENVELOPE_SPEC = {
  version: JWS_ENVELOPE_VERSION,
  alg: JWS_ALG,
  typ: JWS_TYP,
  serialization: 'rfc7515-general-json',
  payload: 'canonicalizeReport(report)',
};

export default { toJwsGeneralJson, verifyJws, publicJwk, reportPublicJwk, decodeJwsPayload };
