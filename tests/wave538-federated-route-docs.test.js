// Wave 538 - federated learning foundation routes are documented public contracts.

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

const FL_ROUTES = [
  ['POST', '/v1/fl/round/new', /Federated round create - creates a foundation-state round/],
  ['POST', '/v1/fl/contribution/verify', /Federated contribution verify - checks a client update receipt/],
  ['POST', '/v1/fl/aggregate', /Federated aggregate - folds verified client deltas/],
];

const STALE_FL_COPY = /source-indexed route; contract generated from route source|No inline description in route source|docs pending|federated learning$/i;

test('W538 #1 - federated learning routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of FL_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain source-indexed`);
    assert.match(hit.short || '', summary);
  }
});

test('W538 #2 - federated learning routes are reference-ready in OpenAPI', () => {
  for (const [method, routePath] of FL_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not use legacy undocumented flag`);
    assert.equal(op['x-kolm-source-indexed'], undefined, `${method} ${routePath} must not remain source-indexed`);
  }
});

test('W538 #3 - generated OpenAPI federated summaries follow source comments', () => {
  for (const [method, routePath] of FL_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W538 #4 - generated federated contracts do not expose source-indexed placeholders', () => {
  for (const [method, routePath] of FL_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_FL_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_FL_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_FL_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W538 #5 - federated route source preserves auth, shape checks, and module calls', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/fl/strategies'");
  const end = router.indexOf('// ----- lineage + capability -----', start);
  assert.ok(start > 0 && end > start, 'federated route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /r\.post\('\/v1\/fl\/round\/new',\s*wave144Limiter,\s*authMiddleware/);
  assert.match(block, /federatedLearning\.newRound\(req\.body \|\| \{\}\)/);
  assert.match(block, /federatedLearning\.roundHash\(round\)/);
  assert.match(block, /r\.post\('\/v1\/fl\/contribution\/verify',\s*wave144Limiter,\s*authMiddleware/);
  assert.match(block, /if \(!contribution \|\| !round \|\| !public_key\) return _http400\(res, 'contribution, round, and public_key required'\)/);
  assert.match(block, /federatedLearning\.verifyContribution\(\{ contribution, round, public_key \}\)/);
  assert.match(block, /r\.post\('\/v1\/fl\/aggregate',\s*wave144Limiter,\s*authMiddleware/);
  assert.match(block, /if \(!round \|\| !Array\.isArray\(contributions\)\) return _http400\(res, 'round and contributions\[\] required'\)/);
  assert.match(block, /federatedLearning\.aggregate\(\{ round, contributions \}\)/);
});

test('W538 #6 - federated module keeps honest foundation-state boundaries', () => {
  const fl = read('src/federated-learning.js');

  assert.match(fl, /export const FEATURE_STATE = 'foundation'/);
  assert.match(fl, /No secure-aggregation, no network transport, no production Byzantine robustness/);
  assert.match(fl, /transport:\s*transport \|\| 'in_memory_dev_only'/);
  assert.match(fl, /status:\s*'not_verified'/);
  assert.match(fl, /byzantine_robust:\s*false/);
  assert.match(fl, /privacy_budget:\s*\{ epsilon: null, delta: null \}/);
  assert.match(fl, /if \(contributions\.length < round\.min_participants\)/);
  assert.match(fl, /duplicate participant_id/);
  assert.match(fl, /unreviewed_client_update/);
});

test('W538 #7 - existing federated behavior tests remain wired', () => {
  const apiTest = read('tests/wave144-api.test.js');
  const foundationTest = read('tests/wave409u-federated-foundation.test.js');

  assert.match(apiTest, /\/v1\/fl\/round\/new/);
  assert.match(apiTest, /\/v1\/fl\/contribution\/verify/);
  assert.match(apiTest, /\/v1\/fl\/aggregate/);
  assert.match(foundationTest, /aggregation_round schema fields populated by aggregate\(\)/);
  assert.match(foundationTest, /verifyContribution rejects an unreviewed client_update/);
});

test('W538 #8 - OpenAPI generator refreshes documented routes that used to be source-indexed', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
  assert.match(openapiGenerator, /delete op\['x-kolm-undocumented'\]/);
});
