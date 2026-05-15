// Provenance credentials for kolm artifacts and inferences.
//
// This is kolm's own credential schema — NOT a real C2PA assertion library.
// The schema borrows the shape (claim_generator, ingredients, assertions,
// signature) so that a future C2PA conformance pass can ship by swapping the
// signer for a real Content Authenticity Initiative library. Until then we
// avoid the word "C2PA" outside this comment so we don't claim conformance
// we haven't earned.
//
// Two callsites:
//   1) Artifact build (src/artifact.js) — embeds an artifact-scoped credential
//      in the receipt and in a sidecar `credential.json` inside the .kolm zip.
//   2) Runtime emission (src/runtime.js + src/router.js /v1/run) — emits an
//      output-scoped credential per invocation, signed with the artifact's
//      credential as a parent ingredient. Chain is auditable offline.
//
// Why this is honest:
// - We sign with HMAC-SHA256 (the same secret that already chains receipts).
// - We do NOT claim "tamper-proof" — we say "tamper-evident".
// - We do NOT claim public verification — verification requires the secret
//   (or a future Ed25519 swap). Documented in the manifest.

import crypto from 'node:crypto';
import { canonicalJson } from './cid.js';

const SPEC = 'kolm-credential/0.1';
const CLAIM_GENERATOR = 'kolm/0.1 (RS-1 reference impl)';

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

// Build an artifact credential. Returns a JSON-serializable object that
// embeds in the receipt and as `credential.json` in the .kolm zip.
//
// Required:
//   secret         — HMAC secret (same as receipt signer)
//   artifact_hash  — sha256 of the manifest JSON
//   cid            — content identifier (kolm CID, sha256-based)
//   k_score        — final K-score
//   base_model     — pointer to teacher model
//   signed_at      — ISO timestamp
//
// Optional:
//   judge_id, tier, ingredients[]
export function buildArtifactCredential({
  secret, artifact_hash, cid, k_score, base_model, signed_at,
  judge_id, tier, ingredients,
}) {
  if (!secret) throw new Error('provenance: signing secret required');
  const body = {
    spec: SPEC,
    type: 'artifact',
    claim_generator: CLAIM_GENERATOR,
    artifact_hash,
    cid,
    assertions: {
      'kolm.k_score': typeof k_score === 'number' ? k_score : null,
      'kolm.base_model': base_model || null,
      'kolm.judge_id': judge_id || null,
      'kolm.tier': tier || null,
    },
    ingredients: Array.isArray(ingredients) ? ingredients : [],
    signed_at: signed_at || new Date().toISOString(),
    signature_alg: 'hmac-sha256',
  };
  const canon = canonicalJson(body);
  body.signature = hmac(secret, canon);
  return body;
}

// Build an output (per-inference) credential. The artifact credential is
// referenced as an ingredient so verifiers can walk the chain offline.
//
// Required:
//   secret              — HMAC secret
//   artifact_credential — the credential JSON for the .kolm that produced this
//   output_hash         — sha256 of the canonical output JSON
//   request_id          — server-generated request id (audit join key)
export function buildOutputCredential({
  secret, artifact_credential, output_hash, request_id, model_pointer,
  k_floor, signed_at,
}) {
  if (!secret) throw new Error('provenance: signing secret required');
  if (!artifact_credential || !artifact_credential.signature) {
    throw new Error('provenance: parent artifact_credential required');
  }
  const body = {
    spec: SPEC,
    type: 'output',
    claim_generator: CLAIM_GENERATOR,
    output_hash,
    request_id: request_id || null,
    parent: {
      artifact_hash: artifact_credential.artifact_hash,
      cid: artifact_credential.cid,
      signature: artifact_credential.signature,
    },
    assertions: {
      'kolm.model_pointer': model_pointer || null,
      'kolm.k_floor': typeof k_floor === 'number' ? k_floor : null,
      'kolm.runtime': 'kolm-node/0.1',
    },
    signed_at: signed_at || new Date().toISOString(),
    signature_alg: 'hmac-sha256',
  };
  const canon = canonicalJson(body);
  body.signature = hmac(secret, canon);
  return body;
}

// Verify a credential (artifact or output). Returns { valid, reason }.
// For artifacts, only the body signature is checked.
// For outputs, the parent.signature must also match what's in the credential
// (i.e., the output was issued against this exact artifact build).
export function verifyCredential(credential, secret) {
  if (!credential || typeof credential !== 'object') return { valid: false, reason: 'missing credential' };
  if (credential.spec !== SPEC) return { valid: false, reason: 'wrong spec' };
  if (!credential.signature) return { valid: false, reason: 'missing signature' };
  const { signature, ...rest } = credential;
  const canon = canonicalJson(rest);
  const expected = hmac(secret, canon);
  if (expected !== signature) return { valid: false, reason: 'signature mismatch' };
  return { valid: true };
}

export const PROVENANCE_SPEC = SPEC;
