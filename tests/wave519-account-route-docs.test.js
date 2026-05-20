// Wave 519 - account key and settings routes are documented public API contracts.

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

const ACCOUNT_ROUTES = [
  ['GET', '/v1/account/keys', /Account API key list - returns the tenant primary key metadata/],
  ['POST', '/v1/account/keys', /Account API key create - rotates the tenant primary key/],
  ['DELETE', '/v1/account/keys/:prefix', /Account API key revoke - rotates away a key prefix/],
  ['POST', '/v1/account/rotate-key', /Account API key rotation - rotates the tenant's primary API key/],
  ['GET', '/v1/account/settings', /Account settings read - returns tenant settings/],
  ['PUT', '/v1/account/settings', /Account settings update - persists whitelisted tenant settings/],
];

test('W519 #1 - account key and settings routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of ACCOUNT_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W519 #2 - account key and settings routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of ACCOUNT_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W519 #3 - generated OpenAPI account summaries follow source comments', () => {
  for (const [method, routePath] of ACCOUNT_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W519 #4 - generated public contracts do not expose stale account key implementation notes', () => {
  for (const rel of ['public/docs/api-routes.json', 'public/docs/api.html', 'public/openapi.json']) {
    const text = read(rel);
    assert.equal(text.includes('ONE api_key_hash'), false, `${rel} must not expose internal key-storage wording`);
    assert.equal(text.includes('multi-key was') && text.includes('never wired'), false, `${rel} must not expose stale multi-key implementation wording`);
  }
});

test('W519 #5 - account route HTML blocks are documented, not docs-pending placeholders', () => {
  const html = read('public/docs/api.html');
  for (const [method, routePath] of ACCOUNT_ROUTES) {
    const id = routeHtmlId(method, routePath);
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start >= 0, `${method} ${routePath} missing from generated API HTML`);
    const next = html.indexOf('<section class="api-route"', start + 1);
    const section = html.slice(start, next === -1 ? undefined : next);
    assert.doesNotMatch(section, /No inline description in route source/);
    assert.doesNotMatch(section, /docs pending/);
  }
});

test('W519 #6 - OpenAPI generator refreshes stale account key summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleAccountCopy/);
  assert.match(openapiGenerator, /ONE api_key_hash/);
  assert.match(openapiGenerator, /multi-key was/);
});
