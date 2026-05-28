// Wave 511 - no-comment routes are wired routes indexed from source, not implementation stubs.

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

function allRoutes() {
  return (ROUTES.groups || []).flatMap((group) => group.routes || []);
}

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

test('W511 #1 - generated public contracts do not claim source-indexed routes are unimplemented', () => {
  for (const rel of [
    'public/docs/api.html',
    'public/openapi.json',
  ]) {
    const text = read(rel);
    assert.doesNotMatch(text, /implementation pending/i, `${rel} must not claim implementation is pending`);
    assert.doesNotMatch(text, /behind a flag/i, `${rel} must not claim undocumented routes are flag-gated`);
    assert.doesNotMatch(text, /stub route/i, `${rel} must not expose old stub-route wording`);
  }
});

test('W511 #2 - API reference presents wired/documentation status accurately', () => {
  const html = read('public/docs/api.html');
  const routes = allRoutes();
  const documented = routes.filter((r) => !r.stub).length;
  const sourceIndexed = routes.filter((r) => r.stub).length;

  assert.match(html, new RegExp(`${routes.length} wired routes`));
  assert.match(html, new RegExp(`>${documented} reference-ready</span>`));
  assert.match(html, new RegExp(`>${sourceIndexed} source-indexed</span>`));
  assert.match(html, /Show reference-ready routes only/);

  // W541 documented every router.js handler so the "Route contract generated
  // from source" placeholder body is no longer rendered (it only appears for
  // routes without `//` comments). It must still appear when a future
  // un-commented route slips in.
  if (sourceIndexed > 0) {
    assert.match(html, /Route contract generated from source/);
  } else {
    assert.doesNotMatch(html, /Route contract generated from source/);
  }

  assert.doesNotMatch(html, /documented routes across 108 groups/);
  assert.doesNotMatch(html, /Hide preview routes/);
  assert.doesNotMatch(html, />preview<\/span>/);
  assert.doesNotMatch(html, />live<\/span>/);
});

test('W511 #3 - OpenAPI uses x-kolm-source-indexed instead of x-kolm-stub', () => {
  const text = read('public/openapi.json');

  assert.doesNotMatch(text, /"x-kolm-stub"/);
  assert.doesNotMatch(text, /"x-kolm-undocumented"/);

  // W541 documented every router.js handler so the source-indexed (stub) set is
  // now empty in steady state. The legacy stub flag must stay scrubbed; the
  // new x-kolm-source-indexed flag only appears if a future addition slips in
  // un-commented. Either state is acceptable - we only fail if a route is BOTH
  // stub:true in the inventory AND the OpenAPI op uses old/missing flags.
  //
  // W890-9/W891 (V1 launch) added live deprecation aliases (e.g.
  // POST /v1/auth/signup -> 410 Gone, redirect to /v1/signup). Those ops are
  // deliberately curated with a richer deprecation contract (deprecated:true,
  // x-kolm-replacement, a human-readable 410 summary) and the generator keeps
  // them verbatim instead of overwriting them with the generic source-indexed
  // stub summary. They are still stub:true in the inventory only because the
  // source classifier indexes any un-commented handler. Exclude curated
  // deprecation ops from the source-indexed invariant - forcing the generic
  // flag/summary onto them would destroy the intentional deprecation docs.
  const remaining = allRoutes().filter((candidate) => {
    const op = operation(candidate.method, candidate.path);
    return candidate.stub && op && !op.deprecated;
  });
  for (const r of remaining) {
    const op = operation(r.method, r.path);
    assert.equal(op['x-kolm-stub'], undefined, `${r.method} ${r.path} still uses x-kolm-stub`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${r.method} ${r.path} still uses x-kolm-undocumented`);
    assert.equal(op['x-kolm-source-indexed'], true, `${r.method} ${r.path} must set x-kolm-source-indexed`);
    assert.match(op.summary, /source-indexed route; contract generated from route source/);
  }
  if (remaining.length === 0) {
    assert.doesNotMatch(text, /"x-kolm-stub"/);
    assert.doesNotMatch(text, /"x-kolm-undocumented"/);
  } else {
    assert.match(text, /"x-kolm-source-indexed"/);
  }
});

test('W511 #4 - generators encode the new public terminology', () => {
  const apiRef = read('scripts/build-api-ref.cjs');
  const openapi = read('scripts/build-openapi.cjs');

  assert.match(apiRef, /source-indexed/);
  assert.match(apiRef, /reference-ready/);
  assert.match(openapi, /x-kolm-source-indexed/);
  assert.match(openapi, /source-indexed route; contract generated from route source/);
  assert.doesNotMatch(openapi, /implementation pending/);
});
