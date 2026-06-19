// W1002: NRAS live proven-compute readiness.
//
// This locks the frontier-critical claim boundary: Kolm can have a complete
// local default-path contract while still refusing to claim default live proven
// compute until operated hardware evidence exists.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertNrasLiveReadiness,
  buildNrasLiveReadinessPlan,
  validateNrasRootCertPin,
} from '../src/nras-live-readiness.js';
import {
  registerNrasVerifier,
} from '../src/nras-verifier.js';
import {
  clearAttestationVerifier,
  listRegisteredVerifiers,
} from '../src/confidential-compute.js';

function sha256hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function tempFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1002-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function completeEnv(rootCert, overrides = {}) {
  return {
    KOLM_NRAS_VERIFIER: '1',
    KOLM_NRAS_ROOT_CERT: rootCert,
    KOLM_NRAS_ROOT_CERT_SHA256: sha256hex(fs.readFileSync(rootCert)),
    KOLM_PROVEN_COMPUTE_RUNTIME_URL: 'https://runtime.kolm.ai/v1',
    KOLM_PROVEN_COMPUTE_RUNTIME_KEY: 'runtime-secret',
    KOLM_PROVEN_COMPUTE_REQUIRE: '1',
    KOLM_PROVEN_COMPUTE_ARTIFACT_HASH: sha256hex('artifact'),
    KOLM_NRAS_COLLECTOR: 'nvtrust',
    ...overrides,
  };
}

test('W1002 missing default NRAS config is not locally ready and cannot be claimable', () => {
  const plan = buildNrasLiveReadinessPlan({ env: {} });
  assert.equal(plan.local_contract_ready, false);
  assert.equal(plan.default_live_claimable, false);
  assert.equal(plan.status, 'local_contract_incomplete');
  assert.ok(plan.blockers.some((b) => b.id === 'nras_verifier_env_enabled'));
  assert.ok(plan.blockers.some((b) => b.id === 'pinned_root_cert_sha256_matches'));
});

test('W1002 complete local contract stays external-gated without hardware evidence', () => {
  const rootCert = tempFile('nvidia-root.pem', 'test NVIDIA root pem');
  const plan = buildNrasLiveReadinessPlan({ env: completeEnv(rootCert) });

  assert.equal(plan.local_contract_ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.ok, true);
  assert.equal(plan.default_live_claimable, false);
  assert.equal(plan.status, 'local_contract_ready_external_live_evidence_required');
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.external_evidence_required.map((b) => b.id), [
    'operated_confidential_gpu_capacity_evidenced',
  ]);
  assert.equal(plan.root_cert.pinned, true);
  assert.equal(plan.runtime.require_proven_compute, true);
  assert.equal(plan.runtime.artifact_identity.artifact_hash, sha256hex('artifact'));
});

test('W1002 claimable default live path requires operated hardware token and receipt evidence', () => {
  const rootCert = tempFile('nvidia-root.pem', 'test NVIDIA root pem');
  const tokenFixture = tempFile('nras-token.json', '{"token":"recorded"}');
  const receiptFixture = tempFile('proven-compute-receipt.json', '{"ok":true}');
  const plan = buildNrasLiveReadinessPlan({
    env: completeEnv(rootCert, {
      KOLM_PROVEN_COMPUTE_OPERATED_CAPACITY: '1',
      KOLM_NRAS_HARDWARE_TOKEN_FIXTURE: tokenFixture,
      KOLM_PROVEN_COMPUTE_RECEIPT_FIXTURE: receiptFixture,
    }),
  });

  assert.equal(plan.local_contract_ready, true);
  assert.equal(plan.default_live_claimable, true);
  assert.equal(plan.status, 'claimable_default_live_proven_compute');
  assert.deepEqual(plan.external_evidence_required, []);
});

test('W1002 requireClaimable throws instead of upgrading local readiness into a live claim', () => {
  const rootCert = tempFile('nvidia-root.pem', 'test NVIDIA root pem');
  assert.throws(
    () => assertNrasLiveReadiness({ env: completeEnv(rootCert) }, { requireClaimable: true }),
    /operated_confidential_gpu_capacity_evidenced/,
  );
});

test('W1002 root-cert SHA pin catches drift in plan and verifier registration', () => {
  const rootCert = tempFile('nvidia-root.pem', 'test NVIDIA root pem');
  const good = sha256hex(fs.readFileSync(rootCert));
  const bad = sha256hex('different root');

  const pin = validateNrasRootCertPin({ rootCert, expectedSha256: good });
  assert.equal(pin.ok, true);
  assert.equal(pin.pinned, true);

  const drift = buildNrasLiveReadinessPlan({
    env: completeEnv(rootCert, { KOLM_NRAS_ROOT_CERT_SHA256: bad }),
  });
  assert.equal(drift.local_contract_ready, false);
  assert.ok(drift.blockers.some((b) => b.id === 'pinned_root_cert_present') === false);
  assert.ok(drift.blockers.some((b) => b.id === 'pinned_root_cert_sha256_matches'));
  assert.equal(drift.root_cert.reason, 'root_cert_sha256_mismatch');

  assert.throws(
    () => registerNrasVerifier({ gate: '1', rootCert, rootCertSha256: bad }),
    /KOLM_NRAS_ROOT_CERT_SHA256 mismatch/,
  );

  try {
    const registered = registerNrasVerifier({ gate: '1', rootCert, rootCertSha256: good });
    assert.equal(registered.registered, true);
    assert.equal(registered.root_cert_sha256_pinned, true);
    assert.ok(listRegisteredVerifiers().includes('nras'));
  } finally {
    clearAttestationVerifier('nras');
  }
});
