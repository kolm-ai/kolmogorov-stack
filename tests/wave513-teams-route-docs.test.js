// Wave 513 - organization team-management routes are documented public APIs.

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

const TEAM_ROUTES = [
  ['POST', '/v1/teams', /Team creation - creates a paid-plan workspace/],
  ['GET', '/v1/teams', /Team list - returns active teams for the signed-in tenant/],
  ['GET', '/v1/teams/:idOrSlug', /Team detail - returns team, member, and pending-invite data/],
  ['PATCH', '/v1/teams/:idOrSlug', /Team update - admin-only rename, plan, and seat-limit updates/],
  ['DELETE', '/v1/teams/:idOrSlug', /Team delete - owner-only soft delete/],
  ['POST', '/v1/teams/:idOrSlug/transfer', /Team ownership transfer - owner-only handoff/],
  ['POST', '/v1/teams/:idOrSlug/invite', /Team invite - admin-only invite that enforces seat limits/],
  ['GET', '/v1/teams/invites/:token', /Team invite preview - public token lookup/],
  ['POST', '/v1/teams/invites/:token/accept', /Team invite acceptance - signed-in tenant accepts/],
  ['DELETE', '/v1/teams/invites/:invite_id', /Team invite revoke - admin-only deletion/],
  ['PATCH', '/v1/teams/:idOrSlug/members/:tenant_id', /Team member role update - admin-only role changes/],
  ['DELETE', '/v1/teams/:idOrSlug/members/:tenant_id', /Team member removal - members may leave/],
];

test('W513 #1 - all /v1/teams routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of TEAM_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W513 #2 - team routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of TEAM_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W513 #3 - generated OpenAPI summaries for team routes follow source comments', () => {
  for (const [method, routePath] of TEAM_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});
