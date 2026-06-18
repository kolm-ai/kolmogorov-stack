// tests/wave968-proven-compute-receipt.test.js
//
// Contract coverage for src/proven-compute-receipt.js. No live GPU, network, or
// vendor service is used here; the tests prove the local receipt gate is honest:
// proven_compute only when a cryptographic verifier state and nonce binding are
// both present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { generateKeyPair } from '../src/ed25519.js';
import {
  clearAttestationVerifier,
  registerAttestationVerifier,
  verifyAttestation,
} from '../src/confidential-compute.js';
import { nonceBinding } from '../src/nras-verifier.js';
import { TransparencyLog } from '../src/transparency-log.js';
import {
  PROVEN_COMPUTE_RECEIPT_SCHEMA,
  assessProvenComputeProof,
  buildAndSignProvenComputeReceipt,
  verifyProvenComputeReceipt,
} from '../src/proven-compute-receipt.js';

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function validNrasReport(nonce) {
  return {
    gpu_id: 'GPU-wave968',
    driver_version: '550.90.07',
    vbios_version: '96.00.74.00.01',
    attestation_report: 'ZmFrZS1ucmFzLXRva2Vu',
    cert_chain: ['-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----'],
    nonce,
  };
}

function signer() {
  return generateKeyPair();
}

test('W968 proven-compute receipt verifies with cryptographic attestation state + nonce binding', async () => {
  const inputDigest = sha256hex('prompt bytes');
  const outputDigest = sha256hex('output bytes');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);
  const report = validNrasReport(expectedNonce);
  const artifactHash = sha256hex('artifact bytes');

  try {
    registerAttestationVerifier('nras', async () => ({
      ok: true,
      verifier: 'nras',
      trust_root: 'pinned-nvidia-root',
      report_hash: sha256hex('nras report'),
      eat_nonce: expectedNonce,
      expected_nonce: expectedNonce,
      nonce_binding_alg: 'sha256(input_digest||output_digest)',
      cert_chain_length: 2,
    }));
    const state = await verifyAttestation('nras', report, {
      input_digest: inputDigest,
      output_digest: outputDigest,
    });
    assert.equal(state.verified, true);
    assert.equal(state.nonce, expectedNonce, 'verified state must preserve the nonce evidence');
    assert.equal(state.expected_nonce, expectedNonce);

    const tlog = new TransparencyLog({ origin: 'kolm.ai/test/proven-compute' });
    const receipt = buildAndSignProvenComputeReceipt({
      artifact_hash: artifactHash,
      input_digest: inputDigest,
      output_digest: outputDigest,
      attestation_state: state,
      runtime_target: 'nvidia-h100-cc',
      issued_at: '2026-06-19T00:00:00.000Z',
    }, { signer: signer(), transparencyLog: tlog, at: '2026-06-19T00:00:01.000Z' });

    assert.equal(receipt.schema, PROVEN_COMPUTE_RECEIPT_SCHEMA);
    assert.equal(receipt.proof_scope, 'proven_compute');
    assert.equal(receipt.inference.nonce_binding, expectedNonce);
    assert.equal(receipt.proof.nonce_source, 'attestation.expected_nonce');
    assert.ok(receipt.signature_ed25519, 'receipt must be Ed25519 signed');
    assert.ok(receipt.transparency_checkpoint?.inclusion, 'receipt digest must be transparency-log anchored');

    const verified = verifyProvenComputeReceipt(receipt, { requireProvenCompute: true });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.proof_scope, 'proven_compute');
  } finally {
    clearAttestationVerifier('nras');
  }
});

test('W968 shape-only attestation cannot self-upgrade to proven_compute', () => {
  const inputDigest = sha256hex('input');
  const outputDigest = sha256hex('output');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);
  const receipt = buildAndSignProvenComputeReceipt({
    artifact_hash: sha256hex('artifact'),
    input_digest: inputDigest,
    output_digest: outputDigest,
    attestation_state: {
      kind: 'nras',
      state: 'shape_ok',
      verified: false,
      verifier: 'shape_v1',
      nonce: expectedNonce,
      report_hash: sha256hex('shape report'),
    },
    issued_at: '2026-06-19T00:00:00.000Z',
  }, { signer: signer(), transparency: false });

  assert.equal(receipt.proof_scope, 'key_custody');
  assert.equal(verifyProvenComputeReceipt(receipt).ok, true);
  const required = verifyProvenComputeReceipt(receipt, { requireProvenCompute: true });
  assert.equal(required.ok, false);
  assert.match(required.reason, /attestation_not_cryptographically_verified/);

  const forged = JSON.parse(JSON.stringify(receipt));
  forged.proof_scope = 'proven_compute';
  const forgedVerify = verifyProvenComputeReceipt(forged);
  assert.equal(forgedVerify.ok, false, 'changing proof_scope breaks the signed payload or recomputed gate');
});

test('W968 verified attestation without matching nonce remains key_custody', () => {
  const inputDigest = sha256hex('input');
  const outputDigest = sha256hex('output');
  const wrongNonce = '00'.repeat(32);
  const assessment = assessProvenComputeProof({
    artifact_hash: sha256hex('artifact'),
    input_digest: inputDigest,
    output_digest: outputDigest,
    attestation_state: {
      kind: 'nras',
      state: 'cryptographically_verified',
      verified: true,
      verifier: 'nras',
      nonce: wrongNonce,
      report_hash: sha256hex('report'),
    },
  });

  assert.equal(assessment.ok, false);
  assert.equal(assessment.proof_scope, 'key_custody');
  assert.ok(assessment.reasons.includes('nonce_binding_missing_or_mismatch'));
});

test('W968 receipt signature fails on output digest tamper', async () => {
  const inputDigest = sha256hex('prompt');
  const outputDigest = sha256hex('answer');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);
  const receipt = buildAndSignProvenComputeReceipt({
    artifact_hash: sha256hex('artifact'),
    input_digest: inputDigest,
    output_digest: outputDigest,
    attestation_state: {
      kind: 'nras',
      state: 'cryptographically_verified',
      verified: true,
      verifier: 'nras',
      expected_nonce: expectedNonce,
      report_hash: sha256hex('report'),
    },
    issued_at: '2026-06-19T00:00:00.000Z',
  }, { signer: signer(), transparency: false });
  assert.equal(verifyProvenComputeReceipt(receipt, { requireProvenCompute: true }).ok, true);

  const tampered = JSON.parse(JSON.stringify(receipt));
  tampered.inference.output_digest = sha256hex('different answer');
  const verified = verifyProvenComputeReceipt(tampered, { requireProvenCompute: true });
  assert.equal(verified.ok, false);
  assert.match(verified.reason, /^signature:/);
});

test('W968 base64url nonce evidence is accepted when it decodes to the digest binding', () => {
  const inputDigest = sha256hex('base64 input');
  const outputDigest = sha256hex('base64 output');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);
  const receipt = buildAndSignProvenComputeReceipt({
    artifact_hash: sha256hex('artifact'),
    input_digest: inputDigest,
    output_digest: outputDigest,
    attestation_state: {
      kind: 'nras',
      state: 'cryptographically_verified',
      verified: true,
      verifier: 'nras',
      nonce: Buffer.from(expectedNonce, 'hex').toString('base64url'),
      report_hash: sha256hex('report'),
    },
    issued_at: '2026-06-19T00:00:00.000Z',
  }, { signer: signer(), transparency: false });

  assert.equal(receipt.proof_scope, 'proven_compute');
  assert.equal(verifyProvenComputeReceipt(receipt, { requireProvenCompute: true }).ok, true);
});
