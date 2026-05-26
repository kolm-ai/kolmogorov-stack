// W888-Q — /v1/assistant/chat + floating assistant widget.
//
// 10 lock-ins. Tests that hit the route boot a spawned server with the
// KOLM_ASSISTANT_TEST_SHIM=1 env (canned shims, no real GGUF, no upstream).
// Tests that hit the static widget assets read straight from public/assets.
//
//   #1  POST /v1/assistant/chat returns 200 + envelope {ok, response,
//       passport_hash, cost_usd, provider_used, latency_ms, turn_id,
//       fallback_chain} when caller is on a paid plan and prompt is valid.
//   #2  POST without Authorization -> 401 auth_required.
//   #3  POST as plan='free' -> 402 tier_locked:true, required:'Indie'.
//   #4  POST burst (KOLM_ASSISTANT_CHAT_TEST_BURST=1) -> 429 rate_limited.
//   #5  POST when gateway cost > cap -> 200 ok:false reason:'budget_exceeded'.
//   #6  POST missing prompt -> 400 missing_prompt.
//   #7  public/assets/assistant-widget.js exists, registers Ctrl+K listener,
//       and references /v1/assistant/chat endpoint.
//   #8  public/assets/assistant-widget.css exists and declares the
//       --assistant- prefixed custom properties (cool slate dark mode).
//   #9  At least 5 public/account/*.html files reference
//       /assets/assistant-widget.js by <script> tag (greppable lock-in).
//   #10 The widget JS surface uses role="dialog" + aria-labelledby on the
//       slide-out panel (screen-reader friendly per W888-Q spec).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

function bootServer(t, extraEnv = {}) {
  return (async () => {
    const PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    const scratch = path.join(os.tmpdir(), `kolm-w888q-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const dataDir = path.join(scratch, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const tenantId = 't_w888q';
    const plan = extraEnv.__plan || 'pro';
    fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
      { id: tenantId, name: 'w888q', plan, quota: 1000000, created_at: new Date().toISOString() },
    ]), 'utf8');

    const apiKey = 'ks_w888q_smoke_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
      { id: 'apik_w888q', tenant_id: tenantId, hash, kind: 'user', revoked_at: null, created_at: new Date().toISOString() },
    ]), 'utf8');

    const env = {
      ...process.env,
      PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: scratch,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      KOLM_ASSISTANT_TEST_SHIM: '1',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    };
    delete env.__plan;
    for (const k of Object.keys(extraEnv)) {
      if (k === '__plan') continue;
      env[k] = extraEnv[k];
    }

    const proc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    t.after(() => rmSyncBestEffort(scratch));
    t.after(() => killAndWait(proc));

    await waitForHealth(BASE);
    return { BASE, apiKey, tenantId };
  })();
}

// ─── HTTP route lock-ins ────────────────────────────────────────────────────

test('W888-Q #1 — POST /v1/assistant/chat 200 returns full envelope on paid plan', async (t) => {
  const { BASE, apiKey } = await bootServer(t);
  const r = await fetch(BASE + '/v1/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ prompt: 'what is kolm?' }),
  });
  assert.equal(r.status, 200, `body=${await r.clone().text()}`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.response, 'string');
  assert.ok(j.response.length > 0, 'response must be a non-empty string');
  assert.equal(typeof j.cost_usd, 'number');
  assert.equal(typeof j.latency_ms, 'number');
  assert.equal(typeof j.provider_used, 'string');
  assert.ok(['local', 'api', 'gateway', 'error', 'unknown'].includes(j.provider_used), `bad provider_used: ${j.provider_used}`);
  assert.ok(j.turn_id && j.turn_id.startsWith('turn_'), `bad turn_id: ${j.turn_id}`);
  assert.ok(Array.isArray(j.fallback_chain));
  assert.ok(j.fallback_chain.length >= 1);
  // passport_hash is allowed to be null when the on-disk passport is missing
  assert.ok(j.passport_hash === null || typeof j.passport_hash === 'string');
});

test('W888-Q #2 — POST without Authorization returns 401', async (t) => {
  const { BASE } = await bootServer(t);
  const r = await fetch(BASE + '/v1/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  assert.equal(r.status, 401, `body=${await r.clone().text()}`);
  const j = await r.json();
  // Auth middleware short-circuits with {error: 'missing api key'} before the
  // route's own {ok:false, error:'auth_required'} branch. Either shape is
  // acceptable lock-in evidence that the route is not publicly callable.
  assert.ok(
    j.error === 'missing api key' || j.error === 'auth_required',
    `expected an auth error, got: ${JSON.stringify(j)}`
  );
});

test('W888-Q #3 — POST as plan=free returns 402 tier_locked', async (t) => {
  const { BASE, apiKey } = await bootServer(t, { __plan: 'free' });
  const r = await fetch(BASE + '/v1/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  assert.equal(r.status, 402, `body=${await r.clone().text()}`);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'tier_locked');
  assert.equal(j.tier_locked, true);
  assert.equal(j.required, 'Indie');
  assert.equal(j.upgrade, '/pricing');
});

test('W888-Q #4 — burst flag returns 429 rate_limited', async (t) => {
  const { BASE, apiKey } = await bootServer(t, { KOLM_ASSISTANT_CHAT_TEST_BURST: '1' });
  const r = await fetch(BASE + '/v1/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ prompt: 'burst' }),
  });
  assert.equal(r.status, 429, `body=${await r.clone().text()}`);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'rate_limited');
  assert.equal(j.limit, 60);
  assert.equal(typeof j.reset_in_ms, 'number');
});

test('W888-Q #5 — gateway cost > cap returns 200 ok:false budget_exceeded', async (t) => {
  const { BASE, apiKey } = await bootServer(t, { KOLM_ASSISTANT_CHAT_TEST_BUDGET: '1' });
  const r = await fetch(BASE + '/v1/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ prompt: 'expensive' }),
  });
  assert.equal(r.status, 200, `body=${await r.clone().text()}`);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'budget_exceeded');
  assert.equal(typeof j.cost_cap_usd, 'number');
  assert.ok(j.cost_cap_usd > 0);
});

test('W888-Q #6 — POST missing prompt returns 400 missing_prompt', async (t) => {
  const { BASE, apiKey } = await bootServer(t);
  const r = await fetch(BASE + '/v1/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ prompt: '   ' }),
  });
  assert.equal(r.status, 400, `body=${await r.clone().text()}`);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'missing_prompt');
});

// ─── Static asset lock-ins ──────────────────────────────────────────────────

test('W888-Q #7 — assistant-widget.js registers Ctrl+K listener + references /v1/assistant/chat', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'assistant-widget.js'), 'utf8');
  assert.ok(js.length > 500, 'widget JS must be more than a stub');
  // Ctrl+K shortcut handling — check both the key + meta/ctrl handling
  assert.match(js, /key\s*===?\s*['"]k['"]/i, 'widget must check for "k" key');
  assert.ok(/ctrlKey|metaKey/.test(js), 'widget must check ctrlKey or metaKey for the shortcut');
  // Endpoint reference
  assert.ok(js.includes('/v1/assistant/chat'), 'widget must POST to /v1/assistant/chat');
});

test('W888-Q #8 — assistant-widget.css declares --assistant- prefixed cool slate tokens', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'assistant-widget.css'), 'utf8');
  // Custom-property prefix
  assert.ok(css.includes('--assistant-'), 'CSS must declare --assistant- prefixed custom properties');
  // Cool slate dark mode anchor color (--surface-0 family)
  assert.match(css, /--assistant-bg\s*:\s*#0[ef][0-9a-f]/i, 'CSS must use cool slate dark background (#0e/0f range)');
  // 380px panel width
  assert.ok(css.includes('380px'), 'CSS must declare the 380px panel width');
  // 56px floating trigger button
  assert.ok(css.includes('56px'), 'CSS must declare the 56px trigger size');
});

test('W888-Q #9 — at least 5 /account/*.html pages reference /assets/assistant-widget.js', () => {
  const accountDir = path.join(ROOT, 'public', 'account');
  const files = fs.readdirSync(accountDir).filter((f) => f.endsWith('.html'));
  let hits = 0;
  const matched = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(accountDir, f), 'utf8');
    if (content.includes('/assets/assistant-widget.js')) {
      hits += 1;
      matched.push(f);
    }
  }
  assert.ok(hits >= 5, `expected >=5 /account/*.html files to reference the widget, got ${hits}: ${matched.join(', ')}`);
});

test('W888-Q #10 — widget panel surfaces role="dialog" + aria-labelledby (screen-reader friendly)', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'assistant-widget.js'), 'utf8');
  assert.ok(js.includes('role') && /['"]dialog['"]/.test(js), 'panel must set role="dialog"');
  assert.match(js, /aria-(labelledby|label)/, 'panel must wire aria-labelledby or aria-label');
});
