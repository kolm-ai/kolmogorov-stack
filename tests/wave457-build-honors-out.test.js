// W457b — `kolm build` honors --out, surfaces EPERM cleanly, and warns
// when a curated baseline overrides an explicit --from template.
//
// Three P0 regressions the audit flagged on "build the product yourself":
//   1. --out filename was IGNORED on the curated-template path. The artifact
//      went to `<dir>/<job_id>.kolm` (e.g. `job_claims_redactor_v1.kolm`)
//      via a copy-rename in spec-compile.js, and that intermediate name
//      leaked into error messages.
//   2. EPERM/EBUSY opening a locked output crashed inside copyFileSync with
//      no actionable hint — the user saw a raw stack trace.
//   3. Curated baseline silently overrode the user's --from flag with only
//      a quiet `console.log` under [1/4]; no opt-out flag was advertised.
//
// Fixes:
//   - src/artifact.js#buildAndZip now accepts opts.outPath and writes the
//     .kolm directly there (with a pre-flight openSync probe that maps
//     EPERM/EACCES/EBUSY/EROFS to a clean, actionable error).
//   - src/spec-compile.js threads opts.outPath through to buildAndZip and
//     prints the resolved destination before the open probe.
//   - cli/kolm.js#cmdBuild prints the curated-override warning on stderr
//     with [kolm build] prefix and the --no-baseline opt-out flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const CURATED_SEEDS = path.join(ROOT, 'examples', 'claims-redactor', 'seeds.jsonl');

function freshDir(label) {
  const d = path.join(os.tmpdir(), `kolm-w457b-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runBuild(cwd, args) {
  const env = { ...process.env, KOLM_AUTO_YES: '1' };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  const r = spawnSync(process.execPath, [CLI, 'build', ...args], {
    cwd, env, encoding: 'utf8', timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('W457b #1 — `kolm build` with --out writes EXACTLY the requested path (no <job_id>.kolm intermediate)', () => {
  const cwd = freshDir('out-honored');
  const outPath = path.join(cwd, 'my-redactor.kolm');
  const r = runBuild(cwd, [
    'claims-redactor',
    '--from', 'redactor',
    '--examples', CURATED_SEEDS,
    '--out', outPath,
  ]);
  const tail = (r.stdout + '\n' + r.stderr).slice(-1500);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. tail:\n${tail}`);

  // Pin: artifact is at the requested path.
  assert.ok(fs.existsSync(outPath), `--out ${outPath} not honored; tail:\n${tail}`);
  assert.ok(fs.statSync(outPath).size > 1000, `artifact too small at ${outPath}`);

  // Pin: NO intermediate job_<job_id>.kolm in the output dir.
  const stray = path.join(cwd, 'job_claims_redactor_v1.kolm');
  assert.ok(!fs.existsSync(stray),
    `intermediate ${stray} should not exist post-build (pre-W457b this leaked)`);

  // Pin: build logged the resolved destination BEFORE writing.
  assert.ok(/\[kolm build\] writing artifact to:.*my-redactor\.kolm/.test(r.stderr + r.stdout),
    `expected pre-write destination banner; tail:\n${tail}`);
});

test('W457b #2 — `kolm build` against a locked output file emits a clean error and exits non-zero', () => {
  const cwd = freshDir('eperm-locked');
  const outPath = path.join(cwd, 'locked.kolm');
  // Pre-create the file, then mock the destination by replacing its
  // directory entry with a directory of the same name (Windows + POSIX
  // both refuse openSync('w') on a directory with EISDIR / EPERM).
  // This deterministically triggers the openSync probe failure path
  // without spawning a separate process to hold a Windows file lock
  // (which is awkward + flaky in CI).
  fs.mkdirSync(outPath, { recursive: true });
  // Sanity: outPath is a directory, so openSync('w') will throw.
  assert.ok(fs.statSync(outPath).isDirectory(), 'preflight: outPath should be a directory');

  const r = runBuild(cwd, [
    'claims-redactor',
    '--from', 'redactor',
    '--examples', CURATED_SEEDS,
    '--out', outPath,
  ]);
  const text = r.stdout + '\n' + r.stderr;

  // Pin: non-zero exit.
  assert.notEqual(r.code, 0, `expected non-zero exit, got ${r.code}. tail:\n${text.slice(-1500)}`);

  // Pin: the error names the resolved path AND a code (EPERM/EACCES/EBUSY/EISDIR).
  // The map covers Windows + POSIX behaviors when writing to a directory entry.
  const matchesCode = /\b(EPERM|EACCES|EBUSY|EROFS|EISDIR)\b/.test(text);
  assert.ok(matchesCode, `expected a permission/lock error code in output. tail:\n${text.slice(-1500)}`);
  assert.ok(text.includes(outPath) || text.includes(path.basename(outPath)),
    `error should name the locked path. tail:\n${text.slice(-1500)}`);

  // Pin: NO unhandled stack trace leaking node:fs internals (clean message,
  // not a thrown-from-libuv crash). The "ExperimentalWarning: WASI" line is
  // unrelated harness noise — exclude it from the check.
  const filtered = text.split('\n').filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n');
  assert.ok(!/at fs\.openSync \(node:fs:/.test(filtered) && !/at Object\.copyFileSync \(node:fs:/.test(filtered),
    `unhandled fs stack trace leaked; should be wrapped. tail:\n${filtered.slice(-1500)}`);
});

test('W457b #3 — curated-baseline override prints a stderr warning naming --no-baseline; --no-baseline honors --from', () => {
  // 3a — warning fires when the curated path overrides the user's --from.
  const cwdA = freshDir('curated-warn');
  const rA = runBuild(cwdA, [
    'claims-redactor',
    '--from', 'redactor',
    '--examples', CURATED_SEEDS,
    '--out', path.join(cwdA, 'a.kolm'),
  ]);
  const textA = rA.stdout + '\n' + rA.stderr;
  assert.ok(/\[kolm build\] WARNING:.*--from redactor.*overridden by curated baseline claims-redactor.*--no-baseline/.test(textA),
    `expected curated-override warning naming --no-baseline. tail:\n${textA.slice(-1500)}`);

  // 3b — --no-baseline opts out: the user's --from redactor wins. The build
  // doesn't have to succeed (generic redactor stub against curated rich
  // seeds may fail the K-gate); what we PIN is "no curated banner appeared".
  const cwdB = freshDir('no-baseline');
  const rB = runBuild(cwdB, [
    'claims-redactor',
    '--from', 'redactor',
    '--no-baseline',
    '--examples', CURATED_SEEDS,
    '--out', path.join(cwdB, 'b.kolm'),
  ]);
  const textB = rB.stdout + '\n' + rB.stderr;
  assert.ok(!/template: curated/.test(textB),
    `--no-baseline must NOT pick curated. tail:\n${textB.slice(-1500)}`);
  assert.ok(!/\[kolm build\] WARNING:.*overridden by curated baseline/.test(textB),
    `--no-baseline must NOT print the curated-override warning. tail:\n${textB.slice(-1500)}`);
  assert.ok(/template: redactor/.test(textB),
    `expected generic redactor template banner under --no-baseline. tail:\n${textB.slice(-1500)}`);
});
