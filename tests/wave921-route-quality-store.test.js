// W921 NEXT-6 — route-quality-store unit tests (node:test).
//
// Locks in the contract that lets src/semantic-router.js's QUALITY term be
// TRAINED instead of cold-started: realized per-(cluster,model) outcomes are
// persisted via the event-store and read back in the exact shape
// ClusterRouterStats consumes.
//
// Every test that touches the store runs against an ISOLATED KOLM_DATA_DIR
// (temp dir + _resetForTests) so it never reads or writes the developer's real
// ~/.kolm lake. The env restore is in a finally block.
//
// Coverage:
//   #1  record -> getClusterQualityStats round-trip (cells + snapshot shape)
//   #2  snapshot.stats is ClusterRouterStats.restore-compatible (real consume)
//   #3  tenant fence: tenant B never sees tenant A's outcomes
//   #4  namespace + model filters restrict the read
//   #5  deterministic: identical corpus -> byte-identical stats across reads
//   #6  realized_quality / win label policy (threshold derive + explicit win)
//   #7  recordRouteOutcome throws on a tenant-less write
//   #8  un-clusterable (cluster_id null/<0) outcomes are not aggregated
//   #9  trainRouteWeights suggests weights only for discriminating signals
//   #10 trainRouteWeights from a precomputed stats object is deterministic
//   #11 cost 0 treated as UNKNOWN (no cost mass) not "free"; node --check parity

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recordRouteOutcome,
  getClusterQualityStats,
  trainRouteWeights,
  ROUTE_QUALITY_PROVIDER,
  ROUTE_QUALITY_KIND,
} from '../src/route-quality-store.js';
import { ClusterRouterStats } from '../src/semantic-router.js';

// ---- isolated event-store sandbox ----------------------------------------
// Mirrors the pattern in tests/wave921-semantic-router.test.js #11: redirect
// KOLM_DATA_DIR + HOME + USERPROFILE to a temp dir, reset the event-store
// module state, run the body, then restore. Returns whatever the body returns.
async function withSandbox(body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-rq-'));
  const prev = {
    data: process.env.KOLM_DATA_DIR,
    home: process.env.HOME,
    user: process.env.USERPROFILE,
    storePath: process.env.KOLM_EVENT_STORE_PATH,
  };
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.KOLM_EVENT_STORE_PATH;
  let es = null;
  try {
    es = await import('../src/event-store.js');
    if (typeof es._resetForTests === 'function') es._resetForTests();
    return await body();
  } finally {
    if (es && typeof es._resetForTests === 'function') {
      try { es._resetForTests(); } catch { /* best effort */ }
    }
    if (prev.data === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prev.data;
    if (prev.home === undefined) delete process.env.HOME; else process.env.HOME = prev.home;
    if (prev.user === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.user;
    if (prev.storePath !== undefined) process.env.KOLM_EVENT_STORE_PATH = prev.storePath;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Seed a deterministic two-model, two-cluster corpus for a tenant. `now` is a
// fixed clock so every row is reproducible.
async function seedCorpus({ tenant, namespace = 'support' }) {
  let ms = 1_700_000_000_000;
  const next = () => (ms += 1000);
  // cluster 0: cheap mini is good ENOUGH (high quality), opus also good but pricey.
  for (let i = 0; i < 10; i++) {
    await recordRouteOutcome({
      tenant, namespace, cluster_id: 0, model: 'gpt-4o-mini', provider: 'openai',
      prompt_text: 'reset my password please', realized_quality: 0.9,
      cost: 0.001, latency_ms: 40, now: next(),
    });
    await recordRouteOutcome({
      tenant, namespace, cluster_id: 0, model: 'claude-opus-4-7', provider: 'anthropic',
      prompt_text: 'reset my password please', realized_quality: 0.92,
      cost: 0.05, latency_ms: 200, now: next(),
    });
  }
  // cluster 1: HARD prompts — mini is weak (low quality), opus strong.
  for (let i = 0; i < 10; i++) {
    await recordRouteOutcome({
      tenant, namespace, cluster_id: 1, model: 'gpt-4o-mini', provider: 'openai',
      prompt_text: 'derive the renormalization group flow', realized_quality: 0.3,
      cost: 0.001, latency_ms: 50, now: next(),
    });
    await recordRouteOutcome({
      tenant, namespace, cluster_id: 1, model: 'claude-opus-4-7', provider: 'anthropic',
      prompt_text: 'derive the renormalization group flow', realized_quality: 0.95,
      cost: 0.05, latency_ms: 220, now: next(),
    });
  }
}

// -------------------------------------------------------------------------
// #1 record -> getClusterQualityStats round-trip
// -------------------------------------------------------------------------
test('#1 record -> getClusterQualityStats round-trips cells + snapshot', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    const cqs = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    assert.equal(cqs.n, 40);
    // cluster 0 cells exist for both models.
    const c0 = cqs.by_cluster_model[0];
    assert.ok(c0 && c0['gpt-4o-mini'] && c0['claude-opus-4-7']);
    assert.equal(c0['gpt-4o-mini'].n, 10);
    // mini in cluster 0 is high quality (0.9) so it wins (>= 0.5 threshold).
    assert.equal(c0['gpt-4o-mini'].wins, 10);
    assert.ok(Math.abs(c0['gpt-4o-mini'].mean_quality - 0.9) < 1e-9);
    assert.ok(Math.abs(c0['gpt-4o-mini'].mean_cost - 0.001) < 1e-9);
    assert.ok(Math.abs(c0['gpt-4o-mini'].mean_latency - 40) < 1e-9);
    // cluster 1: mini is sub-floor (0.3 < 0.5) so it never wins.
    const c1 = cqs.by_cluster_model[1];
    assert.equal(c1['gpt-4o-mini'].wins, 0);
    assert.equal(c1['claude-opus-4-7'].wins, 10);
    // snapshot.stats carries running sums in the restore shape.
    const snap = cqs.snapshot.stats;
    assert.equal(snap[0]['gpt-4o-mini'].n, 10);
    assert.ok(Math.abs(snap[0]['gpt-4o-mini'].sum_cost - 0.01) < 1e-9); // 10 * 0.001
    assert.equal(snap[0]['gpt-4o-mini'].sum_latency, 400); // 10 * 40
  });
});

// -------------------------------------------------------------------------
// #2 snapshot.stats is ClusterRouterStats.restore-compatible (real consume)
// -------------------------------------------------------------------------
test('#2 ClusterRouterStats.restore ingests the snapshot.stats shape', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    const cqs = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    // Build trained centroids separately, then graft the learned quality cells.
    const dim = 8;
    const c0 = new Array(dim).fill(0); c0[0] = 1;
    const c1 = new Array(dim).fill(0); c1[1] = 1;
    const stats = ClusterRouterStats.restore({
      k: 2, dim, centroids: [c0, c1], counts: [20, 20], stats: cqs.snapshot.stats,
    });
    // The router's own _aggregate reads the grafted cells correctly.
    const aggMini0 = stats._aggregate([0], 'gpt-4o-mini');
    assert.equal(aggMini0.n, 10);
    assert.ok(Math.abs(aggMini0.accuracy - 1.0) < 1e-9); // 10/10 wins in cluster 0
    assert.ok(Math.abs(aggMini0.avg_cost - 0.001) < 1e-9);
    assert.ok(Math.abs(aggMini0.avg_latency - 40) < 1e-9);
    // scoreModel produces a finite quality-aware x (the term is now LIT, not cold).
    const sm = stats.scoreModel({ clusterId: 1, model: 'gpt-4o-mini', alpha: 1 });
    assert.ok(Math.abs(sm.quality_norm - 0.0) < 1e-9); // mini lost every hard prompt
    const smOpus = stats.scoreModel({ clusterId: 1, model: 'claude-opus-4-7', alpha: 1 });
    assert.ok(Math.abs(smOpus.quality_norm - 1.0) < 1e-9);
  });
});

// -------------------------------------------------------------------------
// #3 tenant fence: tenant B never sees tenant A's outcomes
// -------------------------------------------------------------------------
test('#3 tenant fence isolates outcomes by tenant', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    await recordRouteOutcome({
      tenant: 'tenant_B', namespace: 'support', cluster_id: 0, model: 'gpt-4o-mini',
      provider: 'openai', realized_quality: 0.1, cost: 0.001, latency_ms: 10, now: 1_700_000_900_000,
    });
    const a = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    const b = await getClusterQualityStats({ tenant: 'tenant_B', namespace: 'support' });
    assert.equal(a.n, 40);
    assert.equal(b.n, 1);
    // Tenant B's single low-quality row never bleeds into A's cluster 0 mini cell.
    assert.equal(a.by_cluster_model[0]['gpt-4o-mini'].wins, 10);
    assert.equal(b.by_cluster_model[0]['gpt-4o-mini'].wins, 0);
    // Empty/absent tenant returns the empty shape (never the whole lake).
    const none = await getClusterQualityStats({ tenant: null, namespace: 'support' });
    assert.equal(none.n, 0);
    assert.deepEqual(none.snapshot.stats, {});
  });
});

// -------------------------------------------------------------------------
// #4 namespace + model filters restrict the read
// -------------------------------------------------------------------------
test('#4 namespace and model filters restrict the read', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    // A second namespace for the same tenant.
    await recordRouteOutcome({
      tenant: 'tenant_A', namespace: 'billing', cluster_id: 0, model: 'gpt-4o-mini',
      provider: 'openai', realized_quality: 0.8, cost: 0.001, latency_ms: 30, now: 1_700_001_000_000,
    });
    const support = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    const billing = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'billing' });
    assert.equal(support.n, 40);
    assert.equal(billing.n, 1);
    // Model whitelist: only the mini cells survive.
    const miniOnly = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support', models: ['gpt-4o-mini'] });
    assert.equal(miniOnly.n, 20); // 10 per cluster
    for (const cid of Object.keys(miniOnly.by_cluster_model)) {
      assert.deepEqual(Object.keys(miniOnly.by_cluster_model[cid]), ['gpt-4o-mini']);
    }
  });
});

// -------------------------------------------------------------------------
// #5 deterministic: identical corpus -> byte-identical stats across reads
// -------------------------------------------------------------------------
test('#5 getClusterQualityStats is deterministic across reads', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    const a = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    const b = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    assert.deepEqual(a, b);
    // JSON round-trip stability (no NaN/undefined that JSON would drop differently).
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// -------------------------------------------------------------------------
// #6 realized_quality / win label policy
// -------------------------------------------------------------------------
test('#6 win label derives from threshold; explicit win overrides; null is no-credit', async () => {
  await withSandbox(async () => {
    const t = 'tenant_W';
    // realized_quality above default 0.5 threshold -> win.
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.7, cost: 0.01, latency_ms: 10, now: 1 });
    // below threshold -> loss.
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.2, cost: 0.01, latency_ms: 10, now: 2 });
    // custom threshold flips a 0.4 into a win.
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.4, win_threshold: 0.3, cost: 0.01, latency_ms: 10, now: 3 });
    // explicit win:true overrides a low realized_quality.
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.1, win: true, cost: 0.01, latency_ms: 10, now: 4 });
    // null realized_quality with no explicit win -> counts toward n, no win.
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: null, cost: 0.01, latency_ms: 10, now: 5 });
    const cqs = await getClusterQualityStats({ tenant: t, namespace: 'ns' });
    const cell = cqs.by_cluster_model[0]['m'];
    assert.equal(cell.n, 5);
    assert.equal(cell.wins, 3); // 0.7, custom-0.4, explicit-true
    // mean_quality averages only the 4 rows that HAD a quality value.
    assert.ok(Math.abs(cell.mean_quality - ((0.7 + 0.2 + 0.4 + 0.1) / 4)) < 1e-9);
  });
});

// -------------------------------------------------------------------------
// #7 recordRouteOutcome throws on a tenant-less write
// -------------------------------------------------------------------------
test('#7 recordRouteOutcome refuses a tenant-less write', async () => {
  await withSandbox(async () => {
    await assert.rejects(
      () => recordRouteOutcome({ namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.9, now: 1 }),
      (err) => err && err.code === 'missing_tenant',
    );
  });
});

// -------------------------------------------------------------------------
// #8 un-clusterable outcomes are not aggregated
// -------------------------------------------------------------------------
test('#8 cluster_id null / negative outcomes are persisted but not aggregated', async () => {
  await withSandbox(async () => {
    const t = 'tenant_U';
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: null, model: 'm', realized_quality: 0.9, cost: 0.01, latency_ms: 10, now: 1 });
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: -1, model: 'm', realized_quality: 0.9, cost: 0.01, latency_ms: 10, now: 2 });
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 3, model: 'm', realized_quality: 0.9, cost: 0.01, latency_ms: 10, now: 3 });
    const cqs = await getClusterQualityStats({ tenant: t, namespace: 'ns' });
    // Only the cluster_id:3 row is aggregatable.
    assert.equal(cqs.n, 1);
    assert.ok(cqs.by_cluster_model[3] && cqs.by_cluster_model[3]['m'].n === 1);
    assert.equal(cqs.by_cluster_model[0], undefined);
  });
});

// -------------------------------------------------------------------------
// #9 trainRouteWeights suggests weights only for discriminating signals
// -------------------------------------------------------------------------
test('#9 trainRouteWeights weights only discriminating signals', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    const out = await trainRouteWeights({ tenant: 'tenant_A', namespace: 'support' });
    // quality discriminates strongly (cluster 1: mini 0 vs opus 1) -> weighted.
    assert.ok(out.route_weights.quality > 0);
    // cost discriminates (mini 0.001 vs opus 0.05) -> weighted.
    assert.ok(out.route_weights.cost > 0);
    // latency discriminates (mini ~45 vs opus ~210) -> weighted.
    assert.ok(out.route_weights.latency > 0);
    // basis is auditable.
    assert.equal(out.basis.n, 40);
    assert.ok(out.basis.quality_spread > 0);
    // A single-model corpus has NO spread -> no weights fabricated.
    const t2 = 'tenant_S';
    for (let i = 0; i < 6; i++) {
      await recordRouteOutcome({ tenant: t2, namespace: 'ns', cluster_id: 0, model: 'only', realized_quality: 0.8, cost: 0.01, latency_ms: 50, now: 100 + i });
    }
    const single = await trainRouteWeights({ tenant: t2, namespace: 'ns' });
    // No discrimination possible (one model) -> quality/cost/latency spreads 0.
    assert.equal(single.basis.quality_spread, 0);
    assert.equal(single.route_weights.cost, undefined);
    assert.equal(single.route_weights.latency, undefined);
  });
});

// -------------------------------------------------------------------------
// #10 trainRouteWeights from a precomputed stats object is deterministic
// -------------------------------------------------------------------------
test('#10 trainRouteWeights from precomputed stats is pure + deterministic', async () => {
  await withSandbox(async () => {
    await seedCorpus({ tenant: 'tenant_A', namespace: 'support' });
    const cqs = await getClusterQualityStats({ tenant: 'tenant_A', namespace: 'support' });
    const a = await trainRouteWeights({ stats: cqs });
    const b = await trainRouteWeights({ stats: cqs });
    assert.deepEqual(a, b);
    // The precomputed-stats path matches the read-then-train path.
    const c = await trainRouteWeights({ tenant: 'tenant_A', namespace: 'support' });
    assert.deepEqual(a.route_weights, c.route_weights);
  });
});

// -------------------------------------------------------------------------
// #11 cost 0 treated as UNKNOWN (no cost mass), provider tag fences rows
// -------------------------------------------------------------------------
test('#11 cost 0 is unknown (no cost mass); rows are fenced by provider tag', async () => {
  await withSandbox(async () => {
    const t = 'tenant_Z';
    // Two outcomes with cost 0 -> mean_cost is null (unknown), never 0 ("free").
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.9, cost: 0, latency_ms: 0, now: 1 });
    await recordRouteOutcome({ tenant: t, namespace: 'ns', cluster_id: 0, model: 'm', realized_quality: 0.9, cost: 0, latency_ms: 0, now: 2 });
    const cqs = await getClusterQualityStats({ tenant: t, namespace: 'ns' });
    const cell = cqs.by_cluster_model[0]['m'];
    assert.equal(cell.n, 2);
    assert.equal(cell.mean_cost, null);     // unknown, not 0
    assert.equal(cell.mean_latency, null);  // unknown, not 0
    assert.equal(cqs.snapshot.stats[0]['m'].sum_cost, 0);
    // The persisted row carries the distinct provider + kind tags.
    const es = await import('../src/event-store.js');
    const rows = await es.listEvents({ tenant_id: t, limit: 0 });
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.provider === ROUTE_QUALITY_PROVIDER));
    const payload = JSON.parse(rows[0].feedback);
    assert.equal(payload.kind, ROUTE_QUALITY_KIND);
  });
});
