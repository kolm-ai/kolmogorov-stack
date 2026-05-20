// Wave 520 - federated approval-sharing routes are documented public API contracts.

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

function operation(method, routePath) {
  const oapiPath = routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
  return OPENAPI.paths[oapiPath]?.[method.toLowerCase()] || null;
}

function routeHtmlId(method, routePath) {
  return `${method}-${routePath.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '')}`;
}

const FEDERATED_ROUTES = [
  ['POST', '/v1/federated/opt-in', /Federated opt-in - records tenant namespaces and peers/],
  ['POST', '/v1/federated/opt-out', /Federated opt-out - clears tenant approval-sharing opt-in/],
  ['POST', '/v1/federated/share-approvals', /Federated approval share - emits hash-only approval rows/],
  ['POST', '/v1/federated/aggregate', /Federated approval aggregate - returns DP-noised counts/],
  ['GET', '/v1/federated/peers', /Federated peers - lists other opted-in approval-sharing peers/],
  ['GET', '/v1/federated/audit', /Federated audit - returns recent hash-only approval-share envelopes/],
];

test('W520 #1 - federated approval routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of FEDERATED_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W520 #2 - federated approval routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of FEDERATED_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W520 #3 - generated OpenAPI federated summaries follow source comments', () => {
  for (const [method, routePath] of FEDERATED_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W520 #4 - generated public contracts do not expose stale federated route-list comments', () => {
  for (const rel of ['public/docs/api-routes.json', 'public/docs/api.html', 'public/openapi.json']) {
    const text = read(rel);
    assert.equal(text.includes('GET  /v1/federated/audit?limit=N'), false, `${rel} must not expose old route-list comments`);
    assert.equal(text.includes('POST /v1/federated/opt-in    {scope'), false, `${rel} must not expose old route-list comments`);
  }
});

test('W520 #5 - federated route HTML blocks are documented, not docs-pending placeholders', () => {
  const html = read('public/docs/api.html');
  for (const [method, routePath] of FEDERATED_ROUTES) {
    const id = routeHtmlId(method, routePath);
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start >= 0, `${method} ${routePath} missing from generated API HTML`);
    const next = html.indexOf('<section class="api-route"', start + 1);
    const section = html.slice(start, next === -1 ? undefined : next);
    assert.doesNotMatch(section, /No inline description in route source/);
    assert.doesNotMatch(section, /docs pending/);
  }
});

test('W520 #6 - OpenAPI generator refreshes stale federated route-list summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleFederatedCopy/);
  assert.ok(openapiGenerator.includes('GET\\s+\\/v1\\/federated\\/audit\\?limit=N'));
  assert.ok(openapiGenerator.includes('POST\\s+\\/v1\\/federated\\/opt-in\\s+\\{scope'));
});
