// W692 - direct contract test for api/teacher-chat.js.
//
// The Vercel function is a provider/API boundary. These tests exercise the
// handler directly with mocked req/res/fetch so no live provider or Railway
// call is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import handler, {
  TEACHER_CHAT_LIMITS,
  TEACHER_CHAT_VERSION,
  VENDOR_KEYS,
} from '../api/teacher-chat.js';

const HEX_64 = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function mockReq({ method = 'GET', headers = {}, body = undefined } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, headers: lower, body };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function withEnv(patch, fn) {
  const keys = new Set(Object.values(VENDOR_KEYS).flat());
  for (const k of Object.keys(patch || {})) keys.add(k);
  const previous = new Map();
  for (const k of keys) {
    previous.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v != null) process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      const v = previous.get(k);
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withFetch(mock, fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

function response({ ok = true, status = 200, json = {}, text = '' } = {}) {
  return {
    ok,
    status,
    async json() { return json; },
    async text() { return text; },
  };
}

test('W692 teacher-chat API is wired into depth and pins hardened source controls', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../api/teacher-chat.js', import.meta.url), 'utf8');

  assert.equal(TEACHER_CHAT_VERSION, 'w692-v1');
  assert.equal(
    pkg.scripts['verify:teacher-chat-api'],
    'node --test --test-concurrency=1 tests/wave692-teacher-chat-api-contract.test.js',
  );
  assert.ok(pkg.scripts['verify:depth'].includes('npm run verify:teacher-chat-api'));
  assert.match(source, /function _cacheKey/);
  assert.match(source, /fetchWithTimeout/);
  assert.match(source, /safeText/);
  assert.match(source, /request_sha256/);
  assert.doesNotMatch(source, /proxy_key_source/);
});

test('W692 GET health exposes vendor booleans without env var names', async () => withEnv({
  OPENAI_API_KEY: 'sk-openai-test-key',
}, async () => {
  const res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, TEACHER_CHAT_VERSION);
  assert.equal(res.body.vendors.openai, true);
  assert.equal(res.body.vendors.anthropic, false);
  assert.equal(res.body.any_configured, true);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'sources'), false);
  assert.doesNotMatch(JSON.stringify(res.body), /OPENAI_API_KEY|sk-openai-test-key/);
}));

test('W692 POST rejects bad auth and unsupported methods without upstream fetch', async () => withFetch(async () => {
  throw new Error('fetch should not be called');
}, async () => {
  const noAuth = mockRes();
  await handler(mockReq({ method: 'POST', body: { vendor: 'openai' } }), noAuth);
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.body.error, 'auth_required');

  const invalidAuth = mockRes();
  await handler(mockReq({
    method: 'POST',
    headers: { authorization: 'Bearer bad-key' },
    body: { vendor: 'openai' },
  }), invalidAuth);
  assert.equal(invalidAuth.statusCode, 401);
  assert.equal(invalidAuth.body.error, 'auth_invalid');

  const method = mockRes();
  await handler(mockReq({ method: 'PUT' }), method);
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, 'GET, POST');
}));

test('W692 POST relays OpenAI with normalized roles and proof hashes', async () => withEnv({
  OPENAI_API_KEY: 'sk-openai-upstream-secret',
}, async () => {
  const calls = [];
  await withFetch(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/v1/whoami')) {
      assert.equal(opts.headers.authorization, 'Bearer ks_teacherchat1');
      return response({ json: { tenant_id: 'tenant-test' } });
    }
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(opts.headers.authorization, 'Bearer sk-openai-upstream-secret');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(body.messages[1].content, 'hello');
    return response({
      json: {
        id: 'chatcmpl-test',
        choices: [{ message: { content: 'world' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    });
  }, async () => {
    const res = mockRes();
    await handler(mockReq({
      method: 'POST',
      headers: { authorization: 'Bearer ks_teacherchat1' },
      body: {
        vendor: 'openai',
        model: 'gpt-4o-mini',
        system: 'system prompt',
        messages: [
          { role: 'system', content: 'hello' },
          { role: 'assistant', content: 'prior' },
        ],
        max_tokens: 64,
      },
    }), res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.version, TEACHER_CHAT_VERSION);
    assert.equal(res.body.tenant, 'tenant-test');
    assert.equal(res.body.choices[0].message.content, 'world');
    assert.equal(res.body.proxy_key_configured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'proxy_key_source'), false);
    assert.match(res.body.request_sha256, HEX_64);
    assert.equal(res.body.output_sha256, sha256('world'));
    assert.equal(res.body.usage.total_tokens, 4);
    assert.equal(calls.length, 2);
  });
}));

test('W692 upstream errors are redacted and digest-backed', async () => withEnv({
  OPENAI_API_KEY: 'sk-openai-upstream-secret',
}, async () => withFetch(async (url) => {
  if (String(url).includes('/v1/whoami')) return response({ json: { tenant: 'tenant-test' } });
  return response({
    ok: false,
    status: 429,
    text: 'bad alice@example.com sk-openai-upstream-secret',
  });
}, async () => {
  const res = mockRes();
  await handler(mockReq({
    method: 'POST',
    headers: { authorization: 'Bearer ks_teacherchat2' },
    body: { vendor: 'openai', model: 'gpt-4o-mini', input: 'hello' },
  }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'upstream_error');
  assert.equal(res.body.upstream_status, 429);
  assert.match(res.body.upstream_body_sha256, HEX_64);
  assert.doesNotMatch(res.body.upstream_body_excerpt, /alice@example\.com/);
  assert.doesNotMatch(res.body.upstream_body_excerpt, /sk-openai-upstream-secret/);
  assert.match(res.body.upstream_body_excerpt, /\[redacted_email\]/);
  assert.match(res.body.upstream_body_excerpt, /\[redacted_secret\]/);
})));

test('W692 POST enforces message and model bounds before provider calls', async () => withEnv({
  OPENAI_API_KEY: 'sk-openai-upstream-secret',
}, async () => withFetch(async (url) => {
  if (String(url).includes('/v1/whoami')) return response({ json: { tenant: 'tenant-test' } });
  throw new Error('provider fetch should not be called');
}, async () => {
  const model = mockRes();
  await handler(mockReq({
    method: 'POST',
    headers: { authorization: 'Bearer ks_teacherchat3' },
    body: { vendor: 'openai', model: 'bad\u0001model', input: 'hello' },
  }), model);
  assert.equal(model.statusCode, 400);
  assert.equal(model.body.error, 'model_control_chars');

  const tooLarge = mockRes();
  await handler(mockReq({
    method: 'POST',
    headers: { authorization: 'Bearer ks_teacherchat4' },
    body: {
      vendor: 'openai',
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'x'.repeat(TEACHER_CHAT_LIMITS.MAX_MESSAGE_CHARS) },
        { role: 'user', content: 'x'.repeat(TEACHER_CHAT_LIMITS.MAX_MESSAGE_CHARS) },
        { role: 'user', content: 'x' },
      ],
    },
  }), tooLarge);
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.body.error, 'messages_too_large');
})));
