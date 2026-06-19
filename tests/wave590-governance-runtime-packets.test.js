// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import {
  auditFormatGovernancePacket,
  FORMAT_GOVERNANCE_REQUIRED_FILES,
  FORMAT_GOVERNANCE_SUBMISSION_SPEC,
  formatGovernanceSubmissionTemplate,
  validateFormatGovernanceArtifacts,
  validateFormatGovernanceSubmission,
} from '../src/format-governance-packet.js';
import {
  auditRuntimeAdoptionPackets,
  RUNTIME_ADOPTION_MANIFEST_SPEC,
  RUNTIME_ADOPTION_REQUIRED_FILES,
  RUNTIME_ADOPTION_TARGETS,
  runtimeAdoptionManifestTemplate,
  validateRuntimeAdoptionArtifacts,
  validateRuntimeAdoptionManifest,
} from '../src/runtime-adoption-packets.js';
import {
  buildEvidenceReadiness,
  EVIDENCE_READINESS_SPEC,
} from '../src/evidence-readiness.js';
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

test('W590 #2 - runtime adoption packets cover hub, local runner, conversion, and hardware paths', () => {
  const audit = auditRuntimeAdoptionPackets({ root: ROOT });
  assert.equal(audit.spec, 'kolm-runtime-adoption-packets-1');
  assert.equal(audit.ok, true, audit.blockers.join('\n'));
  assert.equal(audit.external_adoption_verified, false);
  assert.equal(audit.secret_values_included, false);
  const ids = new Set(RUNTIME_ADOPTION_TARGETS.map((target) => target.id));
  for (const id of ['huggingface-hub', 'ollama', 'llama-cpp', 'onnx-gguf-tooling', 'hardware-partner']) {
    assert.ok(ids.has(id), `missing runtime adoption target ${id}`);
    assert.ok(audit.blockers.includes(`${id}:external_merge_or_package_missing`));
  }
  assert.equal(audit.counts.blockers, audit.blockers.length);
});

function validSha(seed) {
  return seed.padEnd(64, 'b').slice(0, 64);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeFile(root, rel, value) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, value);
}

function completeGovernanceSubmission() {
  return {
    ...formatGovernanceSubmissionTemplate(),
    generated_at: '2026-05-23T00:00:00.000Z',
    venue: 'Neutral AI Artifact Foundation',
    venue_status: 'accepted',
    submitted_at: '2026-05-20T00:00:00.000Z',
    accepted_at: '2026-05-23T00:00:00.000Z',
    submission_url: 'https://example.org/kolm/submission',
    public_change_control_url: 'https://example.org/kolm/governance',
    governance_record_url: 'https://example.org/kolm',
    spec_sha256: validSha('1'),
    conformance_suite_sha256: validSha('2'),
    maintainer_policy_sha256: validSha('3'),
    trademark_policy_sha256: validSha('4'),
    compatibility_policy: 'Semantic versioned .kolm format with verifier behavior pinned by public fixtures.',
    accepted_scope: 'Accepted stewardship covers the portable artifact spec, conformance tests, and change-control rules.',
  };
}

function attachGovernanceArtifacts(root, manifest) {
  for (const [pathField, hashField, label] of [
    ['spec_artifact_path', 'spec_sha256', 'spec'],
    ['conformance_suite_artifact_path', 'conformance_suite_sha256', 'conformance'],
    ['maintainer_policy_artifact_path', 'maintainer_policy_sha256', 'maintainer'],
    ['trademark_policy_artifact_path', 'trademark_policy_sha256', 'trademark'],
  ]) {
    const body = `${label} accepted governance artifact\n`;
    writeFile(root, manifest[pathField], body);
    manifest[hashField] = sha256(body);
  }
  return manifest;
}

function completeRuntimeAdoption() {
  const manifest = runtimeAdoptionManifestTemplate();
  manifest.generated_at = '2026-05-23T00:00:00.000Z';
  manifest.targets = manifest.targets.map((target, idx) => ({
    ...target,
    status: idx % 2 === 0 ? 'merged' : 'published',
    external_url: `https://example.org/${target.id}/integration`,
    integration_ref: `kolm-${target.id}-integration-${idx}`,
    adopted_at: '2026-05-23T00:00:00.000Z',
    evidence_sha256: validSha(String(idx + 5)),
    conformance_report_sha256: validSha(String(idx + 15)),
    supported_artifact_subset: `The ${target.id} integration supports signed recipe, manifest, receipt, and runtime metadata fields.`,
    maintainer_or_owner: 'External Maintainer',
  }));
  return manifest;
}

function attachRuntimeArtifacts(root, manifest) {
  for (const target of manifest.targets) {
    const evidence = JSON.stringify({ target: target.id, kind: 'external-evidence' }, null, 2);
    writeFile(root, target.evidence_artifact_path, `${evidence}\n`);
    target.evidence_sha256 = sha256(`${evidence}\n`);
    const conformance = JSON.stringify({ target: target.id, kind: 'conformance-report' }, null, 2);
    writeFile(root, target.conformance_report_path, `${conformance}\n`);
    target.conformance_report_sha256 = sha256(`${conformance}\n`);
  }
  return manifest;
}

test('W590 #5 - governance submission manifest validates accepted neutral venue evidence', () => {
  const template = formatGovernanceSubmissionTemplate();
  assert.equal(template.spec, FORMAT_GOVERNANCE_SUBMISSION_SPEC);
  const invalid = { ...template, venue_status: 'submitted', spec_sha256: 'ks_676642272a230636eff1fb36f6eabc4e' };
  const bad = validateFormatGovernanceSubmission(invalid);
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.includes('venue_status:must_be_accepted'));
  assert.ok(bad.failures.includes('secret_value_detected'));

  const good = validateFormatGovernanceSubmission(completeGovernanceSubmission());
  assert.equal(good.ok, true, good.failures.join('\n'));
  assert.equal(good.external_acceptance_manifest_valid, true);
  assert.equal(good.external_acceptance_verified, false);
});

test('W590 #6 - runtime adoption manifest validates every external target', () => {
  const template = runtimeAdoptionManifestTemplate();
  assert.equal(template.spec, RUNTIME_ADOPTION_MANIFEST_SPEC);
  assert.equal(template.targets.length, RUNTIME_ADOPTION_TARGETS.length);
  const invalid = { ...template, targets: template.targets.slice(0, 1) };
  invalid.targets[0].evidence_sha256 = 'sk-test-secret-value';
  const bad = validateRuntimeAdoptionManifest(invalid);
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.includes('secret_value_detected'));
  assert.ok(bad.failures.some((failure) => failure.endsWith(':target_missing')));

  const good = validateRuntimeAdoptionManifest(completeRuntimeAdoption());
  assert.equal(good.ok, true, good.failures.join('\n'));
  assert.equal(good.external_adoption_manifest_valid, true);
  assert.equal(good.external_adoption_verified, false);
  assert.equal(good.counts.complete_targets, RUNTIME_ADOPTION_TARGETS.length);
});

test('W590 #6a - governance acceptance requires retained artifacts before promotion', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w590-governance-'));
  for (const rel of FORMAT_GOVERNANCE_REQUIRED_FILES) writeFile(temp, rel, `${rel}\n`);

  const manifestPath = 'reports/format-governance-submission.json';
  writeFile(temp, manifestPath, `${JSON.stringify(completeGovernanceSubmission(), null, 2)}\n`);
  const missingAudit = auditFormatGovernancePacket({ root: temp });
  assert.equal(missingAudit.ok, true, missingAudit.blockers.join('\n'));
  assert.equal(missingAudit.external_acceptance_verified, false);
  assert.ok(missingAudit.blockers.includes('retained_governance_artifacts_missing'));
  assert.ok(missingAudit.external_submission_artifacts.failures.some((failure) => failure.endsWith(':missing')));

  const manifest = attachGovernanceArtifacts(temp, completeGovernanceSubmission());
  writeFile(temp, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const artifactValidation = validateFormatGovernanceArtifacts(temp, manifest);
  assert.equal(artifactValidation.ok, true, artifactValidation.failures.join('\n'));
  const audit = auditFormatGovernancePacket({ root: temp });
  assert.equal(audit.external_acceptance_verified, true, audit.blockers.join('\n'));
});

test('W590 #6b - runtime adoption requires retained per-target artifacts before promotion', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w590-runtime-'));
  for (const rel of RUNTIME_ADOPTION_REQUIRED_FILES) writeFile(temp, rel, `${rel}\n`);

  const manifestPath = 'reports/runtime-adoption-manifest.json';
  writeFile(temp, manifestPath, `${JSON.stringify(completeRuntimeAdoption(), null, 2)}\n`);
  const missingAudit = auditRuntimeAdoptionPackets({ root: temp });
  assert.equal(missingAudit.ok, true, missingAudit.blockers.join('\n'));
  assert.equal(missingAudit.external_adoption_verified, false);
  assert.ok(missingAudit.blockers.includes('retained_runtime_adoption_artifacts_missing'));
  assert.ok(missingAudit.external_adoption_artifacts.failures.some((failure) => failure.endsWith(':missing')));

  const manifest = attachRuntimeArtifacts(temp, completeRuntimeAdoption());
  writeFile(temp, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const artifactValidation = validateRuntimeAdoptionArtifacts(temp, manifest);
  assert.equal(artifactValidation.ok, true, artifactValidation.failures.join('\n'));
  const audit = auditRuntimeAdoptionPackets({ root: temp });
  assert.equal(audit.external_adoption_verified, true, audit.blockers.join('\n'));
});

test('W590 #7 - governance/runtime template and validate routes fail closed', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const govTemplate = await fetch(base + '/v1/spec/governance-packet/template');
    assert.equal(govTemplate.status, 200);
    assert.equal((await govTemplate.json()).data.template.spec, FORMAT_GOVERNANCE_SUBMISSION_SPEC);

    const govBad = await fetch(base + '/v1/spec/governance-packet/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(govBad.status, 422);
    const govGood = await fetch(base + '/v1/spec/governance-packet/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(completeGovernanceSubmission()),
    });
    assert.equal(govGood.status, 200);
    const govGoodBody = await govGood.json();
    assert.equal(govGoodBody.readiness.status, 'needs_external_partner');
    assert.equal(govGoodBody.data.validation.ok, true);
    assert.equal(govGoodBody.data.validation.external_acceptance_verified, false);

    const runtimeTemplate = await fetch(base + '/v1/runtime/adoption-packets/template');
    assert.equal(runtimeTemplate.status, 200);
    assert.equal((await runtimeTemplate.json()).data.template.spec, RUNTIME_ADOPTION_MANIFEST_SPEC);

    const runtimeBad = await fetch(base + '/v1/runtime/adoption-packets/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [] }),
    });
    assert.equal(runtimeBad.status, 422);
    const runtimeGood = await fetch(base + '/v1/runtime/adoption-packets/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(completeRuntimeAdoption()),
    });
    assert.equal(runtimeGood.status, 200);
    const runtimeGoodBody = await runtimeGood.json();
    assert.equal(runtimeGoodBody.readiness.status, 'needs_external_partner');
    assert.equal(runtimeGoodBody.data.validation.ok, true);
    assert.equal(runtimeGoodBody.data.validation.external_adoption_verified, false);
  });
});

test('W590 #8 - scripts emit governance and runtime adoption templates', () => {
  const gov = spawnSync(process.execPath, ['scripts/format-governance-packet.mjs', '--template'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(gov.status, 0, gov.stderr || gov.stdout);
  assert.equal(JSON.parse(gov.stdout).template.spec, FORMAT_GOVERNANCE_SUBMISSION_SPEC);

  const runtime = spawnSync(process.execPath, ['scripts/runtime-adoption-packets.mjs', '--template'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
  assert.equal(JSON.parse(runtime.stdout).template.spec, RUNTIME_ADOPTION_MANIFEST_SPEC);
});
