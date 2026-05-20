// Wave 497 - public marketing examples must only advertise live API routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OPENAPI = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'openapi.json'), 'utf8'));
const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'docs', 'api-routes.json'), 'utf8'));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function hasRoute(method, expressPath) {
  const wanted = method.toUpperCase() + ' ' + expressPath;
  return (ROUTES.groups || []).some((group) =>
    (group.routes || []).some((route) => `${route.method} ${route.path}` === wanted)
  );
}

test('W497 #1 - receipt page uses the live public receipt lookup route', () => {
  const html = read('public/receipt.html');

  assert.ok(hasRoute('GET', '/v1/receipts/:hash/public'));
  assert.ok(OPENAPI.paths['/v1/receipts/{hash}/public']?.get);

  assert.match(html, /\/v1\/receipts\/:hash\/public/);
  assert.match(html, /https:\/\/kolm\.ai\/v1\/receipts\/e176bc2f720b94a8\/public/);
  assert.doesNotMatch(html, /\/v1\/receipt\/:hash/);
  assert.doesNotMatch(html, /https:\/\/kolm\.ai\/v1\/receipt\//);
});

test('W497 #2 - registry page does not advertise removed get/list routes', () => {
  const html = read('public/registry.html');

  assert.ok(hasRoute('GET', '/v1/registry/search'));
  assert.ok(hasRoute('GET', '/v1/registry/public'));
  assert.ok(hasRoute('GET', '/v1/verify/:cid'));
  assert.ok(OPENAPI.paths['/v1/registry/search']?.get);
  assert.ok(OPENAPI.paths['/v1/registry/public']?.get);
  assert.ok(OPENAPI.paths['/v1/verify/{cid}']?.get);

  assert.match(html, /https:\/\/kolm\.ai\/v1\/registry\/search\?task=phi-redact/);
  assert.match(html, /https:\/\/kolm\.ai\/v1\/verify\/cidv1:sha256:7a2c1f8b9d4e/);
  assert.match(html, /https:\/\/kolm\.ai\/v1\/registry\/public/);
  assert.match(html, /href="\/v1\/verify\//);

  assert.doesNotMatch(html, /\/v1\/registry\/get\//);
  assert.doesNotMatch(html, /\/v1\/registry\/list\b/);
  assert.doesNotMatch(html, /X-Kolm-Receipt/);
});

