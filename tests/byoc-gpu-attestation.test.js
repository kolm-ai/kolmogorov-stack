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
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
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

test('BYOC GPU #2b - verifyGpuAttestation accepts compact NRAS EAT/JWT token shape', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const report = {
    ...validNrasReport(),
    attestation_report: 'eyJhbGciOiJSUzI1NiJ9.eyJlYXRfbm9uY2UiOiJhYiJ9.c2lnbmF0dXJl',
  };
  const gpu = await byoc.verifyGpuAttestation(report);
  assert.equal(gpu.shape_ok, true, JSON.stringify(gpu));
  assert.equal(gpu.verified, false);
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

test('BYOC GPU #8 - /v1/byoc/attestation verifies and persists gpu_attestation', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const express = (await import('express')).default;
  const { buildRouter } = await import('../src/router.js');
  const { deployment } = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
  });
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/byoc/attestation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enroll_token: deployment.enroll_token,
        public_url: 'http://1.2.3.4:8080',
        measurement: 'sha256:' + 'c'.repeat(64),
        gpu_attestation: validNrasReport(),
        input_digest: 'a'.repeat(64),
        output_digest: 'b'.repeat(64),
      }),
    });
    assert.equal(r.status, 200, `expected 200; got ${r.status}`);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.gpu, 'route response must include computed gpu state');
    assert.equal(j.gpu.kind, 'nras');
    assert.equal(j.gpu.shape_ok, true);
    assert.equal(j.gpu.verified, false);
  });

  const stored = byoc.getDeployment(deployment.id);
  assert.equal(stored.attestation.gpu.kind, 'nras');
  assert.equal(stored.attestation.gpu.shape_ok, true);
  assert.equal(stored.attestation.gpu.verifier, 'shape_v1');
});

test('BYOC GPU #9 - /v1/byoc/attestation ignores caller-supplied gpu state without a report', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const express = (await import('express')).default;
  const { buildRouter } = await import('../src/router.js');
  const { deployment } = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
  });
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/byoc/attestation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enroll_token: deployment.enroll_token,
        public_url: 'http://1.2.3.4:8080',
        measurement: 'sha256:' + 'd'.repeat(64),
        gpu: { kind: 'nras', shape_ok: true, verified: true, verifier: 'caller-forged' },
      }),
    });
    assert.equal(r.status, 200, `expected 200; got ${r.status}`);
    const j = await r.json();
    assert.equal(j.gpu, null, 'route must not trust caller-supplied gpu state');
  });

  const stored = byoc.getDeployment(deployment.id);
  assert.equal(stored.attestation.gpu, null);
});

test('BYOC GPU #10 - verified /v1/byoc/attestation emits and persists a Proven-Compute Receipt', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const cc = await import('../src/confidential-compute.js');
  const { nonceBinding } = await import('../src/nras-verifier.js');
  const { verifyProvenComputeReceipt } = await import('../src/proven-compute-receipt.js');
  const express = (await import('express')).default;
  const { buildRouter } = await import('../src/router.js');

  const inputDigest = sha256hex('byoc input');
  const outputDigest = sha256hex('byoc output');
  const artifactHash = sha256hex('artifact');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);

  try {
    cc.registerAttestationVerifier('nras', async () => ({
      ok: true,
      verifier: 'nras',
      trust_root: 'pinned-nvidia-root',
      report_hash: sha256hex('report'),
      eat_nonce: expectedNonce,
      expected_nonce: expectedNonce,
      nonce_binding_alg: 'sha256(input_digest||output_digest)',
    }));

    const { deployment } = byoc.createDeployment({
      tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
    });
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use(buildRouter());

    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/byoc/attestation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enroll_token: deployment.enroll_token,
          public_url: 'http://1.2.3.4:8080',
          measurement: 'sha256:' + 'e'.repeat(64),
          gpu_attestation: validNrasReport(),
          artifact_hash: artifactHash,
          input_digest: inputDigest,
          output_digest: outputDigest,
          require_proven_compute: true,
        }),
      });
      assert.equal(r.status, 200, `expected 200; got ${r.status}`);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.gpu.verified, true);
      assert.equal(j.proven_compute_receipt.proof_scope, 'proven_compute');
      const verified = verifyProvenComputeReceipt(j.proven_compute_receipt, { requireProvenCompute: true });
      assert.equal(verified.ok, true, JSON.stringify(verified));
    });

    const stored = byoc.getDeployment(deployment.id);
    assert.equal(stored.attestation.gpu.verified, true);
    assert.equal(stored.attestation.proven_compute_receipt.proof_scope, 'proven_compute');
  } finally {
    cc.clearAttestationVerifier('nras');
  }
});

test('BYOC GPU #11 - require_proven_compute fails closed without artifact identity', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  const cc = await import('../src/confidential-compute.js');
  const { nonceBinding } = await import('../src/nras-verifier.js');
  const express = (await import('express')).default;
  const { buildRouter } = await import('../src/router.js');

  const inputDigest = sha256hex('byoc input missing artifact');
  const outputDigest = sha256hex('byoc output missing artifact');
  const expectedNonce = nonceBinding(inputDigest, outputDigest);

  try {
    cc.registerAttestationVerifier('nras', async () => ({
      ok: true,
      verifier: 'nras',
      eat_nonce: expectedNonce,
      expected_nonce: expectedNonce,
      nonce_binding_alg: 'sha256(input_digest||output_digest)',
    }));
    const { deployment } = byoc.createDeployment({
      tenantId: 't1', tenantName: 'Acme', target: 'docker', artifactId: 'art-1',
    });
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use(buildRouter());

    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/byoc/attestation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enroll_token: deployment.enroll_token,
          public_url: 'http://1.2.3.4:8080',
          measurement: 'sha256:' + 'f'.repeat(64),
          gpu_attestation: validNrasReport(),
          input_digest: inputDigest,
          output_digest: outputDigest,
          require_proven_compute: true,
        }),
      });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.error, 'proven_compute_receipt_unavailable');
      assert.equal(j.reason, 'missing_artifact_hash_or_cid');
    });
  } finally {
    cc.clearAttestationVerifier('nras');
  }
});

test('BYOC GPU #12 - explicit confidential GPU targets generate NRAS collector scripts', async () => {
  freshEnv();
  const byoc = await import('../src/byoc.js');
  assert.ok(byoc.TARGETS.includes('gcp-cvm-gpu'));
  assert.ok(byoc.TARGETS.includes('azure-cvm-gpu'));

  const gcp = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'gcp-cvm-gpu', artifactId: 'art-gpu',
  });
  assert.equal(gcp.manifest.target, 'gcp-cvm-gpu');
  assert.match(gcp.deploy_script, /a3-highgpu-1g/);
  assert.match(gcp.deploy_script, /--confidential-compute-type="\$CONFIDENTIAL_COMPUTE_TYPE"/);
  assert.match(gcp.deploy_script, /nvidia-smi/);
  assert.match(gcp.deploy_script, /nvidia-attestation/);
  assert.match(gcp.deploy_script, /gpu_attestation/);
  assert.match(gcp.deploy_script, /artifact_hash/);
  assert.match(gcp.deploy_script, /KOLM_BYOC_INPUT_DIGEST/);
  assert.match(gcp.deploy_script, /KOLM_REQUIRE_PROVEN_COMPUTE/);

  const azure = byoc.createDeployment({
    tenantId: 't1', tenantName: 'Acme', target: 'azure-cvm-gpu', artifactId: 'art-gpu',
  });
  assert.equal(azure.manifest.target, 'azure-cvm-gpu');
  assert.match(azure.deploy_script, /NCCadsH100v5/);
  assert.match(azure.deploy_script, /AZURE_CONFIDENTIAL_GPU_SIZE/);
  assert.match(azure.deploy_script, /nvidia-smi/);
  assert.match(azure.deploy_script, /KOLM_NRAS_CERT_CHAIN_FILE/);
  assert.match(azure.deploy_script, /gpu_attestation/);
  assert.match(azure.deploy_script, /artifact_hash/);
});
