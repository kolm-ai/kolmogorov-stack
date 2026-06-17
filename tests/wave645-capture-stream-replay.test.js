// W645 - capture SSE durable replay fallback.
//
// The live capture tail is intentionally in-process. A reconnect may land on a
// different replica, so /v1/capture/stream must backfill recent durable capture
// rows by cursor before relying on the in-process live stream.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function freshEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w645-capture-stream-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  process.env.KOLM_ENV = 'test';
  delete process.env.KOLM_CAPTURE_DRIVER;
  delete process.env.KOLM_STORE_DRIVER;
  delete process.env.VERCEL;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
}

async function startApp(t) {
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    try { server.close(); } catch (_) {}
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function parseSse(text) {
  return text.split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const out = { event: 'message', id: null, data: null, raw: block };
      const data = [];
      for (const line of block.split(/\n/)) {
        if (line.startsWith('event:')) out.event = line.slice(6).trim();
        else if (line.startsWith('id:')) out.id = line.slice(3).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) {
        const joined = data.join('\n');
        try { out.data = JSON.parse(joined); } catch { out.data = joined; }
      }
      return out;
    });
}

async function readUntilReplayComplete(url, headers) {
  const res = await fetch(url, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('event: replay_complete') || text.includes('event: replay_error')) break;
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
  return text;
}

test('W645 capture stream replays bounded durable captures after the caller cursor', async (t) => {
  freshEnv(t);
  const { provisionTenant } = await import('../src/auth.js');
  const { insertCapture } = await import('../src/capture-store.js');
  const tenant = provisionTenant('w645-stream-' + Date.now(), { plan: 'pro' });
  const other = provisionTenant('w645-other-' + Date.now(), { plan: 'pro' });
  const base = await startApp(t);

  const cursor = '2026-06-18T12:00:00.000Z';
  await insertCapture({
    id: 'cap-before-cursor',
    tenant: tenant.id,
    corpus_namespace: 'support',
    created_at: '2026-06-18T11:59:59.000Z',
    model: 'claude-sonnet',
    provider: 'anthropic',
    prompt: 'old prompt',
    response: 'old response',
    status: 200,
  });
  await insertCapture({
    id: 'cap-replay-support',
    tenant: tenant.id,
    corpus_namespace: 'support',
    created_at: '2026-06-18T12:00:01.000Z',
    model: 'claude-sonnet',
    provider: 'anthropic',
    prompt: 'support prompt',
    response: 'support response',
    status: 200,
  });
  await insertCapture({
    id: 'cap-replay-sales',
    tenant: tenant.id,
    corpus_namespace: 'sales',
    created_at: '2026-06-18T12:00:02.000Z',
    model: 'gpt-4.1',
    provider: 'openai',
    prompt: 'sales prompt',
    response: 'sales response',
    status: 200,
  });
  await insertCapture({
    id: 'cap-foreign-tenant',
    tenant: other.id,
    corpus_namespace: 'support',
    created_at: '2026-06-18T12:00:03.000Z',
    model: 'gpt-4.1',
    provider: 'openai',
    prompt: 'foreign prompt',
    response: 'foreign response',
    status: 200,
  });

  const text = await readUntilReplayComplete(
    `${base}/v1/capture/stream?since=${encodeURIComponent(cursor)}&replay_limit=5`,
    { authorization: `Bearer ${tenant.api_key}` }
  );
  const events = parseSse(text);
  const captures = events.filter((e) => e.event === 'capture').map((e) => e.data);
  assert.deepEqual(captures.map((e) => e.capture_id), ['cap-replay-support', 'cap-replay-sales']);
  assert.deepEqual(captures.map((e) => e.replayed), [true, true]);
  assert.equal(captures[0].prompt_head, 'support prompt');
  assert.equal(captures[1].namespace, 'sales');
  assert.equal(captures.some((e) => e.capture_id === 'cap-before-cursor'), false);
  assert.equal(captures.some((e) => e.capture_id === 'cap-foreign-tenant'), false);

  const replayComplete = events.find((e) => e.event === 'replay_complete');
  assert.equal(replayComplete.data.ok, true);
  assert.equal(replayComplete.data.replayed, 2);
  assert.equal(replayComplete.data.since, cursor);
});

test('W645 capture stream namespace replay keeps the old namespace filter semantics', async (t) => {
  freshEnv(t);
  const { provisionTenant } = await import('../src/auth.js');
  const { insertCapture } = await import('../src/capture-store.js');
  const tenant = provisionTenant('w645-ns-' + Date.now(), { plan: 'pro' });
  const base = await startApp(t);

  await insertCapture({
    id: 'cap-support-only',
    tenant: tenant.id,
    corpus_namespace: 'support',
    created_at: '2026-06-18T13:00:01.000Z',
    prompt: 'support prompt',
    response: 'support response',
    status: 200,
  });
  await insertCapture({
    id: 'cap-sales-filtered',
    tenant: tenant.id,
    corpus_namespace: 'sales',
    created_at: '2026-06-18T13:00:02.000Z',
    prompt: 'sales prompt',
    response: 'sales response',
    status: 200,
  });

  const text = await readUntilReplayComplete(
    `${base}/v1/capture/stream?namespace=support&last_seen=${encodeURIComponent('2026-06-18T13:00:00.000Z')}`,
    { authorization: `Bearer ${tenant.api_key}` }
  );
  const captures = parseSse(text).filter((e) => e.event === 'capture').map((e) => e.data);
  assert.deepEqual(captures.map((e) => e.capture_id), ['cap-support-only']);
  assert.equal(captures[0].namespace, 'support');
});
