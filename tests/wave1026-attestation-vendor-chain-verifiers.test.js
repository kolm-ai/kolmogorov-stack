import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION,
  VERIFICATION_TIERS,
  clearAttestationVerifier,
  fingerprintChainMaterial,
  listBuiltinAttestationVerifierSpecs,
  registerAttestationVerifier,
  registerBuiltinAttestationVerifiers,
  verifyAttestation,
} from '../packages/attestation/src/index.js';
import {
  TDX_HEADER_LEN,
  TDX_MIN_QUOTE_LEN,
} from '../packages/attestation/src/tdx.js';

const ROOTS = Object.freeze({
  nitro: 'kolm-fixture-aws-nitro-root',
  amd: 'kolm-fixture-amd-ark-root',
  intel: 'kolm-fixture-intel-pcs-root',
});

function nitroPayload(byte = 'a', root = ROOTS.nitro) {
  return {
    module_id: 'i-1234567890abcdef0-enc1234',
    timestamp: 1700000000000,
    digest: 'SHA384',
    pcrs: { 0: byte.repeat(96) },
    user_data: 'kolm-w1026',
    cabundle: ['kolm-fixture-nitro-leaf', root],
  };
}

function sevReport(byte = 0xaa) {
  const buf = Buffer.alloc(1184);
  buf.writeUInt32LE(1, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeBigUInt64LE(0xABCDn, 8);
  for (let i = 0; i < 48; i++) buf[168 + i] = byte;
  for (let i = 0; i < 64; i++) buf[440 + i] = 0xbb;
  for (let i = 0; i < 512; i++) buf[672 + i] = 0x5a;
  return buf;
}

function sevPayload(root = ROOTS.amd) {
  return {
    report: sevReport(),
    vcek_cert: 'kolm-fixture-vcek-cert',
    ask_cert: 'kolm-fixture-amd-ask-cert',
    ark_cert: root,
  };
}

function fillTdxBody(buf, bodyOffset, byte, len = 48) {
  const abs = TDX_HEADER_LEN + bodyOffset;
  for (let i = 0; i < len; i++) buf[abs + i] = byte;
}

function tdxQuote({ signatureBytes = 32 } = {}) {
  const buf = Buffer.alloc(TDX_MIN_QUOTE_LEN + signatureBytes);
  buf.writeUInt16LE(4, 0);
  buf.writeUInt16LE(2, 2);
  buf.writeUInt32LE(0x81, 4);
  fillTdxBody(buf, 136, 0xdd);
  for (let i = TDX_MIN_QUOTE_LEN; i < buf.length; i++) buf[i] = 0x5a;
  return buf;
}

function tdxPayload(root = ROOTS.intel) {
  return {
    quote: tdxQuote(),
    pck_cert: 'kolm-fixture-intel-pck-cert',
    intel_root_cert: root,
  };
}

function rootPin(root) {
  return fingerprintChainMaterial(root);
}

test('W1026 built-in verifier specs cover Nitro, SEV-SNP, TDX, and cloud CVM wrappers', () => {
  const specs = listBuiltinAttestationVerifierSpecs();
  assert.equal(BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION, 'w1026-vendor-chain-verifiers-v1');
  for (const target of ['aws-nitro', 'sev-snp', 'tdx', 'gcp-cvm', 'azure-cvm']) {
    assert.ok(specs.some((spec) => spec.target === target), `missing built-in spec for ${target}`);
  }
});

test('W1026 Nitro built-in verifier upgrades only with a pinned cabundle root', () => {
  const measurement = `pcr0:sha384:${'a'.repeat(96)}`;
  try {
    registerBuiltinAttestationVerifiers(registerAttestationVerifier, { targets: ['aws-nitro'] });
    const noRoot = verifyAttestation('aws-nitro', nitroPayload('a'), { measurement, vendor: 'aws' });
    assert.equal(noRoot.valid, false);
    assert.match(noRoot.reasons.join('\n'), /no_pinned_trust_root/);

    const verified = verifyAttestation('aws-nitro', nitroPayload('a'), {
      measurement,
      vendor: 'aws',
      trust_roots: { 'aws-nitro-root': rootPin(ROOTS.nitro) },
    });
    assert.equal(verified.valid, true, verified.reasons.join('\n'));
    assert.equal(verified.tier, VERIFICATION_TIERS.CRYPTOGRAPHIC_VENDOR_CHAIN);
    assert.equal(verified.cryptographic, true);
    assert.equal(verified.verifier, 'kolm-builtin-aws-nitro-chain');
    assert.equal(verified.trust_root, rootPin(ROOTS.nitro));

    const wrongRoot = verifyAttestation('aws-nitro', nitroPayload('a', 'other-root'), {
      measurement,
      vendor: 'aws',
      trust_roots: { 'aws-nitro-root': rootPin(ROOTS.nitro) },
    });
    assert.equal(wrongRoot.valid, false);
    assert.match(wrongRoot.reasons.join('\n'), /trust_root_not_pinned/);
  } finally {
    clearAttestationVerifier('aws-nitro');
  }
});

test('W1026 SEV-SNP built-in verifier requires VCEK/ASK/ARK chain and nonzero report signature', () => {
  const measurement = `mrtd:sha384:${'aa'.repeat(48)}`;
  try {
    registerBuiltinAttestationVerifiers(registerAttestationVerifier, { targets: ['sev-snp'] });
    const verified = verifyAttestation('sev-snp', sevPayload(), {
      measurement,
      vendor: 'amd',
      trust_roots: { 'amd-ark-ask': rootPin(ROOTS.amd) },
    });
    assert.equal(verified.valid, true, verified.reasons.join('\n'));
    assert.equal(verified.verifier, 'kolm-builtin-sev-snp-chain');
    assert.equal(verified.trust_root, rootPin(ROOTS.amd));

    const zeroSig = sevPayload();
    zeroSig.report = Buffer.from(zeroSig.report);
    zeroSig.report.fill(0, 672, 672 + 512);
    const rejected = verifyAttestation('sev-snp', zeroSig, {
      measurement,
      vendor: 'amd',
      trust_roots: { 'amd-ark-ask': rootPin(ROOTS.amd) },
    });
    assert.equal(rejected.valid, false);
    assert.match(rejected.reasons.join('\n'), /missing_nonzero_report_signature/);
  } finally {
    clearAttestationVerifier('sev-snp');
  }
});

test('W1026 TDX built-in verifier requires PCS/PCK collateral and quote-signature data', () => {
  const measurement = `mrtd:sha384:${'dd'.repeat(48)}`;
  try {
    registerBuiltinAttestationVerifiers(registerAttestationVerifier, { targets: ['tdx'] });
    const verified = verifyAttestation('tdx', tdxPayload(), {
      measurement,
      vendor: 'intel',
      trust_roots: { 'intel-pcs-pck': rootPin(ROOTS.intel) },
    });
    assert.equal(verified.valid, true, verified.reasons.join('\n'));
    assert.equal(verified.verifier, 'kolm-builtin-tdx-chain');
    assert.equal(verified.trust_root, rootPin(ROOTS.intel));

    const noSig = verifyAttestation('tdx', { ...tdxPayload(), quote: tdxQuote({ signatureBytes: 0 }) }, {
      measurement,
      vendor: 'intel',
      trust_roots: { 'intel-pcs-pck': rootPin(ROOTS.intel) },
    });
    assert.equal(noSig.valid, false);
    assert.match(noSig.reasons.join('\n'), /missing_quote_signature_data/);
  } finally {
    clearAttestationVerifier('tdx');
  }
});
