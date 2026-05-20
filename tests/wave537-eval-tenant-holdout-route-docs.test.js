// Wave 537 - eval tenant holdout routes are documented public contracts.

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

const EVAL_HOLDOUT_ROUTES = [
  ['GET', '/v1/eval/tenant_holdout', /Tenant holdout list - returns the authenticated tenant's retained shadow corpus/],
  ['GET', '/v1/eval/tenant_holdout/:corpus_id', /Tenant holdout detail - returns hash and size metadata/],
  ['DELETE', '/v1/eval/tenant_holdout/:corpus_id', /Tenant holdout delete - removes one authenticated tenant corpus/],
];

const STALE_EVAL_COPY = /source-indexed route; contract generated from route source|No inline description in route source|docs pending|All four are authed/i;

test('W537 #1 - eval tenant holdout routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of EVAL_HOLDOUT_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain source-indexed`);
    assert.match(hit.short || '', summary);
  }
});

test('W537 #2 - eval tenant holdout routes are reference-ready in OpenAPI', () => {
  for (const [method, routePath] of EVAL_HOLDOUT_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not use legacy undocumented flag`);
    assert.equal(op['x-kolm-source-indexed'], undefined, `${method} ${routePath} must not remain source-indexed`);
  }
});

test('W537 #3 - generated OpenAPI eval summaries follow source comments', () => {
  for (const [method, routePath] of EVAL_HOLDOUT_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W537 #4 - generated eval contracts do not expose source-indexed placeholders', () => {
  for (const [method, routePath] of EVAL_HOLDOUT_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_EVAL_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_EVAL_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_EVAL_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W537 #5 - eval tenant holdout route source preserves tenant scope and row redaction', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.post('/v1/eval/tenant_holdout'");
  const end = router.indexOf('// Verify a provenance credential', start);
  assert.ok(start > 0 && end > start, 'tenant holdout route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /const tenantId = req\.tenant_record\?\.id/);
  assert.match(block, /saveTenantCorpus\(tenantId,\s*String\(corpus_id\),\s*rows,\s*\{ replace: replace === true \}\)/);
  assert.match(block, /listTenantCorpora\(tenantId\)/);
  assert.match(block, /loadTenantCorpus\(tenantId,\s*corpusId\)/);
  assert.match(block, /deleteTenantCorpus\(tenantId,\s*corpusId\)/);
  assert.match(block, /res\.json\(\{\s*tenant_id:\s*loaded\.tenant_id,\s*corpus_id:\s*loaded\.corpus_id,[\s\S]*?residency_note:\s*'corpus retained on tenant infrastructure; bytes not included in this response'/);
  assert.doesNotMatch(block, /rows:\s*loaded\.rows/);
  assert.match(block, /tryAppendAudit\(AUDIT_OPS\.EVAL_TENANT_HOLDOUT_DELETE/);
});

test('W537 #6 - tenant holdout storage keeps tenant and corpus ids filesystem-safe', () => {
  const tenantHoldout = read('src/tenant-holdout.js');

  assert.match(tenantHoldout, /const SAFE_ID = \/\^\[a-z0-9\]\[a-z0-9_-\]\{0,62\}\$\/i/);
  assert.match(tenantHoldout, /throw new Error\(`tenant-holdout: tenant_id='\$\{tenantId\}' must match \$\{SAFE_ID\}`\)/);
  assert.match(tenantHoldout, /throw new Error\(`tenant-holdout: corpus_id='\$\{corpusId\}' must match \$\{SAFE_ID\}`\)/);
  assert.match(tenantHoldout, /path\.join\(tenantHoldoutRoot\(opts\),\s*tenantId,\s*`\$\{corpusId\}\.jsonl`\)/);
  assert.match(tenantHoldout, /return fs\.readdirSync\(dir\)[\s\S]*?\.filter\(n => n\.endsWith\('\.jsonl'\)\)/);
  assert.match(tenantHoldout, /return \{ deleted: false, reason: 'not found' \}/);
});

test('W537 #7 - OpenAPI generator refreshes documented routes that used to be source-indexed', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
  assert.match(openapiGenerator, /delete op\['x-kolm-undocumented'\]/);
});
