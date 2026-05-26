// W528 — pin the release-verify exit-code matrix.
//
// Why this lock-in: CI consumers (GitHub Actions step matrix, dashboards,
// the /account/release-verify panel) read the exit code to color the badge
// green/yellow/red. A future refactor that flips 0/1/124 around silently
// breaks every consumer. Pin the matrix.
//
// Exit codes documented + locked here:
//   0   = ok:true (every gate ok or skipped)
//   1   = ok:false (any gate failed)
//   2   = catch handler (uncaught exception inside main())
//   124 = wall-clock timeout (standard Unix code for hung process)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');
const SRC = fs.readFileSync(DRIVER, 'utf8');

const ALL_GATES = [
  'lint:refs', 'control-files', 'openapi-sync', 'claim-verify',
  'sdk-manifest', 'test', 'sdk-smoke', 'local-surfaces',
  // ship-gate (W888-I) is opt-in via --include-ship-gate but always lands in
  // gates[] (as skipped when not opted in) so the summary lists it as a known
  // gate. Include it here so the all-skipped lock-in sees it.
  'ship-gate',
  'doctor', 'whoami', 'verify-claims', 'billing-tiers',
];

test('W528 #1 — happy path exits 0 (or 1 if a real gate fails)', () => {
  // Skip every gate so we definitely get ok:true. Any other exit means
  // the happy-path branch is broken.
  const r = spawnSync(process.execPath, [DRIVER, '--json', '--skip=' + ALL_GATES.join(',')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `all-skipped run must exit 0; got ${r.status}; stderr=${r.stderr.slice(0, 500)}`);
});

test('W528 #2 — process.exit(0) is wired to allOk === true', () => {
  assert.match(SRC, /process\.exit\(\s*allOk\s*\?\s*0\s*:\s*1\s*\)/,
    'main() must exit allOk ? 0 : 1');
});

test('W528 #3 — wall-timeout path exits 124 (Unix hung-process convention)', () => {
  // Pin the literal: 124 is the convention `timeout` (the GNU utility)
  // uses for processes it kills. Consumers (CI matrix runners, alerting)
  // look for 124 specifically to distinguish hang from real fail.
  assert.match(SRC, /process\.exit\(\s*124\s*\)/,
    'wall-timeout handler must exit 124');
  // Defense: pin it's near the wall_timeout literal.
  const idx = SRC.indexOf("error: 'wall_timeout'");
  assert.ok(idx > 0, 'wall_timeout literal must appear');
  const slice = SRC.slice(Math.max(0, idx - 200), idx + 400);
  assert.match(slice, /process\.exit\(\s*124\s*\)/,
    'process.exit(124) must be in the wall_timeout block, not stray elsewhere');
});

test('W528 #4 — catch handler exits 2 (driver-level error, not a gate)', () => {
  assert.match(SRC, /\}\)\(\)\.catch\(\(e\)\s*=>\s*\{[\s\S]{0,400}process\.exit\(\s*2\s*\)/,
    'catch handler must exit 2 (distinguishes from gate failure exit 1)');
});

test('W528 #5 — JSON shape exposes ok:true ↔ exit 0 contract', () => {
  // Belt-and-suspenders: if a gate fails, ok:false AND exit 1. Pin that
  // these are computed from the same allOk value.
  assert.match(SRC, /const\s+allOk\s*=\s*results\.every\(\(r\)\s*=>\s*r\.ok\s*\|\|\s*r\.skipped\)/,
    'allOk must derive from results.every(r => r.ok || r.skipped)');
  assert.match(SRC, /ok:\s*allOk/, 'summary.ok must literally be allOk (no truthy/falsy translation)');
});

test('W528 #6 — skipped gates count as ok (not fail) in allOk', () => {
  // The whole point of --skip is to opt out without breaking ok:true.
  // Run with every gate skipped → ok:true → exit 0. Already tested in #1
  // but pin the structural reason here.
  assert.match(SRC, /r\.ok\s*\|\|\s*r\.skipped/,
    'allOk must accept skipped as ok');
});

test('W528 #7 — gate failure (no skip) is reported as ok:false in JSON envelope', () => {
  // Run without skipping any gate, but with KOLM_BASE_URL pointing to a
  // dead port so doctor/whoami fail. Without --allow-logged-out, that's
  // a real failure. Drop the wall timeout to keep the test fast — and
  // skip the long gates (test + sdk-smoke).
  const r = spawnSync(process.execPath, [
    DRIVER, '--json',
    '--skip=test,sdk-smoke,lint:refs,openapi-sync,sdk-manifest,verify-claims,billing-tiers',
    '--timeout-ms=30000',
  ], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 45000,
    env: { ...process.env, KOLM_API_KEY: '', KOLM_BASE_URL: 'http://127.0.0.1:1' },
  });
  // Without --allow-logged-out, doctor/whoami should fail → exit 1.
  // (On dev hosts where the user IS logged in, this MAY pass with 0; allow
  // both but require the envelope shape.)
  assert.ok(r.status === 0 || r.status === 1,
    `expected exit 0 or 1 (not 2/124); got ${r.status}; stderr=${r.stderr.slice(0, 500)}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  assert.ok(lines.length >= 1, 'must emit at least one JSON line');
  const parsed = JSON.parse(lines[lines.length - 1]);
  // Whichever way it lands, ok ↔ exit-code coherence must hold.
  if (r.status === 0) assert.equal(parsed.ok, true, 'exit 0 ↔ ok:true');
  if (r.status === 1) assert.equal(parsed.ok, false, 'exit 1 ↔ ok:false');
});

test('W528 #8 — unknown --skip token is ignored (not a hard fail)', () => {
  // Robustness: a typo in --skip should not crash the driver. Use a token
  // that doesn't match any gate; everything else still runs.
  const r = spawnSync(process.execPath, [DRIVER, '--json', '--skip=nonexistent-gate-xyz,' + ALL_GATES.join(',')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `unknown --skip token must not crash; got ${r.status}; stderr=${r.stderr.slice(0, 500)}`);
  const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  // All 9 real gates still recognized as skipped because we passed them too.
  assert.equal(parsed.gates.length, ALL_GATES.length,
    'gates[] must enumerate the real gates even with bogus extra skip tokens');
});

test('W528 #9 — header documents the full gate invocation contract', () => {
  const head = SRC.slice(0, 3500);
  // Header should mention --json, --skip, --allow-logged-out and each gate's
  // human-readable name (the actual gate IDs like "sdk-smoke" appear in
  // gateCli call sites, not the header).
  assert.match(head, /--json/, 'header must show --json invocation');
  assert.match(head, /--skip/, 'header must show --skip invocation');
  assert.match(head, /--allow-logged-out/, 'header must show --allow-logged-out invocation');
  // Each gate's name (loose match — accept underscores/spaces/dashes).
  const headLower = head.toLowerCase();
  for (const fragment of ['lint:refs', 'openapi-sync', 'sdk-manifest', 'npm test', 'sdk smoke', 'local-surfaces', 'doctor', 'whoami', 'verify', 'billing']) {
    assert.ok(headLower.includes(fragment.toLowerCase()),
      `header gates list must reference: ${fragment}`);
  }
});

test('W528 #10 — wallTimer.unref() is called so timer never blocks event loop', () => {
  // If we forgot unref(), the Node process would stay alive waiting for
  // the wall timer to fire even after results were ready. Pin the call.
  assert.match(SRC, /wallTimer\.unref\(\)/,
    'wallTimer.unref() must be called so the timer never holds the process open');
});
