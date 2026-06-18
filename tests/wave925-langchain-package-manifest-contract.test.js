// W925 - direct contract test for packages/langchain-kolm/package.json.
//
// This pins the LangChain npm adapter manifest atom: release metadata,
// package file allowlist, public scoped publish intent, optional peer surface,
// and package-release readiness wiring.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditPackageReleaseReadiness,
  PACKAGE_RELEASE_TARGETS,
} from '../src/package-release-readiness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST_REL = 'packages/langchain-kolm/package.json';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function findNpmCli() {
  const cliNames = process.platform === 'win32'
    ? [
        path.join('node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join('node_modules', 'npm', 'bin', 'npm-cli.cjs'),
      ]
    : [
        path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join('node_modules', 'npm', 'bin', 'npm-cli.js'),
      ];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const cleanDir = dir.replace(/^"|"$/g, '');
    for (const rel of cliNames) {
      const candidate = path.join(cleanDir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findNpmCommand() {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const cleanDir = dir.replace(/^"|"$/g, '');
    for (const name of names) {
      const candidate = path.join(cleanDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(args, cwd) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
    });
  }
  const npmCli = findNpmCli();
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
    });
  }
  return spawnSync(findNpmCommand(), args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('W925 LangChain package manifest is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const target = PACKAGE_RELEASE_TARGETS.find((row) => row.id === 'langchain-npm');

  assert.equal(
    pkg.scripts['verify:langchain-package-manifest'],
    'node --test --test-concurrency=1 tests/wave925-langchain-package-manifest-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && npm run verify:eval-safety-harnesses && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.equal(target.root, 'packages/langchain-kolm');
  assert.deepEqual(target.manifests, ['package.json']);
  assert.deepEqual(target.checks, ['npm pack --dry-run']);
});

test('W925 LangChain package manifest is publish-safe and version-aligned', () => {
  const root = readJson('package.json');
  const manifest = readJson(MANIFEST_REL);

  assert.equal(manifest.name, '@kolm/langchain');
  assert.equal(manifest.version, root.version);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './index.js');
  assert.deepEqual(manifest.exports, { '.': './index.js' });
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(manifest.files, ['index.js', 'example.js', 'README.md']);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.repository.directory, 'packages/langchain-kolm');
  assert.equal(manifest.homepage, 'https://kolm.ai/integrations');
  assert.equal(manifest.bugs.url, 'https://github.com/kolm-ai/kolm/issues');
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
  assert.equal(Object.hasOwn(manifest, 'scripts'), false);
  for (const rel of manifest.files) assert.equal(exists(`packages/langchain-kolm/${rel}`), true, rel);
});

test('W925 LangChain package manifest keeps peer dependencies optional and bounded', () => {
  const manifest = readJson(MANIFEST_REL);
  const peerNames = Object.keys(manifest.peerDependencies).sort();
  const metaNames = Object.keys(manifest.peerDependenciesMeta).sort();

  assert.deepEqual(peerNames, ['@langchain/core', 'langchain'].sort());
  assert.deepEqual(metaNames, peerNames);
  for (const name of peerNames) {
    assert.match(manifest.peerDependencies[name], /^>=\d+\.\d+\.\d+$/);
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
    assert.doesNotMatch(manifest.peerDependencies[name], /file:|git\+|https?:|\*/);
  }
});

test('W925 LangChain package dry-run pack contains only the intended release files', () => {
  const result = runNpm(['pack', '--dry-run', '--json'], path.join(ROOT, 'packages/langchain-kolm'));
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const [packed] = JSON.parse(result.stdout);
  const fileSet = packed.files.map((file) => file.path).sort();

  assert.equal(packed.name, '@kolm/langchain');
  assert.equal(packed.version, readJson('package.json').version);
  assert.deepEqual(fileSet, ['README.md', 'example.js', 'index.js', 'package.json'].sort());
  assert.equal(fileSet.some((file) => file.includes('.tmp') || file.includes('node_modules')), false);
});

test('W925 package release audit retains the LangChain local contract without publish claims', () => {
  const audit = auditPackageReleaseReadiness({ root: ROOT });
  const target = audit.targets.find((row) => row.id === 'langchain-npm');

  assert.equal(audit.ok, true, audit.failures.join('\n'));
  assert.equal(audit.publish_ready, false);
  assert.equal(target.root, 'packages/langchain-kolm');
  assert.equal(target.metadata.package_name, '@kolm/langchain');
  assert.equal(target.metadata.version, readJson('package.json').version);
  assert.deepEqual(target.failures, []);
  assert.equal(target.structural_ok, true);
  assert.deepEqual(target.publish_blockers, ['signed_release_artifact_or_registry_url_missing']);
});
