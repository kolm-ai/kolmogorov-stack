// @public-routes-only
// Wave 588 - package release readiness.
// Locks the package-gated closeout items so SDK/runtime/install channels are
// locally auditable without falsely claiming public registry publication.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  auditPackageReleaseReadiness,
  PACKAGE_REQUIREMENT_IDS,
  PACKAGE_RELEASE_MANIFEST_SPEC,
  PACKAGE_RELEASE_TARGETS,
  packageReleaseManifestTemplate,
  validatePackageReleaseManifest,
} from '../src/package-release-readiness.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W588 #1 - package audit covers every package-gated readiness item', () => {
  const audit = auditPackageReleaseReadiness({ root: ROOT });
  assert.equal(audit.spec, 'kolm-package-release-readiness-1');
  assert.equal(audit.secret_values_included, false);
  assert.equal(audit.ok, true, audit.failures.join('\n'));
  assert.equal(audit.publish_ready, false, 'local manifests must not imply registry/channel publication');
  assert.equal(audit.release_version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  for (const id of PACKAGE_REQUIREMENT_IDS) {
    assert.ok(audit.by_requirement[id], `missing requirement ${id}`);
    assert.equal(audit.by_requirement[id].structural_ok, true, id);
    assert.equal(audit.by_requirement[id].status, 'package_channel_pending', id);
    assert.ok(audit.by_requirement[id].target_count > 0, id);
  }
});

test('W588 #1b - package and installer manifests match the root release version', () => {
  const audit = auditPackageReleaseReadiness({ root: ROOT });
  const byId = new Map(audit.targets.map((target) => [target.id, target]));
  for (const id of [
    'sdk-ts',
    'sdk-rn',
    'attestation-npm',
    'langchain-npm',
    'llamaindex-npm',
    'sdk-python',
    'runtime-rs',
    'sdk-kotlin',
    'browser-extension',
  ]) {
    assert.equal(byId.get(id).metadata.version, audit.release_version, id);
    assert.deepEqual(byId.get(id).failures, [], id);
  }
  assert.equal(byId.get('apt').metadata.version, audit.release_version);
  assert.deepEqual(byId.get('homebrew').failures, []);
  assert.deepEqual(byId.get('winget').failures, []);
});

test('W588 #2 - target matrix spans web, mobile, Python, Rust, installers, and extension channels', () => {
  const ids = new Set(PACKAGE_RELEASE_TARGETS.map((target) => target.id));
  for (const id of [
    'sdk-ts',
    'sdk-rn',
    'sdk-python',
    'runtime-rs',
    'sdk-swift',
    'sdk-kotlin',
    'homebrew',
    'apt',
    'winget',
    'install-scripts',
    'browser-extension',
  ]) {
    assert.ok(ids.has(id), `missing release target ${id}`);
  }
  const channels = new Set(PACKAGE_RELEASE_TARGETS.map((target) => target.channel));
  for (const channel of ['npm', 'pypi', 'crates', 'swiftpm', 'maven', 'homebrew', 'apt', 'winget', 'direct-download']) {
    assert.ok(channels.has(channel), `missing release channel ${channel}`);
  }
});

test('W588 #2b - package release manifest template and validator are strict and secret-safe', () => {
  const template = packageReleaseManifestTemplate();
  assert.equal(template.spec, PACKAGE_RELEASE_MANIFEST_SPEC);
  assert.equal(template.secret_values_included, false);
  assert.equal(template.targets.length, PACKAGE_RELEASE_TARGETS.length);
  const incomplete = validatePackageReleaseManifest(template);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.failures.some((failure) => failure.includes('local_checks_passed_must_be_true')));

  const withSecret = {
    ...template,
    targets: template.targets.map((target) => ({ ...target })),
  };
  withSecret.targets[0].artifact_sha256 = 'ks_secret_should_not_ship_1234567890';
  const secretValidation = validatePackageReleaseManifest(withSecret);
  assert.equal(secretValidation.ok, false);
  assert.ok(secretValidation.failures.includes('secret_value_detected'));
});

test('W588 #2c - complete package release manifest validates without contacting registries', () => {
  const manifest = packageReleaseManifestTemplate();
  manifest.generated_at = '2026-05-23T00:00:00.000Z';
  manifest.release_version = '0.2.6';
  manifest.targets = manifest.targets.map((target, idx) => {
    const suffix = String(idx).padStart(2, '0') + 'b'.repeat(62);
    return {
      ...target,
      version: '0.2.6',
      published_at: '2026-05-23T00:00:00.000Z',
      registry_url: `https://registry.example.invalid/kolm/${target.id}/0.2.6`,
      artifact_url: `https://downloads.example.invalid/kolm/${target.id}/0.2.6.tgz`,
      artifact_sha256: suffix,
      sbom_sha256: 'c'.repeat(64),
      provenance_sha256: 'd'.repeat(64),
      signature_bundle_sha256: 'e'.repeat(64),
      local_checks_passed: true,
    };
  });
  const validation = validatePackageReleaseManifest(manifest);
  assert.equal(validation.ok, true, validation.failures.join('\n'));
  assert.equal(validation.counts.complete_targets, PACKAGE_RELEASE_TARGETS.length);
});

test('W588 #3 - package audit reports exact local blockers without exposing secrets', () => {
  const old = process.env.KOLM_API_KEY;
  process.env.KOLM_API_KEY = 'ks_secret_should_not_appear';
  let audit;
  try {
    audit = auditPackageReleaseReadiness({ root: ROOT });
  } finally {
    if (old == null) delete process.env.KOLM_API_KEY;
    else process.env.KOLM_API_KEY = old;
  }
  assert.ok(audit.publish_blockers.some((b) => b.includes('signed_release_artifact_or_registry_url_missing')));
  assert.ok(audit.publish_blockers.some((b) => b.includes('winget_installer_sha256_placeholder')));
  assert.ok(audit.publish_blockers.some((b) => b.includes('release_archive_sha256_placeholder')));
  assert.doesNotMatch(JSON.stringify(audit), /ks_secret_should_not_appear/i);
});

test('W588 #4 - API exposes package readiness as an honest envelope', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/v1/packages/release-readiness');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.audit.ok, true);
  assert.equal(body.data.audit.publish_ready, false);
  assert.equal(body.data.secret_values_included, false);
  assert.ok(body.readiness.requirement_ids.includes('sdk-depth'));

  const templateRes = await fetch(base + '/v1/packages/release-readiness/template');
  assert.equal(templateRes.status, 200);
  assert.equal(templateRes.headers.get('x-kolm-readiness'), 'needs_package_release');
  const templateBody = await templateRes.json();
  assert.equal(templateBody.data.template.spec, PACKAGE_RELEASE_MANIFEST_SPEC);

  const invalidRes = await fetch(base + '/v1/packages/release-readiness/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec: PACKAGE_RELEASE_MANIFEST_SPEC, targets: [] }),
  });
  assert.equal(invalidRes.status, 422);
  const invalidBody = await invalidRes.json();
  assert.equal(invalidBody.data.validation.ok, false);
  assert.equal(invalidBody.data.secret_values_included, false);
});

test('W588 #5 - script and package gates expose release readiness', () => {
  const r = spawnSync(process.execPath, [
    'scripts/package-release-readiness.mjs',
    '--summary',
    '--require-local-contract',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok=true publish_ready=false/);
  assert.match(r.stdout, /one-line-install: package_channel_pending/);
  const smoke = spawnSync(process.execPath, [
    'scripts/package-release-readiness.mjs',
    '--smoke-installers',
    '--summary',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  assert.match(smoke.stdout, /powershell-whatif: (pass|skipped)/);
  assert.match(smoke.stdout, /deb-build-plan: pass/);
  const deb = spawnSync(process.execPath, [
    'scripts/build-deb.mjs',
    '--dry-run',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(deb.status, 0, deb.stderr || deb.stdout);
  const debPlan = JSON.parse(deb.stdout);
  assert.equal(debPlan.spec, 'kolm-deb-build-plan-1');
  assert.equal(debPlan.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(debPlan.secret_values_included, false);
  const localChecks = spawnSync(process.execPath, [
    'scripts/package-release-readiness.mjs',
    '--run-local-checks',
    '--target=langchain-npm',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(localChecks.status, 0, localChecks.stderr || localChecks.stdout);
  const localCheckBody = JSON.parse(localChecks.stdout);
  assert.equal(localCheckBody.ok, true);
  assert.equal(localCheckBody.secret_values_included, false);
  assert.equal(localCheckBody.target_count, 1);
  assert.equal(localCheckBody.checks[0].cwd.replace(/\\/g, '/'), 'packages/langchain-kolm');
  assert.match(localCheckBody.checks[0].stdout, /@kolm\/langchain@0\.2\.6|kolm-langchain-0\.2\.6\.tgz/);
  const extension = spawnSync(process.execPath, [
    'scripts/build-browser-extension.mjs',
    '--dry-run',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(extension.status, 0, extension.stderr || extension.stdout);
  const extensionPlan = JSON.parse(extension.stdout);
  assert.equal(extensionPlan.spec, 'kolm-browser-extension-build-1');
  assert.equal(extensionPlan.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(extensionPlan.secret_values_included, false);
  assert.equal(extensionPlan.missing.length, 0);
  for (const target of ['sdk-ts', 'sdk-rn']) {
    const dist = spawnSync(process.execPath, [
      'scripts/verify-sdk-dist.mjs',
      target,
      '--json',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(dist.status, 0, dist.stderr || dist.stdout);
    const distBody = JSON.parse(dist.stdout);
    assert.equal(distBody.ok, true);
    assert.equal(distBody.package_version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    assert.equal(distBody.secret_values_included, false);
  }
  const t = spawnSync(process.execPath, [
    'scripts/package-release-readiness.mjs',
    '--template',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(t.status, 0, t.stderr || t.stdout);
  assert.match(t.stdout, /kolm-package-release-manifest-1/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:package-release'], /package-release-readiness\.mjs/);
  assert.match(pkg.scripts['verify:package-release'], /--smoke-installers/);
  assert.match(pkg.scripts['verify:package-release'], /--run-local-checks/);
  assert.match(pkg.scripts['verify:depth'], /verify:package-release/);
});
