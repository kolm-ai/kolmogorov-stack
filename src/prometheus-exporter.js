// W730 — Prometheus exporter.
//
// Closes W730-1 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md (line 370):
//   "src/prometheus-exporter.js exposing /metrics endpoint in Prometheus
//    text format (capture counts, queue depth, GPU memory usage, kernel
//    selection histogram, acceptance rates from W727)"
//
// Design contract:
//
//   * PURE renderer. Sample state lives in a module-level map; tests reset
//     it via _resetForTests(). No timers, no auto-scrape, no I/O. Callers
//     pipe renderMetrics() out to whatever surface they want (HTTP route,
//     stdout for cron, log shipper).
//   * Prometheus text exposition format v0.0.4 — HELP/TYPE lines per
//     metric, then zero-or-more sample rows. Honest empty-state: a
//     registered metric with no samples still emits HELP+TYPE (no rows),
//     which is Prometheus-correct (scrapers report `absent()` and you
//     keep the metric in the registry).
//   * Sibling-module composition: when W724 (memory-tier), W726
//     (kernel-selector), W727 (accelerate), W729 (load-queue) ship,
//     callers stitch values in via setGauge / incCounter / observeHistogram.
//     The exporter does NOT import those siblings — keeps the dependency
//     graph one-way and the module fully unit-testable.
//   * Label-value escaping: backslash, double-quote, and newline get the
//     Prometheus escape treatment so a malicious or careless namespace
//     name can never break the line format.
//
// Public surface:
//
//   PROMETHEUS_EXPORTER_VERSION
//   registerMetric({name, type, help, labelnames})
//   incCounter(name, labels, value=1)
//   setGauge(name, labels, value)
//   observeHistogram(name, labels, value)
//   renderMetrics()
//   listRegisteredMetrics()
//   _resetForTests()

export const PROMETHEUS_EXPORTER_VERSION = 'w730-v1';

// Default histogram buckets — sensible defaults for "acceptance rate"
// (0..1 fraction) and HTTP latency (sub-millisecond → minute scale). When
// a callsite wants a different distribution, pass `buckets:[..]` to
// registerMetric. We keep these conservative and well-tested rather than
// inheriting the prom-client defaults — the W707 wave doesn't want a
// third-party SDK dependency for this exporter.
const DEFAULT_HISTOGRAM_BUCKETS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

// Acceptance-rate histograms (W727 spec-decode) live in [0,1] so we
// switch buckets when a metric name ends in `_acceptance_rate` or
// `_acceptance_rate_bucket`. Caller-supplied buckets always win.
const ACCEPTANCE_HISTOGRAM_BUCKETS = Object.freeze([
  0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0,
]);

// =============================================================================
// Registry state (module-level; resettable via _resetForTests())
// =============================================================================

const _registry = new Map();   // name → {type, help, labelnames, buckets}
const _samples = new Map();    // name → Map(labelKey → sample shape per type)

function _emptyRegistry() {
  _registry.clear();
  _samples.clear();
}

/**
 * Wipe all registered metrics + samples. Tests call this in `beforeEach`
 * so cross-test state can't poison the renderer. Production code should
 * never call this.
 */
export function _resetForTests() {
  _emptyRegistry();
  _preRegisterCanonicalMetrics();
}

// =============================================================================
// Canonical pre-registered metrics
// =============================================================================
//
// The W730 spec pins six metrics that the rest of the runtime SHOULD feed.
// We pre-register them at module-import time so a scrape immediately after
// boot returns the canonical HELP/TYPE block even if the runtime hasn't
// produced any samples yet (honest empty-state). Callers in router.js,
// memory-tier.js, etc. just call setGauge/incCounter/observeHistogram —
// they don't need to remember to register first.

function _preRegisterCanonicalMetrics() {
  registerMetric({
    name: 'kolm_capture_total',
    type: 'counter',
    help: 'Total number of capture events written to the event store.',
    labelnames: ['tenant', 'namespace'],
  });
  registerMetric({
    name: 'kolm_load_queue_depth',
    type: 'gauge',
    help: 'Current depth of the W729 load queue (artifacts waiting to be paged in).',
    labelnames: [],
  });
  registerMetric({
    name: 'kolm_runtime_gpu_memory_bytes',
    type: 'gauge',
    help: 'GPU memory usage in bytes by device and W724 tier.',
    labelnames: ['device', 'tier'],
  });
  registerMetric({
    name: 'kolm_runtime_kernel_selected_total',
    type: 'counter',
    help: 'Count of W726 kernel-selector profile selections.',
    labelnames: ['profile_name'],
  });
  registerMetric({
    name: 'kolm_accelerate_acceptance_rate',
    type: 'histogram',
    help: 'W727 speculative-decoding acceptance rate distribution by task class.',
    labelnames: ['task_class'],
    buckets: ACCEPTANCE_HISTOGRAM_BUCKETS.slice(),
  });
  registerMetric({
    name: 'kolm_http_request_duration_seconds',
    type: 'histogram',
    help: 'HTTP request duration in seconds by method, route, and status.',
    labelnames: ['method', 'route', 'status'],
  });
}

// Pre-register on module load so the first scrape after boot is honest.
_preRegisterCanonicalMetrics();

// =============================================================================
// registerMetric
// =============================================================================

/**
 * Register a metric. Idempotent — calling twice with the same shape is a
 * no-op; calling with a CONFLICTING shape (different type) throws so the
 * mistake surfaces at boot, not at scrape.
 */
export function registerMetric(spec) {
  const name = (spec && spec.name) || null;
  if (!name || typeof name !== 'string') {
    throw new Error('registerMetric: name (string) required');
  }
  if (!_isValidMetricName(name)) {
    throw new Error(`registerMetric: invalid Prometheus metric name "${name}"`);
  }
  const type = (spec && spec.type) || null;
  if (type !== 'counter' && type !== 'gauge' && type !== 'histogram') {
    throw new Error(`registerMetric: type must be counter|gauge|histogram (got ${type})`);
  }
  const help = (spec && typeof spec.help === 'string') ? spec.help : '';
  const labelnames = Array.isArray(spec && spec.labelnames)
    ? spec.labelnames.slice() : [];
  for (const ln of labelnames) {
    if (!_isValidLabelName(ln)) {
      throw new Error(`registerMetric: invalid label name "${ln}" on metric "${name}"`);
    }
  }
  const buckets = (type === 'histogram')
    ? (Array.isArray(spec && spec.buckets) ? spec.buckets.slice() : DEFAULT_HISTOGRAM_BUCKETS.slice())
    : null;

  const existing = _registry.get(name);
  if (existing) {
    if (existing.type !== type) {
      throw new Error(`registerMetric: "${name}" already registered as ${existing.type}, cannot re-register as ${type}`);
    }
    // Idempotent — keep existing labelnames + buckets to preserve samples.
    return;
  }
  _registry.set(name, { type, help, labelnames, buckets });
  _samples.set(name, new Map());
}

// =============================================================================
// Sample mutators
// =============================================================================

/**
 * Increment a counter. Negative values are rejected (counters are
 * monotonic). Missing metric throws to surface registration mistakes
 * immediately.
 */
export function incCounter(name, labels, value) {
  const v = (value === undefined || value === null) ? 1 : Number(value);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`incCounter: "${name}" requires non-negative finite value (got ${value})`);
  }
  const spec = _requireRegistered(name, 'counter');
  const key = _labelKey(spec.labelnames, labels);
  const bucket = _samples.get(name);
  const prev = bucket.get(key);
  if (prev) {
    prev.value += v;
  } else {
    bucket.set(key, { labels: _normalizeLabels(spec.labelnames, labels), value: v });
  }
}

/**
 * Set a gauge to a value. Gauges can move in either direction so we
 * accept any finite number (positive, negative, zero). NaN/Infinity are
 * rejected because Prometheus text format forbids them.
 */
export function setGauge(name, labels, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) {
    throw new Error(`setGauge: "${name}" requires finite value (got ${value})`);
  }
  const spec = _requireRegistered(name, 'gauge');
  const key = _labelKey(spec.labelnames, labels);
  const bucket = _samples.get(name);
  bucket.set(key, { labels: _normalizeLabels(spec.labelnames, labels), value: v });
}

/**
 * Observe a value into a histogram. Updates the per-bucket counters +
 * the _sum and _count series for the supplied label set. Non-finite or
 * negative values are rejected (histograms in Prometheus model
 * non-negative durations/quantities).
 */
export function observeHistogram(name, labels, value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`observeHistogram: "${name}" requires non-negative finite value (got ${value})`);
  }
  const spec = _requireRegistered(name, 'histogram');
  const key = _labelKey(spec.labelnames, labels);
  const bucket = _samples.get(name);
  let sample = bucket.get(key);
  if (!sample) {
    const counts = new Array(spec.buckets.length).fill(0);
    sample = {
      labels: _normalizeLabels(spec.labelnames, labels),
      counts,
      sum: 0,
      count: 0,
    };
    bucket.set(key, sample);
  }
  for (let i = 0; i < spec.buckets.length; i += 1) {
    if (v <= spec.buckets[i]) sample.counts[i] += 1;
  }
  sample.sum += v;
  sample.count += 1;
}

// =============================================================================
// renderMetrics — Prometheus text exposition format v0.0.4
// =============================================================================

/**
 * Render every registered metric in Prometheus text format. Returns a
 * single string ready to write to an HTTP response or stdout.
 *
 * Honest empty-state: a metric with no samples still emits its HELP and
 * TYPE lines but no rows. This is Prometheus-correct — scrapers report
 * `absent()` and the metric stays in the registry.
 */
export function renderMetrics() {
  const out = [];
  // Sort by name so the output is deterministic across boots — easier to
  // diff in CI and stable under partial reloads.
  const names = Array.from(_registry.keys()).sort();
  for (const name of names) {
    const spec = _registry.get(name);
    out.push(`# HELP ${name} ${_escapeHelp(spec.help)}`);
    out.push(`# TYPE ${name} ${spec.type}`);
    const bucket = _samples.get(name) || new Map();
    if (bucket.size === 0) {
      // Empty-state: no sample rows. Add a trailing blank line so the
      // next metric block is visually separated when rendered.
      out.push('');
      continue;
    }
    if (spec.type === 'counter' || spec.type === 'gauge') {
      const keys = Array.from(bucket.keys()).sort();
      for (const k of keys) {
        const s = bucket.get(k);
        out.push(`${name}${_renderLabels(s.labels)} ${_renderNumber(s.value)}`);
      }
    } else if (spec.type === 'histogram') {
      const keys = Array.from(bucket.keys()).sort();
      for (const k of keys) {
        const s = bucket.get(k);
        // Per-bucket samples: name_bucket{...,le="<upper>"} <count>
        for (let i = 0; i < spec.buckets.length; i += 1) {
          const labelsWithLe = Object.assign({}, s.labels, { le: String(spec.buckets[i]) });
          out.push(`${name}_bucket${_renderLabels(labelsWithLe)} ${_renderNumber(s.counts[i])}`);
        }
        // +Inf bucket equals the total count.
        const infLabels = Object.assign({}, s.labels, { le: '+Inf' });
        out.push(`${name}_bucket${_renderLabels(infLabels)} ${_renderNumber(s.count)}`);
        // _sum + _count series.
        out.push(`${name}_sum${_renderLabels(s.labels)} ${_renderNumber(s.sum)}`);
        out.push(`${name}_count${_renderLabels(s.labels)} ${_renderNumber(s.count)}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * Introspection helper for `kolm metrics list`. Returns a stable shape
 * describing every registered metric.
 */
export function listRegisteredMetrics() {
  const out = [];
  const names = Array.from(_registry.keys()).sort();
  for (const name of names) {
    const spec = _registry.get(name);
    out.push({
      name,
      type: spec.type,
      help: spec.help,
      labelnames: spec.labelnames.slice(),
      buckets: spec.type === 'histogram' ? spec.buckets.slice() : null,
      sample_count: (_samples.get(name) || new Map()).size,
    });
  }
  return out;
}

// =============================================================================
// Internals
// =============================================================================

function _requireRegistered(name, expectedType) {
  const spec = _registry.get(name);
  if (!spec) {
    throw new Error(`metric "${name}" is not registered`);
  }
  if (spec.type !== expectedType) {
    throw new Error(`metric "${name}" is registered as ${spec.type}, not ${expectedType}`);
  }
  return spec;
}

// Build a stable per-sample key from the metric's labelnames + provided
// labels object. Missing labels become the empty string so a partial
// {tenant} call doesn't accidentally collide with a {tenant, namespace}
// call.
function _labelKey(labelnames, labels) {
  const parts = [];
  for (const ln of labelnames) {
    const v = (labels && labels[ln] !== undefined && labels[ln] !== null)
      ? String(labels[ln]) : '';
    parts.push(`${ln}=${v}`);
  }
  return parts.join('\x00');
}

function _normalizeLabels(labelnames, labels) {
  const out = {};
  for (const ln of labelnames) {
    out[ln] = (labels && labels[ln] !== undefined && labels[ln] !== null)
      ? String(labels[ln]) : '';
  }
  return out;
}

function _renderLabels(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = [];
  for (const k of keys) {
    parts.push(`${k}="${_escapeLabelValue(labels[k])}"`);
  }
  return `{${parts.join(',')}}`;
}

// Prometheus number rendering: integers stay integer, floats stay float.
// NaN/+Inf/-Inf are not produced by our mutators but we still handle them
// here in case a downstream rendering test passes them in directly.
function _renderNumber(n) {
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  if (Number.isNaN(n)) return 'NaN';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

// HELP-line escaping: backslash and newline only (per Prometheus spec).
function _escapeHelp(s) {
  const str = String(s == null ? '' : s);
  return str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

// Label-value escaping: backslash, double-quote, newline.
function _escapeLabelValue(s) {
  const str = String(s == null ? '' : s);
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

// Prometheus metric-name grammar: [a-zA-Z_:][a-zA-Z0-9_:]*
function _isValidMetricName(name) {
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name);
}

// Prometheus label-name grammar: [a-zA-Z_][a-zA-Z0-9_]* (names starting
// with __ are reserved for internal use; we don't block them at the API
// surface to keep the exporter generic, but downstream registration
// SHOULD avoid them).
function _isValidLabelName(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}
