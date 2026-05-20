// Wave 549 - hosted connector must never forward a kolm tenant key upstream.
//
// Hosted calls authenticate to kolm with Authorization: Bearer ks_...
// and pass the customer's provider credential in x-upstream-api-key. The
// proxy must forward ONLY the upstream key to OpenRouter/OpenAI. This catches
// the regression where __connectorProxy resolved Authorization before
// x-upstream-api-key and sent the kolm tenant key to the provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

function tmpHome() {
  const d = path.join(os.tmpdir(), 'kolm-w549-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function withMockOpenRouter(fn) {
  const seen = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization || '',
          referer: req.headers['http-referer'] || '',
          title: req.headers['x-title'] || '',
          openrouterTitle: req.headers['x-openrouter-title'] || '',
          openrouterCategories: req.headers['x-openrouter-categories'] || '',
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl_w549',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'openai/gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`, seen);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

test('W549 #2 - hosted OpenRouter uses x-upstream-api-key, not Authorization ks_*', async () => {
  const home = tmpHome();
  const oldEnv = {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_PRODUCTION: process.env.KOLM_PRODUCTION,
    KOLM_LOCAL_DAEMON: process.env.KOLM_LOCAL_DAEMON,
    KOLM_CONNECTOR_FIXTURE: process.env.KOLM_CONNECTOR_FIXTURE,
    KOLM_UPSTREAM_OPENROUTER_BASE: process.env.KOLM_UPSTREAM_OPENROUTER_BASE,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  try {
    process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.KOLM_STORE_DRIVER = 'json';
    process.env.KOLM_PRODUCTION = '1';
    delete process.env.KOLM_LOCAL_DAEMON;
    delete process.env.KOLM_CONNECTOR_FIXTURE;
    delete process.env.OPENROUTER_API_KEY;

    await withMockOpenRouter(async (upstreamBase, seen) => {
      process.env.KOLM_UPSTREAM_OPENROUTER_BASE = upstreamBase;
      const { buildRouter } = await import('../src/router.js');
      const { provisionAnonTenant } = await import('../src/auth.js');
      const express = (await import('express')).default;
      const app = express();
      app.use(express.json({ limit: '2mb' }));
      app.use(buildRouter());
      const tenant = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

      await new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', async () => {
          try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const r = await fetch(base + '/v1/openrouter/v1/chat/completions', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: 'Bearer ' + tenant.api_key,
                'x-upstream-api-key': 'sk-or-w549-real-upstream',
                'x-kolm-namespace': 'w549',
                'http-referer': 'https://example.com',
                'x-openrouter-title': 'Kolm W549 App',
                'x-openrouter-categories': 'devtools,privacy',
              },
              body: JSON.stringify({
                model: 'openai/gpt-4o-mini',
                messages: [{ role: 'user', content: 'do not leak tenant key upstream' }],
              }),
            });
            assert.equal(r.status, 200);
            server.close(resolve);
          } catch (e) {
            server.close(() => reject(e));
          }
        });
      });

      const { buildDaemonApp } = await import('../src/daemon-connector.js');
      const daemon = buildDaemonApp({ dataDir: process.env.KOLM_DATA_DIR }).app;
      await new Promise((resolve, reject) => {
        const server = daemon.listen(0, '127.0.0.1', async () => {
          try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const r = await fetch(base + '/v1/capture/openrouter/v1/chat/completions', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-upstream-api-key': 'sk-or-w549-real-upstream',
                'http-referer': 'https://example.com',
                'x-openrouter-title': 'Kolm W549 App',
                'x-openrouter-categories': 'devtools,privacy',
              },
              body: JSON.stringify({
                model: 'openai/gpt-4o-mini',
                messages: [{ role: 'user', content: 'daemon should forward attribution headers too' }],
              }),
            });
            assert.equal(r.status, 200);
            server.close(resolve);
          } catch (e) {
            server.close(() => reject(e));
          }
        });
      });

      assert.equal(seen.length, 2, 'mock upstream should receive hosted + daemon requests');
      for (const row of seen) {
        assert.equal(row.authorization, 'Bearer sk-or-w549-real-upstream');
        assert.doesNotMatch(row.authorization, /ks_|kao_/);
        assert.equal(row.referer, 'https://example.com');
        assert.equal(row.title, 'Kolm W549 App');
        assert.equal(row.openrouterTitle, 'Kolm W549 App');
        assert.equal(row.openrouterCategories, 'devtools,privacy');
        assert.equal(row.url, '/v1/chat/completions');
      }
    });
  } finally {
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});
