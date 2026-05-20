// W481 P0-8 lock-in: `kolm doctor --allow-logged-out` and
// `kolm whoami --allow-logged-out` must exit 0 even when no api-key is wired
// or the server rejected the key. This unblocks release-verify, CI runs, and
// first-time evaluators (no signup yet) without compromising the normal
// "blocker" semantics when the flag is absent.
//
// Three lock-ins:
//   1) doctor --allow-logged-out + KOLM_API_KEY unset → exit 0, blockers:0,
//      api key (server) row downgraded to status:'warn' (not 'missing').
//   2) whoami --allow-logged-out + KOLM_API_KEY unset (config_has_key:false)
//      → exit 0, logged_in:false honestly surfaced.
//   3) Sanity: with neither flag and no key, both verbs MUST exit non-zero
//      (we are not allowed to silently make logged-out states "ok" without
//      the explicit flag).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const REPO = path.resolve(import.meta.dirname, '..');
const KOLM_CLI = path.join(REPO, 'cli', 'kolm.js');

// Isolate HOME so we don't accidentally inherit a logged-in config from the
// dev workstation running these tests.
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w481-'));
  return dir;
}

function runCli(argv, extraEnv = {}) {
  const home = freshHome();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KOLM_API_KEY: '',
    ...extraEnv,
  };
  // Strip any inherited base override that would surface the dev user's key.
  delete env.RECIPE_API_KEY;
  const r = spawnSync(process.execPath, [KOLM_CLI, ...argv], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('W481 #1 — doctor --allow-logged-out exits 0 with no api key', async () => {
  const r = runCli(['doctor', '--json', '--allow-logged-out']);
  assert.equal(r.status, 0, `doctor must exit 0 with --allow-logged-out (got ${r.status}): ${r.stderr.slice(0, 200)}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true, 'doctor must report ok:true');
  assert.equal(parsed.blockers, 0, `doctor must have 0 blockers (got ${parsed.blockers})`);
  const apiServer = (parsed.checks || []).find((c) => c.name === 'api key (server)');
  assert.ok(apiServer, 'api key (server) check must be present');
  assert.equal(apiServer.status, 'warn', `api key (server) must be 'warn' under --allow-logged-out (got '${apiServer.status}')`);
  // The detail string must MENTION --allow-logged-out so an operator reading
  // the doctor output knows why the row is yellow not red.
  assert.match(apiServer.detail, /allow-logged-out/, 'detail should call out the demotion');
});

test('W481 #2 — whoami --allow-logged-out exits 0 with no api key', async () => {
  const r = runCli(['whoami', '--json', '--allow-logged-out']);
  assert.equal(r.status, 0, `whoami must exit 0 with --allow-logged-out (got ${r.status}): ${r.stderr.slice(0, 200)}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.logged_in, false, 'logged_in must be honestly false');
  assert.equal(parsed.config_has_key, false, 'config_has_key must be false');
});

test('W481 #3 — without --allow-logged-out, doctor + whoami still exit non-zero', async () => {
  const d = runCli(['doctor', '--json']);
  assert.notEqual(d.status, 0, `doctor without flag must exit non-zero (got ${d.status})`);
  const w = runCli(['whoami', '--json']);
  assert.notEqual(w.status, 0, `whoami without flag must exit non-zero (got ${w.status})`);
});
