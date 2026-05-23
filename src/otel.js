/**
 * src/otel.js
 *
 * OpenTelemetry trace + metric export over OTLP/HTTP.
 *
 * kolm has structured receipts and an audit-log already, but neither shows up
 * in the buyer's existing observability stack (Honeycomb, Grafana Tempo,
 * Datadog, Jaeger). This module ships an OTLP-shaped exporter that
 * mirrors every artifact run + every /v1/* request into the buyer's OTEL
 * collector.
 *
 * Why we wrote it instead of importing @opentelemetry/sdk-node:
 *   - The full SDK pulls ~3 MB of node deps and ~30 packages. We need 200 LOC.
 *   - We already serialize what we need (start, end, attrs, status); we just
 *     have to ship it on the wire in OTLP/HTTP/JSON format.
 *   - The collector accepts the JSON variant of the protobuf schema; we don't
 *     need protobuf encoding.
 *
 * Spec:
 *   https://github.com/open-telemetry/opentelemetry-proto/tree/main/opentelemetry/proto
 *
 * Env-vars:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  default https://localhost:4318
 *   OTEL_EXPORTER_OTLP_HEADERS   "key1=val1,key2=val2"
 *   OTEL_RESOURCE_ATTRIBUTES     "service.name=kolm,deployment.environment=prod"
 *   OTEL_SERVICE_NAME            overrides service.name (default 'kolm')
 *   KOLM_OTEL                    set to "1" to enable; off otherwise.
 *
 * API:
 *   import * as otel from './src/otel.js';
 *   otel.init();                          // call once at server start
 *   const span = otel.startSpan('kolm.run', { 'kolm.artifact_id': 'art_x' });
 *   try { ... } finally { otel.endSpan(span, { status: 'ok' }); }
 *   otel.metric('kolm.k_score', 0.94, { artifact: 'art_x' });
 *   otel.shutdown();                      // flush before exit
 */

import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const STATE = {
  enabled: false,
  endpoint: null,
  headers: {},
  resource: null,
  serviceName: 'kolm',
  spanQueue: [],
  metricQueue: [],
  flushTimer: null,
  flushIntervalMs: 5000,
  maxQueueBytes: 1 << 20,  // 1 MB cap; oldest are dropped
};

function init(opts) {
  opts = opts || {};
  const enabled = (opts.enabled !== undefined) ? !!opts.enabled
                : (process.env.KOLM_OTEL === '1' || process.env.KOLM_OTEL === 'true');
  if (!enabled) return false;

  const endpoint = opts.endpoint
    || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    || 'http://localhost:4318';
  STATE.endpoint = endpoint.replace(/\/$/, '');
  STATE.serviceName = opts.serviceName
    || process.env.OTEL_SERVICE_NAME
    || 'kolm';
  STATE.headers = parseHeaders(opts.headers || process.env.OTEL_EXPORTER_OTLP_HEADERS);
  STATE.resource = buildResource(STATE.serviceName);
  STATE.enabled = true;
  STATE.flushTimer = setInterval(flush, STATE.flushIntervalMs);
  if (STATE.flushTimer.unref) STATE.flushTimer.unref();
  return true;
}

function parseHeaders(raw) {
  if (!raw) return {};
  const out = {};
  String(raw).split(',').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

function buildResource(serviceName) {
  const attrs = [
    kv('service.name', serviceName),
    kv('telemetry.sdk.language', 'nodejs'),
    kv('telemetry.sdk.name', 'kolm-otel'),
    kv('telemetry.sdk.version', '1.0'),
  ];
  const extra = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  extra.split(',').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k && k !== 'service.name') attrs.push(kv(k, v));
  });
  return { attributes: attrs };
}

function kv(key, value) {
  let v;
  if (typeof value === 'number' && Number.isInteger(value)) v = { intValue: String(value) };
  else if (typeof value === 'number') v = { doubleValue: value };
  else if (typeof value === 'boolean') v = { boolValue: value };
  else v = { stringValue: String(value) };
  return { key, value: v };
}

function makeId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function startSpan(name, attrs, parent) {
  const traceId = parent && parent.traceId ? parent.traceId : makeId(16);
  const spanId = makeId(8);
  const parentSpanId = parent && parent.spanId ? parent.spanId : undefined;
  return {
    traceId, spanId, parentSpanId,
    name,
    startTimeUnixNano: nowNs(),
    endTimeUnixNano: null,
    attributes: attrsToKv(attrs),
    status: { code: 0 },
    events: [],
  };
}

function attrsToKv(attrs) {
  if (!attrs) return [];
  const out = [];
  for (const k of Object.keys(attrs)) out.push(kv(k, attrs[k]));
  return out;
}

function nowNs() {
  return String(BigInt(Date.now()) * 1000000n);
}

function endSpan(span, opts) {
  if (!span || !STATE.enabled) return;
  span.endTimeUnixNano = nowNs();
  if (opts && opts.attrs) span.attributes.push(...attrsToKv(opts.attrs));
  if (opts && opts.events) {
    for (const ev of opts.events) {
      span.events.push({
        timeUnixNano: ev.t || nowNs(),
        name: ev.name,
        attributes: attrsToKv(ev.attrs || {}),
      });
    }
  }
  const status = opts && opts.status;
  if (status === 'error') span.status = { code: 2, message: (opts.message || '').slice(0, 256) };
  else if (status === 'ok') span.status = { code: 1 };
  STATE.spanQueue.push(span);
  trimQueue();
}

function metric(name, value, attrs) {
  if (!STATE.enabled) return;
  STATE.metricQueue.push({
    name,
    description: '',
    unit: '',
    gauge: {
      dataPoints: [{
        timeUnixNano: nowNs(),
        asDouble: typeof value === 'number' ? value : Number(value) || 0,
        attributes: attrsToKv(attrs || {}),
      }],
    },
  });
  trimQueue();
}

function counter(name, increment, attrs) {
  if (!STATE.enabled) return;
  STATE.metricQueue.push({
    name,
    description: '',
    unit: '',
    sum: {
      isMonotonic: true,
      aggregationTemporality: 2,  // CUMULATIVE
      dataPoints: [{
        timeUnixNano: nowNs(),
        asInt: String(Math.max(0, Math.floor(increment))),
        attributes: attrsToKv(attrs || {}),
      }],
    },
  });
  trimQueue();
}

function trimQueue() {
  let bytes = JSON.stringify(STATE.spanQueue).length + JSON.stringify(STATE.metricQueue).length;
  while (bytes > STATE.maxQueueBytes && (STATE.spanQueue.length + STATE.metricQueue.length) > 0) {
    if (STATE.spanQueue.length) STATE.spanQueue.shift();
    else STATE.metricQueue.shift();
    bytes = JSON.stringify(STATE.spanQueue).length + JSON.stringify(STATE.metricQueue).length;
  }
}

async function flush() {
  if (!STATE.enabled) return;
  const spans = STATE.spanQueue.splice(0, STATE.spanQueue.length);
  const metrics = STATE.metricQueue.splice(0, STATE.metricQueue.length);
  if (spans.length === 0 && metrics.length === 0) return;
  const tasks = [];
  if (spans.length) tasks.push(postJson('/v1/traces', tracesPayload(spans)));
  if (metrics.length) tasks.push(postJson('/v1/metrics', metricsPayload(metrics)));
  try {
    await Promise.all(tasks);
  } catch (err) {
    // Best-effort: put them back at the front but cap at the queue budget.
    STATE.spanQueue.unshift(...spans.slice(-50));
    STATE.metricQueue.unshift(...metrics.slice(-50));
    trimQueue();
    if (process.env.KOLM_OTEL_DEBUG) {
      // Failure should not bring down the host process; log once at debug.
      // eslint-disable-next-line no-console
      console.warn('[kolm.otel] export failed:', err && err.message);
    }
  }
}

function tracesPayload(spans) {
  return {
    resourceSpans: [{
      resource: STATE.resource,
      scopeSpans: [{
        scope: { name: 'kolm-otel', version: '1.0' },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          name: s.name,
          kind: 1,
          startTimeUnixNano: s.startTimeUnixNano,
          endTimeUnixNano: s.endTimeUnixNano || nowNs(),
          attributes: s.attributes,
          events: s.events,
          status: s.status,
        })),
      }],
    }],
  };
}

function metricsPayload(metrics) {
  return {
    resourceMetrics: [{
      resource: STATE.resource,
      scopeMetrics: [{
        scope: { name: 'kolm-otel', version: '1.0' },
        metrics,
      }],
    }],
  };
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(STATE.endpoint + path);
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        STATE.headers,
      ),
    };
    const transport = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    opts.headers['content-length'] = Buffer.byteLength(data);
    const req = transport.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
        reject(new Error(`OTLP ${path} -> ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('OTLP timeout')));
    req.write(data);
    req.end();
  });
}

async function shutdown() {
  if (STATE.flushTimer) clearInterval(STATE.flushTimer);
  STATE.flushTimer = null;
  await flush();
  STATE.enabled = false;
}

function isEnabled() { return STATE.enabled; }

function expressMiddleware() {
  return function otelMiddleware(req, res, next) {
    if (!STATE.enabled) return next();
    const span = startSpan(`HTTP ${req.method} ${routePattern(req)}`, {
      'http.method': req.method,
      'http.target': req.originalUrl || req.url,
      'http.route': routePattern(req),
      'http.user_agent': req.get && req.get('user-agent') || '',
    });
    res.on('finish', () => {
      const code = res.statusCode;
      const attrs = { 'http.status_code': code };
      const status = code >= 500 ? 'error' : 'ok';
      endSpan(span, { status, attrs, message: status === 'error' ? `HTTP ${code}` : undefined });
    });
    req.kolmSpan = span;
    next();
  };
}

function routePattern(req) {
  return (req.route && req.route.path)
    || (req.baseUrl && req.path && (req.baseUrl + req.path))
    || req.path
    || req.url
    || '';
}

// =============================================================================
// W733 — OpenTelemetry Semantic Conventions
//
// Atomic additions (W707 plan W733-1/-2/-3):
//   * KOLM_OTEL_ATTRS    — the kolm.* attribute namespace (token confidence,
//                          routing decision, K-Score, K-Score 24h drift,
//                          artifact CID, tenant id_hash, namespace).
//   * KOLM_OTEL_SPAN_NAMES — sub-span structure for the inference timeline
//                          (queue → load → prefill → decode).
//   * createInferenceSpans(parent, timings) — emits 4 child spans with
//                          relative start-time offsets so they render as a
//                          stacked timeline in any OTel UI.
//   * setRoutingAttributes(span, w709Block) — pure attacher; safely no-ops
//                          when span or @opentelemetry/api are absent.
//
// Privacy contract (W733 #6): tenant_id NEVER appears as a raw attribute.
// We expose ONLY a sha256-derived 12-char hex prefix as kolm.tenant.id_hash
// so traces stay linkable across spans for the same tenant without leaking
// the identifier into the buyer's tracing backend.
//
// Optional dep: @opentelemetry/api is OPTIONAL. We never list it in
// package.json. At runtime we try-import it lazily; if absent we fall
// through to the existing STATE.enabled-driven kolm-native exporter above
// and remain honest no-ops if neither path is wired. The "honest no-op"
// promise is critical — we never throw on a missing tracer because that
// would put OTel in the request hot-path on uninstrumented hosts.
// =============================================================================

const OTEL_W733_VERSION = 'w733-v1';

const KOLM_OTEL_ATTRS = Object.freeze({
  // W709 token-level confidence (mean Shannon entropy per span, or per-token
  // gauge if the caller emits sub-spans per token). Unit: nats.
  TOKEN_CONFIDENCE: 'kolm.token.confidence',
  // W709 routing decision: 'student' | 'teacher' | 'mixed'.
  ROUTING_DECISION: 'kolm.routing.decision',
  // W709 routing-threshold entropy. Unit: nats. The threshold that fired,
  // not the per-token entropy — that lives on per-token sub-spans.
  ROUTING_ENTROPY_NATS: 'kolm.routing.entropy_nats',
  // W733 K-Score at the time the inference ran.
  KSCORE_VALUE: 'kolm.kscore.value',
  // W733 K-Score 24h drift (current minus 24h-ago baseline).
  KSCORE_DRIFT_24H: 'kolm.kscore.drift_24h',
  // W144 artifact content-id (immutable).
  ARTIFACT_CID: 'kolm.artifact.cid',
  // W733 tenant id_hash — sha256 prefix, NEVER raw tenant_id (see privacy
  // contract above). 12 hex chars = 48 bits = collision-safe for the use
  // case (linking spans across a single tenant inside one tenant's trace
  // budget).
  TENANT_ID_HASH: 'kolm.tenant.id_hash',
  // W245 namespace (already public — appears in routes, capture rows,
  // metrics). Safe to emit raw.
  NAMESPACE: 'kolm.namespace',
});

const KOLM_OTEL_SPAN_NAMES = Object.freeze({
  // W729 load queue → time-in-queue before the request was picked up.
  QUEUE: 'kolm.inference.queue',
  // W729 model load → 0 ms if the artifact was already paged into VRAM.
  LOAD: 'kolm.inference.load',
  // Prefill compute (prompt → KV cache).
  PREFILL: 'kolm.inference.prefill',
  // Decode loop (KV cache → output tokens).
  DECODE: 'kolm.inference.decode',
});

// Lazy @opentelemetry/api detection. Caches the module if present so we
// only pay the try-import cost once per process. We DO NOT add the dep —
// only honor it if the host installed it for their own instrumentation.
let _otelApi = null;
let _otelApiDetected = false;
let _otelApiProbed = false;

async function _probeOtelApi() {
  if (_otelApiProbed) return _otelApiDetected;
  _otelApiProbed = true;
  try {
    _otelApi = await import('@opentelemetry/api');
    _otelApiDetected = !!_otelApi;
  } catch (_e) {
    _otelApi = null;
    _otelApiDetected = false;
  }
  return _otelApiDetected;
}

function _isOtelApiDetectedSync() {
  return _otelApiDetected;
}

function _getRegisteredTracer() {
  if (globalThis.__OTEL_TRACER__) return globalThis.__OTEL_TRACER__;
  if (_otelApi && _otelApi.trace && typeof _otelApi.trace.getTracer === 'function') {
    try { return _otelApi.trace.getTracer('kolm', OTEL_W733_VERSION); } catch (_e) { return null; }
  }
  return null;
}

function _hashTenant(rawTenantId) {
  if (!rawTenantId) return null;
  return crypto.createHash('sha256').update(String(rawTenantId)).digest('hex').slice(0, 12);
}

// Pure helper — attaches W709 routing block attributes to a span. Safe to
// call with span=null (no-op); safe to call with a kolm-native span object
// from startSpan() above OR an @opentelemetry/api Span (both honor
// setAttribute(key, value) and our native path appends to span.attributes).
function setRoutingAttributes(span, block) {
  if (!span || !block || typeof block !== 'object') return false;
  const out = {};
  if (typeof block.decision === 'string') out[KOLM_OTEL_ATTRS.ROUTING_DECISION] = block.decision;
  else if (block.decision && typeof block.decision === 'object' && typeof block.decision.route === 'string') {
    out[KOLM_OTEL_ATTRS.ROUTING_DECISION] = block.decision.route;
  }
  if (Number.isFinite(Number(block.entropy_nats))) out[KOLM_OTEL_ATTRS.ROUTING_ENTROPY_NATS] = Number(block.entropy_nats);
  if (Number.isFinite(Number(block.confidence))) out[KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE] = Number(block.confidence);
  if (Number.isFinite(Number(block.kscore))) out[KOLM_OTEL_ATTRS.KSCORE_VALUE] = Number(block.kscore);
  if (Number.isFinite(Number(block.kscore_drift_24h))) out[KOLM_OTEL_ATTRS.KSCORE_DRIFT_24H] = Number(block.kscore_drift_24h);
  if (typeof block.artifact_cid === 'string') out[KOLM_OTEL_ATTRS.ARTIFACT_CID] = block.artifact_cid;
  if (typeof block.namespace === 'string') out[KOLM_OTEL_ATTRS.NAMESPACE] = block.namespace;
  if (block.tenant_id) {
    // Privacy — only the sha256 prefix ever crosses the OTel boundary.
    const hashed = _hashTenant(block.tenant_id);
    if (hashed) out[KOLM_OTEL_ATTRS.TENANT_ID_HASH] = hashed;
  }
  // Native kolm-otel span shape from startSpan() — attributes is a kv array.
  if (Array.isArray(span.attributes)) {
    for (const k of Object.keys(out)) span.attributes.push(kv(k, out[k]));
    return true;
  }
  // @opentelemetry/api Span shape — setAttribute(key, value).
  if (typeof span.setAttribute === 'function') {
    for (const k of Object.keys(out)) {
      try { span.setAttribute(k, out[k]); } catch (_e) { /* ignore one bad attr */ }
    }
    return true;
  }
  return false;
}

// Emits 4 inference sub-spans (queue → load → prefill → decode) with
// monotonically-advancing start times so the buyer's OTel UI renders them
// as a stacked timeline below the parent kolm.inference span. Tolerates
// (a) missing parent, (b) missing tracer, (c) missing @opentelemetry/api
// — all of which collapse to an honest no-op + return false. Never throws.
function createInferenceSpans(parentSpan, timings) {
  timings = timings || {};
  const queueMs = Number(timings.queue_ms) || 0;
  const loadMs = Number(timings.load_ms) || 0;
  const prefillMs = Number(timings.prefill_ms) || 0;
  const decodeMs = Number(timings.decode_ms) || 0;
  // No tracer + no native otel state? Honest no-op.
  const tracer = _getRegisteredTracer();
  if (!tracer && !STATE.enabled) {
    if (process.env.KOLM_OTEL_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[kolm.otel] createInferenceSpans no-op: no tracer registered, KOLM_OTEL=0');
    }
    return false;
  }
  const baseT = Date.now();
  // Native-path emission: directly enqueue 4 child spans into STATE.spanQueue
  // through endSpan() so they ride the existing OTLP flush loop. We compute
  // start/end deltas in ns from the offset budget so the timeline renders
  // queue → load → prefill → decode in order without overlap.
  const parentTraceId = (parentSpan && parentSpan.traceId) || null;
  const parentSpanId = (parentSpan && parentSpan.spanId) || null;
  let offsetMs = 0;
  const segments = [
    { name: KOLM_OTEL_SPAN_NAMES.QUEUE, ms: queueMs },
    { name: KOLM_OTEL_SPAN_NAMES.LOAD, ms: loadMs },
    { name: KOLM_OTEL_SPAN_NAMES.PREFILL, ms: prefillMs },
    { name: KOLM_OTEL_SPAN_NAMES.DECODE, ms: decodeMs },
  ];
  const emitted = [];
  for (const seg of segments) {
    const startMs = baseT + offsetMs;
    const endMs = startMs + Math.max(0, seg.ms);
    const child = {
      traceId: parentTraceId || makeId(16),
      spanId: makeId(8),
      parentSpanId: parentSpanId || undefined,
      name: seg.name,
      startTimeUnixNano: String(BigInt(startMs) * 1000000n),
      endTimeUnixNano: String(BigInt(endMs) * 1000000n),
      attributes: [kv('kolm.inference.phase_ms', seg.ms)],
      status: { code: 1 },
      events: [],
    };
    if (STATE.enabled) {
      STATE.spanQueue.push(child);
    }
    emitted.push(child);
    offsetMs += Math.max(0, seg.ms);
  }
  if (STATE.enabled) trimQueue();
  // If @opentelemetry/api tracer is also registered, mirror via tracer
  // hook — but tolerate any tracer impl that doesn't honor our minimal
  // contract by catching+continuing.
  if (tracer && typeof tracer.startSpan === 'function') {
    try {
      for (const seg of segments) {
        const s = tracer.startSpan(seg.name);
        if (s && typeof s.setAttribute === 'function') s.setAttribute('kolm.inference.phase_ms', seg.ms);
        if (s && typeof s.end === 'function') s.end();
      }
    } catch (_e) { /* honest no-op on tracer error */ }
  }
  return emitted;
}

function getW733Status() {
  return {
    ok: true,
    version: OTEL_W733_VERSION,
    otel_api_detected: _isOtelApiDetectedSync(),
    tracer_registered: !!_getRegisteredTracer(),
    native_enabled: STATE.enabled,
  };
}

function listW733Attrs() {
  return Object.assign({}, KOLM_OTEL_ATTRS);
}

function listW733SpanNames() {
  return Object.assign({}, KOLM_OTEL_SPAN_NAMES);
}

export {
  init,
  startSpan,
  endSpan,
  metric,
  counter,
  flush,
  shutdown,
  isEnabled,
  expressMiddleware,
  // W733 — semantic conventions surface.
  OTEL_W733_VERSION,
  KOLM_OTEL_ATTRS,
  KOLM_OTEL_SPAN_NAMES,
  createInferenceSpans,
  setRoutingAttributes,
  getW733Status,
  listW733Attrs,
  listW733SpanNames,
  _probeOtelApi,
};
