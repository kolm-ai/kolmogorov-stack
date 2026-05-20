// Wave 504 - browser SDK assets must call shipped capture proxy routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ROUTES = JSON.parse(read('public/docs/api-routes.json'));

function hasRoute(method, routePath) {
  return (ROUTES.groups || []).some((group) =>
    (group.routes || []).some((route) => route.method === method && route.path === routePath)
  );
}

test('W504 #1 - public SDK assets do not call the removed passthrough route', () => {
  const sdkFiles = fs.readdirSync(path.join(ROOT, 'public'))
    .filter((name) => /^sdk(?:-[a-f0-9]{12})?\.js$/.test(name));

  assert.ok(sdkFiles.includes('sdk.js'));
  assert.ok(sdkFiles.length >= 2);

  for (const file of sdkFiles) {
    const text = read(path.join('public', file));
    assert.doesNotMatch(text, /\/v1\/passthrough\//, `${file} must not call /v1/passthrough`);
    assert.match(text, /\/v1\/capture\/openai/, `${file} must know the OpenAI capture route`);
    assert.match(text, /\/v1\/capture\/anthropic/, `${file} must know the Anthropic capture route`);
    assert.match(text, /\/v1\/capture\/openrouter/, `${file} must know the OpenRouter capture route`);
  }
});

test('W504 #2 - current SDK manifest is content-addressed and points at the refreshed asset', () => {
  const current = JSON.parse(read('public/sdk-current.json'));
  const versions = JSON.parse(read('public/sdk-versions.json'));
  const body = fs.readFileSync(path.join(ROOT, 'public', path.basename(current.url)));
  const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const sri = 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');

  assert.equal(current.sha, sha);
  assert.equal(current.sri, sri);
  assert.equal(current.bytes, body.length);
  assert.equal(current.url, `/sdk-${sha}.js`);

  for (const entry of versions.versions) {
    const entryBody = fs.readFileSync(path.join(ROOT, 'public', path.basename(entry.url)));
    const entrySri = 'sha384-' + crypto.createHash('sha384').update(entryBody).digest('base64');
    assert.equal(entry.sri, entrySri, `${entry.url} SRI must match the served file`);
    assert.equal(entry.bytes, entryBody.length, `${entry.url} bytes must match the served file`);
  }
});

test('W504 #3 - SDK capture and passthrough compatibility alias hit shipped capture endpoints', async () => {
  assert.ok(hasRoute('POST', '/v1/capture/openai'));
  assert.ok(hasRoute('POST', '/v1/capture/anthropic'));
  assert.ok(hasRoute('POST', '/v1/capture/openrouter'));
  assert.equal(hasRoute('POST', '/v1/passthrough/:provider'), false);

  const modUrl = pathToFileURL(path.join(ROOT, 'public/sdk.js')).href + '?w504=' + Date.now();
  const { Recipe } = await import(modUrl);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true }; },
    };
  };
  try {
    const sdk = new Recipe({ base: 'https://kolm.ai', apiKey: 'kolm_test_key' });
    await sdk.capture('openai', { messages: [] }, { 'x-upstream-api-key': 'sk-upstream' });
    await sdk.passthrough('anthropic', { messages: [] }, { 'x-upstream-api-key': 'sk-upstream' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0].url, 'https://kolm.ai/v1/capture/openai');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer kolm_test_key');
  assert.equal(calls[0].opts.headers['x-upstream-api-key'], 'sk-upstream');
  assert.equal(calls[1].url, 'https://kolm.ai/v1/capture/anthropic');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer kolm_test_key');
});
