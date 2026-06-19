// W921 NEXT-5 — multi-signal weighted routing unit tests (node:test).
//
// Covers the ADDITIVE multi-signal extension to scoreRoute (src/semantic-
// router.js): a weighted blend of quality + cost + latency + load + cluster
// similarity, gated behind namespaceConfig.route_weights (or opts.route_weights).
//
// The non-negotiable contract this file locks in:
//   (A) absent route_weights => BYTE-IDENTICAL to the legacy cost_quality path
//       (same ordered_chain / route_score / reason / no extra fields).
//   (B) the weighted blend ranks candidates correctly per the requested signals
//       (quality-only, cost-heavy, latency, load, per-model similarity).
//   (C) every result is DETERMINISTIC (no clock / RNG; injected latencyFn).
//   (D) the safety contract is preserved in multi-signal mode: quality floor,
//       cold-start/static fallback, chain never emptied, caller-confidence wins.
//
// Pure-unit: never hits the live HTTP dispatch path. Latency is injected via
// opts.latencyFn so the provider-health singleton is never touched.
//
// Coverage map:
//   #1  normalizeRouteWeights: drops 0/neg/NaN/unknown, returns null when empty
//   #2  blendSignals: renormalizes over present signals; absent signal neutral
//   #3  absent route_weights == legacy path (byte-identical decision)
//   #4  quality-only weights -> highest-accuracy model leads
//   #5  cost-heavy weights -> cheaper model leads on a quality tie
//   #6  latency signal (injected latencyFn) -> faster provider leads
//   #7  load signal (passed load map) -> less-loaded provider leads
//   #8  similarity weight can discriminate candidates by model-specific cluster fit
//   #9  quality floor still blocks a sub-floor cheap model from the head
//   #10 deterministic: identical inputs -> identical output across runs
//   #11 buildRouterDecisionBlock carries route_mode 'semantic' + audit fields
//   #12 multi-signal preserves cold-start/static fallback (untrained stats)
//   #13 caller-confidence override still wins even with route_weights present

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreRoute,
  ClusterRouterStats,
  normalizeRouteWeights,
  blendSignals,
  buildRouterDecisionBlock,
  reorderChainByScore,
  modelKey,
  ROUTE_SIGNALS,
  EMBEDDER_ID,
} from '../src/semantic-router.js';
import { DIMENSIONS, embed } from '../src/embedding.js';

// ---- fixtures -------------------------------------------------------------
function unitVec(dim) {
  const v = new Array(DIMENSIONS).fill(0);
  v[dim] = 1;
  return v;
}

// A trained single-cluster stats object with two models. Caller pins the
// cluster via a topPClusters stub so the test is independent of the embedder.
function statsWithTwoModels({
  opusWins = 25, opusN = 25, opusCost = 0.5, opusLat = 200,
  miniWins = 25, miniN = 25, miniCost = 0.005, miniLat = 50,
} = {}) {
  const stats = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  for (let i = 0; i < opusN; i++) {
    stats.update({ clusterId: 0, model: 'claude-opus-4-7', won: i < opusWins, cost_usd: opusCost, latency_ms: opusLat });
  }
  for (let i = 0; i < miniN; i++) {
    stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: i < miniWins, cost_usd: miniCost, latency_ms: miniLat });
  }
  const stub = Object.assign(Object.create(ClusterRouterStats.prototype), stats);
  stub.topPClusters = () => [0];
  return stub;
}

const CFG = {
  route_mode: 'cost_quality',
  primary: 'anthropic:claude-opus-4-7',
  fallback: ['openai:gpt-4o-mini'],
};

// -------------------------------------------------------------------------
// #1 normalizeRouteWeights
// -------------------------------------------------------------------------
test('#1 normalizeRouteWeights drops zero/neg/NaN/unknown keys; null when empty', () => {
  assert.deepEqual(
    normalizeRouteWeights({ quality: 2, cost: 1, latency: 0, load: -3, similarity: NaN, bogus: 5 }),
    { quality: 2, cost: 1 },
  );
  // All non-positive / unknown => null (falls back to legacy path).
  assert.equal(normalizeRouteWeights({ latency: 0, load: -1, nope: 9 }), null);
  assert.equal(normalizeRouteWeights({}), null);
  assert.equal(normalizeRouteWeights(null), null);
  assert.equal(normalizeRouteWeights('x'), null);
  // Only canonical signals survive.
  const out = normalizeRouteWeights({ quality: 1, cost: 1, latency: 1, load: 1, similarity: 1, extra: 1 });
  assert.deepEqual(Object.keys(out).sort(), [...ROUTE_SIGNALS].sort());
});

// -------------------------------------------------------------------------
// #2 blendSignals renormalizes over present signals
// -------------------------------------------------------------------------
test('#2 blendSignals renormalizes weights over present signals only', () => {
  const weights = { quality: 1, cost: 1 };
  const m = new Map([
    ['a:1', { quality: 1.0, cost: 1.0 }],  // both present -> 1.0
    ['b:1', { quality: 0.0, cost: 0.0 }],  // both present -> 0.0
    ['c:1', { quality: 1.0, cost: null }], // only quality present -> 1.0 (renormalized)
    ['d:1', { quality: null, cost: null }],// none present -> neutral 0.5
  ]);
  const out = blendSignals(m, weights);
  assert.ok(Math.abs(out.get('a:1').score - 1.0) < 1e-9);
  assert.ok(Math.abs(out.get('b:1').score - 0.0) < 1e-9);
  // c has only quality=1 with weight 1 => 1*1 / 1 == 1.0 (cost weight dropped).
  assert.ok(Math.abs(out.get('c:1').score - 1.0) < 1e-9);
  // d has no present signal => neutral 0.5.
  assert.ok(Math.abs(out.get('d:1').score - 0.5) < 1e-9);
  // Unequal weights: quality weighted 3x cost.
  const w2 = { quality: 3, cost: 1 };
  const m2 = new Map([['x:1', { quality: 1.0, cost: 0.0 }]]);
  const o2 = blendSignals(m2, w2);
  // (3*1 + 1*0) / (3+1) = 0.75.
  assert.ok(Math.abs(o2.get('x:1').score - 0.75) < 1e-9);
});

// -------------------------------------------------------------------------
// #3 absent route_weights == legacy path (byte-identical)
// -------------------------------------------------------------------------
test('#3 absent route_weights produces the byte-identical legacy decision', () => {
  const stats = statsWithTwoModels();
  const legacy = scoreRoute({ namespaceConfig: CFG, prompt: 'x', stats, opts: { alpha: 0.5, min_samples: 20 } });
  // Same call, no route_weights anywhere -> identical structure.
  assert.equal(legacy.reason, 'cost_quality_reorder');
  assert.equal(legacy.cold_start, false);
  // No multi-signal fields leak into the legacy decision.
  assert.equal(legacy.route_weights, undefined);
  assert.equal(legacy.route_signals, undefined);
  assert.equal(legacy.cluster_similarity, undefined);
  // Re-run is deeply equal (determinism of legacy path unchanged).
  const again = scoreRoute({ namespaceConfig: CFG, prompt: 'x', stats, opts: { alpha: 0.5, min_samples: 20 } });
  assert.deepEqual(again, legacy);
  // route_weights that normalize to null (all zero) ALSO take the legacy path.
  const zeroW = scoreRoute({ namespaceConfig: CFG, prompt: 'x', stats, opts: { alpha: 0.5, min_samples: 20, route_weights: { quality: 0, cost: 0 } } });
  assert.equal(zeroW.reason, 'cost_quality_reorder');
  assert.deepEqual(zeroW, legacy);
});

// -------------------------------------------------------------------------
// #4 quality-only weights -> highest-accuracy model leads
// -------------------------------------------------------------------------
test('#4 quality-only weights pick the highest-accuracy model regardless of cost', () => {
  // opus high accuracy (24/25) + expensive; mini lower accuracy (15/25) + cheap.
  const stats = statsWithTwoModels({ opusWins: 24, miniWins: 15 });
  const out = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, min_quality: 0.0, route_weights: { quality: 1 } },
  });
  assert.equal(out.reason, 'multi_signal_reorder');
  assert.equal(out.cold_start, false);
  // Pure quality => the more accurate (expensive) opus leads.
  assert.equal(out.chosen.model, 'claude-opus-4-7');
  assert.ok(out.rejected.some((r) => r.model === 'gpt-4o-mini'));
  // route_weights echoed; route_signals present for both candidates.
  assert.deepEqual(out.route_weights, { quality: 1 });
  assert.equal(out.route_signals.length, 2);
});

// -------------------------------------------------------------------------
// #5 cost-heavy weights -> cheaper model leads on a quality tie
// -------------------------------------------------------------------------
test('#5 cost-heavy weights pick the cheaper model on a quality tie', () => {
  // Both high accuracy (tie); mini far cheaper.
  const stats = statsWithTwoModels({ opusWins: 25, miniWins: 25, opusCost: 0.5, miniCost: 0.005 });
  const out = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, route_weights: { quality: 1, cost: 4 } },
  });
  assert.equal(out.reason, 'multi_signal_reorder');
  assert.equal(out.chosen.model, 'gpt-4o-mini');
  const rej = out.rejected.find((r) => r.model === 'claude-opus-4-7');
  assert.ok(rej && rej.reason === 'lower_route_score');
});

// -------------------------------------------------------------------------
// #6 latency signal (injected latencyFn) -> faster provider leads
// -------------------------------------------------------------------------
test('#6 latency weight with injected latencyFn picks the faster provider', () => {
  // Quality + cost tied so latency is the only discriminator.
  const stats = statsWithTwoModels({ opusWins: 25, miniWins: 25, opusCost: 0.01, miniCost: 0.01 });
  // anthropic is the SLOW provider, openai is FAST (live EWMA via injection).
  const latencyFn = (provider) => (provider === 'anthropic' ? 5000 : 100);
  const out = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, route_weights: { quality: 1, latency: 5 }, latencyFn },
  });
  assert.equal(out.reason, 'multi_signal_reorder');
  // The fast openai/gpt-4o-mini leads despite anthropic being the static primary.
  assert.equal(out.chosen.provider, 'openai');
  // The slow provider's latency normalized to the WORST (0 after inversion).
  const slowSig = out.route_signals.find((s) => s.provider === 'anthropic');
  const fastSig = out.route_signals.find((s) => s.provider === 'openai');
  assert.ok(fastSig.latency > slowSig.latency, 'faster provider has higher (better) normalized latency');
});

// -------------------------------------------------------------------------
// #7 load signal (passed load map) -> less-loaded provider leads
// -------------------------------------------------------------------------
test('#7 load weight with a passed load map picks the less-loaded provider', () => {
  const stats = statsWithTwoModels({ opusWins: 25, miniWins: 25, opusCost: 0.01, miniCost: 0.01 });
  // anthropic heavily loaded, openai idle. Keyed by bare provider here.
  const load = { anthropic: 100, openai: 1 };
  const out = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, route_weights: { quality: 1, load: 5 }, load },
  });
  assert.equal(out.chosen.provider, 'openai');
  // Load keyed by full modelKey also resolves (and wins over bare provider).
  const load2 = { [modelKey('anthropic', 'claude-opus-4-7')]: 1, [modelKey('openai', 'gpt-4o-mini')]: 100 };
  const out2 = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, route_weights: { quality: 1, load: 5 }, load: load2 },
  });
  assert.equal(out2.chosen.provider, 'anthropic');
});

// -------------------------------------------------------------------------
// #8 similarity weight discriminates candidates by model-specific cluster fit
// -------------------------------------------------------------------------
test('#8 similarity is per-candidate cluster fit, not a shared request scalar', () => {
  const prompt = 'reset password account support';
  const near = embed(prompt);
  const far = near.map((x) => -x);
  const stats = new ClusterRouterStats({ k: 2, centroids: [near, far] });
  for (let i = 0; i < 25; i++) {
    stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.01, latency_ms: 100 });
    stats.update({ clusterId: 1, model: 'claude-opus-4-7', won: true, cost_usd: 0.01, latency_ms: 100 });
  }
  const stub = Object.assign(Object.create(ClusterRouterStats.prototype), stats);
  stub.topPClusters = () => [0, 1];
  const out = scoreRoute({
    namespaceConfig: CFG, prompt, stats: stub,
    opts: { min_samples: 20, route_weights: { similarity: 1 } },
  });
  assert.equal(out.reason, 'multi_signal_reorder');
  assert.equal(out.chosen.provider, 'openai');
  assert.equal(out.chosen.model, 'gpt-4o-mini');
  assert.ok(out.cluster_similarity != null && out.cluster_similarity >= 0 && out.cluster_similarity <= 1);
  assert.ok(out.route_score >= 0 && out.route_score <= 1);
  const openaiSig = out.route_signals.find((s) => s.provider === 'openai');
  const anthropicSig = out.route_signals.find((s) => s.provider === 'anthropic');
  assert.ok(Object.prototype.hasOwnProperty.call(openaiSig, 'similarity'));
  assert.ok(Object.prototype.hasOwnProperty.call(anthropicSig, 'similarity'));
  assert.ok(openaiSig.similarity > anthropicSig.similarity, `${openaiSig.similarity} <= ${anthropicSig.similarity}`);
});

// -------------------------------------------------------------------------
// #9 quality floor still blocks a sub-floor cheap model from the head
// -------------------------------------------------------------------------
test('#9 quality floor blocks a sub-floor cheap model even with cost-heavy weights', () => {
  // mini is cheap but only 30% accurate (below the 0.8 floor); opus is 95%.
  const stats = statsWithTwoModels({ opusWins: 24, opusN: 25, miniWins: 8, miniN: 25, opusCost: 0.5, miniCost: 0.005 });
  const out = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, min_quality: 0.8, route_weights: { quality: 1, cost: 10 } },
  });
  // Despite the huge cost weight, the sub-floor model must NOT lead.
  assert.notEqual(out.chosen.model, 'gpt-4o-mini');
  assert.equal(out.chosen.model, 'claude-opus-4-7');
  const rej = out.rejected.find((r) => r.model === 'gpt-4o-mini');
  assert.equal(rej.reason, 'below_quality_floor');
  // Sub-floor model stays in the chain (never dropped).
  assert.ok(out.ordered_chain.some((e) => e.model === 'gpt-4o-mini'));
  // route_score is the head's (in-range) blended score, never the -1000 sink.
  assert.ok(out.route_score >= 0 && out.route_score <= 1);
});

// -------------------------------------------------------------------------
// #10 determinism: identical inputs -> identical output across runs
// -------------------------------------------------------------------------
test('#10 multi-signal decision is deterministic across repeated calls', () => {
  const mk = () => scoreRoute({
    namespaceConfig: CFG, prompt: 'deterministic prompt text', stats: statsWithTwoModels(),
    opts: {
      min_samples: 20,
      route_weights: { quality: 1, cost: 2, latency: 1, load: 1, similarity: 1 },
      latencyFn: (p) => (p === 'anthropic' ? 300 : 80),
      load: { anthropic: 10, openai: 2 },
    },
  });
  const a = mk();
  const b = mk();
  assert.deepEqual(a, b);
  // The chosen head is stable.
  assert.equal(a.chosen.provider, b.chosen.provider);
});

// -------------------------------------------------------------------------
// #11 buildRouterDecisionBlock carries route_mode 'semantic' + audit fields
// -------------------------------------------------------------------------
test('#11 buildRouterDecisionBlock surfaces semantic mode + multi-signal audit', () => {
  const stats = statsWithTwoModels({ opusWins: 24, miniWins: 15 });
  const decision = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats,
    opts: { min_samples: 20, min_quality: 0.0, route_weights: { quality: 1, cost: 1 } },
  });
  const block = buildRouterDecisionBlock({
    scored: decision, alpha: decision.alpha, beta: decision.beta,
    cluster_id: decision.cluster_id, n_samples: decision.n_samples,
    embedder: decision.embedder, cold_start: decision.cold_start,
  });
  assert.equal(block.route_mode, 'semantic');
  assert.equal(block.embedder, EMBEDDER_ID);
  assert.deepEqual(block.route_weights, { quality: 1, cost: 1 });
  assert.ok(Array.isArray(block.route_signals) && block.route_signals.length === 2);
  assert.ok(block.cluster_similarity == null || (block.cluster_similarity >= 0 && block.cluster_similarity <= 1));
  // A legacy (cost_quality) decision still reports cost_quality and omits the
  // multi-signal fields (back-compat shape).
  const legacyBlock = buildRouterDecisionBlock({ scored: { reason: 'cost_quality_reorder', cold_start: false } });
  assert.equal(legacyBlock.route_mode, 'cost_quality');
  assert.equal(legacyBlock.route_weights, undefined);
  assert.equal(legacyBlock.route_signals, undefined);
});

// -------------------------------------------------------------------------
// #12 multi-signal preserves cold-start/static fallback
// -------------------------------------------------------------------------
test('#12 route_weights present but untrained stats -> cold-start static order', () => {
  // No trained stats at all.
  const out = scoreRoute({
    namespaceConfig: CFG, prompt: 'x', stats: null,
    opts: { route_weights: { quality: 1, cost: 1, latency: 1 } },
  });
  assert.equal(out.cold_start, true);
  assert.equal(out.reason, 'no_cluster_stats');
  assert.equal(out.ordered_chain[0].provider, 'anthropic'); // static head preserved
  assert.equal(out.ordered_chain.length, 2);
  // Below min_samples also reverts even with weights set.
  const thin = new ClusterRouterStats({ k: 1, centroids: [unitVec(0)] });
  for (let i = 0; i < 3; i++) thin.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.001, latency_ms: 30 });
  const stub = Object.assign(Object.create(ClusterRouterStats.prototype), thin);
  stub.topPClusters = () => [0];
  const cold = scoreRoute({ namespaceConfig: CFG, prompt: 'x', stats: stub, opts: { min_samples: 20, route_weights: { quality: 1, cost: 1 } } });
  assert.equal(cold.cold_start, true);
  assert.equal(cold.reason, 'cold_start_below_min_samples');
  assert.equal(cold.ordered_chain[0].provider, 'anthropic');
});

// -------------------------------------------------------------------------
// #13 caller-confidence override still wins even with route_weights
// -------------------------------------------------------------------------
test('#13 caller-confidence override short-circuits before the multi-signal blend', () => {
  const stats = statsWithTwoModels();
  const cfg = { ...CFG, primary: 'local:trinity-500', fallback: ['openai:gpt-4o-mini'], confidence_threshold: 0.7 };
  const out = scoreRoute({
    namespaceConfig: cfg, prompt: 'x', stats, callerConfidence: 0.2,
    opts: { min_samples: 20, route_weights: { quality: 1, cost: 5 } },
  });
  assert.equal(out.reason, 'caller_confidence_override');
  // The multi-signal branch never ran -> no route_signals.
  assert.equal(out.route_signals, undefined);
});

// -------------------------------------------------------------------------
// #14 reorderChainByScore unchanged (multi-signal reuses it) — sanity
// -------------------------------------------------------------------------
test('#14 reorderChainByScore stays a pure reorder under multi-signal scores', () => {
  const chain = [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'openai', model: 'gpt-4o-mini' },
  ];
  const scores = { [modelKey('openai', 'gpt-4o-mini')]: 0.92, [modelKey('anthropic', 'claude-opus-4-7')]: 0.10 };
  const out = reorderChainByScore(chain, scores, { min_quality: 0.8 });
  assert.equal(out.length, 2);
  assert.equal(out[0].model, 'gpt-4o-mini');
});
