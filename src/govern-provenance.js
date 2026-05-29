// src/govern-provenance.js
//
// W921 Govern / Receipts & Compliance — in-toto v1 / SLSA Provenance v1 build
// provenance for .kolm artifacts, exposed as the high-level, artifact-shaped
// API the task brief names: buildSlsaProvenance(artifact) -> in-toto statement.
//
// This module is a THIN, ergonomic facade over the already-built + tested
// src/intoto-slsa.js (it imports those primitives; it does NOT re-implement
// PAE/DSSE/Statement assembly). The reason it exists separately: intoto-slsa.js
// speaks in {manifest, hashes, lineage, ed25519Signer, subjectDigests} — the
// shape artifact.js holds at build time. A caller who has a higher-level
// "artifact" object (manifest + cid + artifact_hash + lineage + per-file
// digests) wants a single buildSlsaProvenance(artifact) call. This adapter
// normalizes that object into the intoto-slsa.js inputs and returns either the
// in-toto Statement (unsigned) or a full DSSE-enveloped attestation (signed).
//
// SCOPE / Constraints: this emits "SLSA Provenance v1 (Build L2 shape)" — signed
// and non-forgeable because the key is custodied, NOT Build L3 (which requires a
// hardened, identity-bound builder kolm does not provide). We never assert
// hardened-builder properties. The conformance string is re-exported verbatim
// from intoto-slsa.js so it can only ever say what that module says.

import {
  INTOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  INTOTO_DSSE_PAYLOAD_TYPE,
  KOLM_BUILD_TYPE,
  KOLM_SLSA_CONFORMANCE,
  buildInTotoStatement,
  buildSlsaProvenancePredicate,
  resourceDescriptorsFromLineage,
  buildDsseEnvelope,
  verifyDsseEnvelope,
  verifyInTotoAgainstArtifact,
  emitArtifactAttestation,
} from './intoto-slsa.js';

export const GOVERN_PROVENANCE_VERSION = 'w921-provenance-v1';

const HEX64_RE = /^[0-9a-f]{64}$/i;

// ---------------------------------------------------------------------------
// _normalizeArtifact(artifact) -> { manifest, hashes, lineage, artifact_hash,
//   cid, jobId, builderVersion, subjectDigests, issued_at, startedOn }
//
// Accepts several shapes so the same call works whether the caller passes a
// raw .kolm manifest, a {manifest,hashes,lineage,...} bag, or a richer object.
// Tolerant of missing fields — degrades, never throws on shape.
// ---------------------------------------------------------------------------
function _normalizeArtifact(artifact = {}) {
  const a = artifact && typeof artifact === 'object' ? artifact : {};
  const manifest = a.manifest && typeof a.manifest === 'object' ? a.manifest : a;
  const hashes = a.hashes && typeof a.hashes === 'object' ? a.hashes
    : (manifest.hashes && typeof manifest.hashes === 'object' ? manifest.hashes : {});
  const lineage = a.lineage || manifest.lineage || null;
  const artifact_hash = a.artifact_hash || manifest.artifact_hash || null;
  const cid = a.cid != null ? a.cid : manifest.cid;
  const jobId = a.jobId || a.job_id || manifest.job_id || manifest.jobId || null;
  const builderVersion = a.builderVersion || a.builder_version || manifest.builder_version || manifest.version || null;
  // subjectDigests: prefer explicit; else derive from per-file digest map.
  let subjectDigests = a.subjectDigests || a.subject_digests || null;
  if (!subjectDigests && a.file_digests && typeof a.file_digests === 'object') {
    subjectDigests = a.file_digests;
  }
  return {
    manifest,
    hashes,
    lineage,
    artifact_hash,
    cid,
    jobId,
    builderVersion,
    subjectDigests,
    issued_at: a.issued_at || manifest.issued_at || null,
    startedOn: a.startedOn || a.started_on || null,
    builderId: a.builderId || a.builder_id || null,
  };
}

// ---------------------------------------------------------------------------
// buildSlsaProvenance(artifact, opts) -> in-toto v1 Statement
//
// The task-named function. Assembles the SLSA Provenance v1 predicate from the
// artifact's manifest + lineage and wraps it in an in-toto v1 Statement whose
// subject is the artifact (+ any per-file digests). Returns the UNSIGNED
// Statement (use signSlsaProvenance / emitArtifactAttestation for the DSSE
// envelope).
//
// resolvedDependencies (SLSA materials) enumerate WHAT WENT IN: teacher,
// student base, training corpus, recipes/evals — reconstructable by a verifier.
// ---------------------------------------------------------------------------
export function buildSlsaProvenance(artifact, opts = {}) {
  const n = _normalizeArtifact(artifact);

  const predicate = buildSlsaProvenancePredicate({
    manifest: { ...n.manifest, cid: n.cid !== undefined ? n.cid : n.manifest.cid },
    hashes: n.hashes,
    lineage: n.lineage,
    builderId: n.builderId,
    builderVersion: n.builderVersion,
    jobId: n.jobId,
    startedOn: n.startedOn,
    finishedOn: n.issued_at || opts.finishedOn,
  });

  // Build the subject array (artifact + optional inner-file digests).
  const subjects = [];
  if (n.subjectDigests && typeof n.subjectDigests === 'object') {
    for (const [name, sha256] of Object.entries(n.subjectDigests)) {
      if (typeof sha256 === 'string' && HEX64_RE.test(sha256)) {
        subjects.push({ name, digest: { sha256: sha256.toLowerCase() } });
      }
    }
  }
  if (subjects.length === 0) {
    if (!n.artifact_hash || !HEX64_RE.test(n.artifact_hash)) {
      throw new Error('buildSlsaProvenance: need subjectDigests or a valid artifact_hash (hex64)');
    }
    const name = n.jobId ? `${n.jobId}.kolm` : 'artifact.kolm';
    const subj = { name, digest: { sha256: n.artifact_hash.toLowerCase() } };
    if (n.cid) subj.annotations = { cid: String(n.cid) };
    subjects.push(subj);
  }

  return buildInTotoStatement({
    subjects,
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate,
  });
}

// ---------------------------------------------------------------------------
// signSlsaProvenance(artifact, signer, opts) -> { envelope, json, statement }
//
// Build the Statement and wrap it in a DSSE envelope signed with the supplied
// Ed25519 signer ({privateKey, publicKey, key_fingerprint}). Returns the parsed
// envelope, its JSON string (for the sidecar provenance.intoto.dsse.json), and
// the Statement. NEVER folds the envelope into any hash — it is a seal.
// ---------------------------------------------------------------------------
export function signSlsaProvenance(artifact, signer, opts = {}) {
  if (!signer || !signer.privateKey) {
    throw new Error('signSlsaProvenance: signer with privateKey required');
  }
  const statement = buildSlsaProvenance(artifact, opts);
  const envelope = buildDsseEnvelope({
    statement,
    privateKey: signer.privateKey,
    publicKey: signer.publicKey,
    key_fingerprint: signer.key_fingerprint,
  });
  return {
    statement,
    envelope,
    json: JSON.stringify(envelope, null, 2),
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    conformance: KOLM_SLSA_CONFORMANCE,
  };
}

// ---------------------------------------------------------------------------
// emitProvenanceAttestation(artifact, signer, opts) -> string (DSSE JSON)
//
// Convenience that mirrors intoto-slsa.emitArtifactAttestation but takes the
// artifact-shaped object. Returns the JSON string for the sidecar file.
// ---------------------------------------------------------------------------
export function emitProvenanceAttestation(artifact, signer, opts = {}) {
  const n = _normalizeArtifact(artifact);
  return emitArtifactAttestation({
    ed25519Signer: signer,
    manifest: n.manifest,
    hashes: n.hashes,
    lineage: n.lineage,
    artifact_hash: n.artifact_hash,
    cid: n.cid,
    jobId: n.jobId,
    issued_at: n.issued_at || opts.finishedOn,
    builderVersion: n.builderVersion,
    builderId: n.builderId,
    subjectDigests: n.subjectDigests,
    startedOn: n.startedOn,
  });
}

// ---------------------------------------------------------------------------
// verifyProvenance(envelopeOrJson, { publicKey, digestMap }) -> verdict
//
// Verify a DSSE-enveloped attestation. With digestMap (entry name -> sha256
// hex of the real bytes), also confirm subject digests match the artifact
// (full L2-shape provenance verification). Never throws.
// ---------------------------------------------------------------------------
export function verifyProvenance(envelopeOrJson, { publicKey, digestMap = null } = {}) {
  let envelope = envelopeOrJson;
  if (typeof envelopeOrJson === 'string') {
    try { envelope = JSON.parse(envelopeOrJson); }
    catch (e) { return { ok: false, reason: `envelope not JSON: ${e.message}` }; }
  }
  if (digestMap && typeof digestMap === 'object') {
    return verifyInTotoAgainstArtifact(envelope, digestMap, { publicKey });
  }
  const base = verifyDsseEnvelope(envelope, { publicKey });
  return {
    ok: base.ok,
    reason: base.reason,
    statement: base.statement,
    predicateType: base.predicateType,
    key_fingerprint: base.key_fingerprint,
    conformance: KOLM_SLSA_CONFORMANCE,
  };
}

export const GOVERN_PROVENANCE_SPEC = {
  version: GOVERN_PROVENANCE_VERSION,
  statement_type: INTOTO_STATEMENT_TYPE,
  predicate_type: SLSA_PROVENANCE_PREDICATE_TYPE,
  payload_type: INTOTO_DSSE_PAYLOAD_TYPE,
  build_type: KOLM_BUILD_TYPE,
  conformance: KOLM_SLSA_CONFORMANCE,
};

// Re-export the load-bearing constants so callers depend on this module only.
export {
  INTOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  KOLM_BUILD_TYPE,
  KOLM_SLSA_CONFORMANCE,
  resourceDescriptorsFromLineage,
};
