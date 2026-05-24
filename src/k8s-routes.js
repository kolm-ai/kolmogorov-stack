// src/k8s-routes.js
//
// W824-2 + W824-3 — Kubernetes-native deep-readiness + extended-metrics
// routes. Lives in a one-call mount module so W824 ships without touching
// router.js beyond a single `__registerK8sRoutes_w824(r)` line. Concurrent
// agents (WC07, WC14, W822) are editing router.js in parallel and the
// product-wide convention is to minimise diff surface area there.
//
// Routes registered:
//
//   GET /ready/deep      — 200 only when the .kolm artifact is loaded
//                          (W824-2). 503 + structured envelope otherwise.
//                          Distinct from /ready (W730, runtime-readiness)
//                          which only checks env/config presence.
//
//   GET /metrics/extended — Prometheus exposition (W824-3) aggregated from
//                          the event-store: kolm_inferences_total (counter),
//                          kolm_latency_seconds (histogram),
//                          kolm_fallback_rate (gauge),
//                          kolm_inference_queue_depth (gauge — HPA input).
//                          Distinct from /metrics (W730) which exposes the
//                          generic prometheus-exporter registry.
//
// Honesty contract:
//
//   /ready/deep emits {ok:false, error:'artifact_not_loaded', hint, source}
//   with HTTP 503 when the artifact is cold. Never 200 with a fake-ready
//   body — k8s would let traffic land on an empty pod.
//
//   /metrics/extended always returns 200 with a Prometheus text body so
//   scrapers stay green even when the store is empty. Empty store -> all
//   counter samples are 0, gauges are 0; HELP + TYPE lines still emit.

import { isArtifactLoaded, readinessSnapshot, K8S_READINESS_VERSION } from './k8s-readiness.js';
import * as eventStore from './event-store.js';

export const K8S_ROUTES_VERSION = 'w824-v1';

// ---------------------------------------------------------------------------
// Prometheus text helpers (no external SDK — kept local so this module stays
// independently testable and we don't take on a heavy dependency for four
// metrics).
// ---------------------------------------------------------------------------

const _DEFAULT_LATENCY_BUCKETS_SEC = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

function _formatNumber(n) {
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  if (Number.isNaN(n)) return 'NaN';
  // Use integer rendering when value is a whole number to match the
  // Prometheus convention; fall back to fixed-precision otherwise.
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

function _renderLabels(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => {
    const v = String(labels[k] == null ? '' : labels[k])
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    return `${k}="${v}"`;
  });
  return '{' + parts.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Inference queue depth — exported so other modules (load-queue) can update
// the gauge. The gauge is read by /metrics/extended; the HPA uses the value
// via a prometheus-adapter to keep replicas matched to demand.
// ---------------------------------------------------------------------------

let _inferenceQueueDepth = 0;

export function setInferenceQueueDepth(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('setInferenceQueueDepth: requires non-negative finite value');
  }
  _inferenceQueueDepth = n;
}

export function getInferenceQueueDepth() {
  return _inferenceQueueDepth;
}

// ---------------------------------------------------------------------------
// Aggregate from the event-store and render Prometheus text.
//
// All four metrics are computed on-demand at scrape time so they always
// reflect the current store state. For high-traffic deployments this
// short-circuits at 5_000 rows; the prom-friendly tail trends are still
// accurate at that sample size.
// ---------------------------------------------------------------------------

export async function renderExtendedMetrics() {
  let rows = [];
  try {
    rows = await eventStore.listEvents({ limit: 5000 });
    if (!Array.isArray(rows)) rows = [];
  } catch (_) {
    rows = [];
  }

  // kolm_inferences_total — counter labelled by status
  const statusCounts = new Map();
  let fallbackCount = 0;
  let total = 0;
  const latencyBucketHits = new Array(_DEFAULT_LATENCY_BUCKETS_SEC.length).fill(0);
  let latencySum = 0;
  let latencyCount = 0;
  for (const r of rows) {
    total += 1;
    const st = String((r && r.status) || 'unknown');
    statusCounts.set(st, (statusCounts.get(st) || 0) + 1);
    if (st === 'fallback' || (r && r.fallback === true)) fallbackCount += 1;
    const latencyMs = Number(r && r.latency_ms);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      const sec = latencyMs / 1000;
      for (let i = 0; i < _DEFAULT_LATENCY_BUCKETS_SEC.length; i += 1) {
        if (sec <= _DEFAULT_LATENCY_BUCKETS_SEC[i]) latencyBucketHits[i] += 1;
      }
      latencySum += sec;
      latencyCount += 1;
    }
  }
  const fallbackRate = total === 0 ? 0 : (fallbackCount / total);

  const lines = [];
  lines.push('# HELP kolm_inferences_total Total inference events recorded by the event-store.');
  lines.push('# TYPE kolm_inferences_total counter');
  if (statusCounts.size === 0) {
    // Honest empty-state: emit a zero-row labelled status="empty" so scrapers
    // don't report `absent()` while we wait for traffic.
    lines.push(`kolm_inferences_total${_renderLabels({ status: 'empty' })} 0`);
  } else {
    const sortedStatuses = Array.from(statusCounts.keys()).sort();
    for (const st of sortedStatuses) {
      lines.push(`kolm_inferences_total${_renderLabels({ status: st })} ${_formatNumber(statusCounts.get(st))}`);
    }
  }

  lines.push('# HELP kolm_latency_seconds Inference latency distribution in seconds (from event-store latency_ms).');
  lines.push('# TYPE kolm_latency_seconds histogram');
  for (let i = 0; i < _DEFAULT_LATENCY_BUCKETS_SEC.length; i += 1) {
    const le = String(_DEFAULT_LATENCY_BUCKETS_SEC[i]);
    lines.push(`kolm_latency_seconds_bucket${_renderLabels({ le })} ${_formatNumber(latencyBucketHits[i])}`);
  }
  lines.push(`kolm_latency_seconds_bucket${_renderLabels({ le: '+Inf' })} ${_formatNumber(latencyCount)}`);
  lines.push(`kolm_latency_seconds_sum ${_formatNumber(latencySum)}`);
  lines.push(`kolm_latency_seconds_count ${_formatNumber(latencyCount)}`);

  lines.push('# HELP kolm_fallback_rate Ratio of events with status=fallback or fallback:true to total events.');
  lines.push('# TYPE kolm_fallback_rate gauge');
  lines.push(`kolm_fallback_rate ${_formatNumber(fallbackRate)}`);

  lines.push('# HELP kolm_inference_queue_depth Current number of inference requests queued for execution. Consumed by the W824-4 HPA.');
  lines.push('# TYPE kolm_inference_queue_depth gauge');
  lines.push(`kolm_inference_queue_depth ${_formatNumber(_inferenceQueueDepth)}`);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Route registration — single export so router.js gets a one-line diff.
// ---------------------------------------------------------------------------

export function registerK8sRoutes(r) {
  if (!r || typeof r.get !== 'function') {
    throw new Error('registerK8sRoutes: requires an express router-like with .get()');
  }

  // W824-2 — /ready/deep
  r.get('/ready/deep', (_req, res) => {
    const snap = readinessSnapshot();
    if (isArtifactLoaded()) {
      return res.status(200).json({
        ok: true,
        status: 'ready',
        artifact_loaded: true,
        source: snap.source,
        loaded_at_ms: snap.loaded_at_ms,
        reason: snap.reason,
        version: K8S_READINESS_VERSION,
      });
    }
    return res.status(503).json({
      ok: false,
      status: 'not_ready',
      error: 'artifact_not_loaded',
      hint: 'call setArtifactLoaded(true) once the .kolm artifact finishes loading, or set KOLM_ARTIFACT_LOADED=1 in the environment',
      artifact_loaded: false,
      source: snap.source,
      version: K8S_READINESS_VERSION,
    });
  });

  // W824-3 — /metrics/extended
  r.get('/metrics/extended', async (_req, res) => {
    try {
      const body = await renderExtendedMetrics();
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return res.status(200).send(body);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'metrics_extended_render_failed',
        message: String((e && e.message) || e),
        version: K8S_ROUTES_VERSION,
      });
    }
  });

  return r;
}
