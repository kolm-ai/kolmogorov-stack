// W423 — media capture tenant_id mismatch (audit P0-5).
//
// Bug: /v1/capture/media at src/router.js:8688-ish was calling
//   eventAppend({namespace, tenant: req.tenant, ...})
// But src/event-schema.js newEvent() reads `partial.tenant_id` (not
// `partial.tenant`). So every media capture was stamped with the default
// 'local-tenant' string, and the tenant-scoped lake queries dropped them.
//
// Lock-in:
//   #1 newEvent reads partial.tenant_id (W411 invariant we depend on).
//   #2 /v1/capture/media route does NOT pass `tenant: req.tenant` to eventAppend.
//   #3 /v1/capture/media passes `tenant_id` (the canonical key) to eventAppend.
//   #4 The tenant_id source is `req.tenant_record?.id || req.tenant` so authed
//      callers get their canonical id and local-only daemons still work.
//   #5 Behavior: eventAppend({tenant_id:'tA'}) round-trips tenant_id='tA' through
//      newEvent + canonicalize.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');
const SCHEMA_PATH = path.join(REPO, 'src', 'event-schema.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');
const schemaSrc = () => fs.readFileSync(SCHEMA_PATH, 'utf8');

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

test('W423 #1 — newEvent reads partial.tenant_id (W411 invariant)', () => {
  const src = schemaSrc();
  assert.ok(/tenant_id:\s*partial\.tenant_id/.test(src),
    'event-schema newEvent must read partial.tenant_id');
});

test('W423 #2 — /v1/capture/media no longer sends bare `tenant: req.tenant` to eventAppend', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/capture/media'");
  assert.ok(body, '/v1/capture/media route not found');
  // The eventAppend call inside this route MUST NOT have `tenant: req.tenant`
  // as one of its keys (which is the audit-flagged bug).
  const calls = body.match(/eventAppend\(\s*\{[\s\S]*?\}\s*\)/g) || [];
  assert.ok(calls.length > 0, 'eventAppend call not found in media route');
  for (const call of calls) {
    assert.ok(!/\btenant:\s*req\.tenant\b/.test(call),
      'eventAppend must not be called with `tenant: req.tenant` (audit P0-5)');
  }
});

test('W423 #3 — /v1/capture/media passes canonical tenant_id key', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/capture/media'");
  const calls = body.match(/eventAppend\(\s*\{[\s\S]*?\}\s*\)/g) || [];
  for (const call of calls) {
    assert.ok(/tenant_id:/.test(call),
      'eventAppend must include tenant_id key');
  }
});

test('W423 #4 — tenant_id source is req.tenant_record?.id || req.tenant', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/capture/media'");
  assert.ok(/tenant_id:\s*req\.tenant_record\?\.id\s*\|\|\s*req\.tenant/.test(body),
    'tenant_id must read from req.tenant_record?.id with req.tenant fallback');
});

test('W423 #5 — behavior: eventAppend({tenant_id}) round-trips tenant_id', async () => {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  if (typeof _resetForTests === 'function') {
    try { _resetForTests(); } catch (_) {} // deliberate: cleanup
  }
  const ev = await appendEvent({
    event_id: 'w423-media-test',
    tenant_id: 'tenantA',
    namespace: 'media-test',
    provider: 'media',
    model: 'media',
    media_kind: 'image',
    media_uri: 'inline://test',
    media_hash: 'aaaa',
    media_bytes: 1,
    media_mime: 'image/png',
    created_at: new Date().toISOString(),
    captured_at: new Date().toISOString(),
  });
  assert.equal(ev.tenant_id, 'tenantA', 'tenant_id must persist through canonicalize');
});
