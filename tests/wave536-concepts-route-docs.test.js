// Wave 536 - concept registry routes are documented public contracts.

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

const CONCEPT_ROUTES = [
  ['GET', '/v1/concepts/:id', /Concept detail - returns a readable concept/],
  ['DELETE', '/v1/concepts/:id', /Concept delete - removes an owned concept/],
  ['GET', '/v1/concepts/:id/lineage', /Concept lineage - returns upstream and downstream/],
];

const STALE_CONCEPT_COPY = /source-indexed route; contract generated from route source|No inline description in route source|docs pending|Layer 2: Registry/i;

test('W536 #1 - concept registry detail/delete/lineage routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of CONCEPT_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain source-indexed`);
    assert.match(hit.short || '', summary);
  }
});

test('W536 #2 - concept registry routes are reference-ready in OpenAPI', () => {
  for (const [method, routePath] of CONCEPT_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not use legacy undocumented flag`);
    assert.equal(op['x-kolm-source-indexed'], undefined, `${method} ${routePath} must not remain source-indexed`);
  }
});

test('W536 #3 - generated OpenAPI concept summaries follow source comments', () => {
  for (const [method, routePath] of CONCEPT_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W536 #4 - generated concept contracts do not expose source-indexed placeholders', () => {
  for (const [method, routePath] of CONCEPT_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_CONCEPT_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_CONCEPT_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_CONCEPT_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W536 #5 - concept route source preserves visibility and ownership gates', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/concepts'");
  const end = router.indexOf('// Per-concept usage stats', start);
  assert.ok(start > 0 && end > start, 'concept route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /registry\.listConcepts\(\{\s*tenant:\s*req\.tenant,\s*tenantId:\s*req\.tenant_record\?\.id/);
  assert.match(block, /registry\.getConcept\(req\.params\.id,\s*req\.tenant,\s*req\.tenant_record\?\.id\)/);
  assert.match(block, /if \(!c\) return res\.status\(404\)\.json\(\{ error: 'not found' \}\)/);
  assert.match(block, /registry\.deleteConcept\(req\.params\.id,\s*req\.tenant\)/);
  assert.match(block, /res\.status\(403\)\.json\(\{ error: String\(e\.message \|\| e\) \}\)/);
  assert.match(block, /registry\.lineageOf\(req\.params\.id,\s*req\.tenant,\s*req\.tenant_record\?\.id\)/);
});

test('W536 #6 - registry module still strips vectors and enforces read/delete boundaries', () => {
  const registry = read('src/registry.js');

  assert.match(registry, /function canRead\(concept,\s*tenant,\s*tenantId\)/);
  assert.match(registry, /concept\.visibility === 'public'/);
  assert.match(registry, /concept\.tenant === tenant/);
  assert.match(registry, /concept\.team_id && tenantId && isMember\(concept\.team_id,\s*tenantId\)/);
  assert.match(registry, /if \(c\.tenant !== tenant\) throw new Error\('forbidden'\)/);
  assert.match(registry, /downstream:\s*downstream\.map\(stripVector\)/);
  assert.match(registry, /vector_dim:\s*vector\?\.length \|\| 0/);
});

test('W536 #7 - OpenAPI generator refreshes documented routes that used to be source-indexed', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
  assert.match(openapiGenerator, /delete op\['x-kolm-undocumented'\]/);
});
