// W720-1 - self-improvement loop: detect underperforming captures via route events.
//
// Sister to W775 (Continuous background distillation). This module is the
// *detection* primitive - it scans the event-store for telemetry rows that
// signal "this capture / artifact is underperforming" so the orchestrator
// (src/improvement-orchestrator.js) can decide which captures to re-distill.
//
// Detection signals (any one triggers a candidacy):
//   - explicit failure: status in {'error', 'timeout', 'rate_limited', 'blocked'}
//   - explicit reject: review_state === 'rejected'
//   - low K-Score: when an event carries `k_score` in its raw json blob and
//     k_score < (1 - min_kscore_delta) the row is treated as a regression.
//   - explicit feedback string starting with 'fail' / 'thumb_down' / 'reject'
//
// Grouping: by `request_hash` (canonical capture identity in the event-schema).
// When request_hash is missing we fall back to (provider, model, prompt_hash)
// which is a deterministic synthetic key. Each group becomes a candidate row
// with {capture_id, current_artifact_id, observed_kscore, failure_rate,
// route_events_count}.
//
// Honest envelope: if no events match the window OR the store is unavailable,
// we return {ok:false, error:'no_route_telemetry', hint:'<actionable>'} so the
// CLI can exit non-zero rather than silently reporting "0 candidates".
//
// Tenant fence (defense-in-depth): every event row is re-checked against
// tenant_id before it counts toward a candidate. listEvents already filters
// by tenant_id, but the per-row re-check guards against a future event-store
// refactor that drops the filter.

import crypto from 'node:crypto';

export const SELF_IMPROVEMENT_VERSION = 'w720-v1';

// Sentinel values we treat as a failure status. The canonical event-schema
// closed enum is {'ok', 'error', 'timeout', 'rate_limited', 'blocked'} - any
// non-'ok' value is a failure for self-improvement purposes.
const FAILURE_STATUS = new Set(['error', 'timeout', 'rate_limited', 'blocked']);

// Feedback strings that count as an explicit thumbs-down. Matched
// case-insensitive against the prefix so trailing notes ('reject: bad answer')
// still trigger.
const NEGATIVE_FEEDBACK_PREFIXES = ['fail', 'thumb_down', 'thumbs_down', 'reject', 'bad', 'wrong', 'incorrect'];

function _isFailureEvent(ev, kscoreThreshold) {
  if (!ev || typeof ev !== 'object') return false;
  // Direct status failure.
  if (ev.status && FAILURE_STATUS.has(String(ev.status).toLowerCase())) return true;
  // Reviewer-set rejection.
  if (ev.review_state === 'rejected') return true;
  // Numeric K-Score regression signal - payload may live on the raw row OR on
  // a `kscore` / `k_score` field in the canonical event blob.
  const k = _readKScore(ev);
  if (Number.isFinite(k) && k < kscoreThreshold) return true;
  // Feedback string.
  if (typeof ev.feedback === 'string' && ev.feedback) {
    const lc = ev.feedback.toLowerCase().trim();
    for (const prefix of NEGATIVE_FEEDBACK_PREFIXES) {
      if (lc.startsWith(prefix)) return true;
    }
  }
  return false;
}

function _readKScore(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Canonical event-schema does NOT have a top-level k_score field; it lives
  // in `feedback` (when set) or in a nested json blob. We accept both shapes.
  if (Number.isFinite(Number(ev.k_score))) return Number(ev.k_score);
  if (Number.isFinite(Number(ev.kscore))) return Number(ev.kscore);
  // Some integrations stash the kscore under .meta or .eval; try those.
  if (ev.meta && Number.isFinite(Number(ev.meta.k_score))) return Number(ev.meta.k_score);
  if (ev.meta && Number.isFinite(Number(ev.meta.kscore))) return Number(ev.meta.kscore);
  if (ev.eval && Number.isFinite(Number(ev.eval.k_score))) return Number(ev.eval.k_score);
  if (ev.eval && Number.isFinite(Number(ev.eval.kscore))) return Number(ev.eval.kscore);
  return null;
}

function _candidateKey(ev) {
  // Prefer request_hash (canonical capture identity). Fall back to a
  // deterministic synthetic hash so events without request_hash still group.
  if (ev.request_hash) return String(ev.request_hash);
  const prompt = ev.prompt_redacted || ev.prompt || ev.input || '';
  const model = ev.model || '';
  const provider = ev.provider || '';
  const seed = `${provider}|${model}|${String(prompt).slice(0, 256)}`;
  return 'syn_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function _readCurrentArtifactId(ev) {
  // Captures that already ran through a compiled artifact may stamp the
  // artifact_id on the event row. Several spots - runArtifact() in
  // artifact-runner.js (line 521, 643) - surface k_score via the returned
  // envelope; we look at the same nesting positions we read kscore from.
  if (ev.artifact_id) return String(ev.artifact_id);
  if (ev.meta && ev.meta.artifact_id) return String(ev.meta.artifact_id);
  if (ev.workflow_id && /^art_/i.test(ev.workflow_id)) return String(ev.workflow_id);
  return null;
}

function _withinWindow(ev, sinceMs) {
  if (sinceMs == null) return true;
  const t = Date.parse(ev.created_at || '');
  return Number.isFinite(t) && t >= sinceMs;
}

// detectUnderperformingCaptures({tenant_id, namespace, window_days, min_kscore_delta,
//   min_failure_rate}). Returns either:
//   {ok:true, candidates:[{capture_id, current_artifact_id, observed_kscore,
//                          failure_rate, route_events_count}, ...]}
// or
//   {ok:false, error:'no_route_telemetry', hint:'<actionable>'}.
//
// Tenant fence: the listEvents call passes tenant_id; we ALSO re-check
// tenant_id on each event row before counting (defense in depth per W720
// memory trap).
export async function detectUnderperformingCaptures(opts = {}) {
  const {
    tenant_id = null,
    namespace = null,
    window_days = 7,
    min_kscore_delta = 0.05,
    min_failure_rate = 0.10,
  } = opts || {};
  const kscoreThreshold = 1 - Number(min_kscore_delta);
  const minFailureRate = Number(min_failure_rate);

  // Compute the time window - null when window_days<=0 means "all history".
  let sinceMs = null;
  if (Number.isFinite(window_days) && window_days > 0) {
    sinceMs = Date.now() - window_days * 24 * 60 * 60 * 1000;
  }

  // Pull events from the canonical event-store. Tenant + namespace filters
  // applied at the query layer; we re-check at the row layer below.
  let events;
  try {
    const es = await import('./event-store.js');
    if (typeof es.listEvents !== 'function') {
      return {
        ok: false,
        error: 'event_store_unavailable',
        hint: 'src/event-store.js does not export listEvents - check the install',
        self_improvement_version: SELF_IMPROVEMENT_VERSION,
      };
    }
    const query = { limit: 100000, order: 'desc' };
    if (tenant_id) query.tenant_id = tenant_id;
    if (namespace) query.namespace = namespace;
    if (sinceMs != null) query.since = new Date(sinceMs).toISOString();
    events = await es.listEvents(query);
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_failed',
      detail: e && e.message ? e.message : String(e),
      hint: 'check that ~/.kolm/events is writable and the sqlite/jsonl driver loads',
      self_improvement_version: SELF_IMPROVEMENT_VERSION,
    };
  }

  if (!Array.isArray(events) || events.length === 0) {
    return {
      ok: false,
      error: 'no_route_telemetry',
      hint: 'route at least 100 requests then retry; current window has no telemetry rows',
      window_days,
      tenant_id,
      namespace,
      self_improvement_version: SELF_IMPROVEMENT_VERSION,
    };
  }

  // Group events by candidate_key. Each group accumulates:
  //   total_events, failure_count, kscore_sum (only when k_score present),
  //   kscore_n (count of events with a numeric k_score), current_artifact_id
  //   (most recent), first_seen / last_seen.
  const groups = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    // Tenant fence: re-check at the row level even though listEvents was
    // already filtered. Defense in depth (W720 memory trap).
    if (tenant_id && ev.tenant_id !== tenant_id) continue;
    if (namespace && ev.namespace !== namespace) continue;
    if (!_withinWindow(ev, sinceMs)) continue;

    const key = _candidateKey(ev);
    let g = groups.get(key);
    if (!g) {
      g = {
        capture_id: key,
        current_artifact_id: null,
        total_events: 0,
        failure_count: 0,
        kscore_sum: 0,
        kscore_n: 0,
        first_seen: ev.created_at || null,
        last_seen: ev.created_at || null,
      };
      groups.set(key, g);
    }
    g.total_events += 1;
    if (_isFailureEvent(ev, kscoreThreshold)) g.failure_count += 1;
    const k = _readKScore(ev);
    if (Number.isFinite(k)) {
      g.kscore_sum += k;
      g.kscore_n += 1;
    }
    const aid = _readCurrentArtifactId(ev);
    if (aid && !g.current_artifact_id) g.current_artifact_id = aid;
    // Track time bounds.
    const t = Date.parse(ev.created_at || '');
    if (Number.isFinite(t)) {
      const firstT = Date.parse(g.first_seen || '');
      const lastT = Date.parse(g.last_seen || '');
      if (!Number.isFinite(firstT) || t < firstT) g.first_seen = ev.created_at;
      if (!Number.isFinite(lastT) || t > lastT) g.last_seen = ev.created_at;
    }
  }

  // Reduce to candidate rows - only emit groups that meet the failure_rate gate.
  const candidates = [];
  for (const g of groups.values()) {
    const failure_rate = g.total_events === 0 ? 0 : g.failure_count / g.total_events;
    if (failure_rate < minFailureRate) continue;
    candidates.push({
      capture_id: g.capture_id,
      current_artifact_id: g.current_artifact_id,
      observed_kscore: g.kscore_n > 0 ? Math.round((g.kscore_sum / g.kscore_n) * 1e4) / 1e4 : null,
      failure_rate: Math.round(failure_rate * 1e4) / 1e4,
      route_events_count: g.total_events,
      failure_count: g.failure_count,
      first_seen: g.first_seen,
      last_seen: g.last_seen,
    });
  }
  // Sort by (failure_rate desc, route_events_count desc) so the worst
  // candidates surface first.
  candidates.sort((a, b) => {
    if (b.failure_rate !== a.failure_rate) return b.failure_rate - a.failure_rate;
    return b.route_events_count - a.route_events_count;
  });

  return {
    ok: true,
    candidates,
    self_improvement_version: SELF_IMPROVEMENT_VERSION,
    window_days,
    tenant_id,
    namespace,
    events_scanned: events.length,
    threshold: {
      min_kscore_delta,
      min_failure_rate,
      kscore_low_water_mark: kscoreThreshold,
    },
  };
}

// Pure-helper test seam - exported so tests can assert the failure-detection
// edge cases without seeding a full event store.
export function _isFailureEventForTest(ev, kscoreThreshold) {
  return _isFailureEvent(ev, kscoreThreshold);
}

// Pure-helper test seam - exported so tests can assert the candidate key
// derivation without spinning up the store.
export function _candidateKeyForTest(ev) {
  return _candidateKey(ev);
}
