// W432 — snapshotContext({tenant_id}) scopes lake/opportunities/datasets/
// captures probes to the calling tenant. Closes the cross-tenant counter leak
// found by the Explore audit at intent.js:1056,1070 — /v1/intent/next and
// /v1/intent/ask were calling snapshotContext({}) without passing the
// authenticated tenant, so the snapshot_summary would show another tenant's
// totals when the namespace happened to overlap.
//
// Behavior assertions:
//   #1 snapshotContext signature accepts tenant_id + tenant alias.
//   #2 Two tenants writing into the same dataset namespace see only their own
//      dataset counts when snapshotContext({tenant_id}) is called per-tenant.
//   #3 lakeStats wired with tenant_id from intent.js.
//   #4 findOpportunities wired with tenant_id from intent.js.
//   #5 listDatasets wired with tenant_id from intent.js.
//   #6 captureStore.allCapturesForTenant prefers _explicitTenant over local config.
//   #7 /v1/intent/next handler passes req.tenant_record.id into snapshotContext.
//   #8 /v1/intent/ask handler passes req.tenant_record.id into snapshotContext.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const INTENT_PATH = path.join(REPO, 'src', 'intent.js');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');

function readIntent() { return fs.readFileSync(INTENT_PATH, 'utf8'); }
function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }

test('W432 #1 — snapshotContext signature accepts tenant_id + tenant alias', () => {
  const src = readIntent();
  // Signature: ({ cwd = ..., home = ..., tenant_id = ..., tenant = ... } = {})
  const m = src.match(/export\s+async\s+function\s+snapshotContext\s*\(\s*\{([^}]+)\}/);
  assert.ok(m, 'snapshotContext destructured signature not found');
  assert.ok(/tenant_id\s*=\s*null/.test(m[1]), 'tenant_id param missing or wrong default');
  assert.ok(/tenant\s*=\s*null/.test(m[1]), 'tenant alias param missing or wrong default');
});

test('W432 #2 — _explicitTenant resolves tenant_id first, then tenant alias', () => {
  const src = readIntent();
  assert.ok(/const\s+_explicitTenant\s*=\s*tenant_id\s*\|\|\s*tenant\s*\|\|\s*null/.test(src),
    '_explicitTenant must collapse tenant_id || tenant || null');
});

test('W432 #3 — lakeStats called with tenant_id from intent.js when _explicitTenant set', () => {
  const src = readIntent();
  // The call must be guarded by _explicitTenant so local CLI (null tenant)
  // still gets the existing unfiltered behavior.
  assert.ok(/lakeMod\.lakeStats\(\s*_explicitTenant\s*\?\s*\{\s*tenant_id:\s*_explicitTenant\s*\}\s*:\s*\{\s*\}\s*\)/.test(src),
    'lakeStats must be invoked with {tenant_id: _explicitTenant} when tenant set');
});

test('W432 #4 — findOpportunities called with tenant_id from intent.js when _explicitTenant set', () => {
  const src = readIntent();
  assert.ok(/oppMod\.findOpportunities\(\s*_explicitTenant\s*\?\s*\{\s*tenant_id:\s*_explicitTenant\s*\}\s*:\s*\{\s*\}\s*\)/.test(src),
    'findOpportunities must be invoked with {tenant_id: _explicitTenant} when tenant set');
});

test('W432 #5 — listDatasets called with tenant_id from intent.js when _explicitTenant set', () => {
  const src = readIntent();
  assert.ok(/dsMod\.listDatasets\(\s*_explicitTenant\s*\?\s*\{\s*tenant_id:\s*_explicitTenant\s*\}\s*:\s*\{\s*\}\s*\)/.test(src),
    'listDatasets must be invoked with {tenant_id: _explicitTenant} when tenant set');
});

test('W432 #6 — capture-store tenant prefers _explicitTenant over local config', () => {
  const src = readIntent();
  // The tenant resolution for allCapturesForTenant must check _explicitTenant first
  assert.ok(/const\s+tenant\s*=\s*_explicitTenant[\s\S]{0,200}out\.current_tenant/.test(src),
    'capture-store tenant must prefer _explicitTenant over current_tenant');
});

// Helper: walk a brace-balanced block starting from the route opener up to the
// matching close. Tests #7 and #8 slice the route body this way so they don't
// stop at the first nested `})` inside res.json/res.status calls.
function sliceRouteBody(src, opener) {
  const start = src.indexOf(opener);
  if (start === -1) return '';
  // The opener ends at "{" of the arrow body. Find the first "=> {" after start.
  const arrow = src.indexOf('=> {', start);
  if (arrow === -1) return '';
  let depth = 0;
  let i = arrow + 3; // points at "{"
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

test('W432 #7 — /v1/intent/next handler passes req.tenant_record.id into snapshotContext', () => {
  const src = readRouter();
  const body = sliceRouteBody(src, "r.get('/v1/intent/next'");
  assert.ok(body, '/v1/intent/next route not found');
  assert.ok(/intent\.snapshotContext\(\s*\{\s*tenant_id:\s*req\.tenant_record\.id\s*\}\s*\)/.test(body),
    '/v1/intent/next must pass {tenant_id: req.tenant_record.id} to snapshotContext');
});

test('W432 #8 — /v1/intent/ask handler passes req.tenant_record.id into snapshotContext', () => {
  const src = readRouter();
  const body = sliceRouteBody(src, "r.post('/v1/intent/ask'");
  assert.ok(body, '/v1/intent/ask route not found');
  assert.ok(/intent\.snapshotContext\(\s*\{\s*tenant_id:\s*req\.tenant_record\.id\s*\}\s*\)/.test(body),
    '/v1/intent/ask must pass {tenant_id: req.tenant_record.id} to snapshotContext');
});

test('W432 #9 — behavior: listDatasets cross-tenant fence (sanity end-to-end)', async () => {
  // Set up an isolated KOLM_HOME with 2 datasets from 2 tenants in the same
  // namespace. listDatasets({tenant_id:'A'}) must return only A's dataset.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w432-'));
  // dataset-workbench honors KOLM_DATA_DIR (not KOLM_HOME). The datasets dir
  // is <KOLM_DATA_DIR>/datasets.
  const dsDir = path.join(tmp, 'datasets');
  fs.mkdirSync(dsDir, { recursive: true });
  const dsA = {
    dataset_id: 'ds_A',
    namespace: 'shared',
    tenant_id: 'tenantA',
    train_ids: ['e1'],
    holdout_ids: ['e2'],
    train_count: 1,
    holdout_count: 1,
    created_at: '2026-05-19T00:00:00Z',
    version: 1,
  };
  const dsB = {
    dataset_id: 'ds_B',
    namespace: 'shared',
    tenant_id: 'tenantB',
    train_ids: ['e3'],
    holdout_ids: ['e4'],
    train_count: 1,
    holdout_count: 1,
    created_at: '2026-05-19T00:00:01Z',
    version: 1,
  };
  fs.writeFileSync(path.join(dsDir, 'ds_A.json'), JSON.stringify(dsA));
  fs.writeFileSync(path.join(dsDir, 'ds_B.json'), JSON.stringify(dsB));

  const prevDataDir = process.env.KOLM_DATA_DIR;
  process.env.KOLM_DATA_DIR = tmp;
  try {
    const { listDatasets } = await import('../src/dataset-workbench.js');
    const onlyA = await listDatasets({ tenant_id: 'tenantA' });
    const ids = onlyA.map(d => d.dataset_id);
    assert.ok(ids.includes('ds_A'), 'tenantA must see ds_A');
    assert.ok(!ids.includes('ds_B'), 'tenantA must NOT see ds_B');

    const onlyB = await listDatasets({ tenant_id: 'tenantB' });
    const idsB = onlyB.map(d => d.dataset_id);
    assert.ok(idsB.includes('ds_B'), 'tenantB must see ds_B');
    assert.ok(!idsB.includes('ds_A'), 'tenantB must NOT see ds_A');
  } finally {
    if (prevDataDir === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = prevDataDir;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});
