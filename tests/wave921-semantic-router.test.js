// W921 — semantic-router unit tests (node:test).
//
// Mirrors the spec's test_plan. Pure-unit: never hits the live HTTP dispatch
// path (that wiring lands in the router lane), so these exercise the module's
// public surface directly. The event-store-backed trainClustersFromLake test
// runs against a temp KOLM_DATA_DIR sandbox.
//
// Coverage:
//   #1  ClusterRouterStats.assign deterministic for fixed centroids
//   #2  update() accumulates; scoreModel min-max / x formula for alpha=0,.5,1
//   #3  scoreRoute cold-start (n<min_samples) -> cold_start:true + static order
//   #4  cheaper model wins on a quality tie
//   #5  min_quality floor: low-accuracy cheap model not placed first
//   #6  callerConfidence override still wins
//   #7  reorderChainByScore never empties / keeps the only viable provider
//   #8  estimateModelCost prices known model, 0 for unknown (treated as unknown)
//   #9  snapshot()/restore() round-trips centroids + stats
//   #10 buildRouterDecisionBlock shape
//   #11 trainClustersFromLake over a temp lake produces usable stats
//   #12 route_mode unset -> static (regression guard)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scoreRoute,
  ClusterRouterStats,
  trainClustersFromLake,
  reorderChainByScore,
  estimateModelCost,
  buildRouterDecisionBlock,
  modelKey,
  EMBEDDER_ID,
  SEMANTIC_ROUTER_VERSION,
} from '../src/semantic-router.js';
import { embed, DIMENSIONS } from '../src/embedding.js';

// A pair of well-separated unit centroids in DIM space so assign() is
// unambiguous and deterministic.
function fixedCentroids() {
  const a = new Array(DIMENSIONS).fill(0); a[0] = 1; // points at dim 0
  const b = new Array(DIMENSIONS).fill(0); b[1] = 1; // points at dim 1
  return [a, b];
}
function unitVec(dim) {
  const v = new Array(DIMENSIONS).fill(0);
  v[dim] = 1;
  return v;
}

// -------------------------------------------------------------------------
// #1 assign deterministic for fixed centroids
// -------------------------------------------------------------------------
test('#1 ClusterRouterStats.assign is deterministic for fixed centroids', () => {
  const s = new ClusterRouterStats({ k: 2, centroids: fixedCentroids() });
  assert.equal(s.assign(unitVec(0)), 0);
  assert.equal(s.assign(unitVec(1)), 1);
  // Repeated calls are stable.
  assert.equal(s.assign(unitVec(0)), 0);
  // topPClusters returns nearest-first.
  assert.deepEqual(s.topPClusters(unitVec(1), 2), [1, 0]);
  // Untrained shell -> assign -1, topP [].
  const empty = new ClusterRouterStats({ k: 2 });
  assert.equal(empty.assign(unitVec(0)), -1);
  assert.deepEqual(empty.topPClusters(unitVec(0), 4), []);
});

// -------------------------------------------------------------------------
// #2 update() accumulates; scoreModel formula across alpha
// -------------------------------------------------------------------------
test('#2 update accumulates and scoreModel applies x = alpha*q + (1-alpha)*(1-cost)', () => {
  const s = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  // 8 wins / 10 -> accuracy 0.8, total cost 1.0 over 10 -> avg_cost 0.1.
  for (let i = 0; i < 10; i++) {
    s.update({ clusterId: 0, model: 'm', won: i < 8, cost_usd: 0.1, latency_ms: 100 });
  }
  const at1 = s.scoreModel({ clusterId: 0, model: 'm', alpha: 1 });
  assert.equal(at1.n, 10);
  assert.ok(Math.abs(at1.quality_norm - 0.8) < 1e-9);
  // alpha=1 -> x == quality_norm (cost term dropped).
  assert.ok(Math.abs(at1.x - 0.8) < 1e-9);

  const at0 = s.scoreModel({ clusterId: 0, model: 'm', alpha: 0 });
  // alpha=0 -> x == (1 - avg_cost) == 1 - 0.1 == 0.9.
  assert.ok(Math.abs(at0.x - 0.9) < 1e-9);

  const half = s.scoreModel({ clusterId: 0, model: 'm', alpha: 0.5 });
  // 0.5*0.8 + 0.5*(1-0.1) = 0.4 + 0.45 = 0.85.
  assert.ok(Math.abs(half.x - 0.85) < 1e-9);
});

// -------------------------------------------------------------------------
// #3 cold-start: n < min_samples -> static chain + cold_start:true
// -------------------------------------------------------------------------
test('#3 scoreRoute cold-start reverts to static chain when below min_samples', () => {
  const cfg = {
    route_mode: 'cost_quality',
    primary: 'anthropic:claude-opus-4-7',
    fallback: ['openai:gpt-4o-mini'],
  };
  // Trained stats but only a handful of samples in the cluster.
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  for (let i = 0; i < 3; i++) stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.001, latency_ms: 50 });

  const out = scoreRoute({ namespaceConfig: cfg, prompt: 'hello world', stats, opts: { min_samples: 20 } });
  assert.equal(out.cold_start, true);
  // Static order = primary first.
  assert.equal(out.ordered_chain[0].provider, 'anthropic');
  assert.equal(out.chosen.provider, 'anthropic');
});

// -------------------------------------------------------------------------
// #4 cheaper model wins on a quality tie
// -------------------------------------------------------------------------
test('#4 cheaper model wins on a quality tie', () => {
  const cfg = {
    route_mode: 'cost_quality',
    // Expensive primary, cheap fallback.
    primary: 'anthropic:claude-opus-4-7',     // input 0.015 / output 0.075
    fallback: ['openai:gpt-4o-mini'],          // input 0.00015 / output 0.0006
  };
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  // Same high accuracy for BOTH models so quality ties; cost decides.
  for (let i = 0; i < 25; i++) {
    stats.update({ clusterId: 0, model: 'claude-opus-4-7', won: true, cost_usd: 0.5, latency_ms: 100 });
    stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.005, latency_ms: 100 });
  }
  // Force the prompt to land in cluster 0.
  const prompt = 'x';
  const stub = Object.assign(Object.create(ClusterRouterStats.prototype), stats);
  stub.topPClusters = () => [0];
  const out = scoreRoute({ namespaceConfig: cfg, prompt, stats: stub, opts: { alpha: 0.5, min_samples: 20 } });
  assert.equal(out.cold_start, false);
  // Cheaper gpt-4o-mini should lead despite the opus primary.
  assert.equal(out.chosen.model, 'gpt-4o-mini');
  assert.ok(out.rejected.some((r) => r.model === 'claude-opus-4-7'));
});

// -------------------------------------------------------------------------
// #5 min_quality floor: a cheap low-accuracy model is not placed first
// -------------------------------------------------------------------------
test('#5 min_quality floor blocks a low-accuracy cheap model from the head', () => {
  const cfg = {
    route_mode: 'cost_quality',
    primary: 'anthropic:claude-opus-4-7',
    fallback: ['openai:gpt-4o-mini'],
  };
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  // opus: high accuracy 0.95, expensive. mini: accuracy 0.3 (below 0.8 floor), cheap.
  for (let i = 0; i < 40; i++) {
    stats.update({ clusterId: 0, model: 'claude-opus-4-7', won: i < 38, cost_usd: 0.5, latency_ms: 100 });
    stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: i < 12, cost_usd: 0.005, latency_ms: 100 });
  }
  const stub = Object.assign(Object.create(ClusterRouterStats.prototype), stats);
  stub.topPClusters = () => [0];
  const out = scoreRoute({ namespaceConfig: cfg, prompt: 'x', stats: stub, opts: { alpha: 0.3, min_quality: 0.8, min_samples: 20 } });
  // Despite being far cheaper, the sub-floor model must NOT lead.
  assert.notEqual(out.chosen.model, 'gpt-4o-mini');
  assert.equal(out.chosen.model, 'claude-opus-4-7');
  const rej = out.rejected.find((r) => r.model === 'gpt-4o-mini');
  assert.equal(rej.reason, 'below_quality_floor');
  // The low-quality model is still in the chain (never dropped).
  assert.ok(out.ordered_chain.some((e) => e.model === 'gpt-4o-mini'));
});

// -------------------------------------------------------------------------
// #6 caller confidence override still wins
// -------------------------------------------------------------------------
test('#6 callerConfidence override short-circuits the learned score', () => {
  const cfg = {
    route_mode: 'cost_quality',
    primary: 'local:trinity-500',
    fallback: ['openai:gpt-4o-mini'],
    confidence_threshold: 0.7,
  };
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  for (let i = 0; i < 30; i++) stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.005, latency_ms: 50 });
  // Low confidence -> caller forces frontier fallback first.
  const out = scoreRoute({ namespaceConfig: cfg, prompt: 'x', stats, callerConfidence: 0.2 });
  assert.equal(out.reason, 'caller_confidence_override');
  assert.equal(out.route_decision, 'frontier');
  // High confidence with a local primary -> stays static local primary.
  const out2 = scoreRoute({ namespaceConfig: cfg, prompt: 'x', stats, callerConfidence: 0.95 });
  assert.equal(out2.reason, 'caller_confidence_override');
  assert.equal(out2.cold_start, true);
});

// -------------------------------------------------------------------------
// #7 reorderChainByScore never empties / keeps the only viable provider
// -------------------------------------------------------------------------
test('#7 reorderChainByScore never empties and keeps unscored entries', () => {
  const chain = [
    { provider: 'anthropic', model: 'claude-opus-4-7', route_decision: 'frontier' },
    { provider: 'openai', model: 'gpt-4o-mini', route_decision: 'frontier' },
  ];
  // Score only the second one higher -> it moves to front.
  const scores = { [modelKey('openai', 'gpt-4o-mini')]: 0.9, [modelKey('anthropic', 'claude-opus-4-7')]: 0.1 };
  const out = reorderChainByScore(chain, scores, {});
  assert.equal(out.length, 2);
  assert.equal(out[0].model, 'gpt-4o-mini');
  // Empty / single chain safety.
  assert.deepEqual(reorderChainByScore([], scores, {}), []);
  const single = [{ provider: 'openai', model: 'gpt-4o' }];
  assert.equal(reorderChainByScore(single, {}, {}).length, 1);
  // No scores at all -> original order preserved.
  const unsc = reorderChainByScore(chain, {}, {});
  assert.equal(unsc[0].model, 'claude-opus-4-7');
});

// -------------------------------------------------------------------------
// #8 estimateModelCost prices a known model, 0 for unknown
// -------------------------------------------------------------------------
test('#8 estimateModelCost prices known model and returns 0 (unknown) otherwise', () => {
  const known = estimateModelCost({ provider: 'openai', model: 'gpt-4o-mini', est_input_tokens: 1000, est_output_tokens: 1000 });
  // 1000/1000 * (0.00015 + 0.0006) = 0.00075.
  assert.ok(known > 0);
  assert.ok(Math.abs(known - 0.00075) < 1e-9);
  const unknown = estimateModelCost({ provider: 'openai', model: 'does-not-exist', est_input_tokens: 1000, est_output_tokens: 1000 });
  assert.equal(unknown, 0);
  const noProvider = estimateModelCost({ provider: 'nope', model: 'x', est_input_tokens: 100, est_output_tokens: 100 });
  assert.equal(noProvider, 0);
});

// -------------------------------------------------------------------------
// #9 snapshot()/restore() round-trips
// -------------------------------------------------------------------------
test('#9 ClusterRouterStats snapshot/restore round-trips centroids + stats', () => {
  const s = new ClusterRouterStats({ k: 2, centroids: fixedCentroids() });
  for (let i = 0; i < 5; i++) s.update({ clusterId: 0, model: 'm', won: true, cost_usd: 0.01, latency_ms: 20 });
  const snap = s.snapshot();
  assert.equal(snap.version, SEMANTIC_ROUTER_VERSION);
  assert.equal(snap.embedder, EMBEDDER_ID);
  // Survives JSON serialization.
  const round = ClusterRouterStats.restore(JSON.parse(JSON.stringify(snap)));
  assert.equal(round.assign(unitVec(0)), 0);
  const sm = round.scoreModel({ clusterId: 0, model: 'm', alpha: 1 });
  assert.equal(sm.n, 5);
  assert.ok(Math.abs(sm.quality_norm - 1) < 1e-9);
});

// -------------------------------------------------------------------------
// #10 buildRouterDecisionBlock shape
// -------------------------------------------------------------------------
test('#10 buildRouterDecisionBlock produces the non-signed receipt block', () => {
  const scored = {
    route_score: 0.85,
    alpha: 0.5,
    chosen: { provider: 'openai', model: 'gpt-4o-mini' },
    rejected: [{ provider: 'anthropic', model: 'claude-opus-4-7', score: 0.4, reason: 'lower_route_score' }],
    cluster_id: 3,
    n_samples: 42,
    embedder: EMBEDDER_ID,
    cold_start: false,
    reason: 'cost_quality_reorder',
  };
  const block = buildRouterDecisionBlock({ scored, alpha: 0.5, beta: 0, cluster_id: 3, n_samples: 42, embedder: EMBEDDER_ID, cold_start: false });
  assert.equal(block.route_mode, 'cost_quality');
  assert.equal(block.route_score, 0.85);
  assert.equal(block.alpha, 0.5);
  assert.equal(block.cluster_id, 3);
  assert.equal(block.n_samples, 42);
  assert.equal(block.cold_start, false);
  assert.equal(block.rejected.length, 1);
  // Cold-start block reports route_mode static.
  const cold = buildRouterDecisionBlock({ scored: { ...scored, cold_start: true }, cold_start: true });
  assert.equal(cold.route_mode, 'static');
});

// -------------------------------------------------------------------------
// #11 trainClustersFromLake over a temp lake
// -------------------------------------------------------------------------
test('#11 trainClustersFromLake builds usable stats from lake observation rows', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-router-'));
  const prevData = process.env.KOLM_DATA_DIR;
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  const prevStorePath = process.env.KOLM_EVENT_STORE_PATH;
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.KOLM_EVENT_STORE_PATH;
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (typeof _resetForTests === 'function') _resetForTests();
    // Seed a handful of observation rows across two distinct prompt families.
    for (let i = 0; i < 12; i++) {
      await appendEvent({
        tenant_id: 'tenant_w921',
        namespace: 'support',
        provider: i % 2 === 0 ? 'openai' : 'anthropic',
        model: i % 2 === 0 ? 'gpt-4o-mini' : 'claude-opus-4-7',
        prompt_redacted: i % 2 === 0 ? 'reset my password please' : 'explain quantum chromodynamics in depth',
        estimated_cost_usd: i % 2 === 0 ? 0.001 : 0.05,
        latency_ms: i % 2 === 0 ? 40 : 200,
        status: 'ok',
        accepted: true,
      });
    }
    const stats = await trainClustersFromLake({ tenant: 'tenant_w921', namespace: 'support', k: 4 });
    assert.ok(stats instanceof ClusterRouterStats);
    assert.ok(Array.isArray(stats.centroids) && stats.centroids.length >= 1);
    // Some cluster must have recorded outcomes for at least one model.
    let totalN = 0;
    for (const byModel of stats.stats.values()) {
      for (const cell of byModel.values()) totalN += cell.n;
    }
    assert.equal(totalN, 12);
    // Embedding a known prompt assigns to a real cluster.
    const cid = stats.assign(embed('reset my password please'));
    assert.ok(cid >= 0);
  } finally {
    if (prevData === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prevData;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    if (prevStorePath !== undefined) process.env.KOLM_EVENT_STORE_PATH = prevStorePath;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// -------------------------------------------------------------------------
// #12 route_mode unset -> static (regression guard)
// -------------------------------------------------------------------------
test('#12 route_mode unset returns static chain unchanged', () => {
  const cfg = { primary: 'anthropic:claude-opus-4-7', fallback: ['openai:gpt-4o-mini'] };
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  for (let i = 0; i < 50; i++) stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.001, latency_ms: 30 });
  const out = scoreRoute({ namespaceConfig: cfg, prompt: 'anything', stats });
  assert.equal(out.reason, 'route_mode_static');
  assert.equal(out.cold_start, true);
  // Static order preserved: primary opus first.
  assert.equal(out.ordered_chain[0].provider, 'anthropic');
  assert.equal(out.ordered_chain[1].provider, 'openai');
});
