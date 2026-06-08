// Agent Security-Review — public verify route rate-limit (spawned server).
//
// The PUBLIC POST /v1/audit/report/verify route is pure compute, but pure
// compute is still a CPU sink an unauthenticated caller can hammer. audit-
// routes.js wires a self-contained per-IP fixed-window limiter (120/min) that
// honors KOLM_RATE_LIMIT_DISABLED=1. This test boots a server with the limiter
// ACTIVE (that env var deliberately UNSET) and proves the cap fires with the
// limiter's own 429 body shape — no other limiter touches this route, so the
// 429 is unambiguously ours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: boot poll
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

let serverProc = null;
let base = null;
let scratchDir = null;

test('setup — boot server with the verify limiter ACTIVE', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-verify-rl-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      // KOLM_RATE_LIMIT_DISABLED deliberately NOT set → limiter is live.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

test('public verify route returns 429 after the per-IP cap (120/min)', async () => {
  // The limiter check runs BEFORE body validation, so an empty body is fine: a
  // pre-cap request hits the handler and returns 400 report_required; once the
  // window cap is exceeded the route short-circuits with 429.
  let got429 = false;
  let servedBeforeCap = 0;
  let cap429Body = null;
  for (let i = 0; i < 140; i++) {
    const r = await fetch(`${base}/v1/audit/report/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (r.status === 429) {
      got429 = true;
      cap429Body = await r.json().catch(() => ({}));
      break;
    }
    assert.equal(r.status, 400, 'pre-cap requests reach the handler (400 report_required), not 429');
    await r.json().catch(() => {});
    servedBeforeCap += 1;
  }
  assert.ok(servedBeforeCap >= 100, `early requests are served, not rate-limited (served ${servedBeforeCap} before the cap)`);
  assert.ok(got429, 'the limiter eventually returns 429');
  assert.equal(cap429Body.ok, false, '429 body is a well-formed error envelope');
  assert.equal(cap429Body.error, 'rate_limited', 'the 429 is this route\'s own limiter');
  assert.equal(cap429Body.contact, 'dev@kolm.ai', 'points the caller at the only contact address');
});

test('teardown', async () => {
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
});
