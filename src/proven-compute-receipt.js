// src/proven-compute-receipt.js
//
// Signed Proven-Compute Receipt.
//
// This is the bridge from "the artifact is signed" to "this specific output is
// covered by a cryptographically verified compute attestation." It remains
// fail-closed: the receipt can only claim proof_scope=proven_compute when:
//   1. artifact identity is present;
//   2. input_digest and output_digest are sha256 hex digests;
//   3. the attestation state has verified=true through a non-shape verifier;
//   4. an attestation nonce equals sha256(input_digest||output_digest).
//
// The module never stores prompt/output plaintext. The nonce binds digests only.

import crypto from 'node:crypto';

import {
  buildSignatureBlock,
  loadOrCreateDefaultSigner,
  verifySignatureBlock,
} from './ed25519.js';
import { nonceBinding } from './nras-verifier.js';
import { PROOF_SCOPE, proofScopeLabel } from './receipt-export-registry.js';
import { isValidCidFormat } from './cid.js';
import {
  TransparencyLog,
  TRANSPARENCY_LOG_VERSION,
  verifyInclusionProof,
} from './transparency-log.js';
import { getPublicTransparencyLog } from './transparency-log-routes.js';

export const PROVEN_COMPUTE_RECEIPT_SCHEMA = 'kolm.proven_compute_receipt.v1';
export const PROVEN_COMPUTE_RECEIPT_VERSION = 'w968-proven-compute-receipt-v1';
export const PROVEN_COMPUTE_NONCE_BINDING_ALG = 'sha256(input_digest||output_digest)';

const SHA256_RE = /^[0-9a-f]{64}$/i;

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isSha256Hex(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function cleanObject(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => {
    const cleaned = cleanObject(v);
    return cleaned === undefined ? null : cleaned;
  });
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const cleaned = cleanObject(value[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export function canonicalizeProvenComputeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('canonicalizeProvenComputeReceipt: receipt object required');
  }
  const { signature_ed25519, transparency_checkpoint, ...rest } = receipt;
  void signature_ed25519; void transparency_checkpoint;
  return JSON.stringify(cleanObject(rest));
}

function digestOfReceipt(receipt) {
  return sha256hex(Buffer.from(canonicalizeProvenComputeReceipt(receipt), 'utf8'));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeHexDigest(value) {
  return isSha256Hex(value) ? String(value).toLowerCase() : null;
}

function normalizeNonceHex(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const buf = Buffer.from(padded, 'base64');
    if (buf.length === 32) return buf.toString('hex');
  } catch {
    // Not base64/base64url. Fall through.
  }
  return null;
}

function compactAttestationState(state) {
  const s = asObject(state);
  const out = {
    verified: s.verified === true,
    verifier: typeof s.verifier === 'string' && s.verifier ? s.verifier.slice(0, 120) : 'none',
  };
  for (const key of [
    'kind',
    'state',
    'reason',
    'report_hash',
    'trust_root',
    'not_after',
    'revocation_checked_at',
    'timestamp',
    'nonce',
    'eat_nonce',
    'expected_nonce',
    'nonce_binding_alg',
  ]) {
    const value = s[key];
    if (typeof value === 'string' && value) out[key] = value.slice(0, key.includes('nonce') ? 160 : 300);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  if (s.cert_chain_length != null) out.cert_chain_length = s.cert_chain_length;
  return out;
}

function nonceEvidence(attestationState, attestationReport, expectedNonce) {
  const state = asObject(attestationState);
  const report = asObject(attestationReport);
  const candidates = [
    ['attestation.expected_nonce', state.expected_nonce],
    ['attestation.nonce', state.nonce],
    ['attestation.eat_nonce', state.eat_nonce],
    ['attestation.attestation_nonce', state.attestation_nonce],
    ['report.expected_nonce', report.expected_nonce],
    ['report.nonce', report.nonce],
    ['report.eat_nonce', report.eat_nonce],
  ];
  for (const [source, raw] of candidates) {
    const hex = normalizeNonceHex(raw);
    if (hex && expectedNonce && hex === expectedNonce.toLowerCase()) {
      return { ok: true, source, nonce: hex };
    }
  }
  const seen = candidates
    .map(([source, raw]) => ({ source, nonce: normalizeNonceHex(raw) }))
    .filter((row) => row.nonce);
  return { ok: false, source: null, nonce: null, seen };
}

export function assessProvenComputeProof(input = {}) {
  const artifactHash = normalizeHexDigest(input.artifact_hash || input.artifactHash);
  const cid = typeof input.cid === 'string' && isValidCidFormat(input.cid) ? input.cid : null;
  const inputDigest = normalizeHexDigest(input.input_digest || input.inputDigest);
  const outputDigest = normalizeHexDigest(input.output_digest || input.outputDigest);
  const attestationState = asObject(input.attestation_state || input.attestation || input.confidential_compute);
  const attestationReport = asObject(input.attestation_report || input.nras_report || input.report);
  const reasons = [];

  if (!artifactHash && !cid) reasons.push('missing_artifact_identity');
  if (!inputDigest) reasons.push('invalid_input_digest');
  if (!outputDigest) reasons.push('invalid_output_digest');

  const stateScope = proofScopeLabel(attestationState);
  if (stateScope !== PROOF_SCOPE.PROVEN_COMPUTE) {
    reasons.push('attestation_not_cryptographically_verified');
  }

  let expectedNonce = null;
  let nonce = { ok: false, source: null, nonce: null, seen: [] };
  if (inputDigest && outputDigest) {
    expectedNonce = nonceBinding(inputDigest, outputDigest);
    nonce = nonceEvidence(attestationState, attestationReport, expectedNonce);
    if (!nonce.ok) reasons.push('nonce_binding_missing_or_mismatch');
  }

  const ok = reasons.length === 0;
  return {
    ok,
    proof_scope: ok ? PROOF_SCOPE.PROVEN_COMPUTE : PROOF_SCOPE.KEY_CUSTODY,
    reason: ok ? 'proven_compute' : reasons[0],
    reasons,
    expected_nonce: expectedNonce,
    nonce_binding_alg: PROVEN_COMPUTE_NONCE_BINDING_ALG,
    nonce_source: nonce.source,
    nonce: nonce.nonce,
    observed_nonces: nonce.seen || [],
    verifier: typeof attestationState.verifier === 'string' ? attestationState.verifier : null,
    attestation_report_hash: typeof attestationState.report_hash === 'string' ? attestationState.report_hash : null,
  };
}

function defaultReceiptId(seed) {
  return `pcr_${sha256hex(Buffer.from(JSON.stringify(cleanObject(seed)), 'utf8')).slice(0, 24)}`;
}

export function buildProvenComputeReceipt(input = {}, opts = {}) {
  const artifactHash = normalizeHexDigest(input.artifact_hash || input.artifactHash);
  const cid = typeof input.cid === 'string' && isValidCidFormat(input.cid) ? input.cid : null;
  const inputDigest = normalizeHexDigest(input.input_digest || input.inputDigest);
  const outputDigest = normalizeHexDigest(input.output_digest || input.outputDigest);
  const attestationState = compactAttestationState(input.attestation_state || input.attestation || input.confidential_compute);
  const assessment = assessProvenComputeProof({
    artifact_hash: artifactHash,
    cid,
    input_digest: inputDigest,
    output_digest: outputDigest,
    attestation_state: attestationState,
    attestation_report: input.attestation_report || input.nras_report || input.report,
  });
  const issuedAt = input.issued_at || input.issuedAt || opts.issued_at || new Date().toISOString();
  const receipt = {
    schema: PROVEN_COMPUTE_RECEIPT_SCHEMA,
    version: PROVEN_COMPUTE_RECEIPT_VERSION,
    receipt_id: input.receipt_id || input.receiptId || defaultReceiptId({
      artifact_hash: artifactHash,
      cid,
      input_digest: inputDigest,
      output_digest: outputDigest,
      attestation_report_hash: attestationState.report_hash || null,
      expected_nonce: assessment.expected_nonce,
    }),
    issued_at: issuedAt,
    artifact: {
      artifact_hash: artifactHash,
      cid,
      model_weight_artifact_manifest_hash: normalizeHexDigest(input.model_weight_artifact_manifest_hash || input.modelWeightArtifactManifestHash),
      signature_key_fingerprint: typeof input.signature_key_fingerprint === 'string' ? input.signature_key_fingerprint.slice(0, 120) : null,
    },
    inference: {
      input_digest: inputDigest,
      output_digest: outputDigest,
      nonce_binding: assessment.expected_nonce,
      nonce_binding_alg: PROVEN_COMPUTE_NONCE_BINDING_ALG,
      runtime_target: typeof input.runtime_target === 'string' ? input.runtime_target.slice(0, 120) : null,
    },
    attestation: attestationState,
    proof: {
      ok: assessment.ok,
      reason: assessment.reason,
      reasons: assessment.reasons,
      nonce_source: assessment.nonce_source,
      nonce: assessment.nonce,
      verifier: assessment.verifier,
      attestation_report_hash: assessment.attestation_report_hash,
    },
    proof_scope: assessment.proof_scope,
    caveat: assessment.ok
      ? 'attestation_nonce_binds_input_output_digests'
      : 'integrity_only_no_proven_compute',
  };
  return cleanObject(receipt);
}

function logFor(opts = {}) {
  if (opts.transparencyLog instanceof TransparencyLog) return opts.transparencyLog;
  return getPublicTransparencyLog();
}

export function recordProvenComputeTransparencyEntry(receipt, opts = {}) {
  try {
    const receiptDigest = digestOfReceipt(receipt);
    const log = logFor(opts);
    const row = log.append('proven-compute-receipt', {
      alg: 'sha256',
      receipt_digest: receiptDigest,
      receipt_id: receipt.receipt_id || null,
      proof_scope: receipt.proof_scope || null,
      artifact_hash: receipt.artifact?.artifact_hash || null,
      output_digest: receipt.inference?.output_digest || null,
    }, { namespace: 'proven-compute', at: opts.at });
    const head = log.treeHead();
    const proof = log.inclusionProof(row.seq);
    return {
      version: TRANSPARENCY_LOG_VERSION,
      origin: head.origin,
      tree_size: head.tree_size,
      root_hash: head.root_hash,
      root_b64: head.root_b64,
      seq: row.seq,
      entry_hash: row.entry_hash,
      leaf_hash: row.leaf_hash,
      receipt_digest: receiptDigest,
      inclusion: proof && proof.ok ? {
        leaf_hash: proof.leaf_hash,
        leaf_index: proof.leaf_index,
        tree_size: proof.tree_size,
        audit_path: proof.audit_path,
        root_hash: proof.root_hash,
      } : null,
    };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : 'transparency_anchor_failed' };
  }
}

export function signProvenComputeReceipt(receipt, signer, opts = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('signProvenComputeReceipt: receipt object required');
  }
  const s = signer || loadOrCreateDefaultSigner();
  if (!s || !s.privateKey || !s.publicKey) {
    const err = new Error('signProvenComputeReceipt: no Ed25519 signer available');
    err.code = 'NO_SIGNER';
    throw err;
  }
  const canonical = canonicalizeProvenComputeReceipt(receipt);
  receipt.signature_ed25519 = buildSignatureBlock({
    privateKey: s.privateKey,
    publicKey: s.publicKey,
    key_fingerprint: s.key_fingerprint,
    payloadCanonical: canonical,
    signed_at: opts.signed_at || receipt.issued_at,
  });
  if (opts.transparency !== false) {
    const checkpoint = recordProvenComputeTransparencyEntry(receipt, opts);
    if (checkpoint && checkpoint.ok !== false) receipt.transparency_checkpoint = checkpoint;
  }
  return receipt;
}

export function buildAndSignProvenComputeReceipt(input = {}, opts = {}) {
  const receipt = buildProvenComputeReceipt(input, opts);
  return signProvenComputeReceipt(receipt, opts.signer, opts);
}

function verifyTransparencyCheckpoint(receipt, checkpoint, canonicalDigest) {
  if (!checkpoint || typeof checkpoint !== 'object') return { ok: true, skipped: true };
  if (checkpoint.receipt_digest !== canonicalDigest) {
    return { ok: false, reason: 'transparency_checkpoint_receipt_digest_mismatch' };
  }
  if (checkpoint.inclusion) {
    const inc = verifyInclusionProof(checkpoint.inclusion);
    if (!inc.ok) return { ok: false, reason: `transparency_inclusion:${inc.reason}` };
    if (String(inc.root || '').toLowerCase() !== String(checkpoint.root_hash || '').toLowerCase()) {
      return { ok: false, reason: 'transparency_inclusion_root_mismatch' };
    }
  }
  return { ok: true };
}

export function verifyProvenComputeReceipt(receiptInput, opts = {}) {
  const checks = [];
  let receipt = receiptInput;
  if (typeof receipt === 'string') {
    try { receipt = JSON.parse(receipt); }
    catch (e) { return { ok: false, reason: `invalid_json:${e.message}`, checks }; }
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, reason: 'receipt_must_be_object', checks };
  }
  if (receipt.schema !== PROVEN_COMPUTE_RECEIPT_SCHEMA) {
    return { ok: false, reason: `unexpected_schema:${receipt.schema || '(missing)'}`, checks };
  }
  checks.push({ name: 'schema', ok: true, detail: receipt.schema });

  let canonical;
  try { canonical = canonicalizeProvenComputeReceipt(receipt); }
  catch (e) { return { ok: false, reason: `canonicalize_failed:${e.message}`, checks }; }
  const receiptDigest = sha256hex(Buffer.from(canonical, 'utf8'));
  checks.push({ name: 'canonical_payload', ok: true, detail: `${canonical.length} bytes` });

  const block = receipt.signature_ed25519;
  if (!block || typeof block !== 'object') {
    if (opts.requireSignature !== false) {
      return { ok: false, reason: 'missing_signature_ed25519', checks };
    }
  } else {
    const sig = verifySignatureBlock(block, canonical);
    checks.push({ name: 'signature_ed25519', ok: sig.ok === true, detail: sig.reason || block.key_fingerprint || null });
    if (!sig.ok) return { ok: false, reason: `signature:${sig.reason}`, checks };
  }

  const artifact = asObject(receipt.artifact);
  const inference = asObject(receipt.inference);
  const expectedNonce = inference.input_digest && inference.output_digest
    ? nonceBinding(inference.input_digest, inference.output_digest)
    : null;
  if (expectedNonce && inference.nonce_binding !== expectedNonce) {
    return { ok: false, reason: 'nonce_binding_recomputed_mismatch', checks, receipt_digest: receiptDigest };
  }
  checks.push({ name: 'nonce_binding', ok: !!expectedNonce, detail: expectedNonce || null });

  const assessment = assessProvenComputeProof({
    artifact_hash: artifact.artifact_hash,
    cid: artifact.cid,
    input_digest: inference.input_digest,
    output_digest: inference.output_digest,
    attestation_state: receipt.attestation,
  });
  checks.push({ name: 'proof_scope_recomputed', ok: true, detail: assessment.proof_scope });

  if (receipt.proof_scope !== assessment.proof_scope) {
    return {
      ok: false,
      reason: `proof_scope_mismatch:${receipt.proof_scope}->${assessment.proof_scope}`,
      checks,
      receipt_digest: receiptDigest,
      assessment,
    };
  }
  if (opts.requireProvenCompute === true && assessment.proof_scope !== PROOF_SCOPE.PROVEN_COMPUTE) {
    return { ok: false, reason: assessment.reason || 'not_proven_compute', checks, receipt_digest: receiptDigest, assessment };
  }

  const tlog = verifyTransparencyCheckpoint(receipt, receipt.transparency_checkpoint, receiptDigest);
  checks.push({ name: 'transparency_checkpoint', ok: tlog.ok === true, detail: tlog.skipped ? 'absent' : 'verified' });
  if (!tlog.ok) return { ok: false, reason: tlog.reason, checks, receipt_digest: receiptDigest, assessment };

  return {
    ok: true,
    proof_scope: receipt.proof_scope,
    receipt_digest: receiptDigest,
    key_fingerprint: block && block.key_fingerprint,
    checks,
    assessment,
  };
}

export default {
  PROVEN_COMPUTE_RECEIPT_SCHEMA,
  PROVEN_COMPUTE_RECEIPT_VERSION,
  PROVEN_COMPUTE_NONCE_BINDING_ALG,
  assessProvenComputeProof,
  buildProvenComputeReceipt,
  signProvenComputeReceipt,
  buildAndSignProvenComputeReceipt,
  verifyProvenComputeReceipt,
  canonicalizeProvenComputeReceipt,
  recordProvenComputeTransparencyEntry,
};
