// src/ab-metrics.js
//
// W822-2 - Per-version metrics aggregation for A/B traffic.
//
// Reads from src/event-store.js (the canonical telemetry store). Group events
// by variant ('a' or 'b') and aggregate:
//   - count
//   - k_score (mean across events that carry a numeric k_score)
//   - latency_ms p50 + p95
//   - fallback_rate (status not in {'ok'})
//   - thumbs_up + thumbs_down counts (from feedback payloads)
//
// Variant detection priority (per-event):
//   1. ev.variant in {'a','b'}
//   2. parsed JSON feedback {kind:'w822_ab_outcome', variant:'a'|'b'}
//   3. parsed JSON feedback {kind:'w822_ab_feedback', variant:'a'|'b'}
//   4. parsed JSON feedback {kind:'w777_ab_outcome', arm:'a'|'b'}   (compat)
//
// Tenant fence: every event row is re-checked against tenant_id before it
// counts toward the rollup. Defense-in-depth per W411 / W720.
//
// AB_METRICS_VERSION = 'w822-vN' -- consumers MUST match /^w822-/ NOT literal.

export const AB_METRICS_VERSION = 'w822-v1';
export const AB_FEEDBACK_WORKFLOW = 'w822:ab:feedback';
export const AB_OUTCOME_WORKFLOW = 'w822:ab:outcome';

// Feedback strings that count as positive / negative when no structured
// thumbs field is present. Matched case-insensitive on the trimmed prefix.
const POSITIVE_FEEDBACK_PREFIXES = ['thumb_up', 'thumbs_up', 'good', 'positive', 'like', 'accept'];
const NEGATIVE_FEEDBACK_PREFIXES = ['thumb_down', 'thumbs_down', 'bad', 'negative', 'dislike', 'reject', 'fail', 'wrong', 'incorrect'];

function _parseJsonField(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
}

function _readVariant(ev, ab_test_id, namespace) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.variant === 'a' || ev.variant === 'b') return ev.variant;
  const fb = _parseJsonField(ev.feedback);
  if (fb) {
    // Filter by ab_test_id when supplied to keep multi-test namespaces honest.
    if (ab_test_id && fb.ab_test_id && fb.ab_test_id !== ab_test_id) return null;
    if (namespace && fb.namespace && fb.namespace !== namespace) return null;
    if (fb.kind === 'w822_ab_outcome' || fb.kind === 'w822_ab_feedback') {
      if (fb.variant === 'a' || fb.variant === 'b') return fb.variant;
    }
    // Compat with W777 outcome shape.
    if (fb.kind === 'w777_ab_outcome' && (fb.arm === 'a' || fb.arm === 'b')) return fb.arm;
  }
  return null;
}

function _readKScore(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (Number.isFinite(Number(ev.k_score))) return Number(ev.k_score);
  if (Number.isFinite(Number(ev.kscore))) return Number(ev.kscore);
  const fb = _parseJsonField(ev.feedback);
  if (fb) {
    if (Number.isFinite(Number(fb.k_score))) return Number(fb.k_score);
    if (Number.isFinite(Number(fb.kscore))) return Number(fb.kscore);
  }
  if (ev.meta && Number.isFinite(Number(ev.meta.k_score))) return Number(ev.meta.k_score);
  return null;
}

function _isFallback(ev) {
  // status not in {'ok'} -- explicit failure-class. Cache hits keep status='ok'
  // so they don't count as fallback.
  if (!ev || !ev.status) return false;
  const s = String(ev.status).toLowerCase();
  return s !== 'ok';
}

function _readThumbs(ev) {
  if (!ev) return null;
  // Structured field on canonical row first.
  if (ev.thumbs_up === true || ev.thumbs === 'up' || ev.thumb === 'up') return 'up';
  if (ev.thumbs_down === true || ev.thumbs === 'down' || ev.thumb === 'down') return 'down';
  const fb = _parseJsonField(ev.feedback);
  if (fb) {
    if (fb.thumb === 'up' || fb.thumbs_up === true || fb.feedback === 'up') return 'up';
    if (fb.thumb === 'down' || fb.thumbs_down === true || fb.feedback === 'down') return 'down';
  }
  // Fall back to string prefix scan.
  const text = (typeof ev.feedback === 'string') ? ev.feedback.toLowerCase().trim() : '';
  if (text) {
    for (const p of POSITIVE_FEEDBACK_PREFIXES) if (text.startsWith(p)) return 'up';
    for (const p of NEGATIVE_FEEDBACK_PREFIXES) if (text.startsWith(p)) return 'down';
  }
  return null;
}

function _percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function _emptyVariant() {
  return {
    count: 0,
    k_score: null,
    k_score_n: 0,
    latency_p50: null,
    latency_p95: null,
    fallback_count: 0,
    fallback_rate: 0,
    thumbs_up: 0,
    thumbs_down: 0,
  };
}

function _finalizeVariant(acc) {
  const sortedLat = acc._latencies.slice().sort((a, b) => a - b);
  const kMean = acc._kscoreN > 0 ? acc._kscoreSum / acc._kscoreN : null;
  return {
    count: acc.count,
    k_score: kMean,
    k_score_n: acc._kscoreN,
    latency_p50: _percentile(sortedLat, 50),
    latency_p95: _percentile(sortedLat, 95),
    fallback_count: acc.fallback_count,
    fallback_rate: acc.count > 0 ? acc.fallback_count / acc.count : 0,
    thumbs_up: acc.thumbs_up,
    thumbs_down: acc.thumbs_down,
  };
}

/**
 * aggregate({tenant_id, namespace, ab_test_id, window_days, since, until,
 *            workflows}) returns per-variant metrics.
 *
 * Returns:
 *   { ok:true,
 *     metrics: { a: {...}, b: {...} },
 *     n_total: number,
 *     window: { since, until },
 *     version: 'w822-vN' }
 * or
 *   { ok:false, error:'no_route_telemetry', ...} when no events match.
 */
export async function aggregate(opts = {}) {
  const {
    tenant_id = null,
    namespace = null,
    ab_test_id = null,
    window_days = null,
    since = null,
    until = null,
    workflows = null,
  } = opts || {};

  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'aggregate({tenant_id, namespace}) requires tenant_id',
      version: AB_METRICS_VERSION,
    };
  }

  let sinceIso = since ? new Date(since).toISOString() : null;
  const untilIso = until ? new Date(until).toISOString() : null;
  if (!sinceIso && Number.isFinite(window_days) && window_days > 0) {
    sinceIso = new Date(Date.now() - window_days * 24 * 60 * 60 * 1000).toISOString();
  }

  // Default: look at both W822 feedback + outcome workflows plus the W777
  // outcome workflow (compat). Callers can pass {workflows:[...]} to narrow.
  const wfList = Array.isArray(workflows) && workflows.length
    ? workflows
    : [AB_FEEDBACK_WORKFLOW, AB_OUTCOME_WORKFLOW, 'w777:ab', null];

  let allEvents = [];
  try {
    const es = await import('./event-store.js');
    if (typeof es.listEvents !== 'function') {
      return {
        ok: false,
        error: 'event_store_unavailable',
        hint: 'src/event-store.js does not export listEvents',
        version: AB_METRICS_VERSION,
      };
    }
    for (const wf of wfList) {
      const q = { tenant_id, limit: 100000, order: 'desc' };
      if (namespace) q.namespace = namespace;
      if (wf) q.workflow_id = wf;
      if (sinceIso) q.since = sinceIso;
      if (untilIso) q.until = untilIso;
      const rows = await es.listEvents(q);
      if (Array.isArray(rows)) allEvents = allEvents.concat(rows);
    }
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_failed',
      detail: e && e.message ? e.message : String(e),
      version: AB_METRICS_VERSION,
    };
  }

  // Dedup by event_id (we may have read the same row under multiple workflow
  // filters when wf===null acts as wildcard).
  const seenIds = new Set();
  const events = [];
  for (const ev of allEvents) {
    if (!ev || !ev.event_id) continue;
    if (seenIds.has(ev.event_id)) continue;
    seenIds.add(ev.event_id);
    events.push(ev);
  }

  if (events.length === 0) {
    return {
      ok: false,
      error: 'no_route_telemetry',
      hint: 'no events match this (tenant, namespace) window; record outcomes via POST /v1/ab/feedback',
      window: { since: sinceIso, until: untilIso },
      version: AB_METRICS_VERSION,
    };
  }

  const buckets = {
    a: { count: 0, _kscoreSum: 0, _kscoreN: 0, _latencies: [], fallback_count: 0, thumbs_up: 0, thumbs_down: 0 },
    b: { count: 0, _kscoreSum: 0, _kscoreN: 0, _latencies: [], fallback_count: 0, thumbs_up: 0, thumbs_down: 0 },
  };

  let counted = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    // Defense-in-depth tenant fence -- listEvents was already filtered.
    if (ev.tenant_id !== tenant_id) continue;
    if (namespace && ev.namespace !== namespace) continue;
    const variant = _readVariant(ev, ab_test_id, namespace);
    if (variant !== 'a' && variant !== 'b') continue;
    const acc = buckets[variant];
    acc.count++;
    counted++;
    const k = _readKScore(ev);
    if (Number.isFinite(k)) {
      acc._kscoreSum += k;
      acc._kscoreN++;
    }
    const lat = Number(ev.latency_ms);
    if (Number.isFinite(lat) && lat >= 0) acc._latencies.push(lat);
    if (_isFallback(ev)) acc.fallback_count++;
    const t = _readThumbs(ev);
    if (t === 'up') acc.thumbs_up++;
    else if (t === 'down') acc.thumbs_down++;
  }

  if (counted === 0) {
    return {
      ok: false,
      error: 'no_ab_tagged_events',
      hint: 'events exist but none carry a variant=a|b tag; check feedback shape',
      events_scanned: events.length,
      version: AB_METRICS_VERSION,
    };
  }

  return {
    ok: true,
    metrics: {
      a: _finalizeVariant(buckets.a),
      b: _finalizeVariant(buckets.b),
    },
    n_total: counted,
    events_scanned: events.length,
    window: { since: sinceIso, until: untilIso },
    namespace,
    ab_test_id,
    version: AB_METRICS_VERSION,
  };
}

/**
 * deltas(metrics) returns the per-axis B-vs-A differences in a flat object so
 * the auto-promote / auto-rollback gate has a single shape to threshold on.
 *
 * Returns:
 *   { k_score_delta, latency_p50_delta, latency_p95_delta,
 *     latency_p95_pct_delta, fallback_rate_delta,
 *     thumbs_up_delta, thumbs_down_delta }
 *
 * When either variant has zero rows we return null deltas (cannot compare).
 */
export function deltas(metricsObj) {
  if (!metricsObj || typeof metricsObj !== 'object') return null;
  const a = metricsObj.a || metricsObj.metrics?.a;
  const b = metricsObj.b || metricsObj.metrics?.b;
  if (!a || !b || a.count === 0 || b.count === 0) {
    return {
      k_score_delta: null,
      latency_p50_delta: null,
      latency_p95_delta: null,
      latency_p95_pct_delta: null,
      fallback_rate_delta: null,
      thumbs_up_delta: null,
      thumbs_down_delta: null,
      reason: 'one_or_both_variants_empty',
      version: AB_METRICS_VERSION,
    };
  }
  const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const kA = Number.isFinite(Number(a.k_score)) ? Number(a.k_score) : null;
  const kB = Number.isFinite(Number(b.k_score)) ? Number(b.k_score) : null;
  const k_score_delta = (kA != null && kB != null) ? (kB - kA) : null;

  const p50A = safeNum(a.latency_p50);
  const p50B = safeNum(b.latency_p50);
  const p95A = safeNum(a.latency_p95);
  const p95B = safeNum(b.latency_p95);
  const latency_p50_delta = p50B - p50A;
  const latency_p95_delta = p95B - p95A;
  const latency_p95_pct_delta = p95A > 0 ? (p95B - p95A) / p95A : null;

  const fallback_rate_delta = safeNum(b.fallback_rate) - safeNum(a.fallback_rate);
  const thumbs_up_delta = safeNum(b.thumbs_up) - safeNum(a.thumbs_up);
  const thumbs_down_delta = safeNum(b.thumbs_down) - safeNum(a.thumbs_down);

  return {
    k_score_delta,
    latency_p50_delta,
    latency_p95_delta,
    latency_p95_pct_delta,
    fallback_rate_delta,
    thumbs_up_delta,
    thumbs_down_delta,
    version: AB_METRICS_VERSION,
  };
}

export default {
  AB_METRICS_VERSION,
  AB_FEEDBACK_WORKFLOW,
  AB_OUTCOME_WORKFLOW,
  aggregate,
  deltas,
};
