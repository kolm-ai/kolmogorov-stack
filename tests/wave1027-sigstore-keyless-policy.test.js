// W1027 - Sigstore keyless/Fulcio policy contract.
//
// These tests are offline by design. They prove that Kolm has an optional
// keyless verification policy with exact OIDC identity binding, pinned Fulcio
// root material, and Rekor evidence, while keeping SLSA Build L3 locked behind
// separate hardened-builder evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGSTORE_KEYLESS_POLICY_VERSION,
  SIGSTORE_KEYLESS_DESCRIPTOR_FIXTURE_SCOPE,
  buildFulcioKeylessPolicy,
  verifySigstoreKeylessBundle,
  extractSigstoreKeylessMaterial,
  assessSlsaL3Eligibility,
  fingerprintChainMaterial,
} from '../src/sigstore-keyless.js';
import {
  getSlsaProfile,
  SLSA_PROFILE_IDS,
  validateSlsaProfileRegistry,
} from '../src/slsa-profile-registry.js';
import { INTOTO_SLSA_SPEC } from '../src/intoto-slsa.js';
import { buildSigstoreBundle } from '../src/sigstore.js';
import { generateKeyPair } from '../src/ed25519.js';
import { canonicalJson } from '../src/cid.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const IDENTITY = 'https://github.com/kolm-ai/kolm/.github/workflows/release.yml@refs/heads/main';
const ROOT_PIN = fingerprintChainMaterial('w1027-fulcio-root-fixture');
const REKOR_LOG_ID = '8f'.repeat(32);

function policy(overrides = {}) {
  return buildFulcioKeylessPolicy({
    issuer: ISSUER,
    identity: IDENTITY,
    fulcioRootSha256: ROOT_PIN,
    rekorLogId: REKOR_LOG_ID,
    sourceRepository: 'kolm-ai/kolm',
    workflowRef: 'refs/heads/main',
    allowDescriptorFixture: true,
    ...overrides,
  });
}

function keylessBundle(overrides = {}) {
  const { verificationMaterial, ...topLevel } = overrides;
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
    verificationMaterial: {
      certificate: {
        subject: IDENTITY,
        oidcIssuer: ISSUER,
        identities: [IDENTITY],
        certificate_sha256: 'c1'.repeat(32),
        valid_from: '2025-01-01T00:00:00.000Z',
        valid_to: '2027-01-01T00:00:00.000Z',
        chain_verified: true,
      },
      fulcio_root_sha256: ROOT_PIN,
      source_repository: 'kolm-ai/kolm',
      workflow_ref: 'refs/heads/main',
      tlogEntries: [{
        logId: { keyId: REKOR_LOG_ID },
        integratedTime: 1763419200,
        inclusionProof: { logIndex: 0, treeSize: 1, rootHash: '00'.repeat(32), hashes: [] },
      }],
      ...(verificationMaterial || {}),
    },
    ...topLevel,
  };
}

test('W1027 #1 - keyless policy normalizes exact issuer, identity, root, and Rekor pins', () => {
  const p = policy();
  assert.equal(p.ok, true, p.failures.join(','));
  assert.equal(p.version, SIGSTORE_KEYLESS_POLICY_VERSION);
  assert.deepEqual(p.issuers, [ISSUER]);
  assert.deepEqual(p.identities, [IDENTITY]);
  assert.deepEqual(p.fulcio_root_sha256, [ROOT_PIN]);
  assert.deepEqual(p.rekor_log_ids, [REKOR_LOG_ID]);
  assert.equal(p.require_rekor, true);
  assert.equal(p.require_certificate_chain, true);
});

test('W1027 #2 - descriptor fixture path verifies only when explicitly allowed and fully pinned', () => {
  const result = verifySigstoreKeylessBundle(keylessBundle(), policy());
  assert.equal(result.ok, true, result.failures.join(','));
  assert.equal(result.claim_scope, SIGSTORE_KEYLESS_DESCRIPTOR_FIXTURE_SCOPE);
  assert.equal(result.keyless_oidc_identity_bound, true);
  assert.equal(result.certificate_identity_bound, true);
  assert.equal(result.fulcio_root_pinned, true);
  assert.equal(result.rekor_bound, true);
  assert.equal(result.slsa_build_l3_claim_allowed, false);
});

test('W1027 #3 - issuer, identity, root, and Rekor mismatches fail closed', () => {
  const wrongIssuer = keylessBundle({ verificationMaterial: { certificate: { oidcIssuer: 'https://issuer.example.invalid', identities: [IDENTITY], chain_verified: true } } });
  assert.equal(verifySigstoreKeylessBundle(wrongIssuer, policy()).ok, false);
  assert.ok(verifySigstoreKeylessBundle(wrongIssuer, policy()).failures.includes('oidc_issuer_not_allowed'));

  const wrongIdentity = keylessBundle({ verificationMaterial: { certificate: { oidcIssuer: ISSUER, identities: ['https://github.com/other/repo/.github/workflows/release.yml@refs/heads/main'], chain_verified: true } } });
  const identityResult = verifySigstoreKeylessBundle(wrongIdentity, policy());
  assert.equal(identityResult.ok, false);
  assert.ok(identityResult.failures.includes('oidc_identity_not_allowed'));

  const wrongRoot = keylessBundle({ verificationMaterial: { fulcio_root_sha256: 'aa'.repeat(32) } });
  const rootResult = verifySigstoreKeylessBundle(wrongRoot, policy());
  assert.equal(rootResult.ok, false);
  assert.ok(rootResult.failures.includes('fulcio_root_pin_mismatch'));

  const wrongRekor = keylessBundle({ verificationMaterial: { tlogEntries: [{ logId: { keyId: 'bb'.repeat(32) }, inclusionProof: {} }] } });
  const rekorResult = verifySigstoreKeylessBundle(wrongRekor, policy());
  assert.equal(rekorResult.ok, false);
  assert.ok(rekorResult.failures.includes('rekor_log_id_not_allowed'));
});

test('W1027 #4 - missing Rekor inclusion and missing descriptor-fixture opt-in fail closed', () => {
  const noRekor = keylessBundle({ verificationMaterial: { tlogEntries: [] } });
  const noRekorResult = verifySigstoreKeylessBundle(noRekor, policy());
  assert.equal(noRekorResult.ok, false);
  assert.ok(noRekorResult.failures.includes('rekor_entry_missing'));

  const noInclusion = keylessBundle({ verificationMaterial: { tlogEntries: [{ logId: { keyId: REKOR_LOG_ID }, integratedTime: 1763419200 }] } });
  const noInclusionResult = verifySigstoreKeylessBundle(noInclusion, policy());
  assert.equal(noInclusionResult.ok, false);
  assert.ok(noInclusionResult.failures.includes('rekor_inclusion_missing'));

  const strictPolicy = policy({ allowDescriptorFixture: false });
  const strictResult = verifySigstoreKeylessBundle(keylessBundle(), strictPolicy);
  assert.equal(strictResult.ok, false);
  assert.ok(strictResult.failures.includes('x509_chain_incomplete'));
});

test('W1027 #5 - existing Kolm dry-run sigstore shim remains bare-key, not keyless', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const block = buildSigstoreBundle({
    publicKey,
    privateKey,
    payloadCanonical: canonicalJson({ w: 1027 }),
  });
  const result = verifySigstoreKeylessBundle(block.bundle, policy());
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('keyless_certificate_missing'));

  const material = extractSigstoreKeylessMaterial(block.bundle);
  assert.equal(material.present, false);
  assert.equal(material.tlog_entry_count, 0);
});

test('W1027 #6 - keyless verification alone does not authorize SLSA Build L3', () => {
  const keyless = verifySigstoreKeylessBundle(keylessBundle(), policy());
  const noBuilder = assessSlsaL3Eligibility({ keylessVerification: keyless });
  assert.equal(noBuilder.ok, false);
  assert.equal(noBuilder.slsa_build_l3_claim_allowed, false);
  assert.ok(noBuilder.failures.includes('hardened_builder_missing'));

  const withBuilder = assessSlsaL3Eligibility({
    keylessVerification: keyless,
    hardenedBuilderEvidence: {
      hardened_builder: true,
      ephemeral_isolated_builder: true,
      non_falsifiable_provenance: true,
      builder_id: 'https://github.com/kolm-ai/kolm/.github/workflows/release.yml',
    },
  });
  assert.equal(withBuilder.ok, true, withBuilder.failures.join(','));
  assert.equal(withBuilder.slsa_build_l3_claim_allowed, true);
});

test('W1027 #7 - model-artifact SLSA profile exposes optional keyless without changing default L2 claim', () => {
  const registry = validateSlsaProfileRegistry();
  assert.equal(registry.ok, true, registry.failures.join(','));
  const profile = getSlsaProfile(SLSA_PROFILE_IDS.MODEL_ARTIFACT);
  assert.equal(profile.keyless_oidc_option_supported, true);
  assert.equal(profile.keyless_policy_module, 'src/sigstore-keyless.js');
  assert.equal(profile.keyless_oidc_identity_bound, false);
  assert.equal(profile.slsa_build_l3_claim_allowed, false);
  assert.ok(profile.optional_identity_modes.includes('sigstore_keyless_fulcio_oidc_policy'));

  assert.equal(INTOTO_SLSA_SPEC.keyless_oidc_option_supported, true);
  assert.equal(INTOTO_SLSA_SPEC.keyless_policy_module, 'src/sigstore-keyless.js');
  assert.equal(INTOTO_SLSA_SPEC.slsa_build_l3_claim_allowed, false);
  assert.match(INTOTO_SLSA_SPEC.conformance, /L2/);
});
