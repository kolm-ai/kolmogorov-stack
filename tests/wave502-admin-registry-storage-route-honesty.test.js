// Wave 502 - admin, registry, storage, and status copy must use shipped routes.

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

test('W502 #1 - backlog observability ticket points at shipped admin endpoints', () => {
  const html = read('public/docs/tickets.html');

  assert.ok(hasRoute('GET', '/v1/admin/stats'));
  assert.ok(hasRoute('GET', '/v1/admin/tenants'));
  assert.ok(hasRoute('GET', '/v1/admin/compile-jobs'));
  assert.ok(hasRoute('GET', '/v1/admin/audit'));
  assert.equal(hasRoute('GET', '/v1/admin/metrics'), false);
  assert.ok(OPENAPI.paths['/v1/admin/stats']?.get);
  assert.equal(OPENAPI.paths['/v1/admin/metrics'], undefined);

  assert.match(html, /\/v1\/admin\/stats/);
  assert.match(html, /\/v1\/admin\/tenants/);
  assert.match(html, /\/v1\/admin\/compile-jobs/);
  assert.match(html, /\/v1\/admin\/audit/);
  assert.doesNotMatch(html, /\/v1\/admin\/metrics/);
});

test('W502 #2 - audit-log retention copy does not advertise a nonexistent observations purge route', () => {
  const html = read('public/audit-log.html');

  assert.ok(hasRoute('POST', '/v1/storage/purge'));
  assert.equal(hasRoute('POST', '/v1/observations/purge'), false);
  assert.ok(OPENAPI.paths['/v1/storage/purge']?.post);
  assert.equal(OPENAPI.paths['/v1/observations/purge'], undefined);

  assert.match(html, /POST \/v1\/storage\/purge/);
  assert.doesNotMatch(html, /\/v1\/observations\/purge/);
});

test('W502 #3 - spec grammar fixture download uses shipped marketplace download route', () => {
  const html = read('public/spec-grammar.html');

  assert.ok(hasRoute('GET', '/v1/public/concepts'));
  assert.ok(hasRoute('GET', '/v1/marketplace/:slug/download'));
  assert.equal(hasRoute('GET', '/v1/registry/:id/artifact'), false);
  assert.ok(OPENAPI.paths['/v1/marketplace/{slug}/download']?.get);

  assert.match(html, /\/v1\/public\/concepts/);
  assert.match(html, /\/v1\/marketplace\/qwen-distill-classifier\/download/);
  assert.doesNotMatch(html, /\/v1\/registry\/&lt;id&gt;\/artifact/);
  assert.doesNotMatch(html, /\/v1\/registry\/<id>\/artifact/);
});

test('W502 #4 - status page names concrete health surfaces, not bare route prefixes', () => {
  const html = read('public/status.html');

  assert.ok(hasRoute('GET', '/v1/bridges/observations'));
  assert.ok(hasRoute('POST', '/v1/capture/log'));
  assert.ok(hasRoute('POST', '/v1/compile'));
  assert.ok(hasRoute('GET', '/v1/distill/runs'));
  assert.equal(hasRoute('GET', '/v1/bridges'), false);
  assert.equal(hasRoute('GET', '/v1/capture'), false);
  assert.equal(hasRoute('GET', '/v1/distill'), false);

  assert.match(html, /\/v1\/bridges\/observations/);
  assert.match(html, /\/v1\/capture\/log/);
  assert.match(html, /\/v1\/distill\/runs/);
  assert.doesNotMatch(html, /\/v1\/bridges, \/v1\/capture/);
  assert.doesNotMatch(html, /\/v1\/compile, \/v1\/distill<\/small>/);
});
