// W991 - calibrated meets-bar routing.
//
// Closes the llm-routing frontier gap: route decisions can now use a
// conservative per-request quality prediction and select the cheapest candidate
// whose lower confidence bound clears a calibrated quality bar.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ClusterRouterStats,
  buildRouterDecisionBlock,
  predictRouteQuality,
  scoreRoute,
} from '../src/semantic-router.js';
import { DIMENSIONS } from '../src/embedding.js';

let tmp;
let prev;
let routeQuality;
let routeTraining;
let store;
let eventStore;

function unitVec(dim) {
  const v = new Array(DIMENSIONS).fill(0);
  v[dim] = 1;
  return v;
}

function statsForQualityBar({
  cheapWins,
  cheapN,
  cheapCost = 0.001,
  expensiveWins,
  expensiveN,
  expensiveCost = 0.05,
} = {}) {
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  for (let i = 0; i < cheapN; i += 1) {
    stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: i < cheapWins, cost_usd: cheapCost, latency_ms: 40 });
  }
  for (let i = 0; i < expensiveN; i += 1) {
    stats.update({ clusterId: 0, model: 'claude-opus-4-7', won: i < expensiveWins, cost_usd: expensiveCost, latency_ms: 180 });
  }
  const stub = Object.assign(Object.create(ClusterRouterStats.prototype), stats);
  stub.topPClusters = () => [0];
  return stub;
}

const CFG = {
  route_mode: 'semantic',
  primary: 'openai:gpt-4o-mini',
  fallback: ['anthropic:claude-opus-4-7'],
  route_quality_bar_policy: {
    enabled: true,
    mode: 'meets_bar',
    bar: 0.8,
    confidence_z: 1.96,
    min_samples: 20,
  },
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w991-quality-bar-'));
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

  routeQuality = await import('../src/route-quality-store.js');
  routeTraining = await import('../src/route-training.js');
  store = await import('../src/store.js');
  eventStore = await import('../src/event-store.js');
});

beforeEach(() => {
  if (store) store.remove(routeTraining.ROUTE_NAMESPACE_TABLE, () => true);
  if (eventStore && typeof eventStore._resetForTests === 'function') eventStore._resetForTests();
  if (routeTraining) routeTraining.clearRouteStatsCacheForTests();
});

after(() => {
  if (routeTraining) routeTraining.clearRouteStatsCacheForTests();
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

test('1. predictRouteQuality exposes a conservative lower confidence bound', () => {
  const thin = predictRouteQuality({ wins: 17, n: 20, confidence_z: 1.96 });
  assert.equal(thin.empirical_quality, 0.85);
  assert.ok(thin.predicted_quality_lcb < 0.8, thin.predicted_quality_lcb);

  const thick = predictRouteQuality({ wins: 95, n: 100, confidence_z: 1.96 });
  assert.ok(thick.predicted_quality_lcb >= 0.8, thick.predicted_quality_lcb);
});

test('2. quality_bar mode rejects a cheap raw-accurate model whose lower bound misses the bar', () => {
  const stats = statsForQualityBar({
    cheapWins: 17,
    cheapN: 20,
    expensiveWins: 95,
    expensiveN: 100,
  });
  const out = scoreRoute({ namespaceConfig: CFG, prompt: 'x', stats });

  assert.equal(out.reason, 'quality_bar_reorder');
  assert.equal(out.chosen.provider, 'anthropic');
  assert.equal(out.chosen.model, 'claude-opus-4-7');
  const cheap = out.quality_bar.candidates.find((c) => c.model === 'gpt-4o-mini');
  assert.equal(cheap.meets_quality_bar, false);
  assert.ok(cheap.predicted_quality_lcb < out.quality_bar.effective_bar);
  assert.equal(out.rejected.find((r) => r.model === 'gpt-4o-mini').reason, 'predicted_quality_below_bar');

  const block = buildRouterDecisionBlock({ scored: out });
  assert.equal(block.route_mode, 'quality_bar');
  assert.equal(block.quality_bar.selection, 'cheapest_meeting_quality_bar');
});

test('3. quality_bar mode picks the cheapest candidate once both predictions clear the bar', () => {
  const stats = statsForQualityBar({
    cheapWins: 96,
    cheapN: 100,
    expensiveWins: 100,
    expensiveN: 100,
  });
  const out = scoreRoute({
    namespaceConfig: {
      ...CFG,
      route_quality_bar_policy: { ...CFG.route_quality_bar_policy, bar: 0.85, confidence_z: 1.281552 },
    },
    prompt: 'x',
    stats,
  });

  assert.equal(out.reason, 'quality_bar_reorder');
  assert.equal(out.chosen.provider, 'openai');
  assert.equal(out.chosen.model, 'gpt-4o-mini');
  assert.equal(out.quality_bar.selection, 'cheapest_meeting_quality_bar');
});

test('4. calibrateQualityBar derives a holdout false-accept margin from route outcomes', async () => {
  const tenant = 'tenant_w991_cal';
  const namespace = 'support';
  for (let i = 0; i < 6; i += 1) {
    await routeQuality.recordRouteOutcome({
      tenant,
      namespace,
      cluster_id: 0,
      model: 'gpt-4o-mini',
      provider: 'openai',
      prompt_text: 'support route ' + i,
      realized_quality: i < 4 ? 0.95 : 0.2,
      cost: 0.001,
      latency_ms: 40,
      now: 1_700_000_000_000 + i,
    });
  }

  const calibration = await routeQuality.calibrateQualityBar({
    tenant,
    namespace,
    quality_bar: 0.8,
    min_train_samples: 4,
    min_holdout_samples: 2,
    holdout_fraction: 0.25,
  });

  assert.equal(calibration.version, routeQuality.ROUTE_QUALITY_BAR_CALIBRATION_VERSION);
  assert.equal(calibration.groups_evaluated, 1);
  assert.equal(calibration.false_accepts, 1);
  assert.equal(calibration.calibrated_bar, 1);
  assert.ok(calibration.calibration_margin > 0);
});

test('5. promoted route snapshots persist reusable quality-bar policy metadata', async () => {
  const tenant = 'tenant_w991_persist';
  const namespace = 'support';
  const calibration = {
    version: routeQuality.ROUTE_QUALITY_BAR_CALIBRATION_VERSION,
    quality_bar: 0.8,
    calibrated_bar: 0.9,
    calibration_margin: 0.1,
    confidence_z: 1.281552,
    min_train_samples: 4,
    groups_evaluated: 3,
  };
  await routeTraining.persistRouteTrainingSnapshot({
    tenant,
    namespace,
    snapshot: {
      version: 'snap-w991',
      k: 1,
      dim: DIMENSIONS,
      centroids: [unitVec(0)],
      counts: [8],
      stats: {},
    },
    route_quality_bar_calibration: calibration,
    activate: true,
  });

  const row = store.findByTenant(routeTraining.ROUTE_NAMESPACE_TABLE, tenant)[0];
  assert.equal(row.route_quality_bar_calibration.version, routeQuality.ROUTE_QUALITY_BAR_CALIBRATION_VERSION);
  assert.equal(row.route_quality_bar_policy.enabled, true);
  assert.equal(row.route_quality_bar_policy.mode, 'meets_bar');
  assert.equal(row.route_quality_bar_policy.calibrated_bar, 0.9);
});
