// W484 P0-3 — `kolm update` must refuse to run from a repo checkout (without
// --force). Audit flagged: a dev cloning the repo and running `kolm update`
// silently triggers `npm i -g github:sneaky-hippo/kolmogorov-stack`, which
// clobbers their global install with whatever main is at right now. The fix
// detects the checkout (sibling .git + matching package.json name) and routes
// the user to `git pull` instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: REPO,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('W484 #1 — kolm update from a repo checkout refuses without --force (exits non-zero)', () => {
  const r = runCli(['update']);
  assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}`);
  // Combined output should mention the refusal reason.
  const out = (r.stdout + '\n' + r.stderr).toLowerCase();
  assert.ok(/non-mutating|refused|repo[_\s-]checkout/.test(out),
    'output must signal refusal: ' + out.slice(0, 300));
});

test('W484 #2 — kolm update --json from a repo checkout returns refusal envelope (non-zero exit)', () => {
  const r = runCli(['update', '--json']);
  assert.notEqual(r.status, 0, `expected non-zero exit (JSON), got ${r.status}`);
  // Find first {...} block in stdout
  const m = r.stdout.match(/\{[\s\S]*?\}/);
  assert.ok(m, 'json envelope must appear in stdout: ' + r.stdout.slice(0, 300));
  const env = JSON.parse(m[0]);
  assert.equal(env.ok, false, 'envelope must set ok=false');
  assert.equal(env.status, 'refused', 'envelope status must be "refused"');
  assert.equal(env.reason, 'repo_checkout');
  assert.ok(Array.isArray(env.remedy) && env.remedy.length >= 1, 'remedy must be a non-empty array');
});

test('W484 #3 — kolm update --force --dry-run from a repo checkout bypasses the guard (exit 0, no mutate)', () => {
  const r = runCli(['update', '--force', '--dry-run']);
  assert.equal(r.status, 0, `expected exit 0 with --force --dry-run, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.ok(out.includes('would run:'),
    '--force --dry-run must print the would-run plan (non-mutating): ' + out.slice(0, 200));
  assert.ok(!out.includes('refused'), 'should not be refused with --force');
});

test('W484 #4 — guard source uses package.json name === kolmogorov-stack heuristic', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  // Make sure the guard pattern is wired and the right package-name check is present.
  assert.ok(/kolmogorov-stack/.test(src), 'guard must compare against package name kolmogorov-stack');
  assert.ok(/repo_checkout/.test(src), 'guard must surface reason=repo_checkout');
});
