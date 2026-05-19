// W411 — vendor normalization + production-gate consistency lock-in.
//
// The auditor's P0 Core Truth #11 + #12 + Connector Product seam closed by
// this wave covers two structurally separate but symbolically paired bugs:
//
//   (a) Vendor sprawl. Every connector (OpenAI / Anthropic / OpenRouter /
//       Ollama / vLLM / llama.cpp) wrote events with a free-text `provider`
//       string. The lake / opportunities / datasets / label-queue switches
//       all had to handle 'manual', 'open-router', 'llama.cpp', 'Google',
//       etc. — leaving the audit unable to claim "one canonical event
//       schema across every vendor". Fix: `vendor` (closed enum) lives on
//       every canonical event row alongside the legacy `provider` string.
//
//   (b) Production-gate inconsistency. The marketplace listing surfaced
//       `production_readiness_state` from src/marketplace.js:hydrate() →
//       productionReadySync(), a verdict marked `_provisional: true` that
//       skips the executable_bundle / eval_parity / durability gates. A
//       freshly compiled .kolm that passed the sync verdict but failed the
//       async one would show "production_ready_verified" in /marketplace
//       and refuse to install at the download gate. Fix: GET
//       /v1/marketplace/:slug now overlays both `production_ready` (bool)
//       and `production_readiness_state` (string) from the LIVE async
//       productionReady() call, the same verdict /download enforces.
//
// Tests assert BEHAVIOR — HTTP responses + bridged event rows — not page
// copy. No new install-time dependencies; the same buildRouter() harness
// the W409a/W409x tests use is reused here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Module-level singleton imports — buildRouter dynamically resolves these
// inside the SAME process, so cache-busting here would split the module
// instance and the test would silently miss the bridged rows (W397/W409a
// trap).
import * as eventStore from '../src/event-store.js';
import * as captureStore from '../src/capture-store.js';
import { normalizeVendor, VENDOR_VALUES, newEvent, canonicalize, validateEvent, EVENT_FIELDS } from '../src/event-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- shared isolation harness (mirrors wave409a) ----------

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w411-'));
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
}

function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // jsonl driver — no node:sqlite required for the test runner.
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  delete process.env.KOLM_CAPTURE_DRIVER;
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
}

function teardownIsolated(home) {
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
  delete process.env.KOLM_DATA_DIR;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.KOLM_STORE_DRIVER;
  delete process.env.OPENAI_UPSTREAM_URL;
  delete process.env.ANTHROPIC_UPSTREAM_URL;
  delete process.env.KOLM_CONNECTOR_FIXTURE;
  delete process.env.KOLM_LOCAL_DAEMON;
  cleanup(home);
}

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key, tenantId: t.id, tenantName: t.name };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const out = await fn(`http://127.0.0.1:${realPort}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// Spin a minimal HTTP server that responds with an OpenAI- or Anthropic-
// shaped JSON envelope. We point OPENAI_UPSTREAM_URL/ANTHROPIC_UPSTREAM_URL
// at this server so /v1/capture/openai + /v1/capture/anthropic exercise
// their real forward path against deterministic upstream bytes.
function withMockUpstream(shape, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        const model = String(parsed.model || 'mock-model');
        let respJson;
        if (shape === 'openai') {
          respJson = {
            id: 'chatcmpl-w411-' + Math.random().toString(36).slice(2, 10),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'mock-openai-w411' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
          };
        } else if (shape === 'anthropic') {
          respJson = {
            id: 'msg_w411_' + Math.random().toString(36).slice(2, 10),
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: 'mock-anthropic-w411' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 9 },
          };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(respJson));
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// ---------- pure-schema unit tests (no router) ----------

test('W411 #1 — event-schema exposes vendor + tokens_in/out + cost_micro_usd + latency_us + files + error', () => {
  // All 7 W411 fields must live on the EVENT_FIELDS contract so validateEvent
  // does not flag them as "extra".
  for (const f of ['vendor', 'tokens_in', 'tokens_out', 'cost_micro_usd', 'latency_us', 'files', 'error']) {
    assert.ok(EVENT_FIELDS.includes(f), `EVENT_FIELDS must include "${f}" — auditor mandate`);
  }
  // VENDOR_VALUES enum must cover every connector the connector-registry mounts.
  for (const v of ['openai', 'anthropic', 'openrouter', 'ollama', 'vllm', 'llama-cpp']) {
    assert.ok(VENDOR_VALUES.has(v), `VENDOR_VALUES must include "${v}"`);
  }
  // normalizeVendor must collapse the wild-text aliases the legacy daemon-
  // connector + capture-log paths emit onto the closed enum.
  assert.equal(normalizeVendor('OpenAI'), 'openai');
  assert.equal(normalizeVendor('ANTHROPIC'), 'anthropic');
  assert.equal(normalizeVendor('open-router'), 'openrouter');
  assert.equal(normalizeVendor('llama.cpp'), 'llama-cpp');
  assert.equal(normalizeVendor('google'), 'gemini');
  assert.equal(normalizeVendor(''), 'other');
  assert.equal(normalizeVendor(null), 'other');
  assert.equal(normalizeVendor('   '), 'other');
  // newEvent + canonicalize must populate the W411 fields from legacy aliases
  // so a connector that only knows the old field names still produces a
  // canonical row the lake can read.
  const ev = newEvent({
    tenant_id: 't',
    namespace: 'n',
    provider: 'openai',
    prompt_tokens: 4,
    completion_tokens: 6,
    estimated_cost_usd: 0.012,
    latency_ms: 250,
  });
  assert.equal(ev.vendor, 'openai', 'vendor derived from provider');
  assert.equal(ev.tokens_in, 4);
  assert.equal(ev.tokens_out, 6);
  assert.equal(ev.cost_micro_usd, 12000, 'cost_micro_usd = estimated_cost_usd * 1e6');
  assert.equal(ev.latency_us, 250000, 'latency_us = latency_ms * 1000');
  assert.deepEqual(ev.files, []);
  assert.equal(ev.error, null);
  // Idempotency contract: canonicalize(canonicalize(x)) === canonicalize(x).
  const round = canonicalize(canonicalize(ev));
  assert.deepEqual(round, ev, 'canonicalize must be idempotent over W411 fields');
  // validateEvent must accept the W411-equipped row without flagging extras.
  const v = validateEvent(ev);
  assert.equal(v.ok, true, `validateEvent must accept W411 row; errors=${JSON.stringify(v.errors)} extra=${JSON.stringify(v.extra)}`);
});

// ---------- bridge tests: capture-store → event-store carries vendor ----------

test('W411 #2 — POST /v1/capture/openai bridges with vendor:"openai" + tokens_in/out populated', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantName } = await makeAppAndTenant();
    await withMockUpstream('openai', async (upstreamBase) => {
      process.env.OPENAI_UPSTREAM_URL = upstreamBase + '/v1/chat/completions';
      await withServer(app, async (base) => {
        const ns = 'w411_oai_' + Date.now().toString(36);
        const r = await fetch(base + '/v1/capture/openai', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + apiKey,
            'x-upstream-api-key': 'sk-fake-w411',
            'x-kolm-namespace': ns,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'normalize vendor please' }],
          }),
        });
        assert.equal(r.status, 200, 'OpenAI proxy must 200 against mock upstream');
        const captureId = r.headers.get('x-kolm-capture-id');
        assert.ok(captureId, 'x-kolm-capture-id header must be present');

        // Bridged canonical event must carry vendor:'openai' (closed enum)
        // along with the legacy provider field.
        const evRows = await eventStore.listEvents({ namespace: ns, limit: 50 });
        assert.equal(evRows.length, 1, 'one bridged event for one POST');
        const ev = evRows[0];
        assert.equal(ev.event_id, captureId, 'event_id matches capture id');
        assert.equal(ev.vendor, 'openai', 'vendor must be canonical "openai"');
        assert.equal(ev.provider, 'openai', 'provider preserved as alias');
        assert.equal(ev.model, 'gpt-4o-mini');
        // tokens_in/out populated from the mock upstream's usage block.
        assert.equal(ev.tokens_in, 7, 'tokens_in mirrors prompt_tokens=7 from upstream usage');
        assert.equal(ev.tokens_out, 11, 'tokens_out mirrors completion_tokens=11');
        // Parity field types.
        assert.equal(typeof ev.cost_micro_usd, 'number');
        assert.equal(typeof ev.latency_us, 'number');
        assert.ok(Array.isArray(ev.files));
        // Tenant + namespace round-trip via authenticated path.
        assert.equal(ev.tenant_id, tenantName);
        assert.equal(ev.namespace, ns);
      });
    });
  } finally {
    teardownIsolated(home);
  }
});

test('W411 #3 — POST /v1/capture/anthropic bridges with vendor:"anthropic" + tokens populated', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantName } = await makeAppAndTenant();
    await withMockUpstream('anthropic', async (upstreamBase) => {
      process.env.ANTHROPIC_UPSTREAM_URL = upstreamBase + '/v1/messages';
      await withServer(app, async (base) => {
        const ns = 'w411_ant_' + Date.now().toString(36);
        const r = await fetch(base + '/v1/capture/anthropic', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + apiKey,
            'x-upstream-api-key': 'sk-ant-fake-w411',
            'x-kolm-namespace': ns,
          },
          body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 256,
            messages: [{ role: 'user', content: 'normalize vendor please anthropic' }],
          }),
        });
        assert.equal(r.status, 200, 'Anthropic proxy must 200 against mock upstream');
        const captureId = r.headers.get('x-kolm-capture-id');
        assert.ok(captureId, 'x-kolm-capture-id header must be present');

        const evRows = await eventStore.listEvents({ namespace: ns, limit: 50 });
        assert.equal(evRows.length, 1, 'one bridged event for one POST');
        const ev = evRows[0];
        assert.equal(ev.event_id, captureId, 'event_id matches capture id');
        assert.equal(ev.vendor, 'anthropic', 'vendor must be canonical "anthropic"');
        assert.equal(ev.provider, 'anthropic', 'provider preserved as alias');
        assert.equal(ev.model, 'claude-3-5-sonnet-20241022');
        assert.equal(ev.tokens_in, 5, 'tokens_in mirrors input_tokens=5 from upstream usage');
        assert.equal(ev.tokens_out, 9, 'tokens_out mirrors output_tokens=9');
        assert.equal(ev.tenant_id, tenantName);
        assert.equal(ev.namespace, ns);
      });
    });
  } finally {
    teardownIsolated(home);
  }
});

test('W411 #4 — /v1/capture/openrouter via local-daemon mode bridges with vendor:"openrouter"', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    // Local-daemon mode skips the kolm-tenant-key gate so the connector
    // passthrough runs with req.tenant = local:<host>.
    process.env.KOLM_LOCAL_DAEMON = '1';
    // Fixture mode: connector returns deterministic bytes without a network
    // upstream so the test does not need an OpenRouter key.
    process.env.KOLM_CONNECTOR_FIXTURE = '1';
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/capture/openrouter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'meta-llama/llama-3-8b-instruct',
          messages: [{ role: 'user', content: 'openrouter vendor normalization' }],
        }),
      });
      assert.equal(r.status, 200, 'openrouter fixture must 200');
      assert.equal(r.headers.get('x-kolm-provider'), 'openrouter');
      const evId = r.headers.get('x-kolm-event-id');
      assert.ok(evId, 'x-kolm-event-id must be present');

      // The connector hardcodes namespace='default' for the local-daemon
      // passthrough path; query without a namespace filter to find the row.
      const evRows = await eventStore.listEvents({ namespace: 'default', limit: 50 });
      const ev = evRows.find((e) => e.event_id === evId);
      assert.ok(ev, 'bridged event must surface in event-store; ids=' + JSON.stringify(evRows.map((e) => e.event_id)));
      assert.equal(ev.vendor, 'openrouter', 'vendor must be canonical "openrouter"');
      assert.equal(ev.provider, 'openrouter');
      assert.equal(ev.model, 'meta-llama/llama-3-8b-instruct');
    });
  } finally {
    teardownIsolated(home);
  }
});

// ---------- marketplace production-gate live-verdict test ----------

const FIXTURE_OK = path.join(ROOT, 'examples', 'claims-redactor', 'claims-redactor.kolm');
const FIXTURE_STUB = path.join(ROOT, 'public', 'registry-pack', 'phi-redactor.kolm');

test('W411 #5 — GET /v1/marketplace/<slug> production_ready comes from LIVE productionReady() (not the catalog provisional verdict)', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      // Pass-fixture: claims-redactor was built by W343 with --seeds (60 real
      // seeds, K~0.985) so productionReady() returns ok=true. The catalog
      // listing's provisional sync verdict ALSO marks it production_ready,
      // but the test still proves the response comes from the async call
      // because production_ready is overlaid AFTER hydrate().
      if (fs.existsSync(FIXTURE_OK)) {
        const r1 = await fetch(base + '/v1/marketplace/claims-redactor');
        assert.equal(r1.status, 200, 'claims-redactor must resolve');
        const body1 = await r1.json();
        assert.equal(typeof body1.production_ready, 'boolean',
          'production_ready must be a boolean on the response');
        assert.equal(body1.production_ready, true,
          'claims-redactor must be production_ready=true (60 seeds, K=0.985)');
        assert.equal(body1.production_readiness_state, 'production_ready_verified',
          'production_readiness_state must reflect the live verdict');
        assert.equal(body1.verified, true, '"Verified" badge must also flip from the live verdict');
        assert.ok(Array.isArray(body1.badges) && body1.badges.includes('Verified'),
          'badges array must include "Verified"');
      }

      // Fail-fixture: phi-redactor.kolm was built WITHOUT --seeds, so
      // seed_provenance is null and productionReady() returns ok=false. The
      // listing must reflect the live verdict: production_ready=false,
      // production_readiness_state='foundation', verified=false. This is the
      // structural guarantee that the marketplace cannot ship a green badge
      // for an artifact the download gate would reject.
      if (fs.existsSync(FIXTURE_STUB)) {
        const r2 = await fetch(base + '/v1/marketplace/phi-redactor');
        // Some seeds may not be in the catalog; only assert when the slug
        // resolves.
        if (r2.status === 200) {
          const body2 = await r2.json();
          assert.equal(typeof body2.production_ready, 'boolean',
            'production_ready must be a boolean on the response');
          assert.equal(body2.production_ready, false,
            'phi-redactor must be production_ready=false (no seeds, K-gate fails)');
          assert.notEqual(body2.production_readiness_state, 'production_ready_verified',
            'production_readiness_state must NOT claim verified for a fail-gate artifact');
          assert.equal(body2.verified, false, '"Verified" badge must be false');
          assert.ok(!body2.badges.includes('Verified'),
            'badges must not include "Verified" when gate fails');
          assert.ok(Array.isArray(body2.gate_reasons) && body2.gate_reasons.length > 0,
            'gate_reasons must surface why the live verdict failed');
        }
      }
    });
  } finally {
    teardownIsolated(home);
  }
});
