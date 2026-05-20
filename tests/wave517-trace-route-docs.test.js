// Wave 517 - trace provenance and replay routes are documented public API contracts.

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

const TRACE_ROUTES = [
  ['GET', '/v1/trace/:trace_id/stats', /Trace stats - returns tenant-scoped span counts/],
  ['GET', '/v1/trace/:trace_id/chain', /Trace chain - returns tenant-scoped parent\/child span chain/],
  ['GET', '/v1/trace/:trace_id/export', /Trace export - returns tenant-scoped raw spans/],
  ['POST', '/v1/trace/append', /Trace append - validates and stores one span/],
  ['POST', '/v1/trace/compile', /Trace compile - converts a tenant trace/],
  ['POST', '/v1/trace/verify', /Trace replay verify - checks compiled replay outputs/],
  ['GET', '/v1/trace/translate/providers', /Trace translate providers - lists supported cross-provider/],
  ['GET', '/v1/trace/translate/detect', /Trace provider detect - detects source provider\/model metadata/],
  ['POST', '/v1/trace/translate', /Trace translate - rewrites trace IR provider\/model fields/],
];

test('W517 #1 - trace routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of TRACE_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W517 #2 - trace routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of TRACE_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W517 #3 - generated OpenAPI trace summaries follow source comments', () => {
  for (const [method, routePath] of TRACE_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W517 #4 - generated public contracts do not expose stale trace block comments', () => {
  for (const rel of ['public/docs/api-routes.json', 'public/docs/api.html', 'public/openapi.json']) {
    const text = read(rel);
    assert.equal(text.includes('req.tenant_record.id down into trace-capture'), false, `${rel} must not expose trace ownership internals`);
    assert.equal(text.includes('pre-seeds the IR'), false, `${rel} must not expose old trace compile note`);
    assert.equal(text.includes('Closes audit P1 Agent Trace cluster'), false, `${rel} must not expose audit-worklog wording`);
  }
});

test('W517 #5 - OpenAPI generator refreshes stale trace summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleTraceCopy/);
  assert.match(openapiGenerator, /trace-capture/);
  assert.match(openapiGenerator, /pre-seeds the IR/);
});
