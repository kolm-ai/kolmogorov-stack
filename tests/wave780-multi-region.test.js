// W780 -- Multi-Region Gateway.
//
// Atomic items pinned (matches the W780 implementation):
//
//   1)  Module exports + MULTI_REGION_VERSION regex
//   2)  CANONICAL_REGIONS freeze + carries us/eu/apac
//   3)  getCurrentRegion default
//   4)  getCurrentRegion override (canonical + short-name)
//   5)  getRegionGateways empty
//   6)  getRegionGateways populated
//   7)  routeRequest honors residency_requirement when set
//   8)  routeRequest honest envelope when residency cannot be satisfied
//   9)  routeRequest uses prefer_region when set
//   10) routeRequest falls back to current region
//   11) getRegionForCapture joins with W769 namespace default
//   12) getRegionForCapture honors W769 tenant inference
//   13) testFailover honest envelope when no gateways
//   14) testFailover happy path (stub URLs that return 200)
//   15) Route /v1/region/status -- auth 401 + 200 happy
//   16) Route /v1/region/gateways -- auth 401 + 200 happy
//   17) Route /v1/region/route -- auth 401 + 200 happy
//   18) CLI `kolm region --help` exits 0
//   19) CLI `kolm region status` returns stable envelope (local fallback)
//   20) W604 version regex match for MULTI_REGION_VERSION
//   21) vercel.json carries the /docs/multi-region rewrite
//   22) public/docs/multi-region.html exists w/ data-w780 anchors
//
// W604 anti-brittleness: family locks use regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as MultiRegion from '../src/multi-region.js';

const {
  MULTI_REGION_VERSION,
  CANONICAL_REGIONS,
  DEFAULT_REGION,
  getCurrentRegion,
  getRegionGateways,
  routeRequest,
  getRegionForCapture,
  testFailover,
} = MultiRegion;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'docs', 'multi-region.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const NODE_BIN = process.execPath;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w780-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  delete process.env.KOLM_REGION;
  delete process.env.KOLM_REGION_GATEWAY_URLS;
  delete process.env.KOLM_API_KEY;
  delete process.env.KOLM_KEY;
  return tmp;
}

// =============================================================================
// 1) Module exports + version regex
// =============================================================================
test('W780 #1 -- module exports + MULTI_REGION_VERSION matches /^w780-/', () => {
  freshDir();
  assert.equal(typeof MULTI_REGION_VERSION, 'string');
  assert.ok(/^w780-/.test(MULTI_REGION_VERSION),
    `MULTI_REGION_VERSION must match /^w780-/; got ${JSON.stringify(MULTI_REGION_VERSION)}`);
  assert.equal(typeof getCurrentRegion, 'function');
  assert.equal(typeof getRegionGateways, 'function');
  assert.equal(typeof routeRequest, 'function');
  assert.equal(typeof getRegionForCapture, 'function');
  assert.equal(typeof testFailover, 'function');
});

// =============================================================================
// 2) CANONICAL_REGIONS freeze + us/eu/apac entries
// =============================================================================
test('W780 #2 -- CANONICAL_REGIONS frozen + carries us/eu/apac entries', () => {
  freshDir();
  assert.ok(Object.isFrozen(CANONICAL_REGIONS),
    'CANONICAL_REGIONS MUST be Object.freeze()-d so downstream callers cannot mutate the contract');
  for (const sn of ['us', 'eu', 'apac']) {
    assert.ok(CANONICAL_REGIONS[sn], `CANONICAL_REGIONS.${sn} must exist`);
    assert.equal(CANONICAL_REGIONS[sn].short, sn);
    assert.ok(typeof CANONICAL_REGIONS[sn].canonical === 'string'
      && CANONICAL_REGIONS[sn].canonical.length > 0);
    assert.ok(typeof CANONICAL_REGIONS[sn].display_name === 'string'
      && CANONICAL_REGIONS[sn].display_name.length > 0);
    assert.ok(Object.isFrozen(CANONICAL_REGIONS[sn]));
  }
  assert.equal(DEFAULT_REGION, 'us-east-1',
    `DEFAULT_REGION must be us-east-1; got ${JSON.stringify(DEFAULT_REGION)}`);
});

// =============================================================================
// 3) getCurrentRegion default
// =============================================================================
test('W780 #3 -- getCurrentRegion returns DEFAULT_REGION when env unset', () => {
  freshDir();
  assert.equal(getCurrentRegion({ env: {} }), 'us-east-1');
  // Empty string also defaults.
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: '' } }), 'us-east-1');
  // Non-string also defaults.
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 12 } }), 'us-east-1');
});

// =============================================================================
// 4) getCurrentRegion override (canonical + short name)
// =============================================================================
test('W780 #4 -- getCurrentRegion honors canonical AND short-name overrides', () => {
  freshDir();
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'eu-west-1' } }), 'eu-west-1');
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'us-east-1' } }), 'us-east-1');
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'ap-southeast-1' } }), 'ap-southeast-1');
  // Short-name short-circuit.
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'eu' } }), 'eu-west-1');
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'us' } }), 'us-east-1');
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'apac' } }), 'ap-southeast-1');
  // Case-insensitive + trim.
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: ' EU ' } }), 'eu-west-1');
  // Bogus values fall back to default.
  assert.equal(getCurrentRegion({ env: { KOLM_REGION: 'MARS_NORTH' } }), 'us-east-1');
});

// =============================================================================
// 5) getRegionGateways empty
// =============================================================================
test('W780 #5 -- getRegionGateways returns {} when env unset or invalid JSON', () => {
  freshDir();
  assert.deepEqual(getRegionGateways({ env: {} }), {});
  assert.deepEqual(getRegionGateways({ env: { KOLM_REGION_GATEWAY_URLS: '' } }), {});
  // Invalid JSON -> honest empty (NOT a thrown error).
  assert.deepEqual(getRegionGateways({ env: { KOLM_REGION_GATEWAY_URLS: 'not-json' } }), {});
  // Array (not an object) -> empty.
  assert.deepEqual(getRegionGateways({ env: { KOLM_REGION_GATEWAY_URLS: '[1,2,3]' } }), {});
  // Object with non-string values -> values dropped.
  assert.deepEqual(
    getRegionGateways({ env: { KOLM_REGION_GATEWAY_URLS: '{"us": 123, "eu": "https://eu.kolm.ai"}' } }),
    { eu: 'https://eu.kolm.ai' });
});

// =============================================================================
// 6) getRegionGateways populated
// =============================================================================
test('W780 #6 -- getRegionGateways parses a full us/eu/apac JSON map', () => {
  freshDir();
  const json = JSON.stringify({
    us: 'https://us.kolm.ai',
    eu: 'https://eu.kolm.ai',
    apac: 'https://ap.kolm.ai',
  });
  const got = getRegionGateways({ env: { KOLM_REGION_GATEWAY_URLS: json } });
  assert.equal(got.us, 'https://us.kolm.ai');
  assert.equal(got.eu, 'https://eu.kolm.ai');
  assert.equal(got.apac, 'https://ap.kolm.ai');
  // Keys are lowercased for normalisation.
  const upper = getRegionGateways({
    env: { KOLM_REGION_GATEWAY_URLS: '{"US": "https://us.kolm.ai"}' },
  });
  assert.equal(upper.us, 'https://us.kolm.ai');
});

// =============================================================================
// 7) routeRequest honors residency_requirement when set
// =============================================================================
test('W780 #7 -- routeRequest honors residency_requirement when set (HARD constraint)', () => {
  freshDir();
  const env = {
    KOLM_REGION: 'us-east-1',
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://us.kolm.ai',
      eu: 'https://eu.kolm.ai',
      apac: 'https://ap.kolm.ai',
    }),
  };
  const r = routeRequest({
    request_hash: 'h_w780_7',
    residency_requirement: 'eu',
    opts: { env },
  });
  assert.equal(r.ok, true);
  assert.equal(r.region, 'eu');
  assert.equal(r.gateway_url, 'https://eu.kolm.ai');
  assert.equal(r.reason, 'residency_requirement');
  // Long-form residency also resolves.
  const r2 = routeRequest({
    request_hash: 'h_w780_7b',
    residency_requirement: 'eu-west-1',
    opts: { env },
  });
  assert.equal(r2.region, 'eu');
  assert.equal(r2.gateway_url, 'https://eu.kolm.ai');
});

// =============================================================================
// 8) routeRequest honest envelope when residency cannot be satisfied
// =============================================================================
test('W780 #8 -- routeRequest returns honest envelope when residency cannot be satisfied', () => {
  freshDir();
  const env = {
    KOLM_REGION: 'us-east-1',
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://us.kolm.ai',
    }),
  };
  const r = routeRequest({
    request_hash: 'h_w780_8',
    residency_requirement: 'eu',
    opts: { env },
  });
  assert.equal(r.ok, false,
    `residency_requirement that cannot be satisfied MUST return ok:false; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'no_gateway_for_residency_requirement');
  assert.equal(r.requirement, 'eu');
  assert.ok(Array.isArray(r.available_regions));
  assert.ok(r.available_regions.includes('us'));
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'unsatisfiable residency envelope must carry a hint');
  assert.equal(r.version, MULTI_REGION_VERSION);
});

// =============================================================================
// 9) routeRequest uses prefer_region when set
// =============================================================================
test('W780 #9 -- routeRequest uses prefer_region when set (SOFT hint, falls through on miss)', () => {
  freshDir();
  const env = {
    KOLM_REGION: 'us-east-1',
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://us.kolm.ai',
      eu: 'https://eu.kolm.ai',
      apac: 'https://ap.kolm.ai',
    }),
  };
  const r = routeRequest({
    request_hash: 'h_w780_9',
    prefer_region: 'apac',
    opts: { env },
  });
  assert.equal(r.ok, true);
  assert.equal(r.region, 'apac');
  assert.equal(r.reason, 'prefer_region');
  // Miss on prefer falls through to current region (us).
  const miss = routeRequest({
    request_hash: 'h_w780_9b',
    prefer_region: 'unknown',
    opts: { env },
  });
  assert.equal(miss.ok, true);
  assert.equal(miss.region, 'us');
  assert.equal(miss.reason, 'current_region');
});

// =============================================================================
// 10) routeRequest falls back to current region
// =============================================================================
test('W780 #10 -- routeRequest falls back to current region when no residency/prefer', () => {
  freshDir();
  const env = {
    KOLM_REGION: 'eu-west-1',
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://us.kolm.ai',
      eu: 'https://eu.kolm.ai',
    }),
  };
  const r = routeRequest({
    request_hash: 'h_w780_10',
    opts: { env },
  });
  assert.equal(r.ok, true);
  assert.equal(r.region, 'eu');
  assert.equal(r.gateway_url, 'https://eu.kolm.ai');
  assert.equal(r.reason, 'current_region');
  // Empty gateway map returns region_not_configured.
  const empty = routeRequest({
    request_hash: 'h_w780_10b',
    opts: { env: { KOLM_REGION: 'eu-west-1' } },
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'region_not_configured');
  assert.equal(empty.version, MULTI_REGION_VERSION);
  assert.ok(typeof empty.hint === 'string' && empty.hint.length > 0);
});

// =============================================================================
// 11) getRegionForCapture joins with W769 namespace default
// =============================================================================
test('W780 #11 -- getRegionForCapture joins with W769 namespace default', async () => {
  freshDir();
  const fakeDr = {
    DEFAULT_REGION: 'GLOBAL',
    getNamespaceDefaultRegion: async () => 'EU_WEST',
    inferRegionFromTenant: () => 'GLOBAL',
  };
  const r = await getRegionForCapture({
    tenant: { id: 'tenant_w780_11' },
    namespace: 'support.eu',
    opts: { dataResidency: fakeDr },
  });
  assert.equal(r.ok, true);
  assert.equal(r.region, 'eu');
  assert.equal(r.w769_region, 'EU_WEST');
  assert.equal(r.reason, 'w769_namespace_default');
});

// =============================================================================
// 12) getRegionForCapture honors W769 tenant inference (fallback)
// =============================================================================
test('W780 #12 -- getRegionForCapture falls through to W769 tenant inference', async () => {
  freshDir();
  const fakeDr = {
    DEFAULT_REGION: 'GLOBAL',
    getNamespaceDefaultRegion: async () => 'GLOBAL',
    inferRegionFromTenant: () => 'JAPAN',
  };
  const r = await getRegionForCapture({
    tenant: { id: 'tenant_w780_12', country_code: 'JP' },
    namespace: 'support.jp',
    opts: { dataResidency: fakeDr },
  });
  assert.equal(r.ok, true);
  assert.equal(r.region, 'apac',
    `JAPAN must map to apac via the short-name resolver; got ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'w769_tenant_inference');
  // missing tenant -> honest error
  const e = await getRegionForCapture({ namespace: 'support.eu' });
  assert.equal(e.ok, false);
  assert.equal(e.error, 'tenant_required');
});

// =============================================================================
// 13) testFailover honest envelope when no gateways
// =============================================================================
test('W780 #13 -- testFailover honest envelope when no gateways configured', async () => {
  freshDir();
  const env = {};
  const r = await testFailover({ opts: { env } });
  assert.equal(r.ok, false,
    `empty gateway map MUST yield ok:false; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'region_not_configured');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
  assert.equal(r.version, MULTI_REGION_VERSION);
});

// =============================================================================
// 14) testFailover happy path (stub URLs that return 200)
// =============================================================================
test('W780 #14 -- testFailover happy path with injected fetch stub returning 200', async () => {
  freshDir();
  const env = {
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://us.example',
      eu: 'https://eu.example',
    }),
  };
  // Inject a fake fetch that returns 200 for every probe.
  const fakeFetch = async (url, opts) => {
    void opts;
    void url;
    return { status: 200 };
  };
  const r = await testFailover({
    opts: { env, fetch: fakeFetch, timeout_ms: 1000 },
  });
  assert.equal(r.ok, true,
    `with two reachable gateways, ok must be true; got ${JSON.stringify(r)}`);
  assert.equal(r.region_count, 2);
  assert.equal(r.reachable_count, 2);
  assert.ok(Array.isArray(r.gateways));
  for (const g of r.gateways) {
    assert.equal(g.reachable, true);
    assert.equal(g.status, 200);
    assert.ok(typeof g.latency_ms === 'number' && g.latency_ms >= 0);
  }
  // Inject a fetch that throws -- every gateway becomes unreachable.
  const badFetch = async () => { throw new Error('connection_refused'); };
  const bad = await testFailover({
    opts: { env, fetch: badFetch, timeout_ms: 500 },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reachable_count, 0);
});

// =============================================================================
// 15) Route /v1/region/status -- auth 401 + 200 happy
// =============================================================================
test('W780 #15 -- GET /v1/region/status: 401 w/o auth, 200 happy', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_REGION = 'us-east-1';
  process.env.KOLM_REGION_GATEWAY_URLS = JSON.stringify({
    us: 'https://us.kolm.ai',
    eu: 'https://eu.kolm.ai',
  });

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/region/status`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/region/status`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.region, 'us-east-1');
    assert.equal(env.gateway_url, 'https://us.kolm.ai');
    assert.equal(env.version, MULTI_REGION_VERSION);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
    delete process.env.KOLM_REGION;
    delete process.env.KOLM_REGION_GATEWAY_URLS;
  }
});

// =============================================================================
// 16) Route /v1/region/gateways -- auth 401 + 200 happy
// =============================================================================
test('W780 #16 -- GET /v1/region/gateways: 401 w/o auth, 200 happy', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_REGION_GATEWAY_URLS = JSON.stringify({
    us: 'https://us.kolm.ai',
    eu: 'https://eu.kolm.ai',
  });

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/region/gateways`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/region/gateways`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.region_count, 2);
    assert.equal(env.gateways.us, 'https://us.kolm.ai');
    assert.equal(env.gateways.eu, 'https://eu.kolm.ai');
    assert.equal(env.version, MULTI_REGION_VERSION);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
    delete process.env.KOLM_REGION_GATEWAY_URLS;
  }
});

// =============================================================================
// 17) Route /v1/region/route -- auth 401 + 200 happy
// =============================================================================
test('W780 #17 -- POST /v1/region/route: 401 w/o auth, 200 happy', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_REGION = 'us-east-1';
  process.env.KOLM_REGION_GATEWAY_URLS = JSON.stringify({
    us: 'https://us.kolm.ai',
    eu: 'https://eu.kolm.ai',
  });

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/region/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_hash: 'h_w780_17', residency_requirement: 'eu' }),
    });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/region/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ request_hash: 'h_w780_17', residency_requirement: 'eu' }),
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.region, 'eu');
    assert.equal(env.gateway_url, 'https://eu.kolm.ai');
    assert.equal(env.reason, 'residency_requirement');
    assert.equal(env.version, MULTI_REGION_VERSION);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
    delete process.env.KOLM_REGION;
    delete process.env.KOLM_REGION_GATEWAY_URLS;
  }
});

// =============================================================================
// 18) CLI `kolm region --help` exits 0
// =============================================================================
test('W780 #18 -- CLI `kolm region --help` exits 0 (or BAD_ARGS=1) and prints usage', () => {
  freshDir();
  // The CLI's standard pattern for help is to print to stderr and exit
  // EXIT.BAD_ARGS (1) when no subcommand. We accept exit 0 OR exit 1
  // because both are "non-failure for help" in node CLI convention.
  const result = spawnSync(NODE_BIN, [CLI_PATH, 'region', '--help'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, KOLM_API_KEY: '', KOLM_KEY: '' },
  });
  // Exit code is 0 OR 1 -- both denote "help printed, not a real error".
  assert.ok(result.status === 0 || result.status === 1,
    `kolm region --help must exit 0 or 1; got ${result.status} stderr=${result.stderr}`);
  const combined = (result.stdout || '') + (result.stderr || '');
  assert.ok(/region/i.test(combined),
    `help output must mention region; got ${combined.slice(0, 400)}`);
  assert.ok(/status|gateways|route|test-failover/.test(combined),
    `help must list at least one subcommand; got ${combined.slice(0, 400)}`);
});

// =============================================================================
// 19) CLI `kolm region status` returns stable envelope (local fallback)
// =============================================================================
test('W780 #19 -- CLI `kolm region status` returns stable envelope (local fallback, no auth)', () => {
  freshDir();
  const env = {
    ...process.env,
    KOLM_API_KEY: '',
    KOLM_KEY: '',
    KOLM_REGION: 'us-east-1',
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://us.kolm.ai',
      eu: 'https://eu.kolm.ai',
    }),
  };
  const result = spawnSync(NODE_BIN, [CLI_PATH, 'region', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
  assert.equal(result.status, 0,
    `kolm region status must exit 0 with valid env; got ${result.status} stderr=${result.stderr}`);
  // Parse the last JSON object the CLI prints.
  const stdout = (result.stdout || '').trim();
  assert.ok(stdout.length > 0,
    `kolm region status must print to stdout; got empty (stderr=${result.stderr})`);
  let env_parsed;
  try {
    env_parsed = JSON.parse(stdout);
  } catch (_e) {
    assert.fail('kolm region status stdout must be valid JSON; got ' + stdout.slice(0, 400));
  }
  assert.equal(env_parsed.ok, true);
  assert.equal(env_parsed.region, 'us-east-1');
  assert.equal(env_parsed.gateway_url, 'https://us.kolm.ai');
  assert.equal(env_parsed.source, 'local',
    `local-fallback path must stamp source=local; got ${JSON.stringify(env_parsed)}`);
  assert.ok(/^w780-/.test(env_parsed.version));
});

// =============================================================================
// 20) W604 version regex match
// =============================================================================
test('W780 #20 -- MULTI_REGION_VERSION matches the W604 family regex', () => {
  freshDir();
  // The W604 anti-brittleness rule: callers MUST match version with a
  // regex (never an exact-equality check tied to a hard-coded literal).
  // This test asserts the version is in the family that the regex captures.
  const re = /^w780-/;
  assert.ok(re.test(MULTI_REGION_VERSION),
    `MULTI_REGION_VERSION must satisfy /^w780-/; got ${JSON.stringify(MULTI_REGION_VERSION)}`);
});

// =============================================================================
// 21) vercel.json /docs/multi-region rewrite
// =============================================================================
test('W780 #21 -- vercel.json carries the /docs/multi-region rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/multi-region' &&
    r.destination === '/docs/multi-region.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/multi-region', destination: '/docs/multi-region.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 22) public/docs/multi-region.html anchors + version stamp
// =============================================================================
test('W780 #22 -- public/docs/multi-region.html exists with data-w780 anchors + version stamp', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Required hidden test anchors (W604 anti-brittleness).
  assert.ok(html.includes('data-w780="launch-plan"'));
  assert.ok(html.includes('data-w780="dns-layout"'));
  assert.ok(html.includes('data-w780="cloudflare-worker"'));
  assert.ok(html.includes('data-w780="lambda-at-edge"'));
  assert.ok(html.includes('data-w780="region-aware-capture"'));
  // Cross-link to W769 data residency page.
  assert.ok(html.includes('/compliance/data-residency'),
    'multi-region.html must cross-link to /compliance/data-residency (W769)');
  // Version stamp.
  assert.ok(/w780-/.test(html),
    'multi-region.html must stamp a w780-* version somewhere on the page');
});
