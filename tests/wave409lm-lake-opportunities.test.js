// W409l + W409m — telemetry lake + opportunity engine.
//
// W409l (lake):
//   - kolm lake stats / tail / export read from the canonical event-store
//     (NOT capture-store), so the dashboard sees what the optimizer sees.
//   - Account telemetry page exists at /account/lake and hits /v1/lake/stats
//     when wired through the static-served HTML.
//   - Storage lives at ~/.kolm/events/ first; cloud sync is opt-in only.
//   - Events carry stable id, tenant/namespace, redaction metadata, model/
//     vendor, latency/token/cost/status, and the multimodal media_* kinds.
//
// W409m (opportunities):
//   - findOpportunities() detects the 8 categories the brief calls for
//     (we already ship 11) and emits a universal score envelope:
//     { estimated_savings, volume, risk, trainability, score }.
//   - /v1/opportunities surfaces them.
//   - /v1/opportunities/:id/promote turns one into a dataset and returns
//     { dataset_id, train_count, holdout_count, source_event_ids }.
//
// Tests assert BEHAVIOR (rows that show up where, fields that round-trip,
// HTTP status codes) — never page copy. Same module-singleton trap noted
// in W397 + W409a applies: we import the stores at module scope so the
// router resolves the SAME instance the test writes to. The event-store
// is forced to jsonl mode so node:sqlite isn't required to run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

import * as eventStore from '../src/event-store.js';
import * as lake from '../src/lake.js';
import * as opportunityEngine from '../src/opportunity-engine.js';
import * as datasetWorkbench from '../src/dataset-workbench.js';
import { newEvent } from '../src/event-schema.js';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409lm-'));
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
}
function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Event-store autodetects sqlite vs jsonl on its own. We do NOT set
  // KOLM_STORE_DRIVER (that belongs to src/store.js / capture-store and
  // only accepts 'json' or 'sqlite' — setting it to 'jsonl' crashes
  // router import). The event-store's own driver picker handles both.
  if (eventStore._resetForTests) eventStore._resetForTests();
}
function teardownIsolated(home) {
  if (eventStore._resetForTests) eventStore._resetForTests();
  delete process.env.KOLM_DATA_DIR;
  cleanup(home);
}

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key, tenantId: t.id, tenantName: t.name };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const out = await fn(`http://127.0.0.1:${realPort}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// Seed the event-store directly. The canonical schema requires
// {event_id, tenant_id, namespace, created_at, schema_version}; appendEvent()
// fills the rest via newEvent() defaults.
async function seedEvents(opts) {
  const {
    namespace,
    tenantId = 'test-tenant',
    count = 1,
    promptTemplate = 'analyze log line {i}',
    model = 'gpt-4o',
    provider = 'openai',
    promptTokens = 800,
    completionTokens = 50,
    costPerCall = 0.02,
    latencyMs = 1500,
    sensitiveClasses = [],
    response = '',
  } = opts;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const ev = await eventStore.appendEvent({
      tenant_id: tenantId,
      namespace,
      provider,
      model,
      prompt_redacted: promptTemplate.replace('{i}', String(i)),
      response_redacted: response || ('ERROR_CLASS_' + (i % 3)),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      estimated_cost_usd: costPerCall,
      latency_ms: latencyMs,
      status: 'ok',
      sensitive_data_detected: sensitiveClasses.length > 0,
      sensitive_classes: sensitiveClasses,
      redaction_policy: sensitiveClasses.length > 0 ? 'allow' : 'redact',
      source_type: 'real',
    });
    ids.push(ev.event_id);
  }
  return ids;
}

function runCli(args, env = {}) {
  const merged = { ...process.env, ...env };
  // Strip any externally-set api key so the cli reads from our isolated HOME.
  delete merged.KOLM_API_KEY;
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: merged,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// =============================================================================
// 1) kolm lake stats reads from event-store
// =============================================================================

test('W409l #1 — kolm lake stats reads from event-store', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409l_ns_' + Date.now().toString(36);
    await seedEvents({ namespace: ns, count: 5, provider: 'openai', model: 'gpt-4o', costPerCall: 0.05, promptTokens: 1000, completionTokens: 100 });

    // (a) Programmatic lakeStats() — same module the CLI imports.
    const stats = await lake.lakeStats({ namespace: ns });
    assert.equal(stats.total_calls, 5, 'lake.lakeStats must report all 5 seeded events');
    assert.ok(stats.total_spend_usd > 0, 'spend must be > 0');
    assert.ok(stats.providers && stats.providers.openai, 'providers must include openai');
    assert.equal(stats.providers.openai.calls, 5, 'openai provider must show 5 calls');
    assert.ok(stats.models && stats.models['gpt-4o'], 'models must include gpt-4o');
    assert.ok(stats.storage, 'lakeStats must return a storage envelope');
    assert.ok(String(stats.storage.path || '').includes('events'), 'storage.path must point at ~/.kolm/events/');

    // (b) Spawned CLI — kolm lake stats --json
    const result = runCli(['lake', 'stats', '--json', '--namespace', ns], {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(result.status, 0, 'kolm lake stats must exit 0: stderr=' + result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.total_calls, 5, 'CLI stats must report 5 calls');
    assert.ok(parsed.providers.openai.calls === 5, 'CLI stats must surface openai provider');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 2) kolm lake tail streams from event-store
// =============================================================================

test('W409l #2 — kolm lake tail streams from event-store', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409l_tail_' + Date.now().toString(36);
    await seedEvents({ namespace: ns, count: 3, model: 'kolm-tail' });

    // tailEvents is async-iterable — exhaust the first 3 rows (no --follow).
    const seen = [];
    const iter = lake.tailEvents({ namespace: ns, limit: 10, follow: false });
    for await (const ev of iter) {
      seen.push(ev);
      if (seen.length >= 3) break;
    }
    assert.equal(seen.length, 3, 'tailEvents must yield 3 rows for the namespace');
    for (const ev of seen) {
      assert.equal(ev.namespace, ns, 'tail row namespace must match filter');
      assert.equal(ev.model, 'kolm-tail', 'tail row model must round-trip');
      assert.ok(ev.event_id, 'tail row must carry stable event_id');
      assert.ok(ev.created_at, 'tail row must carry created_at');
    }

    // CLI tail (no --follow so the iterator drains and exits).
    const result = runCli(['lake', 'tail', '--namespace', ns, '--limit', '3', '--json'], {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(result.status, 0, 'kolm lake tail must exit 0: stderr=' + result.stderr);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'CLI tail --limit 3 must emit 3 jsonl rows');
    const row = JSON.parse(lines[0]);
    assert.equal(row.namespace, ns, 'first CLI tail row namespace round-trips');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 3) kolm lake export outputs JSONL with canonical schema
// =============================================================================

test('W409l #3 — kolm lake export outputs JSONL with canonical schema', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409l_export_' + Date.now().toString(36);
    await seedEvents({ namespace: ns, count: 4, model: 'kolm-export', sensitiveClasses: ['email'] });

    // Programmatic exportEvents — JSONL is the default.
    const { exportEvents } = await import('../src/event-store.js');
    const buf = await exportEvents({ format: 'jsonl', namespace: ns });
    const text = String(buf);
    const lines = text.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 4, 'exportEvents jsonl must emit 4 lines');
    for (const ln of lines) {
      const ev = JSON.parse(ln);
      // Canonical schema fields (REQUIRED_FIELDS in event-schema.js).
      assert.ok(ev.event_id, 'each row carries event_id');
      assert.ok(ev.tenant_id, 'each row carries tenant_id');
      assert.equal(ev.namespace, ns, 'namespace round-trips');
      assert.ok(ev.created_at, 'each row carries created_at');
      assert.equal(typeof ev.schema_version, 'number', 'schema_version is a number');
      // Cost/latency/token/status/model/vendor are the W409l-mandated fields.
      assert.equal(ev.model, 'kolm-export', 'model round-trips');
      assert.equal(typeof ev.latency_ms, 'number', 'latency_ms is a number');
      assert.equal(typeof ev.estimated_cost_usd, 'number', 'cost is a number');
      assert.equal(typeof ev.status, 'string', 'status is a string');
      // Redaction metadata.
      assert.ok(['allow', 'redact', 'block', 'review_required'].includes(ev.redaction_policy),
        'redaction_policy is canonical');
      assert.ok(Array.isArray(ev.sensitive_classes), 'sensitive_classes is an array');
    }

    // CSV format negotiates correctly.
    const csv = await exportEvents({ format: 'csv', namespace: ns });
    const csvText = String(csv);
    assert.ok(csvText.includes('event_id'), 'CSV header must include event_id');
    assert.ok(csvText.split('\n').filter(Boolean).length >= 5, 'CSV must have header + 4 data rows');

    // CLI export verb — write to a file so we don't bloat stdout.
    const outPath = path.join(home, 'export.jsonl');
    const result = runCli(['lake', 'export', '--namespace', ns, '--format', 'jsonl', '--out', outPath], {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(result.status, 0, 'kolm lake export must exit 0: stderr=' + result.stderr);
    assert.ok(fs.existsSync(outPath), 'CLI export must create the --out file');
    const fileLines = fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(fileLines.length, 4, 'CLI export file must contain 4 lines');
    const first = JSON.parse(fileLines[0]);
    assert.equal(first.namespace, ns, 'CLI export round-trips namespace');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 4) 100 repeated mock log-analysis calls → 1 opportunity flagged
// =============================================================================

test('W409m #4 — 100 repeated log-analysis calls flag a repeated-prompt opportunity', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409m_repeat_' + Date.now().toString(36);
    // 100 identical-template log-triage calls. cost-per-call must be > $0.01
    // so the monthly-spend threshold ($10/mo at default minMonthlySpend) is
    // crossed.
    await seedEvents({
      namespace: ns,
      count: 100,
      promptTemplate: 'classify this log line: error connecting to db',
      model: 'gpt-4o',
      provider: 'openai',
      promptTokens: 500,
      completionTokens: 30,
      costPerCall: 0.05,
      latencyMs: 1200,
      response: 'database_error',
    });

    const opps = await opportunityEngine.findOpportunities({ namespace: ns });
    assert.ok(opps.length >= 1, 'must surface at least one opportunity for 100 repeated calls');
    // The "repeated expensive prompt" requirement matches our local_replacement_candidate
    // detector (templates repeated >=100x with monthly_spend >= $10).
    const repeatedTypes = new Set([
      'local_replacement_candidate',
      'log_triage',
      'repeated_classification',
      'cheaper_model_candidate',
    ]);
    const hit = opps.find(o => repeatedTypes.has(o.type));
    assert.ok(hit, 'must surface at least one of the repeated-prompt opportunity types: got types=' +
      JSON.stringify(opps.map(o => o.type)));
    assert.ok(hit.call_count >= 50, 'opportunity must show high call_count: got ' + hit.call_count);
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 5) Opportunity score reflects savings/volume/risk/trainability
// =============================================================================

test('W409m #5 — opportunity score envelope carries savings/volume/risk/trainability', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409m_score_' + Date.now().toString(36);
    await seedEvents({
      namespace: ns,
      count: 120,
      promptTemplate: 'classify support ticket text {i}',
      model: 'gpt-4o',
      provider: 'openai',
      promptTokens: 400,
      completionTokens: 20,
      costPerCall: 0.03,
      latencyMs: 900,
      response: 'billing',
    });

    const opps = await opportunityEngine.findOpportunities({ namespace: ns });
    assert.ok(opps.length >= 1, 'expected at least one opportunity');
    for (const o of opps) {
      // Universal envelope per the W409m spec.
      assert.equal(typeof o.estimated_savings, 'number', 'opportunity must carry numeric estimated_savings');
      assert.equal(typeof o.volume, 'number', 'opportunity must carry numeric volume');
      assert.ok(typeof o.risk === 'string', 'opportunity must carry risk string');
      assert.ok(['low', 'medium', 'high'].includes(o.risk), 'risk must be one of low/medium/high');
      assert.equal(typeof o.trainability, 'number', 'opportunity must carry numeric trainability');
      assert.ok(o.trainability >= 0 && o.trainability <= 1, 'trainability is a 0..1 fraction');
      assert.equal(typeof o.score, 'number', 'opportunity must carry a numeric score');
      assert.ok(o.score >= 0 && o.score <= 100, 'score is a 0..100 ranker');
    }

    // Score sanity: a high-savings + high-volume opportunity should beat a
    // tiny one. Verify by seeding a clearly trivial namespace and confirming
    // the bigger namespace's top score >= small namespace's top score.
    const nsSmall = ns + '_small';
    await seedEvents({
      namespace: nsSmall,
      count: 110,
      promptTemplate: 'tiny task {i}',
      costPerCall: 0.001,
      promptTokens: 100,
      completionTokens: 5,
    });
    const big = await opportunityEngine.findOpportunities({ namespace: ns });
    const small = await opportunityEngine.findOpportunities({ namespace: nsSmall });
    if (big.length && small.length) {
      const bigBest = Math.max(...big.filter(o => o.type !== 'privacy_leak').map(o => o.score));
      const smallBest = Math.max(...small.filter(o => o.type !== 'privacy_leak').map(o => o.score));
      assert.ok(bigBest >= smallBest, 'higher-spend namespace should score >= cheaper namespace: big=' + bigBest + ' small=' + smallBest);
    }
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 6) /v1/opportunities returns at least one opportunity after seeding events
// =============================================================================

test('W409m #6 — /v1/opportunities returns at least one row after seeding', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant();
    const ns = 'w409m_api_' + Date.now().toString(36);
    // W437 — seed under the authenticated tenant so the W419 tenant fence
    // on /v1/opportunities surfaces these rows. Before W437 this seeded under
    // the seedEvents default ('test-tenant') and the route correctly hid them.
    await seedEvents({
      namespace: ns,
      tenantId,
      count: 110,
      promptTemplate: 'extract entities from sentence {i}',
      model: 'gpt-4o',
      provider: 'openai',
      promptTokens: 600,
      completionTokens: 40,
      costPerCall: 0.04,
      response: 'PERSON',
    });

    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/opportunities?namespace=' + encodeURIComponent(ns), {
        headers: { authorization: 'Bearer ' + apiKey },
      });
      assert.equal(r.status, 200, '/v1/opportunities must return 200');
      const body = await r.json();
      assert.equal(body.ok, true, 'response envelope ok=true');
      assert.ok(body.total >= 1, '/v1/opportunities must return at least 1 row after seeding: got ' + body.total);
      assert.ok(Array.isArray(body.opportunities), 'opportunities array present');
      const first = body.opportunities[0];
      assert.ok(first.id, 'first opportunity has an id');
      assert.ok(first.type, 'first opportunity has a type');
      assert.ok(typeof first.score === 'number', 'first opportunity has a score');
    });
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 7) Promote opportunity → dataset returns dataset_id
// =============================================================================

test('W409m #7 — promote opportunity returns a dataset_id (programmatic + HTTP)', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409m_promote_' + Date.now().toString(36);
    // NOTE: W411 createDataset() applies content-based dedupe by (prompt,response)
    // hash BEFORE the train/holdout split, so 110 *identical* events collapse to
    // a single row and train_count can be 0 after the split. Vary the prompt
    // per iteration (the {i} slot is what makes each row distinct in the
    // dataset) while keeping the *template shape* identical so the opportunity
    // engine still clusters them as a single promotable template.
    const seededIds = await seedEvents({
      namespace: ns,
      count: 110,
      promptTemplate: 'fixed template prompt for promote test #{i}',
      model: 'gpt-4o',
      provider: 'openai',
      promptTokens: 600,
      completionTokens: 40,
      costPerCall: 0.04,
      response: 'category-A',
    });
    assert.equal(seededIds.length, 110, 'seeded 110 events');

    // 7a. Programmatic promote.
    const opps = await opportunityEngine.findOpportunities({ namespace: ns });
    assert.ok(opps.length >= 1, 'need at least one opportunity to promote');
    const oppToPromote = opps.find(o => o.type !== 'privacy_leak') || opps[0];
    const r = await opportunityEngine.promoteOpportunity(oppToPromote.id, { namespace: ns });
    assert.ok(r.dataset_id, 'promote must return a dataset_id');
    assert.ok(/^ds_/.test(r.dataset_id) || /dataset_/.test(r.dataset_id) || r.dataset_id.length > 0,
      'dataset_id has a reasonable shape: ' + r.dataset_id);
    assert.equal(r.namespace, ns, 'promote response namespace matches');
    assert.ok(r.train_count > 0, 'promote response carries train_count');
    assert.ok(r.holdout_count >= 0, 'promote response carries holdout_count');
    assert.ok(Array.isArray(r.source_event_ids), 'source_event_ids array present');

    // Verify the dataset was actually written to disk.
    const inspected = await datasetWorkbench.inspectDataset(r.dataset_id);
    assert.equal(inspected.namespace, ns, 'on-disk dataset has the correct namespace');
    assert.ok(inspected.from_opportunity === oppToPromote.id, 'on-disk dataset records from_opportunity provenance');
    // train_ids/holdout_ids must be disjoint (W369 dataset workbench rule).
    const setA = new Set(inspected.train_ids || []);
    const setB = new Set(inspected.holdout_ids || []);
    let overlap = 0;
    for (const id of setA) if (setB.has(id)) overlap++;
    assert.equal(overlap, 0, 'train_ids and holdout_ids must be disjoint');

    // 7b. HTTP promote on a *fresh* opportunity (different namespace so we
    // don't double-promote and trip the "already promoted" guard).
    // W437 — seed under the same tenant the request authenticates as so the
    // W419 tenant fence on /v1/opportunities surfaces these rows.
    const { app, apiKey, tenantId } = await makeAppAndTenant();
    const ns2 = ns + '_http';
    await seedEvents({
      namespace: ns2,
      tenantId,
      count: 110,
      promptTemplate: 'fixed template for http promote #{i}',
      model: 'gpt-4o',
      provider: 'openai',
      costPerCall: 0.04,
      promptTokens: 600,
      completionTokens: 40,
      response: 'category-B',
    });
    await withServer(app, async (base) => {
      const ro = await fetch(base + '/v1/opportunities?namespace=' + encodeURIComponent(ns2), {
        headers: { authorization: 'Bearer ' + apiKey },
      });
      const ob = await ro.json();
      assert.ok(ob.total >= 1, 'need >=1 opportunity in ns2 to promote');
      const target = ob.opportunities.find(o => o.type !== 'privacy_leak') || ob.opportunities[0];
      const rp = await fetch(base + '/v1/opportunities/' + encodeURIComponent(target.id) + '/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ namespace: ns2 }),
      });
      assert.equal(rp.status, 200, '/promote must return 200');
      const pb = await rp.json();
      assert.equal(pb.ok, true, 'promote response envelope ok=true');
      assert.ok(pb.dataset_id, '/promote response must carry dataset_id');
      assert.equal(pb.namespace, ns2, '/promote response namespace matches');
      assert.ok(pb.train_count > 0, '/promote response carries train_count');
    });
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 8) Account page route serves HTML that calls the lake/opportunities APIs
// =============================================================================

test('W409l #8 — /account/lake page exists and references /v1/lake/stats', async () => {
  // The account page lives at public/account/lake.html. We don't spin a static
  // server here; we just verify the file ships and binds the lake endpoints
  // so the test catches regressions where the page silently drops API wiring.
  const lakePath = path.join(REPO_ROOT, 'public', 'account', 'lake.html');
  assert.ok(fs.existsSync(lakePath), 'public/account/lake.html must exist');
  const html = fs.readFileSync(lakePath, 'utf8');
  assert.ok(html.includes('/v1/lake/stats'), 'lake.html must call /v1/lake/stats');
  assert.ok(html.includes('/v1/lake/tail'), 'lake.html must call /v1/lake/tail');
  assert.ok(html.includes('/v1/lake/export'), 'lake.html must call /v1/lake/export');
  // Storage path documented in copy so users know where their events live.
  assert.ok(/~\/\.kolm\/events/.test(html), 'lake.html must document the ~/.kolm/events/ storage path');
});

// =============================================================================
// 9) /v1/lake/tail returns recent canonical events
// =============================================================================

test('W409l #9 — /v1/lake/tail returns events with canonical schema fields', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant();
    const ns = 'w409l_apitail_' + Date.now().toString(36);
    // W411 — seed with the canonical tenant id (`tenant_*`) so the lake API,
    // which fences on req.tenant_record.id, can see the rows.
    await seedEvents({ namespace: ns, count: 5, model: 'kolm-apitail', tenantId });

    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/lake/tail?namespace=' + encodeURIComponent(ns) + '&limit=5', {
        headers: { authorization: 'Bearer ' + apiKey },
      });
      assert.equal(r.status, 200, '/v1/lake/tail must return 200');
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.events), 'events array present');
      assert.equal(body.events.length, 5, 'tail must return all 5 seeded events');
      for (const ev of body.events) {
        assert.ok(ev.event_id, 'event_id present');
        assert.equal(ev.namespace, ns, 'namespace round-trips');
        assert.equal(ev.model, 'kolm-apitail', 'model round-trips');
      }
    });
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 10) /v1/lake/export emits valid JSONL via HTTP
// =============================================================================

test('W409l #10 — /v1/lake/export emits valid JSONL via HTTP', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant();
    const ns = 'w409l_httpexport_' + Date.now().toString(36);
    // W411 — seed with the canonical tenant id; /v1/lake/export fences on
    // req.tenant_record.id.
    await seedEvents({ namespace: ns, count: 3, model: 'kolm-export-http', tenantId });

    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/lake/export?namespace=' + encodeURIComponent(ns) + '&format=jsonl', {
        headers: { authorization: 'Bearer ' + apiKey },
      });
      assert.equal(r.status, 200, '/v1/lake/export must return 200');
      assert.equal(r.headers.get('x-kolm-lake-format'), 'jsonl', 'x-kolm-lake-format header echoes format');
      const text = await r.text();
      const lines = text.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 3, '/v1/lake/export jsonl must emit 3 lines');
      for (const ln of lines) {
        const ev = JSON.parse(ln);
        assert.equal(ev.namespace, ns, 'each line round-trips namespace');
        assert.ok(ev.event_id, 'each line has event_id');
      }
    });
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 11) privacy_leak opportunity surfaces when policy=allow and sensitive data
// =============================================================================

test('W409m #11 — privacy_leak opportunity fires for sensitive_data + policy=allow', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w409m_privacy_' + Date.now().toString(36);
    await seedEvents({
      namespace: ns,
      count: 12,
      promptTemplate: 'user contact info {i}',
      sensitiveClasses: ['email', 'phone'],
      costPerCall: 0.01,
      promptTokens: 200,
      completionTokens: 10,
    });
    const opps = await opportunityEngine.findOpportunities({ namespace: ns });
    const privacy = opps.find(o => o.type === 'privacy_leak');
    assert.ok(privacy, 'privacy_leak opportunity must fire for sensitive + allow policy');
    assert.equal(privacy.risk, 'high', 'privacy_leak risk is high');
    assert.equal(privacy.score, 100, 'privacy_leak score is pinned to 100 for top-of-list surfacing');
    // Score-envelope contract still holds.
    assert.equal(privacy.trainability, 0, 'privacy_leak trainability is 0 (policy hint, not a training opportunity)');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 12) /v1/lake/storage returns the canonical event-store envelope
// =============================================================================

test('W409l #12 — /v1/lake/storage returns event-store driver + path + count', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant();
    const ns = 'w409l_storage_' + Date.now().toString(36);
    // W411 — seed with the canonical tenant id; /v1/lake/storage scopes its
    // total_events count via the same _tenantScope helper.
    await seedEvents({ namespace: ns, count: 2, tenantId });

    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/lake/storage', {
        headers: { authorization: 'Bearer ' + apiKey },
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.ok(body.driver, 'driver present');
      assert.equal(body.total_events >= 2, true, 'total_events >= 2 after seeding');
      // Either db_path or jsonl_path must be set so the dashboard can show the
      // user where their events live.
      assert.ok(body.db_path || body.jsonl_path, 'one of db_path / jsonl_path must be set');
    });
  } finally {
    teardownIsolated(home);
  }
});
