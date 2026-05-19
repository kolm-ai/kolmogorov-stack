// W409v — confidential compute metadata + plugin-only "verified" claim.
//
// Audit said: "defaults to shape-only verification". W409v keeps the
// honest shape-only default + adds an explicit verifier-plugin interface
// (registerVerifier) keyed by provider. The product cannot say
// "confidential compute verified" without a registered plugin returning
// ok:true.
//
// Tests assert behavior:
//   1. Shape-only path → verified:false, reason:'shape_only_no_plugin'.
//   2. registerVerifier('fake-verifier', fn) → verified:true (only because
//      plugin is registered).
//   3. Metadata fields (attestation_provider, attestation_report_hash,
//      trusted_execution_required, enclave_image_hash, gpu_attestation_hash)
//      survive a JSON round-trip and reproduce the same verifier result.
//   4. clearVerifier reverts back to shape-only path.
//   5. listRegisteredProviderVerifiers reports registered providers.
//   6. Missing attestation_provider → reason:'missing_attestation_provider'.
//   7. Provider names list contains the canonical set.
//   8. Plugin that throws → verified:false, reason:'plugin_threw:*'.
//   9. fakeVerifier helper is exported (testing only) and never auto-registered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTESTATION_SPEC_VERSION,
  PROVIDERS,
  W409V_METADATA_FIELDS,
  registerVerifier,
  clearVerifier,
  listRegisteredProviderVerifiers,
  verifyConfidentialCompute,
  buildConfidentialComputeMetadata,
  manifestRoundTrip,
  fakeVerifier,
} from '../src/confidential-compute.js';

function happyMetadata(over = {}) {
  return buildConfidentialComputeMetadata({
    attestation_provider: 'azure-tdx',
    attestation_report_hash: 'aa'.repeat(32),
    trusted_execution_required: true,
    enclave_image_hash: 'bb'.repeat(32),
    gpu_attestation_hash: 'cc'.repeat(32),
    ...over,
  });
}

test('W409v #1 — shape-only path returns verified:false, reason:"shape_only_no_plugin"', async () => {
  // No plugin registered for azure-tdx → shape-only path.
  clearVerifier('azure-tdx');
  const meta = happyMetadata();
  const r = await verifyConfidentialCompute(meta);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'shape_only_no_plugin');
  assert.equal(r.provider, 'azure-tdx');
  assert.equal(r.plugin, null);
});

test('W409v #2 — registering a fake-verifier flips verified to true', async () => {
  registerVerifier('azure-tdx', fakeVerifier);
  try {
    const meta = happyMetadata();
    const r = await verifyConfidentialCompute(meta);
    assert.equal(r.verified, true);
    assert.equal(r.plugin, 'azure-tdx');
    assert.equal(r.provider, 'azure-tdx');
    assert.equal(r.verifier_meta.fake, true,
      'fake-verifier must surface its __fake__ marker so reviewers can spot it');
  } finally {
    clearVerifier('azure-tdx');
  }
});

test('W409v #3 — metadata fields survive a JSON round-trip and reproduce the same verifier result', async () => {
  registerVerifier('aws-nitro', fakeVerifier);
  try {
    const meta = happyMetadata({ attestation_provider: 'aws-nitro' });
    // Round-trip via JSON (manifest-shaped).
    const round = manifestRoundTrip(meta);
    // All five W409v fields present after round-trip.
    for (const f of W409V_METADATA_FIELDS) {
      assert.ok(f in round, `field ${f} survives round-trip`);
    }
    assert.equal(round.attestation_provider, 'aws-nitro');
    assert.equal(round.attestation_report_hash, 'aa'.repeat(32));
    assert.equal(round.trusted_execution_required, true);
    assert.equal(round.enclave_image_hash, 'bb'.repeat(32));
    assert.equal(round.gpu_attestation_hash, 'cc'.repeat(32));
    // Verifier produces identical state pre- and post-round-trip.
    const before = await verifyConfidentialCompute(meta);
    const after = await verifyConfidentialCompute(round);
    assert.equal(before.verified, after.verified);
    assert.equal(before.plugin, after.plugin);
    assert.equal(before.provider, after.provider);
  } finally {
    clearVerifier('aws-nitro');
  }
});

test('W409v #4 — clearVerifier reverts back to shape-only path', async () => {
  registerVerifier('gcp-tdx', fakeVerifier);
  let r1 = await verifyConfidentialCompute(happyMetadata({ attestation_provider: 'gcp-tdx' }));
  assert.equal(r1.verified, true);
  clearVerifier('gcp-tdx');
  let r2 = await verifyConfidentialCompute(happyMetadata({ attestation_provider: 'gcp-tdx' }));
  assert.equal(r2.verified, false);
  assert.equal(r2.reason, 'shape_only_no_plugin');
});

test('W409v #5 — listRegisteredProviderVerifiers reports registered providers (sorted)', () => {
  registerVerifier('a-prov', fakeVerifier);
  registerVerifier('z-prov', fakeVerifier);
  try {
    const ls = listRegisteredProviderVerifiers();
    assert.ok(ls.includes('a-prov'));
    assert.ok(ls.includes('z-prov'));
    // Sorted.
    assert.deepEqual(ls.slice().sort(), ls);
  } finally {
    clearVerifier('a-prov');
    clearVerifier('z-prov');
  }
});

test('W409v #6 — missing attestation_provider → reason:"missing_attestation_provider"', async () => {
  // Bypass the builder so we can hand-craft a missing-field metadata.
  const broken = { attestation_report_hash: 'aa'.repeat(32) };
  const r = await verifyConfidentialCompute(broken);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'missing_attestation_provider');
});

test('W409v #6b — null/undefined metadata → reason:"no_metadata"', async () => {
  const r1 = await verifyConfidentialCompute(null);
  assert.equal(r1.verified, false);
  assert.equal(r1.reason, 'no_metadata');
  const r2 = await verifyConfidentialCompute(undefined);
  assert.equal(r2.verified, false);
  assert.equal(r2.reason, 'no_metadata');
});

test('W409v #7 — PROVIDERS list contains canonical set (azure-tdx, gcp-tdx, aws-nitro, sev-snp)', () => {
  for (const p of ['azure-tdx', 'gcp-tdx', 'aws-nitro', 'sev-snp']) {
    assert.ok(PROVIDERS.includes(p), `PROVIDERS must include ${p}`);
  }
});

test('W409v #8 — plugin that throws → verified:false, reason starts with "plugin_threw:"', async () => {
  registerVerifier('breaks', async () => { throw new Error('boom'); });
  try {
    const meta = happyMetadata({ attestation_provider: 'breaks' });
    const r = await verifyConfidentialCompute(meta);
    assert.equal(r.verified, false);
    assert.match(r.reason, /^plugin_threw:/);
  } finally {
    clearVerifier('breaks');
  }
});

test('W409v #8b — plugin that returns ok:false → verified:false, reason:"plugin_returned_falsy"', async () => {
  registerVerifier('refuses', async () => ({ ok: false, reason: 'no_trust_chain' }));
  try {
    const meta = happyMetadata({ attestation_provider: 'refuses' });
    const r = await verifyConfidentialCompute(meta);
    assert.equal(r.verified, false);
    assert.equal(r.reason, 'plugin_returned_falsy');
    assert.equal(r.plugin_reason, 'no_trust_chain');
  } finally {
    clearVerifier('refuses');
  }
});

test('W409v #9 — fakeVerifier helper is exported (testing only) and not auto-registered', () => {
  // Confirm the helper exists.
  assert.equal(typeof fakeVerifier, 'function');
  // It is not registered by default — every fresh boot starts shape-only.
  const ls = listRegisteredProviderVerifiers();
  assert.equal(ls.includes('fake-verifier'), false,
    'fake-verifier must NOT be auto-registered (prod registers nothing)');
});

test('W409v #10 — buildConfidentialComputeMetadata refuses without attestation_provider', () => {
  assert.throws(() => buildConfidentialComputeMetadata({}), /attestation_provider/i);
});

test('W409v #11 — W409V_METADATA_FIELDS exposes the five required fields', () => {
  const expected = ['attestation_provider', 'attestation_report_hash', 'trusted_execution_required', 'enclave_image_hash', 'gpu_attestation_hash'];
  for (const f of expected) {
    assert.ok(W409V_METADATA_FIELDS.includes(f), `metadata field list must include ${f}`);
  }
});

test('W409v #12 — verifier carries spec version + timestamp', async () => {
  const r = await verifyConfidentialCompute(happyMetadata());
  assert.equal(r.spec, ATTESTATION_SPEC_VERSION);
  assert.ok(r.timestamp);
});
