// W706 - direct contract for workers/itkv/itkv.mjs.
//
// Pins the Node worker shell around argv validation, runtime override bounds,
// doctor privacy, and secret-minimized child process execution.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER = path.join(ROOT, 'workers', 'itkv', 'itkv.mjs');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w706-itkv-'));
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

test('W706 source pins ITKV worker shell constants and package depth wiring', () => {
  const src = fs.readFileSync(WORKER, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(src, /ITKV_WORKER_VERSION\s*=\s*'w706-itkv-worker-shell-v1'/);
  assert.match(src, /ITKV_WORKER_CONTRACT_VERSION\s*=\s*'w706-v1'/);
  assert.match(src, /MAX_RUNTIME_CMD_CHARS:\s*8192/);
  assert.match(src, /childEnv\(\)/);
  assert.match(src, /parseRuntimeOverride/);
  assert.doesNotMatch(src, /env:\s*\{\s*\.\.\.process\.env\s*\}/, 'worker must not forward full parent env');
  assert.equal(
    pkg.scripts['verify:itkv-worker-shell'],
    'node --test --test-concurrency=1 tests/wave706-itkv-worker-shell-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:kv-cache && npm run verify:itkv-worker-shell && npm run verify:tsac-worker-shell && npm run verify:llm-routing/);
});

test('W706 doctor output keeps readiness but does not disclose home path or secrets', () => {
  const secret = 'itkv-super-secret-value';
  const r = runWorker(['--doctor'], { SECRET_SHOULD_NOT_LEAK: secret });
  const out = parseJson(r.stdout);

  assert.equal(out.spec, 'kolm-itkv-tier-selector-doctor');
  assert.equal(out.contract_version, 'w706-v1');
  assert.equal(typeof out.ready, 'boolean');
  assert.equal(typeof out.env.home_present, 'boolean');
  assert.equal(out.env.home, undefined);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(secret));
  assert.equal(r.status === 0 || r.status === 3, true);
});

test('W706 malformed argv fails before runtime lookup with a structured bad_args envelope', () => {
  const r = runWorker(['--tokens', '--output', 'out.jsonl', '--unknown-flag'], { PATH: '', Path: '' });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 2);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'bad_args');
  assert.ok(out.errors.some((row) => row.flag === '--tokens' && row.error === 'missing_value'));
  assert.ok(out.errors.some((row) => row.flag === '--unknown-flag' && row.error === 'unknown_arg'));
});

test('W706 missing token path is reported without the raw absolute path', (t) => {
  const dir = tmpDir(t);
  const missing = path.join(dir, 'missing-token-file.jsonl');
  const outPath = path.join(dir, 'out.jsonl');
  const r = runWorker(['--tokens', missing, '--output', outPath], {
    ITKV_TIER_CMD: JSON.stringify([process.execPath]),
    SECRET_SHOULD_NOT_LEAK: 'secret-token-path-value',
  });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 2);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tokens_file_not_found');
  assert.match(out.path_sha256, /^[a-f0-9]{64}$/);
  assert.equal(out.path_basename, 'missing-token-file.jsonl');
  assert.doesNotMatch(JSON.stringify(out), new RegExp(missing.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(out), /secret-token-path-value/);
});

test('W706 runtime override uses JSON argv and strips parent secrets from child env', (t) => {
  const dir = tmpDir(t);
  const tokens = path.join(dir, 'tokens.jsonl');
  const output = path.join(dir, 'classified.jsonl');
  const stub = path.join(dir, 'stub.mjs');
  fs.writeFileSync(tokens, JSON.stringify({ position: 0 }) + '\n');
  fs.writeFileSync(stub, `
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = args[outputIndex + 1];
fs.writeFileSync(output, JSON.stringify({ position: 0, class: 'sink', precision_tier: 'bf16' }) + '\\n');
console.log(JSON.stringify({
  ok: true,
  tokens_classified: 1,
  secret_seen: Boolean(process.env.SECRET_SHOULD_NOT_LEAK),
  secret_keys: Object.keys(process.env).filter((key) => /SECRET|TOKEN|KEY/i.test(key)).sort(),
}));
`);

  const r = runWorker(['--tokens', tokens, '--output', output], {
    ITKV_TIER_CMD: JSON.stringify([process.execPath, stub]),
    SECRET_SHOULD_NOT_LEAK: 'do-not-forward',
    API_TOKEN_SHOULD_NOT_LEAK: 'do-not-forward',
  });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.contract_version, 'w706-v1');
  assert.equal(out.output, output);
  assert.equal(out.tokens_classified, 1);
  assert.equal(out.inner.secret_seen, false);
  assert.deepEqual(out.inner.secret_keys, []);
  assert.equal(fs.readFileSync(output, 'utf8').trim(), '{"position":0,"class":"sink","precision_tier":"bf16"}');
});

test('W706 raw runtime overrides with embedded argv are rejected honestly', (t) => {
  const dir = tmpDir(t);
  const tokens = path.join(dir, 'tokens.jsonl');
  const output = path.join(dir, 'classified.jsonl');
  const stub = path.join(dir, 'stub.mjs');
  fs.writeFileSync(tokens, JSON.stringify({ position: 0 }) + '\n');
  fs.writeFileSync(stub, 'console.log(JSON.stringify({ok:true,tokens_classified:1}))\n');

  const r = runWorker(['--tokens', tokens, '--output', output], {
    ITKV_TIER_CMD: `${process.execPath} ${stub}`,
    PATH: '',
    Path: '',
  });
  const out = parseJson(r.stdout);

  assert.equal(r.status, 3);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_tier_runtime');
  assert.match(out.install_hint, /JSON array form supported/);
});
