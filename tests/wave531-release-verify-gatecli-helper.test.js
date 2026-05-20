// W531 — pin the gateCli helper inside scripts/release-verify.cjs.
//
// Why this lock-in: gateCli is the foundational helper that wraps every
// "CLI gate" (doctor, whoami, verify-claims, billing-tiers). It's responsible
// for: argv quoting, JSON parsing, validator dispatch, skip handling, exit
// reporting, and timeout enforcement. If a refactor changes the contract
// (e.g. parses stdout differently, swaps the validator signature) all four
// CLI gates silently break. Pin the entire helper shape so a refactor breaks
// here first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');
const SRC = fs.readFileSync(DRIVER, 'utf8');

test('W531 #1 — gateCli helper is defined with (name, argv, validator) signature', () => {
  assert.match(SRC, /function\s+gateCli\(\s*name\s*,\s*argv\s*,\s*validator\s*\)/,
    'gateCli must take (name, argv, validator) — pinned signature');
});

test('W531 #2 — gateCli short-circuits to skipped when shouldRun(name) is false', () => {
  // Pin the early-return so --skip=doctor actually skips doctor.
  assert.match(SRC, /if\s*\(\s*!shouldRun\(name\)\s*\)\s*\{\s*recordResult\(name,\s*true,\s*\{\s*skipped:\s*true\s*\}\s*\);\s*return\s+true;\s*\}/,
    'gateCli must early-return ok:true skipped:true when shouldRun is false');
});

test('W531 #3 — gateCli emits progress(`${name} running: kolm ${argv}`) for user visibility', () => {
  // Without progress, the user sees release-verify "hang" while doctor runs
  // its 30s probe — UX nightmare.
  assert.match(SRC, /progress\(\s*`\$\{name\} running: kolm \$\{argv\.join\(['"]\s+['"]\)\}`\s*\)/,
    'gateCli must emit "running: kolm <argv>" progress line');
});

test('W531 #4 — gateCli runs the kolm CLI via runSync with silent + 60s timeout', () => {
  // 60s is the documented per-CLI-gate ceiling. Drift means whoami/doctor
  // could hang for minutes inside release-verify.
  assert.match(SRC, /runSync\(nodeBin,\s*\[\s*KOLM_CLI,\s*\.\.\.argv\s*\],\s*\{\s*silent:\s*true,\s*timeoutMs:\s*60_?000\s*\}\)/,
    'gateCli must invoke runSync with silent:true + timeoutMs:60000');
});

test('W531 #5 — gateCli parses stdout as JSON and reports non-JSON as a failure', () => {
  // If the CLI ever stops emitting --json envelopes, this surfaces the
  // first 300 chars of stdout + 200 of stderr so the user sees WHY.
  assert.match(SRC, /try\s*\{\s*parsed\s*=\s*JSON\.parse\(r\.stdout\);\s*\}\s*catch/,
    'gateCli must try/catch JSON.parse on stdout');
  assert.match(SRC, /non-JSON stdout/,
    'gateCli must report non-JSON output as failure detail');
  assert.match(SRC, /r\.stdout[^\n]*\.slice\(0,\s*300\)/,
    'failure detail must include first 300 chars of stdout');
  assert.match(SRC, /r\.stderr[^\n]*\.slice\(0,\s*200\)/,
    'failure detail must include first 200 chars of stderr');
});

test('W531 #6 — gateCli dispatches the validator with (parsed, r) and trusts ok boolean', () => {
  // The validator gets both the parsed envelope AND the raw spawnSync
  // result (so it can also inspect exit code / stderr if needed).
  assert.match(SRC, /const\s+verdict\s*=\s*validator\s*\?\s*validator\(parsed,\s*r\)\s*:\s*\{\s*ok:\s*true\s*\}/,
    'gateCli must call validator(parsed, r) and default to {ok:true} when absent');
  assert.match(SRC, /const\s+ok\s*=\s*!!verdict\.ok/,
    'gateCli must coerce verdict.ok via !!');
});

test('W531 #7 — gateCli records duration_ms + exit on every recordResult call', () => {
  // Required by the dashboard panel + CI matrix consumers.
  const idx = SRC.indexOf('function gateCli');
  const fnEnd = SRC.indexOf('\n}\n', idx);
  const fn = SRC.slice(idx, fnEnd);
  // Count recordResult invocations — should be 2 (skipped path doesn't count;
  // pin happens elsewhere). Both must include duration_ms + exit.
  const recordCalls = fn.match(/recordResult\(/g) || [];
  assert.ok(recordCalls.length >= 2, `gateCli must call recordResult at least twice; got ${recordCalls.length}`);
  // Both surface paths include the duration_ms + exit fields.
  const fnAfterFirstRecord = fn.slice(fn.indexOf('recordResult(name, false'));
  assert.match(fnAfterFirstRecord, /duration_ms:\s*Date\.now\(\)\s*-\s*t/,
    'failure recordResult must include duration_ms');
  assert.match(fnAfterFirstRecord, /exit:\s*r\.status/,
    'failure recordResult must include exit');
});

test('W531 #8 — gateCli is used by all four CLI gates with the right validator', () => {
  // Pin every consumer — if a new gate is added but skips the helper, it
  // would silently break the timeout/skip/JSON-parse contract.
  for (const gate of ['doctor', 'whoami', 'verify-claims', 'billing-tiers']) {
    assert.match(SRC, new RegExp(`gateCli\\(\\s*['"]${gate}['"]`),
      `gateCli('${gate}', ...) call must exist`);
  }
});

test('W531 #9 — gateCli return value reflects ok boolean (not undefined)', () => {
  // Some callers may use the return value (sequential gating). Pin that
  // every code path returns either true or false (no implicit undefined).
  const idx = SRC.indexOf('function gateCli');
  const fnEnd = SRC.indexOf('\n}\n', idx);
  const fn = SRC.slice(idx, fnEnd);
  // Three return points: skipped, JSON parse fail, normal.
  const returns = fn.match(/\breturn\s+(true|false|ok)\b/g) || [];
  assert.ok(returns.length >= 3, `gateCli must return explicit boolean in every code path; got ${returns.length} return statements`);
});

test('W531 #10 — gateCli detail string formatting includes parsed envelope keys on happy path', () => {
  // When the validator returns ok:true but no reason, gateCli synthesizes
  // a "fields: ..." line so the user sees WHAT the CLI returned (debug aid).
  assert.match(SRC, /Object\.keys\(parsed\)\.slice\(0,\s*10\)\.join\(['"],['"]\)/,
    'happy-path fallback detail must enumerate first 10 envelope keys');
});
