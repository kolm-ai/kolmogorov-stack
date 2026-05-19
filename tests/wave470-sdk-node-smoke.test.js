// W470 P0-2 lock-in: Node SDK must complete end-to-end against an
// in-process server. The user-reported "search() returns matches:
// internal server error" failure path is the regression we are pinning.
//
// We boot the same express router the production server uses, hit a
// random port, and exercise the SDK's search() + a couple of other
// surfaces. /v1/search must NEVER return a bare 500 even on a stale or
// edge-case registry — the route is wrapped to emit a structured
// {error, detail, matches:[]} envelope, and searchSimilar itself
// returns [] when query is empty / corpus is unreadable.

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import express from 'express';
import { buildRouter } from '../src/router.js';
import { searchSimilar } from '../src/registry.js';

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w470-'));
  process.env.KOLM_DATA_DIR = dir;
  return dir;
}

async function bootServer() {
  freshDataDir();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(buildRouter());
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('W470 #1 — searchSimilar() returns [] on empty query (never throws)', () => {
  assert.deepStrictEqual(searchSimilar({ query: '', tenant: 't' }), []);
  assert.deepStrictEqual(searchSimilar({ query: '   ', tenant: 't' }), []);
  assert.deepStrictEqual(searchSimilar({ query: null, tenant: 't' }), []);
  assert.deepStrictEqual(searchSimilar({ query: undefined, tenant: 't' }), []);
});

async function signupKey(baseUrl) {
  const res = await fetch(baseUrl + '/v1/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `w470-${Date.now()}-${Math.random()}@example.com` }),
  });
  const body = await res.json();
  return body.api_key;
}

test('W470 #2 — /v1/search wraps errors in honest envelope (no raw 500)', async () => {
  const { server, baseUrl } = await bootServer();
  try {
    const key = await signupKey(baseUrl);
    const res = await fetch(baseUrl + '/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ query: 'detect spam', k: 3 }),
    });
    const body = await res.json();
    assert.ok('matches' in body, 'response must always carry matches array');
    assert.ok(Array.isArray(body.matches), 'matches must be array');
    // If anything inside searchSimilar threw, the route would have returned
    // status 500 — but with body { error, detail, matches: [] }. Either way
    // the SDK's _req can parse the body without surfacing "Internal Server
    // Error" plain text.
    if (res.status !== 200) {
      assert.ok(body.error, 'non-200 must carry structured error field');
      assert.ok(Array.isArray(body.matches), 'non-200 still carries matches:[]');
    }
  } finally {
    server.close();
  }
});

test('W470 #3 — SDK search() against in-process server resolves matches', async () => {
  const { server, baseUrl } = await bootServer();
  try {
    const mod = await import('../sdk/node/index.mjs');
    const KolmClient = mod.default;
    const key = await signupKey(baseUrl);
    const c = new KolmClient({ baseUrl, apiKey: key });
    const s = await c.search('detect spam', 3);
    assert.ok(Array.isArray(s.matches), 'SDK search must return matches array');
  } finally {
    server.close();
  }
});

test('W470 #4 — SDK end-to-end signup + featured + search must all resolve', async () => {
  const { server, baseUrl } = await bootServer();
  try {
    const mod = await import('../sdk/node/index.mjs');
    const KolmClient = mod.default;
    const c = new KolmClient({ baseUrl });
    const h = await c.health();
    assert.strictEqual(h.status, 'ok');
    const su = await c.signup(`w470-${Date.now()}@example.com`);
    assert.match(su.api_key, /^ks_/);
    c.apiKey = su.api_key;
    const f = await c.featured();
    assert.ok(Array.isArray(f.featured));
    const s = await c.search('classify text', 5);
    assert.ok(Array.isArray(s.matches));
  } finally {
    server.close();
  }
});
