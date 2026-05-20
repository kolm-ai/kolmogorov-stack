// Wave 498 - capture SDK docs and generated API contracts must agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ROUTES = JSON.parse(read('public/docs/api-routes.json'));
const OPENAPI = JSON.parse(read('public/openapi.json'));

function route(method, routePath) {
  for (const group of ROUTES.groups || []) {
    for (const r of group.routes || []) {
      if (r.method === method && r.path === routePath) return r;
    }
  }
  return null;
}

test('W498 #1 - regex capture routes are represented in generated route inventory and OpenAPI', () => {
  for (const p of ['/v1/capture/anthropic', '/v1/capture/openai']) {
    const r = route('POST', p);
    assert.ok(r, `${p} must be in api-routes.json`);
    assert.equal(r.expanded_from, 'regex-literal');
    assert.ok(OPENAPI.paths[p]?.post, `${p} must be in OpenAPI`);
  }

  assert.match(
    OPENAPI.paths['/v1/capture/anthropic'].post.summary,
    /POST \/v1\/capture\/anthropic/
  );
});

test('W498 #2 - public Anthropic integration copy uses the live capture base, not the removed alias', () => {
  const files = [
    'public/integrations.html',
    'public/integrations/anthropic-sdk.html',
    'public/docs/sdk.html',
  ];
  const staleHostedAlias = /https:\/\/kolm\.ai\/v1\/anthropic(?![a-z0-9/_-])/i;

  for (const rel of files) {
    const text = read(rel);
    assert.match(text, /\/v1\/capture\/anthropic/);
    assert.doesNotMatch(text, staleHostedAlias, `${rel} advertises the dead /v1/anthropic alias`);
  }
});

test('W498 #3 - SDK docs do not advertise a nonexistent generic passthrough route or method', () => {
  const html = read('public/docs/sdk.html');
  assert.match(html, /id="capture-proxy"/);
  assert.match(html, /x-upstream-api-key/);
  assert.doesNotMatch(html, /\/v1\/passthrough(?:\/|&lt;|<|\b)/);
  assert.doesNotMatch(html, /passthrough\(/);
});

