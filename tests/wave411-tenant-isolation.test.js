// Wave 411 — Tenant isolation lock-in across the data plane.
//
// The external CTO audit (2026-05-19) flagged that several /v1/* surfaces
// read the global event-store / approvals.jsonl / datasets folder without
// scoping by tenant_id. tenantA, by accident or intent, could see tenantB's
// captures, repeated-cluster spend, label queue, and datasets.
//
// This file pins the new tenant fence in three places:
//
//   (a) event-store listEvents/countEvents/exportEvents accept `tenant`/`tenant_id`
//       and drop every row that does not match.
//   (b) src/router.js _tenantScope(req) reads req.tenant_record.id and pushes it
//       down into the lake/dataset/label/bakeoff handlers.
//   (c) src/dataset-workbench.js + src/label-queue.js stamp tenant_id on every
//       approval / dataset row, and the lookup path drops cross-tenant records.
//
// The tests assert BEHAVIOR (HTTP responses, list contents, error codes) — not
// page copy. They use per-test tmpdirs (KOLM_DATA_DIR + HOME) so the dev box's
// real ~/.kolm is never touched. Run with `--test-concurrency=1` to avoid the
// SQLite parallel-test trap (W311 + W319).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function _mkTmp(label = 'w411t') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISABLE_RATE_LIMIT: process.env.KOLM_DISABLE_RATE_LIMIT,
    KOLM_DB_PATH: process.env.KOLM_DB_PATH,
    DEFAULT_TENANT: process.env.DEFAULT_TENANT,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // src/event-store.js auto-detects sqlite vs jsonl; src/store.js (row store
  // for tenants/recipes/etc.) accepts only 'json' or 'sqlite' — use 'json'
  // here so the auth tenant_record insert/findByApiKey path works without
  // pulling node:sqlite into the test box.
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'wave411-tenant-isolation-secret-32+chars';
  process.env.KOLM_DB_PATH = path.join(tmp, 'kolm.sqlite');
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// Append N events directly into the canonical event-store under a specific
// tenant_id. This bypasses HTTP so we can seed both tenants without spinning
// up two API keys (the HTTP path is exercised in test #2 below).
async function _seed(tenantId, namespace, n) {
  const { appendEvent } = await import('../src/event-store.js');
  const ids = [];
  for (let i = 0; i < n; i++) {
    const ev = await appendEvent({
      namespace,
      tenant_id: tenantId,
      prompt_redacted: `${tenantId} prompt ${i}`,
      response_redacted: `${tenantId} reply ${i}`,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      estimated_cost_usd: 0.001,
      latency_ms: 42,
    });
    ids.push(ev.event_id);
  }
  return ids;
}

async function _bustModuleCache() {
  // Reset the event-store singleton so the per-test tmpdir is honored when
  // tests run sequentially. _resetForTests is exported expressly for this.
  const ev = await import('../src/event-store.js');
  if (typeof ev._resetForTests === 'function') ev._resetForTests();
}

// Boot an in-process express app on a random port; mint two distinct anon
// tenants so the test can fire authenticated requests for each one.
async function _makeAppTwoTenants() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const tA = provisionAnonTenant({ ttl_days: 1, quota: 100000 });
  const tB = provisionAnonTenant({ ttl_days: 1, quota: 100000 });
  return { app, A: tA, B: tB };
}

function _withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// #1 — event-store listEvents({tenant_id}) returns only the requested tenant's
//      rows; the JSONL backend honors the same filter as SQLite.
// ---------------------------------------------------------------------------
test('W411-T #1 — listEvents({tenant_id}) returns only the requested tenant\'s rows', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  await _seed('tenant_A_iso', 'ns_iso_1', 10);
  await _seed('tenant_B_iso', 'ns_iso_1', 10);

  const { listEvents, countEvents } = await import('../src/event-store.js');
  const allRows = await listEvents({ namespace: 'ns_iso_1', limit: 0 });
  assert.equal(allRows.length, 20, 'global listEvents sees both tenants');

  const aRows = await listEvents({ namespace: 'ns_iso_1', tenant_id: 'tenant_A_iso', limit: 0 });
  assert.equal(aRows.length, 10, 'tenant_id filter restricts to A\'s 10 rows');
  for (const r of aRows) assert.equal(r.tenant_id, 'tenant_A_iso');

  // The `tenant` shorthand must produce the same result as `tenant_id`.
  const aShort = await listEvents({ namespace: 'ns_iso_1', tenant: 'tenant_A_iso', limit: 0 });
  assert.equal(aShort.length, 10, 'tenant shorthand is honored');

  const aCount = await countEvents({ namespace: 'ns_iso_1', tenant_id: 'tenant_A_iso' });
  assert.equal(aCount, 10, 'countEvents honors the tenant filter');

  const bRows = await listEvents({ namespace: 'ns_iso_1', tenant_id: 'tenant_B_iso', limit: 0 });
  assert.equal(bRows.length, 10, 'tenant_id filter restricts to B\'s 10 rows');
});

// ---------------------------------------------------------------------------
// #2 — HTTP /v1/lake/stats and /v1/lake/tail return only the caller's rows.
//      Tenant A's key never surfaces tenant B's spend or events.
// ---------------------------------------------------------------------------
test('W411-T #2 — /v1/lake/stats + /v1/lake/tail are tenant-scoped to the api key', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  const { app, A, B } = await _makeAppTwoTenants();
  // Seed events under each tenant's canonical id (the same id auth attaches
  // to req.tenant_record.id when the api_key is validated).
  await _seed(A.id, 'ns_lake', 10);
  await _seed(B.id, 'ns_lake', 10);

  await _withServer(app, async (base) => {
    // Tenant A asks for /v1/lake/stats — must report 10 total_calls, $0.01 spend.
    const sA = await fetch(base + '/v1/lake/stats?namespace=ns_lake', {
      headers: { authorization: 'Bearer ' + A.api_key },
    });
    assert.equal(sA.status, 200);
    const aBody = await sA.json();
    assert.equal(aBody.total_calls, 10, 'tenant A sees only its own 10 calls');
    assert.equal(aBody.window.tenant_id, A.id, 'window echoes the tenant_id scope');

    // Tenant B independently sees its 10.
    const sB = await fetch(base + '/v1/lake/stats?namespace=ns_lake', {
      headers: { authorization: 'Bearer ' + B.api_key },
    });
    const bBody = await sB.json();
    assert.equal(bBody.total_calls, 10, 'tenant B sees only its own 10 calls');

    // /v1/lake/tail returns the events, scoped.
    const tA = await fetch(base + '/v1/lake/tail?namespace=ns_lake&limit=50', {
      headers: { authorization: 'Bearer ' + A.api_key },
    });
    const tABody = await tA.json();
    assert.equal(tABody.events.length, 10);
    for (const ev of tABody.events) {
      assert.equal(ev.tenant_id, A.id, 'every row /v1/lake/tail returns belongs to A');
    }
  });
});

// ---------------------------------------------------------------------------
// #3 — Cross-tenant compile is blocked: when tenant A calls compileFull with
//      its tenant scope, it cannot ingest tenant B's rows even when they
//      share the same namespace.
// ---------------------------------------------------------------------------
test('W411-T #3 — prepareDistillCorpus({tenant_id}) blocks cross-tenant ingest', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  await _seed('tenant_A_compile', 'ns_compile', 6);
  await _seed('tenant_B_compile', 'ns_compile', 6);

  const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');

  const corpusA = await prepareDistillCorpus({ namespace: 'ns_compile', split: 'all', tenant_id: 'tenant_A_compile' });
  assert.equal(corpusA.pairs.length, 6, 'tenant A\'s corpus has only A\'s 6 rows');
  for (const p of corpusA.pairs) {
    assert.equal(p.tenant_id, 'tenant_A_compile', 'every pair carries tenant_A_compile');
    assert.match(p.prompt, /tenant_A_compile/);
  }

  const corpusB = await prepareDistillCorpus({ namespace: 'ns_compile', split: 'all', tenant_id: 'tenant_B_compile' });
  assert.equal(corpusB.pairs.length, 6, 'tenant B\'s corpus has only B\'s 6 rows');

  // Global (admin / local-only): no tenant filter -> all 12 rows.
  const corpusAll = await prepareDistillCorpus({ namespace: 'ns_compile', split: 'all' });
  assert.equal(corpusAll.pairs.length, 12, 'no tenant filter returns the global corpus');
});

// ---------------------------------------------------------------------------
// #4 — Label approvals stamped with tenant A do NOT surface in tenant B's
//      review queue and stats; cross-tenant submitLabel returns 403.
// ---------------------------------------------------------------------------
test('W411-T #4 — label approvals are tenant-fenced (queue + stats + submit)', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  const aIds = await _seed('tenant_A_label', 'ns_lbl', 5);
  const bIds = await _seed('tenant_B_label', 'ns_lbl', 5);

  const { submitLabel, nextToLabel, labelStats } = await import('../src/label-queue.js');

  // Tenant A approves all 5 of its events.
  for (const eid of aIds) {
    await submitLabel(eid, { verdict: 'good', reviewer: 'reviewer-A', tenant_id: 'tenant_A_label' });
  }

  // Tenant B's queue should still show its 5 events as undecided.
  const bQueue = await nextToLabel({ namespace: 'ns_lbl', n: 50, tenant_id: 'tenant_B_label' });
  assert.equal(bQueue.length, 5, 'tenant B\'s queue is untouched by A\'s approvals');
  for (const ev of bQueue) assert.equal(ev.tenant_id, 'tenant_B_label');

  // Tenant A's queue: 0 pending.
  const aQueue = await nextToLabel({ namespace: 'ns_lbl', n: 50, tenant_id: 'tenant_A_label' });
  assert.equal(aQueue.length, 0, 'tenant A\'s queue is empty after approving all 5');

  // labelStats() must compartmentalize counts.
  const aStats = await labelStats({ tenant_id: 'tenant_A_label' });
  assert.equal(aStats.approved, 5, 'tenant A stats: 5 approved');
  assert.equal(aStats.pending, 0, 'tenant A stats: 0 pending');
  assert.equal(aStats.total_events, 5, 'tenant A stats: 5 total events');

  const bStats = await labelStats({ tenant_id: 'tenant_B_label' });
  assert.equal(bStats.approved, 0, 'tenant B stats: 0 approved (A\'s 5 do not leak)');
  assert.equal(bStats.pending, 5, 'tenant B stats: 5 pending');
  assert.equal(bStats.total_events, 5, 'tenant B stats: 5 total events (A\'s do not leak)');

  // Cross-tenant submitLabel must throw CROSS_TENANT_LABEL.
  let threw = null;
  try {
    await submitLabel(bIds[0], { verdict: 'good', reviewer: 'attacker-A', tenant_id: 'tenant_A_label' });
  } catch (e) { threw = e; }
  assert.ok(threw, 'cross-tenant submitLabel must throw');
  assert.equal(threw.code, 'CROSS_TENANT_LABEL', 'error code is CROSS_TENANT_LABEL');
});

// ---------------------------------------------------------------------------
// #5 — Dataset workbench: createDataset stamps tenant_id; listDatasets({tenant})
//      hides cross-tenant rows; the /v1/datasets HTTP path 404s on cross-tenant
//      inspect.
// ---------------------------------------------------------------------------
test('W411-T #5 — datasets fenced at creation + listing + HTTP inspect', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  // Seed 5 events per tenant in the same namespace.
  await _seed('tenant_A_ds', 'ns_ds', 5);
  await _seed('tenant_B_ds', 'ns_ds', 5);

  const { createDataset, listDatasets, inspectDataset } = await import('../src/dataset-workbench.js');

  const dsA = await createDataset('ns_ds', { tenant_id: 'tenant_A_ds' });
  assert.equal(dsA.tenant_id, 'tenant_A_ds', 'dataset stamps tenant_id from caller');
  assert.equal(dsA.source_event_ids.length, 5, 'createDataset({tenant}) pulls only A\'s 5 rows');

  const dsB = await createDataset('ns_ds', { tenant_id: 'tenant_B_ds' });
  assert.equal(dsB.tenant_id, 'tenant_B_ds');
  assert.equal(dsB.source_event_ids.length, 5, 'createDataset({tenant}) pulls only B\'s 5 rows');

  // listDatasets({tenant: A}) drops B's dataset.
  const aList = await listDatasets({ tenant_id: 'tenant_A_ds' });
  assert.equal(aList.length, 1, 'tenant A sees its 1 dataset');
  assert.equal(aList[0].tenant_id, 'tenant_A_ds');

  const bList = await listDatasets({ tenant_id: 'tenant_B_ds' });
  assert.equal(bList.length, 1, 'tenant B sees its 1 dataset');

  // Global view (admin / local-only): both datasets visible.
  const allList = await listDatasets({});
  assert.equal(allList.length, 2, 'admin / local-only view returns both datasets');

  // inspectDataset still works module-level (the HTTP route enforces the
  // cross-tenant 404).
  const inspectA = await inspectDataset(dsA.dataset_id);
  assert.equal(inspectA.tenant_id, 'tenant_A_ds');
});

// ---------------------------------------------------------------------------
// #6 — HTTP /v1/datasets POST + GET :id enforces the tenant fence over the
//      wire: tenant B asking for tenant A's dataset by id gets a 404.
// ---------------------------------------------------------------------------
test('W411-T #6 — HTTP /v1/datasets fences cross-tenant inspect at the route', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  const { app, A, B } = await _makeAppTwoTenants();
  await _seed(A.id, 'ns_http_ds', 5);
  await _seed(B.id, 'ns_http_ds', 5);

  await _withServer(app, async (base) => {
    // Tenant A creates its dataset.
    const createA = await fetch(base + '/v1/datasets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A.api_key },
      body: JSON.stringify({ namespace: 'ns_http_ds' }),
    });
    assert.equal(createA.status, 200);
    const aBody = await createA.json();
    assert.ok(aBody.dataset_id, 'dataset_id minted');
    assert.equal(aBody.tenant_id, A.id, 'dataset stamped with A\'s tenant_id');

    // Tenant A reads its own dataset -> 200.
    const ownGet = await fetch(base + `/v1/datasets/${aBody.dataset_id}`, {
      headers: { authorization: 'Bearer ' + A.api_key },
    });
    assert.equal(ownGet.status, 200, 'owner inspect returns 200');

    // Tenant B tries to read A's dataset by id -> 404.
    const crossGet = await fetch(base + `/v1/datasets/${aBody.dataset_id}`, {
      headers: { authorization: 'Bearer ' + B.api_key },
    });
    assert.equal(crossGet.status, 404, 'cross-tenant inspect returns 404');

    // Tenant B's /v1/datasets list does not include A's dataset.
    const bList = await fetch(base + '/v1/datasets', {
      headers: { authorization: 'Bearer ' + B.api_key },
    });
    const bListBody = await bList.json();
    for (const ds of bListBody.datasets || []) {
      assert.notEqual(ds.dataset_id, aBody.dataset_id, 'A\'s dataset never appears in B\'s list');
    }
  });
});

// ---------------------------------------------------------------------------
// #7 — HTTP /v1/label-queue/submit blocks cross-tenant labels with 403.
// ---------------------------------------------------------------------------
test('W411-T #7 — HTTP /v1/label-queue/submit returns 403 cross-tenant', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  const { app, A, B } = await _makeAppTwoTenants();
  const bIds = await _seed(B.id, 'ns_lq', 3);

  await _withServer(app, async (base) => {
    // Tenant A attempts to label one of B's events.
    const attempt = await fetch(base + '/v1/label-queue/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A.api_key },
      body: JSON.stringify({ event_id: bIds[0], label: 'accept' }),
    });
    assert.equal(attempt.status, 403, 'cross-tenant label POST returns 403');
    const body = await attempt.json();
    assert.equal(body.error, 'cross_tenant_label_forbidden');
  });
});

// ---------------------------------------------------------------------------
// #8 — /v1/lake/storage reports a tenant-scoped total_events count: tenant A
//      should NOT see B's row count surfaced as its own.
// ---------------------------------------------------------------------------
test('W411-T #8 — /v1/lake/storage total_events is tenant-scoped', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  const { app, A, B } = await _makeAppTwoTenants();
  await _seed(A.id, 'ns_storage', 4);
  await _seed(B.id, 'ns_storage', 7);

  await _withServer(app, async (base) => {
    const sA = await fetch(base + '/v1/lake/storage', { headers: { authorization: 'Bearer ' + A.api_key } });
    const aBody = await sA.json();
    assert.equal(aBody.total_events, 4, 'tenant A sees only its 4 rows');

    const sB = await fetch(base + '/v1/lake/storage', { headers: { authorization: 'Bearer ' + B.api_key } });
    const bBody = await sB.json();
    assert.equal(bBody.total_events, 7, 'tenant B sees only its 7 rows');
  });
});
