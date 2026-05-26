// Wave 391 / 392 . CLI bug-fix behavior lock-in.
//
// W391 . `kolm privacy test <text>` must run the detector against the
//        supplied text. The legacy canned 17-class smoke moves under
//        --smoke (or the explicit `kolm privacy smoke` subverb).
//
// W392 . `kolm shell-init --shell powershell` is an alias of pwsh and
//        emits a PowerShell-style env block ($env:NAME = '...').
//
// Tests assert BEHAVIOR (spawnSync the CLI in a clean HOME) per the
// feedback-tests-assert-behavior-not-page-copy convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli', 'kolm.js');

function runCli(args, { extraEnv } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w391-'));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    ...(extraEnv || {}),
  };
  delete env.KOLM_API_KEY;
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env, encoding: 'utf8', timeout: 30000,
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

function parseJson(out) {
  const line = (out || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('{'));
  if (!line) throw new Error('no JSON line in stdout: ' + JSON.stringify(out).slice(0, 200));
  return JSON.parse(line);
}

// ===========================================================================
// W391 . privacy test <text>
// ===========================================================================

test('W391 #1 . privacy test <text> scans the supplied text (SSN positive)', () => {
  const r = runCli(['privacy', 'test', 'patient ssn is 999-12-3456 today', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  // The envelope must reflect THIS input, not a hardcoded fixture.
  assert.ok(Array.isArray(env.data.matches), 'matches must be an array');
  const classes = (env.data.matches || []).map(m => m.class);
  assert.ok(
    classes.includes('ssn') || classes.includes('malformed_ssn'),
    `expected ssn or malformed_ssn match, got: ${classes.join(',')}`
  );
  // The envelope must echo the input so consumers can pin the source.
  assert.ok(typeof env.data.input === 'string');
  assert.ok(env.data.input.includes('999-12-3456'));
});

test('W391 #2 . privacy test <text> with email + api_key in one input', () => {
  const text = 'email me at a@example.com and api key sk-test1234567890aaaaaaaaaaaaaaaaaaaaaaa';
  const r = runCli(['privacy', 'test', text, '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  const classes = new Set((env.data.matches || []).map(m => m.class));
  // We assert on email (api_key heuristics can vary by detector version).
  assert.ok(classes.has('email'), `expected email in matches, got: ${[...classes].join(',')}`);
  // The smoke-fixture bearer_token "Bearer bbbb..." string must NOT appear
  // (that was the W391 bug . canned fixture leaking into custom-text path).
  const values = (env.data.matches || []).map(m => m.value || '');
  for (const v of values) {
    assert.ok(!/^Bearer bb+/.test(v), `bearer fixture leaked into custom text: ${v}`);
  }
});

test('W391 #3 . privacy test with no text and no --smoke prints usage hint', () => {
  const r = runCli(['privacy', 'test']);
  // Must fail (bad_args), and stderr must point at --smoke.
  assert.notEqual(r.code, 0, 'expected non-zero exit when neither text nor --smoke is provided');
  assert.match(r.stderr, /--smoke/, 'stderr must hint at --smoke');
});

test('W391 #4 . privacy test --smoke --json returns the canned 17-class fixture', () => {
  const r = runCli(['privacy', 'test', '--smoke', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.results, 'results envelope required for smoke run');
  // Each canonical fixture class must surface.
  for (const cls of ['ssn', 'email', 'phone', 'api_key']) {
    assert.ok(env.data.results[cls], `result for ${cls} required`);
    assert.equal(env.data.results[cls].matched, true);
  }
});

test('W391 #5 . privacy smoke subverb is an alias of test --smoke', () => {
  const r = runCli(['privacy', 'smoke', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.results, 'results envelope required for smoke subverb');
});

// ===========================================================================
// W392 . shell-init --shell powershell
// ===========================================================================

test('W392 #1 . shell-init --shell powershell exits 0', () => {
  const r = runCli(['shell-init', '--shell', 'powershell']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
});

test('W392 #2 . shell-init --shell powershell emits PowerShell-style env block', () => {
  const r = runCli(['shell-init', '--shell', 'powershell']);
  assert.equal(r.code, 0);
  // PowerShell form: `$env:NAME = 'value'`. Bash form is `export NAME=`.
  assert.match(r.stdout, /\$env:\w+\s*=\s*'/m,
    'must emit at least one $env:NAME = "..." line');
  assert.ok(!/^export\s/m.test(r.stdout),
    'must NOT emit bash-style export lines for --shell powershell');
});

test('W392 #3 . shell-init --shell powershell --json wraps snippet in envelope', () => {
  const r = runCli(['shell-init', '--shell', 'powershell', '--json']);
  assert.equal(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.snippet, 'snippet required');
  assert.match(env.data.snippet, /\$env:\w+/);
});

test('W392 #4 . shell-init --shell pwsh still works (canonical name)', () => {
  const r = runCli(['shell-init', '--shell', 'pwsh']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  assert.match(r.stdout, /\$env:\w+\s*=\s*'/m);
});
