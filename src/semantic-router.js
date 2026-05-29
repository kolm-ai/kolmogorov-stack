// W921 — semantic-router: cost/latency/quality-aware request routing.
//
// Ships the TRAINING-FREE Avengers-Pro cluster/KNN router family (DAI'25;
// justified by LLMRouterBench 2026 which found clustering routers match
// trained neural routers and that embedder quality is negligible). It picks,
// per request, the cheapest model in the namespace chain that still clears a
// quality bar — instead of always firing the static primary or relying on a
// caller-supplied confidence number kolm never computes.
//
// Recipe (Avengers-Pro):
//   Offline: embed past prompts -> mini-batch k-means into k clusters.
//   Per (cluster j, model i) record running accuracy p_ij + cost q_ij +
//   latency l_ij from kolm's OWN captured outcomes (the data flywheel).
//   Serve: embed prompt -> top-p nearest clusters by cosine -> per candidate
//   x = alpha*p~ + (1-alpha)*(1 - q~) - beta*l~  (min-max normalized within
//   the aggregated cluster window) -> reorder the static chain by x desc.
//
// Safety contract (the whole point of shipping this carefully):
//   - default OFF per-namespace (route_mode:'static'); caller opts in.
//   - cold-start guard: a cluster with < min_samples outcomes reverts to the
//     static chain and stamps cold_start:true — NEVER silently downgrades a
//     hard prompt on no data.
//   - quality floor: a cheaper model whose measured cluster accuracy is below
//     namespace.min_quality (default 0.8) is never placed first.
//   - caller x-kolm-confidence still wins (back-compat).
//   - cost_usd of 0/missing is treated as UNKNOWN (skip the cost term) rather
//     than "free" — guards the w920 estimator-returns-0 bug from corrupting
//     the ordering.
//   - reorder/trim ONLY: dispatchWithFallback fallback semantics are
//     unchanged and the chain is never emptied.
//
// Reuses (zero new deps): src/embedding.js (embed/cosine/topK, 256-dim
// hashed), src/cost-estimator.js, src/provider-registry.js, src/lake.js,
// src/event-store.js. The decision is stamped into receipt.router_decision, a
// NON-SIGNED top-level block (mirrors latency_breakdown) so savings are
// auditable without touching the frozen signed canonical fields.

import { embed, cosine, DIMENSIONS } from './embedding.js';
import { estimateCost } from './cost-estimator.js';
import { buildChainFromNamespace, selectRoute, parseChainEntry } from './gateway-router.js';

export const SEMANTIC_ROUTER_VERSION = 'w921-v1';
export const EMBEDDER_ID = 'hashed-ngram-256';

const DEFAULT_K = 32;
const DEFAULT_TOP_P = 4;
const DEFAULT_ALPHA = 0.5;
const DEFAULT_BETA = 0.0;
const DEFAULT_MIN_QUALITY = 0.8;
const DEFAULT_MIN_SAMPLES = 20;

// Rough length-based token estimate used BEFORE dispatch (we have no usage
// yet). ~4 chars/token is the standard OpenAI heuristic. Floor at 1 so an
// empty prompt still prices a single token rather than 0 (which the cost
// guard would read as "unknown").
function _estTokensFromText(text) {
  const s = String(text == null ? '' : text);
  return Math.max(1, Math.ceil(s.length / 4));
}

// A stable per-(provider,model) key for the scoresByModel / stats maps.
export function modelKey(provider, model) {
  return `${provider || ''}:${model || ''}`;
}

// Min-max normalize an array of {value,index} into [0,1]; when all values are
// equal (or the array is empty/length 1) every entry normalizes to 0.5 so a
// degenerate cluster never fabricates a preference.
function _minMaxNorm(values) {
  if (!values.length) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (!(span > 0)) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / span);
}

// --------------------------------------------------------------------------
// estimateModelCost — thin wrapper over cost-estimator.estimateCost using a
// length-based token estimate BEFORE dispatch. Returns the USD cost or 0 when
// the model is not in the price table (the caller MUST treat 0 as "unknown",
// never "free" — see the cost guard in scoreRoute).
// --------------------------------------------------------------------------
export function estimateModelCost({ provider, model, est_input_tokens, est_output_tokens }) {
  const pin = Number.isFinite(Number(est_input_tokens)) ? Number(est_input_tokens) : 0;
  const pout = Number.isFinite(Number(est_output_tokens)) ? Number(est_output_tokens) : 0;
  // estimateCost takes prompt_tokens/completion_tokens (not input/output) —
  // map across the naming gap the live dispatch path also bridges.
  return estimateCost({
    provider,
    model,
    prompt_tokens: pin,
    completion_tokens: pout,
  });
}

// --------------------------------------------------------------------------
// ClusterRouterStats — per-namespace k-means centroids + per-(cluster,model)
// running outcome stats. Durable via snapshot()/restore() so the gateway can
// persist it per namespace as JSON between process restarts.
// --------------------------------------------------------------------------
export class ClusterRouterStats {
  constructor({ k = DEFAULT_K, dim = DIMENSIONS, centroids = null } = {}) {
    this.k = Math.max(1, Math.trunc(Number(k) || DEFAULT_K));
    this.dim = Math.max(1, Math.trunc(Number(dim) || DIMENSIONS));
    // centroids: Array<number[dim]> length k, or null until trained. When
    // null, assign() returns -1 (no centroid) and topPClusters returns []
    // so scoreRoute degrades to cold-start.
    this.centroids = Array.isArray(centroids) ? centroids.map((c) => c.slice()) : null;
    // counts[clusterId] = number of vectors assigned (for mini-batch update +
    // cold-start population checks at the cluster level).
    this.counts = new Array(this.centroids ? this.centroids.length : this.k).fill(0);
    // stats: Map<clusterId, Map<modelKey, {n,wins,sum_cost,sum_latency}>>
    this.stats = new Map();
  }

  // assign(vec) -> nearest centroid id by cosine, or -1 when untrained.
  assign(vec) {
    if (!this.centroids || !this.centroids.length) return -1;
    let best = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < this.centroids.length; i++) {
      const sim = cosine(vec, this.centroids[i]);
      if (sim > bestSim) { bestSim = sim; best = i; }
    }
    return best;
  }

  // topPClusters(vec,p) -> the p nearest centroid ids by cosine (descending).
  topPClusters(vec, p = DEFAULT_TOP_P) {
    if (!this.centroids || !this.centroids.length) return [];
    const scored = this.centroids.map((c, i) => ({ id: i, sim: cosine(vec, c) }));
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, Math.max(1, Math.trunc(Number(p) || DEFAULT_TOP_P))).map((s) => s.id);
  }

  _cell(clusterId, model) {
    let byModel = this.stats.get(clusterId);
    if (!byModel) { byModel = new Map(); this.stats.set(clusterId, byModel); }
    const key = String(model);
    let cell = byModel.get(key);
    if (!cell) { cell = { n: 0, wins: 0, sum_cost: 0, sum_latency: 0 }; byModel.set(key, cell); }
    return cell;
  }

  // update — fold ONE observed outcome into the (cluster,model) cell.
  //   won:        boolean quality label (accepted / judged-correct). When
  //               null/undefined the outcome counts toward n but not wins
  //               (latency/cost still accumulate so the cost/latency terms
  //               stay usable without a quality label).
  //   cost_usd:   measured USD cost for this call (0 => unknown, ignored).
  //   latency_ms: measured wall latency.
  update({ clusterId, model, won, cost_usd, latency_ms }) {
    if (clusterId == null || clusterId < 0) return;
    const cell = this._cell(clusterId, model);
    cell.n += 1;
    if (won === true) cell.wins += 1;
    const c = Number(cost_usd);
    if (Number.isFinite(c) && c > 0) cell.sum_cost += c;
    const l = Number(latency_ms);
    if (Number.isFinite(l) && l >= 0) cell.sum_latency += l;
  }

  // Aggregate raw (n,wins,sum_cost,sum_latency) for a model across a set of
  // clusters (the top-p window). Cost/latency averages skip cells with no
  // cost/latency mass so an all-zero-cost model reports unknown, not free.
  _aggregate(clusterIds, model) {
    let n = 0;
    let wins = 0;
    let sumCost = 0;
    let nCost = 0;
    let sumLat = 0;
    let nLat = 0;
    const key = String(model);
    for (const cid of clusterIds) {
      const byModel = this.stats.get(cid);
      if (!byModel) continue;
      const cell = byModel.get(key);
      if (!cell) continue;
      n += cell.n;
      wins += cell.wins;
      if (cell.sum_cost > 0) { sumCost += cell.sum_cost; nCost += cell.n; }
      if (cell.sum_latency > 0) { sumLat += cell.sum_latency; nLat += cell.n; }
    }
    return {
      n,
      wins,
      accuracy: n > 0 ? wins / n : 0,
      avg_cost: nCost > 0 ? sumCost / nCost : null,
      avg_latency: nLat > 0 ? sumLat / nLat : null,
    };
  }

  // scoreModel — raw per-model aggregates for one cluster (or top-p window
  // if clusterId is an array). The normalized x is computed by scoreRoute
  // across the candidate set (min-max needs all candidates); here we return
  // the building blocks plus a self-normalized convenience x (accuracy as the
  // quality_norm, since accuracy is already in [0,1], and cost/latency left
  // raw at 0 when unknown). scoreRoute is the source of truth for the final
  // cross-candidate normalized x; this method exists for unit inspection.
  scoreModel({ clusterId, model, alpha = DEFAULT_ALPHA, beta = DEFAULT_BETA }) {
    const clusterIds = Array.isArray(clusterId) ? clusterId : [clusterId];
    const agg = this._aggregate(clusterIds, model);
    const quality_norm = agg.accuracy; // already [0,1]
    const cost_norm = agg.avg_cost == null ? null : agg.avg_cost;
    const latency_norm = agg.avg_latency == null ? null : agg.avg_latency;
    const costTerm = cost_norm == null ? 0 : cost_norm;
    const latTerm = latency_norm == null ? 0 : latency_norm;
    const a = _clamp01(alpha);
    const x = a * quality_norm + (1 - a) * (1 - costTerm) - Number(beta || 0) * latTerm;
    return { quality_norm, cost_norm, latency_norm, x, n: agg.n };
  }

  // snapshot/restore — durable per-namespace JSON. Centroids + counts +
  // flattened stats. Plain JSON (no Map) so it survives JSON.stringify.
  snapshot() {
    const stats = {};
    for (const [cid, byModel] of this.stats.entries()) {
      const m = {};
      for (const [model, cell] of byModel.entries()) {
        m[model] = { n: cell.n, wins: cell.wins, sum_cost: cell.sum_cost, sum_latency: cell.sum_latency };
      }
      stats[cid] = m;
    }
    return {
      version: SEMANTIC_ROUTER_VERSION,
      embedder: EMBEDDER_ID,
      k: this.k,
      dim: this.dim,
      centroids: this.centroids ? this.centroids.map((c) => c.slice()) : null,
      counts: this.counts.slice(),
      stats,
    };
  }

  static restore(obj) {
    const o = obj || {};
    const inst = new ClusterRouterStats({ k: o.k, dim: o.dim, centroids: o.centroids || null });
    if (Array.isArray(o.counts)) inst.counts = o.counts.slice();
    inst.stats = new Map();
    const stats = o.stats || {};
    for (const cidStr of Object.keys(stats)) {
      const cid = Number(cidStr);
      const byModel = new Map();
      const m = stats[cidStr] || {};
      for (const model of Object.keys(m)) {
        const cell = m[model] || {};
        byModel.set(model, {
          n: Number(cell.n) || 0,
          wins: Number(cell.wins) || 0,
          sum_cost: Number(cell.sum_cost) || 0,
          sum_latency: Number(cell.sum_latency) || 0,
        });
      }
      inst.stats.set(cid, byModel);
    }
    return inst;
  }
}

function _clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// --------------------------------------------------------------------------
// reorderChainByScore — pure reorder/trim of a static chain by per-model
// score. NEVER empties the chain and never drops the only viable provider.
//   scoresByModel: Record<modelKey, number> (higher = preferred).
//   min_quality:   entries flagged below the floor (score === -Infinity, or a
//                  caller-provided low score) sink to the back but are kept.
//   preserve_local_floor: keep at least one entry even if all are below floor.
// Entries with no score keep their original relative order at the end (stable),
// behind scored entries, so an unknown model never jumps the queue.
// --------------------------------------------------------------------------
export function reorderChainByScore(chain, scoresByModel, { min_quality = DEFAULT_MIN_QUALITY, preserve_local_floor = true } = {}) {
  if (!Array.isArray(chain) || chain.length === 0) return Array.isArray(chain) ? chain : [];
  const scores = scoresByModel || {};
  const decorated = chain.map((entry, idx) => {
    const key = modelKey(entry.provider, entry.model);
    const has = Object.prototype.hasOwnProperty.call(scores, key);
    const s = has ? Number(scores[key]) : null;
    return { entry, idx, key, score: s, scored: has && Number.isFinite(s) };
  });
  decorated.sort((a, b) => {
    // scored entries first (descending score), then unscored in original order.
    if (a.scored && b.scored) {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    }
    if (a.scored) return -1;
    if (b.scored) return 1;
    return a.idx - b.idx;
  });
  const out = decorated.map((d) => d.entry);
  // Safety: never return empty (the input was non-empty so this holds), and
  // never lose the only viable provider — we trim NOTHING here; trimming is a
  // deliberate caller choice in scoreRoute via the rejected[] list. The
  // preserve_local_floor flag is honored by scoreRoute which decides what to
  // exclude; reorder itself only reorders, so the floor is structurally safe.
  void preserve_local_floor;
  void min_quality;
  return out.length ? out : chain.slice();
}

// --------------------------------------------------------------------------
// scoreRoute — the entry point the gateway calls in dispatch stage 3.
//
// Returns a decision object with a reordered/trimmed ordered_chain plus the
// non-signed receipt fields. Falls back to the static chain (cold_start:true)
// whenever it cannot responsibly improve the order.
// --------------------------------------------------------------------------
export function scoreRoute({
  namespaceConfig,
  prompt,
  candidates = null,
  callerConfidence = null,
  stats = null,
  costFn = null,
  opts = {},
} = {}) {
  const cfg = namespaceConfig || {};
  const alpha = _clamp01(typeof opts.alpha === 'number' ? opts.alpha
    : (typeof cfg.route_alpha === 'number' ? cfg.route_alpha : DEFAULT_ALPHA));
  const beta = Number.isFinite(Number(opts.beta)) ? Number(opts.beta)
    : (Number.isFinite(Number(cfg.route_beta)) ? Number(cfg.route_beta) : DEFAULT_BETA);
  const minQuality = typeof opts.min_quality === 'number' ? opts.min_quality
    : (typeof cfg.min_quality === 'number' ? cfg.min_quality : DEFAULT_MIN_QUALITY);
  const minSamples = Number.isFinite(Number(opts.min_samples)) ? Number(opts.min_samples)
    : (Number.isFinite(Number(cfg.min_samples)) ? Number(cfg.min_samples) : DEFAULT_MIN_SAMPLES);
  const topP = Number.isFinite(Number(opts.top_p)) ? Number(opts.top_p)
    : (Number.isFinite(Number(cfg.top_p)) ? Number(cfg.top_p) : DEFAULT_TOP_P);

  // The static chain is the ground truth we fall back to. candidates override
  // when the caller already resolved the chain (dispatch passes it through).
  const staticChain = Array.isArray(candidates) && candidates.length
    ? candidates.map((c) => ({ ...c }))
    : buildChainFromNamespace(cfg);

  // Primary route_decision per today's static selectRoute (local vs frontier).
  const baseRoute = selectRoute({ namespaceConfig: cfg, confidence: callerConfidence == null ? undefined : callerConfidence });

  const buildStatic = (reason, extra = {}) => {
    const head = staticChain[0] || {};
    return {
      route_decision: baseRoute.route_decision,
      ordered_chain: staticChain,
      route_score: 0,
      alpha,
      chosen: { provider: head.provider || baseRoute.provider || null, model: head.model || baseRoute.model || '' },
      rejected: [],
      cluster_id: null,
      n_samples: 0,
      embedder: EMBEDDER_ID,
      cold_start: true,
      reason,
      ...extra,
    };
  };

  // (5) Caller x-kolm-confidence still wins — reproduces today's
  // pre_routed_to_fallback short-circuit. We do NOT second-guess an explicit
  // caller signal.
  if (callerConfidence != null && typeof callerConfidence === 'number') {
    if (baseRoute.pre_routed_to_fallback) {
      // Caller forced a fallback-first route; honor it as the head of chain.
      const fb = parseChainEntry((cfg.fallback || [])[0] || '');
      const reordered = staticChain.slice();
      // Move the matching fallback entry to the front if present.
      const idx = reordered.findIndex((e) => e.provider === (fb.provider || baseRoute.provider));
      if (idx > 0) {
        const [picked] = reordered.splice(idx, 1);
        reordered.unshift(picked);
      }
      const head = reordered[0] || {};
      return {
        route_decision: 'frontier',
        ordered_chain: reordered,
        route_score: 0,
        alpha,
        chosen: { provider: head.provider || baseRoute.provider || null, model: head.model || '' },
        rejected: [],
        cluster_id: null,
        n_samples: 0,
        embedder: EMBEDDER_ID,
        cold_start: true,
        reason: 'caller_confidence_override',
      };
    }
    return buildStatic('caller_confidence_override');
  }

  // route_mode must be opted into per namespace.
  const mode = String(cfg.route_mode || 'static');
  if (mode !== 'cost_quality') {
    return buildStatic('route_mode_static');
  }

  if (!staticChain.length) {
    return buildStatic('empty_chain');
  }
  if (staticChain.length === 1) {
    // Nothing to reorder; record but stay static.
    return buildStatic('single_candidate');
  }

  // Need trained cluster stats to do anything cost/quality-aware.
  if (!stats || typeof stats.topPClusters !== 'function' || !stats.centroids || !stats.centroids.length) {
    return buildStatic('no_cluster_stats');
  }

  const vec = embed(String(prompt == null ? '' : prompt));
  const clusterIds = stats.topPClusters(vec, topP);
  if (!clusterIds.length) {
    return buildStatic('no_clusters');
  }
  const clusterId = clusterIds[0];

  // Aggregate per-candidate raw stats across the top-p window.
  const estIn = _estTokensFromText(prompt);
  const estOut = Math.max(1, Math.round(estIn * 0.5)); // rough completion estimate
  const priceFn = typeof costFn === 'function' ? costFn : estimateModelCost;

  const rows = [];
  let totalSamples = 0;
  for (const cand of staticChain) {
    const key = modelKey(cand.provider, cand.model);
    const agg = stats._aggregate(clusterIds, cand.model);
    totalSamples += agg.n;
    // Cost: prefer the measured average from the lake; otherwise estimate from
    // the price table BEFORE dispatch. 0/missing => unknown (cost term skipped
    // for this candidate's normalization).
    let cost = agg.avg_cost;
    if (cost == null || !(cost > 0)) {
      const est = priceFn({ provider: cand.provider, model: cand.model, est_input_tokens: estIn, est_output_tokens: estOut });
      cost = Number.isFinite(est) && est > 0 ? est : null;
    }
    rows.push({
      key,
      cand,
      n: agg.n,
      accuracy: agg.accuracy,
      cost,
      latency: agg.avg_latency,
      hasQuality: agg.n > 0,
    });
  }

  // Cold-start guard: if NO candidate has min_samples outcomes in the window,
  // we have no responsible basis to reorder — revert to the static chain.
  const maxN = rows.reduce((m, r) => Math.max(m, r.n), 0);
  if (maxN < minSamples) {
    return buildStatic('cold_start_below_min_samples', { cluster_id: clusterId, n_samples: totalSamples });
  }

  // Min-max normalize cost across candidates that HAVE a known cost. Unknown
  // cost normalizes to 0.5 (neutral) so it neither rewards nor penalizes.
  const knownCosts = rows.filter((r) => r.cost != null).map((r) => r.cost);
  const costNormMap = new Map();
  if (knownCosts.length) {
    const normed = _minMaxNorm(knownCosts);
    let i = 0;
    for (const r of rows) {
      if (r.cost != null) costNormMap.set(r.key, normed[i++]);
      else costNormMap.set(r.key, 0.5);
    }
  } else {
    for (const r of rows) costNormMap.set(r.key, 0.5);
  }

  // Latency normalization (only when beta != 0 and we have latency data).
  const latNormMap = new Map();
  if (beta !== 0) {
    const knownLat = rows.filter((r) => r.latency != null).map((r) => r.latency);
    if (knownLat.length) {
      const normed = _minMaxNorm(knownLat);
      let i = 0;
      for (const r of rows) {
        if (r.latency != null) latNormMap.set(r.key, normed[i++]);
        else latNormMap.set(r.key, 0.5);
      }
    } else {
      for (const r of rows) latNormMap.set(r.key, 0.5);
    }
  }

  // Score each candidate: x = alpha*quality~ + (1-alpha)*(1 - cost~) - beta*lat~.
  // quality~ is the cluster accuracy (already [0,1]); a candidate with no
  // quality data uses the neutral 0.5 so it is not penalized into oblivion.
  const scoresByModel = {};
  const scored = [];
  for (const r of rows) {
    const q = r.hasQuality ? r.accuracy : 0.5;
    const cn = costNormMap.get(r.key);
    const ln = beta !== 0 ? (latNormMap.get(r.key) ?? 0.5) : 0;
    let x = alpha * q + (1 - alpha) * (1 - cn) - beta * ln;
    // Quality floor: a candidate with MEASURED accuracy below min_quality is
    // never allowed to lead. We sink it by clamping its score below any
    // floor-passing candidate (subtract a large penalty but keep it finite so
    // reorderChainByScore still keeps it in the chain for fallback).
    let belowFloor = false;
    if (r.hasQuality && r.accuracy < minQuality) {
      belowFloor = true;
      x -= 1000; // sink to the back, never dropped
    }
    scoresByModel[r.key] = x;
    scored.push({
      provider: r.cand.provider,
      model: r.cand.model,
      score: Number(x.toFixed(6)),
      quality: Number(q.toFixed(6)),
      cost_norm: Number((cn).toFixed(6)),
      n: r.n,
      below_quality_floor: belowFloor,
    });
  }

  const ordered_chain = reorderChainByScore(staticChain, scoresByModel, { min_quality: minQuality });
  const head = ordered_chain[0] || {};
  const headKey = modelKey(head.provider, head.model);

  // rejected[] = every candidate that did NOT win the head slot, with reason.
  const rejected = [];
  for (const s of scored) {
    const key = modelKey(s.provider, s.model);
    if (key === headKey) continue;
    rejected.push({
      provider: s.provider,
      model: s.model,
      score: s.score,
      reason: s.below_quality_floor ? 'below_quality_floor' : 'lower_route_score',
    });
  }

  const headScored = scored.find((s) => modelKey(s.provider, s.model) === headKey);
  const route_score = headScored ? _clamp01(headScored.score) : 0;
  const headIsLocal = String(head.route_decision || '') === 'local'
    || String(head.provider || '').startsWith('local');

  return {
    route_decision: headIsLocal ? 'local' : 'frontier',
    ordered_chain,
    route_score: Number(route_score.toFixed(6)),
    alpha,
    chosen: { provider: head.provider || null, model: head.model || '' },
    rejected,
    cluster_id: clusterId,
    n_samples: totalSamples,
    embedder: EMBEDDER_ID,
    cold_start: false,
    reason: 'cost_quality_reorder',
  };
}

// --------------------------------------------------------------------------
// buildRouterDecisionBlock — the non-signed receipt.router_decision block
// (mirrors latency_breakdown). canonicalForSigning walks ALL_FIELDS only, so
// attaching this is signature-neutral.
// --------------------------------------------------------------------------
export function buildRouterDecisionBlock({ scored, alpha, beta = DEFAULT_BETA, cluster_id, n_samples, embedder, cold_start } = {}) {
  const s = scored || {};
  return {
    route_mode: cold_start ? 'static' : 'cost_quality',
    version: SEMANTIC_ROUTER_VERSION,
    route_score: Number.isFinite(Number(s.route_score)) ? Number(s.route_score) : 0,
    alpha: Number.isFinite(Number(alpha)) ? Number(alpha) : (Number.isFinite(Number(s.alpha)) ? Number(s.alpha) : DEFAULT_ALPHA),
    beta: Number.isFinite(Number(beta)) ? Number(beta) : DEFAULT_BETA,
    chosen: s.chosen || null,
    rejected: Array.isArray(s.rejected) ? s.rejected : [],
    cluster_id: cluster_id == null ? (s.cluster_id == null ? null : s.cluster_id) : cluster_id,
    n_samples: Number.isFinite(Number(n_samples)) ? Number(n_samples) : (Number(s.n_samples) || 0),
    embedder: embedder || s.embedder || EMBEDDER_ID,
    cold_start: cold_start == null ? !!s.cold_start : !!cold_start,
    reason: s.reason || null,
  };
}

// --------------------------------------------------------------------------
// trainClustersFromLake — offline mini-batch k-means over lake observation
// rows. CLI-invokable (`kolm route train`). Embeds each row's prompt text
// (prompt_redacted, falling back to request_hash) and clusters into k
// centroids, then folds each row's outcome into per-(cluster,model) stats so
// the very first serve already has data.
//
// Quality label policy (the spec's documented caveat): the lake stores NO
// judge/win-loss field, but it DOES store `accepted` (thumbs feedback) and a
// transport `status`. We use `accepted === true` as the win when present;
// otherwise a transport-ok row (status not 'error') counts as a weak win so
// the cost/latency terms remain usable. This is recorded as embedder/version
// provenance so a Phase-2 real-judge label can supersede it.
// --------------------------------------------------------------------------
export async function trainClustersFromLake({ tenant, namespace, k = DEFAULT_K, max_rows = 50000, embedder = embed } = {}) {
  // Lazy import so the module stays usable in pure-unit contexts that never
  // touch the event store (and so the test file can exercise scoreRoute /
  // ClusterRouterStats without a SQLite dependency).
  const { listEvents } = await import('./event-store.js');
  const rows = await listEvents({
    namespace: namespace || undefined,
    tenant_id: tenant || undefined,
    limit: Math.max(0, Math.trunc(Number(max_rows) || 50000)),
    order: 'asc',
  });

  const embedFn = typeof embedder === 'function' ? embedder : embed;
  const samples = [];
  for (const r of rows || []) {
    const text = r.prompt_redacted || r.request_hash || '';
    if (!text) continue;
    samples.push({ vec: embedFn(String(text)), row: r });
  }

  const kk = Math.max(1, Math.min(Math.trunc(Number(k) || DEFAULT_K), samples.length || 1));
  if (!samples.length) {
    // Nothing to train on — return an untrained shell (assign -> -1, scoreRoute
    // will cold-start). Never fabricate centroids.
    return new ClusterRouterStats({ k: kk });
  }

  const dim = samples[0].vec.length || DIMENSIONS;
  const centroids = _kmeans(samples.map((s) => s.vec), kk, dim);
  const inst = new ClusterRouterStats({ k: kk, dim, centroids });

  // Fold every row's outcome into the cluster it assigns to.
  for (const s of samples) {
    const cid = inst.assign(s.vec);
    if (cid < 0) continue;
    inst.counts[cid] = (inst.counts[cid] || 0) + 1;
    const r = s.row;
    const won = r.accepted === true
      ? true
      : (r.accepted === false ? false
        : (String(r.status || 'ok').toLowerCase() !== 'error'));
    inst.update({
      clusterId: cid,
      model: r.model || '',
      won,
      cost_usd: Number(r.estimated_cost_usd) || 0,
      latency_ms: Number(r.latency_ms) || 0,
    });
  }
  return inst;
}

// Deterministic mini-batch k-means (cosine on L2-normalized vectors, so the
// centroid is the L2-normalized mean — spherical k-means). Seeded init picks
// the first k DISTINCT vectors so a fixed corpus yields fixed centroids
// (important for the deterministic-assign unit test).
function _kmeans(vectors, k, dim, maxIter = 25) {
  const n = vectors.length;
  if (n === 0) return [];
  const kk = Math.max(1, Math.min(k, n));
  // Seed: first kk distinct vectors (deterministic).
  const centroids = [];
  const seenKeys = new Set();
  for (const v of vectors) {
    if (centroids.length >= kk) break;
    const key = v.slice(0, 8).map((x) => x.toFixed(3)).join(',');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    centroids.push(v.slice());
  }
  while (centroids.length < kk) centroids.push(vectors[centroids.length % n].slice());

  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const sim = cosine(vectors[i], centroids[c]);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    // Recompute centroids as the L2-normalized mean of assigned vectors.
    const sums = Array.from({ length: centroids.length }, () => new Array(dim).fill(0));
    const cnts = new Array(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const a = assignments[i];
      cnts[a]++;
      const v = vectors[i];
      for (let d = 0; d < dim; d++) sums[a][d] += v[d];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (cnts[c] === 0) continue; // keep prior centroid for empty cluster
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += sums[c][d] * sums[c][d];
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) sums[c][d] /= norm;
      centroids[c] = sums[c];
    }
    if (!changed && iter > 0) break;
  }
  return centroids;
}
