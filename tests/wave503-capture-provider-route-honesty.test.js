// Wave 503 - capture provider docs must name shipped provider-specific routes.

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

function hasRoute(method, routePath) {
  return (ROUTES.groups || []).some((group) =>
    (group.routes || []).some((route) => route.method === method && route.path === routePath)
  );
}

test('W503 #1 - hosted capture routes are provider-specific in generated contracts', () => {
  for (const provider of ['openai', 'anthropic', 'openrouter']) {
    const routePath = `/v1/capture/${provider}`;
    assert.ok(hasRoute('POST', routePath), `${routePath} must be in api-routes.json`);
    assert.ok(OPENAPI.paths[routePath]?.post, `${routePath} must be in OpenAPI`);
  }

  assert.equal(hasRoute('POST', '/v1/capture/:provider'), false);
  assert.equal(OPENAPI.paths['/v1/capture/{provider}'], undefined);
});

test('W503 #2 - public capture loop pages do not publish a literal provider placeholder route', () => {
  const files = [
    'public/research/capture-loop-fidelity.html',
    'public/use-cases/capture-and-distill.html',
  ];

  for (const rel of files) {
    const html = read(rel);
    assert.match(html, /\/v1\/capture\/openai/, `${rel} must name the OpenAI capture route`);
    assert.match(html, /\/v1\/capture\/anthropic/, `${rel} must name the Anthropic capture route`);
    assert.match(html, /\/v1\/capture\/openrouter/, `${rel} must name the OpenRouter capture route`);
    assert.doesNotMatch(html, /\/v1\/capture\/&lt;provider&gt;/, `${rel} must not publish an HTML placeholder route`);
    assert.doesNotMatch(html, /\/v1\/capture\/<provider>/, `${rel} must not publish a literal placeholder route`);
  }
});

test('W503 #3 - generated API reference does not inherit provider placeholder wording from source comments', () => {
  const generated = [
    read('public/docs/api-routes.json'),
    read('public/docs/api.html'),
    read('public/openapi.json'),
  ].join('\n');
  const source = read('src/router.js');

  for (const text of [generated, source]) {
    assert.doesNotMatch(text, /\/v1\/capture\/&lt;provider&gt;/);
    assert.doesNotMatch(text, /\/v1\/capture\/<provider>/);
    assert.doesNotMatch(text, /capture\/<provider>/);
  }
});
