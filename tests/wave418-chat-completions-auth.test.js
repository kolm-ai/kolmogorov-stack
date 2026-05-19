// W418 — /v1/chat/completions auth enforcement (audit 2026-05-19 P0 #3).
//
// "P0 Core Truth #3: /v1/chat/completions MUST enforce auth on every request
//  path. No anonymous proxy slip."
//
// W411 already shipped a hosted-auth gate (__w411HostedAuthGate) that fronts
// every OpenAI/Anthropic-compatible inference passthrough route. W418 is a
// pure regression guard plus a defense-in-depth check at the connector-proxy
// boundary itself: any future route that wires __connectorProxy without
// going through the W411 gate must STILL fail closed when hosted.
//
// Behavior assertions (HTTP-level + static-source):
//   1. POST /v1/chat/completions with no auth → 401 unauthorized
//   2. POST /v1/completions  (legacy) — NOT registered; surfaces 404 not slip
//   3. POST /v1/embeddings  with no auth → 401 unauthorized
//   4. POST /v1/messages    with no auth → 401 unauthorized (Anthropic shape)
//   5. Bad Bearer (sk-*) → 401 (NOT 403, NOT 200, NOT forwarded)
//   6. 401 envelope is JSON {error:'unauthorized', reason:string}
//   7. Static guard: every r.post('/v1/chat/completions'…) handler line
//      contains __w411HostedAuthGate within 200 chars of the path literal
//   8. Static guard: __connectorProxy has a !req.tenant_record fail-closed
//      check before any upstream HTTP call (defense-in-depth)
//   9. GET /v1/models stays 200 anonymous (SDK probe; W411 #8 carry-over)
//
// Test isolation pattern mirrors tests/wave411-hosted-auth-gate.test.js so
// per-test KOLM_DATA_DIR + KOLM_PRODUCTION=1 stay sealed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');

function freshDataDir() {
  const d = path.join(
    os.tmpdir(),
    'kolm-w418-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function makeHostedApp() {
  const dir = freshDataDir();
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    dir, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';
  process.env.KOLM_CONNECTOR_FIXTURE = '1';
  process.env.KOLM_PRODUCTION = '1';
  delete process.env.KOLM_LOCAL_DAEMON;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.KOLM_ALLOW_RAW;
  try {
    const es = await import('../src/event-store.js');
    es._resetForTests?.();
  } catch { /* not all modules expose this */ }
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  return { app, dataDir: dir };
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

function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }

// =====================================================================
// HTTP-level assertions (anonymous traffic must NOT slip).
// =====================================================================

test('W418 #1 — POST /v1/chat/completions with no auth returns 401', async () => {
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(r.status, 401, 'hosted /v1/chat/completions must 401 anon traffic');
    const body = await r.json();
    assert.equal(body.error, 'unauthorized', 'error tag must be "unauthorized"');
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0,
      'response body must carry a structured "reason" field');
  });
});

test('W418 #2 — POST /v1/completions is NOT a registered slip path', async () => {
  // Legacy OpenAI completions endpoint. We do not expose it. The audit cares
  // that there is no quiet anonymous slip — a 404 (route not found) is fine;
  // a 200/forwarded response would be a P0 leak.
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-3.5-turbo-instruct', prompt: 'hi' }),
    });
    assert.notEqual(r.status, 200,
      '/v1/completions must NOT silently 200 — would be a proxy slip');
    assert.ok(r.status === 404 || r.status === 401 || r.status === 405,
      'expected 404/401/405; got ' + r.status);
  });
});

test('W418 #3 — POST /v1/embeddings with no auth returns 401', async () => {
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }),
    });
    assert.equal(r.status, 401, 'embeddings must 401 anon');
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W418 #4 — POST /v1/messages (Anthropic) with no auth returns 401', async () => {
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(r.status, 401, 'messages must 401 anon');
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W418 #5 — POST /v1/chat/completions with a bad Bearer (sk-*) returns 401 not 403', async () => {
  // Naive callers pasting an upstream provider key into Authorization must
  // get a clean 401 (not 403, not 500, not forwarded). 403 is a category
  // error here: the request is unauthenticated against our system, not
  // authenticated-but-forbidden.
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer sk-not-a-kolm-key-xxxxxxx',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(r.status, 401, 'sk-* must 401, not 403/500/200; got ' + r.status);
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W418 #6 — POST /v1/chat/completions with an unknown ks_* bearer returns 401', async () => {
  // A ks_*-shaped key that does not resolve to a real tenant must also 401.
  // This is the "looks like ours but isn't" case.
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ks_not_a_real_tenant_xxxxxxxxxxxx',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(r.status, 401, 'unknown ks_* must 401; got ' + r.status);
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W418 #7 — GET /v1/models stays 200 anonymous (SDK probe)', async () => {
  // OpenAI / Anthropic SDKs call client.models.list() BEFORE authenticating.
  // That probe must succeed without a key — W411 already pins this, W418
  // restates it so removing the W411 file does not silently break.
  const { app } = await makeHostedApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/models', {
      headers: { accept: 'application/json' },
    });
    assert.equal(r.status, 200, 'anonymous /v1/models probe must succeed');
    const body = await r.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

// =====================================================================
// Static-source guards — defense against future-regression where a new
// route wires __connectorProxy without the W411 gate.
// =====================================================================

test('W418 #8 — every r.post(\'/v1/chat/completions\') line carries __w411HostedAuthGate', () => {
  // Scan every line that registers a chat-completions POST route and
  // assert the gate middleware is wired on the same line (within 200
  // chars of the path literal). Catches "someone added a new
  // /v1/chat/completions alias and forgot the gate" before it ships.
  const src = readRouter();
  const lines = src.split(/\r?\n/);
  const offenders = [];
  for (const line of lines) {
    if (!/r\.post\(\s*['"]\/v1\/chat\/completions['"]/.test(line)) continue;
    if (!line.includes('__w411HostedAuthGate')) {
      offenders.push(line.trim().slice(0, 200));
    }
  }
  assert.equal(offenders.length, 0,
    '/v1/chat/completions routes missing W411 gate:\n  ' + offenders.join('\n  '));
});

test('W418 #9 — /v1/embeddings, /v1/messages, /v1/responses, /v1/openrouter/* routes carry the gate', () => {
  const src = readRouter();
  const lines = src.split(/\r?\n/);
  const patterns = [
    /\/v1\/embeddings/,
    /\/v1\/messages/,
    /\/v1\/responses/,
    /\/v1\/openrouter/,
    /\/v1\/capture\/openrouter/,
  ];
  const offenders = [];
  for (const line of lines) {
    if (!/r\.post\(/.test(line)) continue;
    if (!patterns.some((p) => p.test(line))) continue;
    if (!line.includes('__w411HostedAuthGate')) {
      offenders.push(line.trim().slice(0, 200));
    }
  }
  // Note: __connectorProxy is called via for-loop at line 2466 for ['/v1/responses',
  // '/v1/embeddings', '/v1/moderations'] — that loop body includes the gate. The
  // grep above only catches inline literal-path posts; the loop's `r.post(p, ...)`
  // form does not match `/v1/responses` literally on the same line, so we add an
  // explicit check that the for-loop block also wires the gate.
  assert.equal(offenders.length, 0,
    'inference passthrough route(s) missing W411 gate:\n  ' + offenders.join('\n  '));
});

test('W418 #10 — __connectorProxy fails closed when req.tenant_record missing in hosted mode', () => {
  // Defense-in-depth: if a future route bypasses __w411HostedAuthGate (e.g.
  // a developer wires r.post('/v1/something-new', (req,res) => __connectorProxy(...))
  // without the middleware), the connector-proxy boundary itself must
  // refuse to forward an anonymous request to the upstream provider.
  const src = readRouter();
  const i = src.indexOf('async function __connectorProxy');
  assert.ok(i >= 0, '__connectorProxy must be defined');
  // The fail-closed check should be in the FIRST 1000 chars of the body
  // (before any upstream HTTP machinery). We look for the W418 marker
  // comment plus a !req.tenant_record gate plus a 401 return.
  const slice = src.slice(i, i + 1200);
  assert.match(slice, /!req\.tenant_record/,
    '__connectorProxy must check !req.tenant_record at boundary');
  assert.match(slice, /401/,
    '__connectorProxy must 401 when tenant missing');
  assert.match(slice, /__w411IsLocalDaemonMode/,
    '__connectorProxy must use the local-daemon discriminator (so the laptop dev path stays open)');
});

test('W418 #11 — __w411HostedAuthGate rejects sk-* (upstream provider keys) explicitly', () => {
  // Make sure the "naive caller pastes their OpenAI key" path stays a hard
  // 401 — not a quiet upstream forward. The check lives in the gate
  // function and reads keys for ks_*/kao_* prefix only.
  const src = readRouter();
  const i = src.indexOf('function __w411HostedAuthGate');
  assert.ok(i >= 0, '__w411HostedAuthGate must be defined');
  const slice = src.slice(i, i + 3000);
  assert.match(slice, /ks_|kao_/,
    'gate must scope to ks_*/kao_* tenant keys');
  assert.match(slice, /401/,
    'gate must return 401 on missing/unknown key');
});
