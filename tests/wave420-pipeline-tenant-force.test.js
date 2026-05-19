// W420 — force tenant scope on /v1/pipeline/full + /v1/pipeline/compile
// (audit P0-2). Before W420 both routes called compileFull without a
// tenant_id, so the pipeline read the global event store and compiled
// another tenant's corpus into the caller's artifact.
//
// Lock-in:
//   #1 /v1/pipeline/full requires req.tenant_record (401 envelope)
//   #2 /v1/pipeline/full builds scopedOpts containing tenant_id: req.tenant_record.id
//   #3 /v1/pipeline/full passes scopedOpts to pipelineCompileFull, not body.opts directly
//   #4 /v1/pipeline/compile requires req.tenant_record
//   #5 /v1/pipeline/compile builds scopedOpts and passes it down
//   #6 compileFull (src/compile-pipeline.js) honors opts.tenant_id (regression guard)
//   #7 body.opts.tenant_id cannot override the canonical req.tenant_record.id
//      (spreading order: ...body.opts, then tenant_id — last write wins)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');
const COMPILE_PATH = path.join(REPO, 'src', 'compile-pipeline.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');
const compileSrc = () => fs.readFileSync(COMPILE_PATH, 'utf8');

function sliceRouteBody(src, opener) {
  const start = src.indexOf(opener);
  if (start === -1) return '';
  const arrow = src.indexOf('=> {', start);
  if (arrow === -1) return '';
  let depth = 0;
  let i = arrow + 3;
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

test('W420 #1 — /v1/pipeline/full requires req.tenant_record (401)', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/full'");
  assert.ok(body, '/v1/pipeline/full route not found');
  assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)\s*\.json\(\s*\{\s*ok:\s*false,\s*error:\s*['"]auth required['"]/.test(body),
    '/v1/pipeline/full must 401 with the canonical ok:false envelope when tenant missing');
});

test('W420 #2 — /v1/pipeline/full builds scopedOpts with tenant_id from req.tenant_record.id', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/full'");
  assert.ok(/const\s+scopedOpts\s*=\s*\{\s*\.\.\.\(?body\.opts\s*\|\|\s*\{\}\)?\s*,\s*tenant_id:\s*req\.tenant_record\.id\s*\}/.test(body),
    'scopedOpts must spread body.opts then write tenant_id from req.tenant_record.id');
});

test('W420 #3 — /v1/pipeline/full passes scopedOpts to pipelineCompileFull (not body.opts)', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/full'");
  assert.ok(/pipelineCompileFull\(\s*\{\s*namespace:\s*body\.namespace,\s*opts:\s*scopedOpts\s*\}\s*\)/.test(body),
    'pipelineCompileFull must be called with opts: scopedOpts');
  assert.ok(!/pipelineCompileFull\(\s*\{[^}]*opts:\s*body\.opts/.test(body),
    'must not pass raw body.opts directly');
});

test('W420 #4 — /v1/pipeline/compile requires req.tenant_record (401)', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/compile'");
  assert.ok(body, '/v1/pipeline/compile route not found');
  assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)/.test(body),
    '/v1/pipeline/compile must 401 without tenant');
});

test('W420 #5 — /v1/pipeline/compile builds scopedOpts and passes it down', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/compile'");
  assert.ok(/const\s+scopedOpts\s*=\s*\{\s*\.\.\.\(?body\.opts\s*\|\|\s*\{\}\)?\s*,\s*tenant_id:\s*req\.tenant_record\.id/.test(body),
    'scopedOpts spread + tenant_id');
  assert.ok(/pipelineCompileFull\(\s*\{[^}]*opts:\s*scopedOpts/.test(body),
    'compile route must pass scopedOpts');
});

test('W420 #6 — compileFull honors opts.tenant_id (W411 regression guard)', () => {
  const src = compileSrc();
  // W411 stamped this in. Make sure it stays.
  assert.ok(/const\s+tenantScope\s*=\s*opts\.tenant_id\s*\|\|\s*opts\.tenant\s*\|\|\s*null/.test(src),
    'compileFull must collapse opts.tenant_id || opts.tenant || null into tenantScope');
  assert.ok(/prepareDistillCorpus\(\s*\{[^}]*tenant_id:\s*tenantScope/.test(src),
    'prepareDistillCorpus call must carry tenant_id: tenantScope');
});

test('W420 #7 — body.opts.tenant_id cannot override canonical req.tenant_record.id', () => {
  // The spread `{ ...body.opts, tenant_id: req.tenant_record.id }` means the
  // last write wins — tenant_id always comes from req. This test pins that
  // ordering so a future refactor can't accidentally let an attacker pass
  // {opts:{tenant_id:'victim'}} and steal another tenant's corpus.
  const src = routerSrc();
  const fullBody = sliceRouteBody(src, "r.post('/v1/pipeline/full'");
  const compileBody = sliceRouteBody(src, "r.post('/v1/pipeline/compile'");
  for (const [name, body] of [['full', fullBody], ['compile', compileBody]]) {
    const m = body.match(/const\s+scopedOpts\s*=\s*\{\s*\.\.\.\(?body\.opts\s*\|\|\s*\{\}\)?\s*,\s*tenant_id:\s*req\.tenant_record\.id\s*\}/);
    assert.ok(m, `${name}: scopedOpts must put tenant_id AFTER the body.opts spread (last write wins)`);
  }
});
