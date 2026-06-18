// W707 - direct contract for workers/tsac/tsac.mjs.
//
// Pins the Node worker shell around argv validation, runtime override bounds,
// doctor privacy, profile path redaction, and secret-minimized child process
// execution.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildDefaultProfile } from '../src/tsac-profile.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER = path.join(ROOT, 'workers', 'tsac', 'tsac.mjs');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w707-tsac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function parseJson(stdout) {
  const text = String(stdout || '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  assert.ok(first >= 0 && last > first, `stdout did not contain JSON: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(first, last + 1));
}

function runWorker(args, env = {}) {
  return spawnSync(process.execPath, [WORKER, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function writeProfile(dir, task = 'claims-redaction') {
  const profile = buildDefaultProfile({ task, num_layers: 1, num_heads: 1 });
  const profilePath = path.join(dir, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  return profilePath;
}

test('W707 source pins TSAC worker shell constants and package depth wiring', () => {
  const src = fs.readFileSync(WORKER, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(src, /TSAC_WORKER_VERSION\s*=\s*'w707-tsac-worker-shell-v1'/);
  assert.match(src, /TSAC_WORKER_CONTRACT_VERSION\s*=\s*'w707-v1'/);
  assert.match(src, /MAX_RUNTIME_CMD_CHARS:\s*8192/);
  assert.match(src, /childEnv\(\)/);
  assert.match(src, /parseRuntimeOverride/);
  assert.doesNotMatch(src, /env:\s*\{\s*\.\.\.process\.env\s*\}/, 'worker must not forward full parent env');
  assert.doesNotMatch(src, /shell:\s*process\.platform\s*===\s*['"]win32['"]/, 'worker must not use shell:true on Windows');
  assert.match(src, /shell:\s*false/);
  assert.equal(
    pkg.scripts['verify:tsac-worker-shell'],
    'node --test --test-concurrency=1 tests/wave707-tsac-worker-shell-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:kv-cache && npm run verify:itkv-worker-shell && npm run verify:tsac-worker-shell && npm run verify:llm-routing/,
  );
});

test('W707 doctor output keeps readiness but does not disclose home path or secrets', () => {
  const secret = 'tsac-super-secret-value';
  const r = runWorker(['--doctor'], { SECRET_SHOULD_NOT_LEAK: secret });
  const out = parseJson(r.stdout);

  assert.equal(out.spec, 'kolm-tsac-worker-doctor');
  assert.equal(out.contract_version, 'w707-v1');
  assert.equal(typeof out.ready, 'boolean');
  assert.equal(typeof out.script_present, 'boolean');
  assert.equal(out.home, undefined);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(secret));
  assert.equal(r.status, 0);
});

test('W707 malformed argv fails before runtime lookup with a structured bad_args envelope', () => {
  const r = runWorker(['--profile', '--output', 'out.json', '--unknown-flag'], { PATH: '', Path: '' });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 2);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'bad_args');
  assert.ok(out.errors.some((row) => row.flag === '--profile' && row.error === 'missing_value'));
  assert.ok(out.errors.some((row) => row.flag === '--unknown-flag' && row.error === 'unknown_arg'));
});

test('W707 missing profile path is reported without the raw absolute path', (t) => {
  const dir = tmpDir(t);
  const missing = path.join(dir, 'missing-profile.json');
  const r = runWorker(['--profile', missing], {
    TSAC_KERNEL_CMD: JSON.stringify([process.execPath]),
    SECRET_SHOULD_NOT_LEAK: 'secret-profile-path-value',
  });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 4);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'profile_not_found');
  assert.match(out.path_sha256, /^[a-f0-9]{64}$/);
  assert.equal(out.path_basename, 'missing-profile.json');
  assert.doesNotMatch(JSON.stringify(out), new RegExp(missing.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(out), /secret-profile-path-value/);
});

test('W707 runtime override uses JSON argv and strips parent secrets from child env', (t) => {
  const dir = tmpDir(t);
  const profile = writeProfile(dir);
  const output = path.join(dir, 'selector-output.json');
  const stub = path.join(dir, 'stub.mjs');
  fs.writeFileSync(stub, `
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = args[outputIndex + 1];
fs.writeFileSync(output, JSON.stringify({ ok: true, kernel: 'vertical_slash_qtopk' }) + '\\n');
console.log(JSON.stringify({
  ok: true,
  selected: 1,
  secret_seen: Boolean(process.env.SECRET_SHOULD_NOT_LEAK),
  secret_keys: Object.keys(process.env).filter((key) => /SECRET|TOKEN|KEY/i.test(key)).sort(),
}));
`);

  const r = runWorker(['--profile', profile, '--output', output, '--task', 'claims-redaction'], {
    TSAC_KERNEL_CMD: JSON.stringify([process.execPath, stub]),
    SECRET_SHOULD_NOT_LEAK: 'do-not-forward',
    API_TOKEN_SHOULD_NOT_LEAK: 'do-not-forward',
  });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.contract_version, 'w707-v1');
  assert.equal(out.worker_version, 'w707-tsac-worker-shell-v1');
  assert.equal(out.output, output);
  assert.equal(out.selector_source, 'env:TSAC_KERNEL_CMD');
  assert.equal(out.selector_inner.secret_seen, false);
  assert.deepEqual(out.selector_inner.secret_keys, []);
  assert.equal(fs.readFileSync(output, 'utf8').trim(), '{"ok":true,"kernel":"vertical_slash_qtopk"}');
});

test('W707 raw runtime overrides with embedded argv are rejected honestly', (t) => {
  const dir = tmpDir(t);
  const profile = writeProfile(dir);
  const output = path.join(dir, 'selector-output.json');
  const stub = path.join(dir, 'stub.mjs');
  fs.writeFileSync(stub, 'console.log(JSON.stringify({ok:true,selected:1}))\n');

  const r = runWorker(['--profile', profile, '--output', output], {
    TSAC_KERNEL_CMD: `${process.execPath} ${stub}`,
    PATH: '',
    Path: '',
  });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 3);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_kernel_runtime');
  assert.match(out.hint, /JSON array override/);
});
