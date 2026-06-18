// W715 - direct route contract for src/savings-routes.js.
//
// W835 already covers the savings accounting core. This file pins the HTTP
// boundary: route wiring, auth-required envelopes, tenant-derived IDs,
// bounded input validation, and compact error shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as eventStore from '../src/event-store.js';
import {
  SAVINGS_ROUTES_CONTRACT_VERSION,
  SAVINGS_ROUTE_LIMITS,
  registerSavingsRoutes,
} from '../src/savings-routes.js';

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w715-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  if (eventStore._resetForTests) eventStore._resetForTests();
  return tmp;
}

function makeRouter() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
}

async function invoke(routes, key, { tenant_id = 'tenant_w715', query = {}, body = {} } = {}) {
  const handler = routes.get(key);
  assert.equal(typeof handler, 'function', `${key} handler must be registered`);
  const req = {
    query,
    body,
    tenant_record: tenant_id ? { id: tenant_id } : null,
  };
  const res = makeRes();
  await handler(req, res);
  return res;
}

test('W715 savings routes are directly wired into depth verification', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../src/savings-routes.js', import.meta.url), 'utf8');
  const router = makeRouter();

  assert.equal(SAVINGS_ROUTES_CONTRACT_VERSION, 'w715-v1');
  assert.ok(SAVINGS_ROUTE_LIMITS.max_namespace_chars <= 128);
  assert.ok(SAVINGS_ROUTE_LIMITS.max_tokens_per_call <= 50_000_000);
  assert.equal(
    pkg.scripts['verify:savings-routes'],
    'node --test --test-concurrency=1 tests/wave835-savings.test.js tests/wave715-savings-routes-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:licensing-allowlist && npm run verify:savings-routes && npm run verify:scim-provisioning && npm run verify:trend-extract && npm run verify:verticals && npm run verify:video-bakeoff && npm run verify:video-capture && npm run verify:vision-capture && npm run verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /registerSavingsRoutes: router with \.get\/\.post required/);
  assert.throws(() => registerSavingsRoutes({ get() {} }), /router with \.get\/\.post/);

  registerSavingsRoutes(router);
  assert.deepEqual(Array.from(router.routes.keys()).sort(), [
    'GET /v1/savings/baseline',
    'GET /v1/savings/summary',
    'POST /v1/savings/baseline',
    'POST /v1/savings/record',
  ]);
});

test('W715 routes require tenant auth and reject unsafe namespace text', async () => {
  freshDir();
  const router = makeRouter();
  registerSavingsRoutes(router);

  const noAuth = await invoke(router.routes, 'GET /v1/savings/baseline', { tenant_id: null });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.jsonBody.error, 'auth_required');
  assert.equal(noAuth.jsonBody.route_contract_version, SAVINGS_ROUTES_CONTRACT_VERSION);

  const badNs = await invoke(router.routes, 'GET /v1/savings/baseline', {
    query: { namespace: '../private/alice@example.com' },
  });
  const badNsJson = JSON.stringify(badNs.jsonBody);
  assert.equal(badNs.statusCode, 400);
  assert.equal(badNs.jsonBody.error, 'invalid_namespace');
  assert.doesNotMatch(badNsJson, /alice@example\.com/);
  assert.doesNotMatch(badNsJson, /\.\.\/private/);
});

test('W715 record route rejects hostile provider, model, tokens, and timestamps before persistence', async () => {
  freshDir();
  const router = makeRouter();
  registerSavingsRoutes(router);

  let res = await invoke(router.routes, 'POST /v1/savings/record', {
    body: { provider: 'openai/../../alice@example.com', model: 'gpt-4o-mini', input_tokens: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.error, 'invalid_provider');
  assert.doesNotMatch(JSON.stringify(res.jsonBody), /alice@example\.com/);

  res = await invoke(router.routes, 'POST /v1/savings/record', {
    body: { provider: 'openai', model: 'bad model name', input_tokens: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.error, 'invalid_model');

  res = await invoke(router.routes, 'POST /v1/savings/record', {
    body: { provider: 'openai', model: 'gpt-4o-mini', input_tokens: -1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.error, 'invalid_token_count');

  res = await invoke(router.routes, 'POST /v1/savings/record', {
    body: { provider: 'openai', model: 'gpt-4o-mini', input_tokens: 1, ts: 'not-a-date' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.error, 'invalid_ts');

  const rows = await eventStore.listEvents({ tenant_id: 'tenant_w715', namespace: 'default', limit: 0 });
  assert.equal(rows.length, 0);
});

test('W715 baseline and record routes use tenant_record.id instead of caller body tenant_id', async () => {
  freshDir();
  const router = makeRouter();
  registerSavingsRoutes(router);

  const start = await invoke(router.routes, 'POST /v1/savings/baseline', {
    tenant_id: 'tenant_good_w715',
    body: {
      tenant_id: 'tenant_bad_w715',
      namespace: 'prod',
      start_ts: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(start.jsonBody.tenant_id, 'tenant_good_w715');
  assert.equal(start.jsonBody.namespace, 'prod');

  const recorded = await invoke(router.routes, 'POST /v1/savings/record', {
    tenant_id: 'tenant_good_w715',
    body: {
      tenant_id: 'tenant_bad_w715',
      namespace: 'prod',
      provider: 'openai',
      model: 'gpt-4o-mini',
      input_tokens: 1_000_000,
      output_tokens: 0,
      ts: '2026-01-02T00:00:00.000Z',
    },
  });
  assert.equal(recorded.statusCode, 200);
  assert.equal(recorded.jsonBody.recorded.cost_micro_usd, 150_000);
  assert.equal(recorded.jsonBody.recorded.input_tokens, 1_000_000);

  const goodRows = await eventStore.listEvents({ tenant_id: 'tenant_good_w715', namespace: 'prod', limit: 0 });
  const badRows = await eventStore.listEvents({ tenant_id: 'tenant_bad_w715', namespace: 'prod', limit: 0 });
  assert.equal(goodRows.length, 2);
  assert.equal(badRows.length, 0);
});

test('W715 summary route keeps honest 400s for invalid period and fee rate', async () => {
  freshDir();
  const router = makeRouter();
  registerSavingsRoutes(router);

  const badPeriod = await invoke(router.routes, 'GET /v1/savings/summary', {
    query: { period_days: '999999' },
  });
  assert.equal(badPeriod.statusCode, 400);
  assert.equal(badPeriod.jsonBody.error, 'invalid_period_days');

  const badFee = await invoke(router.routes, 'GET /v1/savings/summary', {
    query: { fee_rate: '1.5' },
  });
  assert.equal(badFee.statusCode, 400);
  assert.equal(badFee.jsonBody.error, 'invalid_fee_rate');
});
