// W742 - direct contract test for src/website-status-routes.js.
//
// This pins the public website status atom: pre-auth router wiring with real
// store/signer probes, deterministic component status, bounded receipt scans,
// receipt-id sanitization, privacy-safe aggregates, and cache semantics.

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBSITE_STATUS_COMPONENT_IDS,
  WEBSITE_STATUS_CONTRACT_VERSION,
  WEBSITE_STATUS_LIMITS,
  WEBSITE_STATUS_VERSION,
  _resetReceiptCacheForTests,
  probeComponents,
  publicReceiptStats,
  registerWebsiteStatusRoutes,
  statusSummary,
} from '../src/website-status-routes.js';

const NOW_MS = Date.parse('2026-06-18T00:00:00.000Z');

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function storeWith(rows, extra = {}) {
  return {
    all(table) {
      assert.equal(table, 'observations');
      return rows;
    },
    backendInfo() {
      return { driver: 'fixture' };
    },
    ...extra,
  };
}

test('W742 website status is wired into direct depth verification and mounted public-safe', () => {
  const pkg = readJson('package.json');
  const source = read('src/website-status-routes.js');
  const routerSource = read('src/router.js');
  const storeDef = routerSource.indexOf('const __w609ReceiptStore = { all, find, findByTenant, insert, update, backendInfo: storeBackendInfo };');
  const statusMount = routerSource.indexOf('__registerWebsiteStatusRoutes_w921(r, { store: __w609ReceiptStore, loadSigner: __w609GetReceiptSigner });');
  const authGate = routerSource.indexOf('\n  r.use(authMiddleware);');

  assert.equal(WEBSITE_STATUS_VERSION, 'w921-v1');
  assert.equal(WEBSITE_STATUS_CONTRACT_VERSION, 'w742-website-status-v1');
  assert.deepEqual(WEBSITE_STATUS_COMPONENT_IDS, ['gateway', 'signing', 'storage']);
  assert.equal(Object.isFrozen(WEBSITE_STATUS_COMPONENT_IDS), true);
  assert.equal(WEBSITE_STATUS_LIMITS.max_receipt_scan_rows, 1000);
  assert.equal(WEBSITE_STATUS_LIMITS.max_receipt_cache_ttl_ms, 300000);
  assert.equal(
    pkg.scripts['verify:website-status'],
    'node --test --test-concurrency=1 tests/wave742-website-status-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && npm run verify:eval-safety-harnesses && npm run verify:worker-safety-contracts && npm run verify:compute-backends && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.ok(storeDef >= 0, 'router must define the shared W609 receipt-store wrapper');
  assert.ok(statusMount > storeDef, 'status routes must receive the real receipt-store wrapper');
  assert.ok(statusMount < authGate, 'status routes must be mounted before the global auth gate');
  assert.doesNotMatch(routerSource, /__registerWebsiteStatusRoutes_w921\(r,\s*\{\s*authMiddleware\s*\}\)/);
  assert.match(source, /WEBSITE_STATUS_LIMITS/);
  assert.match(source, /encodeURIComponent\(lastId\)/);
  assert.match(source, /max_receipt_scan_rows/);
});

test('W742 component status is deterministic and fails closed on missing primitives', () => {
  const missing = statusSummary({}, { now_ms: NOW_MS });
  assert.equal(missing.ok, true);
  assert.equal(missing.contract_version, WEBSITE_STATUS_CONTRACT_VERSION);
  assert.equal(missing.page.updated_at, '2026-06-18T00:00:00.000Z');
  assert.deepEqual(missing.components.map((c) => c.id), WEBSITE_STATUS_COMPONENT_IDS);
  assert.equal(missing.components.find((c) => c.id === 'gateway').status, 'operational');
  assert.equal(missing.components.find((c) => c.id === 'signing').status, 'degraded_performance');
  assert.equal(missing.components.find((c) => c.id === 'storage').status, 'degraded_performance');
  assert.equal(missing.status.indicator, 'minor');

  const healthyComponents = probeComponents({
    store: storeWith([]),
    loadSigner: () => ({ publicKey: 'fixture' }),
  }, { now_iso: '2026-06-18T00:00:00Z' });
  assert.deepEqual(healthyComponents.map((c) => c.status), ['operational', 'operational', 'operational']);
  assert.equal(healthyComponents.every((c) => c.contract_version === WEBSITE_STATUS_CONTRACT_VERSION), true);

  const failedSigner = probeComponents({
    store: storeWith([]),
    loadSigner: () => null,
  }, { now_ms: NOW_MS });
  assert.equal(failedSigner.find((c) => c.id === 'signing').status, 'degraded_performance');
});

test('W742 receipt stats are bounded, sanitized, and privacy-safe', () => {
  _resetReceiptCacheForTests();
  const filler = Array.from(
    { length: WEBSITE_STATUS_LIMITS.max_receipt_scan_rows - 3 },
    (_, i) => ({ receipt_id: `rcpt_fill_${i}`, created_at: '2026-06-17T12:00:00.000Z' }),
  );
  const rows = [
    {
      receipt_id: 'rcpt_first',
      created_at: '2026-06-17T00:00:01.000Z',
      tenant_id: 'tenant_secret',
      prompt: 'customer secret prompt',
    },
    { receipt_id: 'rcpt_bad/../../x', created_at: '2026-06-18T00:00:00.000Z' },
    { receipt: { receipt_id: 'rcpt_nested' }, at: '2026-06-18T00:00:00.000Z' },
    ...filler,
    { receipt_id: 'rcpt_after_limit', created_at: '2026-06-18T12:00:00.000Z' },
  ];

  const out = publicReceiptStats({ now_ms: NOW_MS, ttlMs: 0 }, { store: storeWith(rows) });
  const json = JSON.stringify(out);

  assert.equal(out.ok, true);
  assert.equal(out.version, WEBSITE_STATUS_VERSION);
  assert.equal(out.contract_version, WEBSITE_STATUS_CONTRACT_VERSION);
  assert.equal(out.scanned_row_limit, WEBSITE_STATUS_LIMITS.max_receipt_scan_rows);
  assert.equal(out.total, WEBSITE_STATUS_LIMITS.max_receipt_scan_rows - 1);
  assert.equal(out.last_24h, WEBSITE_STATUS_LIMITS.max_receipt_scan_rows - 1);
  assert.equal(out.last_receipt_id, 'rcpt_nested');
  assert.equal(out.last_receipt_at, '2026-06-18T00:00:00.000Z');
  assert.equal(out.verify_url, '/v1/verify/rcpt_nested');
  assert.equal(json.includes('tenant_secret'), false);
  assert.equal(json.includes('customer secret prompt'), false);
  assert.equal(json.includes('rcpt_bad'), false);
  assert.equal(json.includes('rcpt_after_limit'), false);
});

test('W742 receipt cache honors TTL normalization and zero-TTL refresh', () => {
  _resetReceiptCacheForTests();
  const first = publicReceiptStats({ now_ms: NOW_MS, ttlMs: 60000 }, {
    store: storeWith([{ receipt_id: 'rcpt_cached', created_at: '2026-06-18T00:00:00.000Z' }]),
  });
  const cached = publicReceiptStats({ now_ms: NOW_MS + 1000, ttlMs: 60000 }, {
    store: storeWith([{ receipt_id: 'rcpt_newer', created_at: '2026-06-18T00:00:01.000Z' }]),
  });
  assert.equal(cached.last_receipt_id, first.last_receipt_id);

  const refreshed = publicReceiptStats({ now_ms: NOW_MS + 1000, ttlMs: 0 }, {
    store: storeWith([{ receipt_id: 'rcpt_newer', created_at: '2026-06-18T00:00:01.000Z' }]),
  });
  assert.equal(refreshed.last_receipt_id, 'rcpt_newer');

  const defaultedTtl = publicReceiptStats({ now_ms: NOW_MS + 2000, ttlMs: -1 }, {
    store: storeWith([{ receipt_id: 'rcpt_should_not_replace_cached_value', created_at: '2026-06-18T00:00:02.000Z' }]),
  });
  assert.equal(defaultedTtl.last_receipt_id, 'rcpt_newer');
});

test('W742 route registration returns contract-versioned envelopes', () => {
  _resetReceiptCacheForTests();
  const routes = [];
  const r = {
    get(path, handler) {
      routes.push({ path, handler });
    },
  };
  registerWebsiteStatusRoutes(r, {
    store: storeWith([{ receipt_id: 'rcpt_route', created_at: '2026-06-18T00:00:00.000Z' }]),
    loadSigner: () => ({ publicKey: 'fixture' }),
  });

  assert.deepEqual(routes.map((route) => route.path), ['/v1/status/summary', '/v1/status/receipts']);
  let summary = null;
  routes.find((route) => route.path === '/v1/status/summary').handler({}, { json: (payload) => { summary = payload; } });
  assert.equal(summary.contract_version, WEBSITE_STATUS_CONTRACT_VERSION);
  assert.equal(summary.status.indicator, 'none');

  let receipts = null;
  routes.find((route) => route.path === '/v1/status/receipts').handler({}, { json: (payload) => { receipts = payload; } });
  assert.equal(receipts.contract_version, WEBSITE_STATUS_CONTRACT_VERSION);
  assert.equal(receipts.last_receipt_id, 'rcpt_route');
});
