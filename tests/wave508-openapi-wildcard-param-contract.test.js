// Wave 508 - Express wildcard params must not leak into public API contracts.

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

test('W508 #1 - api-routes normalizes Express :id(*) to public :id', () => {
  const hit = route('GET', '/v1/recall/sources/:id');

  assert.ok(hit, 'recall source route must be present with public :id syntax');
  assert.equal(hit.group.key, 'recall');
  assert.equal(hit.route.source, 'src/router.js');
  assert.equal(route('GET', '/v1/recall/sources/:id(*)'), null);
});

test('W508 #2 - OpenAPI uses a valid {id} parameter path without path-to-regexp suffixes', () => {
  assert.ok(OPENAPI.paths['/v1/recall/sources/{id}']?.get);
  assert.equal(OPENAPI.paths['/v1/recall/sources/{id}(*)'], undefined);

  const params = OPENAPI.paths['/v1/recall/sources/{id}'].get.parameters || [];
  assert.ok(params.some((p) => p.name === 'id' && p.in === 'path' && p.required === true));
});

test('W508 #3 - generated public contracts contain no Express wildcard parameter suffix', () => {
  for (const rel of [
    'public/docs/api-routes.json',
    'public/docs/api.html',
    'public/openapi.json',
  ]) {
    const text = read(rel);
    assert.doesNotMatch(text, /:\w+\(\*\)/, `${rel} must not expose :param(*)`);
    assert.doesNotMatch(text, /\{\w+\}\(\*\)/, `${rel} must not expose {param}(*)`);
  }
});

test('W508 #4 - generators explicitly normalize wildcard route params', () => {
  const apiRef = read('scripts/build-api-ref.cjs');
  const openapi = read('scripts/build-openapi.cjs');
  const coverage = read('tests/wave485-openapi-coverage.test.js');

  assert.match(apiRef, /normalizeExpressRoutePath/);
  assert.match(apiRef, /\\\(\\\*\\\)/);
  assert.match(openapi, /publicRoutePath/);
  assert.match(openapi, /delete merged\.paths\[p\]/);
  assert.match(coverage, /\\\(\\\*\\\)/);
});
