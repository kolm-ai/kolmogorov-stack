// Runtime proven-compute binding.
//
// BYOC callbacks can already persist a Proven-Compute Receipt after a verified
// NRAS report. This module is the live inference-side companion: it binds one
// runtime request/response pair to an attestation report whose nonce equals
// sha256(input_digest||output_digest), then emits the same signed receipt shape.
//
// Privacy: plaintext request/response values are only hashed in process. The
// receipt carries digests, artifact identity, attestation state, and signature.

import crypto from 'node:crypto';

import { verifyAttestation, KINDS } from './confidential-compute.js';
import {
  buildAndSignProvenComputeReceipt,
  verifyProvenComputeReceipt,
} from './proven-compute-receipt.js';

export const RUNTIME_PROVEN_COMPUTE_VERSION = 'w992-runtime-proven-compute-v1';

const SHA256_RE = /^[0-9a-f]{64}$/i;
const PROOF_KEYS = new Set([
  'kolm_proven_compute',
  'proven_compute',
  'proven_compute_receipt',
  'proven_compute_receipt_error',
  'proven_compute_receipt_digest',
]);

function sha256hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanObject(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => {
      const cleaned = cleanObject(v);
      return cleaned === undefined ? null : cleaned;
    });
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (PROOF_KEYS.has(key)) continue;
    const cleaned = cleanObject(value[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export function canonicalRuntimePayload(value) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString('utf8');
  }
  return JSON.stringify(cleanObject(value));
}

function normalizeDigest(value) {
  return typeof value === 'string' && SHA256_RE.test(value) ? value.toLowerCase() : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeProofConfig(input = {}) {
  const requestBody = input.request_body || input.requestBody || {};
  const responseBody = input.response_body || input.responseBody || {};
  const direct = firstObject(input.proven_compute, input.provenCompute, input.kolm_proven_compute);
  const fromRequest = firstObject(requestBody.kolm_proven_compute, requestBody.proven_compute);
  const fromResponse = firstObject(responseBody.kolm_proven_compute, responseBody.proven_compute);
  return {
    ...(fromRequest || {}),
    ...(direct || {}),
    ...(fromResponse || {}),
  };
}

function normalizeRuntimeNrasReport(input = {}) {
  const proof = normalizeProofConfig(input);
  const raw = firstObject(
    input.gpu_attestation,
    input.gpuAttestation,
    input.nras_report,
    input.nrasReport,
    proof.gpu_attestation,
    proof.gpuAttestation,
    proof.nras_report,
    proof.nrasReport,
  ) || firstString(
    input.gpu_attestation,
    input.gpuAttestation,
    input.nras_report,
    input.nrasReport,
    proof.gpu_attestation,
    proof.gpuAttestation,
    proof.nras_report,
    proof.nrasReport,
  );
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return {
      gpu_id: firstString(input.gpu_id, proof.gpu_id, proof.nras_gpu_id),
      driver_version: firstString(input.driver_version, proof.driver_version, proof.nras_driver_version),
      vbios_version: firstString(input.vbios_version, proof.vbios_version, proof.nras_vbios_version),
      attestation_report: raw.trim(),
      cert_chain: firstArray(input.cert_chain, proof.cert_chain, proof.gpu_cert_chain, proof.nras_cert_chain),
      nonce: firstString(input.nonce, input.eat_nonce, proof.nonce, proof.gpu_nonce, proof.eat_nonce),
    };
  }
  return null;
}

export function runtimeInferenceDigests(input = {}) {
  const requestDigest = normalizeDigest(input.input_digest || input.inputDigest)
    || sha256hex(Buffer.from(canonicalRuntimePayload(input.request_body || input.requestBody || ''), 'utf8'));
  const responseDigest = normalizeDigest(input.output_digest || input.outputDigest)
    || sha256hex(Buffer.from(canonicalRuntimePayload(input.response_body || input.responseBody || ''), 'utf8'));
  return {
    input_digest: requestDigest,
    output_digest: responseDigest,
    digest_alg: 'sha256(canonical_runtime_payload_without_proof_metadata)',
    canonicalization: 'stable-json-strip-kolm_proven_compute',
  };
}

function artifactIdentity(input = {}) {
  const proof = normalizeProofConfig(input);
  return {
    artifact_hash: normalizeDigest(
      input.artifact_hash || input.artifactHash || proof.artifact_hash || proof.artifactHash,
    ),
    cid: firstString(input.cid, input.artifact_cid, proof.cid, proof.artifact_cid),
    model_weight_artifact_manifest_hash: normalizeDigest(
      input.model_weight_artifact_manifest_hash
        || input.modelWeightArtifactManifestHash
        || proof.model_weight_artifact_manifest_hash
        || proof.modelWeightArtifactManifestHash,
    ),
    signature_key_fingerprint: firstString(
      input.signature_key_fingerprint,
      input.signatureKeyFingerprint,
      proof.signature_key_fingerprint,
      proof.signatureKeyFingerprint,
    ),
  };
}

export function runtimeProvenComputeRequired(input = {}) {
  const proof = normalizeProofConfig(input);
  const raw = input.require_proven_compute ?? input.requireProvenCompute
    ?? proof.require_proven_compute ?? proof.requireProvenCompute ?? proof.require;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

export async function buildRuntimeProvenComputeReceipt(input = {}, opts = {}) {
  const proof = normalizeProofConfig(input);
  const required = runtimeProvenComputeRequired(input);
  const report = normalizeRuntimeNrasReport(input);
  if (!report) {
    return {
      ok: false,
      required,
      reason: 'runtime_attestation_report_missing',
      version: RUNTIME_PROVEN_COMPUTE_VERSION,
    };
  }

  const digests = runtimeInferenceDigests(input);
  const identity = artifactIdentity(input);
  if (!identity.artifact_hash && !identity.cid) {
    return {
      ok: false,
      required,
      reason: 'missing_artifact_hash_or_cid',
      version: RUNTIME_PROVEN_COMPUTE_VERSION,
    };
  }

  let gpu;
  try {
    gpu = await verifyAttestation(KINDS.NRAS, report, {
      input_digest: digests.input_digest,
      output_digest: digests.output_digest,
      now_ms: opts.now_ms,
    });
  } catch (e) {
    return {
      ok: false,
      required,
      reason: `runtime_attestation_verify_failed:${e && e.message ? e.message : 'unknown'}`,
      version: RUNTIME_PROVEN_COMPUTE_VERSION,
    };
  }

  let receipt;
  try {
    receipt = buildAndSignProvenComputeReceipt({
      artifact_hash: identity.artifact_hash,
      cid: identity.cid,
      model_weight_artifact_manifest_hash: identity.model_weight_artifact_manifest_hash,
      signature_key_fingerprint: identity.signature_key_fingerprint,
      input_digest: digests.input_digest,
      output_digest: digests.output_digest,
      attestation_state: gpu,
      attestation_report: report,
      runtime_target: firstString(input.runtime_target, input.runtimeTarget, proof.runtime_target, proof.runtimeTarget)
        || 'runtime-inference',
      issued_at: input.issued_at || input.issuedAt || opts.issued_at,
    }, {
      signer: input.signer || opts.signer,
      transparencyLog: input.transparencyLog || opts.transparencyLog,
      transparency: opts.transparency,
      at: opts.at,
    });
  } catch (e) {
    return {
      ok: false,
      required,
      reason: `receipt_build_failed:${e && e.message ? e.message : 'unknown'}`,
      version: RUNTIME_PROVEN_COMPUTE_VERSION,
      gpu,
    };
  }

  const verified = verifyProvenComputeReceipt(receipt, { requireProvenCompute: required });
  if (!verified.ok) {
    return {
      ok: false,
      required,
      reason: `receipt_verify_failed:${verified.reason}`,
      version: RUNTIME_PROVEN_COMPUTE_VERSION,
      proof_scope: receipt.proof_scope,
      gpu,
      receipt,
    };
  }

  return {
    ok: true,
    required,
    version: RUNTIME_PROVEN_COMPUTE_VERSION,
    proof_scope: receipt.proof_scope,
    receipt,
    receipt_digest: verified.receipt_digest,
    input_digest: digests.input_digest,
    output_digest: digests.output_digest,
    digest_alg: digests.digest_alg,
    gpu,
  };
}

export default {
  RUNTIME_PROVEN_COMPUTE_VERSION,
  canonicalRuntimePayload,
  runtimeInferenceDigests,
  runtimeProvenComputeRequired,
  buildRuntimeProvenComputeReceipt,
};
