// W668 - direct contract for api/r2.js.
//
// Exercises the Vercel-style R2 API handler with a stubbed Cloudflare fetch:
// header-only admin auth, method allowlists, bucket/key validation, bounded
// upload bodies, public asset reads, and non-secret ping/list envelopes.

import assert from 'node:assert/strict';
import test from 'node:test';

function makeReq({ method = 'GET', query = {}, headers = {}, chunks = [] } = {}) {
  return {
    method,
    query,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    ended: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    end(body) {
      this.ended = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
      return this;
    },
  };
}

async function loadHandler() {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123456789';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-secret-token';
  process.env.ADMIN_KEY = 'admin-secret';
  delete process.env.KOLM_DEBUG;
  const mod = await import(`../api/r2.js?wave668=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function installFetchStub(t) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, headers: { ...(init.headers || {}) }, body: init.body });

    if (u.endsWith('/r2/buckets') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: { buckets: [{ name: 'kolm-assets' }, { name: 'kolm-artifacts' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/r2/buckets') && method === 'POST') {
      return new Response(JSON.stringify({ success: true, result: { name: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/objects?') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: [{ key: 'public/asset.txt', size: 11 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/objects/') && method === 'GET') {
      return new Response('asset bytes', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (u.includes('/objects/') && method === 'PUT') {
      return new Response('', { status: 200 });
    }
    if (u.includes('/objects/') && method === 'DELETE') {
      return new Response('', { status: 204 });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'unexpected' }] }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  return calls;
}

test('W668 R2 API ping is public but does not disclose bucket names or secrets', async (t) => {
  const calls = installFetchStub(t);
  const handler = await loadHandler();
  const res = makeRes();

  await handler(makeReq({ method: 'GET', query: { op: 'ping' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.bucket_count, 2);
  assert.equal(res.jsonBody.buckets, undefined);
  assert.match(res.jsonBody.account_prefix, /^acct1234\.\.\.$/);
  assert.doesNotMatch(JSON.stringify(res.jsonBody), /cf-secret-token|admin-secret|kolm-assets/);
  assert.equal(calls[0].headers.Authorization, 'Bearer cf-secret-token');
});

test('W668 R2 API requires x-admin-key header; query admin_key is ignored', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();

  const queryKey = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'list', bucket: 'kolm-assets', admin_key: 'admin-secret' },
  }), queryKey);
  assert.equal(queryKey.statusCode, 403);
  assert.equal(queryKey.jsonBody.error, 'admin_only');

  const headerKey = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'list', bucket: 'kolm-assets' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), headerKey);
  assert.equal(headerKey.statusCode, 200);
  assert.equal(headerKey.jsonBody.ok, true);
  assert.deepEqual(headerKey.jsonBody.objects, [{ key: 'public/asset.txt', size: 11 }]);
});

test('W668 R2 API enforces per-operation HTTP methods', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();

  const putViaGet = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'put', bucket: 'kolm-assets', key: 'public/a.txt' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), putViaGet);
  assert.equal(putViaGet.statusCode, 405);
  assert.equal(putViaGet.headers.allow, 'POST');
  assert.equal(putViaGet.jsonBody.error, 'method_not_allowed');

  const listViaPost = makeRes();
  await handler(makeReq({
    method: 'POST',
    query: { op: 'list', bucket: 'kolm-assets' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), listViaPost);
  assert.equal(listViaPost.statusCode, 405);
  assert.equal(listViaPost.headers.allow, 'GET');
});

test('W668 R2 API validates bucket and key before public/admin object access', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();

  const badPublicKey = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'get', bucket: 'kolm-assets', key: '../secret.txt' },
  }), badPublicKey);
  assert.equal(badPublicKey.statusCode, 400);
  assert.equal(badPublicKey.jsonBody.error, 'invalid_key');

  const badBucket = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'list', bucket: 'Bad/Bucket' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), badBucket);
  assert.equal(badBucket.statusCode, 400);
  assert.equal(badBucket.jsonBody.error, 'invalid_bucket');
});

test('W668 R2 API public asset GET sets cache headers and returns object bytes', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();
  const res = makeRes();

  await handler(makeReq({
    method: 'GET',
    query: { op: 'get', bucket: 'kolm-assets', key: 'public/asset.txt' },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/plain');
  assert.equal(res.headers['cache-control'], 'public, max-age=3600, stale-while-revalidate=86400');
  assert.equal(res.ended.toString('utf8'), 'asset bytes');
});

test('W668 R2 API bounds PUT request bodies before upstream upload', async (t) => {
  const calls = installFetchStub(t);
  const handler = await loadHandler();
  process.env.KOLM_R2_MAX_PUT_BYTES = '4';
  t.after(() => { delete process.env.KOLM_R2_MAX_PUT_BYTES; });

  const tooLarge = makeRes();
  await handler(makeReq({
    method: 'POST',
    query: { op: 'put', bucket: 'kolm-assets', key: 'public/big.txt' },
    headers: { 'x-admin-key': 'admin-secret', 'content-type': 'text/plain' },
    chunks: ['123', '45'],
  }), tooLarge);

  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.jsonBody.error, 'body_too_large');
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'oversized body must not reach upstream PUT');

  const ok = makeRes();
  await handler(makeReq({
    method: 'POST',
    query: { op: 'put', bucket: 'kolm-assets', key: 'public/small.txt' },
    headers: { 'x-admin-key': 'admin-secret', 'content-type': 'text/plain' },
    chunks: ['ok'],
  }), ok);

  assert.equal(ok.statusCode, 200);
  assert.equal(ok.jsonBody.ok, true);
  assert.equal(ok.jsonBody.key, 'public/small.txt');
  assert.ok(calls.some((c) => c.method === 'PUT' && c.headers.Authorization === 'Bearer cf-secret-token'));
});
