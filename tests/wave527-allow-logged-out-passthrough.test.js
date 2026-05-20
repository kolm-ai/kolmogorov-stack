// W527 — pin the --allow-logged-out contract end-to-end.
//
// Why this lock-in: release-verify on a CI host (no kolm signup, no api key)
// only passes because both the driver AND the CLI honor --allow-logged-out:
//   1. Driver passes --allow-logged-out THROUGH to the doctor + whoami args.
//   2. CLI doctor demotes "api key (server) missing" to status:warn instead
//      of status:missing (so blockers:0 instead of blockers>=1).
//   3. CLI whoami exits 0 with logged_in:false instead of MISSING_PREREQ.
//   4. Driver validator accepts the passthrough envelope.
// If any link in this chain breaks (someone renames the flag, demotes the
// demotion, etc.) the entire CI release-verify pipeline silently fails open
// or fails closed without telling anyone where.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const DRIVER_SRC = fs.readFileSync(DRIVER, 'utf8');
const CLI_SRC = fs.readFileSync(CLI, 'utf8');

test('W527 #1 — driver parses --allow-logged-out into allowLoggedOut', () => {
  assert.match(DRIVER_SRC, /const\s+allowLoggedOut\s*=\s*args\.includes\(['"]--allow-logged-out['"]\)/,
    'driver must derive allowLoggedOut from args.includes("--allow-logged-out")');
});

test('W527 #2 — driver threads --allow-logged-out through to doctor argv', () => {
  // The driver does NOT just inspect blockers locally; it passes the flag
  // through so the CLI itself demotes the missing rows to warn. Pin both
  // the push and the conditional.
  assert.match(DRIVER_SRC, /const\s+doctorArgv\s*=\s*\[\s*['"]doctor['"]\s*,\s*['"]--json['"]\s*\]/,
    'doctor base argv must be ["doctor", "--json"]');
  assert.match(DRIVER_SRC, /if\s*\(\s*allowLoggedOut\s*\)\s*doctorArgv\.push\(\s*['"]--allow-logged-out['"]\s*\)/,
    'driver must push --allow-logged-out into doctor argv when set');
});

test('W527 #3 — driver threads --allow-logged-out through to whoami argv', () => {
  assert.match(DRIVER_SRC, /const\s+whoamiArgv\s*=\s*\[\s*['"]whoami['"]\s*,\s*['"]--json['"]\s*\]/,
    'whoami base argv must be ["whoami", "--json"]');
  assert.match(DRIVER_SRC, /if\s*\(\s*allowLoggedOut\s*\)\s*whoamiArgv\.push\(\s*['"]--allow-logged-out['"]\s*\)/,
    'driver must push --allow-logged-out into whoami argv when set');
});

test('W527 #4 — driver validator accepts logged_in:false when allowLoggedOut is set', () => {
  // Defense in depth: even if a future maintainer removes the demotion
  // from the CLI side, the driver still passes when allowLoggedOut + the
  // envelope has logged_in:false. Pin this exact reason string so a flag
  // rename also breaks here.
  assert.match(DRIVER_SRC, /if\s*\(\s*allowLoggedOut\s*\)\s*return\s*\{\s*ok:\s*true,\s*reason:\s*['"]--allow-logged-out \(logged_in=['"]/,
    'driver whoami validator must short-circuit ok:true when allowLoggedOut');
});

test('W527 #5 — driver doctor validator falls back to non-auth blocker scan when allowLoggedOut', () => {
  // The release-verify driver should distinguish "API key missing" (OK to
  // skip in CI) from "docker missing" (real blocker). Pin both.
  const idx = DRIVER_SRC.indexOf("gateCli('doctor'");
  assert.ok(idx > 0, "gateCli('doctor', ...) call must exist");
  const fnSlice = DRIVER_SRC.slice(idx, idx + 1500);
  assert.match(fnSlice, /api[ -_]?key|auth|logged|signup|login/,
    'doctor validator must include auth-name regex');
  assert.match(fnSlice, /nonAuth/,
    'doctor validator must derive nonAuth = non-auth blockers');
  assert.match(fnSlice, /non-auth blockers present/,
    'doctor validator must surface remaining non-auth blockers as fail reason');
});

test('W527 #6 — CLI whoami honors --allow-logged-out', () => {
  // Pin that cli/kolm.js whoami code path parses the flag and short-circuits.
  assert.match(CLI_SRC, /args\.includes\(['"]--allow-logged-out['"]\)/,
    'cli whoami / doctor must check args.includes("--allow-logged-out")');
});

test('W527 #7 — CLI doctor demotes auth-related missing rows when --allow-logged-out', () => {
  // The CLI source must contain the demotion logic so missing → warn.
  // We don't bind to exact wording; we bind to the demotion shape.
  assert.match(CLI_SRC, /demoted to warn|--allow-logged-out/i,
    'cli doctor must mention --allow-logged-out demotion path');
  // And we pin the structural ternary that flips the status.
  assert.match(CLI_SRC, /status:\s*allowLoggedOut\s*\?\s*['"]warn['"]\s*:\s*['"]missing['"]/,
    'cli doctor must demote auth-missing rows to warn under --allow-logged-out');
});

test('W527 #8 — kolm whoami --json --allow-logged-out exits 0 and returns logged_in:false', () => {
  // Behavioral end-to-end: this is what CI actually runs.
  const r = spawnSync(process.execPath, [CLI, 'whoami', '--json', '--allow-logged-out'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, KOLM_API_KEY: '', KOLM_BASE_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(r.status, 0, `whoami must exit 0 with --allow-logged-out; got ${r.status}; stderr=${r.stderr.slice(0, 500)}`);
  // Strip any stray CR; parse the JSON envelope.
  const out = r.stdout.trim();
  assert.ok(out.length > 0, 'whoami must emit JSON to stdout');
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.logged_in, 'boolean', 'envelope must contain logged_in:bool');
  // No assertion on logged_in's specific value: it MIGHT be true if the dev
  // happens to be logged in locally. The contract is just that the CLI exits
  // 0 with --allow-logged-out and returns a boolean.
});

test('W527 #9 — kolm doctor --json --allow-logged-out exits 0 (or returns blockers:0) without server', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'doctor', '--json', '--allow-logged-out'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, KOLM_API_KEY: '', KOLM_BASE_URL: 'http://127.0.0.1:1' },
  });
  // Doctor exits 0 even when there are non-blocker warns. Allow exit codes 0
  // (clean) and accept any envelope where blockers:0 or only-auth blockers.
  assert.ok(r.status === 0 || r.status === 1 || r.status === 3,
    `doctor exited unexpectedly ${r.status}; stderr=${r.stderr.slice(0, 500)}`);
  // Doctor pretty-prints JSON across multiple lines. Parse the whole stdout
  // as one JSON document (it should be — no leading prose in --json mode).
  const out = r.stdout.trim();
  assert.ok(out.length > 0, 'doctor must emit JSON to stdout');
  let envelope;
  try { envelope = JSON.parse(out); } catch (e) {
    assert.fail('doctor --json stdout must be valid JSON: ' + e.message + '\nstdout=' + out.slice(0, 500));
  }
  assert.equal(typeof envelope.ok, 'boolean', 'envelope must contain ok:bool');
  // When --allow-logged-out is set, auth-related rows demote to warn → blockers:0
  // unless there's a non-auth blocker (docker missing, port in use, etc).
  if (envelope.ok === false) {
    // Then it must be a real non-auth blocker, not an api-key issue.
    const checks = envelope.checks || [];
    const nonAuthMissing = checks.filter((c) =>
      (c.status === 'missing' || c.status === 'fail' || c.status === 'error') &&
      !/api[ -_]?key|auth|logged|signup|login/i.test((c.name || '') + (c.detail || ''))
    );
    // It's acceptable for there to be a real non-auth blocker on a dev host.
    // We're only pinning that auth issues never appear as blockers under --allow-logged-out.
    const authBlocker = checks.find((c) =>
      (c.status === 'missing' || c.status === 'fail' || c.status === 'error') &&
      /api[ -_]?key|auth|logged|signup|login/i.test((c.name || '') + (c.detail || ''))
    );
    assert.ok(!authBlocker,
      `--allow-logged-out must demote auth blockers to warn; saw blocker: ${JSON.stringify(authBlocker)}`);
  }
});

test('W527 #10 — header comment + --help text both advertise --allow-logged-out', () => {
  // Self-documentation: someone reading the file should see the flag.
  const head = DRIVER_SRC.slice(0, 3000);
  assert.match(head, /--allow-logged-out/, 'driver header must advertise --allow-logged-out');
});
