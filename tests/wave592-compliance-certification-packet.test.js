// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import express from 'express';
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

test('W592 #1 - compliance packet has local evidence but no live certification claim', () => {
  const audit = auditComplianceCertificationPacket({ root: ROOT });
  assert.equal(audit.spec, 'kolm-compliance-certification-packet-1');
  assert.equal(audit.ok, true, audit.blockers.join('\n'));
  assert.equal(audit.local_contract_ok, true);
  assert.equal(audit.live_certification_verified, false);
  assert.equal(audit.secret_values_included, false);
  assert.equal(audit.files.length, COMPLIANCE_REQUIRED_FILES.length);
  assert.equal(audit.controls.length, COMPLIANCE_CERTIFICATION_CONTROLS.length);
  assert.ok(audit.blockers.some((blocker) => blocker.includes('soc2_auditor_report_missing')));
});

test('W592 #2 - route exposes compliance packet as needs_live_certification', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/compliance/certification-packet');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-readiness'), 'needs_live_certification');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.audit.live_certification_verified, false);
    assert.ok(body.readiness.requirement_ids.includes('compliance-certifications'));
  });
});

test('W592 #3 - script exposes a local contract gate', () => {
  const r = spawnSync(process.execPath, ['scripts/compliance-certification-packet.mjs', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /live_certification_verified=false/);
});

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
    signature_sha256: validSha(String(idx + 20)),
    scope_summary: `External evidence for ${row.id} covers the production boundary, exclusions, and control period.`,
  }));
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
  }
});

test('W592 #5 - manifest validator rejects placeholders, missing controls, and secrets', () => {
  const invalid = complianceCertificationManifestTemplate();
  invalid.controls = invalid.controls.slice(0, 1);
  invalid.production_proof.authenticated_probe_sha256 = 'ks_676642272a230636eff1fb36f6eabc4e';
  const validation = validateComplianceCertificationManifest(invalid);
  assert.equal(validation.ok, false);
  assert.equal(validation.live_certification_verified, false);
  assert.ok(validation.failures.includes('secret_value_detected'));
  assert.ok(validation.failures.some((failure) => failure.endsWith(':control_missing')));
});

test('W592 #6 - complete certification manifest validates without contacting auditors', () => {
  const validation = validateComplianceCertificationManifest(completeManifest());
  assert.equal(validation.ok, true, validation.failures.join('\n'));
  assert.equal(validation.live_certification_verified, true);
  assert.equal(validation.counts.complete_controls, COMPLIANCE_CERTIFICATION_CONTROLS.length);
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
    assert.equal(goodBody.data.validation.live_certification_verified, true);
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

test('W592 #9 - CLI evidence command exposes compliance certification packet', () => {
  const summary = spawnSync(process.execPath, ['cli/kolm.js', 'evidence', 'compliance-certification', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(summary.status, 0, summary.stderr || summary.stdout);
  assert.match(summary.stdout, /live_certification_verified=false/);
  assert.doesNotMatch(summary.stdout, /undefined/);

  const template = spawnSync(process.execPath, ['cli/kolm.js', 'evidence', 'compliance', '--template'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(template.status, 0, template.stderr || template.stdout);
  assert.equal(JSON.parse(template.stdout).template.spec, COMPLIANCE_CERTIFICATION_MANIFEST_SPEC);
});
