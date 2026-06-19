// src/slsa-provenance.js
//
// TRACK CRYPTO-STD / S5 - emit an in-toto Statement + SLSA provenance predicate
// over a SIGNED kolm Agent Security-Review report, wrapped in a DSSE (Dead
// Simple Signing Envelope) and Ed25519-signed.
//
// WHY
//   Supply-chain tooling (Sigstore policy-controller, cosign, slsa-verifier, the
//   GitHub attestation ecosystem) speaks in-toto Statements and DSSE envelopes,
//   NOT bespoke JSON. Emitting the report as a SLSA provenance statement lets a
//   buyer feed a kolm readiness report into the same gate that already checks
//   their container provenance: subject = the report (by digest), predicate =
//   how kolm produced it. The native signature_ed25519 stays PRIMARY; this is an
//   ALTERNATE, ecosystem-native representation.
//
// SHAPE
//   in-toto Statement v1 (https://in-toto.io/Statement/v1):
//     { _type, subject:[{ name, digest:{ sha256 } }], predicateType, predicate }
//   SLSA Provenance v1 predicate (https://slsa.dev/provenance/v1):
//     { buildDefinition:{ buildType, externalParameters, internalParameters,
//                         resolvedDependencies }, runDetails:{ builder, metadata } }
//   DSSE envelope (https://github.com/secure-systems-lab/dsse):
//     { payloadType:'application/vnd.in-toto+json', payload:<base64>,
//       signatures:[{ keyid, sig:<base64> }] }
//
// PURITY
//   Every export is pure, ASCII-only, and NEVER throws. A bad report yields a
//   well-formed-but-empty statement; a missing signer yields an UNSIGNED DSSE
//   envelope (signatures:[]) rather than an exception.

import crypto from 'node:crypto';
import {
  sign,
  verify,
  keyFingerprint,
  loadOrCreateDefaultSigner,
} from './ed25519.js';
import { canonicalizeReport } from './attestation-report-builder.js';
import { SLSA_PROFILE_IDS, getSlsaProfile } from './slsa-profile-registry.js';

export const SLSA_PROVENANCE_VERSION = 'kolm-slsa-v1';
export const ASR_REPORT_SLSA_PROFILE = getSlsaProfile(SLSA_PROFILE_IDS.ASR_REPORT);

export const IN_TOTO_STATEMENT_TYPE = ASR_REPORT_SLSA_PROFILE.statement_type;
export const SLSA_PREDICATE_TYPE = ASR_REPORT_SLSA_PROFILE.predicate_type;
export const KOLM_BUILD_TYPE = ASR_REPORT_SLSA_PROFILE.build_type;
export const KOLM_BUILDER_ID = ASR_REPORT_SLSA_PROFILE.builder_id;
export const INTOTO_PAYLOAD_TYPE = ASR_REPORT_SLSA_PROFILE.payload_type;

const _emptyHexSha256 = () => crypto.createHash('sha256').update('{}', 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Report digest: sha256 over canonicalizeReport(report) - the SAME canonical
// bytes the native Ed25519 signature covers, and the digest the transparency
// log + RFC 3161 timestamp already bind to (log_checkpoint.report_digest). This
// is the artifact identity the in-toto subject names. Falls back to the signed
// evidence_digest.value (the input-events digest), then to sha256('{}').
// ---------------------------------------------------------------------------
function reportDigestSha256(report) {
  try {
    const canon = canonicalizeReport(report);
    return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
  } catch {
    const ev = report && report.evidence_digest && typeof report.evidence_digest.value === 'string'
      ? report.evidence_digest.value
      : null;
    if (ev && /^[0-9a-f]{64}$/i.test(ev)) return ev.toLowerCase();
    return _emptyHexSha256();
  }
}

function _str(v) {
  return v == null ? null : String(v);
}

// ---------------------------------------------------------------------------
// toInTotoStatement(report) -> in-toto Statement v1 with a SLSA provenance v1
// predicate. The subject is the report itself (name = report_id, digest =
// sha256 of the canonical report). The input AuditEvents digest
// (evidence_digest) is recorded as a resolved dependency, which is exactly its
// SLSA role: the materials the build consumed. Pure, ASCII, never throws.
// ---------------------------------------------------------------------------
export function toInTotoStatement(report) {
  const r = report && typeof report === 'object' ? report : {};
  const sig = r.signature_ed25519 && typeof r.signature_ed25519 === 'object' ? r.signature_ed25519 : {};
  const subjectName = _str(r.report_id) || 'kolm-asr-report';
  const digest = reportDigestSha256(r);

  const ev = r.evidence_digest && typeof r.evidence_digest === 'object' ? r.evidence_digest : null;
  const resolvedDependencies = [];
  if (ev && typeof ev.value === 'string' && /^[0-9a-f]{64}$/i.test(ev.value)) {
    resolvedDependencies.push({
      name: 'audit-events',
      digest: { sha256: ev.value.toLowerCase() },
      annotations: { event_count: Number.isFinite(Number(ev.event_count)) ? Number(ev.event_count) : null },
    });
  }

  const subj = r.subject && typeof r.subject === 'object' ? r.subject : {};

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: subjectName, digest: { sha256: digest } },
    ],
    predicateType: SLSA_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: KOLM_BUILD_TYPE,
        externalParameters: {
          subject: _str(subj.name),
          source: _str(subj.source),
          tier: _str(r.tier),
        },
        internalParameters: {
          schema: _str(r.schema),
          report_version: _str(r.report_version),
          spec_version: _str(r.spec_version),
        },
        resolvedDependencies,
      },
      runDetails: {
        builder: {
          id: KOLM_BUILDER_ID,
          version: { 'kolm-attestation-report-builder': _str(r.schema) },
        },
        metadata: {
          invocationId: subjectName,
          startedOn: _str(r.generated_at),
          finishedOn: _str(sig.signed_at) || _str(r.generated_at),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DSSE Pre-Authentication Encoding (PAE), per the DSSE spec:
//   PAE(type, body) =
//     "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
// where SP is a single ASCII space (0x20) and LEN is the ASCII-decimal byte
// length. The signature covers PAE, not the bare payload - this is what defeats
// a payloadType-confusion attack.
// ---------------------------------------------------------------------------
function dssePae(payloadType, payloadBytes) {
  const typeBuf = Buffer.from(String(payloadType), 'utf8');
  const header = Buffer.from(
    `DSSEv1 ${typeBuf.length} ${payloadType} ${payloadBytes.length} `,
    'utf8',
  );
  return Buffer.concat([header, payloadBytes]);
}

function resolveSigner(signer) {
  if (signer && signer.privateKey) return signer;
  try { return loadOrCreateDefaultSigner(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// toDsseEnvelope(statement, signer?) -> a DSSE envelope. The payload is the
// JSON statement (base64, standard alphabet per the DSSE spec), payloadType is
// application/vnd.in-toto+json, and the Ed25519 signature is over PAE. Returns
// an UNSIGNED envelope (signatures:[]) when no signer is available. Pure, ASCII,
// never throws.
// ---------------------------------------------------------------------------
export function toDsseEnvelope(statement, signer) {
  const payloadType = INTOTO_PAYLOAD_TYPE;
  let payloadBytes;
  try { payloadBytes = Buffer.from(JSON.stringify(statement == null ? {} : statement), 'utf8'); }
  catch { payloadBytes = Buffer.from('{}', 'utf8'); }

  const env = {
    payloadType,
    payload: payloadBytes.toString('base64'),
    signatures: [],
  };

  const s = resolveSigner(signer);
  if (!s || !s.privateKey) return env;
  try {
    const pae = dssePae(payloadType, payloadBytes);
    // ed25519.sign returns base64url; DSSE carries the signature as standard
    // base64, so re-encode the same raw bytes.
    const sigB64url = sign(s.privateKey, pae);
    const sigB64 = Buffer.from(sigB64url, 'base64url').toString('base64');
    const keyid = s.key_fingerprint || (s.publicKey ? keyFingerprint(s.publicKey) : '');
    env.signatures.push({ keyid, sig: sigB64 });
  } catch {
    // leave the envelope unsigned rather than throw
  }
  return env;
}

// ---------------------------------------------------------------------------
// verifyDsse(env, publicKeyPem) -> bool. Reconstructs PAE from the carried
// payloadType + base64 payload and checks each Ed25519 signature against the
// public key. Pure, offline, never throws. Returns true if ANY signature
// verifies.
// ---------------------------------------------------------------------------
export function verifyDsse(env, publicKeyPem) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) return false;
    if (typeof env.payload !== 'string') return false;
    const sigs = Array.isArray(env.signatures) ? env.signatures : [];
    if (!sigs.length) return false;

    const payloadBytes = Buffer.from(env.payload, 'base64');
    const pae = dssePae(env.payloadType || INTOTO_PAYLOAD_TYPE, payloadBytes);

    for (const s of sigs) {
      if (!s || typeof s.sig !== 'string' || s.sig.length === 0) continue;
      // Convert standard-base64 DSSE sig back to base64url for ed25519.verify.
      const sigB64url = Buffer.from(s.sig, 'base64').toString('base64url');
      if (verify(publicKeyPem, pae, sigB64url)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Build + wrap in one call. Returns { statement, envelope }.
export function toDsseProvenance(report, signer) {
  const statement = toInTotoStatement(report);
  const envelope = toDsseEnvelope(statement, signer);
  return { statement, envelope };
}

export const SLSA_PROVENANCE_SPEC = {
  version: SLSA_PROVENANCE_VERSION,
  profile_id: ASR_REPORT_SLSA_PROFILE.id,
  product_surface: ASR_REPORT_SLSA_PROFILE.product_surface,
  owner_module: ASR_REPORT_SLSA_PROFILE.owner_module,
  statement_type: IN_TOTO_STATEMENT_TYPE,
  predicate_type: SLSA_PREDICATE_TYPE,
  build_type: KOLM_BUILD_TYPE,
  builder_id: KOLM_BUILDER_ID,
  payload_type: INTOTO_PAYLOAD_TYPE,
  conformance: ASR_REPORT_SLSA_PROFILE.conformance,
  slsa_build_l3_claim_allowed: ASR_REPORT_SLSA_PROFILE.slsa_build_l3_claim_allowed,
};

export default {
  toInTotoStatement,
  toDsseEnvelope,
  verifyDsse,
  toDsseProvenance,
};
