// Wave 523 - dataset routes are documented public API contracts.

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

const DATASET_ROUTES = [
  ['GET', '/v1/datasets', /Datasets list - returns tenant-scoped dataset summaries/],
  ['POST', '/v1/datasets', /Dataset create - builds a tenant-stamped dataset/],
  ['GET', '/v1/datasets/:id', /Dataset detail - inspects one dataset/],
  ['POST', '/v1/datasets/:id/split', /Dataset split - recomputes a deterministic train\/holdout split/],
];

test('W523 #1 - dataset routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of DATASET_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W523 #2 - dataset routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of DATASET_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W523 #3 - generated OpenAPI dataset summaries follow source comments', () => {
  for (const [method, routePath] of DATASET_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W523 #4 - dataset route HTML blocks are documented, not docs-pending placeholders', () => {
  for (const [method, routePath] of DATASET_ROUTES) {
    const section = routeHtmlSection(method, routePath);
    assert.doesNotMatch(section, /No inline description in route source/);
    assert.doesNotMatch(section, /docs pending/);
  }
});

test('W523 #5 - dataset route source still carries tenant fence and split invariant calls', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/datasets'");
  const end = router.indexOf('// ============== W384: label queue', start);
  assert.ok(start > 0 && end > start, 'dataset route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /dsListDatasets\(\{\s*tenant_id:\s*_tenantScope\(req\)\s*\}\)/);
  assert.match(block, /dsCreateDataset\(body\.namespace,\s*\{\s*\.\.\.body,\s*tenant_id:\s*_tenantScope\(req\)\s*\}\)/);
  assert.match(block, /result\.tenant_id[\s\S]{0,160}!== scope[\s\S]{0,120}dataset_not_found/);
  assert.match(block, /dsSplitDataset\(req\.params\.id,\s*ratio\)/);
});

test('W523 #6 - OpenAPI generator refreshes documented routes that used to be docs-pending', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
});
