// W679 - direct contract/security test for packages/sdk-rn/index.ts.
//
// The React Native bridge accepts app-provided artifact sources and options.
// It must reject unsafe URI/config/token shapes before handing paths to native
// Swift/Kotlin loaders, and its checked-in dist entrypoint must stay in sync.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = 'packages/sdk-rn/index.ts';
const DIST = 'packages/sdk-rn/dist/index.js';
const README = 'packages/sdk-rn/README.md';
const PKG = 'packages/sdk-rn/package.json';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  });
}

function runNpm(args) {
  if (process.platform === 'win32') {
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args]);
  }
  return run('npm', args);
}

test('W679 RN bridge validates config, URI, download, and token boundaries', () => {
  const src = read(SOURCE);

  assert.match(src, /VALID_VERIFY = new Set<Verify>\(\["off", "on", "strict"\]\)/);
  assert.match(src, /function normalizeConfig/);
  assert.match(src, /config\.secret must be a non-empty string/);
  assert.match(src, /function normalizePlainLocalPath/);
  assert.match(src, /source must be require\(\.\.\.\), file:\/\/, https:\/\/, or a local filesystem path/);
  assert.match(src, /source object must include a string uri/);
  assert.match(src, /function cacheFileName/);
  assert.match(src, /readTimeout: DOWNLOAD_TIMEOUT_MS/);
  assert.match(src, /connectionTimeout: DOWNLOAD_TIMEOUT_MS/);
  assert.match(src, /download failed with HTTP/);
  assert.match(src, /function normalizeMaxTokens/);
  assert.match(src, /MAX_TOKENS = 32768/);
  assert.match(src, /predict text must be a string/);
});

test('W679 RN checked-in dist mirrors the hardened bridge controls', () => {
  const dist = read(DIST);

  for (const token of [
    'function normalizeConfig',
    'function normalizePlainLocalPath',
    'function cacheFileName',
    'readTimeout: DOWNLOAD_TIMEOUT_MS',
    'connectionTimeout: DOWNLOAD_TIMEOUT_MS',
    'function normalizeMaxTokens',
    'export function setConfig',
    'export default Kolm',
  ]) {
    assert.ok(dist.includes(token), `dist missing ${token}`);
  }
});

test('W679 RN package files stay ASCII clean', () => {
  for (const rel of [SOURCE, DIST, README, PKG]) {
    assert.doesNotMatch(read(rel), /[^\x00-\x7F]/, `${rel} contains non-ASCII text`);
  }
});

test('W679 RN package build and local release checks remain green', () => {
  const build = runNpm(['--prefix', 'packages/sdk-rn', 'run', 'build']);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.match(build.stdout, /sdk-dist: ok target=sdk-rn/);

  const readiness = run(process.execPath, [
    'scripts/package-release-readiness.mjs',
    '--run-local-checks',
    '--target=sdk-rn',
    '--summary',
  ]);
  assert.equal(readiness.status, 0, readiness.stderr || readiness.stdout);
  assert.match(readiness.stdout, /sdk-rn:npm run build: pass/);
  assert.match(readiness.stdout, /sdk-rn:npm pack --dry-run: pass/);
});
