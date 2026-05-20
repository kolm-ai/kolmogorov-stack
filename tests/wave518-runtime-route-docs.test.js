// Wave 518 - runtime policy and decision routes are documented public API contracts.

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

const RUNTIME_ROUTES = [
  ['GET', '/v1/runtime/policy', /Runtime policy read - returns the active runtime policy/],
  ['PUT', '/v1/runtime/policy', /Runtime policy update - admin-only mutation/],
  ['POST', '/v1/runtime/decide', /Runtime decision - executes the policy ladder/],
  ['GET', '/v1/runtime/decisions', /Runtime decision history - returns the most recent recorded runtime decisions/],
  ['GET', '/v1/runtime/replacement-stats', /Runtime replacement stats - summarizes replacement rate/],
];

test('W518 #1 - runtime routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of RUNTIME_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W518 #2 - runtime routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of RUNTIME_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W518 #3 - generated OpenAPI runtime summaries follow source comments', () => {
  for (const [method, routePath] of RUNTIME_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W518 #4 - generated public contracts do not expose runtime docs-pending placeholders', () => {
  const html = read('public/docs/api.html');
  for (const [method, routePath] of RUNTIME_ROUTES) {
    const id = `${method}-${routePath.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '')}`;
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start >= 0, `${method} ${routePath} missing from generated API HTML`);
    const next = html.indexOf('<section class="api-route"', start + 1);
    const section = html.slice(start, next === -1 ? undefined : next);
    assert.doesNotMatch(section, /No inline description in route source/);
    assert.doesNotMatch(section, /docs pending/);
  }
});

test('W518 #5 - OpenAPI generator refreshes documented routes that used to be docs-pending', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
});
