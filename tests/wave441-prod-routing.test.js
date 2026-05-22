// W441 lock-in: vercel.json must NOT register api/index.js as a function,
// because (a) it wraps the full Express app and (b) Vercel routes / and /api
// to it, both of which then cold-start-fail with FUNCTION_INVOCATION_FAILED.
//
// The shipped routing model is:
//   - /v1/(.*) -> Railway (via vercel.json rewrites line 135-137)
//   - /health, /ready -> Railway
//   - Everything else -> static files in public/ (with rewrites)
//   - api/r2.js and api/cf-config.js remain as scoped helpers
//
// This test asserts that contract structurally so a future engineer
// re-adding api/index.js (and its catch-all Express wrap) triggers
// an immediate test failure long before prod re-breaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const vercelJsonPath = path.join(REPO, 'vercel.json');
const apiDir = path.join(REPO, 'api');

test('W441 #1 — api/index.js must NOT exist (it catch-all-fails on /, /api, /docs/*)', () => {
  const apiIndex = path.join(apiDir, 'index.js');
  assert.ok(!fs.existsSync(apiIndex),
    `api/index.js must NOT exist — it wraps the full Express app and Vercel routes / and /api to it, causing FUNCTION_INVOCATION_FAILED. /v1/* already proxies direct to Railway via vercel.json. If you need the Express app on Vercel, put it on a non-/api path so Vercel does not catch-all.`);
});

test('W441 #2 — vercel.json must NOT register api/index.js in functions', () => {
  const cfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  assert.ok(cfg.functions, 'vercel.json must declare functions block');
  assert.ok(!('api/index.js' in cfg.functions),
    'vercel.json functions must NOT contain api/index.js — same reason as #1');
});

test('W441 #3 — vercel.json must keep the Railway proxy rewrites for /v1, /health, /ready', () => {
  const cfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const railway = ['kolmo', 'gorov-stack-production.up.railway.app'].join('');
  const hasV1 = rewrites.some((r) => r.source === '/v1/(.*)' && (r.destination || '').includes(railway));
  const hasHealth = rewrites.some((r) => r.source === '/health' && (r.destination || '').includes(railway));
  const hasReady = rewrites.some((r) => r.source === '/ready' && (r.destination || '').includes(railway));
  assert.ok(hasV1, 'rewrite /v1/(.*) -> Railway must remain — replaces api/index.js for /v1/*');
  assert.ok(hasHealth, 'rewrite /health -> Railway must remain');
  assert.ok(hasReady, 'rewrite /ready -> Railway must remain');
});

test('W441 #4 — vercel.json must rewrite / to /index.html so the root serves static', () => {
  const cfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const hasRoot = rewrites.some((r) => r.source === '/' && r.destination === '/index.html');
  assert.ok(hasRoot, 'rewrite / -> /index.html must remain so the root serves public/index.html');
});

test('W441 #5 — vercel.json must rewrite /api to /api.html (was being eaten by function)', () => {
  const cfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const hasApi = rewrites.some((r) => r.source === '/api' && r.destination === '/api.html');
  assert.ok(hasApi, 'rewrite /api -> /api.html must remain');
});

test('W441 #6 — referenced static destinations must actually exist on disk', () => {
  // Sanity: the rewrite targets the test pins above must resolve to real files.
  const required = ['public/index.html', 'public/api.html', 'public/docs/api-routes.json'];
  for (const rel of required) {
    const p = path.join(REPO, rel);
    assert.ok(fs.existsSync(p), `${rel} must exist (referenced by vercel.json rewrite)`);
  }
});

test('W441 #7 — only safe helper functions remain in api/', () => {
  // The two allowed function files are scoped (r2 + cf-config), not full app wraps.
  const allowed = new Set(['r2.js', 'cf-config.js']);
  const present = fs.readdirSync(apiDir).filter((f) => f.endsWith('.js'));
  for (const f of present) {
    assert.ok(allowed.has(f),
      `api/${f} is an unexpected serverless function — only ${[...allowed].join(', ')} are allowed. Adding new functions risks catching shared route prefixes.`);
  }
});
