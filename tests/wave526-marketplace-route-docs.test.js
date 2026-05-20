// Wave 526 - marketplace catalog routes are documented public contracts.

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

const MARKETPLACE_ROUTES = [
  ['GET', '/v1/marketplace/catalog.json', /Marketplace catalog manifest - returns the signed catalog/],
  ['GET', '/v1/marketplace', /Marketplace list - filters artifacts and overlays live verification/],
  ['POST', '/v1/marketplace/publish-request', /Marketplace publish request - queues an artifact proposal/],
  ['GET', '/v1/marketplace/:slug', /Marketplace detail - returns one artifact with live verification state/],
];

const STALE_MARKETPLACE_COPY = /source-indexed route; contract generated from route source|No inline description in route source|docs pending|W263 marketplace|signed public catalog of \.kolm artifacts/i;

test('W526 #1 - marketplace catalog routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of MARKETPLACE_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain source-indexed`);
    assert.match(hit.short || '', summary);
  }
});

test('W526 #2 - marketplace catalog routes are reference-ready in OpenAPI', () => {
  for (const [method, routePath] of MARKETPLACE_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not use legacy undocumented flag`);
    assert.equal(op['x-kolm-source-indexed'], undefined, `${method} ${routePath} must not remain source-indexed`);
  }
});

test('W526 #3 - generated OpenAPI marketplace summaries follow source comments', () => {
  for (const [method, routePath] of MARKETPLACE_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W526 #4 - generated marketplace contracts do not expose source-indexed placeholders', () => {
  for (const [method, routePath] of MARKETPLACE_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_MARKETPLACE_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_MARKETPLACE_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_MARKETPLACE_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W526 #5 - marketplace route source preserves live verification and manual-review invariants', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/marketplace/catalog.json'");
  const end = router.indexOf("r.get('/v1/marketplace/:slug/download'", start);
  assert.ok(start > 0 && end > start, 'marketplace catalog route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /res\.set\('Cache-Control', 'public, max-age=300'\)/);
  assert.match(block, /marketplaceGetCatalogManifest\(\)/);
  assert.match(block, /cat\.artifacts = await __hydrateVerified\(cat\.artifacts \|\| \[\]\)/);
  assert.match(block, /marketplaceListArtifacts\(\{ filter \}\)/);
  assert.match(block, /arr = await __hydrateVerified\(arr\)/);
  assert.ok(
    block.indexOf('arr = await __hydrateVerified(arr)') < block.indexOf('if (wantVerified)'),
    'verified=true filter must run after live verification overlay',
  );
  assert.match(block, /path\.join\(os\.tmpdir\(\), 'kolm-marketplace-queue'\)/);
  assert.match(block, /fs\.appendFileSync\(path\.join\(queueDir, 'publish-queue\.jsonl'\)/);
  assert.match(block, /res\.status\(202\)\.json\(\{ ok: true, queue_id: queueId, status: 'manual_review_queue'/);
  assert.match(block, /marketplaceGetArtifact\(String\(req\.params\.slug \|\| ''\)\)/);
  assert.match(block, /unknown_slug/);
  assert.match(block, /const v = await __verifyArtifactCached\(a\)/);
  assert.match(block, /verified:\s*v\.ok/);
  assert.match(block, /production_ready:\s*v\.ok/);
});

test('W526 #6 - marketplace route behavior tests remain wired to live verification checks', () => {
  const gateTest = read('tests/wave342-marketplace-gate.test.js');
  const installTest = read('tests/wave409x-marketplace-gate.test.js');
  const provisionalTest = read('tests/wave428-marketplace-verified-provisional.test.js');

  assert.match(gateTest, /GET \/v1\/marketplace \+ \/v1\/marketplace\/catalog\.json \+ \/v1\/marketplace\/list/);
  assert.match(gateTest, /GET \/v1\/marketplace\/:slug carries verified \+ gate_reasons/);
  assert.match(installTest, /installArtifactFromBytes accepts a real production_ready fixture/);
  assert.match(provisionalTest, /verified_provisional/);
});

test('W526 #7 - OpenAPI generator refreshes documented routes that used to be source-indexed', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
  assert.match(openapiGenerator, /delete op\['x-kolm-undocumented'\]/);
});
