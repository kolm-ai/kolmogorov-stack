import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function runKolm(args) {
  return spawnSync(process.execPath, ['cli/kolm.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('W591 #1 - attestation package test script targets real test files and publishes repo metadata', () => {
  const pkg = readJson('packages/attestation/package.json');
  assert.match(pkg.scripts.test, /tests\/\*\.test\.js/);
  assert.equal(pkg.repository.directory, 'packages/attestation');
  assert.ok(exists('packages/attestation/tests/attestation.test.js'));
});

test('W591 #1b - TypeScript/browser SDK has checked-in release entrypoints', () => {
  const pkg = readJson('packages/sdk-ts/package.json');
  assert.equal(pkg.main, './dist/index.js');
  assert.equal(pkg.types, './dist/index.d.ts');
  assert.equal(pkg.scripts.build, 'node ../../scripts/verify-sdk-dist.mjs sdk-ts');
  assert.ok(exists('packages/sdk-ts/dist/index.js'));
  assert.ok(exists('packages/sdk-ts/dist/index.d.ts'));
});

test('W591 #2 - React Native package has TS, iOS, and Android package surfaces', () => {
  const pkg = readJson('packages/sdk-rn/package.json');
  assert.equal(pkg.scripts.build, 'node ../../scripts/verify-sdk-dist.mjs sdk-rn');
  for (const rel of [
    'packages/sdk-rn/tsconfig.json',
    'packages/sdk-rn/types.d.ts',
    'packages/sdk-rn/dist/index.js',
    'packages/sdk-rn/dist/index.d.ts',
    'packages/sdk-rn/react-native.config.js',
    'packages/sdk-rn/kolm-rn.podspec',
    'packages/sdk-rn/ios/KolmRN.swift',
    'packages/sdk-rn/ios/KolmRNBridge.m',
    'packages/sdk-rn/android/build.gradle',
    'packages/sdk-rn/android/src/main/AndroidManifest.xml',
    'packages/sdk-rn/android/src/main/java/ai/kolm/rn/KolmRNModule.kt',
    'packages/sdk-rn/android/src/main/java/ai/kolm/rn/KolmRNPackage.kt',
  ]) {
    assert.ok(exists(rel), `missing ${rel}`);
  }
});

test('W591 #3 - mobile SDK package manifests reference files that exist locally', () => {
  assert.ok(exists('packages/sdk-swift/Tests/KolmTests/KolmTests.swift'));
  assert.ok(exists('packages/sdk-kotlin/src/main/AndroidManifest.xml'));
  assert.ok(exists('packages/sdk-kotlin/consumer-rules.pro'));
});

test('W591 #4 - CLI exposes package release readiness without publishing', () => {
  const summary = runKolm(['packages', 'release-readiness', '--summary', '--require-local-contract']);
  assert.equal(summary.status, 0, summary.stderr || summary.stdout);
  assert.match(summary.stdout, /ok=true/);
  assert.match(summary.stdout, /publish_ready=false/);
  assert.doesNotMatch(summary.stdout, /undefined/);

  const target = runKolm(['package', 'release', 'readiness', '--target=sdk-ts', '--json']);
  assert.equal(target.status, 0, target.stderr || target.stdout);
  const body = JSON.parse(target.stdout);
  assert.equal(body.spec, 'kolm-package-release-readiness-1');
  assert.equal(body.secret_values_included, false);
  assert.equal(body.publish_ready, false);
  assert.deepEqual(body.targets.map((row) => row.id), ['sdk-ts']);

  const template = runKolm(['packages', 'release-readiness', '--template', '--json']);
  assert.equal(template.status, 0, template.stderr || template.stdout);
  const templateBody = JSON.parse(template.stdout);
  assert.equal(templateBody.ok, true);
  assert.equal(templateBody.template.spec, 'kolm-package-release-manifest-1');
  assert.equal(templateBody.template.secret_values_included, false);

  const evidence = runKolm(['evidence', 'package-release', '--summary', '--require-local-contract']);
  assert.equal(evidence.status, 0, evidence.stderr || evidence.stdout);
  assert.match(evidence.stdout, /publish_ready=false/);
});
