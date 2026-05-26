// Wave 525 - canonical label queue routes are documented and tenant-fenced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

const LABEL_ROUTES = [
  ['GET', '/v1/labels/next', /Labels next - returns tenant-scoped unlabeled events/],
  ['POST', '/v1/labels', /Label submit - records a reviewer verdict/],
  ['GET', '/v1/labels/stats', /Labels stats - returns tenant-scoped pending, approved, rejected, and edited counts/],
  ['GET', '/v1/labels/:event_id', /Label detail - fetches one persisted decision and hides cross-tenant event ids/],
];

const STALE_LABEL_COPY = /undocumented route - wired in source|No inline description in route source|docs pending|W384:\s*label queue/i;

test('W525 #1 - canonical label routes are documented in api-routes', () => {
  for (const [method, routePath, summary] of LABEL_ROUTES) {
    const hit = route(method, routePath);
    assert.ok(hit, `${method} ${routePath} missing from api-routes.json`);
    assert.equal(hit.stub, false, `${method} ${routePath} must not remain docs-pending`);
    assert.match(hit.short || '', summary);
  }
});

test('W525 #2 - canonical label routes are not flagged as undocumented in OpenAPI', () => {
  for (const [method, routePath] of LABEL_ROUTES) {
    const op = operation(method, routePath);
    assert.ok(op, `${method} ${routePath} missing from OpenAPI`);
    assert.equal(op['x-kolm-stub'], undefined, `${method} ${routePath} must not use old stub flag`);
    assert.equal(op['x-kolm-undocumented'], undefined, `${method} ${routePath} must not be undocumented`);
    assert.doesNotMatch(op.summary || '', /undocumented route - wired in source/);
  }
});

test('W525 #3 - generated OpenAPI label summaries follow source comments', () => {
  for (const [method, routePath] of LABEL_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    assert.ok(hit && op, `${method} ${routePath} missing from generated contracts`);
    assert.equal(op.summary, hit.short, `${method} ${routePath} summary must follow the source route comment`);
  }
});

test('W525 #4 - generated label contracts do not expose docs-pending placeholders', () => {
  for (const [method, routePath] of LABEL_ROUTES) {
    const hit = route(method, routePath);
    const op = operation(method, routePath);
    const inventoryText = [hit.short, ...(hit.comments || [])].join(' ');
    const openapiText = [op.summary, op.description].filter(Boolean).join(' ');
    assert.doesNotMatch(inventoryText, STALE_LABEL_COPY, `${method} ${routePath} inventory must not expose stale notes`);
    assert.doesNotMatch(openapiText, STALE_LABEL_COPY, `${method} ${routePath} OpenAPI must not expose stale notes`);
    assert.doesNotMatch(routeHtmlSection(method, routePath), STALE_LABEL_COPY, `${method} ${routePath} HTML must not expose stale notes`);
  }
});

test('W525 #5 - label route source preserves tenant scope and detail lookup fence', () => {
  const router = read('src/router.js');
  const start = router.indexOf("r.get('/v1/labels/next'");
  const end = router.indexOf('// ============== W409o: label-queue aliases', start);
  assert.ok(start > 0 && end > start, 'label route block must be located');
  const block = router.slice(start, end);

  assert.match(block, /lblNextToLabel\(\{[\s\S]{0,240}tenant_id:\s*_tenantScope\(req\)/);
  assert.match(block, /lblSubmitLabel\(body\.event_id,\s*\{[\s\S]{0,360}tenant_id:\s*_tenantScope\(req\)/);
  assert.match(block, /lblStats\(\{\s*tenant_id:\s*_tenantScope\(req\)\s*\}\)/);
  assert.match(block, /const scope = _tenantScope\(req\)/);
  assert.match(block, /await eventGet\(req\.params\.event_id\)/);
  assert.match(block, /ev\.tenant_id !== scope[\s\S]{0,120}label_not_found/);
  assert.ok(
    block.indexOf('await eventGet(req.params.event_id)') < block.indexOf('lblGetLabel(req.params.event_id)'),
    'label detail must prove event ownership before reading the persisted label',
  );

  const labelQueue = read('src/label-queue.js');
  assert.match(labelQueue, /tenant_id:\s*callerTenant \|\| ev\.tenant_id \|\| null/);
});

const ENV_KEYS = ['KOLM_DATA_DIR', 'HOME', 'USERPROFILE', 'KOLM_EVENT_STORE_PATH', 'ADMIN_KEY'];

function snapEnv() {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] == null) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function freshDataDir() {
  const dir = path.join(os.tmpdir(), `kolm-w525-labels-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function resetEventStore() {
  try {
    const events = await import('../src/event-store.js');
    if (typeof events._resetForTests === 'function') events._resetForTests();
  } catch {} // deliberate: cleanup
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

test('W525 #6 - label detail HTTP route hides cross-tenant event ids', async (t) => {
  const saved = snapEnv();
  const dir = freshDataDir();
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_EVENT_STORE_PATH = path.join(dir, 'events.sqlite');
  delete process.env.ADMIN_KEY;
  t.after(async () => {
    restoreEnv(saved);
    await resetEventStore();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  });

  await resetEventStore();
  const express = (await import('express')).default;
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const { appendEvent } = await import('../src/event-store.js');
  const { submitLabel } = await import('../src/label-queue.js');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(buildRouter());
  const tenantA = provisionAnonTenant({ ttl_days: 1, quota: 100000 });
  const tenantB = provisionAnonTenant({ ttl_days: 1, quota: 100000 });

  const ev = await appendEvent({
    namespace: 'w525-label-detail',
    tenant_id: tenantA.id,
    prompt_redacted: 'tenant A prompt',
    response_redacted: 'tenant A response',
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 'ok',
    estimated_cost_usd: 0.001,
    latency_ms: 25,
  });
  const submitted = await submitLabel(ev.event_id, {
    verdict: 'good',
    reviewer: 'w525-owner',
    tenant_id: tenantA.id,
  });
  assert.equal(submitted.label.tenant_id, tenantA.id);

  await withServer(app, async (base) => {
    const owner = await fetch(base + `/v1/labels/${ev.event_id}`, {
      headers: { authorization: 'Bearer ' + tenantA.api_key },
    });
    assert.equal(owner.status, 200, 'owning tenant can read its label');
    const ownerBody = await owner.json();
    assert.equal(ownerBody.label.event_id, ev.event_id);
    assert.equal(ownerBody.label.tenant_id, tenantA.id);

    const cross = await fetch(base + `/v1/labels/${ev.event_id}`, {
      headers: { authorization: 'Bearer ' + tenantB.api_key },
    });
    assert.equal(cross.status, 404, 'cross-tenant label detail must hide the event id');
    const crossBody = await cross.json();
    assert.equal(crossBody.error, 'label_not_found');
  });
});

test('W525 #7 - OpenAPI generator refreshes documented label routes that used to be docs-pending', () => {
  const openapiGenerator = read('scripts/build-openapi.cjs');

  assert.match(openapiGenerator, /operationHasStaleUndocumentedFlag/);
  assert.match(openapiGenerator, /x-kolm-source-indexed/);
});
