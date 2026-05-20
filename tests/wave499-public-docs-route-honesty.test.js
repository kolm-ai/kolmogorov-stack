// Wave 499 - public docs must not advertise removed run/receipt/key routes.

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

test('W499 #1 - docs overview uses live run and receipt routes', () => {
  const html = read('public/docs.html');
  assert.ok(hasRoute('POST', '/v1/run'));
  assert.ok(hasRoute('GET', '/v1/receipts/:hash/public'));
  assert.ok(OPENAPI.paths['/v1/run']?.post);
  assert.ok(OPENAPI.paths['/v1/receipts/{hash}/public']?.get);

  assert.match(html, /<code>\/v1\/run<\/code>/);
  assert.match(html, /<code>\/v1\/receipts\/:hash\/public<\/code>/);
  assert.doesNotMatch(html, /\/v1\/run\/:id/);
  assert.doesNotMatch(html, /\/v1\/receipts\/:id/);
});

test('W499 #2 - value-loop audit copy uses the live receipt verifier flow', () => {
  const html = read('public/value-loop.html');
  assert.ok(hasRoute('POST', '/v1/receipts/verify'));
  assert.ok(OPENAPI.paths['/v1/receipts/verify']?.post);

  assert.match(html, /POST \/v1\/receipts\/verify/);
  assert.match(html, /https:\/\/kolm\.ai\/v1\/receipts\/e176bc2f720b94a8\/public/);
  assert.doesNotMatch(html, /\/v1\/artifacts\/:id\/receipts/);
  assert.doesNotMatch(html, /\/v1\/artifacts\/art_abc123\/receipts/);
});

test('W499 #3 - spec and threat-model pages use current run and key-public routes', () => {
  const spec = read('public/spec/codebase.html');
  const threat = read('public/threat-model.html');
  assert.ok(hasRoute('POST', '/v1/run'));
  assert.ok(hasRoute('GET', '/v1/keys/public'));
  assert.ok(OPENAPI.paths['/v1/keys/public']?.get);

  assert.match(spec, /POST \/v1\/run/);
  assert.doesNotMatch(spec, /\/v1\/run\/:id/);
  assert.doesNotMatch(spec, /\/v1\/run\/\*/);

  assert.match(threat, /\/v1\/keys\/public/);
  assert.doesNotMatch(threat, /\/v1\/registry\/pubkey/);
});

test('W499 #4 - API quickstart does not advertise nonexistent job-log stream route', () => {
  const html = read('public/quickstart/api.html');
  assert.ok(hasRoute('GET', '/v1/jobs/:id'));
  assert.ok(OPENAPI.paths['/v1/jobs/{id}']?.get);

  assert.match(html, /GET \/v1\/jobs\/:id/);
  assert.doesNotMatch(html, /\/v1\/jobs\/:id\/logs/);
  assert.doesNotMatch(html, /\/v1\/jobs\/job_w8e2\/logs/);
});

