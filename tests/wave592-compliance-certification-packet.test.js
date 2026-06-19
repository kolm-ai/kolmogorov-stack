// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditComplianceCertificationPacket,
  COMPLIANCE_CERTIFICATION_MANIFEST_SPEC,
  COMPLIANCE_CERTIFICATION_CONTROLS,
  COMPLIANCE_REQUIRED_FILES,
  complianceCertificationManifestTemplate,
  validateComplianceCertificationManifest,
} from '../src/compliance-certification-packet.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function writeFile(root, rel, body = 'fixture') {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const out = await fn(base);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

function validSha(seed) {
  return seed.padEnd(64, 'a').slice(0, 64);
}

function completeManifest() {
  const manifest = complianceCertificationManifestTemplate();
  manifest.generated_at = '2026-05-23T00:00:00.000Z';
  manifest.organization = 'Kolm, Inc.';
  manifest.production_proof = {
    base_url: 'https://kolm.ai',
    environment: 'production',
    verified_at: '2026-05-23T00:00:00.000Z',
    health_probe_sha256: validSha('1'),
    ready_probe_sha256: validSha('2'),
    authenticated_probe_sha256: validSha('3'),
    tenant_boundary: 'Single tenant workspace boundary verified by authenticated probe hashes.',
    data_region: 'us',
  };
  manifest.controls = manifest.controls.map((row, idx) => ({
    ...row,
    status: row.id === 'hipaa-baa' || row.id === 'gdpr-dpa' ? 'legally_approved' : 'certified',
    issuer: 'Independent Auditor LLP',
    issued_at: '2026-05-23T00:00:00.000Z',
    expires_at: '2027-05-23T00:00:00.000Z',
    evidence_url: `https://kolm.ai/trust/${row.id}.pdf`,
    evidence_sha256: validSha(String(idx + 4)),
    evidence_register_sha256: validSha(String(idx + 12)),
    signature_sha256: validSha(String(idx + 20)),
    scope_summary: `External evidence for ${row.id} covers the production boundary, exclusions, and control period.`,
    control_period_start: '2025-05-23T00:00:00.000Z',
    control_period_end: '2026-05-23T00:00:00.000Z',
    system_boundary: {
      services: ['kolm-api', 'kolm-runtime', 'kolm-evidence-store'],
      data_classes: ['customer prompts', 'compiled artifacts', 'audit receipts'],
      exclusions: ['customer-managed infrastructure outside the signed scope'],
    },
    chain_of_custody: {
      collected_by: 'Independent Auditor LLP evidence team',
      reviewed_by: 'Independent Auditor LLP partner',
      reviewer_independence: row.id === 'hipaa-baa' || row.id === 'gdpr-dpa' ? 'external_counsel' : 'external_auditor',
      retained_until: '2033-05-23T00:00:00.000Z',
      evidence_register_path: row.evidence_register_path,
      evidence_register_sha256: validSha(String(idx + 12)),
    },
  }));
  return manifest;
}

function writeLocalComplianceEvidence(root) {
  const required = new Set(COMPLIANCE_REQUIRED_FILES);
  for (const control of COMPLIANCE_CERTIFICATION_CONTROLS) {
    for (const rel of control.implemented_evidence) required.add(rel);
  }
  for (const rel of required) writeFile(root, rel, `${rel}\n`);
}

function attachCertificationArtifacts(root, manifest) {
  manifest.controls = manifest.controls.map((row) => {
    const evidence = Buffer.from(`${row.id}:external-evidence\n`);
    const register = Buffer.from(`${row.id}:evidence-register\n`);
    const signature = Buffer.from(`${row.id}:external-signature\n`);
    writeFile(root, row.evidence_artifact_path, evidence);
    writeFile(root, row.evidence_register_path, register);
    writeFile(root, row.signature_artifact_path, signature);
    const registerSha = `sha256:${sha256(register)}`;
    return {
      ...row,
      evidence_sha256: `sha256:${sha256(evidence)}`,
      evidence_register_sha256: registerSha,
      signature_sha256: `sha256:${sha256(signature)}`,
      chain_of_custody: {
        ...row.chain_of_custody,
        evidence_register_sha256: registerSha,
      },
    };
  });
  return manifest;
}

test('W592 #4 - compliance certification manifest template covers every required control', () => {
  const template = complianceCertificationManifestTemplate();
  assert.equal(template.spec, COMPLIANCE_CERTIFICATION_MANIFEST_SPEC);
  assert.equal(template.secret_values_included, false);
  assert.equal(template.controls.length, COMPLIANCE_CERTIFICATION_CONTROLS.length);
  for (const control of COMPLIANCE_CERTIFICATION_CONTROLS) {
    const row = template.controls.find((item) => item.id === control.id);
    assert.ok(row, `${control.id} is in template`);
    assert.deepEqual(row.implemented_evidence, control.implemented_evidence);
    assert.deepEqual(row.framework_control_refs, control.framework_control_refs);
    assert.deepEqual(row.authority_refs.map((item) => item.id), control.authority_refs);
    assert.equal(row.chain_of_custody.evidence_register_path, row.evidence_register_path);
  }
});

test('W592 #5 - manifest validator rejects placeholders, missing controls, and secrets', () => {
  const invalid = complianceCertificationManifestTemplate();
  invalid.controls = invalid.controls.slice(0, 1);
  invalid.controls[0].authority_refs = [];
  invalid.controls[0].framework_control_refs = [];
  invalid.production_proof.authenticated_probe_sha256 = 'ks_676642272a230636eff1fb36f6eabc4e';
  const validation = validateComplianceCertificationManifest(invalid);
  assert.equal(validation.ok, false);
  assert.equal(validation.live_certification_verified, false);
  assert.equal(validation.manifest_ready_for_artifact_validation, false);
  assert.equal(validation.secret_values_included, true);
  assert.equal(validation.placeholder_values_included, true);
  assert.ok(validation.failures.includes('secret_value_detected'));
  assert.ok(validation.failures.includes('placeholder_value_detected'));
  assert.ok(validation.failures.some((failure) => failure.endsWith(':authority_refs_missing')));
  assert.ok(validation.failures.some((failure) => failure.endsWith(':framework_control_refs_missing')));
  assert.ok(validation.failures.some((failure) => failure.endsWith(':control_missing')));
});

test('W592 #6 - complete certification manifest validates without contacting auditors', () => {
  const validation = validateComplianceCertificationManifest(completeManifest());
  assert.equal(validation.ok, true, validation.failures.join('\n'));
  assert.equal(validation.manifest_ready_for_artifact_validation, true);
  assert.equal(validation.live_certification_verified, false);
  assert.equal(validation.secret_values_included, false);
  assert.equal(validation.placeholder_values_included, false);
  assert.equal(validation.counts.complete_controls, COMPLIANCE_CERTIFICATION_CONTROLS.length);
});

test('W592 #6b - audit keeps live certification blocked until retained evidence artifacts exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-compliance-evidence-'));
  writeLocalComplianceEvidence(root);
  writeFile(root, 'reports/compliance-certification-manifest.json', JSON.stringify(completeManifest(), null, 2));

  const audit = auditComplianceCertificationPacket({ root });
  assert.equal(audit.local_contract_ok, true, audit.blockers.join('\n'));
  assert.equal(audit.live_certification_verified, false);
  assert.ok(audit.certification_artifact_validation.failures.some((failure) => failure.includes(':missing')));
});

test('W592 #6c - audit verifies retained evidence and signature hashes before live promotion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-compliance-evidence-'));
  writeLocalComplianceEvidence(root);
  const manifest = attachCertificationArtifacts(root, completeManifest());
  writeFile(root, 'reports/compliance-certification-manifest.json', JSON.stringify(manifest, null, 2));

  const audit = auditComplianceCertificationPacket({ root });
  assert.equal(audit.local_contract_ok, true, audit.blockers.join('\n'));
  assert.equal(audit.certification_manifest_validation.ok, true);
  assert.equal(audit.certification_artifact_validation.ok, true, audit.certification_artifact_validation.failures.join('\n'));
  assert.equal(audit.certification_artifact_validation.artifact_count, COMPLIANCE_CERTIFICATION_CONTROLS.length * 3);
  assert.equal(audit.live_certification_verified, true);
});

test('W592 #7 - API exposes certification template and fails closed on invalid validation', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const templateRes = await fetch(base + '/v1/compliance/certification-packet/template');
    assert.equal(templateRes.status, 200);
    const templateBody = await templateRes.json();
    assert.equal(templateBody.data.template.spec, COMPLIANCE_CERTIFICATION_MANIFEST_SPEC);
    assert.equal(templateBody.readiness.status, 'needs_live_certification');

    const badRes = await fetch(base + '/v1/compliance/certification-packet/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controls: [] }),
    });
    assert.equal(badRes.status, 422);
    const badBody = await badRes.json();
    assert.equal(badBody.data.validation.ok, false);
    assert.equal(badBody.readiness.status, 'needs_live_certification');

    const goodRes = await fetch(base + '/v1/compliance/certification-packet/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(completeManifest()),
    });
    assert.equal(goodRes.status, 200);
    const goodBody = await goodRes.json();
    assert.equal(goodBody.data.validation.manifest_ready_for_artifact_validation, true);
    assert.equal(goodBody.data.validation.live_certification_verified, false);
    assert.equal(goodBody.readiness.status, 'needs_live_certification');
  });
});

test('W592 #8 - CLI emits certification manifest template', () => {
  const r = spawnSync(process.execPath, ['scripts/compliance-certification-packet.mjs', '--template'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const body = JSON.parse(r.stdout);
  assert.equal(body.template.spec, COMPLIANCE_CERTIFICATION_MANIFEST_SPEC);
});

test('W592 #9 - local compliance packet evidence contract is current', () => {
  const audit = auditComplianceCertificationPacket({ root: ROOT });
  assert.equal(audit.local_contract_ok, true, audit.blockers.join('\n'));
  assert.equal(audit.ok, true, audit.blockers.join('\n'));
  assert.equal(audit.live_certification_verified, false);

  const r = spawnSync(process.execPath, ['scripts/compliance-certification-packet.mjs', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok=true live_certification_verified=false/);
});
