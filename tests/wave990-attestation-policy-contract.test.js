// W990 - attestation trust policy.
//
// The package parsers can extract measurements from synthetic or real TEE
// payloads, but hardware TEE evidence is not valid proof unless a registered
// verifier confirms the vendor chain/signature. Explicit TOFU remains possible
// as a labeled comparison tier, and BYOC must not promote unverified hardware
// parser output to the authoritative deployment measurement.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  clearAttestationVerifier,
  registerAttestationVerifier,
  VERIFICATION_TIERS,
  verifyAttestation,
} from '../packages/attestation/src/index.js';

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w990-byoc-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_RECEIPT_SECRET = 'w990-attestation-policy-secret-0123456789';
}

function nitroPayload(byte = 'a') {
  return {
    module_id: 'i-1234567890abcdef0-enc1234',
    timestamp: 1700000000000,
    digest: 'SHA384',
    pcrs: { 0: byte.repeat(96) },
    user_data: 'kolm-w990',
    cabundle: ['MIIDxz...PEMENC'],
  };
}

test('W990 hardware TEE verification defaults to fail-closed, with explicit TOFU tier only on opt-in', () => {
  const measurement = `pcr0:sha384:${'a'.repeat(96)}`;

  const strict = verifyAttestation('aws-nitro', nitroPayload('a'), { measurement, vendor: 'aws' });
  assert.equal(strict.valid, false);
  assert.equal(strict.tier, VERIFICATION_TIERS.PARSED_UNVERIFIED);
  assert.equal(strict.cryptographic, false);
  assert.match(strict.reasons.join('\n'), /cryptographic attestation verifier required/);

  const tofu = verifyAttestation('aws-nitro', nitroPayload('a'), {
    measurement,
    vendor: 'aws',
    allow_tofu: true,
  });
  assert.equal(tofu.valid, true);
  assert.equal(tofu.tier, VERIFICATION_TIERS.TOFU_MEASUREMENT);
  assert.equal(tofu.trust_policy, 'explicit_tofu');
  assert.equal(tofu.cryptographic, false);
});

test('W990 registered verifier is required for cryptographic hardware attestation tier', () => {
  const measurement = `pcr0:sha384:${'b'.repeat(96)}`;
  try {
    registerAttestationVerifier('aws-nitro', (parsed) => {
      assert.equal(parsed.measurement, measurement);
      return { ok: true, verifier: 'fixture-nitro-chain', trust_root: 'fixture-aws-nitro-root' };
    });
    const verified = verifyAttestation('aws-nitro', nitroPayload('b'), { measurement, vendor: 'aws' });
    assert.equal(verified.valid, true);
    assert.equal(verified.tier, VERIFICATION_TIERS.CRYPTOGRAPHIC_VENDOR_CHAIN);
    assert.equal(verified.cryptographic, true);
    assert.equal(verified.verifier, 'fixture-nitro-chain');
    assert.equal(verified.trust_root, 'fixture-aws-nitro-root');
  } finally {
    clearAttestationVerifier('aws-nitro');
  }
});

test('W990 BYOC stores unverified hardware parser evidence without promoting it to authoritative measurement', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const { deployment } = byoc.createDeployment({
    tenantId: 'tenant-w990',
    tenantName: 'W990',
    target: 'aws-nitro',
    artifactId: 'artifact-w990',
  });

  const selfReported = 'sha256:' + 'c'.repeat(64);
  const parsedMeasurement = `pcr0:sha384:${'d'.repeat(96)}`;
  const recorded = byoc.recordAttestation(deployment.enroll_token, {
    public_url: 'https://nitro.example.test/runtime',
    measurement: selfReported,
    attestation: nitroPayload('d'),
  });

  assert.equal(recorded.ok, true);
  assert.equal(recorded.vendor, 'aws');
  assert.equal(recorded.measurement, selfReported);

  const stored = byoc.getDeployment(deployment.id);
  assert.equal(stored.attestation.measurement, selfReported);
  assert.equal(stored.attestation.parsed.measurement, parsedMeasurement);
  assert.equal(stored.attestation.parsed.verification.valid, false);
  assert.equal(stored.attestation.parsed.verification.tier, VERIFICATION_TIERS.PARSED_UNVERIFIED);
  assert.equal(stored.attestation.parsed.verification.cryptographic, false);
  assert.match(stored.attestation.parsed.verification.reasons.join('\n'), /cryptographic attestation verifier required/);
});
