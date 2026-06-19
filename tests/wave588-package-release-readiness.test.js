// @public-routes-only
// Wave 588 - package release readiness.
// Locks the package-gated closeout items so SDK/runtime/install channels are
// locally auditable without falsely claiming public registry publication.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import {
  auditPackageReleaseReadiness,
  PACKAGE_REQUIREMENT_IDS,
  PACKAGE_RELEASE_MANIFEST_SPEC,
  PACKAGE_RELEASE_TARGETS,
  packageReleaseManifestTemplate,
  validatePackageReleaseArtifacts,
  validatePackageReleaseManifest,
} from '../src/package-release-readiness.js';
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

function completeReleaseManifest() {
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
  return manifest;
}

function attachReleaseArtifacts(root, manifest) {
  manifest.targets = manifest.targets.map((target) => {
    const artifact = Buffer.from(`${target.id}:artifact\n`);
    const sbom = Buffer.from(`${target.id}:sbom\n`);
    const provenance = Buffer.from(`${target.id}:provenance\n`);
    const signature = Buffer.from(`${target.id}:signature\n`);
    writeFile(root, target.artifact_path, artifact);
    writeFile(root, target.sbom_path, sbom);
    writeFile(root, target.provenance_path, provenance);
    writeFile(root, target.signature_bundle_path, signature);
    return {
      ...target,
      artifact_sha256: `sha256:${sha256(artifact)}`,
      sbom_sha256: `sha256:${sha256(sbom)}`,
      provenance_sha256: `sha256:${sha256(provenance)}`,
      signature_bundle_sha256: `sha256:${sha256(signature)}`,
    };
  });
  return manifest;
}

function seedPackageAuditRoot(root) {
  writeFile(root, 'package.json', JSON.stringify({ version: '0.2.6' }));
  for (const target of PACKAGE_RELEASE_TARGETS) {
    for (const file of [...(target.manifests || []), ...(target.docs || [])]) {
      writeFile(root, path.join(target.root, file), 'fixture');
    }
  }
  for (const target of PACKAGE_RELEASE_TARGETS.filter((item) => item.channel === 'npm')) {
    if (target.channel === 'vscode-marketplace') continue;
    writeFile(root, path.join(target.root, 'package.json'), JSON.stringify({
      name: `@kolm/${target.id}`,
      version: '0.2.6',
      license: 'Apache-2.0',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      repository: { type: 'git', url: 'https://github.com/kolm-ai/kolm.git', directory: target.root },
      files: ['dist'],
      scripts: { build: 'node ../../scripts/verify-sdk-dist.mjs', test: 'node --test' },
    }));
    writeFile(root, path.join(target.root, 'dist/index.js'), 'export default {};\n');
    writeFile(root, path.join(target.root, 'dist/index.d.ts'), 'export {};\n');
  }
  writeFile(root, 'packages/sdk-rn/kolm-rn.podspec', 's.version = "0.2.6"\n');
  for (const target of PACKAGE_RELEASE_TARGETS.filter((item) => item.channel === 'pypi')) {
    writeFile(root, path.join(target.root, 'pyproject.toml'), `[build-system]\nbuild-backend = "setuptools.build_meta"\n[project]\nname = "${target.id}"\nversion = "0.2.6"\nlicense = { text = "Apache-2.0" }\nreadme = "README.md"\n`);
  }
  writeFile(root, 'packages/runtime-rs/Cargo.toml', '[package]\nname = "kolm-runtime"\nversion = "0.2.6"\nlicense = "Apache-2.0"\n[lib]\ncrate-type = ["cdylib", "rlib"]\n[features]\nwasm = []\n');
  writeFile(root, 'packages/sdk-swift/Package.swift', 'import PackageDescription\nlet package = Package(name: "Kolm", platforms: [.iOS(.v13)], products: [.library(name: "Kolm", targets: ["Kolm"])], targets: [.target(name: "Kolm")])\n');
  writeFile(root, 'packages/sdk-kotlin/build.gradle.kts', 'plugins { id("com.android.library"); id("org.jetbrains.kotlin.android"); id("maven-publish") }\ngroup = "ai.kolm"\nversion = "0.2.6"\n');
  writeFile(root, 'packages/homebrew/kolm.rb', 'class Kolm < Formula\nhomepage "https://kolm.ai"\nurl "https://github.com/kolm-ai/kolm/archive/refs/tags/v0.2.6.tar.gz"\nsha256 "' + 'a'.repeat(64) + '"\nlicense "Apache-2.0"\ndepends_on "node@20"\ndef install\nFormula["node@20"].opt_bin\nbin.write "kolm", "set -euo pipefail\\nexport KOLM_INSTALL_CHANNEL=homebrew\\n"\nend\ntest do\nshell_output("#{bin}/kolm --version")\nshell_output("#{bin}/kolm --help")\nend\nend\n');
  writeFile(root, 'packages/apt/kolm.control', 'Package: kolm\nVersion: 0.2.6\nDepends: nodejs\nMaintainer: Kolm <dev@kolm.ai>\nHomepage: https://kolm.ai\nDescription: Kolm CLI\n');
  writeFile(root, 'packages/winget/kolm.kolm.yaml', 'PackageIdentifier: kolm.kolm\nPackageVersion: 0.2.6\nManifestVersion: 1.6.0\n');
  writeFile(root, 'packages/winget/kolm.kolm.installer.yaml', 'PackageIdentifier: kolm.kolm\nPackageVersion: 0.2.6\nManifestVersion: 1.6.0\nInstallers:\n- Architecture: x64\n  InstallerUrl: https://github.com/kolm-ai/kolm/releases/download/v0.2.6/kolm-0.2.6-win-x64.zip\n  InstallerSha256: ' + 'a'.repeat(64) + '\n- Architecture: arm64\n  InstallerUrl: https://github.com/kolm-ai/kolm/releases/download/v0.2.6/kolm-0.2.6-win-arm64.zip\n  InstallerSha256: ' + 'b'.repeat(64) + '\n');
  writeFile(root, 'packages/winget/kolm.kolm.locale.en-US.yaml', 'PackageIdentifier: kolm.kolm\nPackageVersion: 0.2.6\nManifestVersion: 1.6.0\nReleaseNotesUrl: https://github.com/kolm-ai/kolm/releases/tag/v0.2.6\nTags:\n- ai\n');
  writeFile(root, 'scripts/install.sh', 'set -eu\nKOLM_REPO_URL=${KOLM_REPO_URL:-https://github.com/kolm-ai/kolm.git}\n"$HOME/.kolm/bin/kolm" doctor\n');
  writeFile(root, 'scripts/install.ps1', "[CmdletBinding(SupportsShouldProcess)]\nparam()\n$ErrorActionPreference = 'Stop'\n$KOLM_REPO_URL = $env:KOLM_REPO_URL\nkolm doctor --quick\n");
  writeFile(root, 'packages/browser-extension/manifest.json', JSON.stringify({ manifest_version: 3, name: 'Kolm', version: '0.2.6' }));
  writeFile(root, 'packages/vscode-kolm-rag/package.json', JSON.stringify({
    name: 'kolm-rag',
    displayName: 'Kolm RAG',
    description: 'Kolm workspace helper',
    version: '0.2.6',
    publisher: 'kolm',
    license: 'Apache-2.0',
    main: './dist/extension.js',
    preview: true,
    qna: false,
    repository: { type: 'git', url: 'https://github.com/kolm-ai/kolm.git', directory: 'packages/vscode-kolm-rag' },
    engines: { vscode: '^1.90.0' },
    extensionKind: ['workspace'],
    capabilities: { untrustedWorkspaces: { supported: false }, virtualWorkspaces: { supported: false } },
    activationEvents: ['onStartupFinished'],
    contributes: {
      commands: [
        { command: 'kolm.capture', title: 'Kolm Capture' },
        { command: 'kolm.search', title: 'Kolm Search' },
        { command: 'kolm.refresh', title: 'Kolm Refresh' },
      ],
      configuration: {
        title: 'Kolm',
        properties: {
          'kolm.cluster.threshold': { description: 'Threshold' },
          'kolm.teacher.preference': { description: 'Teacher' },
          'kolm.namespace': { description: 'Namespace' },
          'kolm.routing.enabled': { description: 'Routing' },
          'kolm.routing.jaccardThreshold': { description: 'Jaccard' },
          'kolm.passiveMonitor.enabled': { description: 'Monitor' },
          'kolm.passiveMonitor.minBlockChars': { description: 'Chars' },
        },
      },
    },
  }));
  writeFile(root, 'packages/vscode-kolm-rag/dist/extension.js', 'module.exports = {};\n');
}

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
  const manifest = completeReleaseManifest();
  const validation = validatePackageReleaseManifest(manifest);
  assert.equal(validation.ok, true, validation.failures.join('\n'));
  assert.equal(validation.counts.complete_targets, PACKAGE_RELEASE_TARGETS.length);
});

test('W588 #2d - package release audit requires retained artifacts before publish readiness', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-package-release-'));
  seedPackageAuditRoot(root);
  const manifest = completeReleaseManifest();
  writeFile(root, 'reports/package-release-manifest.json', JSON.stringify(manifest, null, 2));

  const pending = auditPackageReleaseReadiness({ root });
  assert.equal(pending.ok, true, pending.failures.join('\n'));
  assert.equal(pending.release_manifest.validation.ok, true, pending.release_manifest.validation.failures.join('\n'));
  assert.equal(pending.release_manifest.artifacts.ok, false);
  assert.ok(pending.release_manifest.artifacts.failures.some((failure) => failure.includes(':missing')));
  assert.equal(pending.publish_ready, false);

  attachReleaseArtifacts(root, manifest);
  writeFile(root, 'reports/package-release-manifest.json', JSON.stringify(manifest, null, 2));
  const ready = auditPackageReleaseReadiness({ root });
  assert.equal(ready.ok, true, ready.failures.join('\n'));
  assert.equal(ready.release_manifest.validation.ok, true, ready.release_manifest.validation.failures.join('\n'));
  assert.equal(ready.release_manifest.artifacts.ok, true, ready.release_manifest.artifacts.failures.join('\n'));
  assert.equal(ready.publish_ready, true, ready.publish_blockers.join('\n'));
});

test('W588 #2e - retained release artifact hash validation catches mismatches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-package-release-'));
  const manifest = attachReleaseArtifacts(root, completeReleaseManifest());
  manifest.targets[0].artifact_sha256 = 'sha256:' + 'f'.repeat(64);
  const validation = validatePackageReleaseArtifacts(root, manifest);
  assert.equal(validation.ok, false);
  assert.ok(validation.failures.includes(`${manifest.targets[0].id}:artifact_sha256_mismatch`));
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
  assert.equal(body.readiness.status, 'needs_package_release');
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
  assert.equal(invalidBody.readiness.status, 'needs_package_release');
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

test('W588 #5b - Python package dist verifier checks wheels and sdists without build module', () => {
  const r = spawnSync(process.execPath, [
    'scripts/verify-python-package-dist.mjs',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const body = JSON.parse(r.stdout);
  assert.equal(body.spec, 'kolm-python-package-dist-verifier-1');
  assert.equal(body.ok, true, JSON.stringify(body, null, 2));
  assert.equal(body.secret_values_included, false);
  assert.equal(body.package_count, 3);
  for (const pkg of body.packages) {
    assert.equal(pkg.ok, true, pkg.package_root);
    assert.ok(pkg.wheel.path.endsWith('.whl'), pkg.package_root);
    assert.ok(pkg.sdist.path.endsWith('.tar.gz'), pkg.package_root);
    assert.ok(pkg.wheel.bytes > 0, pkg.package_root);
    assert.ok(pkg.sdist.bytes > 0, pkg.package_root);
    assert.ok(
      pkg.wheel.readable ? pkg.wheel.entries > 0 : /EPERM|EACCES/.test(pkg.wheel.read_error),
      pkg.package_root,
    );
    assert.ok(
      pkg.sdist.readable ? pkg.sdist.entries > 0 : /EPERM|EACCES/.test(pkg.sdist.read_error),
      pkg.package_root,
    );
  }

  const localChecks = spawnSync(process.execPath, [
    'scripts/package-release-readiness.mjs',
    '--run-local-checks',
    '--target=sdk-python',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(localChecks.status, 0, localChecks.stderr || localChecks.stdout);
  const checks = JSON.parse(localChecks.stdout);
  assert.equal(checks.ok, true, JSON.stringify(checks, null, 2));
  assert.ok(checks.checks.some((check) => check.label.includes('verify-python-package-dist') && check.ok && !check.skipped));
});
