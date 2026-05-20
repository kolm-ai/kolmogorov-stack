// Wave 516 - founder admin routes are documented public API contracts.

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

const ADMIN_ROUTES = [
  ['GET', '/v1/admin/tenants', /Admin tenant list - scrubbed cross-tenant view/],
  ['GET', '/v1/admin/stats', /Admin stats - aggregate tenants/],
  ['GET', '/v1/admin/audit', /Admin audit feed - newest audit events/],
  ['GET', '/v1/admin/compile-jobs', /Admin compile job feed - newest compile jobs/],
  ['GET', '/v1/admin/health', /Admin health snapshot - process, store, memory/],
  ['POST', '/v1/admin/tenant', /Admin tenant provision - creates a tenant/],
  ['GET', '/v1/admin/diagnostics', /Admin diagnostics - checks data\/artifact directories/],
  ['GET', '/v1/admin/waitlist', /Admin waitlist list - returns all waitlist rows/],
  ['GET', '/v1/admin/submissions', /Admin submissions list - returns all submitted/],
];

test('W516 #1 - admin routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of ADMIN_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W516 #2 - admin routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of ADMIN_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W516 #3 - generated OpenAPI admin summaries follow source comments', () => {
  for (const [method, routePath] of ADMIN_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W516 #4 - generated public contracts do not expose stale admin block comments', () => {
  for (const rel of ['public/docs/api-routes.json', 'public/docs/api.html', 'public/openapi.json']) {
    const text = read(rel);
    assert.equal(text.includes('Admin console endpoints'), false, `${rel} must not expose old admin section copy`);
    assert.equal(text.includes('/v1/admin/tenants') && text.includes('defined above'), false, `${rel} must not expose old diagnostics note`);
    assert.equal(text.includes('list waitlist + submissions for triage'), false, `${rel} must not expose old waitlist triage note`);
  }
});

test('W516 #5 - OpenAPI generator refreshes stale admin summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleAdminCopy/);
  assert.match(openapiGenerator, /Admin console endpoints/);
  assert.match(openapiGenerator, /waitlist/);
  assert.match(openapiGenerator, /submissions for triage/);
});
