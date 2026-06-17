// Tests for the TEE attestation parsers.
//
// These tests use synthetic fixture payloads that exercise the parser logic
// without needing real hardware. Real-hardware validation lives in the
// integration test suite (run only on EC2 Nitro / AMD SEV-SNP / Intel TDX).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  parseAttestation,
  verifyAttestation,
  extractMeasurement,
  SUPPORTED_TARGETS,
} from '../src/index.js';

test('SUPPORTED_TARGETS includes the BYOC targets', () => {
  for (const t of ['aws-nitro', 'sev-snp', 'tdx', 'gcp-cvm', 'azure-cvm', 'docker']) {
    assert.ok(SUPPORTED_TARGETS.includes(t), `missing target: ${t}`);
  }
});

test('parseAttestation rejects unknown targets', () => {
  const r = parseAttestation('unknown', 'whatever');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unsupported target/);
});

// ---------- aws-nitro ----------

test('nitro: parses pre-parsed envelope with PCR0', () => {
  const payload = {
    module_id: 'i-1234567890abcdef0-enc1234',
    timestamp: 1700000000000,
    digest: 'SHA384',
    pcrs: { 0: 'a'.repeat(96), 1: 'b'.repeat(96) },
    user_data: 'kolm-deploy-123',
    cabundle: ['MIIDxz...PEMENC'],
  };
  const r = parseAttestation('aws-nitro', payload);
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'aws');
  assert.match(r.measurement, /^pcr0:sha384:a+$/);
  assert.equal(r.claims.module_id, 'i-1234567890abcdef0-enc1234');
  assert.equal(r.claims.signed_at, new Date(1700000000000).toISOString());
  assert.deepEqual(Object.keys(r.claims.pcrs).sort(), ['0', '1']);
});

test('nitro: rejects payload missing PCR0', () => {
  const r = parseAttestation('aws-nitro', { module_id: 'x', pcrs: { 1: 'b'.repeat(96) } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /PCR0/);
});

// ---------- sev-snp ----------

test('sev-snp: parses minimal 1184-byte report', () => {
  const buf = Buffer.alloc(1184);
  // version=1, guest_svn=2 at offsets 0/4
  buf.writeUInt32LE(1, 0);
  buf.writeUInt32LE(2, 4);
  // policy at offset 8
  buf.writeBigUInt64LE(0xABCDn, 8);
  // measurement at offset 168 — fill with 0xAA
  for (let i = 0; i < 48; i++) buf[168 + i] = 0xAA;
  // chip_id at offset 440
  for (let i = 0; i < 64; i++) buf[440 + i] = 0xBB;

  const r = parseAttestation('sev-snp', buf);
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'amd');
  assert.equal(r.measurement, `mrtd:sha384:${'aa'.repeat(48)}`);
  assert.equal(r.claims.version, 1);
  assert.equal(r.claims.guest_svn, 2);
  assert.equal(r.claims.chip_id, 'bb'.repeat(64));
});

test('sev-snp: rejects truncated report', () => {
  const r = parseAttestation('sev-snp', Buffer.alloc(512));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /too short/);
});

test('sev-snp: accepts hex-string payload', () => {
  const buf = Buffer.alloc(1184);
  for (let i = 0; i < 48; i++) buf[168 + i] = 0x11;
  const r = parseAttestation('sev-snp', buf.toString('hex'));
  assert.equal(r.ok, true);
  assert.equal(r.measurement, `mrtd:sha384:${'11'.repeat(48)}`);
});

// ---------- tdx ----------

test('tdx: parses minimal quote', () => {
  const buf = Buffer.alloc(48 + 584);
  buf.writeUInt16LE(4, 0);   // version
  buf.writeUInt16LE(2, 2);   // attestation_key_type
  // mr_seam at offset 64
  for (let i = 0; i < 48; i++) buf[64 + i] = 0xCC;
  // mr_td at absolute offset 184 (TD10 report body offset 136)
  for (let i = 0; i < 48; i++) buf[184 + i] = 0xDD;
  const r = parseAttestation('tdx', buf);
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'intel');
  assert.equal(r.measurement, `mrtd:sha384:${'dd'.repeat(48)}`);
  assert.equal(r.claims.mr_seam, 'cc'.repeat(48));
});

// ---------- gcp-cvm ----------

test('gcp-cvm: dispatches to sev-snp', () => {
  const inner = Buffer.alloc(1184);
  for (let i = 0; i < 48; i++) inner[168 + i] = 0xEE;
  const r = parseAttestation('gcp-cvm', {
    provider: 'gcp',
    technology: 'sev-snp',
    report: inner.toString('hex'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'gcp');
  assert.equal(r.claims.csp, 'gcp');
  assert.equal(r.claims.technology, 'sev-snp');
  assert.equal(r.measurement, `mrtd:sha384:${'ee'.repeat(48)}`);
});

// ---------- azure-cvm ----------

test('azure-cvm: parses MAA JWT claim', () => {
  const claims = {
    'x-ms-attestation-type': 'sevsnpvm',
    'x-ms-sevsnpvm-launchmeasurement': 'ff'.repeat(48),
    iat: 1700000000,
    iss: 'https://shareduks.uks.attest.azure.net',
    aud: 'https://kolm.ai',
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const jwt = `eyJ.${body}.sig`;
  const r = parseAttestation('azure-cvm', { token: jwt });
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'azure');
  assert.equal(r.measurement, `mrtd:sha384:${'ff'.repeat(48)}`);
  assert.equal(r.claims.technology, 'sevsnpvm');
});

// ---------- docker ----------

test('docker: accepts sha256 string', () => {
  const r = parseAttestation('docker', 'sha256:' + 'a'.repeat(64));
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'docker');
  assert.equal(r.measurement, 'sha256:' + 'a'.repeat(64));
});

test('docker: rejects missing measurement', () => {
  const r = parseAttestation('docker', {});
  assert.equal(r.ok, false);
});

// ---------- verifyAttestation ----------

test('verifyAttestation: measurement match → valid', () => {
  const stored = 'sha256:' + 'b'.repeat(64);
  const v = verifyAttestation('docker', stored, { measurement: stored });
  assert.equal(v.valid, true);
  assert.deepEqual(v.reasons, []);
});

test('verifyAttestation: measurement mismatch → invalid', () => {
  const v = verifyAttestation('docker', 'sha256:' + 'b'.repeat(64), {
    measurement: 'sha256:' + 'c'.repeat(64),
  });
  assert.equal(v.valid, false);
  assert.match(v.reasons[0], /measurement mismatch/);
});

test('extractMeasurement: returns the measurement on success', () => {
  const m = extractMeasurement('docker', 'sha256:' + 'd'.repeat(64));
  assert.equal(m, 'sha256:' + 'd'.repeat(64));
});

test('extractMeasurement: returns null on bad payload', () => {
  assert.equal(extractMeasurement('docker', {}), null);
});
