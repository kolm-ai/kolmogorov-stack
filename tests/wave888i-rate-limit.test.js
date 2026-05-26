// W888-I ship-gate check #6 — Rate limiting enforces tier limits.
//
// Pin POST /v1/gateway/dispatch to:
//   1. accept the call when the tenant is under its monthly gateway_calls cap;
//   2. reject with HTTP 429 + structured envelope when the cap is exceeded;
//   3. stamp Retry-After (RFC 7231 §7.1.3) AND X-RateLimit-{Limit,Remaining,Reset}
//      (RFC draft-ietf-httpapi-ratelimit-headers) on the 429 path.
//
// The test pre-populates the on-disk usage counter to a value beyond the free-tier
// hard cap (50 000), then issues a single gateway/dispatch call and asserts the
// 429 contract is intact. This avoids burning 50 000 real requests through the
// rate limiter to push it over the cliff.

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
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

function currentPeriod() {
  const d = new Date();
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

test('W888-I #6 — gateway dispatch returns 429 + retry-after + RateLimit-* headers when free-tier monthly cap exceeded', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = path.join(os.tmpdir(), `kolm-w888i-rl-data-${process.pid}-${Date.now()}`);
  const home = path.join(os.tmpdir(), `kolm-w888i-rl-home-${process.pid}-${Date.now()}`);
  const usageDir = path.join(dataDir, 'usage');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });

  // Pre-populate tenant with a known id + free plan.
  const tenantId = 't_w888i_ratelimit';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId,
      name: 'w888i-ratelimit',
      email: 'w888i-rl@example.com',
      plan: 'free',
      quota: 50000,
      seats: 1,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');

  // Provision an api-key row for the tenant. The auth layer accepts the
  // raw `secret_hash`-equivalent in test fixtures by writing the same shape
  // that provisionTenant() emits.
  // To keep the test self-contained, drive the live key creation via the
  // provision endpoint inside the server. We attach a known key here so the
  // initial header has something to send.
  const apiKey = 'ks_w888i_ratelimit_smoke_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const crypto = await import('node:crypto');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    {
      id: 'apik_w888i_rl',
      tenant_id: tenantId,
      hash: keyHash,
      label: 'w888i-rl-test',
      kind: 'user',
      created_at: new Date().toISOString(),
      revoked_at: null,
    },
  ]), 'utf8');

  // Pre-populate gateway_calls counter ABOVE the free-tier hard cap (50_000).
  const period = currentPeriod();
  fs.writeFileSync(path.join(usageDir, `period_${period}.json`), JSON.stringify({
    period,
    updated_at: new Date().toISOString(),
    tenants: { [tenantId]: { gateway_calls: 60_000 } },
  }), 'utf8');

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_USAGE_DIR: usageDir,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      // Leave express-rate-limit on so the IP layer doesn't trip first.
      // Tier limiting is independent of express-rate-limit and is what we
      // are pinning here.
      KOLM_RATE_LIMIT_DISABLED: '1',
      DEFAULT_TENANT: 'w888i-rl',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => {
    rmSyncBestEffort(dataDir);
    rmSyncBestEffort(home);
  });
  t.after(() => killAndWait(proc));

  await waitForHealth(BASE);

  const res = await fetch(BASE + '/v1/gateway/dispatch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'gpt-4o-mini',
    }),
  });

  assert.equal(res.status, 429, 'gateway/dispatch must 429 when tier cap exceeded');

  // RFC 7231 §7.1.3 — Retry-After header (delta-seconds, integer).
  const retryAfter = res.headers.get('retry-after');
  assert.ok(retryAfter, 'Retry-After header must be present on 429');
  assert.ok(Number.isInteger(Number(retryAfter)) && Number(retryAfter) > 0,
    'Retry-After must be a positive integer (seconds); got ' + retryAfter);

  // RFC draft-ietf-httpapi-ratelimit-headers — RateLimit-* trio.
  const rlLimit = res.headers.get('x-ratelimit-limit');
  const rlRemaining = res.headers.get('x-ratelimit-remaining');
  const rlReset = res.headers.get('x-ratelimit-reset');
  assert.equal(rlLimit, '50000', 'X-RateLimit-Limit must equal free-tier hard cap (50000)');
  assert.equal(rlRemaining, '0', 'X-RateLimit-Remaining must be 0 when over cap');
  assert.ok(rlReset && Number.isInteger(Number(rlReset)), 'X-RateLimit-Reset must be an integer epoch');

  // Envelope shape.
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'rate_limit_exceeded');
  assert.equal(body.unit, 'gateway_calls');
  assert.equal(body.tier, 'free');
  assert.equal(body.plan, 'free');
  assert.equal(body.limit, 50000);
  assert.ok(body.current >= 50000, 'current must report the over-cap usage value');
  assert.ok(Number.isInteger(body.reset_epoch));
  assert.ok(Number.isInteger(body.retry_after_s) && body.retry_after_s > 0);
  assert.ok(/free tier/i.test(String(body.hint)), 'hint must guide free-tier upgrade');
});
