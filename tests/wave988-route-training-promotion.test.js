// W988 - route-training promotion policy, due scheduler, and rollback.
//
// W608 made route snapshots trainable and live-loadable. This file locks the
// next production control-plane step: scheduled retrain planning, fail-closed
// promotion gates, one-slot rollback, and CLI exposure.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let tmp;
let prev;
let routeTraining;
let routeQuality;
let store;
let eventStore;

function unitVec(i, dim = 8) {
  const v = new Array(dim).fill(0);
  v[i] = 1;
  return v;
}

function snapshot({ version = 'snap-v1', counts = [1], route_quality_outcomes = 0 } = {}) {
  return {
    version,
    k: 1,
    dim: 8,
    centroids: [unitVec(0)],
    counts,
    stats: {},
    route_quality_outcomes,
    trained_at: '2026-01-01T00:00:00.000Z',
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w988-route-'));
  prev = {
    data: process.env.KOLM_DATA_DIR,
    home: process.env.HOME,
    user: process.env.USERPROFILE,
    storePath: process.env.KOLM_EVENT_STORE_PATH,
    cacheMs: process.env.KOLM_ROUTE_STATS_CACHE_MS,
  };
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ROUTE_STATS_CACHE_MS = '0';
  delete process.env.KOLM_EVENT_STORE_PATH;

  routeTraining = await import('../src/route-training.js');
  routeQuality = await import('../src/route-quality-store.js');
  store = await import('../src/store.js');
  eventStore = await import('../src/event-store.js');
});

beforeEach(() => {
  routeTraining.clearRouteStatsCacheForTests();
  store.remove(routeTraining.ROUTE_NAMESPACE_TABLE, () => true);
  if (eventStore && typeof eventStore._resetForTests === 'function') eventStore._resetForTests();
});

after(() => {
  routeTraining.clearRouteStatsCacheForTests();
  if (eventStore && typeof eventStore._resetForTests === 'function') {
    try { eventStore._resetForTests(); } catch {}
  }
  if (prev.data === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prev.data;
  if (prev.home === undefined) delete process.env.HOME; else process.env.HOME = prev.home;
  if (prev.user === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.user;
  if (prev.storePath === undefined) delete process.env.KOLM_EVENT_STORE_PATH; else process.env.KOLM_EVENT_STORE_PATH = prev.storePath;
  if (prev.cacheMs === undefined) delete process.env.KOLM_ROUTE_STATS_CACHE_MS; else process.env.KOLM_ROUTE_STATS_CACHE_MS = prev.cacheMs;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('1. retrain policy planning is deterministic and fail-closed', () => {
  const cfg = {
    route_stats_snapshot: snapshot({ route_quality_outcomes: 5 }),
    route_stats_trained_at: '2026-01-01T00:00:00.000Z',
    route_quality_outcomes: 5,
  };
  const policy = {
    min_interval_ms: 1000,
    max_snapshot_age_ms: 10_000,
    min_new_quality_outcomes: 2,
  };

  const early = routeTraining.planRouteRetrain({
    namespaceConfig: cfg,
    policy,
    latest_route_quality_outcomes: 99,
    now: '2026-01-01T00:00:00.500Z',
  });
  assert.equal(early.due, false);
  assert.equal(early.reason, 'cadence_not_due');

  const thinDelta = routeTraining.planRouteRetrain({
    namespaceConfig: cfg,
    policy,
    latest_route_quality_outcomes: 6,
    now: '2026-01-01T00:00:02.000Z',
  });
  assert.equal(thinDelta.due, false);
  assert.equal(thinDelta.reason, 'quality_delta_not_met');

  const enoughDelta = routeTraining.planRouteRetrain({
    namespaceConfig: cfg,
    policy,
    latest_route_quality_outcomes: 7,
    now: '2026-01-01T00:00:02.000Z',
  });
  assert.equal(enoughDelta.due, true);
  assert.equal(enoughDelta.reason, 'new_quality_outcomes_ready');

  const stale = routeTraining.planRouteRetrain({
    namespaceConfig: cfg,
    policy,
    latest_route_quality_outcomes: 5,
    now: '2026-01-01T00:00:11.000Z',
  });
  assert.equal(stale.due, true);
  assert.equal(stale.reason, 'snapshot_stale');
});

test('2. promotion gates reject weak candidates and promote covered snapshots', () => {
  const weak = routeTraining.evaluateRouteSnapshotPromotion({
    candidate: {
      ok: true,
      trained_rows: 2,
      route_quality_outcomes: 1,
      route_weights: { quality: 0.1 },
      snapshot: snapshot({ counts: [2], route_quality_outcomes: 1 }),
    },
    policy: {
      min_trained_rows: 4,
      min_route_quality_outcomes: 2,
      min_route_weight_signals: 1,
      min_cluster_model_cells: 1,
    },
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(weak.promote, false);
  assert.equal(weak.reason, 'insufficient_training_rows');

  const strongSnapshot = snapshot({ version: 'snap-v2', counts: [8], route_quality_outcomes: 4 });
  strongSnapshot.stats = { 0: { 'gpt-4o-mini': { n: 4, wins: 4, sum_cost: 0.004, sum_latency: 160 } } };
  const strong = routeTraining.evaluateRouteSnapshotPromotion({
    candidate: {
      ok: true,
      trained_rows: 8,
      route_quality_outcomes: 4,
      route_weights: { quality: 0.1 },
      snapshot: strongSnapshot,
    },
    namespaceConfig: { route_quality_outcomes: 2 },
    policy: {
      min_trained_rows: 4,
      min_route_quality_outcomes: 2,
      min_route_weight_signals: 1,
      min_cluster_model_cells: 1,
    },
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(strong.promote, true);
  assert.equal(strong.reason, 'promotion_gates_passed');
  assert.equal(strong.metrics.route_quality_outcome_delta, 2);
});

test('3. persist creates a rollback slot and rollback restores the previous route snapshot', async () => {
  const tenant = 'tenant_w988_rollback';
  const ns = 'support';
  const first = snapshot({ version: 'snap-v1', counts: [2], route_quality_outcomes: 2 });
  const second = snapshot({ version: 'snap-v2', counts: [4], route_quality_outcomes: 4 });
  await routeTraining.persistRouteTrainingSnapshot({
    tenant,
    namespace: ns,
    snapshot: first,
    route_weights: { quality: 0.1 },
    activate: true,
    now: '2026-01-01T00:00:00.000Z',
  });
  const promotion = routeTraining.evaluateRouteSnapshotPromotion({
    candidate: {
      ok: true,
      trained_rows: 4,
      route_quality_outcomes: 4,
      route_weights: { quality: 0.2 },
      snapshot: second,
    },
    namespaceConfig: { route_stats_snapshot: first, route_quality_outcomes: 2 },
    policy: {
      min_trained_rows: 1,
      min_route_quality_outcomes: 1,
      min_route_weight_signals: 1,
      min_cluster_model_cells: 0,
    },
    now: '2026-01-02T00:00:00.000Z',
  });
  const saved = await routeTraining.persistRouteTrainingSnapshot({
    tenant,
    namespace: ns,
    snapshot: second,
    route_weights: { quality: 0.2 },
    activate: true,
    promotion,
    policy: promotion.policy,
    now: '2026-01-02T00:00:00.000Z',
  });

  assert.equal(saved.route_stats_snapshot.version, 'snap-v2');
  assert.equal(saved.route_stats_previous_snapshot.version, 'snap-v1');
  assert.equal(saved.route_training_rollback_available, true);
  assert.equal(saved.route_training_promotion.reason, 'promotion_gates_passed');

  const rolled = await routeTraining.rollbackRouteTrainingSnapshot({
    tenant,
    namespace: ns,
    reason: 'regression_detected',
    now: '2026-01-03T00:00:00.000Z',
  });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.row.route_stats_snapshot.version, 'snap-v1');
  assert.equal(rolled.row.route_training_rollback_available, false);
  assert.equal(rolled.row.route_training_rollback.reason, 'regression_detected');
});

test('4. scheduler scans due namespaces and persists promoted retrain snapshots', async () => {
  const tenant = 'tenant_w988_sched';
  const ns = 'support';
  store.insert(routeTraining.ROUTE_NAMESPACE_TABLE, {
    id: 'ns_sched',
    tenant,
    slug: ns,
    status: 'active',
    route_mode: 'cost_quality',
    route_stats_snapshot: snapshot({ version: 'old', counts: [1], route_quality_outcomes: 0 }),
    route_stats_trained_at: '2026-01-01T00:00:00.000Z',
    route_quality_outcomes: 0,
  });

  for (let i = 0; i < 4; i += 1) {
    await routeQuality.recordRouteOutcome({
      tenant,
      namespace: ns,
      cluster_id: 0,
      model: i % 2 === 0 ? 'gpt-4o-mini' : 'claude-opus-4-7',
      provider: i % 2 === 0 ? 'openai' : 'anthropic',
      prompt_text: 'routing retrain prompt ' + i,
      realized_quality: i % 2 === 0 ? 0.85 : 0.95,
      cost: i % 2 === 0 ? 0.001 : 0.05,
      latency_ms: i % 2 === 0 ? 45 : 180,
      now: 1_700_000_000_000 + i,
    });
  }

  const out = await routeTraining.runDueRouteRetraining({
    tenant,
    k: 1,
    max_rows: 100,
    now: '2026-01-02T00:00:00.000Z',
    policy: {
      min_interval_ms: 0,
      min_trained_rows: 1,
      min_route_quality_outcomes: 1,
      min_new_quality_outcomes: 1,
      min_route_weight_signals: 1,
      min_cluster_model_cells: 1,
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.scanned, 1);
  assert.equal(out.due, 1);
  assert.equal(out.promoted, 1);
  assert.equal(out.persisted, 1);

  const row = store.findByTenant(routeTraining.ROUTE_NAMESPACE_TABLE, tenant)[0];
  assert.equal(row.route_training_promotion.reason, 'promotion_gates_passed');
  assert.equal(row.route_training_rollback_available, true);
  assert.equal(row.route_stats_previous_snapshot.version, 'old');
});

test('5. route CLI exposes promote, scheduler, and rollback commands', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(src, /sub === 'retrain'/);
  assert.match(src, /cmdRouteRetrain/);
  assert.match(src, /runDueRouteRetraining\(\{/);
  assert.match(src, /sub === 'rollback'/);
  assert.match(src, /cmdRouteRollback/);
  assert.match(src, /rollbackRouteTrainingSnapshot\(\{/);
  assert.match(src, /--promote/);
});
