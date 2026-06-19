// src/intoto-slsa.js
//
// W921 Phase-1 - in-toto v1 Statement + SLSA Provenance v1, DSSE-enveloped.
//
// WHY: kolm already proves a lot cryptographically (HMAC integrity, Ed25519
// receipt signatures, a cosign-bundle-shaped sigstore block) but it all speaks
// kolm-dialect. A buyer's CI/CD policy gate - cosign verify-attestation,
// kyverno, conftest, in-toto-verify, GUAC, Tekton Chains - cannot consume a
// .kolm artifact's provenance without a custom parser. This module emits the
// 2025 ML supply-chain consensus shape: an in-toto v1 Statement (subject
// digests + predicateType) carrying a SLSA Provenance v1 predicate
// (buildDefinition + runDetails with the teacher / base model / training
// corpus as resolvedDependencies), wrapped in a DSSE envelope signed with the
// SAME Ed25519 key already used for signature_ed25519 (no new key custody).
//
// SCOPE HONESTY (mirrors src/provenance.js discipline): this is SLSA Build L2
// SHAPE - signed and non-forgeable because the signing key is custodied - NOT
// Build L3. L3 requires a hardened, isolated builder with OIDC/Fulcio identity
// binding, which kolm does not provide. We never assert hardened-builder
// properties. The string is "SLSA Provenance v1 (Build L2 shape)".
//
// SUBJECT-DIGEST CORRECTNESS: subjects are PLAIN sha256 over the actual zipped
// bytes (supplied by the caller as a digestMap), NEVER hashes.model_pointer - 
// that field folds a "\x00parent_cid:<cid>" suffix for lineage-chained
// artifacts (artifact.js W739), so a zip-byte recomputation would mismatch.
//
// BYTE-STABILITY: the DSSE envelope is a SEAL over the bytes, emitted as a
// sidecar (provenance.intoto.dsse.json) and EXCLUDED from artifact_hash_input,
// exactly like signature.sig. It must never be folded into the CID.
//
// DEPS: node:crypto via src/ed25519.js + src/cid.js canonicalJson. The DSSE
// PAE + base64 re-encode is ~30 lines of vanilla Node. NO @sigstore/* or
// in-toto npm packages (heavy transitive trees, against kolm's zero-heavy-deps
// design).

import { sign as ed25519Sign, verify as ed25519Verify, keyFingerprint } from './ed25519.js';
import { canonicalJson } from './cid.js';

// ---------------------------------------------------------------------------
// Spec constants (authoritative type URIs - primary sources).
// ---------------------------------------------------------------------------
export const INTOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const SLSA_PROVENANCE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
export const INTOTO_DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const KOLM_BUILD_TYPE = 'https://kolm.ai/compile/v1';
// Honest conformance bar - see header. NEVER bump to L3 without a hardened,
// identity-bound builder.
export const KOLM_SLSA_CONFORMANCE = 'SLSA Provenance v1 (Build L2 shape)';

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;

export function inferModelDocumentationRole(name) {
  const s = String(name || '').toLowerCase().replace(/\\/g, '/');
  const base = s.split('/').pop() || s;
  if (/^model[-_ ]?card\.(md|json|ya?ml)$/.test(base) || /(^|\/)model[-_ ]?card\.(md|json|ya?ml)$/.test(s)) {
    return 'model_card';
  }
  if (/annex[-_ ]?xi(\.|-|_|$)/i.test(base) || /annex[-_ ]?11(\.|-|_|$)/i.test(base)) {
    return 'eu_ai_act_annex_xi';
  }
  if (/annex[-_ ]?xii(\.|-|_|$)/i.test(base) || /annex[-_ ]?12(\.|-|_|$)/i.test(base)) {
    return 'eu_ai_act_annex_xii';
  }
  if (/technical[-_ ]?documentation|technical[-_ ]?doc|eu[-_ ]?ai[-_ ]?act|gpai/.test(s)) {
    return 'technical_documentation';
  }
  return null;
}

function _normalizeDigestValue(v) {
  if (typeof v === 'string') return { sha256: v.toLowerCase() };
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const [alg, value] of Object.entries(v)) {
    if (typeof alg === 'string' && typeof value === 'string' && value.length > 0) {
      out[alg] = value.toLowerCase();
    }
  }
  return out;
}

function _digestMapsMatch(wantDigest, haveValue) {
  const want = _normalizeDigestValue(wantDigest);
  const have = _normalizeDigestValue(haveValue);
  const common = Object.keys(want).filter((alg) => typeof have[alg] === 'string');
  if (common.length === 0) return false;
  return common.every((alg) => want[alg] === have[alg]);
}

function _subjectDigestFromValue(v) {
  if (typeof v === 'string') {
    const sha256 = v.toLowerCase();
    return HEX64_RE.test(sha256) ? { sha256 } : null;
  }
  if (!v || typeof v !== 'object') return null;
  const digest = {};
  const sha256 = typeof v.sha256 === 'string' ? v.sha256.toLowerCase() : null;
  const blake2b = typeof v.blake2b === 'string' ? v.blake2b.toLowerCase() : null;
  if (sha256 && HEX64_RE.test(sha256)) digest.sha256 = sha256;
  if (blake2b && HEX128_RE.test(blake2b)) digest.blake2b = blake2b;
  return Object.keys(digest).length > 0 ? digest : null;
}

export function normalizeModelDocumentationDigests(documentationDigests) {
  const rows = Array.isArray(documentationDigests)
    ? documentationDigests
    : Object.entries(documentationDigests || {}).map(([name, digest]) => ({ name, digest }));
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const name = String(row?.name || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!name || seen.has(name)) continue;
    const digest = _subjectDigestFromValue(row.digest || row);
    if (!digest) continue;
    const role = row.role || row.document_role || inferModelDocumentationRole(name);
    if (!role) continue;
    seen.add(name);
    out.push({
      name,
      digest,
      annotations: {
        role: 'model_documentation',
        document_role: String(role),
      },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// DSSE Pre-Authentication Encoding (PAE).
//
// PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
//   - SP is a single 0x20 byte.
//   - LEN is the ASCII DECIMAL **byte** length (NOT char length), no leading
//     zeros.
//   - "+" in the spec is byte concatenation.
//
// The Ed25519 signature is computed over these PAE bytes - NOT the raw
// Statement. A char-length-vs-byte-length bug or a base64url slip makes the
// signature verify in kolm but FAIL in cosign, so this is the #1 interop trap.
//
// DSSE spec example (asserted byte-for-byte in tests):
//   PAE("http://example.com/HelloWorld", "hello world")
//     = "DSSEv1 29 http://example.com/HelloWorld 11 hello world"
// ---------------------------------------------------------------------------
export function pae(payloadType, payloadBytes) {
  const typeBuf = Buffer.from(String(payloadType), 'utf8');
  const bodyBuf = Buffer.isBuffer(payloadBytes)
    ? payloadBytes
    : Buffer.from(String(payloadBytes), 'utf8');
  const SP = Buffer.from(' ', 'utf8');
  return Buffer.concat([
    Buffer.from('DSSEv1', 'utf8'),
    SP,
    Buffer.from(String(typeBuf.length), 'utf8'), // byte length, no leading zeros
    SP,
    typeBuf,
    SP,
    Buffer.from(String(bodyBuf.length), 'utf8'),
    SP,
    bodyBuf,
  ]);
}

// ---------------------------------------------------------------------------
// in-toto v1 ResourceDescriptors derived from a kolm lineage object
// (src/artifact-lineage.js shape). These become the SLSA resolvedDependencies
// (a.k.a. materials) - what WENT IN: teacher, student base, training corpus.
//
// Degrades gracefully: no lineage -> []. No fabricated entries; we only emit a
// descriptor when the underlying datum exists.
// ---------------------------------------------------------------------------
export function resourceDescriptorsFromLineage(lineage) {
  if (!lineage || typeof lineage !== 'object') return [];
  const deps = [];

  if (lineage.teacher && lineage.teacher.vendor && lineage.teacher.model) {
    const t = lineage.teacher;
    const annotations = { role: 'teacher', vendor: String(t.vendor), model: String(t.model) };
    if (t.version) annotations.version = String(t.version);
    deps.push({
      name: `teacher:${t.vendor}/${t.model}${t.version ? '@' + t.version : ''}`,
      uri: `kolm:teacher:${t.vendor}/${t.model}`,
      annotations,
    });
  }

  if (lineage.student_base && lineage.student_base.repo) {
    const sb = lineage.student_base;
    const d = {
      name: `student-base:${sb.repo}`,
      uri: `hf:${sb.repo}`,
      annotations: { role: 'student_base', repo: String(sb.repo) },
    };
    if (sb.revision) d.annotations.revision = String(sb.revision);
    deps.push(d);
  }

  if (lineage.training_corpus_hash && HEX64_RE.test(lineage.training_corpus_hash)) {
    deps.push({
      name: 'training-corpus',
      digest: { sha256: lineage.training_corpus_hash },
      annotations: { role: 'training_corpus' },
    });
  }

  if (lineage.parent_artifact_hash && HEX64_RE.test(lineage.parent_artifact_hash)) {
    deps.push({
      name: 'parent-artifact',
      digest: { sha256: lineage.parent_artifact_hash },
      annotations: { role: 'parent_artifact' },
    });
  }

  if (lineage.distillation_method) {
    // record method as an annotation-only descriptor so verifiers see HOW.
    deps.push({
      name: `distillation-method:${lineage.distillation_method}`,
      annotations: { role: 'distillation_method', method: String(lineage.distillation_method) },
    });
  }

  return deps;
}

// ---------------------------------------------------------------------------
// SLSA Provenance v1 predicate. The two SLSA-REQUIRED fields are
// buildDefinition.buildType and runDetails.builder.id - both always set.
// ---------------------------------------------------------------------------
export function buildSlsaProvenancePredicate({
  manifest = {},
  hashes = {},
  lineage = null,
  documentationDigests = null,
  builderId,
  builderVersion,
  jobId,
  startedOn,
  finishedOn,
} = {}) {
  const externalParameters = {};
  if (manifest.task !== undefined) externalParameters.task = manifest.task;
  if (manifest.base_model !== undefined) externalParameters.base_model = manifest.base_model;
  if (manifest.tier !== undefined) externalParameters.tier = manifest.tier;
  if (manifest.cid !== undefined) externalParameters.cid = manifest.cid;
  if (hashes && hashes.recipes_json) externalParameters.recipes_hash = hashes.recipes_json;
  if (jobId !== undefined) externalParameters.job_id = jobId;
  const modelDocumentation = normalizeModelDocumentationDigests(documentationDigests);
  if (modelDocumentation.length) {
    externalParameters.model_documentation = modelDocumentation.map((d) => ({
      name: d.name,
      digest: d.digest,
      document_role: d.annotations.document_role,
    }));
  }

  const resolvedDependencies = resourceDescriptorsFromLineage(lineage);
  // When there is no distillation lineage, degrade to recipes/evals as inputs
  // rather than fabricating teacher/base entries.
  if (resolvedDependencies.length === 0) {
    if (hashes && hashes.recipes_json && HEX64_RE.test(hashes.recipes_json)) {
      resolvedDependencies.push({ name: 'recipes.json', digest: { sha256: hashes.recipes_json } });
    }
    if (hashes && hashes.evals_json && HEX64_RE.test(hashes.evals_json)) {
      resolvedDependencies.push({ name: 'evals.json', digest: { sha256: hashes.evals_json } });
    }
  }

  const builderIdResolved = builderId
    || `https://kolm.ai/cli/${builderVersion || '0.0.0'}`;

  return {
    buildDefinition: {
      buildType: KOLM_BUILD_TYPE,
      externalParameters,
      internalParameters: {},
      resolvedDependencies,
    },
    runDetails: {
      builder: {
        id: builderIdResolved,
        version: builderVersion ? { kolm: String(builderVersion) } : {},
      },
      metadata: {
        invocationId: jobId !== undefined && jobId !== null ? String(jobId) : '',
        startedOn: startedOn || finishedOn || new Date().toISOString(),
        finishedOn: finishedOn || new Date().toISOString(),
      },
      byproducts: modelDocumentation.map((d) => ({
        name: d.name,
        digest: d.digest,
        annotations: {
          ...d.annotations,
          slsa_relation: 'regulatory_documentation',
        },
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// in-toto v1 Statement. Validates subject is a non-empty array of
// ResourceDescriptors each carrying a non-empty digest map.
// ---------------------------------------------------------------------------
export function buildInTotoStatement({ subjects, predicateType, predicate }) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new Error('buildInTotoStatement: subject must be a non-empty array');
  }
  for (const s of subjects) {
    if (!s || typeof s !== 'object') throw new Error('buildInTotoStatement: each subject must be an object');
    if (typeof s.name !== 'string' || s.name.length === 0) {
      throw new Error('buildInTotoStatement: each subject requires a name');
    }
    if (!s.digest || typeof s.digest !== 'object') {
      throw new Error(`buildInTotoStatement: subject "${s.name}" requires a digest`);
    }
    const algs = Object.keys(s.digest);
    if (algs.length === 0) {
      throw new Error(`buildInTotoStatement: subject "${s.name}" digest must be non-empty`);
    }
    for (const a of algs) {
      if (typeof s.digest[a] !== 'string' || s.digest[a].length === 0) {
        throw new Error(`buildInTotoStatement: subject "${s.name}" digest.${a} must be a non-empty string`);
      }
    }
  }
  if (typeof predicateType !== 'string' || predicateType.length === 0) {
    throw new Error('buildInTotoStatement: predicateType (TypeURI) required');
  }
  return {
    _type: INTOTO_STATEMENT_TYPE,
    subject: subjects,
    predicateType,
    predicate: predicate || {},
  };
}

// ---------------------------------------------------------------------------
// DSSE envelope. The signature is STANDARD base64 (cosign/DSSE require it,
// NOT base64url). kolm's ed25519.sign returns base64url, so we re-encode via
// Buffer.from(sig, 'base64url').toString('base64') - the exact pattern
// src/sigstore.js:209 already uses.
// ---------------------------------------------------------------------------
export function buildDsseEnvelope({ statement, privateKey, publicKey, key_fingerprint }) {
  if (!statement || typeof statement !== 'object') {
    throw new Error('buildDsseEnvelope: statement object required');
  }
  if (!privateKey) throw new Error('buildDsseEnvelope: privateKey required');
  // Statement bytes are canonical JSON so the payload is reproducible across
  // re-runs (modulo signed_at fields embedded by the caller in the predicate).
  const statementJson = canonicalJson(statement);
  const payloadBytes = Buffer.from(statementJson, 'utf8');
  const paeBytes = pae(INTOTO_DSSE_PAYLOAD_TYPE, payloadBytes);

  const sigB64Url = ed25519Sign(privateKey, paeBytes);
  const sigStdB64 = Buffer.from(sigB64Url, 'base64url').toString('base64');

  let keyid = key_fingerprint;
  if (!keyid && publicKey) {
    try { keyid = keyFingerprint(publicKey); } catch { keyid = undefined; }
  }

  return {
    payload: payloadBytes.toString('base64'),
    payloadType: INTOTO_DSSE_PAYLOAD_TYPE,
    signatures: [{ sig: sigStdB64, ...(keyid ? { keyid } : {}) }],
  };
}

// ---------------------------------------------------------------------------
// Verify a DSSE envelope (signature + payload shape). Returns the decoded
// Statement on success. NEVER throws.
// ---------------------------------------------------------------------------
export function verifyDsseEnvelope(envelope, { publicKey } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, reason: 'envelope missing or not an object' };
  }
  if (envelope.payloadType !== INTOTO_DSSE_PAYLOAD_TYPE) {
    return { ok: false, reason: `unexpected payloadType: ${envelope.payloadType}` };
  }
  if (typeof envelope.payload !== 'string' || envelope.payload.length === 0) {
    return { ok: false, reason: 'payload missing' };
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    return { ok: false, reason: 'signatures missing' };
  }
  let payloadBytes;
  try {
    payloadBytes = Buffer.from(envelope.payload, 'base64');
  } catch (e) {
    return { ok: false, reason: `payload base64 decode failed: ${e.message}` };
  }
  let statement;
  try {
    statement = JSON.parse(payloadBytes.toString('utf8'));
  } catch (e) {
    return { ok: false, reason: `payload is not valid JSON: ${e.message}` };
  }
  if (!publicKey) {
    return { ok: false, reason: 'publicKey required to verify signature' };
  }
  const paeBytes = pae(envelope.payloadType, payloadBytes);
  let verified = false;
  let usedKeyid;
  for (const s of envelope.signatures) {
    if (!s || typeof s.sig !== 'string' || s.sig.length === 0) continue;
    // sig is standard base64; convert to base64url for ed25519.verify.
    let sigB64Url;
    try {
      sigB64Url = Buffer.from(s.sig, 'base64').toString('base64url');
    } catch { continue; }
    if (ed25519Verify(publicKey, paeBytes, sigB64Url)) {
      verified = true;
      usedKeyid = s.keyid;
      break;
    }
  }
  if (!verified) {
    return { ok: false, reason: 'no signature verifies against the provided public key' };
  }
  let kf;
  try { kf = keyFingerprint(publicKey); } catch { kf = undefined; }
  return {
    ok: true,
    statement,
    predicateType: statement && statement.predicateType,
    key_fingerprint: kf,
    keyid: usedKeyid,
  };
}

// ---------------------------------------------------------------------------
// Verify the DSSE envelope AND that its Statement subjects match the actual
// artifact bytes. `digestMap` maps subject name -> sha256 hex or a digest map
// of the real (zipped) bytes. Every subject must match on at least one common
// algorithm; when the caller supplies multiple algorithms, all common
// algorithms must match.
// ---------------------------------------------------------------------------
export function verifyInTotoAgainstArtifact(envelope, digestMap, { publicKey } = {}) {
  const base = verifyDsseEnvelope(envelope, { publicKey });
  if (!base.ok) {
    return { ok: false, reason: base.reason, subjects_matched: 0, subjects_total: 0, predicateType: null, slsa_materials: [] };
  }
  const statement = base.statement;
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const total = subjects.length;
  let matched = 0;
  const mismatches = [];
  const dm = digestMap && typeof digestMap === 'object' ? digestMap : {};
  for (const s of subjects) {
    const have = dm[s.name];
    if (_digestMapsMatch(s.digest, have)) {
      matched += 1;
    } else {
      mismatches.push(s.name);
    }
  }
  const slsa_materials =
    statement.predicate
    && statement.predicate.buildDefinition
    && Array.isArray(statement.predicate.buildDefinition.resolvedDependencies)
      ? statement.predicate.buildDefinition.resolvedDependencies
      : [];
  const ok = total > 0 && matched === total;
  return {
    ok,
    reason: ok ? undefined : (total === 0 ? 'no subjects' : `subject digest mismatch: ${mismatches.join(', ')}`),
    subjects_matched: matched,
    subjects_total: total,
    predicateType: statement.predicateType,
    slsa_materials,
    key_fingerprint: base.key_fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Top-level emitter: assemble Statement (subjects from a digestMap of real
// zip-byte digests) + SLSA predicate, DSSE-envelope it, and return the JSON
// string for the sidecar provenance.intoto.dsse.json.
//
// `subjectDigests` maps entry name -> sha256 hex or digest map of the actual
// bytes. The caller (artifact.js) supplies these from the zipped bytes - NOT
// from hashes.model_pointer (which may be lineage-folded). If omitted, the
// artifact itself (<jobId>.kolm with artifact_hash) is used as the single
// subject.
// ---------------------------------------------------------------------------
export function emitArtifactAttestation({
  ed25519Signer,
  manifest = {},
  hashes = {},
  lineage = null,
  documentationDigests = null,
  artifact_hash,
  cid,
  jobId,
  issued_at,
  builderVersion,
  builderId,
  subjectDigests = null,
  startedOn,
} = {}) {
  if (!ed25519Signer || !ed25519Signer.privateKey) {
    throw new Error('emitArtifactAttestation: ed25519Signer with privateKey required');
  }

  const subjects = [];
  if (subjectDigests && typeof subjectDigests === 'object' && Object.keys(subjectDigests).length > 0) {
    for (const name of Object.keys(subjectDigests).sort()) {
      const digest = _subjectDigestFromValue(subjectDigests[name]);
      if (digest) {
        subjects.push({ name, digest });
      }
    }
  }
  if (subjects.length === 0) {
    if (!artifact_hash || !HEX64_RE.test(artifact_hash)) {
      throw new Error('emitArtifactAttestation: need subjectDigests or a valid artifact_hash (hex64)');
    }
    const artifactName = (jobId ? `${jobId}.kolm` : 'artifact.kolm');
    const subj = {
      name: artifactName,
      digest: { sha256: artifact_hash },
    };
    if (cid) subj.annotations = { cid: String(cid) };
    subjects.push(subj);
  }

  const finishedOn = issued_at || new Date().toISOString();
  const predicate = buildSlsaProvenancePredicate({
    manifest: { ...manifest, cid: cid !== undefined ? cid : manifest.cid },
    hashes,
    lineage,
    documentationDigests,
    builderId,
    builderVersion,
    jobId,
    startedOn,
    finishedOn,
  });

  const statement = buildInTotoStatement({
    subjects,
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate,
  });

  const envelope = buildDsseEnvelope({
    statement,
    privateKey: ed25519Signer.privateKey,
    publicKey: ed25519Signer.publicKey,
    key_fingerprint: ed25519Signer.key_fingerprint,
  });

  return JSON.stringify(envelope, null, 2);
}

export const INTOTO_SLSA_SPEC = {
  statement_type: INTOTO_STATEMENT_TYPE,
  predicate_type: SLSA_PROVENANCE_PREDICATE_TYPE,
  payload_type: INTOTO_DSSE_PAYLOAD_TYPE,
  build_type: KOLM_BUILD_TYPE,
  conformance: KOLM_SLSA_CONFORMANCE,
};
