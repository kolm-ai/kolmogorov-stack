// W888-I ship-gate check #51 — Gateway overhead in local measurement.
//
// Pin the wrapper-tax (everything kolm does ON TOP of the upstream provider
// round-trip) under 500ms mean locally.
//
// Methodology:
//   1. Boot a mock provider HTTP server that echoes a constant OpenAI-shaped
//      completion immediately. Latency floor for the upstream call ~= 0ms.
//   2. Boot the kolm server with that mock provider registered as the only
//      upstream for the default namespace.
//   3. POST 10 calls direct to the mock to establish a direct baseline.
//   4. POST 10 calls through /v1/gateway/dispatch (with kolm's wrapper-tax:
//      tier check + namespace select + PII scan + chain dispatch + PII scan +
//      receipt sign + capture write) to measure the wrapped latency.
//   5. Assert (gateway mean) - (direct mean) < 500ms.
//
// This is the LOCAL equivalent of the W887 prod benchmark (which measured
// 200-300ms wrapper tax against real Anthropic+OpenAI traffic). The local
// run uses a mock provider so the assert can be tight: nothing here should
// take >500ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
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

function startMockProvider(port) {
  const echoBody = JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-gpt-mini',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(echoBody) });
      res.end(echoBody);
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function p50(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function timedJsonFetch(url, options, label, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const t0 = Date.now();
    const r = await fetch(url, options);
    const body = await r.text();
    const elapsed = Date.now() - t0;
    try {
      JSON.parse(body);
      return elapsed;
    } catch (e) {
      lastError = `${label} attempt=${attempt} status=${r.status} invalid JSON: ${e.message}; body=${body.slice(0, 160)}`;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  assert.fail(lastError || `${label} did not return JSON`);
}

test('W888-I #51 — gateway overhead vs direct provider mock < 500ms mean (local)', async (t) => {
  const MOCK_PORT = await freePort();
  const KOLM_PORT = await freePort();
  const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  const KOLM_BASE = `http://127.0.0.1:${KOLM_PORT}`;

  const scratch = path.join(os.tmpdir(), `kolm-w888i-gwperf-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, 'data');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => rmSyncBestEffort(scratch));

  const tenantId = 't_w888i_gwperf';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId,
      name: 'w888i-gwperf',
      email: 'w888i-gwperf@example.com',
      plan: 'enterprise',
      quota: 50_000_000,
      seats: 1,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');
  const apiKey = 'ks_w888i_gwperf_smoke_key_dddddddddddddddddddddddddddddd';
  const crypto = await import('node:crypto');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    {
      id: 'apik_w888i_gwperf',
      tenant_id: tenantId,
      hash: keyHash,
      label: 'w888i-gwperf',
      kind: 'user',
      created_at: new Date().toISOString(),
      revoked_at: null,
    },
  ]), 'utf8');

  // Start mock provider.
  const mock = await startMockProvider(MOCK_PORT);
  t.after(() => new Promise((r) => mock.close(() => r())));

  // Start kolm server pointing OPENAI_BASE_URL at the mock so the gateway
  // chain dispatches to localhost instead of api.openai.com.
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(KOLM_PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      DEFAULT_TENANT: 'w888i-gwperf',
      // Route the OpenAI chain to the mock provider.
      OPENAI_BASE_URL: MOCK_BASE + '/v1',
      OPENAI_API_KEY: 'sk-test-mock-key',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => killAndWait(proc));

  await waitForHealth(KOLM_BASE);

  const N = 10;
  // Warm-up — the first request through the gateway dynamically imports a
  // handful of modules (gateway-router, pii-redactor, gateway-receipt,
  // provider-registry). Don't count that one in the budget.
  await fetch(KOLM_BASE + '/v1/gateway/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'warmup' }], model: 'gpt-4o-mini' }),
  });

  // Direct baseline.
  const directTimings = [];
  for (let i = 0; i < N; i++) {
    const elapsed = await timedJsonFetch(MOCK_BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello ' + i }], model: 'gpt-4o-mini' }),
    }, `direct ${i}`);
    directTimings.push(elapsed);
  }

  // Gateway-wrapped.
  const gwTimings = [];
  for (let i = 0; i < N; i++) {
    const elapsed = await timedJsonFetch(KOLM_BASE + '/v1/gateway/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello ' + i }], model: 'gpt-4o-mini' }),
    }, `gateway ${i}`);
    gwTimings.push(elapsed);
  }

  const directMean = mean(directTimings);
  const gwMean = mean(gwTimings);
  const overhead = gwMean - directMean;
  const report = {
    iterations: N,
    direct_mean_ms: Math.round(directMean),
    direct_p50_ms: Math.round(p50(directTimings)),
    gateway_mean_ms: Math.round(gwMean),
    gateway_p50_ms: Math.round(p50(gwTimings)),
    overhead_mean_ms: Math.round(overhead),
    budget_ms: 500,
  };
  process.stderr.write('[W888-I #51] ' + JSON.stringify(report) + '\n');
  assert.ok(overhead < 500,
    `gateway overhead ${Math.round(overhead)}ms (gw mean ${Math.round(gwMean)}ms - direct mean ${Math.round(directMean)}ms) exceeded 500ms budget`);
});
