// Wave 507 - mounted OAuth routes must be present in generated API contracts.

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
      if (r.method === method && r.path === routePath) return { group, route: r };
    }
  }
  return null;
}

test('W507 #1 - OAuth routes mounted from src/oauth.js appear in api-routes.json', () => {
  assert.deepEqual(ROUTES.sources, ['src/router.js', 'src/oauth.js']);

  for (const routePath of [
    '/v1/oauth/providers',
    '/v1/oauth/:provider/start',
    '/v1/oauth/:provider/callback',
  ]) {
    const hit = route('GET', routePath);
    assert.ok(hit, `${routePath} must be generated`);
    assert.equal(hit.group.key, 'oauth');
    assert.equal(hit.route.source, 'src/oauth.js');
    assert.equal(hit.route.stub, false);
    assert.match(hit.route.short, /OAuth|providers|provider/i);
  }
});

test('W507 #2 - OpenAPI covers the public OAuth provider discovery and redirect routes', () => {
  assert.ok(OPENAPI.paths['/v1/oauth/providers']?.get);
  assert.ok(OPENAPI.paths['/v1/oauth/{provider}/start']?.get);
  assert.ok(OPENAPI.paths['/v1/oauth/{provider}/callback']?.get);

  const startParams = OPENAPI.paths['/v1/oauth/{provider}/start'].get.parameters || [];
  const callbackParams = OPENAPI.paths['/v1/oauth/{provider}/callback'].get.parameters || [];
  assert.ok(startParams.some((p) => p.name === 'provider' && p.in === 'path'));
  assert.ok(callbackParams.some((p) => p.name === 'provider' && p.in === 'path'));
});

test('W507 #3 - generated API HTML renders an OAuth group instead of omitting mounted routes', () => {
  const html = read('public/docs/api.html');

  assert.match(html, /id="group-oauth"/);
  assert.match(html, /GET<\/span> <code>\/v1\/oauth\/providers<\/code>/);
  assert.match(html, /GET<\/span> <code>\/v1\/oauth\/:provider\/start<\/code>/);
  assert.match(html, /GET<\/span> <code>\/v1\/oauth\/:provider\/callback<\/code>/);
});

test('W507 #4 - public signup OAuth calls are backed by generated contract routes', () => {
  const signup = read('public/signup.html');

  assert.match(signup, /\/v1\/oauth\/providers/);
  assert.match(signup, /\/v1\/oauth\/['"]?\s*\+\s*provider\s*\+\s*['"]?\/start/);
  assert.ok(route('GET', '/v1/oauth/providers'));
  assert.ok(route('GET', '/v1/oauth/:provider/start'));
});

test('W507 #5 - build-api-ref parses mounted router modules, not only src/router.js', () => {
  const script = read('scripts/build-api-ref.cjs');

  assert.match(script, /ROUTE_SOURCES/);
  assert.match(script, /src\/oauth\.js/);
  assert.match(script, /\(\?:r\|router\)\\\./);
});
