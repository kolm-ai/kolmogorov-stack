// W470 P0-4 lock-in: auth/key recovery UX.
//
// Auditor flagged the contradiction: `kolm doctor` reports ok:true while
// `kolm whoami` reports the server rejected the key. Mandate:
//
//   1. Detect invalid key. Don't surface stale local auth as healthy.
//   2. Present actionable recovery: kolm login / kolm signup / kolm logout.
//   3. doctor --json must exit with EXIT.MISSING_PREREQ (3) on rejected key.
//
// We exercise BEHAVIOR (exit code + json envelope + recovery copy), not page
// copy. Two scenarios:
//   - Config holds a key, server rejects it (rotated/revoked case)
//   - No key on disk (fresh machine case)
//
// Both must surface a "missing" check, raise blockers >= 1, drive ok:false,
// and exit 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w470-p04-'));
}

async function spinRejectingCloud() {
  const app = express();
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/v1/account', (_req, res) => res.status(401).json({ error: 'invalid_api_key' }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: 'http://127.0.0.1:' + port });
    });
  });
}

// Async spawn (NOT spawnSync) — spawnSync blocks the parent event loop, which
// deadlocks against the in-process express server the child needs to talk to.
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [KOLM_CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 60_000);
    child.on('error', reject);
    child.on('exit', (status) => {
      clearTimeout(t);
      let body = null;
      try { body = JSON.parse(out); } catch (_) {}
      resolve({ status, stdout: out, stderr: err, body });
    });
  });
}

test('W470 P0-4 #1 — doctor --json with config-holding rejected-by-server key returns ok:false + exit 3', async () => {
  const HOME = mkHome();
  const { server, base } = await spinRejectingCloud();
  try {
    fs.mkdirSync(path.join(HOME, '.kolm'), { recursive: true });
    fs.writeFileSync(
      path.join(HOME, '.kolm', 'config.json'),
      JSON.stringify({ api_key: 'ks_stale_rotated_for_test_only', base }, null, 2),
    );
    const r = await runCli(['doctor', '--json'], { HOME, USERPROFILE: HOME, KOLM_BASE: base });
    assert.equal(r.status, 3,
      'doctor must exit 3 (EXIT.MISSING_PREREQ); got ' + r.status +
      '\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr);
    assert.ok(r.body, 'doctor --json must emit parseable JSON');
    assert.equal(r.body.ok, false, 'ok must be false on rejected-server-key');
    assert.ok(r.body.blockers >= 1, 'blockers >= 1; got ' + r.body.blockers);
    const apiSrv = r.body.checks.find((c) => c.name === 'api key (server)');
    assert.ok(apiSrv, 'must have an "api key (server)" check');
    assert.equal(apiSrv.status, 'missing', 'api key (server) must be missing on 401; got ' + apiSrv.status + ' / ' + apiSrv.detail);
    // Recovery copy MUST list all three exits.
    assert.match(apiSrv.detail, /kolm login/, 'detail must mention `kolm login` as recovery');
    assert.match(apiSrv.detail, /kolm signup/, 'detail must mention `kolm signup` as recovery');
    assert.match(apiSrv.detail, /kolm logout/, 'detail must mention `kolm logout` as recovery');
  } finally {
    await new Promise((r) => server.close(() => r()));
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W470 P0-4 #2 — doctor --json with no api_key on disk returns ok:false + exit 3 + signup hint', async () => {
  const HOME = mkHome();
  try {
    // Fresh machine: no config file at all. Doctor must point at signup as
    // the first-time-user path AND login as the existing-user path.
    const r = await runCli(['doctor', '--json'], { HOME, USERPROFILE: HOME, KOLM_API_KEY: '' });
    assert.equal(r.status, 3,
      'doctor must exit 3 on no-api-key; got ' + r.status +
      '\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr);
    assert.ok(r.body, 'doctor --json must emit JSON');
    assert.equal(r.body.ok, false);
    assert.ok(r.body.blockers >= 1);
    const apiSrv = r.body.checks.find((c) => c.name === 'api key (server)');
    assert.ok(apiSrv);
    assert.equal(apiSrv.status, 'missing', 'no-key must be `missing`, not `warn`; got ' + apiSrv.status + ' / ' + apiSrv.detail);
    assert.match(apiSrv.detail, /kolm signup/, 'first-time path must mention `kolm signup`');
    assert.match(apiSrv.detail, /kolm login/, 'existing-user path must mention `kolm login`');
  } finally {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W470 P0-4 #3 — whoami --json reports logged_in:false + actionable hint on rejected key', async () => {
  const HOME = mkHome();
  const { server, base } = await spinRejectingCloud();
  try {
    fs.mkdirSync(path.join(HOME, '.kolm'), { recursive: true });
    fs.writeFileSync(
      path.join(HOME, '.kolm', 'config.json'),
      JSON.stringify({ api_key: 'ks_rotated_for_w470_test', base }, null, 2),
    );
    const r = await runCli(['whoami', '--json'], { HOME, USERPROFILE: HOME, KOLM_BASE: base });
    assert.ok(r.body, 'whoami --json must emit parseable JSON; got:\n' + r.stdout);
    assert.equal(r.body.logged_in, false, 'logged_in must be false on rejected key');
    assert.equal(r.body.config_has_key, true, 'config_has_key must be true (key is on disk)');
    assert.equal(r.body.server_validated, false, 'server_validated must be false on 401');
    assert.match(String(r.body.hint || ''), /kolm login/, 'hint must include `kolm login`');
  } finally {
    await new Promise((r) => server.close(() => r()));
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});
