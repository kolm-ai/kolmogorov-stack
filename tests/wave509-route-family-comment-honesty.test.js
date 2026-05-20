// Wave 509 - route-family comments must not imply wildcard API contracts.

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

const FORBIDDEN_FAMILIES = [
  '/v1/audio/*',
  '/v1/openrouter/*',
  '/v1/label-queue/*',
  '/v1/labels/*',
];

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

function assertOpenApi(method, routePath) {
  const op = method.toLowerCase();
  assert.ok(OPENAPI.paths[openapiPath(routePath)]?.[op], `${method} ${routePath} missing from OpenAPI`);
}

test('W509 #1 - generated contracts do not advertise wildcard route families', () => {
  for (const rel of [
    'public/docs/api-routes.json',
    'public/docs/api.html',
    'public/openapi.json',
  ]) {
    const text = read(rel);
    for (const family of FORBIDDEN_FAMILIES) {
      assert.equal(text.includes(family), false, `${rel} must not contain ${family}`);
    }
  }
});

test('W509 #2 - source comments no longer seed wildcard route-family docs', () => {
  const router = read('src/router.js');

  for (const family of FORBIDDEN_FAMILIES) {
    assert.equal(router.includes(family), false, `src/router.js must not contain ${family}`);
  }
});

test('W509 #3 - concrete audio, OpenRouter, and label-queue routes stay documented', () => {
  for (const [method, routePath] of [
    ['POST', '/v1/audio/speech'],
    ['POST', '/v1/audio/transcriptions'],
    ['POST', '/v1/audio/translations'],
    ['POST', '/v1/capture/openrouter'],
    ['POST', '/v1/capture/openrouter/v1/chat/completions'],
    ['POST', '/v1/openrouter/chat/completions'],
    ['POST', '/v1/openrouter/v1/chat/completions'],
    ['GET', '/v1/label-queue/next'],
    ['GET', '/v1/label-queue/stats'],
    ['POST', '/v1/label-queue/submit'],
    ['GET', '/v1/label-queue/audit/:event_id'],
  ]) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.route.source, 'src/router.js');
    assert.equal(hit.route.stub, false);
    assertOpenApi(method, routePath);
  }
});

test('W509 #4 - generated descriptions explain concrete alias surfaces', () => {
  const audio = route('POST', '/v1/audio/speech').route.comments.join(' ');
  const openrouter = route('POST', '/v1/capture/openrouter').route.comments.join(' ');
  const labelQueue = route('GET', '/v1/label-queue/next').route.comments.join(' ');

  assert.match(audio, /concrete audio endpoints/);
  assert.match(openrouter, /OpenRouter capture and base-URL aliases/);
  assert.match(labelQueue, /concrete label-queue aliases/);

  for (const text of [audio, openrouter, labelQueue]) {
    for (const family of FORBIDDEN_FAMILIES) {
      assert.equal(text.includes(family), false, `route comments must not contain ${family}`);
    }
  }
});

test('W509 #5 - OpenAPI builder refreshes stale wildcard-family descriptions', () => {
  const script = read('scripts/build-openapi.cjs');

  assert.match(script, /FORBIDDEN_ROUTE_FAMILY_STRINGS/);
  assert.match(script, /operationContainsForbiddenRouteFamily/);
  assert.match(script, /refreshRouteDerivedFields/);
});
