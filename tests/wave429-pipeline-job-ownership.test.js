// W429 — pipeline job ownership uses canonical tenant id (audit P1-5).
//
// Bug: _newPipelineJob stamped `_ownedBy: req.tenant` (the human-readable
// tenant *name*), and the matching GET /v1/pipeline/jobs/:id +
// .../stream guards compared against `req.tenant` again. After the W419/
// W420/W432 wave canonicalized auth on `req.tenant_record.id`, two tenants
// sharing a legacy name (e.g. both 'local-tenant' mid-migration) could
// silently read each other's pipeline phases — or worse, when a future
// refactor stops setting `req.tenant` the entire check would no-op.
//
// Lock-in:
//   #1 _jobOwnerKey helper exists and prefers req.tenant_record.id over
//      req.tenant.
//   #2 _newPipelineJob stamps _ownedBy from _jobOwnerKey(req).
//   #3 GET /v1/pipeline/jobs/:id compares with _jobOwnerKey(req), not raw
//      req.tenant.
//   #4 GET /v1/pipeline/jobs/:id/stream same.
//   #5 No live `_ownedBy !== req.tenant` comparison remains (regression
//      guard — the old pattern is gone).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');

test('W429 #1 — _jobOwnerKey prefers req.tenant_record.id over req.tenant', () => {
  const src = routerSrc();
  assert.ok(/function\s+_jobOwnerKey\s*\(\s*req\s*\)\s*\{[\s\S]*?req\.tenant_record[\s\S]*?\.id[\s\S]*?\|\|[\s\S]*?req\.tenant/.test(src),
    '_jobOwnerKey must collapse req.tenant_record.id || req.tenant');
});

test('W429 #2 — _newPipelineJob stamps _ownedBy from _jobOwnerKey(req)', () => {
  const src = routerSrc();
  const idx = src.indexOf('function _newPipelineJob');
  assert.ok(idx !== -1, '_newPipelineJob must exist');
  const block = src.slice(idx, idx + 600);
  assert.ok(/_ownedBy:\s*_jobOwnerKey\(\s*req\s*\)/.test(block),
    '_newPipelineJob must call _jobOwnerKey(req) for _ownedBy');
  // Regression: must NOT still write the raw req.tenant pattern.
  assert.ok(!/_ownedBy:\s*req\.tenant\b(?!_record)/.test(block),
    '_newPipelineJob must not stamp the bare req.tenant name as _ownedBy');
});

test('W429 #3 — GET /v1/pipeline/jobs/:id compares with _jobOwnerKey(req)', () => {
  const src = routerSrc();
  const idx = src.indexOf("r.get('/v1/pipeline/jobs/:id'");
  assert.ok(idx !== -1, '/v1/pipeline/jobs/:id route must exist');
  const block = src.slice(idx, idx + 500);
  assert.ok(/job\._ownedBy\s*!==\s*_jobOwnerKey\(\s*req\s*\)/.test(block),
    'jobs/:id must compare _ownedBy against _jobOwnerKey(req)');
});

test('W429 #4 — GET /v1/pipeline/jobs/:id/stream compares with _jobOwnerKey(req)', () => {
  const src = routerSrc();
  const idx = src.indexOf("r.get('/v1/pipeline/jobs/:id/stream'");
  assert.ok(idx !== -1, '/v1/pipeline/jobs/:id/stream route must exist');
  const block = src.slice(idx, idx + 500);
  assert.ok(/job\._ownedBy\s*!==\s*_jobOwnerKey\(\s*req\s*\)/.test(block),
    'jobs/:id/stream must compare _ownedBy against _jobOwnerKey(req)');
});

test('W429 #5 — no live `_ownedBy !== req.tenant` comparison remains', () => {
  const src = routerSrc();
  // Pattern the audit flagged: bare req.tenant compare.
  // The replacement is _jobOwnerKey(req), so the raw name compare must be gone.
  const matches = src.match(/job\._ownedBy\s*!==\s*req\.tenant\b(?!_record)/g) || [];
  assert.equal(matches.length, 0,
    'no live `job._ownedBy !== req.tenant` comparisons should remain (W429 regression guard)');
});
