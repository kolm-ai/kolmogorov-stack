// W929 - distribution manifest frontier contracts.
// Directly covers:
// - packages/vscode-kolm-rag/package.json
// - packages/winget/kolm.kolm.installer.yaml
// - packages/winget/kolm.kolm.locale.en-US.yaml
// - packages/winget/kolm.kolm.yaml

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  auditPackageReleaseReadiness,
  PACKAGE_RELEASE_TARGETS,
} from '../src/package-release-readiness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROOT_PACKAGE_REL = 'package.json';
const VSCODE_PACKAGE_REL = 'packages/vscode-kolm-rag/package.json';
const VSCODE_README_REL = 'packages/vscode-kolm-rag/README.md';
const WINGET_VERSION_REL = 'packages/winget/kolm.kolm.yaml';
const WINGET_INSTALLER_REL = 'packages/winget/kolm.kolm.installer.yaml';
const WINGET_LOCALE_REL = 'packages/winget/kolm.kolm.locale.en-US.yaml';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function yamlScalar(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function yamlList(text, key) {
  const start = text.match(new RegExp(`^${key}:\\s*$`, 'm'));
  assert.ok(start, `missing ${key}`);
  const after = text.slice(start.index + start[0].length);
  const lines = after.split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    if (/^[A-Za-z][A-Za-z0-9]*:/.test(line)) break;
    const item = line.match(/^\s*-\s*(.+)\s*$/);
    if (item) items.push(item[1].trim());
  }
  return items;
}

test('W929 #1 - VS Code RAG manifest is marketplace-honest and workspace-bounded', () => {
  const rootVersion = readJson(ROOT_PACKAGE_REL).version;
  const pkg = readJson(VSCODE_PACKAGE_REL);
  assert.equal(pkg.name, 'vscode-kolm-rag');
  assert.equal(pkg.version, rootVersion);
  assert.equal(pkg.publisher, 'kolm');
  assert.equal(pkg.preview, true);
  assert.equal(pkg.qna, false);
  assert.equal(pkg.repository.url, 'git+https://github.com/kolm-ai/kolm.git');
  assert.equal(pkg.repository.directory, 'packages/vscode-kolm-rag');
  assert.equal(pkg.bugs.url, 'https://github.com/kolm-ai/kolm/issues');
  assert.ok(pkg.engines.vscode);
  assert.equal(pkg.main, './dist/extension.js');
  assert.deepEqual(pkg.extensionKind, ['workspace']);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(pkg.capabilities.virtualWorkspaces.supported, false);
  assert.match(pkg.capabilities.untrustedWorkspaces.description, /trusted workspace/i);
  assert.match(pkg.capabilities.virtualWorkspaces.description, /local workspace/i);

  const commands = pkg.contributes.commands.map((command) => command.title);
  assert.ok(commands.includes('Kolm RAG: Open Distill Dialog'));
  assert.ok(commands.includes('Kolm RAG: View Detected Clusters'));
  assert.ok(commands.includes('Kolm RAG: Toggle Local Routing'));

  const props = pkg.contributes.configuration.properties;
  assert.equal(props['kolm.routing.jaccardThreshold'].minimum, 0);
  assert.equal(props['kolm.routing.jaccardThreshold'].maximum, 1);
  assert.equal(props['kolm.passiveMonitor.enabled'].default, true);
  assert.equal(props['kolm.passiveMonitor.minBlockChars'].default, 80);

  const publicText = [
    pkg.displayName,
    pkg.description,
    ...commands,
    pkg.contributes.configuration.title,
    ...Object.values(props).flatMap((property) => [
      property.description,
      property.markdownDescription,
    ]),
  ].filter(Boolean).join('\n');
  assert.doesNotMatch(publicText, /\bW\d{3}(?:-\d+)?\b/);
  assert.doesNotMatch(collectStrings(pkg).join('\n'), /sneaky-hippo/i);
});

test('W929 #2 - VS Code RAG release docs state preview, trust, and no private-provider claim', () => {
  const body = read(VSCODE_README_REL);
  assert.match(body, /Preview extension/i);
  assert.match(body, /trusted VS Code workspaces/i);
  assert.match(body, /does not claim access to private provider accept events/i);
  assert.match(body, /Public Marketplace publication remains blocked/i);
  assert.doesNotMatch(body, /\bW\d{3}(?:-\d+)?\b/);
});

test('W929 #3 - WinGet manifests are version-aligned and honest about unpublished hashes', () => {
  const rootVersion = readJson(ROOT_PACKAGE_REL).version;
  const version = read(WINGET_VERSION_REL);
  const installer = read(WINGET_INSTALLER_REL);
  const locale = read(WINGET_LOCALE_REL);
  for (const [name, body] of [
    ['version', version],
    ['installer', installer],
    ['locale', locale],
  ]) {
    assert.equal(yamlScalar(body, 'PackageIdentifier'), 'kolm.kolm', name);
    assert.equal(yamlScalar(body, 'PackageVersion'), rootVersion, name);
    assert.equal(yamlScalar(body, 'ManifestVersion'), '1.5.0', name);
  }
  assert.equal(yamlScalar(version, 'ManifestType'), 'version');
  assert.equal(yamlScalar(installer, 'ManifestType'), 'installer');
  assert.equal(yamlScalar(locale, 'ManifestType'), 'defaultLocale');
  assert.doesNotMatch(installer, /Submitted to winget-pkgs/i);
  assert.match(installer, new RegExp(`/v${rootVersion}/kolm-${rootVersion}-win-x64\\.zip`));
  assert.match(installer, new RegExp(`/v${rootVersion}/kolm-${rootVersion}-win-arm64\\.zip`));
  assert.equal((installer.match(/InstallerSha256:\s*0{64}/g) || []).length, 2);
  assert.equal((installer.match(/Placeholder until signed GitHub release artifacts are attached/g) || []).length, 2);
});

test('W929 #4 - WinGet locale avoids regulated certification tags and keeps release metadata', () => {
  const rootVersion = readJson(ROOT_PACKAGE_REL).version;
  const locale = read(WINGET_LOCALE_REL);
  const tags = yamlList(locale, 'Tags');
  assert.equal(yamlScalar(locale, 'ReleaseNotesUrl'), `https://github.com/kolm-ai/kolm/releases/tag/v${rootVersion}`);
  assert.ok(tags.includes('compliance'));
  assert.ok(tags.includes('audit'));
  assert.ok(tags.includes('receipts'));
  assert.ok(tags.includes('air-gap'));
  assert.ok(!tags.includes('hipaa'));
  assert.ok(!tags.includes('sr-11-7'));
});

test('W929 #5 - package-release audit covers VS Code and preserves WinGet blockers', () => {
  const target = PACKAGE_RELEASE_TARGETS.find((item) => item.id === 'vscode-kolm-rag');
  assert.ok(target, 'vscode-kolm-rag must be a package-release target');
  assert.equal(target.channel, 'vscode-marketplace');
  assert.equal(target.root, 'packages/vscode-kolm-rag');
  assert.ok(target.manifests.includes('package.json'));
  assert.ok(target.docs.includes('README.md'));
  assert.ok(target.checks.includes('npm pack --dry-run'));

  const audit = auditPackageReleaseReadiness({ root: ROOT });
  assert.equal(audit.ok, true, audit.failures.join('\n'));
  const byId = new Map(audit.targets.map((item) => [item.id, item]));
  assert.equal(byId.get('vscode-kolm-rag').structural_ok, true);
  assert.equal(byId.get('vscode-kolm-rag').publish_ready, false);
  assert.equal(byId.get('vscode-kolm-rag').metadata.preview, true);
  assert.equal(byId.get('vscode-kolm-rag').metadata.trusted_workspace_required, true);
  assert.deepEqual(byId.get('vscode-kolm-rag').failures, []);
  assert.deepEqual(byId.get('winget').failures, []);
  assert.ok(audit.publish_blockers.includes('winget:winget_installer_sha256_placeholder'));
});

test('W929 #6 - depth verification runs distribution manifest checks before SOTA audit', () => {
  const pkg = readJson(ROOT_PACKAGE_REL);
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && node scripts\/audit-sota-readiness\.cjs/
  );
});
