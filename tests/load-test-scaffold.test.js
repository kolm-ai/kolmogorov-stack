// tests/load-test-scaffold.test.js
//
// Verifies the load-test SCAFFOLD itself — does NOT execute live load tests.
//
// The scaffold lives at:
//   scripts/load-test.cjs                          (driver)
//   scripts/load-test-scenarios/concurrent-100.js
//   scripts/load-test-scenarios/long-context-128k.js
//   scripts/load-test-scenarios/all-providers-down.js
//
// Six checks:
//   1. driver `--help` exits 0
//   2. driver `--scenario unknown` exits 2
//   3. each of the three scenarios exports a default async function
//   4. dry-run mode for concurrent-100 makes no HTTP calls
//   5. dry-run mode for long-context-128k makes no HTTP calls
//   6. dry-run mode for all-providers-down makes no HTTP calls

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'load-test.cjs');
const SCEN_DIR = path.join(REPO, 'scripts', 'load-test-scenarios');

function runDriver(args) {
  return spawnSync(process.execPath, [DRIVER, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function scenarioUrl(name) {
  return pathToFileURL(path.join(SCEN_DIR, name + '.js')).href;
}

test('1. load-test driver --help exits 0', () => {
  const r = runDriver(['--help']);
  assert.equal(r.status, 0, 'expected exit 0, got ' + r.status + '\nstderr: ' + r.stderr);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /concurrent-100/);
  assert.match(r.stdout, /long-context-128k/);
  assert.match(r.stdout, /all-providers-down/);
});

test('2. load-test driver --scenario unknown exits 2', () => {
  const r = runDriver(['--scenario', 'does-not-exist']);
  assert.equal(r.status, 2, 'expected exit 2, got ' + r.status + '\nstderr: ' + r.stderr);
  assert.match(r.stderr, /unknown scenario/);
});

test('3. each scenario module exports a default async function', async () => {
  const scenarios = ['concurrent-100', 'long-context-128k', 'all-providers-down'];
  for (const name of scenarios) {
    const mod = await import(scenarioUrl(name));
    const fn = mod.default || mod.run;
    assert.equal(typeof fn, 'function', name + ' did not export a function');
    const isAsync = fn.constructor && fn.constructor.name === 'AsyncFunction';
    const ctx = { base: 'https://example.invalid', bearer: '', rpm: 60, duration_s: 60, dry_run: true };
    const ret = fn(ctx);
    const isThenable = ret && typeof ret.then === 'function';
    assert.ok(isAsync || isThenable, name + ' is not async-compatible');
    if (isThenable) ret.then(() => {}, () => {});
  }
});

async function assertNoHttpInDryRun(scenarioName) {
  // Scenarios `import http from 'node:http'` and call `http.request(...)`
  // — they read `.request` off the module namespace at call time, so
  // monkey-patching the namespace object's `request` property is enough
  // to detect any accidental network call during dry-run.
  const origHttpReq = http.request;
  const origHttpsReq = https.request;
  let httpCalls = 0;
  let httpsCalls = 0;
  http.request = function () { httpCalls++; throw new Error('http.request called during dry-run for ' + scenarioName); };
  https.request = function () { httpsCalls++; throw new Error('https.request called during dry-run for ' + scenarioName); };
  try {
    const mod = await import(scenarioUrl(scenarioName));
    const fn = mod.default || mod.run;
    const ctx = { base: 'https://example.invalid', bearer: 'ks_test', rpm: 60, duration_s: 60, dry_run: true };
    const result = await fn(ctx);
    assert.ok(result, scenarioName + ' returned no result');
    assert.equal(result.skipped, true, scenarioName + ' dry-run did not set skipped:true');
    assert.equal(httpCalls, 0, scenarioName + ' made ' + httpCalls + ' http.request calls');
    assert.equal(httpsCalls, 0, scenarioName + ' made ' + httpsCalls + ' https.request calls');
  } finally {
    http.request = origHttpReq;
    https.request = origHttpsReq;
  }
}

test('4. concurrent-100 dry-run makes no HTTP calls', async () => {
  await assertNoHttpInDryRun('concurrent-100');
});

test('5. long-context-128k dry-run makes no HTTP calls', async () => {
  await assertNoHttpInDryRun('long-context-128k');
});

test('6. all-providers-down dry-run makes no HTTP calls', async () => {
  await assertNoHttpInDryRun('all-providers-down');
});
