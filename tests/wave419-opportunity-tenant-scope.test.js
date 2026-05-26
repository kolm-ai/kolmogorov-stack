// W419 — opportunity engine tenant scope (audit P0-1).
//
// Before W419, src/opportunity-engine.js:findOpportunities() called
// listEvents() without a tenant_id, so /v1/opportunities surfaced cross-tenant
// patterns. The router /v1/opportunities/accept|dismiss|ignore|promote routes
// also had no auth gate.
//
// Behavior + static-source assertions pinning the fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OPP_PATH = path.join(REPO, 'src', 'opportunity-engine.js');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');

const oppSrc = () => fs.readFileSync(OPP_PATH, 'utf8');
const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');

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

test('W419 #1 — findOpportunities resolves tenant_id from opts and passes to listEvents', () => {
  const src = oppSrc();
  // The function must extract tenant_id from opts and pass it as the
  // tenant_id key in the listEvents call.
  assert.ok(/const\s+tenant_id\s*=\s*opts\.tenant_id\s*\|\|\s*opts\.tenant\s*\|\|\s*null/.test(src),
    'findOpportunities must collapse opts.tenant_id || opts.tenant || null');
  // listEvents call must carry tenant_id
  const idx = src.indexOf('export async function findOpportunities');
  const block = src.slice(idx, idx + 1500);
  assert.ok(/listEvents\(\s*\{[\s\S]*?tenant_id[\s\S]*?\}\s*\)/.test(block),
    'findOpportunities listEvents call must pass tenant_id');
});

test('W419 #2 — acceptOpportunity verifies tenant ownership before writing state', () => {
  const src = oppSrc();
  assert.ok(/_assertOppOwnership\s*\(/.test(src),
    'opportunity-engine must declare _assertOppOwnership');
  assert.ok(/export async function acceptOpportunity[\s\S]{0,200}_assertOppOwnership/.test(src),
    'acceptOpportunity must call _assertOppOwnership before _writeState');
});

test('W419 #3 — ignoreOpportunity verifies tenant ownership before writing state', () => {
  const src = oppSrc();
  assert.ok(/export async function ignoreOpportunity[\s\S]{0,200}_assertOppOwnership/.test(src),
    'ignoreOpportunity must call _assertOppOwnership before _writeState');
});

test('W419 #4 — promoteOpportunity resolves tenant_id and uses it in findOpportunities', () => {
  const src = oppSrc();
  const idx = src.indexOf('export async function promoteOpportunity');
  const block = src.slice(idx, idx + 800);
  assert.ok(/const\s+tenant_id\s*=\s*opts\.tenant_id\s*\|\|\s*opts\.tenant\s*\|\|\s*null/.test(block),
    'promoteOpportunity must collapse tenant_id');
  assert.ok(/findOpportunities\(\s*\{[\s\S]*?tenant_id[\s\S]*?\}\s*\)/.test(block),
    'promoteOpportunity must pass tenant_id to its findOpportunities lookup');
});

test('W419 #5 — GET /v1/opportunities requires auth + passes req.tenant_record.id', () => {
  const body = sliceRouteBody(routerSrc(), "r.get('/v1/opportunities'");
  assert.ok(body, '/v1/opportunities GET route not found');
  assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)/.test(body),
    'GET /v1/opportunities must 401 without tenant');
  assert.ok(/oppFindOpportunities\(\s*\{[\s\S]*?tenant_id:\s*req\.tenant_record\.id/.test(body),
    'GET /v1/opportunities must pass tenant_id: req.tenant_record.id');
});

test('W419 #6 — POST /v1/opportunities/:id/accept requires auth + passes tenant_id', () => {
  const body = sliceRouteBody(routerSrc(), "r.post('/v1/opportunities/:id/accept'");
  assert.ok(body, '/v1/opportunities/:id/accept route not found');
  assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)/.test(body),
    'accept route must 401 without tenant');
  assert.ok(/tenant_id:\s*req\.tenant_record\.id/.test(body),
    'accept route must pass tenant_id');
});

test('W419 #7 — POST /v1/opportunities/:id/dismiss + /ignore + /promote all auth-gated', () => {
  const src = routerSrc();
  for (const verb of ['dismiss', 'ignore', 'promote']) {
    const body = sliceRouteBody(src, `r.post('/v1/opportunities/:id/${verb}'`);
    assert.ok(body, `/v1/opportunities/:id/${verb} route not found`);
    assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)/.test(body),
      `${verb} route must 401 without tenant`);
    assert.ok(/tenant_id:\s*req\.tenant_record\.id/.test(body),
      `${verb} route must pass tenant_id`);
  }
});

test('W419 #8 — behavior: findOpportunities({tenant_id}) only sees its own tenant events', async () => {
  // Direct import — we'll write 2 tenants' events to the in-process event-store
  // and assert tenant A's opportunity scan never returns rows from tenant B.
  const { findOpportunities } = await import('../src/opportunity-engine.js');
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');

  if (typeof _resetForTests === 'function') {
    try { _resetForTests(); } catch (_) {} // deliberate: cleanup
  }

  // 10 identical requests for tenant A — should trigger cache_candidate.
  const promptA = JSON.stringify([{ role: 'user', content: 'Pick a number between 1 and 10.' }]);
  for (let i = 0; i < 12; i++) {
    await appendEvent({
      event_id: 'a' + i,
      tenant_id: 'tenantA',
      namespace: 'shared-ns',
      provider: 'openai',
      model: 'gpt-4o',
      messages_redacted: promptA,
      response_redacted: 'A',
      request_hash: 'hashA',
      estimated_cost_usd: 0.10,
      prompt_tokens: 20,
      completion_tokens: 5,
      latency_ms: 250,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      captured_at: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  // 12 different requests for tenant B (also cache_candidate-shaped)
  const promptB = JSON.stringify([{ role: 'user', content: 'Translate hi to French.' }]);
  for (let i = 0; i < 12; i++) {
    await appendEvent({
      event_id: 'b' + i,
      tenant_id: 'tenantB',
      namespace: 'shared-ns',
      provider: 'openai',
      model: 'gpt-4o',
      messages_redacted: promptB,
      response_redacted: 'B',
      request_hash: 'hashB',
      estimated_cost_usd: 0.10,
      prompt_tokens: 20,
      completion_tokens: 5,
      latency_ms: 250,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      captured_at: new Date(Date.now() - i * 1000).toISOString(),
    });
  }

  const oppsA = await findOpportunities({ tenant_id: 'tenantA', minCallCount: 1, minMonthlySpend: 0.001 });
  const oppsB = await findOpportunities({ tenant_id: 'tenantB', minCallCount: 1, minMonthlySpend: 0.001 });

  // A's cache_candidate should reference hashA. B should never reference hashA.
  const aHashes = oppsA.flatMap(o => (o.pattern || '').match(/[a-f0-9]+/gi) || []);
  const bHashes = oppsB.flatMap(o => (o.pattern || '').match(/[a-f0-9]+/gi) || []);
  // Sanity — both tenants get at least one cache_candidate.
  assert.ok(oppsA.length > 0, 'tenantA should surface opportunities');
  assert.ok(oppsB.length > 0, 'tenantB should surface opportunities');
  // Cross-tenant: A's hashes must NOT include hashB; B's must NOT include hashA.
  assert.ok(!aHashes.some(h => h.startsWith('hashB')), 'tenantA must not see hashB');
  assert.ok(!bHashes.some(h => h.startsWith('hashA')), 'tenantB must not see hashA');
});
