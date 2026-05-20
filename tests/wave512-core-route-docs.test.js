// Wave 512 - core runtime, compile, artifact, and receipt routes are documented.

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

function openapiPath(routePath) {
  return routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function operation(method, routePath) {
  return OPENAPI.paths[openapiPath(routePath)]?.[method.toLowerCase()] || null;
}

const CORE_ROUTES = [
  ['POST', '/v1/run', /Runtime run - executes a concept_id or version_id/],
  ['POST', '/v1/compile', /Compile job creation - queues a tenant-scoped build/],
  ['GET', '/v1/compile', /Compile job list - returns the caller's recent tenant-scoped compile jobs/],
  ['GET', '/v1/compile/:id', /Compile job status - returns a safe tenant-scoped snapshot/],
  ['GET', '/v1/compile/:id/.kolm', /Compile artifact download - streams the completed \.kolm zip/],
  ['GET', '/v1/artifacts', /Artifact list - exposes completed compile jobs as artifact records/],
  ['GET', '/v1/artifacts/:id', /Artifact detail - returns one tenant-scoped compile artifact/],
  ['GET', '/v1/artifacts/:id/download', /Artifact download - streams the completed artifact zip/],
  ['GET', '/v1/receipts/:hash/public', /Public receipt lookup - resolves a receipt, artifact, CID, or signature hash/],
];

const GENERATED_REFRESHED_ROUTES = [
  ['GET', '/v1/compile'],
  ['GET', '/v1/compile/:id/.kolm'],
  ['GET', '/v1/artifacts'],
  ['GET', '/v1/artifacts/:id'],
  ['GET', '/v1/artifacts/:id/download'],
  ['GET', '/v1/receipts/:hash/public'],
];

test('W512 #1 - core runtime and artifact routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of CORE_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W512 #2 - core documented routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of CORE_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W512 #3 - generated OpenAPI summaries refresh after source comments are added', () => {
  for (const [method, routePath] of GENERATED_REFRESHED_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W512 #4 - OpenAPI generator refreshes stale docs-pending flags', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
});
