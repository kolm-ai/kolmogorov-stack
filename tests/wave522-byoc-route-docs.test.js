// Wave 522 - BYOC routes are documented public API contracts.

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

const BYOC_ROUTES = [
  ['POST', '/v1/byoc/deploy', /Customer deploys a \.kolm artifact to their own/],
  ['GET', '/v1/byoc/deployments', /BYOC deployments list - returns tenant deployments/],
  ['GET', '/v1/byoc/deployments/:id', /BYOC deployment detail - returns one deployment/],
  ['DELETE', '/v1/byoc/deployments/:id', /BYOC deployment teardown - marks an owned deployment torn down/],
  ['POST', '/v1/byoc/attestation', /Attestation callback/],
  ['GET', '/v1/byoc/targets', /BYOC targets - lists supported deploy targets/],
];

test('W522 #1 - BYOC routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of BYOC_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W522 #2 - BYOC routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of BYOC_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W522 #3 - generated OpenAPI BYOC summaries follow source comments', () => {
  for (const [method, routePath] of BYOC_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W522 #4 - BYOC route HTML blocks are documented, not docs-pending placeholders', () => {
  for (const [method, routePath] of BYOC_ROUTES) {
    const section = routeHtmlSection(method, routePath);
    assert.doesNotMatch(section, /No inline description in route source/);
    assert.doesNotMatch(section, /docs pending/);
  }
});

test('W522 #5 - BYOC team-scoped deployment listing proves membership before listing team rows', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/byoc/deployments'");
  const end = router.indexOf("r.get('/v1/byoc/deployments/:id'", start);
  assert.ok(start > 0 && end > start, 'BYOC deployments list handler must be located');
  const handler = router.slice(start, end);

  assert.match(handler, /const team_id = req\.query\.team_id/);
  assert.match(handler, /team_id && !teams\.isMember\(team_id, t\.id\)/);
  assert.ok(
    handler.indexOf('teams.isMember(team_id, t.id)') < handler.indexOf('byoc.listDeploymentsForTenant'),
    'membership check must happen before listDeploymentsForTenant gets teamId',
  );
});

test('W522 #6 - OpenAPI generator refreshes documented routes that used to be docs-pending', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
});
