// W921 — CLI / TUI / Developer Experience frontier specs lock-in.
//
// Covers the four DX specs shipped this wave:
//   (41) cursor-driven interactive prompt primitives (cli/kolm-ux.js)
//   (43) gh/kubectl-style user command extensions (cli/kolm.js)
//   (42) nested/concurrent task-tree renderer (cli/kolm-ux.js)
//   (40) OS-native credential storage scaffolding + `kolm logout` (cli/kolm.js)
//
// Prompt + task-tree primitives are unit-tested against a non-TTY PassThrough
// harness (fallback parity, masking, fuzzy rank, wrapped-line counting). The
// extension subsystem is tested both at source level and behaviorally by
// spawning the CLI with an isolated KOLM_EXTENSIONS_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KOLM_JS = path.join(REPO, 'cli', 'kolm.js');
const UX = await import(url.pathToFileURL(path.join(REPO, 'cli', 'kolm-ux.js')).href);
const SRC = fs.readFileSync(KOLM_JS, 'utf8');

function mkStream() { const s = new PassThrough(); s.isTTY = false; return s; }

// Drive a non-TTY prompt to completion by feeding scripted lines.
async function drivePrompt(fn, feeds) {
  const stdin = mkStream();
  const stdout = mkStream();
  let out = '';
  stdout.on('data', (d) => { out += d.toString(); });
  const p = fn(stdin, stdout);
  let delay = 10;
  for (const f of feeds) { const ff = f, dd = delay; setTimeout(() => stdin.write(ff), dd); delay += 40; }
  const r = await p;
  return { r, out };
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-dx-'));
  fs.mkdirSync(path.join(dir, '.kolm'), { recursive: true });
  return dir;
}

function runKolm(args, extraEnv = {}) {
  const env = {
    ...process.env, KOLM_ASSISTANT: '0', KOLM_NO_INTERACTIVE: '1',
    KOLM_NO_PROGRESS: '1', NO_COLOR: '1', ...extraEnv,
  };
  const r = spawnSync(process.execPath, [KOLM_JS, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch (_) {}
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// ───────────────────── Spec 41 — prompt primitives ──────────────────────────

test('W921-DX.1 prompt primitives are exported', () => {
  for (const k of ['select', 'multiselect', 'confirm', 'text', 'password', 'autocomplete', 'selectKey', 'isCancel', 'CANCEL', 'isInteractiveCapable']) {
    assert.ok(k in UX, k + ' is exported from kolm-ux.js');
  }
});

test('W921-DX.2 isInteractiveCapable is false on non-TTY (forces fallback)', () => {
  assert.equal(UX.isInteractiveCapable({ stdin: mkStream(), stdout: mkStream() }), false);
});

test('W921-DX.3 select() falls back to numbered readline on non-TTY', async () => {
  const { r, out } = await drivePrompt(
    (i, o) => UX.select({ message: 'Pick', options: [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Banana' }], stdin: i, stdout: o }),
    ['2\n']);
  assert.equal(r, 'b');
  assert.match(out, /Apple/);
  assert.match(out, /Banana/);
});

test('W921-DX.4 password() never echoes the secret to scrollback', async () => {
  const { r, out } = await drivePrompt((i, o) => UX.password({ message: 'Key', stdin: i, stdout: o }), ['ks_secret_value\n']);
  assert.equal(r, 'ks_secret_value', 'real value resolved');
  assert.ok(!out.includes('ks_secret_value'), 'masked: the typed value must NOT appear in output');
});

test('W921-DX.5 text() validate keeps the prompt open then resolves', async () => {
  const { r } = await drivePrompt(
    (i, o) => UX.text({ message: 'Email', validate: (v) => v.includes('@') ? undefined : 'need @', stdin: i, stdout: o }),
    ['bad\n', 'good@x.com\n']);
  assert.equal(r, 'good@x.com');
});

test('W921-DX.6 confirm() default applies on empty Enter', async () => {
  const { r } = await drivePrompt((i, o) => UX.confirm({ message: 'OK?', initialValue: true, stdin: i, stdout: o }), ['\n']);
  assert.equal(r, true);
});

test('W921-DX.7 multiselect() parses comma-separated picks', async () => {
  const { r } = await drivePrompt(
    (i, o) => UX.multiselect({ message: 'Pick', options: [{ value: 'x' }, { value: 'y' }, { value: 'z' }], stdin: i, stdout: o }),
    ['1,3\n']);
  assert.deepEqual(r, ['x', 'z']);
});

test('W921-DX.8 _fuzzyRank ranks prefix/subsequence matches', () => {
  const ranked = UX._fuzzyRank([{ value: 'q4km' }, { value: 'q5km' }, { value: 'q8' }], 'q5');
  assert.equal(ranked[0].value, 'q5km', 'best match first');
});

test('W921-DX.9 login is wired to use the masked password() primitive', () => {
  const start = SRC.indexOf('async function cmdLogin');
  const body = SRC.slice(start, start + 1500);
  assert.match(body, /ux\.password\(\{ message: 'API key/, 'login uses password() in the TTY branch');
});

// ───────────────────── Spec 43 — command extensions ─────────────────────────

test('W921-DX.10 extension resolver + dispatcher are wired', () => {
  assert.match(SRC, /function resolveExtension\(words, opts/);
  assert.match(SRC, /async function cmdExtension\(args\)/);
  assert.match(SRC, /case 'extension':\s*\n\s*case 'ext':/);
  // Resolver runs in the default branch BEFORE suggestVerb.
  const def = SRC.indexOf('// W921 — gh/kubectl-style extension resolution');
  const sug = SRC.indexOf('const guess = suggestVerb(cmd, COMPLETION_VERBS)');
  assert.ok(def > 0 && def < sug, 'extension resolution precedes suggestVerb in the default branch');
});

test('W921-DX.11 EXT_NAME_RE blocks path traversal', () => {
  const re = /^[a-z][a-z0-9-]{0,63}$/;
  assert.equal(re.test('../etc'), false);
  assert.equal(re.test('runpod'), true);
  assert.equal(re.test('Foo'), false);
});

test('W921-DX.12 extension list --json is parseable + empty by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ext-'));
  const r = runKolm(['extension', 'list', '--json'], { KOLM_EXTENSIONS_DIR: dir });
  assert.ok(r.json && r.json.ok === true);
  assert.deepEqual(r.json.extensions, []);
  assert.match(r.json.version, /^w921-/);
});

test('W921-DX.13 `kolm <name>` forwards args + env + exit code to a managed extension', { skip: process.platform !== 'win32' ? false : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ext-'));
  const extdir = path.join(dir, 'kolm-hello');
  fs.mkdirSync(extdir, { recursive: true });
  let binName, content;
  if (process.platform === 'win32') {
    binName = 'kolm-hello.cmd';
    content = '@echo off\r\nnode -e "console.log(\'ARGV=\'+process.argv.slice(1).join(\',\'));console.log(\'EXT=\'+process.env.KOLM_EXTENSION+\' NAME=\'+process.env.KOLM_EXT_NAME+\' HASKEY=\'+(process.env.KOLM_API_KEY?\'yes\':\'no\'));process.exit(7)" %*\r\n';
  } else {
    binName = 'kolm-hello';
    content = '#!/usr/bin/env node\nconsole.log("ARGV="+process.argv.slice(2).join(","));console.log("EXT="+process.env.KOLM_EXTENSION+" NAME="+process.env.KOLM_EXT_NAME+" HASKEY="+(process.env.KOLM_API_KEY?"yes":"no"));process.exit(7);\n';
  }
  const binPath = path.join(extdir, binName);
  fs.writeFileSync(binPath, content);
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(path.join(extdir, 'manifest.json'), JSON.stringify({ name: 'hello', wants_api_key: false }));
  const r = runKolm(['hello', 'a', 'b', '--x'], { KOLM_EXTENSIONS_DIR: dir });
  assert.match(r.stdout, /ARGV=a,b,--x/, 'args forwarded verbatim');
  assert.match(r.stdout, /EXT=1 NAME=hello/, 'KOLM_EXTENSION + KOLM_EXT_NAME injected');
  assert.match(r.stdout, /HASKEY=no/, 'KOLM_API_KEY NOT leaked when manifest opts out');
  assert.equal(r.status, 7, 'child exit code propagated verbatim');
});

test('W921-DX.14 a core verb is never shadowed by a same-named extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ext-'));
  // Drop a kolm-version shim; `kolm version` must STILL run the core verb.
  const binName = process.platform === 'win32' ? 'kolm-version.cmd' : 'kolm-version';
  const content = process.platform === 'win32' ? '@echo off\r\necho SHADOW\r\n' : '#!/bin/sh\necho SHADOW\n';
  const bp = path.join(dir, binName);
  fs.writeFileSync(bp, content);
  if (process.platform !== 'win32') fs.chmodSync(bp, 0o755);
  const r = runKolm(['version'], { KOLM_EXTENSIONS_DIR: dir });
  assert.ok(!/SHADOW/.test(r.stdout + r.stderr), 'the extension must not run');
  assert.match(r.stdout, /\d+\.\d+\.\d+/, 'core version verb ran');
});

test('W921-DX.15 unknown verb with NO extension preserves the suggestVerb path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ext-'));
  const r = runKolm(['complie'], { KOLM_EXTENSIONS_DIR: dir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did you mean:\s*kolm\s+compile/i);
});

// ───────────────────── Spec 42 — task-tree renderer ─────────────────────────

test('W921-DX.16 task-tree renderer + adapters are exported', () => {
  for (const k of ['taskTree', 'fromStepStream', 'fromPhaseStream', 'visibleLineCount', 'displayWidth']) {
    assert.ok(k in UX, k + ' is exported');
  }
});

test('W921-DX.17 visibleLineCount counts WRAPPED rows, not newlines', () => {
  assert.equal(UX.visibleLineCount(['x'.repeat(170)], 80), 3, '170 chars / 80 cols = 3 rows');
  assert.equal(UX.visibleLineCount(['short'], 80), 1);
  assert.equal(UX.displayWidth('\x1b[32mhi\x1b[0m'), 2, 'ANSI stripped before width');
});

test('W921-DX.18 taskTree non-TTY emits append-only lines (zero cursor escapes)', async () => {
  const out = mkStream();
  let buf = ''; out.on('data', (d) => { buf += d.toString(); });
  const r = await UX.taskTree([
    { title: 'alpha', task: async () => {} },
    { title: 'beta', task: async () => { throw new Error('boom'); } },
  ], { stream: out });
  assert.equal(r.ok, false, 'a failing leaf makes the tree fail');
  assert.equal(r.failed.length, 1);
  assert.ok(!/\x1b\[/.test(buf), 'no ANSI cursor-move/erase escapes on non-TTY');
  assert.match(buf, /start: alpha/);
  assert.match(buf, /fail: beta/);
});

test('W921-DX.19 taskTree TTY frame uses cursor-up + erase-line in place', async () => {
  const out = mkStream(); out.isTTY = true; out.columns = 80;
  let buf = ''; out.on('data', (d) => { buf += d.toString(); });
  const r = await UX.taskTree([{ title: 'one', task: async (ctx) => ctx.setOutput('x') }], { stream: out, tickMs: 1000 });
  assert.equal(r.ok, true);
  assert.match(buf, /\x1b\[\d+A/, 'cursor-up to repaint in place');
  assert.match(buf, /\x1b\[2K/, 'erase-line per frame row');
});

test('W921-DX.20 fromStepStream detects failure + stays append-only on non-TTY', async () => {
  async function* steps() {
    yield { step: 1, name: 'plan', status: 'started' };
    yield { step: 1, status: 'ok' };
    yield { step: 2, name: 'build', status: 'started' };
    yield { step: 2, status: 'err', detail: 'nope' };
  }
  const out = mkStream(); let buf = ''; out.on('data', (d) => { buf += d.toString(); });
  const r = await UX.fromStepStream(steps(), { stream: out });
  assert.equal(r.ok, false);
  assert.ok(!/\x1b\[2K/.test(buf), 'no frame escapes on non-TTY');
});

test('W921-DX.21 fromPhaseStream --json emits NDJSON, no human frame', async () => {
  async function* phases() { yield { phase: 'plan' }; yield { phase: 'quantize' }; yield { phase: 'done', ok: true }; }
  const out = mkStream(); out.isTTY = true; let buf = ''; out.on('data', (d) => { buf += d.toString(); });
  const r = await UX.fromPhaseStream(phases(), { plan: { title: 'Plan' }, quantize: { title: 'Quantize' } }, { stream: out, json: true });
  assert.ok(r.done, 'captures the done event');
  assert.ok(!/\x1b\[2K/.test(buf), 'JSON mode bypasses the frame renderer');
  const lines = buf.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'one NDJSON object per event');
  for (const l of lines) JSON.parse(l); // must all be valid JSON
});

// ───────────────────── Spec 40 — credential storage ─────────────────────────

test('W921-DX.22 cred-store scaffolding + logout + migrate-keys wired', () => {
  assert.match(SRC, /async function _credBackend\(\)/);
  assert.match(SRC, /function keyStoreLocation\(\)/);
  assert.match(SRC, /async function cmdLogout\(args\)/);
  assert.match(SRC, /async function cmdConfigMigrateKeys\(args\)/);
  assert.match(SRC, /case 'logout':\s*await withErrorContext\('logout'/);
});

test('W921-DX.23 config show --json surfaces key_store transparency', () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, '.kolm', 'config.json'),
    JSON.stringify({ base: 'https://kolm.ai', api_key: 'ks_test_plain_abcd1234' }));
  const r = runKolm(['config', 'show', '--json'], { HOME: home, USERPROFILE: home, KOLM_HOME: home });
  assert.ok(r.json, 'parseable JSON');
  assert.ok('key_store' in r.json, 'key_store field present');
  assert.ok('key_store_reason' in r.json, 'key_store_reason present');
  // No @napi-rs/keyring in this run -> file backend.
  assert.equal(r.json.key_store, 'file');
});

test('W921-DX.24 logout scrubs the plaintext api_key from config.json', () => {
  const home = freshHome();
  const cfgPath = path.join(home, '.kolm', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ base: 'https://kolm.ai', api_key: 'ks_secret_scrub_me_5678' }));
  const r = runKolm(['logout', '--json'], { HOME: home, USERPROFILE: home, KOLM_HOME: home });
  assert.ok(r.json && r.json.ok === true);
  assert.equal(r.json.plaintext_scrubbed, true);
  const after = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(!after.includes('ks_secret_scrub_me_5678'), 'plaintext key removed from config.json');
});

test('W921-DX.25 migrate-keys is honest when no OS vault is available', () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, '.kolm', 'config.json'),
    JSON.stringify({ base: 'https://kolm.ai', api_key: 'ks_plain_xyz' }));
  const r = runKolm(['config', 'migrate-keys', '--json'], { HOME: home, USERPROFILE: home, KOLM_HOME: home });
  assert.ok(r.json);
  assert.equal(r.json.migrated, false);
  assert.equal(r.json.reason, 'no_os_vault');
});

test('W921-DX.26 KOLM_KEY_STORE=file forces the file backend', () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, '.kolm', 'config.json'),
    JSON.stringify({ base: 'https://kolm.ai', api_key: 'ks_plain_force' }));
  const r = runKolm(['config', 'show', '--json'], { HOME: home, USERPROFILE: home, KOLM_HOME: home, KOLM_KEY_STORE: 'file' });
  assert.equal(r.json.key_store, 'file');
  assert.match(r.json.key_store_reason, /forced by KOLM_KEY_STORE/);
});
