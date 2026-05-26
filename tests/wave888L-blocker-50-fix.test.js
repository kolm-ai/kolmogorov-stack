// W888-L blocker #50 — /v1/captures/list works under shared-server context.
//
// In the ship-gate shared-server boot the api-key row is provisioned via the
// api_keys.json fixture (rows shaped { tenant_id, hash }). Pre-W888-L the
// auth layer only consulted tenants.api_key_hash, so /v1/captures/list 401'd
// even though the shared boot's Authorization header was correct.
//
// The fix lives in src/auth.js (findTenantByApiKey now falls back to the
// api_keys table). This regression pins the join shape end-to-end through
// /v1/captures/list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
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

test('W888-L #50 — /v1/captures/list 200s with api_keys.json-style fixture', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const scratch = path.join(os.tmpdir(), `kolm-w888L-b50-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const tenantId = 't_w888L_b50';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: tenantId, name: 'w888L-b50', plan: 'enterprise', quota: 1000000, created_at: new Date().toISOString() },
  ]), 'utf8');

  const apiKey = 'ks_w888L_b50_smoke_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_w888L_b50', tenant_id: tenantId, hash, kind: 'user', revoked_at: null, created_at: new Date().toISOString() },
  ]), 'utf8');

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: scratch,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => rmSyncBestEffort(scratch));
  t.after(() => killAndWait(proc));

  await waitForHealth(BASE);
  const r = await fetch(BASE + '/v1/captures/list?limit=10', {
    headers: { authorization: 'Bearer ' + apiKey },
  });
  assert.equal(r.status, 200, 'captures/list must accept api_keys.json-style auth');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.total, 'number');
  assert.ok(Array.isArray(j.captures));
});
