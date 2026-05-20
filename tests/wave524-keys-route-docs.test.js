// Wave 524 - public key directory routes are documented contracts.

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

function routeHtmlSection(method, routePath) {
  const id = `${method}-${routePath.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '')}`;
  const html = read('public/docs/api.html');
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `${method} ${routePath} missing from generated API HTML`);
  const next = html.indexOf('<section class="api-route"', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

const KEY_ROUTES = [
  ['GET', '/v1/keys/public', /Public keys list - returns registered Ed25519 verification keys/],
  ['GET', '/v1/keys/public/:fingerprint', /Public key lookup - fetches one registered Ed25519 key/],
  ['POST', '/v1/keys/challenge', /Key challenge - issues a proof-of-control nonce/],
  ['POST', '/v1/keys/register', /Key register - verifies a signed challenge nonce/],
  ['DELETE', '/v1/keys/public/:fingerprint', /Public key delete - admin-only removal/],
];

const STALE_KEY_COPY = /undocumented route - wired in source|GET\s+\/v1\/keys\/public|\/v1\/keys\/challenge and POST \/v1\/keys\/register|DELETE requires admin because key removal/i;

test('W524 #1 - public key routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of KEY_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W524 #2 - public key routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of KEY_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W524 #3 - generated OpenAPI key summaries follow source comments', () => {
  for (const [method, routePath] of KEY_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W524 #4 - generated public key contracts do not expose stale route-list notes', () => {
  for (const [method, routePath] of KEY_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_KEY_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_KEY_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_KEY_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W524 #5 - key route source still carries proof-of-control and admin-delete guards', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/keys/public'");
  const end = router.indexOf('// Wave 150', start);
  assert.ok(start > 0 && end > start, 'public key route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /pubkeyDir\.issueChallenge/);
  assert.match(block, /pubkeyDir\.registerKey/);
  assert.match(block, /adminApiKey\(\)/);
  assert.match(block, /constantTimeEq\(adminKey, supplied\)/);
  assert.ok(
    block.indexOf('constantTimeEq(adminKey, supplied)') < block.indexOf('pubkeyDir.deleteKey(fp)'),
    'admin key check must happen before deleteKey',
  );
});

test('W524 #6 - OpenAPI generator refreshes stale public key route-list summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleKeysCopy/);
  assert.match(openapiGenerator, /GET\\s\+\\\/v1\\\/keys\\\/public/);
  assert.match(openapiGenerator, /DELETE requires admin because key removal/);
});
