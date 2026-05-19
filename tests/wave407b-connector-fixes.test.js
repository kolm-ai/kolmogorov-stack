// W407b — connector audit fixes.
//
// Locks in three P0 fixes the audit caught:
//   1. Default privacy policy is now 'redact' (was 'allow') so raw PII does
//      not land in the lake unless the user explicitly opts in.
//   2. GET /v1/models returns an OpenAI-shaped list with non-empty data so
//      SDKs that auto-discover models (langchain, llamaindex, OpenAI SDK
//      `.models.list()`) get a 200 instead of a 404.
//   3. The /v1/health per-provider block carries 4 explicit booleans
//      (configured, key_set, network_reachable, authenticated) so the old
//      misleading `upstream_reachable: true` signal can never reappear.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w407b-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const hdr = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers };
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', headers: hdr,
    }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET' }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    req.end();
  });
}

function spinMockUpstream() {
  const received = { last_prompt: '', count: 0 };
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    const m = (req.body && req.body.messages && req.body.messages[0] && req.body.messages[0].content) || '';
    received.last_prompt = String(m);
    received.count += 1;
    res.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || 'gpt-4o-mini',
      // Return constant content so the reinsert walk has no placeholders to swap.
      choices: [{ index: 0, message: { role: 'assistant', content: 'mock-reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port, received });
    });
  });
}

let _urlCounter = 0;
function pathToFileURLOnce(rel) {
  const abs = path.resolve(__dirname, rel);
  _urlCounter += 1;
  return 'file://' + abs.replace(/\\/g, '/') + '?w407b=' + _urlCounter;
}

async function startTestDaemon(env = {}) {
  for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
  const url = pathToFileURLOnce('../src/daemon-connector.js');
  const mod = await import(url);
  const PRpath = 'file://' + path.resolve(__dirname, '../src/provider-registry.js').replace(/\\/g, '/');
  const PRmod = await import(PRpath);
  if (env.KOLM_UPSTREAM_OPENAI_BASE) PRmod.PROVIDERS.openai.upstream = env.KOLM_UPSTREAM_OPENAI_BASE;
  const { server, port, pid } = await mod.startDaemon({ port: 0, host: '127.0.0.1' });
  return { server, port, pid, base: 'http://127.0.0.1:' + port, mod };
}

test('W407b #1 - default privacy policy is "redact" when no config + no env var', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, POLICY: process.env.KOLM_PRIVACY_POLICY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  delete process.env.KOLM_PRIVACY_POLICY;
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const h = await getJson(t.base + '/v1/health');
      assert.equal(h.status, 200);
      assert.equal(h.body.policy, 'redact', 'default policy must be redact, got ' + h.body.policy);
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.USERPROFILE || '';
    if (prev.POLICY != null) process.env.KOLM_PRIVACY_POLICY = prev.POLICY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W407b #2 - explicit privacy_policy=allow in config.json is still honored (opt-in path)', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, POLICY: process.env.KOLM_PRIVACY_POLICY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  delete process.env.KOLM_PRIVACY_POLICY;
  fs.mkdirSync(path.join(HOME, '.kolm'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.kolm', 'config.json'), JSON.stringify({ privacy_policy: 'allow' }));
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const h = await getJson(t.base + '/v1/health');
      assert.equal(h.body.policy, 'allow', 'config.json opt-in must override default');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.USERPROFILE || '';
    if (prev.POLICY != null) process.env.KOLM_PRIVACY_POLICY = prev.POLICY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W407b #3 - GET /v1/models returns 200 with non-empty OpenAI-shaped data', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const r = await getJson(t.base + '/v1/models');
      assert.equal(r.status, 200);
      assert.equal(r.body.object, 'list', 'response.object must be "list"');
      assert.ok(Array.isArray(r.body.data), 'response.data must be an array');
      assert.ok(r.body.data.length > 0, 'response.data must be non-empty');
      // Each entry must be OpenAI-model shaped.
      for (const m of r.body.data) {
        assert.equal(typeof m.id, 'string', 'model.id is string');
        assert.equal(m.object, 'model');
        assert.equal(typeof m.created, 'number');
        assert.equal(typeof m.owned_by, 'string');
      }
      // Must include at least one known OpenAI model from PROVIDERS.openai.
      const ids = new Set(r.body.data.map((m) => m.id));
      assert.ok(ids.has('gpt-4o-mini') || ids.has('gpt-4o'), 'must include an openai model');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.USERPROFILE || '';
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W407b #4 - raw SSN does not land in the lake when default policy is in effect', async () => {
  const HOME = isolatedHome();
  const prev = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    POLICY: process.env.KOLM_PRIVACY_POLICY, KEY: process.env.OPENAI_API_KEY,
  };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  delete process.env.KOLM_PRIVACY_POLICY;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  const SSN = '123-45-6789';
  const EMAIL = 'jane.doe@example.com';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const prompt = `my ssn is ${SSN} and email is ${EMAIL}`;
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
      assert.equal(r.status, 200, 'expected 200, got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
      assert.ok(r.headers['x-kolm-event-id'], 'missing x-kolm-event-id');

      // 1. Verify mock upstream NEVER saw the raw SSN/email (was redacted out).
      // We read directly from the mock's server-side capture so reinsert on
      // the way back to the caller can't mask what the upstream actually got.
      const upstreamSaw = String(up.received.last_prompt || '');
      assert.ok(upstreamSaw.length > 0, 'mock upstream did not record a prompt');
      assert.ok(!upstreamSaw.includes(SSN), 'mock upstream received raw SSN: ' + upstreamSaw);
      assert.ok(!upstreamSaw.includes(EMAIL), 'mock upstream received raw email: ' + upstreamSaw);
      assert.ok(upstreamSaw.includes('VAR_'), 'expected placeholders in upstream prompt, got: ' + upstreamSaw);

      // 2. Verify the lake (capture store) row does not contain the raw SSN.
      const csMod = await import(pathToFileURLOnce('../src/capture-store.js'));
      // W411 local-daemon mode stamps tenant_id = `local:<hostname>` sentinel
      // (not the bare 'local' literal). The store may have accumulated rows
      // across dev runs (./data/kolm.sqlite persists), so use a high limit
      // and try both tenants to find the row by event_id.
      const sentinelTenant = 'local:' + (os.hostname() || 'host');
      const evid = r.headers['x-kolm-event-id'];
      let rows = await csMod.listCaptures(sentinelTenant, 'default', 100000);
      let row = rows.find((x) => x.id === evid || x.event_id === evid);
      if (!row) {
        rows = await csMod.listCaptures('local', 'default', 100000);
        row = rows.find((x) => x.id === evid || x.event_id === evid);
      }
      assert.ok(row, 'expected a row for ' + evid + ' (have ' + rows.length + ')');
      const haystack = JSON.stringify(row);
      assert.ok(!haystack.includes(SSN), 'lake row contains raw SSN: ' + haystack.slice(0, 400));
      assert.ok(!haystack.includes(EMAIL), 'lake row contains raw email: ' + haystack.slice(0, 400));
      // Sanity: the redacted placeholders should be present somewhere.
      assert.ok(
        haystack.includes('VAR_SSN') || haystack.includes('VAR_EMAIL'),
        'expected at least one VAR_ placeholder in the lake row'
      );
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.USERPROFILE || '';
    if (prev.POLICY != null) process.env.KOLM_PRIVACY_POLICY = prev.POLICY;
    if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY; else delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W407b #5 - /v1/health per-provider block carries the 4-field connector health (no legacy upstream_reachable)', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const h = await getJson(t.base + '/v1/health');
      assert.equal(h.status, 200);
      const provs = h.body.providers || {};
      for (const [id, p] of Object.entries(provs)) {
        assert.equal(typeof p.configured, 'boolean', id + '.configured');
        assert.equal(typeof p.key_set, 'boolean', id + '.key_set');
        assert.equal(typeof p.network_reachable, 'boolean', id + '.network_reachable');
        assert.equal(typeof p.authenticated, 'boolean', id + '.authenticated');
        // Legacy field MUST NOT reappear under that name.
        assert.equal(typeof p.upstream_reachable, 'undefined',
          id + ' still carries legacy upstream_reachable — must be removed');
      }
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.USERPROFILE || '';
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});
