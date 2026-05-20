// Wave 539 - workflow IR stateless routes are documented public contracts.

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

const IR_ROUTES = [
  ['POST', '/v1/ir/stats', /IR stats - validates a body-supplied workflow IR/],
  ['POST', '/v1/ir/validate', /IR validate - checks body-supplied workflow IR structure/],
  ['POST', '/v1/ir/replay', /IR replay - replays every workflow IR seed/],
];

const STALE_IR_COPY = /source-indexed route; contract generated from route source|No inline description in route source|docs pending|workflow ir$/i;

test('W539 #1 - workflow IR routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of IR_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain source-indexed`);
    assert.match(hit.short || '', summary);
  }
});

test('W539 #2 - workflow IR routes are reference-ready in OpenAPI', () => {
  for (const [method, routePath] of IR_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not use legacy undocumented flag`);
    assert.equal(op['x-kolm-source-indexed'], undefined, `${method} ${routePath} must not remain source-indexed`);
  }
});

test('W539 #3 - generated OpenAPI workflow IR summaries follow source comments', () => {
  for (const [method, routePath] of IR_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W539 #4 - generated workflow IR contracts do not expose source-indexed placeholders', () => {
  for (const [method, routePath] of IR_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_IR_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_IR_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_IR_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W539 #5 - workflow IR route source preserves public stateless behavior and module calls', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.post('/v1/ir/stats'");
  const end = router.indexOf('// ----- W463: trace compile + verify', start);
  assert.ok(start > 0 && end > start, 'workflow IR public route block must be located');
  const block = router.slice(start, end);

  assert.doesNotMatch(block, /authMiddleware/, 'IR stats/validate/replay must remain public stateless validators');
  assert.match(block, /r\.post\('\/v1\/ir\/stats',\s*wave144Limiter,\s*\(req,\s*res\) =>/);
  assert.match(block, /const ir = _unwrapIrBody\(req\.body \|\| \{\}\)/);
  assert.match(block, /const s = workflowIr\.stats\(ir\)/);
  assert.match(block, /catch \(e\) \{ _http400\(res, e\.message \|\| e\); \}/);
  assert.match(block, /r\.post\('\/v1\/ir\/validate',\s*wave144Limiter,\s*\(req,\s*res\) =>/);
  assert.match(block, /workflowIr\.validateIr\(ir\)/);
  assert.match(block, /res\.json\(\{ ok: true, hash: workflowIr\.hashIr\(ir\) \}\)/);
  assert.match(block, /catch \(e\) \{ res\.json\(\{ ok: false, error: String\(e\.message \|\| e\) \}\); \}/);
  assert.match(block, /r\.post\('\/v1\/ir\/replay',\s*wave144Limiter,\s*async \(req,\s*res\) =>/);
  assert.match(block, /const r2 = await workflowIr\.replaySeeds\(ir\)/);
});

test('W539 #6 - workflow IR module keeps deterministic validation, hash, replay, and stats boundaries', () => {
  const ir = read('src/workflow-ir.js');

  assert.match(ir, /export const WORKFLOW_IR_VERSION = 'wir-v1'/);
  assert.match(ir, /if \(!ir \|\| typeof ir !== 'object'\) throw new Error\('ir must be an object'\)/);
  assert.match(ir, /ir\.nodes must be a non-empty array/);
  assert.match(ir, /ir\.edges must be an array/);
  assert.match(ir, /ir\.seeds must be an array/);
  assert.match(ir, /exactly one INPUT node required/);
  assert.match(ir, /exactly one OUTPUT node required/);
  assert.match(ir, /cycle through node/);
  assert.match(ir, /export function hashIr\(ir\)/);
  assert.match(ir, /validateIr\(ir\);\s*const norm = \{/);
  assert.match(ir, /export async function replaySeeds\(ir, opts = \{\}\)/);
  assert.match(ir, /const \{ output \} = await interpret\(ir, seed\.input, opts\)/);
  assert.match(ir, /return \{ ok: mismatches\.length === 0, mismatches, total: ir\.seeds\.length \}/);
  assert.match(ir, /export function stats\(ir\)/);
  assert.match(ir, /nodes: ir\.nodes\.length/);
  assert.match(ir, /hash: hashIr\(ir\)/);
});

test('W539 #7 - public auth allowlist keeps only stateless workflow IR routes open', () => {
  const auth = read('src/auth.js');

  assert.match(auth, /p === '\/v1\/ir\/stats'/);
  assert.match(auth, /p === '\/v1\/ir\/validate'/);
  assert.match(auth, /p === '\/v1\/ir\/replay'/);
  assert.doesNotMatch(auth, /p === '\/v1\/ir\/compile'/);
  assert.match(auth, /Trace\/IR-compile\/FL-round\/aggregate stay auth-gated above because they touch tenant data/);
});

test('W539 #8 - existing workflow IR behavior tests remain wired', () => {
  const apiTest = read('tests/wave144-api.test.js');
  const traceOwnershipTest = read('tests/wave425-trace-ownership.test.js');
  const traceCompileTest = read('tests/wave463-trace-compile.test.js');

  assert.match(apiTest, /\/v1\/ir\/stats/);
  assert.match(apiTest, /\/v1\/ir\/validate/);
  assert.match(apiTest, /\/v1\/ir\/replay/);
  assert.match(traceOwnershipTest, /r\.post\('\/v1\/ir\/stats'/);
  assert.match(traceOwnershipTest, /ir\/compile route must include tenant_id/);
  assert.match(traceCompileTest, /workflow IR across providers/);
  assert.match(traceCompileTest, /cache-hit replay/);
});

test('W539 #9 - OpenAPI generator refreshes documented routes that used to be source-indexed', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
  assert.match(openapiGenerator, /delete op\['x-kolm-undocumented'\]/);
});
