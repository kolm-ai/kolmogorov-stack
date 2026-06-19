// W974 - core BYOC deployment contract.
//
// The GPU attestation suite covers NRAS and route wiring. This file pins the
// plain BYOC lifecycle that every target depends on: signed manifests,
// attestation fallback/override behavior, and tenant-owned teardown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'w974-byoc-contract-secret-0123456789abcdef';

let byocPromise = null;

function initEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-byoc-core-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.RECIPE_RECEIPT_SECRET = SECRET;
}

async function loadByoc() {
  if (!byocPromise) {
    initEnv();
    byocPromise = import('../src/byoc.js');
  }
  return byocPromise;
}

function hmacManifest(fields) {
  const canonical = JSON.stringify(fields, Object.keys(fields).sort());
  return crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
}

function signedManifestFields(manifest) {
  return {
    deploy_id: manifest.deploy_id,
    artifact_id: manifest.artifact_id,
    target: manifest.target,
    region: manifest.region,
    name: manifest.name,
    enroll_token: manifest.enroll_token,
    issued_at: manifest.issued_at,
  };
}

test('W974 #1 - createDeployment emits a reproducible HMAC-signed manifest', async () => {
  const byoc = await loadByoc();
  const { deployment, manifest, deploy_script } = byoc.createDeployment({
    tenantId: 'tenant-w974-sign',
    tenantName: 'W974 Sign',
    teamId: 'team-w974',
    target: 'docker',
    artifactId: 'artifact-w974',
    region: 'iad',
    name: 'Kolm BYOC W974!',
  });

  assert.equal(deployment.id, manifest.deploy_id);
  assert.equal(manifest.name, 'kolm-byoc-w974-');
  assert.equal(manifest.signature, hmacManifest(signedManifestFields(manifest)));
  assert.notEqual(
    manifest.signature,
    hmacManifest({ ...signedManifestFields(manifest), region: 'tampered' }),
    'manifest signature must change when signed deploy fields change',
  );
  assert.match(deploy_script, /artifact-w974/);
  assert.match(deploy_script, new RegExp(manifest.enroll_token));
});

test('W974 #2 - malformed attestation payload records operator measurement without blocking liveness', async () => {
  const byoc = await loadByoc();
  const { deployment } = byoc.createDeployment({
    tenantId: 'tenant-w974-attest',
    tenantName: 'W974 Attest',
    target: 'docker',
    artifactId: 'artifact-w974-attest',
  });
  const fallbackMeasurement = 'sha256:' + 'b'.repeat(64);

  const recorded = byoc.recordAttestation(deployment.enroll_token, {
    public_url: 'https://byoc.example.test/runtime',
    measurement: fallbackMeasurement,
    attestation: 'not-a-docker-sha',
  });

  assert.equal(recorded.ok, true);
  assert.equal(recorded.vendor, null);
  assert.equal(recorded.measurement, fallbackMeasurement);

  const stored = byoc.getDeployment(deployment.id);
  assert.equal(stored.status, 'live');
  assert.equal(stored.public_url, 'https://byoc.example.test/runtime');
  assert.equal(stored.attestation.measurement, fallbackMeasurement);
  assert.equal(stored.attestation.parsed, null);
  assert.equal(stored.attestation.raw, 'not-a-docker-sha');
});

test('W974 #3 - valid docker attestation overrides a mismatched self-reported measurement', async () => {
  const byoc = await loadByoc();
  const { deployment } = byoc.createDeployment({
    tenantId: 'tenant-w974-docker',
    tenantName: 'W974 Docker',
    target: 'docker',
    artifactId: 'artifact-w974-docker',
  });
  const selfReported = 'sha256:' + 'c'.repeat(64);
  const parsedMeasurement = 'sha256:' + 'd'.repeat(64);

  const recorded = byoc.recordAttestation(deployment.enroll_token, {
    public_url: 'https://docker.example.test/runtime',
    measurement: selfReported,
    attestation: parsedMeasurement,
  });

  assert.equal(recorded.ok, true);
  assert.equal(recorded.vendor, 'docker');
  assert.equal(recorded.measurement, parsedMeasurement);

  const stored = byoc.getDeployment(deployment.id);
  assert.equal(stored.attestation.measurement, parsedMeasurement);
  assert.equal(stored.attestation.parsed.vendor, 'docker');
  assert.equal(stored.attestation.parsed.measurement, parsedMeasurement);
});

test('W974 #4 - teardownDeployment is tenant-owned and removes rows from tenant listings', async () => {
  const byoc = await loadByoc();
  const { deployment } = byoc.createDeployment({
    tenantId: 'tenant-w974-owner',
    tenantName: 'W974 Owner',
    target: 'docker',
    artifactId: 'artifact-w974-owned',
  });

  assert.equal(byoc.listDeploymentsForTenant('tenant-w974-owner').length, 1);
  assert.throws(
    () => byoc.teardownDeployment(deployment.id, 'tenant-w974-intruder'),
    /forbidden/,
  );
  assert.equal(byoc.getDeployment(deployment.id).status, 'issued');

  assert.equal(byoc.teardownDeployment(deployment.id, 'tenant-w974-owner'), true);
  assert.equal(byoc.getDeployment(deployment.id), null);
  assert.equal(byoc.listDeploymentsForTenant('tenant-w974-owner').length, 0);
  assert.equal(byoc.teardownDeployment(deployment.id, 'tenant-w974-owner'), false);
});
