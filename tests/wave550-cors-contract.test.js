// Wave 550 - browser connector CORS contract.
//
// Hosted browser SDK usage needs two credential lanes:
//   Authorization: Bearer ks_*       -> Kolm tenant auth
//   x-upstream-api-key: sk_*         -> customer's provider credential
//
// If preflight does not allow x-upstream-api-key, the product works from
// server-side tests but fails from browsers before the request reaches Express.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

async function makeApp() {
  const dir = path.join(os.tmpdir(), 'kolm-w550-cors-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_PRODUCTION = '1';
  delete process.env.KOLM_LOCAL_DAEMON;
  const es = await import('../src/event-store.js');
  es._resetForTests?.();
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  return app;
}

async function makeDaemonApp() {
  const dir = path.join(os.tmpdir(), 'kolm-w550-daemon-cors-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const { buildDaemonApp } = await import('../src/daemon-connector.js');
  return buildDaemonApp({ dataDir: dir }).app;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

test('W550 #1 - CORS preflight allows browser connector and account-console headers', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/capture/openrouter/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': [
          'authorization',
          'content-type',
          'x-api-key',
          'x-upstream-api-key',
          'x-anthropic-api-key',
          'anthropic-version',
          'openai-beta',
          'http-referer',
          'x-title',
          'x-openrouter-title',
          'x-openrouter-categories',
          'x-kolm-namespace',
          'x-kolm-privacy-policy',
          'x-kolm-raw',
          'x-kolm-privacy-override',
        ].join(', '),
      },
    });
    assert.equal(r.status, 204);
    const allowHeaders = String(r.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const h of [
      'authorization',
      'content-type',
      'x-api-key',
      'x-upstream-api-key',
      'x-anthropic-api-key',
      'anthropic-version',
      'openai-beta',
      'http-referer',
      'x-title',
      'x-openrouter-title',
      'x-openrouter-categories',
      'x-kolm-namespace',
      'x-kolm-privacy-policy',
      'x-kolm-raw',
      'x-kolm-privacy-override',
    ]) {
      assert.match(allowHeaders, new RegExp(`(^|, )${h}(,|$)`), `CORS must allow ${h}`);
    }
    const allowMethods = String(r.headers.get('access-control-allow-methods') || '').toUpperCase();
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.match(allowMethods, new RegExp(`(^|, )${m}(,|$)`), `CORS must allow ${m}`);
    }
  });
});

test('W550 #4 - local daemon CORS mirrors hosted browser connector headers', async () => {
  const app = await makeDaemonApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/capture/openrouter/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': [
          'authorization',
          'content-type',
          'x-upstream-api-key',
          'x-openrouter-title',
          'x-openrouter-categories',
          'x-kolm-privacy-policy',
          'x-kolm-raw',
        ].join(', '),
      },
    });
    assert.equal(r.status, 204);
    const allowHeaders = String(r.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const h of [
      'authorization',
      'content-type',
      'x-upstream-api-key',
      'x-openrouter-title',
      'x-openrouter-categories',
      'x-kolm-privacy-policy',
      'x-kolm-raw',
    ]) {
      assert.match(allowHeaders, new RegExp(`(^|, )${h}(,|$)`), `daemon CORS must allow ${h}`);
    }
    const allowMethods = String(r.headers.get('access-control-allow-methods') || '').toUpperCase();
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.match(allowMethods, new RegExp(`(^|, )${m}(,|$)`), `daemon CORS must allow ${m}`);
    }
  });
});
