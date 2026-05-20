// Wave 540 - authenticated workflow simulation routes are documented public contracts.

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

const SIM_ROUTES = [
  ['POST', '/v1/sim/run', /Sim run - creates a workflow simulation and emits synthetic events/],
  ['GET', '/v1/sim', /Sim list - returns saved workflow simulations/],
  ['GET', '/v1/sim/:id', /Sim detail - returns one saved workflow simulation record/],
];

const STALE_SIM_COPY = /source-indexed route; contract generated from route source|No inline description in route source|docs pending|simulation$/i;

test('W540 #1 - workflow simulation routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of SIM_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain source-indexed`);
    assert.match(hit.short || '', summary);
  }
});

test('W540 #2 - workflow simulation routes are reference-ready in OpenAPI', () => {
  for (const [method, routePath] of SIM_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not use legacy undocumented flag`);
    assert.equal(op['x-kolm-source-indexed'], undefined, `${method} ${routePath} must not remain source-indexed`);
  }
});

test('W540 #3 - generated OpenAPI workflow simulation summaries follow source comments', () => {
  for (const [method, routePath] of SIM_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W540 #4 - generated workflow simulation contracts do not expose source-indexed placeholders', () => {
  for (const [method, routePath] of SIM_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_SIM_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_SIM_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_SIM_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W540 #5 - workflow simulation route source preserves auth mount, create/run, list, and detail behavior', () => {
  const router = read('src/router.js');
  const authMount = router.indexOf('r.use(authMiddleware)');
  const start = router.indexOf('// ============== W384: simulation ==============');
  const end = router.indexOf('// ============== W384: bakeoff ==============', start);
  assert.ok(authMount > 0 && start > authMount && end > start, 'simulation block must be mounted behind global authMiddleware');
  const block = router.slice(start, end);

  assert.match(block, /r\.post\('\/v1\/sim\/run',\s*async \(req,\s*res\) =>/);
  assert.match(block, /simCreateSim\(body\.workflow_id \|\| 'default',\s*\{/);
  assert.match(block, /type:\s*body\.type/);
  assert.match(block, /n:\s*body\.n/);
  assert.match(block, /personas:\s*body\.personas/);
  assert.match(block, /opts:\s*body\.opts \|\| \{\}/);
  assert.match(block, /simRunSim\(sim\.sim_id,\s*\{ n: body\.n, opts: \{ \.\.\.body\.opts, toLake: body\.toLake !== false \} \}\)/);
  assert.match(block, /res\.json\(\{ ok: true, sim_id: sim\.sim_id, type: sim\.type, \.\.\.result \}\)/);
  assert.match(block, /sim_run_error/);
  assert.match(block, /r\.get\('\/v1\/sim',\s*\(req,\s*res\) =>/);
  assert.match(block, /const rows = simListSims\(\)/);
  assert.match(block, /res\.json\(\{ ok: true, total: rows\.length, sims: rows, types: SIM_TYPES \}\)/);
  assert.match(block, /r\.get\('\/v1\/sim\/:id',\s*\(req,\s*res\) =>/);
  assert.match(block, /const sim = simReadRaw\(req\.params\.id\)/);
  assert.match(block, /if \(!sim\) return res\.status\(404\)\.json\(\{ error: 'sim_not_found' \}\)/);
  assert.match(block, /res\.json\(\{ ok: true, sim \}\)/);
});

test('W540 #6 - simulation module keeps offline synthetic event and dataset boundaries', () => {
  const sim = read('src/simulation.js');

  assert.match(sim, /export const SIM_TYPES = Object\.freeze\(\[/);
  assert.match(sim, /'privacy_red_team_simulator'/);
  assert.match(sim, /const SIM_DIR = \(\) => path\.join\(os\.homedir\(\), '\.kolm', 'simulations'\)/);
  assert.match(sim, /throw new Error\('unsupported sim type: ' \+ type/);
  assert.match(sim, /status:\s*'created'/);
  assert.match(sim, /ev\.sim_id = sim\.sim_id/);
  assert.match(sim, /sim\.events = \(sim\.events \|\| \[\]\)\.concat\(events\)/);
  assert.match(sim, /opts\.toLake !== false/);
  assert.match(sim, /source_type:\s*'synthetic'/);
  assert.match(sim, /holdoutFromSim \? rows\.slice/);
  assert.match(sim, /holdout_synthetic_warning:\s*holdoutFromSim/);
  assert.match(sim, /export function listSims\(\)/);
  assert.match(sim, /return out\.sort/);
});

test('W540 #7 - existing workflow simulation behavior tests remain wired', () => {
  const builderTest = read('tests/wave371-builder.test.js');
  const routerWiringTest = read('tests/wave384-router-wiring.test.js');

  assert.match(builderTest, /sim\.createSim writes ~\/\.kolm\/simulations\/<id>\.json/);
  assert.match(builderTest, /sim\.runSim emits N events with sim_id tag/);
  assert.match(builderTest, /privacy_red_team_simulator produces PII inputs/);
  assert.match(builderTest, /sim\.generateDatasetFromSim writes dataset with synthetic rows and empty holdout by default/);
  assert.match(routerWiringTest, /POST \/v1\/sim\/run returns sim_id \+ status \+ events/);
});

test('W540 #8 - OpenAPI generator refreshes documented routes that used to be source-indexed', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
  assert.match(openapiGenerator, /delete op\['x-kolm-undocumented'\]/);
});
