// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  auditFormatGovernancePacket,
  FORMAT_GOVERNANCE_REQUIRED_FILES,
  FORMAT_GOVERNANCE_SUBMISSION_SPEC,
  formatGovernanceSubmissionTemplate,
  validateFormatGovernanceSubmission,
} from '../src/format-governance-packet.js';
import {
  auditRuntimeAdoptionPackets,
  RUNTIME_ADOPTION_MANIFEST_SPEC,
  RUNTIME_ADOPTION_TARGETS,
  runtimeAdoptionManifestTemplate,
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

test('W590 #1 - format governance packet is local-ready and external-gated', () => {
  const audit = auditFormatGovernancePacket({ root: ROOT });
  assert.equal(audit.spec, 'kolm-format-governance-packet-1');
  assert.equal(audit.ok, true, audit.blockers.join('\n'));
  assert.equal(audit.local_contract_ok, true);
  assert.equal(audit.external_acceptance_verified, false);
  assert.equal(audit.secret_values_included, false);
  assert.equal(audit.files.length, FORMAT_GOVERNANCE_REQUIRED_FILES.length);
  assert.ok(audit.blockers.includes('neutral_venue_acceptance_missing'));
  assert.equal(audit.counts.blockers, audit.blockers.length);
});

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

test('W590 #3 - governance and runtime packet routes are public, enveloped, and scoped', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const gov = await fetch(base + '/v1/spec/governance-packet');
    assert.equal(gov.status, 200);
    assert.equal(gov.headers.get('x-kolm-readiness'), 'needs_external_partner');
    const govBody = await gov.json();
    assert.equal(govBody.ok, true);
    assert.equal(govBody.data.audit.external_acceptance_verified, false);
    assert.ok(govBody.readiness.requirement_ids.includes('foundation-standardization'));

    const runtime = await fetch(base + '/v1/runtime/adoption-packets');
    assert.equal(runtime.status, 200);
    assert.equal(runtime.headers.get('x-kolm-readiness'), 'needs_external_partner');
    const runtimeBody = await runtime.json();
    assert.equal(runtimeBody.ok, true);
    assert.equal(runtimeBody.data.audit.external_adoption_verified, false);
    assert.ok(runtimeBody.readiness.requirement_ids.includes('ecosystem-runtime-adoption'));
  });
});

test('W590 #4 - scripts and package gate expose governance/runtime packets', () => {
  const gov = spawnSync(process.execPath, ['scripts/format-governance-packet.mjs', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(gov.status, 0, gov.stderr || gov.stdout);
  assert.match(gov.stdout, /external_acceptance_verified=false/);

  const runtime = spawnSync(process.execPath, ['scripts/runtime-adoption-packets.mjs', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
  assert.match(runtime.stdout, /external_adoption_verified=false/);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:governance-packets'], /format-governance-packet\.mjs/);
  assert.match(pkg.scripts['verify:governance-packets'], /runtime-adoption-packets\.mjs/);
  assert.match(pkg.scripts['verify:depth'], /verify:governance-packets/);
});

test('W590 #4b - CLI evidence command exposes governance and runtime packets', () => {
  const gov = spawnSync(process.execPath, ['cli/kolm.js', 'evidence', 'format-governance', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(gov.status, 0, gov.stderr || gov.stdout);
  assert.match(gov.stdout, /external_acceptance_verified=false/);
  assert.doesNotMatch(gov.stdout, /undefined/);

  const runtime = spawnSync(process.execPath, ['cli/kolm.js', 'evidence', 'runtime-adoption', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
  assert.match(runtime.stdout, /external_adoption_verified=false/);
  assert.doesNotMatch(runtime.stdout, /undefined/);
});

test('W590 #4c - CLI evidence aggregate returns every local readiness gate', () => {
  const summary = spawnSync(process.execPath, ['cli/kolm.js', 'evidence', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(summary.status, 0, summary.stderr || summary.stdout);
  assert.match(summary.stdout, /local_contract_ok=true/);
  assert.match(summary.stdout, /external_ready=false/);
  assert.match(summary.stdout, /package-release: needs_package_release/);
  assert.doesNotMatch(summary.stdout, /undefined/);

  const json = spawnSync(process.execPath, ['cli/kolm.js', 'evidence', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(json.status, 0, json.stderr || json.stdout);
  const body = JSON.parse(json.stdout);
  assert.equal(body.spec, 'kolm-evidence-readiness-1');
  assert.equal(body.local_contract_ok, true);
  assert.equal(body.external_ready, false);
  assert.equal(body.secret_values_included, false);
  assert.deepEqual(body.gates.map((gate) => gate.id), [
    'format-governance',
    'runtime-adoption',
    'compliance-certification',
    'package-release',
    'benchmark',
    'quality',
  ]);
});

test('W590 #4d - evidence readiness aggregate is shared by CLI and public API', async () => {
  const aggregate = buildEvidenceReadiness({ root: ROOT, generated_at: '2026-05-23T00:00:00.000Z' });
  assert.equal(aggregate.spec, EVIDENCE_READINESS_SPEC);
  assert.equal(aggregate.local_contract_ok, true);
  assert.equal(aggregate.external_ready, false);
  assert.equal(aggregate.secret_values_included, false);
  assert.equal(aggregate.gates.length, 6);
  assert.ok(aggregate.gates.every((gate) => gate.api_path && gate.proof_command));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/evidence/readiness');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-readiness'), 'partial');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.readiness.spec, EVIDENCE_READINESS_SPEC);
    assert.equal(body.data.readiness.local_contract_ok, true);
    assert.equal(body.data.readiness.external_ready, false);
    assert.deepEqual(body.data.readiness.gates.map((gate) => gate.id), aggregate.gates.map((gate) => gate.id));
    assert.ok(body.readiness.external_requirements.includes('package-release:needs_package_release'));
    assert.ok(body.evidence.source_paths.includes('src/evidence-readiness.js'));
  });
});

function validSha(seed) {
  return seed.padEnd(64, 'b').slice(0, 64);
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
  assert.equal(good.external_acceptance_verified, true);
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
  assert.equal(good.external_adoption_verified, true);
  assert.equal(good.counts.complete_targets, RUNTIME_ADOPTION_TARGETS.length);
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
