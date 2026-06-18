// W265 - usage analytics aggregator.
//
// The /dashboard page (public/dashboard.html) needs deterministic
// aggregation primitives over the three load-bearing tables in
// src/store.js: observations (captures), invocations (artifact runs),
// and team-events (drift_observation entries + regression_flags). This
// module owns those pure functions so the dashboard, the CLI
// (`kolm stats`), and the third-party-monitoring SDK all read from one
// source of truth.
//
// Design:
//   - All aggregators take an array as input. They do not touch the
//     store - callers pull rows themselves with whatever filter applies
//     (tenant, since, namespace). That makes them trivially testable.
//   - Latency percentiles are computed from `latency_us`; missing values
//     are skipped, NOT counted as zero.
//   - Error rate = rows with `error` truthy / total rows. Rows with
//     status >= 400 also count as errors.
//   - Day buckets are UTC YYYY-MM-DD strings derived from the row's
//     timestamp (`ts` or `timestamp` or `recorded_at`).
//   - Drift signal axes come from team-events with kind='drift_observation'
//     payload.signal - we tally counts per (axis) where axis is the
//     payload.signal.axis or payload.axis hint, falling back to 'unknown'.

export const USAGE_ANALYTICS_VERSION = 'w709-usage-analytics-v1';
export const USAGE_ANALYTICS_CONTRACT_VERSION = 'w709-v1';
export const USAGE_ANALYTICS_LIMITS = Object.freeze({
  MAX_ROWS: 50_000,
  MAX_BUCKET_KEY_CHARS: 160,
});

function _percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function _ts(row) {
  return row.ts || row.timestamp || row.recorded_at || null;
}

function _day(iso) {
  if (iso == null || iso === '') return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function _bucketBy(rows, keyFn) {
  const out = Object.create(null);
  for (const r of rows) {
    const k = _bucketKey(keyFn(r));
    if (k == null) continue;
    out[k] = (out[k] || 0) + 1;
  }
  return _finalizeBuckets(out);
}

function _bucketKey(value) {
  if (value == null) return null;
  const raw = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const key = raw.slice(0, USAGE_ANALYTICS_LIMITS.MAX_BUCKET_KEY_CHARS);
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return 'reserved_key';
  return key;
}

function _finalizeBuckets(bucket) {
  return Object.fromEntries(Object.entries(bucket).sort(([a], [b]) => a.localeCompare(b)));
}

function _boundedRows(rows) {
  const input = Array.isArray(rows) ? rows : [];
  const truncated = input.length > USAGE_ANALYTICS_LIMITS.MAX_ROWS;
  return {
    rows: truncated ? input.slice(0, USAGE_ANALYTICS_LIMITS.MAX_ROWS) : input,
    input_count: input.length,
    truncated,
  };
}

function _errorLike(row) {
  if (!row) return false;
  if (row.error) return true;
  const s = Number(row.status);
  return Number.isFinite(s) && s >= 400;
}

function _baseMeta(input) {
  return {
    input_count: input.input_count,
    truncated: input.truncated,
    version: USAGE_ANALYTICS_VERSION,
    contract_version: USAGE_ANALYTICS_CONTRACT_VERSION,
  };
}

// Captures table summary. Pass rows out of the `observations` table.
// Filters (since, namespace, tenant) are the caller's responsibility.
export function summarizeCaptures(rows = [], opts = {}) {
  const input = _boundedRows(rows);
  const total = input.rows.length;
  const by_namespace = _bucketBy(input.rows, r => r.namespace);
  const by_runtime_target = _bucketBy(input.rows, r => r.runtime_target);
  const by_day = Object.create(null);
  for (const r of input.rows) {
    const d = _day(_ts(r));
    if (d) by_day[d] = (by_day[d] || 0) + 1;
  }
  const latencies = input.rows
    .map(r => Number(r.latency_us))
    .filter(v => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const errors = input.rows.filter(_errorLike).length;
  const durable = input.rows.filter(r => r.x_kolm_capture_durable === true || r.durable === true).length;
  return {
    total,
    by_namespace,
    by_runtime_target,
    by_day: _finalizeBuckets(by_day),
    p50_latency_us: _percentile(latencies, 50),
    p95_latency_us: _percentile(latencies, 95),
    p99_latency_us: _percentile(latencies, 99),
    error_count: errors,
    error_rate: total > 0 ? errors / total : 0,
    durable_count: durable,
    durable_rate: total > 0 ? durable / total : 0,
    since: opts.since || null,
    ..._baseMeta(input),
  };
}

// Invocations table summary. Pass rows out of `invocations`. Each row
// should carry version_id, concept_id, latency_us, error?, ts.
export function summarizeInvocations(rows = []) {
  const input = _boundedRows(rows);
  const total = input.rows.length;
  const by_recipe = _bucketBy(input.rows, r => r.concept_id || r.recipe_id);
  const by_version = _bucketBy(input.rows, r => r.version_id);
  const cache_hits = input.rows.filter(r => r.cache_hit).length;
  const latencies = input.rows
    .map(r => Number(r.latency_us))
    .filter(v => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const errors = input.rows.filter(_errorLike).length;
  return {
    total,
    by_recipe,
    by_version,
    cache_hit_count: cache_hits,
    cache_hit_rate: total > 0 ? cache_hits / total : 0,
    p50_latency_us: _percentile(latencies, 50),
    p95_latency_us: _percentile(latencies, 95),
    error_count: errors,
    error_rate: total > 0 ? errors / total : 0,
    ..._baseMeta(input),
  };
}

// Drift signal summary. Pass team-events rows with kind='drift_observation'
// or kind='regression_flag'. Returns counts by axis + last_observed.
export function summarizeDriftSignals(events = []) {
  const input = _boundedRows(events);
  const drift = input.rows.filter(e => e.kind === 'drift_observation');
  const regr = input.rows.filter(e => e.kind === 'regression_flag');
  const by_axis = Object.create(null);
  for (const e of drift) {
    const axis = _bucketKey((e.payload && (e.payload.axis || (e.payload.signal && e.payload.signal.axis))) || 'unknown') || 'unknown';
    by_axis[axis] = (by_axis[axis] || 0) + 1;
  }
  const all = [...drift, ...regr];
  const observed = all
    .map(e => _ts(e))
    .map(ts => {
      const d = new Date(ts);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    })
    .filter(Boolean)
    .sort();
  const last_observed = observed.length > 0 ? observed[observed.length - 1] : null;
  return {
    drift_count: drift.length,
    regression_count: regr.length,
    total: drift.length + regr.length,
    by_axis: _finalizeBuckets(by_axis),
    last_observed,
    ..._baseMeta(input),
  };
}

// Composite dashboard summary. Takes pre-pulled rows and returns the
// full top-of-page summary the /dashboard renders.
export function dashboardSummary({ captures = [], invocations = [], driftEvents = [], since = null } = {}) {
  return {
    captures: summarizeCaptures(captures, { since }),
    invocations: summarizeInvocations(invocations),
    drift: summarizeDriftSignals(driftEvents),
    generated_at: new Date().toISOString(),
    window: { since },
    version: USAGE_ANALYTICS_VERSION,
    contract_version: USAGE_ANALYTICS_CONTRACT_VERSION,
  };
}

export default {
  summarizeCaptures,
  summarizeInvocations,
  summarizeDriftSignals,
  dashboardSummary,
};
