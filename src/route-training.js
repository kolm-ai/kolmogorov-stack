// W608/W988 - live semantic-routing training loop.
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

export const ROUTE_TRAINING_VERSION = 'w988-route-training-v2';
export const ROUTE_NAMESPACE_TABLE = 'wrapper_namespaces';
export const ROUTE_STATS_CACHE_MS = 30_000;
export const DEFAULT_ROUTE_RETRAIN_POLICY = Object.freeze({
  enabled: true,
  min_interval_ms: 6 * 60 * 60 * 1000,
  max_snapshot_age_ms: 7 * 24 * 60 * 60 * 1000,
  min_trained_rows: 16,
  min_route_quality_outcomes: 4,
  min_new_quality_outcomes: 1,
  min_route_weight_signals: 1,
  min_cluster_model_cells: 1,
});

const _statsCache = new Map();

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _bool(v, fallback = false) {
  if (v === true || v === false) return v;
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function _iso(now) {
  if (now == null) return new Date().toISOString();
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
  const t = Date.parse(String(now));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

function _ms(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const t = Date.parse(String(now));
  return Number.isFinite(t) ? t : Date.now();
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

function _object(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function _policySource(policy, namespaceConfig) {
  if (policy && typeof policy === 'object') return policy;
  const cfg = _object(namespaceConfig);
  return cfg.route_retrain_policy || cfg.route_training_policy || cfg.route_promotion_policy || {};
}

function _clampMs(v, fallback) {
  return Math.max(0, Math.trunc(_num(v, fallback)));
}

function _clampInt(v, fallback) {
  return Math.max(0, Math.trunc(_num(v, fallback)));
}

function _existingQualityOutcomes(namespaceConfig) {
  const cfg = _object(namespaceConfig);
  const direct = _num(cfg.route_quality_outcomes, NaN);
  if (Number.isFinite(direct)) return Math.max(0, Math.trunc(direct));
  const snap = _object(cfg.route_stats_snapshot);
  return Math.max(0, Math.trunc(_num(snap.route_quality_outcomes, 0)));
}

function _snapshotTrainedAt(namespaceConfig) {
  const cfg = _object(namespaceConfig);
  return cfg.route_stats_trained_at || _object(cfg.route_stats_snapshot).trained_at || null;
}

function _countRouteWeightSignals(routeWeights) {
  const rw = _object(routeWeights);
  return Object.keys(rw).filter((k) => Number(rw[k]) > 0).length;
}

function _countClusterModelCells(snapshot) {
  const stats = _object(_object(snapshot).stats);
  let n = 0;
  for (const cid of Object.keys(stats)) {
    const byModel = _object(stats[cid]);
    n += Object.keys(byModel).length;
  }
  return n;
}

function _findNamespaceRow(tenant, namespace) {
  const nsSlug = _cleanNamespace(namespace);
  const rows = findByTenant(ROUTE_NAMESPACE_TABLE, tenant) || [];
  return rows.find((r) => r && r.slug === nsSlug) || null;
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

export function normalizeRouteRetrainPolicy(policy = null, namespaceConfig = null) {
  const src = _policySource(policy, namespaceConfig);
  const base = DEFAULT_ROUTE_RETRAIN_POLICY;
  return {
    version: ROUTE_TRAINING_VERSION,
    enabled: _bool(src.enabled, base.enabled),
    min_interval_ms: _clampMs(src.min_interval_ms ?? src.interval_ms ?? src.cadence_ms, base.min_interval_ms),
    max_snapshot_age_ms: _clampMs(src.max_snapshot_age_ms ?? src.max_age_ms, base.max_snapshot_age_ms),
    min_trained_rows: _clampInt(src.min_trained_rows ?? src.min_rows, base.min_trained_rows),
    min_route_quality_outcomes: _clampInt(src.min_route_quality_outcomes ?? src.min_outcomes, base.min_route_quality_outcomes),
    min_new_quality_outcomes: _clampInt(src.min_new_quality_outcomes ?? src.min_new_outcomes, base.min_new_quality_outcomes),
    min_route_weight_signals: _clampInt(src.min_route_weight_signals ?? src.min_weight_signals, base.min_route_weight_signals),
    min_cluster_model_cells: _clampInt(src.min_cluster_model_cells ?? src.min_cells, base.min_cluster_model_cells),
  };
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
  now = null,
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
  snapshot.trained_at = _iso(now);
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

export function planRouteRetrain({
  namespaceConfig = {},
  policy = null,
  latest_route_quality_outcomes = null,
  now = Date.now(),
  force = false,
} = {}) {
  const pol = normalizeRouteRetrainPolicy(policy, namespaceConfig);
  const cfg = _object(namespaceConfig);
  const nowMs = _ms(now);
  const currentOutcomes = _existingQualityOutcomes(cfg);
  const latestOutcomes = Math.max(0, Math.trunc(_num(latest_route_quality_outcomes, currentOutcomes)));
  const outcomeDelta = Math.max(0, latestOutcomes - currentOutcomes);
  const trainedAt = _snapshotTrainedAt(cfg);
  const trainedAtMs = trainedAt ? Date.parse(String(trainedAt)) : NaN;
  const ageMs = Number.isFinite(trainedAtMs) ? Math.max(0, nowMs - trainedAtMs) : null;
  const hasSnapshot = _hasCentroids(cfg.route_stats_snapshot);

  const out = {
    ok: true,
    due: false,
    reason: 'cadence_not_due',
    policy: pol,
    metrics: {
      current_route_quality_outcomes: currentOutcomes,
      latest_route_quality_outcomes: latestOutcomes,
      route_quality_outcome_delta: outcomeDelta,
      last_trained_at: trainedAt || null,
      snapshot_age_ms: ageMs,
      has_route_stats_snapshot: hasSnapshot,
    },
  };
  if (!pol.enabled) return { ...out, reason: 'policy_disabled' };
  if (force) return { ...out, due: true, reason: 'force' };
  if (!hasSnapshot) return { ...out, due: true, reason: 'missing_route_stats_snapshot' };
  if (ageMs == null) return { ...out, due: true, reason: 'missing_route_stats_trained_at' };
  if (pol.max_snapshot_age_ms > 0 && ageMs >= pol.max_snapshot_age_ms) {
    return { ...out, due: true, reason: 'snapshot_stale' };
  }
  if (pol.min_interval_ms > 0 && ageMs < pol.min_interval_ms) return out;
  if (outcomeDelta >= pol.min_new_quality_outcomes) {
    return { ...out, due: true, reason: 'new_quality_outcomes_ready' };
  }
  if (pol.min_new_quality_outcomes === 0) {
    return { ...out, due: true, reason: 'cadence_due' };
  }
  return { ...out, reason: 'quality_delta_not_met' };
}

export function evaluateRouteSnapshotPromotion({
  candidate = null,
  namespaceConfig = {},
  policy = null,
  now = Date.now(),
  force = false,
} = {}) {
  const pol = normalizeRouteRetrainPolicy(policy, namespaceConfig);
  const env = _object(candidate);
  const snapshot = env.snapshot;
  const routeWeights = env.route_weights;
  const metrics = {
    trained_rows: Math.max(0, Math.trunc(_num(env.trained_rows, 0))),
    route_quality_outcomes: Math.max(0, Math.trunc(_num(env.route_quality_outcomes, _object(snapshot).route_quality_outcomes || 0))),
    route_weight_signal_count: _countRouteWeightSignals(routeWeights),
    cluster_model_cells: _countClusterModelCells(snapshot),
    previous_route_quality_outcomes: _existingQualityOutcomes(namespaceConfig),
    previous_trained_at: _snapshotTrainedAt(namespaceConfig),
    evaluated_at: _iso(now),
  };
  metrics.route_quality_outcome_delta = Math.max(0, metrics.route_quality_outcomes - metrics.previous_route_quality_outcomes);

  const base = {
    ok: true,
    promote: false,
    reason: 'promotion_gate_failed',
    policy: pol,
    metrics,
  };
  if (!pol.enabled) return { ...base, reason: 'policy_disabled' };
  if (!env.ok) return { ...base, reason: 'candidate_not_ok' };
  if (!_hasCentroids(snapshot)) return { ...base, reason: 'missing_candidate_centroids' };
  if (force) return { ...base, promote: true, reason: 'force' };
  if (metrics.trained_rows < pol.min_trained_rows) return { ...base, reason: 'insufficient_training_rows' };
  if (metrics.route_quality_outcomes < pol.min_route_quality_outcomes) return { ...base, reason: 'insufficient_route_quality_outcomes' };
  if (metrics.route_weight_signal_count < pol.min_route_weight_signals) return { ...base, reason: 'insufficient_route_weight_signals' };
  if (metrics.cluster_model_cells < pol.min_cluster_model_cells) return { ...base, reason: 'insufficient_cluster_model_cells' };
  return { ...base, promote: true, reason: 'promotion_gates_passed' };
}

export async function persistRouteTrainingSnapshot({
  tenant,
  namespace = 'default',
  snapshot,
  route_weights = null,
  activate = false,
  promotion = null,
  policy = null,
  now = null,
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

  const existing = _findNamespaceRow(tenant, nsSlug);
  const nowIso = _iso(now);
  const patch = {
    route_stats_snapshot: snapshot,
    route_stats_trained_at: nowIso,
    route_training_version: ROUTE_TRAINING_VERSION,
    route_quality_outcomes: Number(snapshot.route_quality_outcomes) || 0,
    updated_at: nowIso,
  };
  const normalizedPolicy = policy ? normalizeRouteRetrainPolicy(policy, existing || {}) : null;
  if (normalizedPolicy) patch.route_retrain_policy = normalizedPolicy;
  if (route_weights && typeof route_weights === 'object' && Object.keys(route_weights).length) {
    patch.route_weights = { ...route_weights };
  }
  if (activate) patch.route_mode = 'cost_quality';
  if (existing && _hasCentroids(existing.route_stats_snapshot)) {
    patch.route_stats_previous_snapshot = existing.route_stats_snapshot;
    patch.route_weights_previous = existing.route_weights && typeof existing.route_weights === 'object'
      ? { ...existing.route_weights }
      : null;
    patch.route_mode_previous = existing.route_mode || null;
    patch.route_stats_previous_trained_at = existing.route_stats_trained_at || null;
    patch.route_training_rollback_available = true;
  }
  if (promotion && typeof promotion === 'object') {
    patch.route_training_promotion = {
      version: ROUTE_TRAINING_VERSION,
      promoted: promotion.promote === true,
      reason: promotion.reason || null,
      metrics: promotion.metrics || {},
      policy: normalizedPolicy || promotion.policy || null,
      evaluated_at: promotion.metrics && promotion.metrics.evaluated_at || nowIso,
    };
    if (promotion.promote === true) patch.route_training_promoted_at = nowIso;
  }

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
    created_at: nowIso,
    ...patch,
  };
  insert(ROUTE_NAMESPACE_TABLE, row);
  return row;
}

export async function runRouteRetrainPromotion({
  tenant,
  namespace = 'default',
  namespaceConfig = null,
  k = 32,
  max_rows = 50_000,
  activate = true,
  force = false,
  dry_run = false,
  policy = null,
  now = null,
} = {}) {
  if (!tenant) {
    const err = new Error('route_train_missing_tenant');
    err.code = 'missing_tenant';
    throw err;
  }
  const ns = _cleanNamespace(namespace);
  const cfg = namespaceConfig || _findNamespaceRow(tenant, ns) || {};
  const effectivePolicy = normalizeRouteRetrainPolicy(policy, cfg);
  const candidate = await buildRouteTrainingSnapshot({ tenant, namespace: ns, k, max_rows, now });
  const promotion = evaluateRouteSnapshotPromotion({
    candidate,
    namespaceConfig: cfg,
    policy: effectivePolicy,
    now,
    force,
  });
  let saved = null;
  if (promotion.promote && !dry_run) {
    saved = await persistRouteTrainingSnapshot({
      tenant,
      namespace: ns,
      snapshot: candidate.snapshot,
      route_weights: candidate.route_weights,
      activate,
      promotion,
      policy: effectivePolicy,
      now,
    });
  }
  return {
    ...candidate,
    promotion,
    persisted: !!saved,
    activated: !!(saved && saved.route_mode === 'cost_quality'),
    namespace_row_id: saved && saved.id || null,
  };
}

export async function runDueRouteRetraining({
  tenant,
  namespaces = null,
  k = 32,
  max_rows = 50_000,
  activate = true,
  force = false,
  dry_run = false,
  policy = null,
  now = Date.now(),
} = {}) {
  if (!tenant) {
    const err = new Error('route_retrain_missing_tenant');
    err.code = 'missing_tenant';
    throw err;
  }
  const filter = Array.isArray(namespaces) && namespaces.length
    ? new Set(namespaces.map((n) => _cleanNamespace(n)))
    : null;
  const rows = (findByTenant(ROUTE_NAMESPACE_TABLE, tenant) || [])
    .filter((r) => r && r.status !== 'deleted')
    .filter((r) => !filter || filter.has(_cleanNamespace(r.slug)));

  const results = [];
  for (const row of rows) {
    const ns = _cleanNamespace(row.slug);
    const qualityStats = await getClusterQualityStats({ tenant, namespace: ns, max_rows });
    const plan = planRouteRetrain({
      namespaceConfig: row,
      policy: policy || row.route_retrain_policy,
      latest_route_quality_outcomes: qualityStats.n,
      now,
      force,
    });
    if (!plan.due) {
      results.push({ ok: true, namespace: ns, skipped: true, plan });
      continue;
    }
    const promoted = await runRouteRetrainPromotion({
      tenant,
      namespace: ns,
      namespaceConfig: row,
      k,
      max_rows,
      activate,
      force,
      dry_run,
      policy: plan.policy,
      now,
    });
    results.push({ ok: true, namespace: ns, skipped: false, plan, result: promoted });
  }
  return {
    ok: true,
    version: ROUTE_TRAINING_VERSION,
    tenant,
    scanned: rows.length,
    due: results.filter((r) => !r.skipped).length,
    promoted: results.filter((r) => r.result && r.result.promotion && r.result.promotion.promote).length,
    persisted: results.filter((r) => r.result && r.result.persisted).length,
    dry_run: !!dry_run,
    results,
  };
}

export async function rollbackRouteTrainingSnapshot({
  tenant,
  namespace = 'default',
  reason = 'manual_rollback',
  now = null,
} = {}) {
  if (!tenant) {
    const err = new Error('route_rollback_missing_tenant');
    err.code = 'missing_tenant';
    throw err;
  }
  const ns = _cleanNamespace(namespace);
  const existing = _findNamespaceRow(tenant, ns);
  if (!existing) return { ok: false, reason: 'missing_namespace', tenant, namespace: ns };
  const previous = existing.route_stats_previous_snapshot;
  if (!_hasCentroids(previous)) return { ok: false, reason: 'missing_previous_route_stats_snapshot', tenant, namespace: ns };
  const nowIso = _iso(now);
  const patch = {
    route_stats_snapshot: previous,
    route_stats_trained_at: existing.route_stats_previous_trained_at || _object(previous).trained_at || nowIso,
    route_weights: existing.route_weights_previous && typeof existing.route_weights_previous === 'object'
      ? { ...existing.route_weights_previous }
      : null,
    route_mode: existing.route_mode_previous || existing.route_mode || 'static',
    route_training_rollback_available: false,
    route_stats_previous_snapshot: null,
    route_weights_previous: null,
    route_mode_previous: null,
    route_stats_previous_trained_at: null,
    route_training_rollback: {
      version: ROUTE_TRAINING_VERSION,
      rolled_back_at: nowIso,
      reason: String(reason || 'manual_rollback').slice(0, 256),
      from_trained_at: existing.route_stats_trained_at || null,
      restored_trained_at: existing.route_stats_previous_trained_at || _object(previous).trained_at || null,
    },
    updated_at: nowIso,
  };
  update(ROUTE_NAMESPACE_TABLE, (r) => r.id === existing.id, patch);
  clearRouteStatsCacheForTests();
  return { ok: true, tenant, namespace: ns, row: { ...existing, ...patch } };
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
  DEFAULT_ROUTE_RETRAIN_POLICY,
  normalizeRouteRetrainPolicy,
  mergeRouteQualitySnapshot,
  loadRouteStatsForNamespace,
  buildRouteTrainingSnapshot,
  planRouteRetrain,
  evaluateRouteSnapshotPromotion,
  persistRouteTrainingSnapshot,
  runRouteRetrainPromotion,
  runDueRouteRetraining,
  rollbackRouteTrainingSnapshot,
  recordRouteOutcomeFromDispatch,
  clearRouteStatsCacheForTests,
};
