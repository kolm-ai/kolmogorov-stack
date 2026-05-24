// W783 - Cost attribution / chargeback.
//
// Atomic items pinned (matches the W783 implementation):
//
//   1)  CHARGEBACK_VERSION matches /^w783-/ + DEFAULTS frozen
//   2)  GROUP_BY_DIMENSIONS frozen + exactly 3 dimensions
//   3)  EXPORT_FORMATS frozen + exactly 2 formats (csv, json)
//   4)  periodBounds returns half-open UTC bounds for valid YYYY-MM
//   5)  periodBounds throws invalid_period on garbage + month 13
//   6)  chargebackReport groups by namespace (default) + sorts cost desc
//   7)  chargebackReport groups by project (derived from namespace prefix)
//   8)  chargebackReport groups by department (mapped from namespace)
//   9)  chargebackReport W411 tenant fence (foreign rows excluded)
//   10) chargebackReport honest no_events_in_period envelope on empty
//   11) chargebackReport invalid_group_by envelope
//   12) exportChargeback CSV header + RFC 4180 escape + CRLF
//   13) exportChargeback JSON shape + mime_type
//   14) exportChargeback bad_format envelope
//   15) GET /v1/chargeback auth-gated (401 without auth)
//   16) GET /v1/chargeback returns ok envelope w/ auth + tenant_id forced from auth
//   17) POST /v1/chargeback/export streams CSV w/ Content-Type + X-Kolm-Chargeback-* headers
//   18) Router wires both routes + version stamps match /^w783-/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eventStore from '../src/event-store.js';
import * as chargeback from '../src/chargeback.js';
import * as auth from '../src/auth.js';
import * as kolmStore from '../src/store.js';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w783-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  return tmp;
}

async function buildApp() {
  const tmpdir = freshDir();
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

// Seed an event with explicit period (uses current month if omitted).
async function seedCost(tenant_id, namespace, cost_micro_usd, opts) {
  const o = opts || {};
  return await eventStore.appendEvent({
    tenant_id,
    namespace,
    provider: o.provider || 'openai',
    vendor: o.vendor || 'openai',
    model: o.model || 'gpt-4o-mini',
    tokens_in: o.tokens_in || 10,
    tokens_out: o.tokens_out || 20,
    prompt_tokens: o.tokens_in || 10,
    completion_tokens: o.tokens_out || 20,
    cost_micro_usd,
    estimated_cost_usd: cost_micro_usd / 1_000_000,
    latency_ms: o.latency_ms || 100,
    status: 'ok',
    created_at: o.created_at || new Date().toISOString(),
  });
}

function _currentPeriod() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// =============================================================================
// 1) Version + DEFAULTS frozen
// =============================================================================

test('W783 #1 - CHARGEBACK_VERSION matches /^w783-/ + DEFAULTS frozen', () => {
  assert.match(chargeback.CHARGEBACK_VERSION, /^w783-/);
  assert.ok(Object.isFrozen(chargeback.DEFAULTS));
  assert.equal(typeof chargeback.chargebackReport, 'function');
  assert.equal(typeof chargeback.exportChargeback, 'function');
  assert.equal(typeof chargeback.periodBounds, 'function');
});

// =============================================================================
// 2) GROUP_BY_DIMENSIONS frozen + exactly 3
// =============================================================================

test('W783 #2 - GROUP_BY_DIMENSIONS frozen + exactly 3 dimensions', () => {
  assert.ok(Object.isFrozen(chargeback.GROUP_BY_DIMENSIONS));
  assert.equal(chargeback.GROUP_BY_DIMENSIONS.length, 3);
  assert.deepEqual(Array.from(chargeback.GROUP_BY_DIMENSIONS),
    ['namespace', 'project', 'department']);
});

// =============================================================================
// 3) EXPORT_FORMATS frozen + exactly 2
// =============================================================================

test('W783 #3 - EXPORT_FORMATS frozen + exactly 2 formats', () => {
  assert.ok(Object.isFrozen(chargeback.EXPORT_FORMATS));
  assert.equal(chargeback.EXPORT_FORMATS.length, 2);
  assert.deepEqual(Array.from(chargeback.EXPORT_FORMATS), ['csv', 'json']);
});

// =============================================================================
// 4) periodBounds returns half-open UTC bounds
// =============================================================================

test('W783 #4 - periodBounds returns half-open UTC bounds for YYYY-MM', () => {
  const b = chargeback.periodBounds('2026-05');
  assert.equal(b.period, '2026-05');
  assert.equal(b.since, '2026-05-01T00:00:00.000Z');
  assert.equal(b.until, '2026-06-01T00:00:00.000Z');
  // Year-end rollover
  const dec = chargeback.periodBounds('2026-12');
  assert.equal(dec.since, '2026-12-01T00:00:00.000Z');
  assert.equal(dec.until, '2027-01-01T00:00:00.000Z');
});

// =============================================================================
// 5) periodBounds rejects malformed + month 13/00
// =============================================================================

test('W783 #5 - periodBounds throws invalid_period on garbage + out-of-range month', () => {
  let err;
  err = null;
  try { chargeback.periodBounds('2026/05'); } catch (e) { err = e; }
  assert.ok(err && err.code === 'invalid_period');
  err = null;
  try { chargeback.periodBounds('2026-13'); } catch (e) { err = e; }
  assert.ok(err && err.code === 'invalid_period',
    'month 13 must throw invalid_period (regex alone passes 2026-13 - Date.UTC silently rolls over)');
  err = null;
  try { chargeback.periodBounds('2026-00'); } catch (e) { err = e; }
  assert.ok(err && err.code === 'invalid_period');
});

// =============================================================================
// 6) Group by namespace (default) + sort by cost desc
// =============================================================================

test('W783 #6 - chargebackReport groups by namespace + sorts by cost desc', async () => {
  freshDir();
  const tenant = 'tenant_w783_6';
  await seedCost(tenant, 'support_chat', 100_000);
  await seedCost(tenant, 'support_chat', 150_000);
  await seedCost(tenant, 'premium_chat', 5_000_000);
  await seedCost(tenant, 'premium_chat', 3_000_000);

  const out = await chargeback.chargebackReport({
    tenant,
    period: _currentPeriod(),
    group_by: 'namespace',
  });
  assert.equal(out.ok, true);
  assert.equal(out.group_by, 'namespace');
  assert.equal(out.tenant_id, tenant);
  assert.equal(out.groups.length, 2);
  // Sorted desc.
  assert.equal(out.groups[0].key, 'premium_chat');
  assert.equal(out.groups[0].cost_micro_usd, 8_000_000);
  assert.equal(out.groups[0].call_count, 2);
  assert.equal(out.groups[1].key, 'support_chat');
  assert.equal(out.groups[1].cost_micro_usd, 250_000);
  // Totals roll up.
  assert.equal(out.total.cost_micro_usd, 8_250_000);
  assert.equal(out.total.call_count, 4);
});

// =============================================================================
// 7) Group by project (derived from namespace prefix)
// =============================================================================

test('W783 #7 - chargebackReport groups by project (derived from namespace prefix)', async () => {
  freshDir();
  const tenant = 'tenant_w783_7';
  // Two namespaces under 'support' project, one under 'sales'.
  await seedCost(tenant, 'support_chat',   500_000);
  await seedCost(tenant, 'support_email',  300_000);
  await seedCost(tenant, 'sales_outbound', 1_000_000);

  const out = await chargeback.chargebackReport({
    tenant,
    period: _currentPeriod(),
    group_by: 'project',
  });
  assert.equal(out.ok, true);
  assert.equal(out.group_by, 'project');
  // 'sales' project is biggest -> appears first.
  assert.equal(out.groups[0].key, 'sales');
  assert.equal(out.groups[0].cost_micro_usd, 1_000_000);
  // 'support' project rolls up both namespaces.
  assert.equal(out.groups[1].key, 'support');
  assert.equal(out.groups[1].cost_micro_usd, 800_000);
  assert.equal(out.groups[1].call_count, 2);
});

// =============================================================================
// 8) Group by department (mapped from namespace)
// =============================================================================

test('W783 #8 - chargebackReport groups by department (mapped from namespace)', async () => {
  freshDir();
  const tenant = 'tenant_w783_8';
  await seedCost(tenant, 'support_chat',   200_000);
  await seedCost(tenant, 'sales_outbound', 800_000);
  await seedCost(tenant, 'mkt_email',      500_000); // marketing prefix
  await seedCost(tenant, 'misc_workflow',  100_000); // -> unassigned

  const out = await chargeback.chargebackReport({
    tenant,
    period: _currentPeriod(),
    group_by: 'department',
  });
  assert.equal(out.ok, true);
  assert.equal(out.group_by, 'department');
  const keys = out.groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ['marketing', 'sales', 'support', 'unassigned']);
  const sales = out.groups.find((g) => g.key === 'sales');
  assert.equal(sales.cost_micro_usd, 800_000);
  const unassigned = out.groups.find((g) => g.key === 'unassigned');
  assert.equal(unassigned.cost_micro_usd, 100_000);
});

// =============================================================================
// 9) W411 tenant fence
// =============================================================================

test('W783 #9 - chargebackReport is tenant-fenced (foreign rows excluded)', async () => {
  freshDir();
  await seedCost('tenant_w783_9_A', 'shared', 1_000_000);
  await seedCost('tenant_w783_9_B', 'shared', 9_999_999);

  const a = await chargeback.chargebackReport({
    tenant: 'tenant_w783_9_A',
    period: _currentPeriod(),
  });
  assert.equal(a.ok, true);
  assert.equal(a.total.cost_micro_usd, 1_000_000,
    'tenant A must NOT see tenant B rows (got: ' + a.total.cost_micro_usd + ')');
  assert.equal(a.total.call_count, 1);

  const b = await chargeback.chargebackReport({
    tenant: 'tenant_w783_9_B',
    period: _currentPeriod(),
  });
  assert.equal(b.total.cost_micro_usd, 9_999_999);
});

// =============================================================================
// 10) Empty period -> honest envelope
// =============================================================================

test('W783 #10 - chargebackReport returns honest no_events_in_period on empty corpus', async () => {
  freshDir();
  const out = await chargeback.chargebackReport({
    tenant: 'tenant_w783_10',
    period: '2099-01', // far future, definitely empty
  });
  assert.equal(out.ok, true);
  assert.equal(out.message, 'no_events_in_period');
  assert.deepEqual(out.groups, []);
  assert.equal(out.total.cost_micro_usd, 0);
  assert.equal(out.total.call_count, 0);
});

// =============================================================================
// 11) invalid_group_by envelope
// =============================================================================

test('W783 #11 - chargebackReport invalid_group_by envelope on bad dimension', async () => {
  const out = await chargeback.chargebackReport({
    tenant: 'tenant_w783_11',
    period: _currentPeriod(),
    group_by: 'banana',
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_group_by');
  assert.deepEqual(Array.from(out.supported),
    ['namespace', 'project', 'department']);
  assert.match(out.version, /^w783-/);
});

// =============================================================================
// 12) CSV export shape (RFC 4180)
// =============================================================================

test('W783 #12 - exportChargeback CSV emits RFC 4180 header + CRLF + escape', async () => {
  freshDir();
  const tenant = 'tenant_w783_12';
  await seedCost(tenant, 'support_chat', 100_000);
  await seedCost(tenant, 'sales,with_comma', 200_000); // embedded comma exercises escape

  const out = await chargeback.exportChargeback({
    tenant,
    period: _currentPeriod(),
    group_by: 'namespace',
    format: 'csv',
  });
  assert.equal(out.ok, true);
  assert.equal(out.format, 'csv');
  assert.equal(out.mime_type, 'text/csv; charset=utf-8');
  assert.equal(out.row_count, 2);
  // Header row exact.
  const lines = out.body.split('\r\n');
  assert.equal(lines[0], 'period,group_by,key,cost_micro_usd,cost_usd,call_count,tokens_in,tokens_out');
  // CRLF terminator (last char of non-empty body region is \n preceded by \r).
  assert.ok(out.body.endsWith('\r\n'), 'CSV must end with CRLF');
  // Embedded comma triggers double-quote wrap.
  const commaLine = lines.find((l) => l.includes('"sales,with_comma"'));
  assert.ok(commaLine, 'embedded comma must be wrapped in double quotes (got: ' + JSON.stringify(lines) + ')');
});

// =============================================================================
// 13) JSON export shape
// =============================================================================

test('W783 #13 - exportChargeback JSON returns parseable body + mime_type', async () => {
  freshDir();
  const tenant = 'tenant_w783_13';
  await seedCost(tenant, 'ns1', 100_000);
  const out = await chargeback.exportChargeback({
    tenant,
    period: _currentPeriod(),
    format: 'json',
  });
  assert.equal(out.ok, true);
  assert.equal(out.format, 'json');
  assert.equal(out.mime_type, 'application/json; charset=utf-8');
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tenant_id, tenant);
  assert.equal(parsed.group_by, 'namespace');
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].key, 'ns1');
});

// =============================================================================
// 14) bad_format envelope
// =============================================================================

test('W783 #14 - exportChargeback bad_format envelope on unknown format', async () => {
  const out = await chargeback.exportChargeback({
    tenant: 'tenant_w783_14',
    period: _currentPeriod(),
    format: 'xml',
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'bad_format');
  assert.deepEqual(Array.from(out.supported), ['csv', 'json']);
});

// =============================================================================
// 15) Route auth-gated
// =============================================================================

test('W783 #15 - GET /v1/chargeback is auth-gated (401 without auth)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const res = await fetch(`${base}/v1/chargeback`);
    assert.equal(res.status, 401);
    // POST /v1/chargeback/export likewise
    const res2 = await fetch(`${base}/v1/chargeback/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'csv' }),
    });
    assert.equal(res2.status, 401);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 16) GET /v1/chargeback returns ok envelope w/ auth + tenant forced
// =============================================================================

test('W783 #16 - GET /v1/chargeback envelope w/ auth + tenant_id forced from auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenantA = await auth.provisionAnonTenant();
    const tenantB = await auth.provisionAnonTenant();
    // Seed B with rows; A has none.
    await seedCost(tenantB.id, 'premium', 5_000_000);

    // Caller is A; body cannot spoof to B.
    const res = await fetch(`${base}/v1/chargeback?period=` + encodeURIComponent(_currentPeriod()), {
      headers: { authorization: `Bearer ${tenantA.api_key}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tenant_id, tenantA.id);
    // Tenant A has no events.
    assert.equal(body.message, 'no_events_in_period',
      'tenant fence broken: A saw B rows');
    assert.equal(body.total.cost_micro_usd, 0);
    assert.match(body.version, /^w783-/);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 17) POST /v1/chargeback/export streams CSV w/ headers
// =============================================================================

test('W783 #17 - POST /v1/chargeback/export streams CSV w/ Content-Type + X-Kolm-Chargeback headers', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    await seedCost(tenant.id, 'support', 500_000);
    await seedCost(tenant.id, 'premium', 2_000_000);

    const res = await fetch(`${base}/v1/chargeback/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tenant.api_key}`,
      },
      body: JSON.stringify({
        period: _currentPeriod(),
        group_by: 'namespace',
        format: 'csv',
      }),
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.ok(/text\/csv/i.test(ct), 'Content-Type must be text/csv (got: ' + ct + ')');
    const cbVer = res.headers.get('x-kolm-chargeback-version') || '';
    assert.match(cbVer, /^w783-/, 'X-Kolm-Chargeback-Version header must match /^w783-/');
    const rowCount = res.headers.get('x-kolm-chargeback-row-count');
    assert.equal(rowCount, '2', 'row_count header must equal seeded group count');
    const text = await res.text();
    assert.ok(text.startsWith('period,group_by,key,'), 'CSV header must lead the body');
    assert.ok(text.includes('premium'), 'premium row must be present');
    assert.ok(text.includes('support'), 'support row must be present');

    // Also exercise JSON branch
    const res2 = await fetch(`${base}/v1/chargeback/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tenant.api_key}`,
      },
      body: JSON.stringify({
        period: _currentPeriod(),
        format: 'json',
      }),
    });
    assert.equal(res2.status, 200);
    const ct2 = res2.headers.get('content-type') || '';
    assert.ok(/application\/json/i.test(ct2), 'JSON branch must surface application/json Content-Type');
    const parsed = JSON.parse(await res2.text());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tenant_id, tenant.id);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 18) Router wires both routes + version stamps
// =============================================================================

test('W783 #18 - router.js wires /v1/chargeback routes + version stamps match /^w783-/', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.get\(['"]\/v1\/chargeback['"]/);
  assert.match(router, /r\.post\(['"]\/v1\/chargeback\/export['"]/);
  assert.match(router, /version:\s*['"]w783-/, 'router must emit w783 version stamps');
  // tenant forced from req.tenant_record.id (defense-in-depth). Slice a
  // generous window so we span the chargebackReport call inside the body.
  const cbStart = router.indexOf("r.get('/v1/chargeback'");
  assert.ok(cbStart > 0, 'chargeback route located');
  const cbBody = router.slice(cbStart, cbStart + 2000);
  assert.match(cbBody, /tenant:\s*req\.tenant_record\.id/,
    'chargeback route must force tenant from req.tenant_record.id');
});
