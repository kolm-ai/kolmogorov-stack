// src/intoto-receipt.js
//
// W921 BET-3 - emit a kolm gateway/inference RECEIPT as an in-toto ITE-6 /
// SLSA-aligned ATTESTATION and an OpenSSF Model-Signing-compatible bundle, so a
// buyer's existing supply-chain tooling (cosign verify-attestation, in-toto
// verify, GUAC, Tekton Chains, the OpenSSF model-signing verifier) can ingest a
// kolm receipt WITHOUT a custom parser.
//
// WHY THIS IS SEPARATE FROM intoto-slsa.js / govern-provenance.js:
//   Those modules attest a *.kolm ARTIFACT* (the compiled, sealed model file:
//   subject = the artifact bytes, predicate = SLSA Provenance v1 describing the
//   BUILD - teacher/student/corpus). This module attests a single *INFERENCE
//   EVENT* (subject = the receipt + the model output it covers, predicate =
//   what the kolm-audit-1 receipt records about that call - provider, model,
//   route decision, tokens, cost, redactions). Build-time vs. run-time. We
//   REUSE the DSSE PAE + envelope machinery from intoto-slsa.js so there is one
//   wire-format implementation, and the Ed25519 primitives from ed25519.js so
//   there is one crypto implementation. No new PAE, no new crypto.
//
// SCOPE / Constraints (mirrors intoto-slsa.js discipline): an Ed25519 signature
// proves KEY CUSTODY over the receipt's claims - it is "authenticated," not a
// proof-of-correct-compute. We never assert that a particular GPU ran a
// particular model; the predicate only restates what the receipt itself
// records. The conformance string says exactly that.
//
// STANDARDS (web-confirmed 2026-05-29):
//   * in-toto Statement v1 - _type "https://in-toto.io/Statement/v1", a
//     non-empty `subject` array of ResourceDescriptors each with a non-empty
//     `digest` (sha256 hex), a `predicateType` URI, and a `predicate` object.
//     (in-toto/attestation spec/v1/statement.md)
//   * SLSA / ITE-6 - the in-toto attestation framework; a custom predicateType
//     is permitted alongside the standard SLSA ones. We mint a kolm inference
//     predicateType and also accept the SLSA provenance type for cross-tooling.
//   * OpenSSF Model Signing (OMS) - a DETACHED Sigstore-bundle-shaped file whose
//     DSSE envelope wraps an in-toto Statement; subjects are (path/name, digest)
//     pairs; predicateType "https://model_signing/signature/v1.0". We emit a
//     bundle of that shape so the OMS verifier can read a kolm inference proof.
//     (sigstore/model-transparency, ossf/model-signing-spec)
//
// DETERMINISM: core logic never reads the wall clock or a global RNG. Any
// timestamp is taken from the receipt (receipt.timestamp / signed_at) or from
// an explicit `issued_at` parameter; callers wanting "now" pass it in.

import crypto from 'node:crypto';
import { canonicalJson } from './cid.js';
import {
  pae,
  buildInTotoStatement,
  buildDsseEnvelope,
  verifyDsseEnvelope,
  INTOTO_STATEMENT_TYPE,
  INTOTO_DSSE_PAYLOAD_TYPE,
} from './intoto-slsa.js';
import { keyFingerprint, publicKeyJwk } from './ed25519.js';

export const INTOTO_RECEIPT_VERSION = 'w921-intoto-receipt-v1';

// ---------------------------------------------------------------------------
// Authoritative type URIs (primary sources, see header).
// ---------------------------------------------------------------------------
// kolm's own predicate for an inference event (ITE-6 custom predicateType).
export const KOLM_INFERENCE_PREDICATE_TYPE = 'https://kolm.ai/attestations/inference/v1';
// OpenSSF Model Signing signature predicateType (web-confirmed).
export const OMS_SIGNATURE_PREDICATE_TYPE = 'https://model_signing/signature/v1.0';
// Re-export the in-toto Statement type from the canonical source so callers
// depend on a single constant.
export { INTOTO_STATEMENT_TYPE };

// Constraints string - Ed25519 over the receipt's own claims. Never upgrade to
// a compute-proof or hardware-attestation claim here.
export const KOLM_INFERENCE_CONFORMANCE =
  'in-toto Statement v1 + ITE-6 inference predicate (Ed25519 key-custody attestation; not proof-of-compute)';

const HEX_RE = /^[0-9a-f]+$/i;

// ---------------------------------------------------------------------------
// _sha256Hex(s) - full 64-hex sha256 of a UTF-8 string. Used to give the
// Statement a robust, FULL-length subject digest (the receipt's own
// input_hash/output_hash are deliberately truncated `sha256:<16..64hex>` for
// grep-ability, which is too short to be a canonical in-toto subject digest).
// ---------------------------------------------------------------------------
function _sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

// Pull the hex out of a kolm short hash `sha256:<hex>` (or pass a bare hex
// through). Returns null when there is no usable hex.
function _hexFromShortHash(v) {
  if (typeof v !== 'string') return null;
  const m = /^sha256:([0-9a-f]{8,64})$/i.exec(v);
  if (m) return m[1].toLowerCase();
  if (HEX_RE.test(v) && v.length >= 8 && v.length <= 64) return v.toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// canonicalReceiptForDigest(receipt) - a stable byte image of the receipt for
// use as a subject digest. Excludes the signature blocks (a seal must not cover
// itself, and re-signing identical claims must not change the subject). Sorted
// keys via canonicalJson so the digest is reproducible across re-serialization.
// ---------------------------------------------------------------------------
export function canonicalReceiptForDigest(receipt) {
  const r = receipt && typeof receipt === 'object' ? { ...receipt } : {};
  delete r.signature_ed25519;
  delete r.signature; // legacy HMAC field, if present
  delete r.anchor;    // non-signed transparency anchor block (additive)
  return canonicalJson(r);
}

// ---------------------------------------------------------------------------
// receiptSubjects(receipt) - the in-toto subject array for an inference receipt.
//
// Two subjects when an output hash is present:
//   1. the receipt itself        name "receipt:<receipt_id>"  digest = sha256(canonical receipt)
//   2. the model output it covers name "output:<receipt_id>"  digest = output_hash hex
// Always at least the receipt subject. Each subject carries a non-empty digest,
// satisfying the in-toto v1 requirement. NEVER fabricates a digest.
// ---------------------------------------------------------------------------
export function receiptSubjects(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const rid = typeof r.receipt_id === 'string' && r.receipt_id ? r.receipt_id : 'unknown';
  const subjects = [];

  const receiptDigest = _sha256Hex(canonicalReceiptForDigest(r));
  const receiptSubj = {
    name: `receipt:${rid}`,
    digest: { sha256: receiptDigest },
  };
  const ann = {};
  if (typeof r.verify_url === 'string' && r.verify_url) ann.verify_url = r.verify_url;
  if (typeof r.timestamp === 'string' && r.timestamp) ann.timestamp = r.timestamp;
  if (Object.keys(ann).length > 0) receiptSubj.annotations = ann;
  subjects.push(receiptSubj);

  const outHex = _hexFromShortHash(r.output_hash);
  if (outHex) {
    subjects.push({
      name: `output:${rid}`,
      digest: { sha256: outHex },
      annotations: { kind: 'model_output', truncated: outHex.length < 64 },
    });
  }
  return subjects;
}

// ---------------------------------------------------------------------------
// buildInferencePredicate(receipt) - the ITE-6 custom predicate restating the
// receipt's verifiable claims. Only emits a field when the receipt carries it
// (degrades, never fabricates). The `input_hash`/`output_hash` are carried as
// the receipt records them (truncated short hashes) so a verifier can correlate
// back to /v1/verify/<receipt_id>.
// ---------------------------------------------------------------------------
export function buildInferencePredicate(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const inference = {};
  const copy = [
    'receipt_id', 'timestamp', 'namespace_id', 'route_decision', 'provider',
    'model', 'artifact_id', 'confidence', 'fallback_reason', 'input_hash',
    'output_hash', 'capture_eligible', 'capture_id', 'redaction_applied',
    'input_tokens', 'output_tokens', 'cost_usd', 'signing_key_id', 'verify_url',
  ];
  for (const k of copy) {
    if (r[k] !== undefined) inference[k] = r[k];
  }
  // signature_ed25519 metadata (NOT the signature bytes themselves - those live
  // in the DSSE envelope). Carries the key fingerprint so a verifier can match
  // the signing key to the envelope.
  const sig = r.signature_ed25519;
  const signature_meta = sig && typeof sig === 'object'
    ? {
        alg: sig.alg || 'ed25519',
        key_fingerprint: sig.key_fingerprint || null,
        signed_at: sig.signed_at || null,
      }
    : null;

  return {
    schema: r.schema || 'kolm-audit-1',
    builder: { id: 'https://kolm.ai/gateway' },
    inference,
    signature_meta,
    conformance: KOLM_INFERENCE_CONFORMANCE,
  };
}

// ---------------------------------------------------------------------------
// toInTotoStatement(receipt, opts) -> in-toto v1 Statement (UNSIGNED).
//
//   {
//     _type: 'https://in-toto.io/Statement/v1',
//     subject: [{ name, digest:{ sha256 } }, ...],
//     predicateType,
//     predicate,
//   }
//
// opts.predicateType overrides the default kolm inference predicateType (e.g.
// pass the OMS predicateType for an OMS-shaped statement). opts.predicate
// overrides the auto-built inference predicate. Throws (via buildInTotoStatement)
// if no valid subject can be formed - but receiptSubjects always yields at least
// the receipt subject with a full sha256 digest, so a well-formed receipt always
// produces a valid Statement.
// ---------------------------------------------------------------------------
export function toInTotoStatement(receipt, opts = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('toInTotoStatement: receipt object required');
  }
  const subjects = opts.subjects || receiptSubjects(receipt);
  const predicateType = opts.predicateType || KOLM_INFERENCE_PREDICATE_TYPE;
  const predicate = opts.predicate || buildInferencePredicate(receipt);
  return buildInTotoStatement({ subjects, predicateType, predicate });
}

// ---------------------------------------------------------------------------
// signInTotoBundle(receipt, signer, opts) -> {
//   statement, envelope, bundle, predicateType, conformance, key_fingerprint
// }
//
// Build the Statement and wrap it in a DSSE envelope signed with the Ed25519
// `signer` ({privateKey, publicKey, key_fingerprint}). REUSES buildDsseEnvelope
// from intoto-slsa.js (same PAE + standard-base64 signature cosign expects).
//
// `bundle` is an OpenSSF-Model-Signing / Sigstore-bundle-SHAPED object: a
// mediaType + a verificationMaterial carrying the Ed25519 public key (as an
// RFC 8037 OKP JWK, reusing ed25519.publicKeyJwk) + the DSSE envelope. This is
// the detached, ingestible artifact a supply-chain verifier consumes.
// ---------------------------------------------------------------------------
export function signInTotoBundle(receipt, signer, opts = {}) {
  if (!signer || !signer.privateKey) {
    throw new Error('signInTotoBundle: signer with privateKey required');
  }
  const statement = toInTotoStatement(receipt, opts);
  const envelope = buildDsseEnvelope({
    statement,
    privateKey: signer.privateKey,
    publicKey: signer.publicKey,
    key_fingerprint: signer.key_fingerprint,
  });

  let kf = signer.key_fingerprint;
  if (!kf && signer.publicKey) {
    try { kf = keyFingerprint(signer.publicKey); } catch { kf = undefined; }
  }

  let jwk = null;
  if (signer.publicKey) {
    try { jwk = publicKeyJwk(signer.publicKey, kf); } catch { jwk = null; }
  }

  // Sigstore-bundle-shaped detached bundle (OMS-compatible). The mediaType is
  // the Sigstore bundle v0.3 media type; verificationMaterial carries a bare
  // public key (kolm self-managed Ed25519, not keyless Fulcio - stated plainly).
  const bundle = {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      publicKey: {
        hint: kf || null,
        // RFC 8037 OKP JWK so a JWKS-aware verifier can match /.well-known/jwks.json.
        jwk: jwk || null,
        // PEM form for verifiers that prefer SPKI.
        pem: signer.publicKey || null,
      },
      keyType: 'ed25519',
      keyless: false,
    },
    dsseEnvelope: envelope,
  };

  return {
    statement,
    envelope,
    bundle,
    predicateType: statement.predicateType,
    conformance: KOLM_INFERENCE_CONFORMANCE,
    key_fingerprint: kf || null,
    version: INTOTO_RECEIPT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// toOmsBundle(receipt, signer, opts) -> bundle (OpenSSF Model Signing shape).
//
// Convenience: an OMS-shaped bundle whose Statement uses the OMS signature
// predicateType and whose subjects are the receipt's (name, digest) pairs - 
// exactly the (file path, digest) pair list the OMS manifest expects. Reuses
// signInTotoBundle so there is one signing path.
// ---------------------------------------------------------------------------
export function toOmsBundle(receipt, signer, opts = {}) {
  const subjects = receiptSubjects(receipt).map((s) => ({
    // OMS manifests key files by path; map the receipt subject name to `name`
    // (the in-toto field) and retain it. Verifiers match purely by digest.
    name: s.name,
    digest: s.digest,
    ...(s.annotations ? { annotations: s.annotations } : {}),
  }));
  const predicate = opts.predicate || {
    // OMS manifest-style predicate: the file list, each by cryptographic hash.
    resources: subjects.map((s) => ({ name: s.name, digest: s.digest })),
    model_signing_version: '1.0',
    note: 'kolm inference receipt expressed as an OpenSSF Model-Signing-compatible manifest',
  };
  const signed = signInTotoBundle(receipt, signer, {
    subjects,
    predicateType: OMS_SIGNATURE_PREDICATE_TYPE,
    predicate,
  });
  return signed.bundle;
}

// ---------------------------------------------------------------------------
// verifyInTotoBundle(bundleOrEnvelope, opts) -> verdict. NEVER throws.
//
// Accepts either a full bundle ({ dsseEnvelope, verificationMaterial }) or a
// bare DSSE envelope. Verifies the Ed25519 signature over the PAE bytes
// (delegating to intoto-slsa.verifyDsseEnvelope) and re-checks the decoded
// Statement is a well-formed in-toto v1 Statement.
//
// publicKey resolution order:
//   1. explicit opts.publicKey (PEM)
//   2. bundle.verificationMaterial.publicKey.pem (the embedded key)
// When the key is taken from the bundle, the verdict flags `key_from_bundle`
// so callers know the key was not externally pinned (trust-on-first-use).
//
// When opts.subjectDigestMap is supplied (subject name -> sha256 hex of the
// real bytes), also confirm every subject digest matches - full content
// verification, not just signature.
// ---------------------------------------------------------------------------
export function verifyInTotoBundle(bundleOrEnvelope, opts = {}) {
  if (!bundleOrEnvelope || typeof bundleOrEnvelope !== 'object') {
    return { ok: false, reason: 'bundle/envelope missing or not an object' };
  }
  // Unwrap a bundle to its DSSE envelope + embedded key.
  let envelope = bundleOrEnvelope;
  let embeddedPem = null;
  let keyFromBundle = false;
  if (bundleOrEnvelope.dsseEnvelope) {
    envelope = bundleOrEnvelope.dsseEnvelope;
    const vm = bundleOrEnvelope.verificationMaterial;
    if (vm && vm.publicKey && typeof vm.publicKey.pem === 'string') {
      embeddedPem = vm.publicKey.pem;
    }
  }

  let publicKey = opts.publicKey || null;
  if (!publicKey && embeddedPem) {
    publicKey = embeddedPem;
    keyFromBundle = true;
  }
  if (!publicKey) {
    return { ok: false, reason: 'publicKey required (pass opts.publicKey or a bundle with an embedded key)' };
  }

  const base = verifyDsseEnvelope(envelope, { publicKey });
  if (!base.ok) {
    return { ok: false, reason: base.reason, key_from_bundle: keyFromBundle };
  }
  const statement = base.statement;

  // Re-validate the decoded Statement is a well-formed in-toto v1 Statement.
  if (!statement || statement._type !== INTOTO_STATEMENT_TYPE) {
    return { ok: false, reason: `decoded payload is not an in-toto v1 Statement (_type=${statement && statement._type})` };
  }
  if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
    return { ok: false, reason: 'Statement has no subjects' };
  }
  for (const s of statement.subject) {
    if (!s || !s.digest || typeof s.digest !== 'object' || Object.keys(s.digest).length === 0) {
      return { ok: false, reason: `subject "${s && s.name}" missing a non-empty digest` };
    }
  }

  // Optional content verification against real bytes.
  let subjects_matched = null;
  let subjects_total = null;
  if (opts.subjectDigestMap && typeof opts.subjectDigestMap === 'object') {
    const dm = opts.subjectDigestMap;
    subjects_total = statement.subject.length;
    subjects_matched = 0;
    const mismatches = [];
    for (const s of statement.subject) {
      const want = s.digest && s.digest.sha256;
      const have = dm[s.name];
      if (typeof want === 'string' && typeof have === 'string' && want.toLowerCase() === have.toLowerCase()) {
        subjects_matched += 1;
      } else {
        mismatches.push(s.name);
      }
    }
    if (subjects_matched !== subjects_total) {
      return {
        ok: false,
        reason: `subject digest mismatch: ${mismatches.join(', ')}`,
        key_from_bundle: keyFromBundle,
        subjects_matched, subjects_total,
        predicateType: statement.predicateType,
      };
    }
  }

  let kf;
  try { kf = keyFingerprint(publicKey); } catch { kf = undefined; }

  return {
    ok: true,
    statement,
    predicateType: statement.predicateType,
    key_fingerprint: kf,
    key_from_bundle: keyFromBundle,
    ...(subjects_total != null ? { subjects_matched, subjects_total } : {}),
    conformance: KOLM_INFERENCE_CONFORMANCE,
    version: INTOTO_RECEIPT_VERSION,
  };
}

export const INTOTO_RECEIPT_SPEC = {
  version: INTOTO_RECEIPT_VERSION,
  statement_type: INTOTO_STATEMENT_TYPE,
  inference_predicate_type: KOLM_INFERENCE_PREDICATE_TYPE,
  oms_predicate_type: OMS_SIGNATURE_PREDICATE_TYPE,
  payload_type: INTOTO_DSSE_PAYLOAD_TYPE,
  conformance: KOLM_INFERENCE_CONFORMANCE,
};
