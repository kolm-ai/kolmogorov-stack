// BYOC enrollment + GPU-TEE (NVIDIA Confidential Compute / NRAS) attestation.
//
// Item 2 (confidential-compute): wire NRAS / GPU-TEE attestation into BYOC.
// recordAttestation stores a GPU state computed by verifyGpuAttestation(),
// which routes the NRAS report through confidential-compute.verifyAttestation.
// Shape-only by default (verified:false honest default); flips verified:true
// only if a tenant registered a real NRAS crypto verifier.
//
// Also locks the surrounding security-sensitive BYOC surface: HMAC manifest
// signature, CPU docker measurement record, and teardown ownership.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh isolated store/data dir per test run.
function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-byoc-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  // A stable receipt secret so signManifest produces a signature.
  process.env.KOLM_RECEIPT_SECRET = 'test-byoc-secret-0123456789abcdef';
  return tmp;
}

// A well-formed NRAS GPU report matching REPORT_SHAPES[KINDS.NRAS]:
// required: gpu_id, driver_version, vbios_version, attestation_report,
//           cert_chain, nonce.
function validNrasReport() {
  return {
    gpu_id: 'GPU-abc123',
    driver_version: '550.90.07',
    vbios_version: '96.00.74.00.01',
    attestation_report: 'aGVsbG8gd29ybGQgYXR0ZXN0YXRpb24=', // base64
    cert_chain: ['-----BEGIN CERTIFICATE-----AAAA-----END CERTIFICATE-----'],
    nonce: 'deadbeefcafebabe',
  };
}

test('BYOC GPU #1 — verifyGpuAttestation: valid NRAS report -> shape_ok, verified:false', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const gpu = await byoc.verifyGpuAttestation(validNrasReport());
  assert.equal(gpu.kind, 'nras');
  assert.equal(gpu.shape_ok, true, `shape_ok must be true for a valid report; got ${JSON.stringify(gpu)}`);
  assert.equal(gpu.verified, false, 'shape-only default must NOT claim crypto verification');
  assert.equal(gpu.verifier, 'shape_v1');
  assert.ok(typeof gpu.report_hash === 'string' && gpu.report_hash.length === 64,
    'report_hash must be a sha256 hex string');
});

test('BYOC GPU #2 — verifyGpuAttestation: malformed report -> shape_ok:false, verified:false', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const gpu = await byoc.verifyGpuAttestation({ gpu_id: 'GPU-x' }); // missing required fields
  assert.equal(gpu.shape_ok, false);
  assert.equal(gpu.verified, false);
});

test('BYOC GPU #3 — recordAttestation persists the GPU state alongside the CPU measurement', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const { deployment } = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
  });
  const gpu = await byoc.verifyGpuAttestation(validNrasReport());
  const res = byoc.recordAttestation(deployment.enroll_token, {
    public_url: 'http://1.2.3.4:8080',
    measurement: 'sha256:' + 'a'.repeat(64),
    gpu,
  });
  assert.equal(res.ok, true);
  assert.ok(res.gpu, 'recordAttestation must return the gpu state');
  assert.equal(res.gpu.kind, 'nras');
  assert.equal(res.gpu.verified, false);

  // Persisted on the deployment row.
  const stored = byoc.getDeployment(deployment.id);
  assert.equal(stored.status, 'live');
  assert.ok(stored.attestation.gpu, 'gpu state must be persisted on the deployment');
  assert.equal(stored.attestation.gpu.shape_ok, true);
  assert.equal(stored.attestation.measurement, 'sha256:' + 'a'.repeat(64));
});

test('BYOC GPU #4 — registered NRAS crypto verifier flips verified:true', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const cc = await import('../src/confidential-compute.js');
  try {
    cc.registerAttestationVerifier('nras', async () => ({ ok: true, verifier: 'test-nras', trust_root: 'pinned-root' }));
    const gpu = await byoc.verifyGpuAttestation(validNrasReport());
    assert.equal(gpu.verified, true, 'a registered crypto verifier returning ok must verify');
    assert.equal(gpu.verifier, 'test-nras');
  } finally {
    cc.clearAttestationVerifier('nras');
  }
});

test('BYOC GPU #5 — recordAttestation without a GPU report leaves gpu:null (CPU-only path unchanged)', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const { deployment } = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
  });
  const res = byoc.recordAttestation(deployment.enroll_token, {
    public_url: 'http://1.2.3.4:8080',
    measurement: 'sha256:' + 'b'.repeat(64),
  });
  assert.equal(res.ok, true);
  assert.equal(res.gpu, null, 'CPU-only attestation must not invent a GPU state');
});

// ---- surrounding BYOC surface lock ----

test('BYOC #6 — createDeployment produces an HMAC-signed manifest', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const { manifest, deploy_script } = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
  });
  assert.ok(typeof manifest.signature === 'string' && manifest.signature.length === 64,
    'manifest signature must be a sha256 HMAC hex string');
  assert.ok(deploy_script.includes('art-1'), 'deploy script must embed the artifact id');
});

test('BYOC #7 — teardownDeployment enforces tenant ownership', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const { deployment } = byoc.createDeployment({
    tenantId: 'owner', tenantName: 'Owner', target: 'docker', artifactId: 'art-1',
  });
  assert.throws(() => byoc.teardownDeployment(deployment.id, 'someone-else'),
    /forbidden/, 'a non-owner must be refused');
  assert.equal(byoc.teardownDeployment(deployment.id, 'owner'), true);
});
