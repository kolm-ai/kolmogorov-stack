// Wave 411 — hosted /v1/* inference auth gate.
//
// P0 Core Truth #3 + #4 (W411 audit closer):
//   - The hosted server (api.kolm.ai) MUST require a Kolm API key on every
//     inference passthrough route (/v1/chat/completions, /v1/responses,
//     /v1/embeddings, /v1/messages, /v1/capture/openai, /v1/capture/anthropic,
//     /v1/openrouter/*). Anonymous requests get 401 with a structured body.
//   - The local daemon (kolm connect start) can stay UNauthenticated, but
//     captured events must still carry a tenant_id (sentinel "local:<host>")
//     so the lake / opportunity engine / dataset workbench have something
//     queryable.
//   - GET /v1/models MUST stay open (OpenAI/Anthropic SDKs probe it before
//     authenticating) but anonymous probes are rate-limited per /24 IP.
//
// Tests assert BEHAVIOR (HTTP status, JSON body shape) not page copy, so a
// later message-string tweak doesn't cascade-break the gate.
//
// Per-test isolation: every test grabs its own KOLM_DATA_DIR + HOME so the
// store + on-disk modules don't collide. W311 trap-aware: stays on the
// json store driver to avoid the parallel-SQLite flake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// =====================================================================
// Per-test isolation helper. Each test calls makeApp({mode}) with
// mode='hosted' or mode='local-daemon'. The env discriminator we use is
// KOLM_LOCAL_DAEMON=1 for local, KOLM_PRODUCTION=1 for hosted.
//
// We set the env vars BEFORE the dynamic import so the module sees the
// production-runtime flag at boot. Each test gets a fresh tmpdir so the
// auth store / event-store / config files do not bleed across tests.
// =====================================================================
function freshDataDir() {
  const d = path.join(
    os.tmpdir(),
    'kolm-w411-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function makeApp({ mode = 'hosted' } = {}) {
  const dir = freshDataDir();
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    dir, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';
  // Fixture mode so the connector proxy can return a deterministic body
  // without configuring real upstream keys.
  process.env.KOLM_CONNECTOR_FIXTURE = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.KOLM_ALLOW_RAW;
  // Discriminator: which mode is this app booted in?
  if (mode === 'hosted') {
    process.env.KOLM_PRODUCTION = '1';
    delete process.env.KOLM_LOCAL_DAEMON;
  } else {
    process.env.KOLM_LOCAL_DAEMON = '1';
    delete process.env.KOLM_PRODUCTION;
  }
  // Reset cached event-store module so we pick up our fresh path.
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

// =====================================================================
// HOSTED MODE — anonymous traffic on /v1/chat/completions must 401.
// =====================================================================

test('W411 #1 — hosted POST /v1/chat/completions with no Authorization returns 401', async () => {
  const { app } = await makeApp({ mode: 'hosted' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 401, 'hosted /v1/chat/completions must 401 anonymous traffic');
    const body = await r.json();
    assert.equal(body.error, 'unauthorized', 'error tag must be "unauthorized"');
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0,
      'response body must carry a structured "reason" field');
  });
});

test('W411 #2 — hosted POST /v1/responses with no auth returns 401', async () => {
  const { app } = await makeApp({ mode: 'hosted' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi' }),
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W411 #3 — hosted POST /v1/embeddings with no auth returns 401', async () => {
  const { app } = await makeApp({ mode: 'hosted' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }),
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W411 #4 — hosted POST /v1/messages with no auth returns 401', async () => {
  const { app } = await makeApp({ mode: 'hosted' });
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
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W411 #5 — hosted POST /v1/openrouter/v1/chat/completions with no auth returns 401', async () => {
  const { app } = await makeApp({ mode: 'hosted' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/openrouter/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W411 #6 — hosted POST /v1/chat/completions with a non-kolm key (sk-*) is rejected', async () => {
  // A naive caller pasting an OpenAI sk-* key into Authorization must NOT
  // get hosted inference. We require ks_*/kao_* prefix specifically so
  // hosted billing always attributes to a real tenant.
  const { app } = await makeApp({ mode: 'hosted' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer sk-not-a-kolm-key-xxxxxxx',
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 401, 'sk-* keys must NOT authenticate against hosted');
    const body = await r.json();
    assert.equal(body.error, 'unauthorized');
  });
});

test('W411 #7 — hosted POST /v1/chat/completions with a valid kolm key returns non-401 (fixture path)', async () => {
  const { app } = await makeApp({ mode: 'hosted' });
  // Provision a real tenant via the auth store so the key resolves.
  const { provisionAnonTenant } = await import('../src/auth.js');
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // We do NOT require 200 — the fixture path returns 200 today, but a
    // future change to require an upstream key on hosted is fine. The
    // CORE assertion: a valid kolm key bypasses the W411 gate, so the
    // response MUST NOT be 401.
    assert.notEqual(r.status, 401,
      'a valid kolm tenant key must pass the W411 gate; status was ' + r.status);
  });
});

test('W411 #8 — hosted GET /v1/models returns 200 with no auth (probe must work)', async () => {
  // OpenAI/Anthropic SDKs call client.models.list() BEFORE authenticating.
  // The probe must succeed (200, OpenAI-list envelope) without a key.
  const { app } = await makeApp({ mode: 'hosted' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/models', {
      headers: { accept: 'application/json' },
    });
    assert.equal(r.status, 200, 'anonymous /v1/models probe must succeed');
    const body = await r.json();
    assert.equal(body.object, 'list', 'OpenAI list envelope');
    assert.ok(Array.isArray(body.data), 'data[] array present');
  });
});

test('W411 #9 — hosted /v1/models with auth header bypasses the anon rate limiter (no 429 burst)', async () => {
  // The anonymous-probe limiter only kicks in for unauth callers. An authed
  // user pinging models 200 times in a tight loop must not get 429'd by the
  // probe limiter. We don't run 200 here (slow); we run 5 in tight
  // succession and assert all 200 — enough to prove the skip() honored auth.
  const { app } = await makeApp({ mode: 'hosted' });
  const { provisionAnonTenant } = await import('../src/auth.js');
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(app, async (base) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(base + '/v1/models', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + t.api_key },
      });
      assert.equal(r.status, 200, 'authed /v1/models call ' + (i + 1) + ' must not 429');
    }
  });
});

// =====================================================================
// LOCAL DAEMON MODE — anonymous /v1/chat/completions must pass through
// AND tag the event with tenant_id='local:<hostname>'.
// =====================================================================

test('W411 #10 — local-daemon POST /v1/chat/completions with no auth returns 200 (fixture path)', async () => {
  const { app } = await makeApp({ mode: 'local-daemon' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200,
      'local daemon must allow anonymous inference (W411 P0 #4)');
    const body = await r.json();
    assert.equal(body.object, 'chat.completion', 'OpenAI envelope');
    assert.ok(r.headers.get('x-kolm-event-id'), 'event_id receipt header still present');
  });
});

test('W411 #11 — local-daemon writes events under tenant_id "local:*"', async () => {
  const { app } = await makeApp({ mode: 'local-daemon' });
  // listEvents() reads from the event-store this module is bound to. We
  // pull the count before/after a single call + read back the row.
  const { listEvents } = await import('../src/event-store.js');
  const before = await listEvents({});
  const beforeLen = before.length;
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'tag me' }] }),
    });
    assert.equal(r.status, 200);
  });
  const after = await listEvents({});
  assert.ok(after.length > beforeLen,
    'at least one new event row should land after a connector call (' + beforeLen + ' -> ' + after.length + ')');
  // listEvents returns DESC by created_at, so newest is index 0. We look
  // for ANY row tagged with the local: sentinel — the gate stamps every
  // request with tenant 'local:<hostname>' so the most recent local-daemon
  // call's row must match.
  const local = after.find((r) => typeof r.tenant_id === 'string' && /^local:/.test(r.tenant_id));
  assert.ok(local,
    'at least one event row must carry tenant_id "local:*"; saw ' +
    JSON.stringify(after.slice(0, 3).map((r) => r.tenant_id)));
});

test('W411 #12 — local-daemon GET /v1/models still returns 200 (anon probe path)', async () => {
  const { app } = await makeApp({ mode: 'local-daemon' });
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/models', {
      headers: { accept: 'application/json' },
    });
    assert.equal(r.status, 200, 'local daemon /v1/models probe must succeed');
    const body = await r.json();
    assert.equal(body.object, 'list');
  });
});

// =====================================================================
// Cross-mode sanity — the gate's mode discriminator should default to
// local-daemon outside production-runtime hosts so developers don't get
// 401'd on their laptop just because KOLM_LOCAL_DAEMON isn't set.
// =====================================================================

test('W411 #13 — when neither KOLM_PRODUCTION nor KOLM_LOCAL_DAEMON is set, treat as local-daemon', async () => {
  // Clear both flags and rebuild. The runtime detection should fall back
  // to local-daemon mode (developer laptop). Without this, every dev test
  // run would 401 on /v1/chat/completions.
  delete process.env.KOLM_PRODUCTION;
  delete process.env.KOLM_LOCAL_DAEMON;
  const { app } = await makeApp({ mode: 'local-daemon' });
  // Clear again AFTER makeApp set KOLM_LOCAL_DAEMON=1 — we want to assert
  // the default-fallback behavior, not the explicit-flag behavior.
  delete process.env.KOLM_LOCAL_DAEMON;
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200,
      'developer-laptop default (no flag) must NOT 401; got ' + r.status);
  });
});
