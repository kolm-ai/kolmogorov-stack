// Wave 492 - `kolm health --require-*` makes production readiness and
// authenticated capture durability verifiable from the CLI without changing
// the default liveness contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w492-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const home = isolatedHome();
    const child = spawn(process.execPath, [KOLM_CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 20_000); // deliberate: cleanup
    child.on('close', (code) => {
      clearTimeout(killer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

function spinServer({ readyStatus = 200, validKey = 'ks_good', captureDurable = true } = {}) {
  const app = express();
  const hasValidAuth = (req) => req.get('authorization') === `Bearer ${validKey}`;
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', (_req, res) => res.status(readyStatus).json({
    status: readyStatus >= 200 && readyStatus < 300 ? 'ready' : 'not_ready',
    production_like: true,
    checks: [{ name: 'artifact_store', ok: readyStatus < 300, required: true }],
  }));
  app.get('/v1/account', (req, res) => {
    if (!hasValidAuth(req)) return res.status(401).json({ error: 'invalid api key' });
    res.json({ id: 'tenant_w492', plan: 'test' });
  });
  app.get('/v1/capture/health', (req, res) => {
    if (!hasValidAuth(req)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ ok: true, driver: 'postgres', durable: captureDurable, subscriber_count: 0, thresholds: [100, 500, 1000] });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

test('W492 #1 - --require-ready succeeds and reports /ready when readiness is 2xx', async () => {
  const { server, base } = await spinServer();
  try {
    const out = await runCli(['health', '--json', '--require-ready'], { KOLM_BASE: base });
    assert.equal(out.code, 0, out.stderr || out.stdout);
    const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    assert.equal(payload.summary, 'healthy');
    assert.equal(payload.ready.status, 200);
    assert.equal(payload.ready_required, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('W492 #2 - --require-ready exits 1 when readiness is non-2xx', async () => {
  const { server, base } = await spinServer({ readyStatus: 503 });
  try {
    const out = await runCli(['health', '--json', '--require-ready'], { KOLM_BASE: base });
    assert.equal(out.code, 1);
    const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    assert.equal(payload.ok, false);
    assert.equal(payload.summary, 'not_ready');
    assert.equal(payload.ready.status, 503);
    assert.equal(payload.ready.error, 'status 503');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('W492 #3 - --require-auth exits 1 when the saved key is rejected', async () => {
  const { server, base } = await spinServer();
  try {
    const out = await runCli(['health', '--json', '--require-ready', '--require-auth'], {
      KOLM_BASE: base,
      KOLM_API_KEY: 'ks_bad',
    });
    assert.equal(out.code, 1);
    const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    assert.equal(payload.ok, false);
    assert.equal(payload.summary, 'auth_failed');
    assert.equal(payload.auth.status, 401);
    assert.equal(payload.auth.validated, false);
    assert.equal(payload.auth_required, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('W492 #4 - --require-capture succeeds when authenticated capture health is durable', async () => {
  const { server, base } = await spinServer();
  try {
    const out = await runCli(['health', '--json', '--require-ready', '--require-auth', '--require-capture'], {
      KOLM_BASE: base,
      KOLM_API_KEY: 'ks_good',
    });
    assert.equal(out.code, 0, out.stderr || out.stdout);
    const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    assert.equal(payload.summary, 'healthy');
    assert.equal(payload.auth.validated, true);
    assert.equal(payload.capture.status, 200);
    assert.equal(payload.capture.driver, 'postgres');
    assert.equal(payload.capture.durable, true);
    assert.equal(payload.capture_required, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('W492 #5 - --require-capture exits 1 when capture health is not durable', async () => {
  const { server, base } = await spinServer({ captureDurable: false });
  try {
    const out = await runCli(['health', '--json', '--require-ready', '--require-auth', '--require-capture'], {
      KOLM_BASE: base,
      KOLM_API_KEY: 'ks_good',
    });
    assert.equal(out.code, 1);
    const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    assert.equal(payload.ok, false);
    assert.equal(payload.summary, 'capture_unhealthy');
    assert.equal(payload.capture.status, 200);
    assert.equal(payload.capture.durable, false);
    assert.equal(payload.capture.error, 'durable false');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
