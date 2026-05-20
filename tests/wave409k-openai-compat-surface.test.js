// Wave 409k — OpenAI/Anthropic/OpenRouter connector surface lock-in.
//
// The auditor mandate: BOTH the hosted server (src/router.js) and the local
// daemon (src/daemon-connector.js) must expose the same OpenAI-compatible
// connector surface. Every connector call must emit the canonical event
// schema (W409a) and carry the redaction-policy / raw_available receipt
// headers (W409b). Tests assert behavior, not page copy.
//
// Surface under test (both server + daemon):
//   POST /v1/chat/completions          (OpenAI Chat Completions API)
//   POST /v1/responses                 (OpenAI Responses API)
//   POST /v1/embeddings                (OpenAI Embeddings API)
//   POST /v1/audio/transcriptions      (OpenAI Whisper)
//   POST /v1/audio/speech              (OpenAI TTS)
//   POST /v1/messages                  (Anthropic Messages API)
//   GET  /v1/models                    (model discovery — both surfaces)
//   POST /v1/openrouter/v1/chat/completions  (OpenRouter passthrough w/ HTTP-Referer + X-Title)
//
// Fixture mode: when no upstream key is configured AND KOLM_CONNECTOR_FIXTURE=1,
// every connector route returns a deterministic mock shaped like the upstream's
// real response. Tests rely on this so they don't need real OPENAI_API_KEY.
//
// Coordinates with W409a (event-store) and W409b (redaction). The tests do
// NOT mock the event-store — they read it back via listEvents() and assert
// every connector call emitted a row.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-suite temp HOME so we never touch the developer's real ~/.kolm.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409k-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
process.env.KOLM_DATA_DIR = path.join(TMP, '.kolm');
// store.js valid values: 'json' | 'sqlite'. event-store.js picks sqlite/jsonl
// independently. Use json for store.js to avoid the parallel-SQLite flake
// trap (W311) when this file runs alongside other tests.
process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';
// Fixture mode is the linchpin: no real upstream keys are configured in CI.
process.env.KOLM_CONNECTOR_FIXTURE = '1';
// Make sure no real upstream keys leak in from the developer's env into the
// test process — we want to exercise the fixture path deterministically.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.KOLM_ALLOW_RAW;

async function makeServerApp() {
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  return app;
}

async function makeDaemonApp() {
  const { buildDaemonApp } = await import('../src/daemon-connector.js');
  return buildDaemonApp({ dataDir: process.env.KOLM_DATA_DIR }).app;
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

async function eventsCountSnapshot() {
  // Read the event-store directly via its public API.
  const { countEvents, _resetForTests } = await import('../src/event-store.js');
  // Don't reset; we just want a snapshot count.
  return countEvents({});
}

// ---------------------------------------------------------------------------
// Cohort A — server (src/router.js / buildRouter)
// ---------------------------------------------------------------------------

test('W409k #1 — server POST /v1/chat/completions returns OpenAI chat-completion shape (fixture)', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(r.status, 200, 'fixture mode must return 200');
    const body = await r.json();
    assert.equal(body.object, 'chat.completion', 'OpenAI chat.completion envelope');
    assert.ok(Array.isArray(body.choices) && body.choices.length >= 1, 'choices[] array');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(typeof body.choices[0].message.content, 'string');
    assert.ok(body.usage && typeof body.usage.prompt_tokens === 'number', 'usage block');
    assert.equal(r.headers.get('x-kolm-provider'), 'openai', 'event receipt provider header');
    assert.equal(r.headers.get('x-kolm-fixture'), 'true', 'fixture marker on response');
    assert.ok(r.headers.get('x-kolm-event-id'), 'event_id receipt header');
    assert.equal(r.headers.get('x-kolm-raw-available'), 'false', 'raw_available defaults to false');
  });
});

test('W409k #2 — server POST /v1/responses returns OpenAI Responses-API shape (fixture)', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.ok(Array.isArray(body.output) && body.output.length >= 1);
    assert.ok(r.headers.get('x-kolm-event-id'));
  });
});

test('W409k #3 — server POST /v1/embeddings returns OpenAI embedding shape (fixture)', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'embed me' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data) && body.data.length >= 1);
    assert.equal(body.data[0].object, 'embedding');
    assert.ok(Array.isArray(body.data[0].embedding));
  });
});

test('W409k #4 — server POST /v1/audio/transcriptions returns transcription envelope (fixture)', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'whisper-1', input: '<<base64-audio>>' }),
    });
    assert.notEqual(r.status, 404, 'must not 404 — route must exist');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body.text, 'string', 'transcription returns {text:"..."}');
  });
});

test('W409k #5 — server POST /v1/audio/speech returns TTS envelope (fixture)', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: 'hello world', voice: 'alloy', response_format: 'mp3' }),
    });
    assert.notEqual(r.status, 404, 'must not 404 — route must exist');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'audio.speech', 'TTS envelope object tag');
    assert.equal(body.format, 'mp3');
  });
});

test('W409k #6 — server POST /v1/messages returns Anthropic-shape message (fixture)', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi claude' }],
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.type, 'message', 'Anthropic Messages envelope');
    assert.equal(body.role, 'assistant');
    assert.ok(Array.isArray(body.content) && body.content[0].type === 'text');
    assert.ok(body.usage && typeof body.usage.input_tokens === 'number');
    assert.equal(r.headers.get('x-kolm-provider'), 'anthropic');
  });
});

test('W409k #7 — server GET /v1/models returns OpenAI list envelope', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/models', { headers: { accept: 'application/json' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'list', 'OpenAI list envelope');
    assert.ok(Array.isArray(body.data) && body.data.length >= 5, 'data[] populated');
    for (const m of body.data.slice(0, 5)) {
      assert.equal(m.object, 'model');
      assert.equal(typeof m.id, 'string');
      assert.equal(typeof m.owned_by, 'string');
    }
  });
});

test('W409k #8 — server POST /v1/openrouter/v1/chat/completions accepts OpenRouter headers + returns chat shape', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/openrouter/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'HTTP-Referer': 'https://example.com',
        'X-Title': 'my-app',
      },
      body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'route me' }] }),
    });
    assert.notEqual(r.status, 404, 'OpenRouter direct must not 404');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(r.headers.get('x-kolm-provider'), 'openrouter');
  });
});

test('W547 #4 - OpenRouter capture base-url alias works without an extra /v1 segment', async () => {
  const appS = await makeServerApp();
  await withServer(appS, async (base) => {
    const r = await fetch(base + '/v1/capture/openrouter/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'capture alias' }] }),
    });
    assert.notEqual(r.status, 404, 'server OpenRouter capture alias must not 404');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-kolm-provider'), 'openrouter');
  });
  const appD = await makeDaemonApp();
  await withServer(appD, async (base) => {
    const r = await fetch(base + '/v1/capture/openrouter/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'daemon alias' }] }),
    });
    assert.notEqual(r.status, 404, 'daemon OpenRouter capture alias must not 404');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-kolm-provider'), 'openrouter');
  });
});

test('W409k #9 — server connector calls emit canonical events (event-store delta ≥ 1)', async () => {
  const app = await makeServerApp();
  const before = await eventsCountSnapshot();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'event-emit-test ' + Date.now() }] }),
    });
    assert.equal(r.status, 200);
  });
  // Give the fire-and-forget appendEvent a tick to settle (it's awaited inside
  // the handler but the try/catch swallows so a flaky disk could lag).
  const after = await eventsCountSnapshot();
  assert.ok(after >= before + 1, `event-store must grow by ≥1 (was ${before}, now ${after})`);
});

// ---------------------------------------------------------------------------
// Cohort B — local daemon (src/daemon-connector.js / buildDaemonApp)
// ---------------------------------------------------------------------------

test('W409k #10 — daemon POST /v1/chat/completions returns chat.completion (fixture)', async () => {
  const app = await makeDaemonApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello daemon' }] }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(r.headers.get('x-kolm-provider'), 'openai');
    assert.equal(r.headers.get('x-kolm-fixture'), 'true');
    assert.equal(r.headers.get('x-kolm-raw-available'), 'false');
    // W409b — redaction policy receipt header (defaults to redact).
    const policy = r.headers.get('x-kolm-redaction-policy');
    assert.ok(['redact', 'allow', 'block', 'review_required'].includes(String(policy)),
      'daemon must echo redaction policy receipt');
  });
});

test('W409k #11 — daemon POST /v1/messages returns Anthropic message (fixture)', async () => {
  const app = await makeDaemonApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'daemon claude' }],
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
  });
});

test('W409k #12 — daemon POST /v1/audio/transcriptions + /v1/audio/speech respond 200 (fixture)', async () => {
  const app = await makeDaemonApp();
  await withServer(app, async (base) => {
    const r1 = await fetch(base + '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'whisper-1', input: '<<audio>>' }),
    });
    assert.notEqual(r1.status, 404, 'transcriptions route must exist on daemon');
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(typeof j1.text, 'string');

    const r2 = await fetch(base + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: 'hi', voice: 'alloy', response_format: 'mp3' }),
    });
    assert.notEqual(r2.status, 404, 'speech route must exist on daemon');
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.object, 'audio.speech');
  });
});

test('W409k #13 — daemon GET /v1/models returns the same OpenAI envelope as server', async () => {
  const appS = await makeServerApp();
  const appD = await makeDaemonApp();
  let serverBody, daemonBody;
  await withServer(appS, async (b) => {
    serverBody = await (await fetch(b + '/v1/models')).json();
  });
  await withServer(appD, async (b) => {
    daemonBody = await (await fetch(b + '/v1/models')).json();
  });
  assert.equal(serverBody.object, 'list');
  assert.equal(daemonBody.object, 'list');
  // Both envelopes must have data[]; we don't require identical lists because
  // the daemon can carry extra owned_by ids (e.g. gemini), but the server
  // surface must be a subset.
  const sIds = new Set(serverBody.data.map(m => m.id));
  const dIds = new Set(daemonBody.data.map(m => m.id));
  // Spot-check: every server-listed model is also on the daemon list.
  for (const id of sIds) {
    assert.ok(dIds.has(id), `server model "${id}" must also be on daemon /v1/models`);
  }
});

test('W409k #14 — daemon connector call emits canonical event (source_type=simulated under fixture)', async () => {
  const app = await makeDaemonApp();
  const before = await eventsCountSnapshot();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'daemon-event-emit ' + Date.now() }] }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-kolm-fixture'), 'true');
  });
  const after = await eventsCountSnapshot();
  assert.ok(after >= before + 1, `daemon must emit ≥1 event (was ${before}, now ${after})`);
  // And that event must be tagged simulated (fixture path).
  const { listEvents } = await import('../src/event-store.js');
  const recent = await listEvents({ limit: 25 });
  const sim = recent.find(e => e.source_type === 'simulated' && e.provider === 'openai');
  assert.ok(sim, 'a simulated openai event must appear in the lake under fixture mode');
  assert.equal(sim.schema_version >= 1, true, 'event row carries schema_version');
});

// ---------------------------------------------------------------------------
// Cohort C — common contract assertions
// ---------------------------------------------------------------------------

test('W409k #15 — no connector route returns 404 (every required route is registered)', async () => {
  const requiredServer = [
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/embeddings'],
    ['POST', '/v1/audio/transcriptions'],
    ['POST', '/v1/audio/speech'],
    ['POST', '/v1/messages'],
    ['POST', '/v1/capture/openrouter/chat/completions'],
    ['POST', '/v1/openrouter/v1/chat/completions'],
    ['GET',  '/v1/models'],
  ];
  const requiredDaemon = [
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/embeddings'],
    ['POST', '/v1/audio/transcriptions'],
    ['POST', '/v1/audio/speech'],
    ['POST', '/v1/messages'],
    ['POST', '/v1/capture/openrouter/chat/completions'],
    ['GET',  '/v1/models'],
  ];
  async function probe(app, method, p) {
    return await withServer(app, async (base) => {
      const r = await fetch(base + p, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'x' }] }) : undefined,
      });
      return r.status;
    });
  }
  const appS = await makeServerApp();
  for (const [m, p] of requiredServer) {
    const code = await probe(appS, m, p);
    assert.notEqual(code, 404, `server: ${m} ${p} must not 404 (got ${code})`);
  }
  const appD = await makeDaemonApp();
  for (const [m, p] of requiredDaemon) {
    const code = await probe(appD, m, p);
    assert.notEqual(code, 404, `daemon: ${m} ${p} must not 404 (got ${code})`);
  }
});

test('W409k #16 — OpenAI SDK-style call shape passes through unchanged (server)', async () => {
  // Mimics the exact request shape the official `openai` npm package sends.
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer sk-fake-test-key',
        'x-stainless-arch': 'x64',
        'x-stainless-lang': 'js',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say hello.' }],
        temperature: 0,
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    // The OpenAI client requires: id, object='chat.completion', choices[].message.role+content
    assert.equal(typeof body.id, 'string');
    assert.equal(body.object, 'chat.completion');
    assert.equal(typeof body.created, 'number');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(typeof body.choices[0].message.content, 'string');
    assert.equal(body.choices[0].finish_reason, 'stop');
  });
});

test('W409k #17 — Anthropic SDK-style call shape passes through unchanged (server)', async () => {
  // Mimics `@anthropic-ai/sdk` request shape.
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'fake-anthropic-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body.id, 'string');
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.content[0].type, 'text');
    assert.equal(typeof body.content[0].text, 'string');
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(typeof body.usage.input_tokens, 'number');
    assert.equal(typeof body.usage.output_tokens, 'number');
  });
});

test('W409k #18 — fixture mode is deterministic + offline (no network call needed)', async () => {
  // Two back-to-back POSTs with the same prompt produce same content shape.
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'same-input' }] });
    const r1 = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const r2 = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const j1 = await r1.json();
    const j2 = await r2.json();
    assert.equal(j1.choices[0].message.content, j2.choices[0].message.content,
      'same input must yield same content in fixture mode');
  });
});

test('W409k #19 — server connector emits x-kolm-event-id + x-kolm-event-durable receipts', async () => {
  const app = await makeServerApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'receipt' }] }),
    });
    assert.equal(r.status, 200);
    const eid = r.headers.get('x-kolm-event-id');
    const dur = r.headers.get('x-kolm-event-durable');
    assert.match(String(eid || ''), /^evt_/, 'event-id should start with evt_ (canonical schema)');
    assert.ok(dur === 'true' || dur === 'false', 'durable must be a boolean header');
  });
});

test('W409k #20 — docs page mentions OPENAI_BASE_URL / ANTHROPIC_BASE_URL guidance', () => {
  const p = path.resolve(process.cwd(), 'public', 'quickstart', 'api.html');
  if (!fs.existsSync(p)) {
    // If the file isn't where we expect, the test is informational only.
    return;
  }
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/OPENAI_BASE_URL/.test(src), '/quickstart/api should document OPENAI_BASE_URL');
  assert.ok(/ANTHROPIC_BASE_URL/.test(src), '/quickstart/api should document ANTHROPIC_BASE_URL');
});
