// WC14 — security hardening regression test.
//
// Three classes of footgun this test pins:
//   1) `shell: process.platform === 'win32'` (or `shell: true`) anywhere in
//      src/compute/backends/*.js. On Windows that flips spawn() into cmd.exe
//      with argv concatenated as a shell string — an RCE waiting to happen
//      the moment any tenant HTTP route routes user-controlled spec.command
//      through compute.run().
//   2) ssh/scp `identity_file` arg taken from a device profile without a
//      leading-`-` guard. A profile with identity_file: "-oProxyCommand=evil"
//      lets the profile owner smuggle arbitrary ssh options into argv.
//   3) Sanity unit tests on _assertSafeFlag() itself.
//
// Test style intentionally fragile (text/regex match) — this is a lock-in
// against a regression on a known footgun, not a unit test of behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const BACKENDS_TO_PIN = [
  'src/compute/backends/local-cpu.js',
  'src/compute/backends/local-cuda.js',
  'src/compute/backends/local-directml.js',
  'src/compute/backends/local-mps.js',
  'src/compute/backends/local-mlx.js',
  'src/compute/backends/local-rocm.js',
  'src/compute/backends/modal.js',
];

function readFile(relative) {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

for (const rel of BACKENDS_TO_PIN) {
  test(`WC14 ${rel} must NOT use shell: process.platform conditional`, () => {
    const src = readFile(rel);
    // Match `shell: process.platform` with arbitrary whitespace between the
    // colon and the keyword. This is the original footgun pattern.
    const m = src.match(/shell\s*:\s*process\.platform/);
    assert.equal(m, null,
      `${rel} contains a 'shell: process.platform' conditional — must be 'shell: false'. ` +
      `On Windows this re-enables cmd.exe argv concatenation and reopens the RCE surface.`);
  });

  test(`WC14 ${rel} must NOT use shell: true`, () => {
    const src = readFile(rel);
    const m = src.match(/shell\s*:\s*true/);
    assert.equal(m, null,
      `${rel} contains a 'shell: true' spawn option — must be 'shell: false'. ` +
      `spawn() with shell:true takes a STRING command and runs it through /bin/sh or cmd.exe, ` +
      `defeating argv-array isolation.`);
  });
}

test('WC14 src/device-install.js defines _assertSafeFlag helper', () => {
  const src = readFile('src/device-install.js');
  assert.match(src, /function\s+_assertSafeFlag\s*\(/,
    'src/device-install.js must define _assertSafeFlag(value, fieldName) as the canonical leading-`-` guard.');
});

test('WC14 src/device-install.js guards identity_file at both scp and ssh sites', () => {
  const src = readFile('src/device-install.js');
  // Count occurrences of `_assertSafeFlag(...identity_file...)` — there are
  // two ssh call sites: scp inside _scpToHost, and ssh inside testInstall.
  const matches = src.match(/_assertSafeFlag\([^)]*identity_file[^)]*\)/g) || [];
  assert.ok(matches.length >= 2,
    `src/device-install.js must invoke _assertSafeFlag on device.ssh.identity_file at BOTH ssh sites ` +
    `(scp inside _scpToHost AND ssh inside testInstall). Found ${matches.length} occurrences.`);
});

test('WC14 src/device-install.js must NOT pass identity_file via raw String()', () => {
  const src = readFile('src/device-install.js');
  // Negative lock — the unguarded form was `String(device.ssh.identity_file)`.
  // If that string returns, the regression is back.
  const m = src.match(/['"]-i['"]\s*,\s*String\(\s*device\.ssh\.identity_file/);
  assert.equal(m, null,
    'src/device-install.js still pushes identity_file with raw String() — must wrap in _assertSafeFlag.');
});

test('WC14 src/device-capabilities.js guards identity_file at the ssh test site', () => {
  const src = readFile('src/device-capabilities.js');
  assert.match(src, /_assertSafeFlag\([^)]*identity_file[^)]*\)/,
    'src/device-capabilities.js must invoke _assertSafeFlag on d.ssh.identity_file (the testDevice ssh path).');
  // Negative: the unguarded form was `String(d.ssh.identity_file)`.
  const m = src.match(/['"]-i['"]\s*,\s*String\(\s*d\.ssh\.identity_file/);
  assert.equal(m, null,
    'src/device-capabilities.js still pushes identity_file with raw String() — must wrap in _assertSafeFlag.');
});

// Unit tests on the helper itself. Import from device-install.js (the
// canonical home — device-capabilities.js intentionally inlines a copy to
// avoid a circular import).
test('WC14 _assertSafeFlag rejects values starting with -', async () => {
  const { _assertSafeFlag } = await import('../src/device-install.js');
  assert.throws(
    () => _assertSafeFlag('-oProxyCommand=evil', 'identity_file'),
    /identity_file must not start with '-'/,
    '_assertSafeFlag must throw when the value begins with `-` (flag injection guard).',
  );
});

test('WC14 _assertSafeFlag returns a real path unchanged', async () => {
  const { _assertSafeFlag } = await import('../src/device-install.js');
  const out = _assertSafeFlag('/home/user/.ssh/id_ed25519', 'identity_file');
  assert.equal(out, '/home/user/.ssh/id_ed25519');
});

test('WC14 _assertSafeFlag treats empty input as safe (callers gate on truthiness)', async () => {
  const { _assertSafeFlag } = await import('../src/device-install.js');
  assert.equal(_assertSafeFlag('', 'identity_file'), '');
  assert.equal(_assertSafeFlag(null, 'identity_file'), '');
  assert.equal(_assertSafeFlag(undefined, 'identity_file'), '');
});
