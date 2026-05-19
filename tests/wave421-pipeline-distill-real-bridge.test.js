// W421 — /v1/pipeline/distill calls the real distill-bridge entrypoint
// (audit P0-3). Before W421, the route looked for
// `dist.synthesizeFromCaptures` which has never existed — the real export
// is `startDistillJob`. So the route was a silent no-op and the docs
// claim that /v1/pipeline/distill kicks off a distill was a lie.
//
// Lock-in:
//   #1 distill-bridge exports startDistillJob (not synthesizeFromCaptures).
//   #2 /v1/pipeline/distill requires req.tenant_record (401 envelope).
//   #3 /v1/pipeline/distill route imports event-store + reads captures
//      filtered by {namespace, tenant_id: req.tenant_record.id}.
//   #4 /v1/pipeline/distill route invokes dist.startDistillJob with
//      tenant from req.tenant_record.id (not req.tenant).
//   #5 The dead reference `synthesizeFromCaptures` is no longer in the
//      route body (regression guard).
//   #6 not_enough_captures path emits a distill phase with error so the
//      caller can see why the job failed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');
const BRIDGE_PATH = path.join(REPO, 'src', 'distill-bridge.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');
const bridgeSrc = () => fs.readFileSync(BRIDGE_PATH, 'utf8');

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

test('W421 #1 — distill-bridge exports startDistillJob', () => {
  const src = bridgeSrc();
  assert.ok(/export\s+async\s+function\s+startDistillJob\b/.test(src),
    'distill-bridge.js must export startDistillJob');
});

test('W421 #2 — /v1/pipeline/distill requires req.tenant_record', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/distill'");
  assert.ok(body, '/v1/pipeline/distill route not found');
  assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)\s*\.json\(\s*\{\s*ok:\s*false,\s*error:\s*['"]auth required['"]/.test(body),
    '/v1/pipeline/distill must 401 with canonical envelope');
});

test('W421 #3 — route reads captures filtered by tenant_id', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/distill'");
  // listEvents call carries both namespace and tenant_id: req.tenant_record.id
  assert.ok(/evMod\.listEvents\(\s*\{[\s\S]*?tenant_id:\s*req\.tenant_record\.id/.test(body),
    'route must call event-store listEvents with tenant_id from req.tenant_record.id');
  assert.ok(/import\(\s*['"]\.\/event-store\.js['"]\s*\)/.test(body),
    'route must import event-store for the corpus read');
});

test('W421 #4 — route invokes dist.startDistillJob with tenant_id from req.tenant_record.id', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/distill'");
  assert.ok(/dist\.startDistillJob\(\s*\{[\s\S]*?tenant:\s*req\.tenant_record\.id/.test(body),
    'startDistillJob must receive tenant: req.tenant_record.id');
});

test('W421 #5 — dead reference synthesizeFromCaptures is no longer CALLED', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/distill'");
  // The comment may still mention the historical name for documentation, but
  // there must be no live `dist.synthesizeFromCaptures(` call or
  // `typeof dist.synthesizeFromCaptures` runtime probe.
  assert.ok(!/dist\.synthesizeFromCaptures\s*\(/.test(body),
    'route must not invoke dist.synthesizeFromCaptures()');
  assert.ok(!/typeof\s+dist\.synthesizeFromCaptures/.test(body),
    'route must not probe for dist.synthesizeFromCaptures');
});

test('W421 #6 — not_enough_captures path emits a distill phase with error', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/pipeline/distill'");
  assert.ok(/not_enough_captures/.test(body),
    'route must surface the not_enough_captures sentinel when the corpus is too small');
});
