// Wave 514 - device capability and fleet routes are documented public APIs.

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

const DEVICE_ROUTES = [
  ['GET', '/v1/device/profiles', /Device capability profiles - list static target profiles/],
  ['GET', '/v1/device/profiles/:device_id', /Device capability profile detail - returns one static profile/],
  ['POST', '/v1/device/check', /Device requirement check - compares a target profile/],
  ['POST', '/v1/device/probe', /Device host probe - detects this server's local profile/],
  ['GET', '/v1/devices', /Device fleet list - enumerates operator-registered device profiles/],
  ['GET', '/v1/devices/detect', /Device fleet detect - probes local hardware/],
  ['POST', '/v1/devices/detect', /Device fleet detect with hints - refreshes local inventory/],
  ['POST', '/v1/devices/:id/register', /Device fleet registration - validates and stores a canonical profile/],
  ['POST', '/v1/devices/:id/test', /Device fleet test - probes reachability and runtime status/],
  ['GET', '/v1/devices/installed', /Device install list - returns staged artifact installs/],
  ['POST', '/v1/devices/:id/install', /Device artifact install - stages a \.kolm artifact/],
  ['DELETE', '/v1/devices/:id/install/:artifact_id', /Device artifact uninstall - removes a staged artifact install/],
  ['POST', '/v1/devices/recommend', /Device recommendation - chooses runtime target and quantization/],
  ['GET', '/v1/devices/recommend', /Device recommendation default - recommends target and quantization/],
];

test('W514 #1 - device capability and fleet routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of DEVICE_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W514 #2 - device routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of DEVICE_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W514 #3 - generated OpenAPI summaries refresh for previously docs-pending device routes', () => {
  for (const [method, routePath] of DEVICE_ROUTES.filter(([m, p]) => !(m === 'POST' && (p === '/v1/devices/detect' || p === '/v1/devices/recommend')))) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W514 #4 - generated public contracts do not expose stale device UI notes', () => {
  for (const rel of ['public/docs/api-routes.json', 'public/docs/api.html', 'public/openapi.json']) {
    const text = read(rel);
    assert.equal(text.includes('devices.html POSTs'), false, `${rel} must not expose internal device page notes`);
    assert.equal(text.includes('without writing the heuristic'), false, `${rel} must not expose implementation-note wording`);
  }
});

test('W514 #5 - OpenAPI generator refreshes stale device summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleDeviceCopy/);
  assert.match(openapiGenerator, /devices\\.html POSTs/);
});
