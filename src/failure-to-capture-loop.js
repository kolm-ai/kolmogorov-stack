// src/failure-to-capture-loop.js
//
// W816 - Failure-Mode -> Capture Recommendation Feedback Loop (T1).
//
// Glue module that closes the loop:
//
//   W812 (failure-modes)  ->  W816 (this)  ->  W815 (active-learning)
//                                            ->  W720 (self-improvement)
//
// W812 clusters captures and surfaces topic clusters where the student
// (compiled artifact) trails the teacher (raw upstream call) by some
// kscore_delta. W816 takes those failing clusters, projects them into the
// "gap" shape that W815.feedToSelfImprovement consumes, then writes one
// active_learning_gap row per failing cluster into the event-store. W720's
// detectUnderperformingCaptures sweep picks those rows up on its next
// iteration and seeds the re-distill candidates.
//
// Design notes:
//
//   1. NO new clustering. NO new analytics. This module only glues primitives
//      that already exist on disk. The math lives in W812; the storage shape
//      lives in W815; the orchestration lives in W720.
//
//   2. Tenant fence. The caller MUST supply tenant_id. We never read tenant
//      from process env (that footgun belongs to the CLI surface, not the
//      library). We pass tenant_id to clusterCaptures + feedToSelfImprovement
//      and we re-check it on every row we project (defense in depth, matches
//      the W411 trap).
//
//   3. Honest envelope on every error path. clusterCaptures() returning
//      {ok:false, error:'no_captures_to_cluster'} short-circuits us into
//      {ok:false, error:'no_captures', ...} - we never silently fabricate a
//      gap list. Same for "all clusters are healthy" - we return
//      {ok:true, fed_count:0, gaps:[]} with a hint so the caller can
//      distinguish "no work to do" from "system broken".
//
//   4. Synthetic gap shape. W815's feedToSelfImprovement consumes
//      {cluster_id, gap_score, recommended_count}. We synthesize gap_score
//      from the W812 kscore_delta + sample_count so failing-and-frequent
//      clusters surface first when W720's detector ranks candidates. The
//      formula is:
//
//          gap_score = kscore_delta * log10(1 + sample_count)
//
//      log10 dampens the sample_count factor so a handful of high-delta
//      failures still beat a wide-but-shallow one. The output is bounded
//      because kscore_delta <= 1.0 and sample_count is real-valued.
//
//   5. recommended_count is a function of kscore_delta and sample_count -
//      bigger regressions deserve more re-distill capture budget. We cap at
//      10 per cluster so one bad cluster cannot dominate a single distill
//      cycle (matches the W815 default-per-gap of 5; we bump to a max of 10
//      because a verified regression cluster has more signal than a generic
//      coverage gap).
//
//   6. version: 'w816-v1'. W604 anti-brittleness: every envelope carries the
//      version string; every test asserts via regex (/^w816-/), never
//      equality + explicit array.
//
// Exports:
//
//   - FAILURE_TO_CAPTURE_LOOP_VERSION
//   - feedFailureToActiveLearning({tenant, namespace, top_k, min_delta?,
//       window_days?, min_samples?})
//   - _synthesizeGap (test seam)

import { topRegressions } from './failure-modes.js';
import { feedToSelfImprovement } from './active-learning.js';

export const FAILURE_TO_CAPTURE_LOOP_VERSION = 'w816-v1';

// Cap per-cluster recommended_count so one cluster never drowns a distill
// cycle. 10 is the W815 DEFAULT_RECOMMENDED_PER_GAP * 2 - failing clusters
// from W812 carry more signal than generic coverage gaps, but we still want
// to give the orchestrator headroom for at least 5 distinct gap clusters per
// run before hitting a typical per-tenant per-day capture cap (~100 rows).
const MAX_RECOMMENDED_PER_CLUSTER = 10;

// Synthesize the {cluster_id, gap_score, recommended_count} record W815's
// feedToSelfImprovement consumes from a W812 regression cluster row.
//
// gap_score formula:
//
//   shortfall = kscore_delta              (bounded to [0, 1])
//   volume    = log10(1 + sample_count)   (dampens raw sample_count)
//   gap_score = shortfall * volume
//
// recommended_count formula:
//
//   base = max(1, ceil(kscore_delta * 10))   (proportional to severity)
//   cap  = min(MAX_RECOMMENDED_PER_CLUSTER, sample_count)
//                                           (never recommend more captures
//                                            than the cluster has historical
//                                            samples - that would be
//                                            speculative beyond W812's
//                                            evidence base)
//   out  = max(1, min(base, cap))
//
// Both numbers are deterministic given (kscore_delta, sample_count) so the
// same cluster always produces the same synthetic gap, which keeps the
// downstream W815 event-store request_hash stable across re-runs.
export function _synthesizeGap(cluster) {
  if (!cluster || typeof cluster !== 'object') return null;
  if (!cluster.cluster_id) return null;
  const delta = Number(cluster.kscore_delta);
  if (!Number.isFinite(delta) || delta <= 0) return null;
  const samples = Math.max(0, Math.trunc(Number(cluster.sample_count) || 0));
  const shortfall = Math.max(0, Math.min(1, delta));
  const volume = Math.log10(1 + samples);
  const gap_score = shortfall * volume;
  const base = Math.max(1, Math.ceil(shortfall * 10));
  const cap = Math.min(MAX_RECOMMENDED_PER_CLUSTER, samples || MAX_RECOMMENDED_PER_CLUSTER);
  const recommended_count = Math.max(1, Math.min(base, cap));
  return {
    cluster_id: String(cluster.cluster_id),
    gap_score,
    recommended_count,
    // Pass-through diagnostic fields the caller can render but W815's
    // feedToSelfImprovement ignores (only reads cluster_id + gap_score +
    // recommended_count from the row).
    source_kscore_delta: shortfall,
    source_sample_count: samples,
    source_topic_seed: cluster.topic_seed || null,
  };
}

// Main entry: pull failing clusters from W812, project them into W815 gap
// shape, write the gap rows via feedToSelfImprovement, return the envelope.
//
// opts:
//   tenant       - REQUIRED. Tenant-fence anchor (also accepted as tenant_id).
//   namespace    - REQUIRED. Capture namespace to scan. We never default to
//                  'default' here - the caller has to be explicit so we
//                  cannot silently feed the wrong namespace.
//   top_k        - max regression clusters to project (default 10).
//   min_delta    - W812 regression threshold (default 0.05, matches W812).
//   window_days  - W812 capture window in days (default 30, matches W812).
//   min_samples  - W812 min cluster size (default 2, matches W812).
//
// Returns:
//   {ok:true, fed_count:N, gaps:[{cluster_id, gap_score, recommended_count,
//                                  source_kscore_delta, source_sample_count}],
//    written:N, attempted:N, feed_rows:[...], version}
//   {ok:false, error:'missing_tenant_id'|'missing_namespace'|'no_captures'
//             |'no_failures'|'failure_modes_error'|'feed_error', hint, version}
export async function feedFailureToActiveLearning(opts = {}) {
  const tenant = (opts && (opts.tenant || opts.tenant_id)) || null;
  const namespace = opts && opts.namespace ? String(opts.namespace) : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'pass {tenant} so the failure -> capture feed is tenant-fenced',
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }
  if (!namespace) {
    return {
      ok: false,
      error: 'missing_namespace',
      hint: 'pass {namespace} - we refuse to default this so the feed cannot land in the wrong namespace',
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }

  const top_k = Number.isFinite(Number(opts.top_k))
    ? Math.max(1, Math.min(1000, Math.trunc(Number(opts.top_k))))
    : 10;
  const min_delta = Number.isFinite(Number(opts.min_delta))
    ? Math.max(0, Math.min(1, Number(opts.min_delta)))
    : 0.05;
  const window_days = Number.isFinite(Number(opts.window_days))
    ? Math.max(0, Math.trunc(Number(opts.window_days)))
    : 30;
  const min_samples = Number.isFinite(Number(opts.min_samples))
    ? Math.max(1, Math.trunc(Number(opts.min_samples)))
    : 2;

  // Step 1 + 2: pull regressions via W812. topRegressions internally calls
  // clusterCaptures, so a single call covers both glue steps in the spec.
  let regEnv;
  try {
    regEnv = await topRegressions({
      tenant_id: tenant,
      namespace,
      window_days,
      min_delta,
      min_samples,
      top: top_k,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'failure_modes_error',
      detail: e && e.message ? e.message : String(e),
      hint: 'src/failure-modes.js threw - check that the event-store is reachable',
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }
  if (!regEnv || regEnv.ok !== true) {
    // W812 reports {ok:false, error:'no_captures_to_cluster'} when the
    // namespace is empty - translate to no_captures for symmetry with the
    // W720 wording.
    const src = (regEnv && regEnv.error) || 'failure_modes_error';
    return {
      ok: false,
      error: src === 'no_captures_to_cluster' ? 'no_captures' : src,
      detail: regEnv && regEnv.detail,
      hint: (regEnv && regEnv.hint) ||
        'route some traffic through this (tenant, namespace) and retry',
      window_days,
      tenant,
      namespace,
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }

  // Step 3: project each failing cluster into a synthetic W815 gap row.
  // Tenant defense in depth - topRegressions already filtered, but we re-check
  // the row tenant_id when present (W812 cluster rows do not carry tenant_id,
  // they are already tenant-scoped by clusterCaptures; this is a future-proof
  // hook in case the cluster shape ever changes).
  const failing = Array.isArray(regEnv.regressions) ? regEnv.regressions : [];
  const gaps = [];
  for (const cluster of failing) {
    if (!cluster || typeof cluster !== 'object') continue;
    // Defense in depth: if a future schema ever stamps tenant on the cluster
    // row, reject foreign tenants.
    if (cluster.tenant_id && cluster.tenant_id !== tenant) continue;
    const gap = _synthesizeGap(cluster);
    if (gap) gaps.push(gap);
  }

  if (gaps.length === 0) {
    // Healthy state: no clusters above min_delta. We return ok:true so the
    // CLI / caller exits 0 - this is NOT an error, it is the desired
    // steady-state.
    return {
      ok: true,
      fed_count: 0,
      gaps: [],
      written: 0,
      attempted: 0,
      feed_rows: [],
      hint: 'no clusters above min_delta - the student is keeping pace with the teacher; nothing to feed',
      tenant,
      namespace,
      threshold: { min_delta, top_k, window_days, min_samples },
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }

  // Step 4: hand the synthetic gaps to W815 - it writes the active_learning_gap
  // event-store rows that W720's detectUnderperformingCaptures picks up.
  // feedToSelfImprovement does its own honest envelope on per-row failures.
  let feedEnv;
  try {
    feedEnv = await feedToSelfImprovement(tenant, namespace, gaps.map((g) => ({
      cluster_id: g.cluster_id,
      gap_score: g.gap_score,
      recommended_count: g.recommended_count,
    })));
  } catch (e) {
    return {
      ok: false,
      error: 'feed_error',
      detail: e && e.message ? e.message : String(e),
      hint: 'src/active-learning.js feedToSelfImprovement threw - check the event-store driver',
      tenant,
      namespace,
      gaps,
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }

  if (!feedEnv || feedEnv.ok !== true) {
    return {
      ok: false,
      error: (feedEnv && feedEnv.error) || 'feed_error',
      detail: feedEnv && feedEnv.detail,
      hint: (feedEnv && feedEnv.hint) || 'W815 feedToSelfImprovement refused to write the gap rows',
      tenant,
      namespace,
      gaps,
      version: FAILURE_TO_CAPTURE_LOOP_VERSION,
    };
  }

  // Step 5: return the unified envelope.
  return {
    ok: true,
    fed_count: feedEnv.written || 0,
    written: feedEnv.written || 0,
    attempted: feedEnv.attempted || gaps.length,
    gaps,
    feed_rows: Array.isArray(feedEnv.rows) ? feedEnv.rows : [],
    tenant,
    namespace,
    threshold: { min_delta, top_k, window_days, min_samples },
    version: FAILURE_TO_CAPTURE_LOOP_VERSION,
  };
}

export default {
  FAILURE_TO_CAPTURE_LOOP_VERSION,
  feedFailureToActiveLearning,
  _synthesizeGap,
};
