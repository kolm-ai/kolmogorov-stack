import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = path.join(os.tmpdir(), `kolm-c10-capture-idem-${process.pid}-${Date.now()}`);
fs.mkdirSync(scratch, { recursive: true });
process.env.KOLM_DATA_DIR = scratch;
process.env.KOLM_STORE_DRIVER = 'sqlite';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
process.env.RECIPE_RECEIPT_SECRET = 'test-receipt-secret-test-receipt-secret-32';
process.env.NODE_ENV = 'test';

const auth = await import('../src/auth.js');
const store = await import('../src/store.js');
const eventStore = await import('../src/event-store.js');
const captureStore = await import('../src/capture-store.js');
const { buildRouter } = await import('../src/router.js');

after(() => {
  try { if (eventStore._resetForTests) eventStore._resetForTests(); } catch {}
  try { if (captureStore._resetDriverCache) captureStore._resetDriverCache(); } catch {}
  try { store.close(); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

function unique(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  return app;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const base = `http://127.0.0.1:${srv.address().port}`;
        const out = await fn(base);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

async function postCapture(base, key, body, extraHeaders = {}) {
  return fetch(base + '/v1/capture/log', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function tenantEvents(tenantId, namespace) {
  return eventStore.listEvents({ tenant_id: tenantId, namespace, limit: 50 });
}

test('C10 capture/log Idempotency-Key replays same ids and prevents duplicate canonical events', async () => {
  const tenant = auth.provisionTenant(unique('c10-idem'), {
    plan: 'enterprise',
    quota: 100000,
    email: 'c10-idem@example.test',
  });

  await withServer(makeApp(), async (base) => {
    const namespace = unique('c10-capture');
    const payload = {
      namespace,
      provider: 'manual',
      model: 'kolm-c10',
      items: [
        { input: 'summarize invoice 123', output: 'invoice summary', latency_us: 12000 },
        { input: 'classify ticket 456', output: 'billing', latency_us: 18000 },
      ],
    };

    const first = await postCapture(base, tenant.api_key, payload, { 'Idempotency-Key': 'capture-retry-1' });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('x-kolm-idempotent-replay'), null);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.count, 2);
    assert.equal(firstBody.ids.length, 2);

    let events = await tenantEvents(tenant.id, namespace);
    assert.equal(events.length, 2, 'first request writes exactly two canonical events');

    const replay = await postCapture(base, tenant.api_key, payload, { 'Idempotency-Key': 'capture-retry-1' });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('x-kolm-idempotent-replay'), 'true');
    assert.equal(replay.headers.get('x-kolm-namespace'), namespace);
    const replayBody = await replay.json();
    assert.equal(replayBody.idempotent_replay, true);
    assert.deepEqual(replayBody.ids, firstBody.ids, 'replay returns the exact original capture ids');
    assert.equal(replayBody.count, 2);

    events = await tenantEvents(tenant.id, namespace);
    assert.equal(events.length, 2, 'replay must not append duplicate canonical events');
    assert.deepEqual(new Set(events.map((e) => e.event_id)), new Set(firstBody.ids));

    const changed = await postCapture(base, tenant.api_key, {
      ...payload,
      items: [{ input: 'same key but changed body', output: 'must conflict' }],
    }, { 'Idempotency-Key': 'capture-retry-1' });
    assert.equal(changed.status, 409);
    const changedBody = await changed.json();
    assert.equal(changedBody.error, 'idempotency_key_reused');
    assert.equal(changedBody.code, 'idempotency_conflict');

    events = await tenantEvents(tenant.id, namespace);
    assert.equal(events.length, 2, 'conflicting key reuse must not write more events');
  });
});

test('C10 body idempotency_key is honored and validation failures do not poison the key', async () => {
  const tenant = auth.provisionTenant(unique('c10-body-idem'), {
    plan: 'enterprise',
    quota: 100000,
    email: 'c10-body-idem@example.test',
  });

  await withServer(makeApp(), async (base) => {
    const namespace = unique('c10-body');
    const idempotencyKey = 'body-key-after-validation-failure';

    const invalid = await postCapture(base, tenant.api_key, {
      namespace,
      idempotency_key: idempotencyKey,
      items: [],
    });
    assert.equal(invalid.status, 400);

    const validPayload = {
      namespace,
      idempotency_key: idempotencyKey,
      provider: 'manual',
      model: 'kolm-c10-body',
      items: [{ input: 'valid after bad request', output: 'captured' }],
    };
    const first = await postCapture(base, tenant.api_key, validPayload);
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.count, 1);

    const replay = await postCapture(base, tenant.api_key, validPayload);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('x-kolm-idempotent-replay'), 'true');
    const replayBody = await replay.json();
    assert.deepEqual(replayBody.ids, firstBody.ids);

    const events = await tenantEvents(tenant.id, namespace);
    assert.equal(events.length, 1, 'body-key replay must not duplicate events');
  });
});
