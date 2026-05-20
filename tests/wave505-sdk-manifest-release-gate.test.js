// Wave 505 - SDK manifest assets must be release-visible and gated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const RELEASE_VERIFY = read('scripts/release-verify.cjs');

test('W505 #1 - repository ignore policy does not hide content-addressed browser SDK assets', () => {
  const ignore = read('.gitignore');
  const ignoredSdkPattern = ignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => line === 'public/sdk-[0-9a-f]*.js');

  assert.deepEqual(ignoredSdkPattern, [], 'public/sdk-[hash].js assets must be visible to git');
});

test('W505 #2 - SDK manifests point at files that exist in public', () => {
  const current = JSON.parse(read('public/sdk-current.json'));
  const versions = JSON.parse(read('public/sdk-versions.json'));
  const entries = [current, versions.current, ...(versions.versions || [])];

  for (const entry of entries) {
    assert.match(entry.url, /^\/sdk-[a-f0-9]{12}\.js$/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', path.basename(entry.url))), `${entry.url} must exist`);
  }
});

test('W505 #3 - release-verify defines an SDK manifest gate with semantic checks', () => {
  assert.match(RELEASE_VERIFY, /async function gateSdkManifest\(\)/);
  assert.match(RELEASE_VERIFY, /shouldRun\(\s*['"]sdk-manifest['"]\s*\)/);

  const fnStart = RELEASE_VERIFY.indexOf('async function gateSdkManifest');
  assert.ok(fnStart > 0);
  const fnSlice = RELEASE_VERIFY.slice(fnStart, fnStart + 4500);
  assert.match(fnSlice, /sdk-current\.json/);
  assert.match(fnSlice, /sdk-versions\.json/);
  assert.match(fnSlice, /verifySdkEntry/);
  assert.match(fnSlice, /sdk-current is not sdk-versions\[0\]/);
});

test('W505 #4 - release-verify runs sdk-manifest before the full test and SDK smoke gates', () => {
  const idxOpenapi = RELEASE_VERIFY.indexOf('await gateOpenapiSync()');
  const idxSdkManifest = RELEASE_VERIFY.indexOf('await gateSdkManifest()');
  const idxTests = RELEASE_VERIFY.indexOf('await gateTests()');
  const idxSdkSmoke = RELEASE_VERIFY.indexOf('await gateSdkSmoke()');

  assert.ok(idxOpenapi > 0, 'openapi-sync gate must be present');
  assert.ok(idxSdkManifest > idxOpenapi, 'sdk-manifest must run after openapi-sync');
  assert.ok(idxTests > idxSdkManifest, 'full tests must run after sdk-manifest');
  assert.ok(idxSdkSmoke > idxTests, 'SDK smoke must run after full tests');
});

test('W505 #5 - release-verify top-level gate list documents sdk-manifest', () => {
  const head = RELEASE_VERIFY.slice(0, 1700);
  assert.match(head, /sdk-manifest/);
  assert.match(head, /current \+ versioned browser SDK assets/);
});
