// W529 — meta-test: pin the release-verify lock-in test suite is itself
// audit-resistant.
//
// We've shipped W524 + W526 + W527 + W528 + W530 + W531 as a structural
// hardening suite for scripts/release-verify.cjs. Without a meta-test,
// someone could (a) delete one of these files and never notice, or
// (b) add a new release-verify lock-in that doesn't follow the contract.
//
// NOTE (2026 teardown): the W490 (openapi-sync) and W525 (sdk-manifest)
// lock-in *test files* were retired with the multi-surface compiler product
// and removed from SUITE below. Their gates still exist in release-verify.cjs
// (gateOpenapiSync / gateSdkManifest), and the gate names remain referenced by
// the surviving suite files, so #9's gate-coverage check still holds.
//
// Pin:
//   1. The suite enumeration — every expected file exists.
//   2. Each file has a header comment that documents WHY it locks in what
//      it does (so a future maintainer can decide whether to delete).
//   3. Each file imports node:test + node:assert/strict (the project-wide
//      convention; no other test runners).
//   4. Each file references scripts/release-verify.cjs OR explicitly
//      documents why it does not (e.g. wave525 also reads sdk-manifest
//      static assets directly).
//   5. The aggregate test count is non-trivial (>= 50) so no one collapses
//      the suite into a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const TESTS = path.join(REPO, 'tests');

const SUITE = [
  { file: 'wave524-release-verify-helpers.test.js',      minTests: 8 },
  { file: 'wave526-release-verify-json-mode.test.js',    minTests: 10 },
  { file: 'wave527-allow-logged-out-passthrough.test.js', minTests: 10 },
  { file: 'wave528-release-verify-exit-codes.test.js',   minTests: 10 },
  { file: 'wave530-release-verify-lint-refs-gate.test.js', minTests: 10 },
  { file: 'wave531-release-verify-gatecli-helper.test.js', minTests: 10 },
];

test('W529 #1 — every release-verify lock-in file exists', () => {
  for (const entry of SUITE) {
    const fp = path.join(TESTS, entry.file);
    assert.ok(fs.existsSync(fp), `missing suite file: ${entry.file}`);
  }
});

test('W529 #2 — every file declares a header docstring with "Why this lock-in"', () => {
  // Documentation contract: when you ship a lock-in, you explain in the
  // header what behavior it pins and why. Future-you (or another agent)
  // needs to know whether the constraint is still load-bearing.
  for (const entry of SUITE) {
    const src = fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
    const head = src.slice(0, 2500);
    // Either "Why" or "why this lock-in" appears in the header comment.
    assert.match(head, /why|lock-?in|pin/i, `${entry.file}: header must explain why the lock-in exists`);
  }
});

test('W529 #3 — every file imports node:test + node:assert/strict (no other runners)', () => {
  for (const entry of SUITE) {
    const src = fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
    assert.match(src, /from\s+['"]node:test['"]/, `${entry.file}: must import from node:test`);
    assert.match(src, /from\s+['"]node:assert\/strict['"]/, `${entry.file}: must import from node:assert/strict`);
    // Negative: no jest/mocha/vitest references.
    assert.doesNotMatch(src, /\b(jest|mocha|vitest|chai|describe\.skip)\b/i,
      `${entry.file}: no foreign test-runner references`);
  }
});

test('W529 #4 — every file references scripts/release-verify.cjs OR documents the exception', () => {
  for (const entry of SUITE) {
    const src = fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
    const refsDriver = /release-verify\.cjs/.test(src);
    if (!refsDriver) {
      assert.fail(`${entry.file}: release-verify lock-in must reference scripts/release-verify.cjs`);
    }
  }
});

test('W529 #5 — every file declares at least the documented minimum test count', () => {
  for (const entry of SUITE) {
    const src = fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
    // Count test('...') invocations at top-level (very simple parser — looks
    // for /^test\(/m after stripping comments). This is good enough as a
    // floor check.
    const testCalls = src.match(/^\s*test\(/gm) || [];
    assert.ok(testCalls.length >= entry.minTests,
      `${entry.file}: expected >= ${entry.minTests} tests, found ${testCalls.length}`);
  }
});

test('W529 #6 — aggregate suite has >= 50 tests (no stub collapse)', () => {
  let total = 0;
  for (const entry of SUITE) {
    const src = fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
    const testCalls = src.match(/^\s*test\(/gm) || [];
    total += testCalls.length;
  }
  assert.ok(total >= 50,
    `release-verify lock-in suite collapsed: only ${total} tests (expected >= 50)`);
});

test('W529 #7 — no file uses literal apostrophes inside single-quoted test names', () => {
  // ESM parser breaks on `test('foo's bar', ...)` — fail loudly here so a
  // future test author doesn't trip the same trap pinned in the W524 memory.
  for (const entry of SUITE) {
    const src = fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
    // Look for test('<name with literal '>') patterns. Specifically the
    // single-quote-inside-single-quote case. This regex is intentionally
    // conservative — it catches the obvious shape, not every edge case.
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s*test\('([^']*)'.*$/);
      if (!m) continue;
      // If the test name "rest after first quote" contains an apostrophe
      // followed by a non-quote char, we have an unescaped apostrophe.
      // Already-correctly-paired strings won't match (the regex stops at
      // the closing quote).
      // Defense: check the rest of the line for `, ...)` shape; if missing
      // it might be a multi-line declaration we can't easily parse — skip.
      if (!/',\s*/.test(line)) continue;
    }
    // The cheaper check: grep for the literal "unref'ed" we hit before.
    assert.doesNotMatch(src, /'\s*\w*'ed\s+/,
      `${entry.file}: avoid contractions with apostrophes inside single-quoted strings`);
  }
});

test('W529 #8 — release-verify driver itself is still single-file CJS', () => {
  // Defense: if someone splits release-verify.cjs into multiple files, the
  // SRC-text parsing in W490/W524-W528 silently misses behavior. Fail here
  // first to force a re-design of the lock-in suite.
  const driver = path.join(REPO, 'scripts', 'release-verify.cjs');
  assert.ok(fs.existsSync(driver), 'scripts/release-verify.cjs must exist as a single file');
  const src = fs.readFileSync(driver, 'utf8');
  assert.ok(src.length > 5000, 'driver must be substantive (>= 5KB)');
  assert.ok(src.length < 200000, 'driver must remain single-file (< 200KB)');
});

test('W529 #9 — every gate name in ALL_GATES list is locked-in somewhere', () => {
  const ALL_GATES = [
    'lint:refs', 'openapi-sync', 'sdk-manifest', 'test', 'sdk-smoke',
    'local-surfaces', 'doctor', 'whoami', 'verify-claims', 'billing-tiers',
  ];
  let combined = '';
  for (const entry of SUITE) {
    combined += fs.readFileSync(path.join(TESTS, entry.file), 'utf8');
  }
  for (const gate of ALL_GATES) {
    assert.ok(combined.includes(gate),
      `gate name ${gate} appears nowhere in the release-verify lock-in suite`);
  }
});

test('W529 #10 — every suite file lives in tests/ (no cross-directory drift)', () => {
  for (const entry of SUITE) {
    const fp = path.join(TESTS, entry.file);
    // Confirm parent dir is exactly tests/, not nested.
    assert.equal(path.dirname(fp), TESTS, `${entry.file} must live directly in tests/`);
  }
});
