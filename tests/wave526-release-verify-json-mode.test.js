// W526 — pin the --json mode contract of scripts/release-verify.cjs.
//
// Why this lock-in: CI consumers (GitHub Actions matrix jobs, downstream
// dashboards, the /account/release-verify panel) parse the stdout of
// `release-verify --json` line-by-line and expect exactly one JSON object on
// stdout with a known shape. If a future refactor lets a stray console.log
// leak through, the consumer sees `Unexpected token...` and the gate
// silently fails-open. Pin the contract so a refactor breaks here first.
//
// Two layers:
//   1. Structural source-text pins (cheap, run in <100ms).
//   2. One actual run of `release-verify --json --skip=<all gates>` with the
//      stdout asserted as a single parseable JSON line that matches the
//      documented shape. This is the only way to catch a regression where
//      a new gate forgets to wrap log()/console.log().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');
const SRC = fs.readFileSync(DRIVER, 'utf8');

test('W526 #1 — --json flag is parsed into jsonMode', () => {
  assert.match(SRC, /const\s+jsonMode\s*=\s*args\.includes\(['"]--json['"]\)/,
    'jsonMode must be derived from args.includes("--json")');
});

test('W526 #2 — log() is a no-op when jsonMode is true', () => {
  // The whole point of --json is that consumers can parse the single line.
  // If log() ever writes to stdout in jsonMode the consumer breaks.
  assert.match(SRC, /function\s+log\([^)]*\)\s*\{\s*if\s*\(\s*!jsonMode\s*\)\s*console\.log/,
    'log() must guard on !jsonMode before writing to stdout');
});

test('W526 #3 — progress() routes to stderr in jsonMode', () => {
  // Progress is a UX signal, not a result. It must go to stderr so
  // consumers can ignore it. KOLM_RELEASE_VERIFY_VERBOSE=1 is the escape
  // hatch for human debugging.
  assert.match(SRC, /function\s+progress\([^)]*\)\s*\{[\s\S]{0,200}process\.stderr\.write/,
    'progress() must write to stderr, never stdout');
  assert.match(SRC, /KOLM_RELEASE_VERIFY_VERBOSE/,
    'progress() must respect KOLM_RELEASE_VERIFY_VERBOSE override');
});

test('W526 #4 — summary JSON shape includes ok, duration_ms, gates, allow_logged_out', () => {
  // The contract documented in the header comment + the /account/release-verify
  // dashboard depend on these keys. A renamed field silently breaks the panel.
  // Note: there's a per-shard "const summary = {" inside gateTests; we want
  // the final top-level summary in main(). Anchor on "const summary = { ok: allOk".
  const idx = SRC.indexOf('const summary = { ok: allOk');
  assert.ok(idx > 0, 'top-level summary { ok: allOk, ... } must be declared in main()');
  const fnSlice = SRC.slice(idx, idx + 400);
  for (const key of ['ok', 'duration_ms', 'gates', 'allow_logged_out']) {
    assert.match(fnSlice, new RegExp(`\\b${key}\\b`),
      `summary object must include ${key}`);
  }
});

test('W526 #5 — happy-path summary writes exactly one JSON.stringify line to stdout', () => {
  // Defense against a future maintainer who logs the summary as pretty JSON
  // (multi-line) — consumers split on \n and the first JSON.parse fails.
  assert.match(SRC, /if\s*\(\s*jsonMode\s*\)\s*\{\s*process\.stdout\.write\(\s*JSON\.stringify\(\s*summary\s*\)\s*\+\s*['"]\\n['"]/,
    'happy-path must write exactly JSON.stringify(summary) + "\\n" — never pretty-printed');
});

test('W526 #6 — wall-timeout path also emits valid JSON before process.exit(124)', () => {
  // A timed-out run is still a result. CI should see the partial gates[] +
  // ok:false rather than just exit code 124 with no body.
  const idx = SRC.indexOf("error: 'wall_timeout'");
  assert.ok(idx > 0, "wall_timeout literal must appear");
  const fnSlice = SRC.slice(Math.max(0, idx - 200), idx + 400);
  assert.match(fnSlice, /process\.stdout\.write\(\s*JSON\.stringify\(partial\)/,
    'wall-timeout handler must write partial JSON to stdout before exit');
  assert.match(fnSlice, /process\.exit\(124\)/,
    'wall-timeout must exit with code 124 (standard for hung process)');
});

test('W526 #7 — catch handler emits JSON envelope before process.exit(2)', () => {
  assert.match(SRC, /\}\)\(\)\.catch\(\(e\)\s*=>\s*\{[\s\S]{0,400}process\.stdout\.write\(\s*JSON\.stringify\(\s*\{\s*ok:\s*false/,
    'catch handler must emit ok:false envelope with error + gates');
  assert.match(SRC, /process\.exit\(2\)/, 'catch handler must exit with code 2');
});

test('W526 #8 — running with --skip on every gate yields one parseable JSON line', () => {
  // Behavioral integration test: with every gate skipped this finishes in
  // under a second and exercises the actual stdout serialization path. If
  // ANY gate leaks a console.log through, the JSON.parse below throws.
  const allGates = [
    'lint:refs', 'control-files', 'openapi-sync', 'claim-verify', 'demo-claims',
    'sdk-manifest', 'test', 'sdk-smoke', 'local-surfaces',
    'ship-gate', 'doctor', 'whoami', 'verify-claims', 'billing-tiers',
  ];
  const r = spawnSync(process.execPath, [DRIVER, '--json', '--skip=' + allGates.join(',')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `expected exit 0 (all gates skipped → ok:true); stderr=${r.stderr.slice(0, 500)}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, `expected exactly one stdout line; got ${lines.length}: ${r.stdout.slice(0, 500)}`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, true, 'ok:true when every gate skipped');
  assert.ok(typeof parsed.duration_ms === 'number', 'duration_ms must be a number');
  assert.ok(Array.isArray(parsed.gates), 'gates must be an array');
  assert.equal(parsed.gates.length, allGates.length, 'gates[] length must equal advertised gate count');
  for (const g of parsed.gates) {
    assert.equal(g.skipped, true, `gate ${g.gate} must report skipped:true when --skip names it`);
    assert.equal(g.ok, true, `skipped gate ${g.gate} reports ok:true (skip is not a failure)`);
  }
  const gateNames = parsed.gates.map((g) => g.gate).sort();
  assert.deepEqual(gateNames, [...allGates].sort(), 'gates[] must enumerate all advertised gates by name');
});

test('W526 #9 — --json mode does not leak progress() to stdout', () => {
  // Direct test of the stderr/stdout split: even when progress fires (which
  // it will on a real gate path), it must never land on stdout.
  // We force one cheap gate (sdk-manifest) to actually run; the others are
  // skipped. The structural gate reads sdk-current.json + the blob — fast.
  const skipAllButManifest = ['lint:refs', 'openapi-sync', 'test', 'sdk-smoke', 'doctor', 'whoami', 'verify-claims', 'billing-tiers'];
  const r = spawnSync(process.execPath, [DRIVER, '--json', '--skip=' + skipAllButManifest.join(',')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
  // Acceptable exits: 0 (ok) or 1 (gate failure — possible if asset drifted).
  assert.ok(r.status === 0 || r.status === 1, `release-verify exited ${r.status}; stderr=${r.stderr.slice(0, 500)}`);
  // stdout must still be exactly one line and parseable.
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, `stdout must remain single-line in --json; got ${lines.length}: ${r.stdout.slice(0, 500)}`);
  const parsed = JSON.parse(lines[0]);
  assert.ok(Array.isArray(parsed.gates), 'gates[] must remain present even when only one gate ran');
});

test('W526 #10 — header comment documents the --json contract', () => {
  // Self-documenting requirement: future maintainers should see the contract
  // at the top of the file before they refactor and break a downstream
  // consumer.
  const head = SRC.slice(0, 2500);
  assert.match(head, /--json/, 'header must mention --json');
  assert.match(head, /machine-readable|single|stdout/i, 'header must explain --json semantics');
});
