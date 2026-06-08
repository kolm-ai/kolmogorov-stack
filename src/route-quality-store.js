// W921 NEXT-6 - route-quality-store: persist the routing QUALITY label + the
// (redacted) prompt context so the semantic router's quality term can be
// TRAINED instead of cold-started.
//
// THE GAP (KOLM_W921_FRONTIER_REVIEW.md, NEXT-6):
//   src/semantic-router.js already SCORES a quality term per (cluster, model),
//   but nothing persists the realized per-cluster OUTCOME, so the term ships
//   cold-started - `trainClustersFromLake` can only fall back to a weak
//   accepted/transport-ok win. This module closes that loop: every realized
//   route outcome (was the cheap model actually good enough?) lands as a
//   durable, tenant-fenced row, and `getClusterQualityStats` reads them back
//   in EXACTLY the shape `ClusterRouterStats` consumes (per-(cluster,model)
//   n / wins / sum_cost / sum_latency + means), lighting up the quality term.
//
// DESIGN (mirrors src/routing-events.js, the established dual-write pattern):
//   - We REUSE the canonical event-store (src/event-store.js appendEvent) as
//     the durable sink - no new storage engine, no new schema. The event
//     schema (src/event-schema.js) is CLOSED: any field outside EVENT_FIELDS
//     is silently dropped by canonicalize(). So the structured route-quality
//     payload (cluster_id, realized_quality, model, prompt context, the win
//     label) is stamped into the one free-form field the schema preserves:
//     `feedback` (a 4096-char string). The numeric signals that DO have a home
//     on the schema (estimated_cost_usd, latency_ms) are ALSO written to those
//     columns so billing/lake roll-ups stay coherent.
//   - DISTINCT PROVIDER TAG: every row uses provider/vendor/workflow_id tags
//     unique to this module (`kolm-route-quality`, workflow `route-quality:<ns>`)
//     so getClusterQualityStats can read back ONLY route-quality rows and never
//     confuse them with live dispatch observations or W709 routing decisions.
//   - TENANT FENCE: recordRouteOutcome refuses a tenant-less write (mirrors
//     recordRoutingDecision); getClusterQualityStats forwards tenant_id to
//     listEvents (which filters at the SQL/JSONL source) AND re-checks tenant
//     in-process as defense-in-depth. A foreign tenant's outcome can never
//     enter another tenant's stats.
//
// DETERMINISM CONTRACT (this whole codebase's house rule):
//   - Core logic accepts the clock as a parameter (`now`) and NEVER reads
//     wall-clock or a global RNG. recordRouteOutcome stamps the caller's `now`
//     (defaults to a fixed sentinel only when omitted, see _nowIso).
//   - getClusterQualityStats / trainRouteWeights are pure functions of the
//     rows they read - same rows in, same stats/weights out, byte-for-byte.
//   - No signing happens here (we persist, we do not seal). If a caller wants
//     a signed receipt of an outcome they sign elsewhere with src/ed25519.js;
//     this module deliberately stays a plain durable store.
//
// PUBLIC API:
//   recordRouteOutcome({tenant, namespace, cluster_id, model, prompt_text,
//                       realized_quality, cost, latency_ms, now, ...})
//        -> the persisted event row (or throws on a tenant-less write).
//   getClusterQualityStats({tenant, namespace, models?, max_rows?})
//        -> { cells, snapshot, n, by_cluster_model }  (see shape below).
//   trainRouteWeights({tenant, namespace, ...} | {stats})
//        -> { route_weights, basis }  suggested weights for the router.

import { appendEvent, listEvents } from './event-store.js';

// Provenance tags that fence route-quality rows off from every other row in
// the lake. getClusterQualityStats reads back rows whose provider matches
// ROUTE_QUALITY_PROVIDER, so a regular dispatch observation (provider:'openai')
// or a W709 routing decision (provider:'kolm-router-student') is never mistaken
// for a route-quality outcome.
export const ROUTE_QUALITY_PROVIDER = 'kolm-route-quality';
export const ROUTE_QUALITY_WORKFLOW_PREFIX = 'route-quality:';
// Stamped into the feedback JSON so a reader can positively identify the row
// kind even if the provider tag is ever reused.
export const ROUTE_QUALITY_KIND = 'route_quality_outcome';
export const ROUTE_QUALITY_VERSION = 'w921-rq-v1';

// A win is realized_quality at/above this bar. Kept as a module constant (not a
// magic number) and overridable per-call so a namespace can tune the bar.
export const DEFAULT_WIN_THRESHOLD = 0.5;

// --------------------------------------------------------------------------
// small pure helpers (no clock / no RNG).
// --------------------------------------------------------------------------
function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// stable per-(provider,model) -> ClusterRouterStats keys on the bare MODEL
// string (see _cell/_aggregate in semantic-router.js), so the snapshot we hand
// back keys cells by model. We still RECORD provider for the audit row.
function _modelKey(model) {
  return String(model == null ? '' : model);
}

// Bounded, redaction-aware prompt context. The router does NOT need the raw
// prompt - only enough to (a) re-embed for clustering and (b) audit. We store
// the caller-supplied text TRUNCATED; callers are expected to pass already-
// redacted text (prompt_redacted), matching the lake's redaction contract. We
// never widen privacy: the cap here is below the schema's prompt_redacted cap.
const PROMPT_CONTEXT_CAP = 4000;
function _promptContext(text) {
  if (text == null) return null;
  const s = String(text);
  return s.length > PROMPT_CONTEXT_CAP ? s.slice(0, PROMPT_CONTEXT_CAP) : s;
}

// A deterministic ISO timestamp. Core callers MUST pass `now` (epoch ms or ISO
// string) to stay reproducible; we only fall back to a FIXED sentinel (never
// Date.now()) when omitted, so a test that forgets `now` is still deterministic
// rather than silently flaky. Production callers always pass a real clock.
const _SENTINEL_ISO = '1970-01-01T00:00:00.000Z';
function _nowIso(now) {
  if (now == null) return _SENTINEL_ISO;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
  const s = String(now);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : _SENTINEL_ISO;
}

// --------------------------------------------------------------------------
// recordRouteOutcome - persist ONE realized per-(cluster,model) outcome.
//
//   tenant            REQUIRED. Tenant fence; a tenant-less write throws.
//   namespace         routing namespace (default 'default').
//   cluster_id        the assigned cluster id (int >= 0) from the router.
//   model             the model that actually served (bare model string).
//   provider          the provider that served (recorded for audit; the
//                     ClusterRouterStats cell keys on model, matching the
//                     router's own _cell()).
//   prompt_text       redacted prompt context (re-embeddable for clustering).
//   realized_quality  the judged/realized quality in [0,1] (e.g. K-Score judge
//                     win prob, acceptance, or a graded score). null => the
//                     outcome counts toward n but contributes no win (matches
//                     ClusterRouterStats.update's won:null semantics).
//   win               optional explicit boolean win label; when omitted it is
//                     derived from realized_quality >= win_threshold.
//   win_threshold     bar for deriving win from realized_quality.
//   cost              measured USD cost (0/absent => unknown, not free).
//   latency_ms        measured wall latency in ms.
//   receipt_id        optional linkage to the signed receipt for this call.
//   now               clock (epoch ms or ISO). Deterministic; see _nowIso.
//
// Returns the persisted event row. Throws {code:'missing_tenant'} on a
// tenant-less write so the caller cannot silently leak across the fence.
// --------------------------------------------------------------------------
export async function recordRouteOutcome({
  tenant,
  namespace = 'default',
  cluster_id = null,
  model = '',
  provider = null,
  prompt_text = null,
  realized_quality = null,
  win = undefined,
  win_threshold = DEFAULT_WIN_THRESHOLD,
  cost = 0,
  latency_ms = 0,
  receipt_id = null,
  now = null,
} = {}) {
  if (!tenant) {
    const err = new Error('route_outcome_missing_tenant');
    err.code = 'missing_tenant';
    throw err;
  }
  const ns = String(namespace || 'default').slice(0, 128);
  const cid = (cluster_id == null || !Number.isFinite(Number(cluster_id)) || Number(cluster_id) < 0)
    ? null
    : Math.trunc(Number(cluster_id));
  const modelStr = _modelKey(model);

  // Quality label policy: realized_quality is the source of truth in [0,1].
  // The boolean `win` is either caller-supplied or derived from the threshold.
  // A null realized_quality with no explicit win => null win (no win credit).
  let rq = null;
  if (realized_quality != null && Number.isFinite(Number(realized_quality))) {
    rq = _clamp01(realized_quality);
  }
  let winLabel = null;
  if (win === true || win === false) {
    winLabel = win;
  } else if (rq != null) {
    winLabel = rq >= _clamp01(win_threshold);
  }

  const costUsd = Math.max(0, _num(cost, 0));
  const latMs = Math.max(0, Math.trunc(_num(latency_ms, 0)));
  const createdAt = _nowIso(now);

  // The structured route-quality payload - every field the router/training loop
  // needs, stamped into the one free-form schema field (`feedback`). cluster_id
  // / realized_quality / win / model live ONLY here (the closed schema has no
  // column for them), so getClusterQualityStats parses this back out.
  const payload = {
    kind: ROUTE_QUALITY_KIND,
    version: ROUTE_QUALITY_VERSION,
    cluster_id: cid,
    model: modelStr,
    provider: provider == null ? null : String(provider).slice(0, 64),
    realized_quality: rq,
    win: winLabel,
    cost_usd: costUsd,
    latency_ms: latMs,
    receipt_id: receipt_id == null ? null : String(receipt_id).slice(0, 128),
  };

  const row = await appendEvent({
    tenant_id: tenant,
    namespace: ns,
    provider: ROUTE_QUALITY_PROVIDER,
    vendor: 'kolm',
    model: modelStr || 'route-quality',
    workflow_id: ROUTE_QUALITY_WORKFLOW_PREFIX + ns,
    // prompt context: redacted + bounded, re-embeddable for clustering.
    prompt_redacted: _promptContext(prompt_text),
    // numeric signals that HAVE a home on the schema -> their columns (so lake
    // roll-ups stay coherent) AND the feedback payload (so the reader is
    // self-contained without joining columns).
    estimated_cost_usd: costUsd,
    latency_ms: latMs,
    status: 'ok',
    created_at: createdAt,
    feedback: JSON.stringify(payload),
  });
  return row;
}

// Parse a persisted event row back into a route-quality outcome, or null when
// the row is not a route-quality row (wrong provider / unparsable feedback).
// Pure; tenant fence is applied by the caller against `expectedTenant`.
function _parseOutcomeRow(row, expectedTenant) {
  if (!row || typeof row !== 'object') return null;
  if (row.provider !== ROUTE_QUALITY_PROVIDER) return null;
  // Defense-in-depth tenant fence (listEvents already filters by tenant_id).
  if (expectedTenant && row.tenant_id !== expectedTenant) return null;
  let payload = null;
  try { payload = JSON.parse(row.feedback || 'null'); } catch { payload = null; }
  if (!payload || payload.kind !== ROUTE_QUALITY_KIND) return null;
  const cid = (payload.cluster_id == null || !Number.isFinite(Number(payload.cluster_id)))
    ? null
    : Math.trunc(Number(payload.cluster_id));
  if (cid == null || cid < 0) return null; // un-clusterable outcome -> not aggregatable
  return {
    cluster_id: cid,
    model: _modelKey(payload.model),
    provider: payload.provider == null ? null : String(payload.provider),
    realized_quality: (payload.realized_quality == null || !Number.isFinite(Number(payload.realized_quality)))
      ? null : _clamp01(payload.realized_quality),
    win: payload.win === true ? true : (payload.win === false ? false : null),
    // Prefer the schema column (canonical) but fall back to the payload copy.
    cost_usd: Math.max(0, _num(row.estimated_cost_usd != null ? row.estimated_cost_usd : payload.cost_usd, 0)),
    latency_ms: Math.max(0, Math.trunc(_num(row.latency_ms != null ? row.latency_ms : payload.latency_ms, 0))),
    namespace: row.namespace,
    created_at: row.created_at,
  };
}

// --------------------------------------------------------------------------
// getClusterQualityStats - read back this tenant's route-quality outcomes and
// fold them into per-(cluster,model) running stats in EXACTLY the shape
// src/semantic-router.js ClusterRouterStats consumes.
//
//   tenant     REQUIRED tenant fence (returns empty when absent).
//   namespace  restrict to one routing namespace (optional).
//   models     optional whitelist of bare model strings to include.
//   max_rows   cap the number of lake rows scanned (default 50000).
//
// Returns a deterministic object:
//   {
//     n,                       total outcomes folded in
//     by_cluster_model: {      friendly per-cell means
//       [cluster_id]: { [model]: { n, wins, accuracy,
//                                  mean_quality, mean_cost, mean_latency } } },
//     cells: [ { cluster_id, model, n, wins, accuracy,
//                mean_quality, mean_cost, mean_latency } ],   // flat list
//     snapshot: {              ClusterRouterStats.restore-compatible
//       stats: { [cluster_id]: { [model]: { n, wins, sum_cost, sum_latency } } }
//     },
//   }
//
// The `snapshot.stats` shape is byte-compatible with what
// ClusterRouterStats.snapshot() emits and ClusterRouterStats.restore()
// ingests, so a caller can do:
//   const cqs = await getClusterQualityStats({tenant, namespace});
//   const stats = ClusterRouterStats.restore({ ...trainedCentroidSnapshot,
//                                              stats: cqs.snapshot.stats });
// merging the LEARNED quality/cost/latency cells onto already-trained centroids.
//
// Pure given the rows it reads (no clock / no RNG). Deterministic ordering:
// clusters ascending, models lexicographic.
// --------------------------------------------------------------------------
export async function getClusterQualityStats({
  tenant,
  namespace = null,
  models = null,
  max_rows = 50000,
} = {}) {
  const empty = { n: 0, by_cluster_model: {}, cells: [], snapshot: { stats: {} } };
  if (!tenant) return empty;

  const limit = Math.max(0, Math.trunc(_num(max_rows, 50000)));
  const rows = await listEvents({
    tenant_id: tenant,
    namespace: namespace || undefined,
    provider: ROUTE_QUALITY_PROVIDER, // server-side fence to our rows only
    limit,
    order: 'asc', // ascending so identical corpora fold in identical order
  });

  const modelFilter = Array.isArray(models) && models.length
    ? new Set(models.map((m) => _modelKey(m)))
    : null;

  // cluster_id -> model -> running aggregate
  const agg = new Map();
  let total = 0;
  for (const row of rows || []) {
    const o = _parseOutcomeRow(row, tenant);
    if (!o) continue;
    if (modelFilter && !modelFilter.has(o.model)) continue;
    let byModel = agg.get(o.cluster_id);
    if (!byModel) { byModel = new Map(); agg.set(o.cluster_id, byModel); }
    let cell = byModel.get(o.model);
    if (!cell) {
      cell = { n: 0, wins: 0, sum_cost: 0, n_cost: 0, sum_latency: 0, n_latency: 0, sum_quality: 0, n_quality: 0 };
      byModel.set(o.model, cell);
    }
    cell.n += 1;
    total += 1;
    if (o.win === true) cell.wins += 1;
    if (o.cost_usd > 0) { cell.sum_cost += o.cost_usd; cell.n_cost += 1; }
    if (o.latency_ms >= 0 && o.latency_ms > 0) { cell.sum_latency += o.latency_ms; cell.n_latency += 1; }
    if (o.realized_quality != null) { cell.sum_quality += o.realized_quality; cell.n_quality += 1; }
  }

  const by_cluster_model = {};
  const cells = [];
  const snapStats = {};
  // Deterministic ordering: clusters ascending, models lexicographic.
  const clusterIds = [...agg.keys()].sort((a, b) => a - b);
  for (const cid of clusterIds) {
    const byModel = agg.get(cid);
    const modelNames = [...byModel.keys()].sort();
    const friendly = {};
    const snapModels = {};
    for (const model of modelNames) {
      const c = byModel.get(model);
      const accuracy = c.n > 0 ? c.wins / c.n : 0;
      const mean_quality = c.n_quality > 0 ? c.sum_quality / c.n_quality : null;
      const mean_cost = c.n_cost > 0 ? c.sum_cost / c.n_cost : null;
      const mean_latency = c.n_latency > 0 ? c.sum_latency / c.n_latency : null;
      const friendlyCell = { n: c.n, wins: c.wins, accuracy, mean_quality, mean_cost, mean_latency };
      friendly[model] = friendlyCell;
      cells.push({ cluster_id: cid, model, ...friendlyCell });
      // ClusterRouterStats.restore-compatible cell: it stores running SUMS
      // (sum_cost / sum_latency) + n + wins; means are derived by _aggregate.
      snapModels[model] = { n: c.n, wins: c.wins, sum_cost: c.sum_cost, sum_latency: c.sum_latency };
    }
    by_cluster_model[cid] = friendly;
    snapStats[cid] = snapModels;
  }

  return { n: total, by_cluster_model, cells, snapshot: { stats: snapStats } };
}

// --------------------------------------------------------------------------
// trainRouteWeights - derive a SUGGESTED route_weights object (the multi-signal
// blend weights src/semantic-router.js normalizeRouteWeights/scoreRoute
// consume) from the realized outcomes.
//
// Intuition (deterministic, no learning loop required): a signal only deserves
// weight if it actually DISCRIMINATES between the candidate models within a
// cluster. We measure each signal's discriminative SPREAD across models and set
// its weight proportional to that spread, so:
//   - quality gets weight when models differ in realized accuracy/quality,
//   - cost gets weight when models differ materially in cost,
//   - latency gets weight when models differ materially in latency.
// A signal with no spread (all models identical, or no data) gets weight 0 and
// is dropped by normalizeRouteWeights -> the router ignores it. This guarantees
// the suggestion never fabricates a preference on a signal it cannot measure.
//
// Inputs (either form):
//   { tenant, namespace, models?, max_rows? }   -> reads via getClusterQualityStats
//   { stats }                                    -> a precomputed getClusterQualityStats result
//   min_samples  per-cell sample floor before a cell counts toward spread.
//   quality_floor / cost_floor / latency_floor  minimum weight for a present,
//                discriminating signal (keeps quality always >0 when measured).
//
// Returns { route_weights, basis } where basis records the per-signal measured
// spread + how many (cluster,model) cells contributed, so the suggestion is
// auditable. route_weights is rounded to 6dp for stable serialization.
// --------------------------------------------------------------------------
export async function trainRouteWeights({
  tenant,
  namespace = null,
  models = null,
  max_rows = 50000,
  stats = null,
  min_samples = 1,
  quality_floor = 0.0,
} = {}) {
  const cqs = stats && stats.cells
    ? stats
    : await getClusterQualityStats({ tenant, namespace, models, max_rows });

  // Group cells by cluster; per cluster measure the spread (max-min across
  // models) of each signal, then average the per-cluster spreads. Spreads are
  // normalized to [0,1] so cross-signal magnitudes are comparable:
  //   quality spread: already in [0,1] units (accuracy / realized_quality).
  //   cost spread:    relative spread (max-min)/max, in [0,1].
  //   latency spread: relative spread (max-min)/max, in [0,1].
  const byCluster = new Map();
  for (const cell of (cqs.cells || [])) {
    if (cell.n < Math.max(0, Math.trunc(_num(min_samples, 1)))) continue;
    let arr = byCluster.get(cell.cluster_id);
    if (!arr) { arr = []; byCluster.set(cell.cluster_id, arr); }
    arr.push(cell);
  }

  const spreads = { quality: [], cost: [], latency: [] };
  let cellsUsed = 0;
  for (const arr of byCluster.values()) {
    if (arr.length < 2) { cellsUsed += arr.length; continue; } // need >=2 models to have spread
    cellsUsed += arr.length;
    // quality: prefer mean_quality, fall back to accuracy.
    const q = arr.map((c) => (c.mean_quality != null ? c.mean_quality : c.accuracy)).filter((v) => Number.isFinite(v));
    if (q.length >= 2) spreads.quality.push(_relSpread(q, false));
    const cost = arr.map((c) => c.mean_cost).filter((v) => v != null && Number.isFinite(v));
    if (cost.length >= 2) spreads.cost.push(_relSpread(cost, true));
    const lat = arr.map((c) => c.mean_latency).filter((v) => v != null && Number.isFinite(v));
    if (lat.length >= 2) spreads.latency.push(_relSpread(lat, true));
  }

  const meanSpread = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const qSpread = meanSpread(spreads.quality);
  const cSpread = meanSpread(spreads.cost);
  const lSpread = meanSpread(spreads.latency);

  const route_weights = {};
  // quality: always present when measured (floor keeps it >0 so the router
  // never drops the bar entirely once any quality data exists).
  const qFloorVal = _clamp01(quality_floor);
  const qWeight = qSpread > 0 ? Math.max(qSpread, qFloorVal) : (cqs.n > 0 ? qFloorVal : 0);
  if (qWeight > 0) route_weights.quality = Number(qWeight.toFixed(6));
  if (cSpread > 0) route_weights.cost = Number(cSpread.toFixed(6));
  if (lSpread > 0) route_weights.latency = Number(lSpread.toFixed(6));

  return {
    route_weights,
    basis: {
      n: cqs.n,
      cells_used: cellsUsed,
      clusters: byCluster.size,
      quality_spread: Number(qSpread.toFixed(6)),
      cost_spread: Number(cSpread.toFixed(6)),
      latency_spread: Number(lSpread.toFixed(6)),
    },
  };
}

// Relative spread of a set of values in [0,1].
//   relative=false: absolute spread (max-min), already-[0,1] inputs (quality).
//   relative=true:  (max-min)/max, scale-free (cost/latency in arbitrary units).
// Returns 0 for degenerate inputs (length<2, all-equal, non-positive max).
function _relSpread(values, relative) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  const span = hi - lo;
  if (!(span > 0)) return 0;
  if (!relative) return _clamp01(span);
  if (!(hi > 0)) return 0;
  return _clamp01(span / hi);
}

export default {
  recordRouteOutcome,
  getClusterQualityStats,
  trainRouteWeights,
  ROUTE_QUALITY_PROVIDER,
  ROUTE_QUALITY_WORKFLOW_PREFIX,
  ROUTE_QUALITY_KIND,
  ROUTE_QUALITY_VERSION,
  DEFAULT_WIN_THRESHOLD,
};
