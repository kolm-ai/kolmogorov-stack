// Wave 515 - notification threshold and WebPush routes are documented public APIs.

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

const NOTIFICATION_ROUTES = [
  ['GET', '/v1/notifications/config', /Notifications config - public VAPID\/email capability flags/],
  ['GET', '/v1/notifications/preferences', /Notification preferences - returns tenant alert opt-in settings/],
  ['PUT', '/v1/notifications/preferences', /Notification preferences update - sets threshold alert opt-in/],
  ['GET', '/v1/notifications/push-subscriptions', /Push subscription list - returns registered WebPush endpoints/],
  ['POST', '/v1/notifications/push-subscriptions', /Push subscription registration - stores an allowlisted HTTPS WebPush endpoint/],
  ['DELETE', '/v1/notifications/push-subscriptions', /Push subscription removal - deletes a subscription by endpoint/],
  ['POST', '/v1/notifications/test', /Notification test alert - fires a synthetic threshold alert/],
  ['GET', '/v1/notifications/state', /Notification threshold state - returns per-namespace alert state/],
];

test('W515 #1 - notification routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of NOTIFICATION_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W515 #2 - notification routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of NOTIFICATION_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W515 #3 - generated OpenAPI notification summaries follow source comments', () => {
  for (const [method, routePath] of NOTIFICATION_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W515 #4 - generated public contracts do not expose stale notification route-list notes', () => {
  for (const rel of ['public/docs/api-routes.json', 'public/docs/api.html', 'public/openapi.json']) {
    const text = read(rel);
    assert.equal(text.includes('GET    /v1/notifications/push-subscriptions'), false, `${rel} must not expose old route-list comments`);
    assert.equal(text.includes('POST   /v1/notifications/test'), false, `${rel} must not expose old route-list comments`);
    assert.equal(text.includes('fire a dummy threshold alert (preview)'), false, `${rel} must not expose preview wording`);
  }
});

test('W515 #5 - OpenAPI generator refreshes stale notification summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleNotificationsCopy/);
  assert.match(openapiGenerator, /push-subscriptions/);
});
