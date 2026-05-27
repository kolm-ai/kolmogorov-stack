// W910 Track F — CLI fuzzy verb suggestion + dispatcher integration.
//
// Pins the W888-G suggestVerb/levenshtein helpers to the W910-F1 dispatcher
// wiring, so the typo→suggestion path stays glued together. The dispatcher
// runs `suggestVerb(verb, Object.keys(table))` in TWO places:
//   1) cli/kolm.js main() switch default branch (long-standing — wired pre-W910)
//   2) cli/kolm.js _dispatchVerb() (W910-F1 — new this wave)
// Both call sites must surface a "did you mean: kolm <verb> ?" line on stderr
// for genuinely close typos, and stay silent on far ones rather than
// confidently misdirect.
//
// Pinned items:
//   1) Source lock-in: suggestVerb is wired into _dispatchVerb's unknown-verb branch
//   2) Source lock-in: suggestVerb is also wired into main()'s switch default
//   3) Spawn: `kolm complie` exits non-zero with "did you mean: kolm compile"
//   4) Spawn: `kolm benc`    exits non-zero with "did you mean: kolm bench"
//   5) Spawn: a far-typo like `kolm zzzzzzzzz` does NOT emit any "did you mean"
//   6) Spawn: known verb `kolm version` works normally (exit 0, prints version)
//   7) Spawn: `--no-assistant` is honored — note about disabled NL routing prints

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KOLM_JS = path.join(REPO, 'cli', 'kolm.js');

function runKolm(args, extraEnv = {}) {
  // KOLM_ASSISTANT=0 disables the W888-P NL pre-dispatch so a single-token
  // typo cleanly falls to the unknown-verb branch we want to assert on.
  // KOLM_NO_INTERACTIVE=1 prevents the bare-kolm interactive shell from
  // hijacking stdout when args are empty.
  // KOLM_NO_PROGRESS=1 disables spinner animation so output stays deterministic.
  const env = {
    ...process.env,
    KOLM_ASSISTANT: '0',
    KOLM_NO_INTERACTIVE: '1',
    KOLM_NO_PROGRESS: '1',
    NO_COLOR: '1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [KOLM_JS, ...args], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// 1
test('W910-F.1 suggestVerb is wired into _dispatchVerb unknown-verb branch', () => {
  const src = fs.readFileSync(KOLM_JS, 'utf8');
  // Verify the dispatcher's unknown-verb branch invokes suggestVerb and emits
  // a "did you mean" line. The exact strings here must match cli/kolm.js.
  assert.match(src, /async function _dispatchVerb\(verb, args\) \{/,
    '_dispatchVerb exists as the named dispatcher');
  // Inside _dispatchVerb, the wiring is: const guess = suggestVerb(verb, Object.keys(table));
  const dispatchStart = src.indexOf('async function _dispatchVerb(verb, args)');
  const dispatchEnd = src.indexOf('\nasync function ', dispatchStart + 1);
  const dispatchBody = src.slice(dispatchStart, dispatchEnd > 0 ? dispatchEnd : dispatchStart + 4000);
  assert.match(dispatchBody, /suggestVerb\(verb,\s*Object\.keys\(table\)\)/,
    '_dispatchVerb calls suggestVerb(verb, Object.keys(table))');
  assert.match(dispatchBody, /did you mean: kolm/,
    '_dispatchVerb emits "did you mean: kolm <verb> ?" on the unknown path');
});

// 2
test('W910-F.2 suggestVerb is wired into main() switch default branch', () => {
  const src = fs.readFileSync(KOLM_JS, 'utf8');
  // The main() default branch path was already wired in W888-G; we lock it
  // in so a future refactor that drops it forces a test update.
  assert.match(src, /suggestVerb\(cmd,\s*COMPLETION_VERBS\)/,
    'main() default invokes suggestVerb(cmd, COMPLETION_VERBS)');
  assert.match(src, /did you mean: kolm/,
    'main() default emits "did you mean: kolm <verb> ?"');
});

// 3
test('W910-F.3 `kolm complie` suggests `compile`', () => {
  const r = runKolm(['complie']);
  assert.notEqual(r.status, 0, 'unknown verb must exit non-zero');
  assert.match(r.stderr, /did you mean:\s*kolm\s+compile/i,
    `expected "did you mean: kolm compile" in stderr; got: ${r.stderr}`);
});

// 4
test('W910-F.4 `kolm benc` suggests `bench`', () => {
  const r = runKolm(['benc']);
  assert.notEqual(r.status, 0, 'unknown verb must exit non-zero');
  assert.match(r.stderr, /did you mean:\s*kolm\s+bench/i,
    `expected "did you mean: kolm bench" in stderr; got: ${r.stderr}`);
});

// 5
test('W910-F.5 far typo does NOT emit a misleading suggestion', () => {
  const r = runKolm(['zzqxblargnope']);
  assert.notEqual(r.status, 0, 'unknown verb must exit non-zero');
  assert.doesNotMatch(r.stderr, /did you mean/i,
    `far typo should produce no suggestion; got: ${r.stderr}`);
  assert.match(r.stderr, /unknown command|unknown verb/i,
    'should still print an unknown-command message');
});

// 6
test('W910-F.6 known verb still works (no false-positive suggestion)', () => {
  const r = runKolm(['version']);
  assert.equal(r.status, 0, `expected exit 0 for known verb, got ${r.status}; stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /did you mean/i, 'known verb must not trigger fuzzy suggestion');
  // version verb writes the version to stdout — match on the package shape.
  assert.match(r.stdout, /\d+\.\d+\.\d+/, 'version output should contain semver');
});

// 7
test('W910-F.7 --no-assistant flag prints the disabled-NL note on unknown verbs', () => {
  // With KOLM_ASSISTANT=0 (already set in runKolm), the unknown-command
  // branch prints a note that NL routing is disabled. Locks in that the
  // strict-grammar UX still tells the user the assistant exists.
  const r = runKolm(['zzqxblargnope']);
  assert.match(r.stderr, /--no-assistant|KOLM_ASSISTANT/i,
    'disabled-NL branch should mention the toggle so users know it exists');
});
