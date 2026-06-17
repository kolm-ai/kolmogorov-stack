// W648 - direct contract/security test for workers/compile-server/server.mjs.
//
// This standalone worker is a high-priority distribution boundary: it is meant
// to run in a customer VPC or air-gapped network with only a shared secret. The
// tests exercise public health, fail-closed auth, offline deploy-hook refusal,
// and request validation without running the full compile orchestrator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_KEYS = [
  'KOLM_SHARED_SECRET',
  'KOLM_OFFLINE',
  'KOLM_ARTIFACT_DIR',
  'KOLM_TENANT_ID',
];

function snapshotEnv() {
  const out = new Map();
  for (const key of ENV_KEYS) out.set(key, process.env[key]);
  return out;
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function applyEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env || {})) {
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

async function importCompileServer() {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return import(`../workers/compile-server/server.mjs?w648=${tag}`);
}

async function withCompileServer(env, fn) {
  const snapshot = snapshotEnv();
  applyEnv(env);
  let server = null;
  try {
    const mod = await importCompileServer();
    server = mod.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await fn({ base: `http://127.0.0.1:${address.port}` });
  } finally {
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    restoreEnv(snapshot);
  }
}

async function readJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function tmpArtifactDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w648-${name}-`));
}

test('W648 compile-server health is public but compile fails closed when the shared secret is blank', async () => {
  const artifactDir = tmpArtifactDir('blank-secret');
  try {
    await withCompileServer({
      KOLM_SHARED_SECRET: '   ',
      KOLM_ARTIFACT_DIR: artifactDir,
      KOLM_OFFLINE: '1',
    }, async ({ base }) => {
      const health = await fetch(base + '/v1/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('x-kolm-mode'), 'self-hosted');
      const healthBody = await readJson(health);
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.secret_configured, false);
      assert.equal(healthBody.offline, true);
      assert.equal(healthBody.artifact_dir, artifactDir);

      const compile = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'compile a small classifier' }),
      });
      assert.equal(compile.status, 503);
      assert.equal(compile.headers.get('x-kolm-server-version'), '0.1.0-w264');
      const body = await readJson(compile);
      assert.match(body.error, /KOLM_SHARED_SECRET is not set/);
    });
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('W648 compile-server enforces shared-secret auth, offline mode, and compile body validation', async () => {
  const artifactDir = tmpArtifactDir('configured');
  const secret = 'w648-shared-secret';
  try {
    await withCompileServer({
      KOLM_SHARED_SECRET: secret,
      KOLM_ARTIFACT_DIR: artifactDir,
      KOLM_TENANT_ID: 'tenant_w648',
      KOLM_OFFLINE: '1',
    }, async ({ base }) => {
      const preflight = await fetch(base + '/v1/compile', { method: 'OPTIONS' });
      assert.equal(preflight.status, 204);

      let res = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'compile' }),
      });
      assert.equal(res.status, 401);
      assert.equal((await readJson(res)).error, 'missing x-kolm-shared-secret header');

      res = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolm-shared-secret': 'wrong-secret',
        },
        body: JSON.stringify({ task: 'compile' }),
      });
      assert.equal(res.status, 401);
      assert.equal((await readJson(res)).error, 'invalid shared secret');

      res = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolm-shared-secret': secret,
        },
        body: '{',
      });
      assert.equal(res.status, 400);
      assert.match((await readJson(res)).error, /invalid JSON body/);

      res = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolm-shared-secret': secret,
        },
        body: JSON.stringify({ examples: [] }),
      });
      assert.equal(res.status, 400);
      assert.equal((await readJson(res)).error, 'task (string) required');

      res = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolm-shared-secret': secret,
        },
        body: JSON.stringify({
          task: 'compile a local artifact',
          deploy_hook: 'https://example.com/hook',
        }),
      });
      assert.equal(res.status, 400);
      assert.equal((await readJson(res)).error, 'deploy_hook rejected: server is in KOLM_OFFLINE=1 mode');

      res = await fetch(base + '/v1/compile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolm-shared-secret': secret,
        },
        body: JSON.stringify({
          task: 'compile a local artifact',
          multi_device: ['phone-ios', 'unknown-device'],
        }),
      });
      assert.equal(res.status, 400);
      assert.match((await readJson(res)).error, /multi_device entry "unknown-device" invalid/);

      const missing = await fetch(base + '/v1/not-a-route', {
        headers: { 'x-kolm-shared-secret': secret },
      });
      assert.equal(missing.status, 404);
      const missingBody = await readJson(missing);
      assert.equal(missingBody.error, 'not found');
      assert.equal(missingBody.path, '/v1/not-a-route');
    });
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});
