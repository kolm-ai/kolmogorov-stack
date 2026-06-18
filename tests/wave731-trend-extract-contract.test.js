// W731 - direct contract test for src/trend-extract.js.
//
// Pattern lake tests prove the write/aggregate primitive. This pins the trend
// reader itself: bounded scans, active opt-in re-fencing, SHA-256-only outputs,
// deterministic summaries, and compact route error envelopes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w731-trend-'));
process.env.KOLM_DATA_DIR = DATA_DIR;
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
process.env.KOLM_ENV = 'test';

const { test, beforeEach, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const eventStore = await import('../src/event-store.js');
const lake = await import('../src/pattern-lake.js');
const trend = await import('../src/trend-extract.js');

const PROVIDER_CONTRIBUTION = 'kolm_pattern_lake_contribution';
const NOW_MS = Date.parse('2026-06-18T00:00:00.000Z');
const RECENT_AT = new Date(NOW_MS - 24 * 3600 * 1000).toISOString();
const PRIOR_AT = new Date(NOW_MS - 10 * 24 * 3600 * 1000).toISOString();
const HEX64_RE = /^[a-f0-9]{64}$/;
let caseCounter = 0;

beforeEach(() => {
  const caseDir = path.join(DATA_DIR, `case-${caseCounter++}`);
  fs.mkdirSync(caseDir, { recursive: true });
  process.env.KOLM_DATA_DIR = caseDir;
  eventStore._resetForTests();
});

after(() => {
  try { eventStore._resetForTests(); } catch {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

async function appendContribution({ tenant, namespace, created_at, hashes, capture_id }) {
  await eventStore.appendEvent({
    tenant_id: tenant,
    namespace: 'kolm_pattern_lake',
    provider: PROVIDER_CONTRIBUTION,
    status: 'ok',
    created_at,
    feedback: JSON.stringify({
      capture_id,
      namespace,
      bigram_hashes: hashes,
      version: 'test',
    }),
  });
}

async function seedTrendFixture() {
  const hot = sha('frontier|trend');
  const baseline = sha('baseline|trend');
  for (let i = 0; i < 5; i += 1) {
    const tenant = `trend-tenant-${i}`;
    const namespace = `support-code-${i}`;
    await lake.optIn(tenant, namespace);
    await appendContribution({
      tenant,
      namespace,
      created_at: PRIOR_AT,
      capture_id: `prior-${i}`,
      hashes: [baseline, 'raw secret should be dropped'],
    });
    await appendContribution({
      tenant,
      namespace,
      created_at: RECENT_AT,
      capture_id: `recent-${i}`,
      hashes: [hot, hot, 'customer@example.com'],
    });
  }

  await appendContribution({
    tenant: 'unopted-tenant',
    namespace: 'support-code-unopted',
    created_at: RECENT_AT,
    capture_id: 'unopted',
    hashes: [hot],
  });

  await lake.optIn('revoked-tenant', 'support-code-revoked');
  await appendContribution({
    tenant: 'revoked-tenant',
    namespace: 'support-code-revoked',
    created_at: RECENT_AT,
    capture_id: 'revoked',
    hashes: [hot],
  });
  await lake.optOut('revoked-tenant', 'support-code-revoked');
  return { hot, baseline };
}

test('W731 trend extraction is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/trend-extract.js');
  const routerSource = read('src/router.js');

  assert.equal(trend.TREND_EXTRACT_CONTRACT_VERSION, 'w731-trend-v1');
  assert.ok(trend.TREND_EXTRACT_LIMITS.max_scan_rows <= 50000);
  assert.ok(trend.TREND_EXTRACT_LIMITS.max_emerging_items <= 50);
  assert.equal(
    pkg.scripts['verify:trend-extract'],
    'node --test --test-concurrency=1 tests/wave731-trend-extract-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:scim-provisioning && npm run verify:trend-extract && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /TREND_EXTRACT_CONTRACT_VERSION/);
  assert.match(source, /_normalizeBigramHashes/);
  assert.match(source, /_isStillOptedIn/);
  assert.match(routerSource, /error_sha256/);
  assert.doesNotMatch(routerSource, /lake_trends_error['"][^}]+detail:/s);
});

test('W731 insufficient history is honest and caps caller scan parameters', async () => {
  const out = await trend.emergingPatterns({
    window_days: 0,
    min_growth_ratio: -99,
    max_scan_rows: 999999,
    now_ms: NOW_MS,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'insufficient_history');
  assert.equal(out.need_min_rows, trend.TREND_EXTRACT_LIMITS.min_history_rows);
  assert.equal(out.window_days, 1);
  assert.equal(out.max_scan_rows, trend.TREND_EXTRACT_LIMITS.max_scan_rows);
  assert.equal(out.scan_rows, 0);
  assert.equal(out.contract_version, trend.TREND_EXTRACT_CONTRACT_VERSION);
});

test('W731 emerging patterns use active opt-in rows and never emit raw hashes or tenant ids', async () => {
  const { hot } = await seedTrendFixture();

  const out = await trend.emergingPatterns({
    window_days: 7,
    min_growth_ratio: 2,
    max_scan_rows: 100,
    now_ms: NOW_MS,
  });
  const json = JSON.stringify(out);

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, trend.TREND_EXTRACT_CONTRACT_VERSION);
  assert.equal(out.generated_at, '2026-06-18T00:00:00.000Z');
  assert.equal(out.n_recent_rows, 5);
  assert.equal(out.n_prior_rows, 5);
  assert.equal(out.emerging[0].hash, hot);
  assert.equal(out.emerging[0].recent_count, 5);
  assert.equal(out.emerging[0].prior_count, 0);
  for (const row of out.emerging) assert.match(row.hash, HEX64_RE);
  assert.doesNotMatch(json, /raw secret/);
  assert.doesNotMatch(json, /customer@example\.com/);
  assert.doesNotMatch(json, /trend-tenant-/);
  assert.doesNotMatch(json, /unopted-tenant|revoked-tenant/);
});

test('W731 summarizeTrends stays aggregate-only and deterministic', async () => {
  await seedTrendFixture();

  const out = await trend.summarizeTrends({
    max_scan_rows: 100,
    window_days: 7,
    min_growth_ratio: 2,
    now_ms: NOW_MS,
  });
  const support = out.top_verticals_by_density.find((row) => row.vertical_id === 'support');

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, trend.TREND_EXTRACT_CONTRACT_VERSION);
  assert.equal(out.generated_at, '2026-06-18T00:00:00.000Z');
  assert.equal(out.total_contributors, 5);
  assert.equal(out.total_namespaces, 5);
  assert.equal(out.total_optin_tenants, 5);
  assert.equal(out.emerging_count, 1);
  assert.deepEqual(support, { vertical_id: 'support', contribution_rows: 10 });
  assert.doesNotMatch(JSON.stringify(out), /trend-tenant-|support-code-/);
});

test('W731 max_scan_rows bounds trend history reads', async () => {
  await seedTrendFixture();

  const out = await trend.emergingPatterns({
    window_days: 7,
    min_growth_ratio: 2,
    max_scan_rows: 2,
    now_ms: NOW_MS,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'insufficient_history');
  assert.equal(out.max_scan_rows, 2);
  assert.equal(out.scan_rows, 2);
  assert.equal(out.scan_capped, true);
});
