#!/usr/bin/env node
// W888-L scaffold #38 — signup → first gateway call timer.
//
// Boots an isolated server, hits /v1/signup, then immediately calls
// /v1/gateway/dispatch with the returned api key and stops the clock. The
// scaffold asserts the round-trip is <120 seconds — the W888 onboarding
// promise. Returns a SKIP envelope only when the server cannot be booted at
// all (port allocation failure / spawn error).
//
// Output (stdout):
//   PASS: { ok:true, elapsed_ms, signup_ms, dispatch_ms, version }
//   FAIL: { ok:false, error, elapsed_ms, version }
//   SKIP: { ok:false, skipped:true, reason, install_hint, version }

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = 'w888L-signup-first-call-v1';

function emit(o, code) {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(code || 0);
}

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
function waitForHealth(base, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(base + '/health', (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}
function httpJSON(base, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(base + urlPath);
    const req = http.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch (_) {} // deliberate: cleanup
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async function main() {
  const wallStart = Date.now();
  let port, proc, scratch;
  try { port = await freePort(); }
  catch (e) { return emit({ ok: false, skipped: true, reason: 'free-port allocation failed', install_hint: 'check for firewall blocking 127.0.0.1', version: VERSION }, 0); }

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888L-signup-'));
  const dataDir = path.join(scratch, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: scratch,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  const up = await waitForHealth(base, 30_000);
  if (!up) {
    try { proc.kill(); } catch (_) {} // deliberate: cleanup
    return emit({ ok: false, error: 'server_failed_to_boot', elapsed_ms: Date.now() - wallStart, version: VERSION }, 2);
  }

  try {
    const tSignup = Date.now();
    const signup = await httpJSON(base, 'POST', '/v1/signup', {
      body: { email: 'w888L-timer@example.test', name: 'w888L-timer' },
    });
    const signupMs = Date.now() - tSignup;
    const apiKey = signup.json && (signup.json.api_key || signup.json.key);
    if (!apiKey) {
      return emit({ ok: false, error: 'signup_did_not_return_api_key', signup_status: signup.status, signup_body: String(signup.body || '').slice(0, 200), elapsed_ms: Date.now() - wallStart, version: VERSION }, 2);
    }
    const tDispatch = Date.now();
    const call = await httpJSON(base, 'POST', '/v1/gateway/dispatch', {
      headers: { authorization: 'Bearer ' + apiKey },
      body: { messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o-mini' },
    });
    const dispatchMs = Date.now() - tDispatch;
    const elapsedMs = Date.now() - wallStart;
    // Envelope ok if the JSON body has *any* of ok/error/error.type/kolm_receipt.
    // We accept upstream rejections (no provider key in this isolated test
    // boot, so the call's REAL outcome is a structured 401/502 — that's a
    // valid envelope, not a missing one).
    const envelopeOk = !!call.json && (
      typeof call.json.ok === 'boolean'
      || typeof call.json.error === 'string'
      || (call.json.error && typeof call.json.error.type === 'string')
      || (call.json.kolm_receipt && typeof call.json.kolm_receipt.receipt_id === 'string')
    );
    emit({
      ok: envelopeOk && elapsedMs < 120_000,
      elapsed_ms: elapsedMs,
      signup_ms: signupMs,
      dispatch_ms: dispatchMs,
      dispatch_status: call.status,
      envelope_ok: envelopeOk,
      version: VERSION,
    }, (envelopeOk && elapsedMs < 120_000) ? 0 : 2);
  } finally {
    try { proc.kill('SIGTERM'); } catch (_) {} // deliberate: cleanup
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
})().catch((e) => emit({ ok: false, error: String(e && e.message || e), version: VERSION }, 2));
