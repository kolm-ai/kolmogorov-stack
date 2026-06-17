// W608 - live semantic-routing training loop.
//
// The semantic router already had three separate pieces:
//   - trainClustersFromLake() builds centroids from captured prompts.
//   - route-quality-store records realized per-(cluster,model) outcomes.
//   - router.js can reorder a gateway chain when scoreRoute receives stats.
//
// This module is the glue layer: build/persist a namespace snapshot, reload it
// in the gateway, and graft the latest quality outcomes onto the trained
// centroids without making router.js grow another embedded subsystem.

import {
  ClusterRouterStats,
  SEMANTIC_ROUTER_VERSION,
  trainClustersFromLake,
} from './semantic-router.js';
import {
  getClusterQualityStats,
  recordRouteOutcome,
  trainRouteWeights,
} from './route-quality-store.js';
import { findByTenant, insert, update, id as storeId } from './store.js';

export const ROUTE_TRAINING_VERSION = 'w608-route-training-v1';
export const ROUTE_NAMESPACE_TABLE = 'wrapper_namespaces';
export const ROUTE_STATS_CACHE_MS = 30_000;

const _statsCache = new Map();

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _cleanNamespace(namespace) {
  return String(namespace || 'default').toLowerCase().slice(0, 128);
}

function _candidateModels(candidates) {
  const out = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const m = c && c.model != null ? String(c.model) : '';
    if (m) out.push(m);
  }
  return [...new Set(out)].sort();
}

function _hasCentroids(snapshot) {
  return !!(
    snapshot
    && typeof snapshot === 'object'
    && Array.isArray(snapshot.centroids)
    && snapshot.centroids.length
  );
}

function _cacheKey({ tenant, namespace, namespaceConfig, models }) {
  const stamp = namespaceConfig && (namespaceConfig.updated_at || namespaceConfig.route_stats_trained_at || '');
  return [
    String(tenant || ''),
    _cleanNamespace(namespace),
    String(stamp || ''),
    models.join(','),
  ].join('|');
}

export function clearRouteStatsCacheForTests() {
  _statsCache.clear();
}

export function mergeRouteQualitySnapshot(baseSnapshot, qualityStats) {
  const base = baseSnapshot && typeof baseSnapshot === 'object' ? baseSnapshot : {};
  const snap = {
    ...base,
    version: base.version || SEMANTIC_ROUTER_VERSION,
    stats: {},
  };
  const baseStats = base.stats && typeof base.stats === 'object' ? base.stats : {};
  for (const cid of Object.keys(baseStats)) {
    snap.stats[cid] = { ...(baseStats[cid] || {}) };
  }
  const qs = qualityStats && qualityStats.snapshot && qualityStats.snapshot.stats
    ? qualityStats.snapshot.stats
    : {};
  for (const cid of Object.keys(qs)) {
    snap.stats[cid] = { ...(snap.stats[cid] || {}), ...(qs[cid] || {}) };
  }
  snap.route_quality_outcomes = Number(qualityStats && qualityStats.n) || 0;
  snap.route_training_version = ROUTE_TRAINING_VERSION;
  return snap;
}

export async function loadRouteStatsForNamespace({
  tenant,
  namespace = 'default',
  namespaceConfig = {},
  candidates = [],
  max_rows = 50_000,
  now = Date.now(),
} = {}) {
  const ns = _cleanNamespace(namespace);
  const snapshot = namespaceConfig && namespaceConfig.route_stats_snapshot;
  if (!tenant) return { stats: null, reason: 'missing_tenant' };
  if (!_hasCentroids(snapshot)) return { stats: null, reason: 'missing_route_stats_snapshot' };

  const models = _candidateModels(candidates);
  const key = _cacheKey({ tenant, namespace: ns, namespaceConfig, models });
  const cached = _statsCache.get(key);
  const ttl = Math.max(0, _num(process.env.KOLM_ROUTE_STATS_CACHE_MS, ROUTE_STATS_CACHE_MS));
  if (cached && ttl > 0 && now - cached.loaded_at < ttl) return cached.value;

  const qualityStats = await getClusterQualityStats({
    tenant,
    namespace: ns,
    models: models.length ? models : null,
    max_rows,
  });
  const merged = mergeRouteQualitySnapshot(snapshot, qualityStats);
  const stats = ClusterRouterStats.restore(merged);
  const value = {
    stats,
    snapshot: merged,
    route_quality_outcomes: qualityStats.n,
    reason: qualityStats.n > 0 ? 'loaded_centroids_plus_quality_outcomes' : 'loaded_centroids',
  };
  _statsCache.set(key, { loaded_at: now, value });
  return value;
}

export async function buildRouteTrainingSnapshot({
  tenant,
  namespace = 'default',
  k = 32,
  max_rows = 50_000,
} = {}) {
  if (!tenant) {
    const err = new Error('route_train_missing_tenant');
    err.code = 'missing_tenant';
    throw err;
  }
  const ns = _cleanNamespace(namespace);
  const maxRows = Math.max(0, Math.trunc(_num(max_rows, 50_000)));
  const trained = await trainClustersFromLake({ tenant, namespace: ns, k, max_rows: maxRows });
  const trainedSnapshot = trained.snapshot();
  const qualityStats = await getClusterQualityStats({ tenant, namespace: ns, max_rows: maxRows });
  const snapshot = mergeRouteQualitySnapshot(trainedSnapshot, qualityStats);
  snapshot.trained_at = new Date().toISOString();
  snapshot.source = 'kolm-route-train';

  const weights = await trainRouteWeights({ stats: qualityStats, quality_floor: 0.000001 });
  const route_weights = weights && weights.route_weights && Object.keys(weights.route_weights).length
    ? weights.route_weights
    : null;
  const trained_rows = Array.isArray(snapshot.counts)
    ? snapshot.counts.reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;

  return {
    ok: true,
    version: ROUTE_TRAINING_VERSION,
    tenant,
    namespace: ns,
    trained_rows,
    route_quality_outcomes: qualityStats.n,
    route_weights,
    route_weight_basis: weights ? weights.basis : null,
    snapshot,
  };
}

export async function persistRouteTrainingSnapshot({
  tenant,
  namespace = 'default',
  snapshot,
  route_weights = null,
  activate = false,
} = {}) {
  if (!tenant) {
    const err = new Error('route_train_missing_tenant');
    err.code = 'missing_tenant';
    throw err;
  }
  const nsSlug = _cleanNamespace(namespace);
  if (!_hasCentroids(snapshot)) {
    const err = new Error('route_train_missing_centroids');
    err.code = 'missing_centroids';
    throw err;
  }

  const rows = findByTenant(ROUTE_NAMESPACE_TABLE, tenant) || [];
  const existing = rows.find((r) => r && r.slug === nsSlug) || null;
  const now = new Date().toISOString();
  const patch = {
    route_stats_snapshot: snapshot,
    route_stats_trained_at: now,
    route_training_version: ROUTE_TRAINING_VERSION,
    route_quality_outcomes: Number(snapshot.route_quality_outcomes) || 0,
    updated_at: now,
  };
  if (route_weights && typeof route_weights === 'object' && Object.keys(route_weights).length) {
    patch.route_weights = { ...route_weights };
  }
  if (activate) patch.route_mode = 'cost_quality';

  if (existing && existing.id) {
    update(ROUTE_NAMESPACE_TABLE, (r) => r.id === existing.id, patch);
    return { ...existing, ...patch };
  }

  const row = {
    id: storeId('ns'),
    tenant,
    slug: nsSlug,
    display_name: nsSlug,
    description: null,
    capture_mode: 'detect_only',
    redact_mode: 'detect_only',
    route_chain: null,
    confidence_threshold: 0.7,
    route_mode: activate ? 'cost_quality' : 'static',
    cache_mode: 'off',
    guardrail_mode: 'detect_only',
    artifact_id: null,
    artifact_history: [],
    status: 'active',
    created_at: now,
    ...patch,
  };
  insert(ROUTE_NAMESPACE_TABLE, row);
  return row;
}

export async function recordRouteOutcomeFromDispatch({
  tenant,
  namespace = 'default',
  routerDecision = null,
  result = null,
  attemptedEntry = null,
  prompt_text = null,
  cost = 0,
  latency_ms = 0,
  receipt_id = null,
  now = null,
} = {}) {
  const clusterId = routerDecision && routerDecision.cluster_id != null
    ? routerDecision.cluster_id
    : null;
  if (clusterId == null || Number(clusterId) < 0) {
    return { ok: false, skipped: true, reason: 'missing_cluster_id' };
  }
  const model = (attemptedEntry && attemptedEntry.model) || (result && result.model) || '';
  const provider = (result && result.provider) || (attemptedEntry && attemptedEntry.provider) || null;
  const status = Number(result && result.status);
  const win = Number.isFinite(status) ? (status >= 200 && status < 500 && status !== 429) : undefined;
  const row = await recordRouteOutcome({
    tenant,
    namespace,
    cluster_id: clusterId,
    model,
    provider,
    prompt_text,
    realized_quality: null,
    win,
    cost,
    latency_ms,
    receipt_id,
    now,
  });
  return { ok: true, row };
}

export default {
  ROUTE_TRAINING_VERSION,
  ROUTE_NAMESPACE_TABLE,
  mergeRouteQualitySnapshot,
  loadRouteStatsForNamespace,
  buildRouteTrainingSnapshot,
  persistRouteTrainingSnapshot,
  recordRouteOutcomeFromDispatch,
  clearRouteStatsCacheForTests,
};
