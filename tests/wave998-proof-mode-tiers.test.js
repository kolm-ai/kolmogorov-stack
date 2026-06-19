// W998: verifiable-inference proof-mode tiers.
//
// This closes the local opML/zkML interface gap without upgrading product
// claims: TEE remains the deployable default, while opML and zkML are explicit,
// fail-closed proof modes that require a registered verifier plus input/output
// binding before any proven-compute wording is allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { generateKeyPair } from '../src/ed25519.js';
import { runAudit } from '../src/audit-orchestrator.js';
import {
  buildAndSignReport,
  verifyReport,
} from '../src/attestation-report-builder.js';
import { nonceBinding } from '../src/nras-verifier.js';
import {
  PROOF_MODE,
  PROOF_SCOPE,
  proofModeDescriptor,
  proofModeForState,
  proofScopeAssessment,
} from '../src/receipt-export-registry.js';
import {
  buildAndSignProvenComputeReceipt,
  verifyProvenComputeReceipt,
} from '../src/proven-compute-receipt.js';

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function signer() {
  return generateKeyPair();
}

function auditWithProofState(state) {
  const audit = runAudit('', { source: 'import' });
  audit.confidential_compute = state;
  return audit;
}

test('W998 proof-mode registry exposes TEE, opML, and zkML as explicit tiers', () => {
  assert.equal(proofModeForState({ verified: true, verifier: 'nras' }), PROOF_MODE.TEE_NRAS);
  assert.equal(proofModeForState({ verified: true, verifier: 'opml-finality', proof_mode: 'opml' }), PROOF_MODE.OPML);
  assert.equal(proofModeForState({ verified: true, verifier: 'ezkl-adapter', proof_system: 'zkml' }), PROOF_MODE.ZKML);

  assert.equal(proofModeDescriptor(PROOF_MODE.TEE_NRAS).default_claimable, true);
  assert.equal(proofModeDescriptor(PROOF_MODE.OPML).default_claimable, false);
  assert.equal(proofModeDescriptor(PROOF_MODE.ZKML).default_claimable, false);
  assert.match(proofModeDescriptor(PROOF_MODE.OPML).frontier_readiness, /roadmap_interface_only/);
});

test('W998 opML mode remains key-custody until a verifier state is actually verified', () => {
  const unverified = proofScopeAssessment({
    verified: false,
    verifier: 'opml-finality',
    proof_mode: 'opml',
    state: 'challenge_window_pending',
  });
  assert.equal(unverified.scope, PROOF_SCOPE.KEY_CUSTODY);
  assert.equal(unverified.proof_mode, PROOF_MODE.OPML);

  const verified = proofScopeAssessment({
    verified: true,
    verifier: 'opml-finality',
    proof_mode: 'opml',
    state: 'challenge_window_finalized',
  });
  assert.equal(verified.scope, PROOF_SCOPE.PROVEN_COMPUTE);
  assert.equal(verified.proof_mode, PROOF_MODE.OPML);
  assert.equal(verified.default_claimable, false, 'opML is an interface tier, not a default product claim');
});

test('W998 signed report proof_scope records opML mode and caveat wording', () => {
  const audit = auditWithProofState({
    verified: true,
    verifier: 'opml-finality',
    proof_mode: 'opml',
    state: 'challenge_window_finalized',
  });
  const { envelope } = buildAndSignReport(audit, { subject: 'W998' });
  const caveat = envelope.caveats.find((c) => c.startsWith('Proof scope:'));

  assert.equal(envelope.proof_scope.scope, PROOF_SCOPE.PROVEN_COMPUTE);
  assert.equal(envelope.proof_scope.proof_mode, PROOF_MODE.OPML);
  assert.equal(envelope.proof_scope.default_claimable, false);
  assert.equal(envelope.proof_scope.evidence_family, 'optimistic_dispute');
  assert.match(caveat, /cryptographically verified compute evidence from opml-finality \(opML \/ optimistic ML\)/);
  assert.match(caveat, /input\/output binding/);
  assert.equal(verifyReport(envelope).ok, true);
});

test('W998 opML receipt can prove compute only with nonce binding', () => {
  const inputDigest = sha256hex('opml prompt');
  const outputDigest = sha256hex('opml answer');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);
  const receipt = buildAndSignProvenComputeReceipt({
    artifact_hash: sha256hex('opml artifact'),
    input_digest: inputDigest,
    output_digest: outputDigest,
    attestation_state: {
      verified: true,
      verifier: 'opml-finality',
      proof_mode: 'opml',
      state: 'challenge_window_finalized',
      expected_nonce: expectedNonce,
      report_hash: sha256hex('opml transcript'),
    },
    issued_at: '2026-06-19T00:00:00.000Z',
  }, { signer: signer(), transparency: false });

  assert.equal(receipt.proof_scope, PROOF_SCOPE.PROVEN_COMPUTE);
  assert.equal(receipt.proof_mode, PROOF_MODE.OPML);
  assert.equal(receipt.proof.evidence_family, 'optimistic_dispute');
  const verified = verifyProvenComputeReceipt(receipt, { requireProvenCompute: true });
  assert.equal(verified.ok, true, JSON.stringify(verified));
});

test('W998 zkML receipt interface fails closed without public-input nonce binding', () => {
  const receipt = buildAndSignProvenComputeReceipt({
    artifact_hash: sha256hex('zk artifact'),
    input_digest: sha256hex('zk prompt'),
    output_digest: sha256hex('zk answer'),
    attestation_state: {
      verified: true,
      verifier: 'zkml-proof-adapter',
      proof_mode: 'zkml',
      proof_system: 'ezkl',
      public_inputs_hash: sha256hex('artifact+input+output'),
      report_hash: sha256hex('zk proof'),
    },
    issued_at: '2026-06-19T00:00:00.000Z',
  }, { signer: signer(), transparency: false });

  assert.equal(receipt.proof_scope, PROOF_SCOPE.KEY_CUSTODY);
  assert.equal(receipt.proof_mode, PROOF_MODE.ZKML);
  const required = verifyProvenComputeReceipt(receipt, { requireProvenCompute: true });
  assert.equal(required.ok, false);
  assert.match(required.reason, /nonce_binding_missing_or_mismatch/);
});
