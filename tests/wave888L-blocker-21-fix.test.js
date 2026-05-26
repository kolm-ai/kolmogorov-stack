// W888-L blocker #21 — `/health` envelope must carry ok:true.
//
// The ship-gate run-surface liveness check (#21) asserts that
// `GET /health` returns `{ ok: true, uptime_s: <number>, version: <string> }`.
// Pre-W888-L the route returned `{ status: 'ok', uptime_s, version, ... }`
// with no top-level `ok` boolean, so `r.json.ok` was undefined and the
// ship-gate row failed.

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
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

test('W888-L #21 — GET /health returns ok:true alongside legacy status:ok', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const scratch = path.join(os.tmpdir(), `kolm-w888L-b21-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: scratch,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => rmSyncBestEffort(scratch));
  t.after(() => killAndWait(proc));

  await waitForHealth(BASE);
  const r = await fetch(BASE + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true, '/health body must carry ok:true');
  assert.equal(j.status, 'ok', '/health must still carry legacy status:ok for older readers');
  assert.equal(typeof j.uptime_s, 'number', 'uptime_s must be a number');
  assert.equal(typeof j.version, 'string', 'version must be a string');
});
