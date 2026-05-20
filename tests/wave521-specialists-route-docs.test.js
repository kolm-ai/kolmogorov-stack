// Wave 521 - specialist route contracts are documented and scrub internal notes.

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

const SPECIALIST_ROUTES = [
  ['GET', '/v1/specialists', /Specialists list - returns tenant-visible specialist jobs/],
  ['GET', '/v1/specialists/:id', /Specialist detail - returns one accessible specialist record/],
  ['POST', '/v1/specialists/:id/run', /Specialist run - executes the specialist preview/],
  ['GET', '/v1/specialists/:id/weights', /Specialist weights - returns completed weight metadata/],
  ['POST', '/v1/specialists/auto-distill', /Specialist auto-distill - turns 1,000\+ kept namespace captures/],
  ['POST', '/v1/specialists/train', /Specialist train - queues tenant specialist training/],
  ['POST', '/v1/specialists/waitlist', /Specialist waitlist - captures guided-training interest/],
];

const STALE_SPECIALIST_COPY = /undocumented route - wired in source|W364|KOLM_TRAINER_BRIDGE_URL|legacy operator-managed cluster/i;

test('W521 #1 - specialist routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of SPECIALIST_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W521 #2 - specialist routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of SPECIALIST_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W521 #3 - generated OpenAPI specialist summaries follow source comments', () => {
  for (const [method, routePath] of SPECIALIST_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W521 #4 - specialist generated contracts do not expose stale internal route notes', () => {
  for (const [method, routePath] of SPECIALIST_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_SPECIALIST_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_SPECIALIST_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_SPECIALIST_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W521 #5 - specialist route HTML blocks are documented, not docs-pending placeholders', () => {
  for (const [method, routePath] of SPECIALIST_ROUTES) {
    const section = routeHtmlSection(method, routePath);
    assert.doesNotMatch(section, /No inline description in route source/);
    assert.doesNotMatch(section, /docs pending/);
  }
});

test('W521 #6 - OpenAPI generator refreshes stale specialist summaries', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationContainsStaleSpecialistsCopy/);
  assert.ok(openapiGenerator.includes("route.path === '/v1/specialists/waitlist'"));
  assert.match(openapiGenerator, /KOLM_TRAINER_BRIDGE_URL/);
  assert.match(openapiGenerator, /legacy operator-managed cluster/);
});
