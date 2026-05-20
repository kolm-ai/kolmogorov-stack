// Wave 510 - generated route docs must not preserve decorative dividers or stale live-route stubs.

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

function openapiPath(routePath) {
  return routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function operation(method, routePath) {
  return OPENAPI.paths[openapiPath(routePath)]?.[method.toLowerCase()] || null;
}

test('W510 #1 - generated public route contracts do not expose decorative section dividers', () => {
  for (const rel of [
    'public/docs/api-routes.json',
    'public/docs/api.html',
    'public/openapi.json',
  ]) {
    const text = read(rel);
    assert.doesNotMatch(text, /={4,}/, `${rel} must not contain decorative ==== dividers`);
  }
});

test('W510 #2 - remaining generated route-family wildcard copy is removed', () => {
  const forbidden = [
    '/v1/agents/*',
    '/v1/recipes/*',
    'call /v1/*',
    '/v1/* without exposing',
  ];

  for (const rel of [
    'public/docs/api-routes.json',
    'public/docs/api.html',
    'public/openapi.json',
  ]) {
    const text = read(rel);
    for (const s of forbidden) {
      assert.equal(text.includes(s), false, `${rel} must not contain ${s}`);
    }
  }
});

test('W510 #3 - concrete agent telemetry routes are documented live in api-routes and OpenAPI', () => {
  for (const [method, routePath, summary] of [
    ['GET', '/v1/agents', /agent telemetry routes fence/],
    ['GET', '/v1/agents/sessions', /Agent sessions list/],
    ['GET', '/v1/agents/sessions/:id', /Agent session detail/],
    ['GET', '/v1/agents/recommend', /Agent model recommendation/],
    ['GET', '/v1/agents/failing', /Top failing agent sessions/],
    ['GET', '/v1/agents/stats', /Agent telemetry aggregate stats/],
  ]) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.route.stub, false, `${method} ${routePath} must not be preview-only`);
    assert.match(hit.route.short || '', summary);

    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not keep a stale x-kolm-stub flag`);
    assert.match(op.summary || '', summary);
  }
});

test('W510 #4 - concrete recipe aliases are documented live in api-routes and OpenAPI', () => {
  for (const [method, routePath, summary] of [
    ['GET', '/v1/recipes/:id', /Recipe artifact aliases/],
    ['GET', '/v1/recipes/:id/download', /Recipe artifact download alias/],
    ['GET', '/v1/recipes/:id/stats', /Recipe stats alias/],
  ]) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.route.stub, false, `${method} ${routePath} must not be preview-only`);
    assert.match(hit.route.short || '', summary);

    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not keep a stale x-kolm-stub flag`);
    assert.match(op.summary || '', summary);
  }
});

test('W510 #5 - route/OpenAPI generators enforce the cleanup rules', () => {
  const apiRef = read('scripts/build-api-ref.cjs');
  const openapi = read('scripts/build-openapi.cjs');

  assert.match(apiRef, /isDecorativeComment/);
  assert.match(openapi, /operationContainsDecorativeSectionDivider/);
  assert.match(openapi, /operationHasStaleStubFlag/);
  assert.match(openapi, /\/v1\/agents\/\*/);
  assert.match(openapi, /\/v1\/recipes\/\*/);
});
