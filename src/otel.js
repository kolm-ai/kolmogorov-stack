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
          // SpanKind: 1=INTERNAL (default, back-compat with the kolm.* path),
          // 3=CLIENT (GenAI inference spans — the gateway is a client of the
          // upstream provider per OTel SemConv gen-ai-spans).
          kind: Number.isInteger(s.kind) ? s.kind : 1,
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
  // W823-1 — extends W733 attrs.
  //
  // ARTIFACT_ID is a stable per-deployment identifier (the W144 artifact
  // pointer the runtime is currently serving). This is different from
  // ARTIFACT_CID (the immutable content-id of the on-disk .kolm) — buyers
  // dashboard by deployment, not by content-hash, so both must travel.
  ARTIFACT_ID: 'kolm.artifact.id',
  // W823 p50/p95 token confidence — distribution stats over a span. We
  // already expose TOKEN_CONFIDENCE (mean entropy); these add the
  // percentile pair for histogram-class panels.
  TOKEN_CONFIDENCE_P50: 'kolm.token.confidence_p50',
  TOKEN_CONFIDENCE_P95: 'kolm.token.confidence_p95',
  // W823 kscore_drift — caller-supplied drift window (default 24h above
  // via KSCORE_DRIFT_24H; KSCORE_DRIFT is the open-window variant so the
  // buyer can pick the comparison baseline). Unit: K-Score points.
  KSCORE_DRIFT: 'kolm.kscore.drift',
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
  if (Number.isFinite(Number(block.kscore_drift))) out[KOLM_OTEL_ATTRS.KSCORE_DRIFT] = Number(block.kscore_drift);
  if (typeof block.artifact_cid === 'string') out[KOLM_OTEL_ATTRS.ARTIFACT_CID] = block.artifact_cid;
  if (typeof block.artifact_id === 'string') out[KOLM_OTEL_ATTRS.ARTIFACT_ID] = block.artifact_id;
  if (Number.isFinite(Number(block.token_confidence_p50))) out[KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P50] = Number(block.token_confidence_p50);
  if (Number.isFinite(Number(block.token_confidence_p95))) out[KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P95] = Number(block.token_confidence_p95);
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

// =============================================================================
// W921 — OpenTelemetry GenAI semantic conventions (gen_ai.*)
//
// Standard OTel GenAI inference span + the three GenAI client metrics emitted
// from the /v1/gateway/dispatch path so a buyer's existing Datadog / Grafana
// Tempo / Honeycomb / Phoenix / OpenLLMetry pipeline lights up kolm gateway
// traffic with ZERO custom mapping. kolm.* (W733/W823) stays additive
// enrichment on the SAME span via setRoutingAttributes — one span carries
// both dialects.
//
// Spec verified against OTel SemConv v1.37 (2026-05-29):
//   gen-ai-spans   : https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
//   gen-ai-metrics : https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
//   attribute reg  : https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
//
// Migration: gen_ai.system is DEPRECATED, replaced by gen_ai.provider.name.
// We dual-emit gen_ai.system ONLY under KOLM_OTEL_SEMCONV_COMPAT=1.
//
// Privacy: CONTENT attributes (gen_ai.input.messages / gen_ai.output.messages /
// gen_ai.system_instructions) are OPT-IN ONLY and SHOULD NOT be captured by
// default. Under KOLM_OTEL_CAPTURE_CONTENT=1 we emit ONLY post-redaction text,
// so no un-redacted PII reaches a trace backend.
//
// Gating: every GenAI emitter is a hard no-op unless isEnabled() (native
// exporter wired via KOLM_OTEL=1) OR a host @opentelemetry/api tracer is
// registered — identical to the existing kolm.inference wrapper. Never throws
// on the request hot-path.
// =============================================================================

const OTEL_GENAI_VERSION = 'w921-genai-v1';

// One source of truth for every gen_ai.* key string so a semconv key rename
// is a one-line change here, not a grep-and-replace across the codebase.
const GEN_AI_ATTRS = Object.freeze({
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  // DEPRECATED — emitted only under KOLM_OTEL_SEMCONV_COMPAT=1.
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  TIME_TO_FIRST_CHUNK: 'gen_ai.response.time_to_first_chunk',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  TOKEN_TYPE: 'gen_ai.token.type',
  // Opt-in content (KOLM_OTEL_CAPTURE_CONTENT=1, post-redaction only).
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
  // Shared (non gen_ai.* namespace per SemConv).
  SERVER_ADDRESS: 'server.address',
  SERVER_PORT: 'server.port',
  ERROR_TYPE: 'error.type',
  // kolm extension namespace — raw provider when no clean enum member exists.
  PROVIDER_RAW: 'kolm.provider.raw',
});

const GEN_AI_METRICS = Object.freeze({
  TOKEN_USAGE: 'gen_ai.client.token.usage',
  OPERATION_DURATION: 'gen_ai.client.operation.duration',
  TIME_TO_FIRST_TOKEN: 'gen_ai.server.time_to_first_token',
});

// Exact bucket boundaries from OTel SemConv v1.37 — byte-match required so a
// buyer's pre-aggregated GenAI dashboards line up without a custom view.
const GENAI_TOKEN_BUCKETS = Object.freeze([1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864]);
const GENAI_DURATION_BUCKETS = Object.freeze([0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]);
const GENAI_TTFT_BUCKETS = Object.freeze([0.001, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0]);

// Well-known gen_ai.provider.name enum members (OTel SemConv attribute
// registry). kolm provider slugs that don't map cleanly fall through to a
// lowercased passthrough and stamp the raw slug under kolm.provider.raw.
const _PROVIDER_ENUM = Object.freeze({
  anthropic: 'anthropic',
  openai: 'openai',
  azure_openai: 'azure.ai.openai',
  'azure-openai': 'azure.ai.openai',
  azure: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
  aws: 'aws.bedrock',
  'aws-bedrock': 'aws.bedrock',
  cohere: 'cohere',
  deepseek: 'deepseek',
  google: 'gcp.gemini',
  gemini: 'gcp.gemini',
  'google-gemini': 'gcp.gemini',
  vertex: 'gcp.vertex_ai',
  'vertex-ai': 'gcp.vertex_ai',
  vertexai: 'gcp.vertex_ai',
  groq: 'groq',
  watsonx: 'ibm.watsonx.ai',
  mistral: 'mistral_ai',
  mistralai: 'mistral_ai',
  'mistral-ai': 'mistral_ai',
  perplexity: 'perplexity',
  xai: 'x_ai',
  'x-ai': 'x_ai',
  grok: 'x_ai',
});

// Map a kolm provider slug to the OTel gen_ai.provider.name well-known enum.
// openrouter is a passthrough aggregator with no enum member: when the
// underlying vendor is derivable (e.g. "openrouter/anthropic") use it, else
// fall back to a lowercased passthrough. Returns a lowercased string always.
function mapProviderToGenAi(kolmProvider) {
  if (!kolmProvider) return 'unknown';
  const raw = String(kolmProvider).trim().toLowerCase();
  if (!raw) return 'unknown';
  // Aggregator passthrough: "openrouter/anthropic", "openrouter:openai".
  if (raw.startsWith('openrouter')) {
    const sub = raw.replace(/^openrouter[\/:]?/, '');
    if (sub && _PROVIDER_ENUM[sub]) return _PROVIDER_ENUM[sub];
    if (sub && !sub.includes('openrouter')) return sub.replace(/[^a-z0-9._-]+/g, '_');
    return 'openrouter';
  }
  if (_PROVIDER_ENUM[raw]) return _PROVIDER_ENUM[raw];
  // Substring vendor sniff for compound slugs.
  for (const key of Object.keys(_PROVIDER_ENUM)) {
    if (raw.includes(key)) return _PROVIDER_ENUM[key];
  }
  // Lowercased fallback — keep it OTel-attribute-safe.
  return raw.replace(/[^a-z0-9._-]+/g, '_');
}

// Normalize a provider-native finish/stop reason to the OpenAI vocabulary
// (stop | length | tool_calls | content_filter). Anthropic stop_reason is
// mapped; OpenAI passes through. null/undefined -> undefined (so the caller
// simply omits the attribute).
function mapFinishReason(provider, raw) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const r = String(raw).trim();
  if (!r) return undefined;
  const p = provider ? String(provider).toLowerCase() : '';
  const isAnthropic = p.includes('anthropic') || p.includes('claude');
  const ANTHROPIC_MAP = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    pause_turn: 'stop',
    refusal: 'content_filter',
    model_context_window_exceeded: 'length',
  };
  if (isAnthropic && ANTHROPIC_MAP[r]) return ANTHROPIC_MAP[r];
  // Even for non-anthropic-tagged providers, defensively normalize the
  // anthropic-only tokens (some chains relabel the provider mid-flight).
  if (ANTHROPIC_MAP[r] && !['stop', 'length', 'tool_calls', 'content_filter'].includes(r)) {
    return ANTHROPIC_MAP[r];
  }
  // OpenAI vocabulary passthrough + lowercased fallback for anything else.
  return r.toLowerCase();
}

// Extract an array of normalized finish reasons from a raw upstream response
// body (OpenAI-shape choices[].finish_reason OR Anthropic stop_reason). Always
// returns string[] (possibly empty), never null — safe for the array attr.
function extractFinishReasons(provider, responseJson) {
  if (!responseJson || typeof responseJson !== 'object') return [];
  const out = [];
  if (Array.isArray(responseJson.choices)) {
    for (const c of responseJson.choices) {
      const fr = c && (c.finish_reason !== undefined ? c.finish_reason : c.finishReason);
      const mapped = mapFinishReason(provider, fr);
      if (mapped) out.push(mapped);
    }
  }
  const stopReason = responseJson.stop_reason !== undefined ? responseJson.stop_reason : responseJson.stopReason;
  if (out.length === 0 && stopReason !== undefined) {
    const mapped = mapFinishReason(provider, stopReason);
    if (mapped) out.push(mapped);
  }
  return out;
}

// True when ANY emit path is live: native exporter (KOLM_OTEL=1) or a host
// @opentelemetry/api tracer registered. Mirrors the kolm.inference gate.
function _genAiActive() {
  return STATE.enabled || !!_getRegisteredTracer();
}

function _scalarAnyValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return { stringValue: String(value) };
}

// Append a gen_ai.* attribute to a kolm-native span (kv-array) OR an
// @opentelemetry/api Span (setAttribute). Drops null/undefined values so we
// never emit an empty attribute. Arrays become an OTLP arrayValue (native) or
// pass straight to setAttribute (which accepts string[]).
function _setSpanAttr(span, key, value) {
  if (!span || value === null || value === undefined) return;
  if (Array.isArray(span.attributes)) {
    if (Array.isArray(value)) {
      span.attributes.push({ key, value: { arrayValue: { values: value.map((v) => _scalarAnyValue(v)) } } });
    } else {
      span.attributes.push(kv(key, value));
    }
    return;
  }
  if (typeof span.setAttribute === 'function') {
    try { span.setAttribute(key, value); } catch (_e) { /* ignore one bad attr */ }
  }
}

// Start a GenAI inference CLIENT span. Returns a kolm-native span object (or
// an @opentelemetry/api span when a host tracer is registered) or null when
// telemetry is inactive (honest no-op). span name = `{operation} {model}`.
function startGenAiSpan({ operation = 'chat', provider, requestModel, maxTokens, temperature, namespace, tenant_id, parent } = {}) {
  if (!_genAiActive()) return null;
  let span;
  try {
    const providerName = mapProviderToGenAi(provider);
    const name = requestModel ? `${operation} ${requestModel}` : String(operation);
    // Prefer a registered host tracer (so the span joins the buyer's trace
    // context); otherwise use the kolm-native span shape that rides our OTLP
    // flush loop. Both honor setAttribute / the kv-array contract.
    const tracer = _getRegisteredTracer();
    if (tracer && typeof tracer.startSpan === 'function') {
      // SpanKind.CLIENT === 3 in @opentelemetry/api.
      span = tracer.startSpan(name, { kind: 3 });
    } else {
      span = startSpan(name, {}, parent);
      span.kind = 3; // CLIENT — honored by tracesPayload.
    }
    _setSpanAttr(span, GEN_AI_ATTRS.OPERATION_NAME, operation);
    _setSpanAttr(span, GEN_AI_ATTRS.PROVIDER_NAME, providerName);
    // Stamp the raw kolm provider slug when the enum mapping was lossy.
    if (provider && providerName !== String(provider).trim().toLowerCase()) {
      _setSpanAttr(span, GEN_AI_ATTRS.PROVIDER_RAW, String(provider));
    }
    if (process.env.KOLM_OTEL_SEMCONV_COMPAT === '1') {
      // Deprecated dual-emit — same value as provider.name.
      _setSpanAttr(span, GEN_AI_ATTRS.SYSTEM, providerName);
    }
    if (requestModel) _setSpanAttr(span, GEN_AI_ATTRS.REQUEST_MODEL, String(requestModel));
    if (Number.isFinite(Number(maxTokens))) _setSpanAttr(span, GEN_AI_ATTRS.REQUEST_MAX_TOKENS, Math.trunc(Number(maxTokens)));
    if (Number.isFinite(Number(temperature))) _setSpanAttr(span, GEN_AI_ATTRS.REQUEST_TEMPERATURE, Number(temperature));
    // kolm enrichment — namespace is public-safe; tenant goes through the
    // W733 hash path so the raw id never crosses the OTel boundary.
    if (typeof namespace === 'string' && namespace) _setSpanAttr(span, KOLM_OTEL_ATTRS.NAMESPACE, namespace);
    if (tenant_id) {
      const hashed = _hashTenant(tenant_id);
      if (hashed) _setSpanAttr(span, KOLM_OTEL_ATTRS.TENANT_ID_HASH, hashed);
    }
    // Stash provider for finish-time finish-reason mapping + metric attrs.
    if (span && typeof span === 'object') {
      span.__genai = { provider, providerName, requestModel, operation, startMs: Date.now() };
    }
  } catch (_e) {
    return span || null;
  }
  return span || null;
}

// Finish a GenAI span: set response attrs, set status + error.type on
// failure, emit opt-in post-redaction content, end the span, and emit the
// three GenAI client metrics in one place. Honest no-op when span is null.
function finishGenAiSpan(span, {
  responseModel, responseId, finishReasons,
  inputTokens, outputTokens, durationMs, ttftMs,
  status = 'ok', errorType, serverAddress, serverPort,
  outputContent, inputContent,
} = {}) {
  // Even with a null span (telemetry inactive at start) we keep the metric
  // emit gated below — metrics are also a hard no-op when inactive.
  const meta = (span && span.__genai) || {};
  const provider = meta.provider;
  const providerName = meta.providerName || mapProviderToGenAi(provider);
  const requestModel = meta.requestModel;
  const operation = meta.operation || 'chat';
  const isError = status === 'error' || (errorType !== undefined && errorType !== null);

  if (span) {
    try {
      if (responseModel) _setSpanAttr(span, GEN_AI_ATTRS.RESPONSE_MODEL, String(responseModel));
      if (responseId) _setSpanAttr(span, GEN_AI_ATTRS.RESPONSE_ID, String(responseId));
      let reasons = finishReasons;
      if (!Array.isArray(reasons)) reasons = (reasons === undefined || reasons === null) ? [] : [reasons];
      reasons = reasons.map((r) => mapFinishReason(provider, r)).filter((r) => r !== undefined);
      if (reasons.length) _setSpanAttr(span, GEN_AI_ATTRS.FINISH_REASONS, reasons);
      if (Number.isFinite(Number(inputTokens))) _setSpanAttr(span, GEN_AI_ATTRS.USAGE_INPUT_TOKENS, Math.trunc(Number(inputTokens)));
      if (Number.isFinite(Number(outputTokens))) _setSpanAttr(span, GEN_AI_ATTRS.USAGE_OUTPUT_TOKENS, Math.trunc(Number(outputTokens)));
      if (Number.isFinite(Number(ttftMs))) _setSpanAttr(span, GEN_AI_ATTRS.TIME_TO_FIRST_CHUNK, Number(ttftMs) / 1000);
      if (serverAddress) _setSpanAttr(span, GEN_AI_ATTRS.SERVER_ADDRESS, String(serverAddress));
      if (Number.isFinite(Number(serverPort))) _setSpanAttr(span, GEN_AI_ATTRS.SERVER_PORT, Math.trunc(Number(serverPort)));
      if (isError && errorType !== undefined && errorType !== null) {
        _setSpanAttr(span, GEN_AI_ATTRS.ERROR_TYPE, String(errorType));
      }
      // Opt-in content (post-redaction text ONLY). Caller is responsible for
      // passing already-redacted strings — this is the privacy chokepoint.
      if (process.env.KOLM_OTEL_CAPTURE_CONTENT === '1') {
        if (typeof inputContent === 'string' && inputContent) _setSpanAttr(span, GEN_AI_ATTRS.INPUT_MESSAGES, inputContent);
        if (typeof outputContent === 'string' && outputContent) _setSpanAttr(span, GEN_AI_ATTRS.OUTPUT_MESSAGES, outputContent);
      }
      // End the span via the right path.
      if (Array.isArray(span.attributes)) {
        endSpan(span, { status: isError ? 'error' : 'ok', message: isError ? String(errorType || 'error') : undefined });
      } else if (typeof span.end === 'function') {
        if (typeof span.setStatus === 'function') {
          // OTel api StatusCode: 1=OK, 2=ERROR.
          try { span.setStatus({ code: isError ? 2 : 1 }); } catch (_e) { /* ignore */ }
        }
        span.end();
      }
    } catch (_e) { /* never throw on the hot path */ }
  }

  // Emit the three GenAI client metrics (each is a hard no-op when inactive).
  try {
    genAiTokenUsage({ provider, requestModel, responseModel, operation, inputTokens, outputTokens, serverAddress, serverPort });
    genAiOperationDuration({ provider, requestModel, responseModel, operation, durationMs, errorType: isError ? errorType : undefined, serverAddress, serverPort });
    if (Number.isFinite(Number(ttftMs))) {
      genAiTimeToFirstToken({ provider, requestModel, responseModel, operation, ttftMs, serverAddress, serverPort });
    }
  } catch (_e) { /* metrics are best-effort */ }
}

// Generic explicit-bucket histogram instrument. The hand-rolled exporter only
// had gauge (metric()) + monotonic sum (counter()); GenAI metrics are
// explicit-bucket histograms. Queues an OTLP histogram dataPoint with
// explicitBounds + bucketCounts + count + sum. Hard no-op when inactive.
function histogram(name, value, { unit = '', bounds = [], attrs = {}, description = '' } = {}) {
  if (!STATE.enabled) return;
  const v = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(v)) return;
  const explicitBounds = Array.isArray(bounds) ? bounds.map((b) => Number(b)) : [];
  // bucketCounts length MUST be explicitBounds.length + 1 (OTLP histogram
  // contract: N boundaries => N+1 buckets including the +Inf overflow bucket).
  const bucketCounts = new Array(explicitBounds.length + 1).fill(0);
  let placed = false;
  for (let i = 0; i < explicitBounds.length; i++) {
    if (v <= explicitBounds[i]) { bucketCounts[i] = 1; placed = true; break; }
  }
  if (!placed) bucketCounts[bucketCounts.length - 1] = 1; // +Inf overflow bucket
  STATE.metricQueue.push({
    name,
    description: description || '',
    unit: unit || '',
    histogram: {
      aggregationTemporality: 2, // CUMULATIVE
      dataPoints: [{
        startTimeUnixNano: nowNs(),
        timeUnixNano: nowNs(),
        count: '1',
        sum: v,
        min: v,
        max: v,
        bucketCounts: bucketCounts.map((c) => String(c)),
        explicitBounds,
        attributes: attrsToKv(attrs || {}),
      }],
    },
  });
  trimQueue();
}

// gen_ai.client.token.usage — Histogram, unit {token}. Emitted TWICE per call
// (gen_ai.token.type=input value=input_tokens; type=output value=output_tokens).
function genAiTokenUsage({ provider, requestModel, responseModel, operation = 'chat', inputTokens, outputTokens, serverAddress, serverPort } = {}) {
  if (!STATE.enabled) return;
  const base = _genAiMetricAttrs({ provider, requestModel, responseModel, operation, serverAddress, serverPort });
  if (Number.isFinite(Number(inputTokens))) {
    const a = Object.assign({}, base); a[GEN_AI_ATTRS.TOKEN_TYPE] = 'input';
    histogram(GEN_AI_METRICS.TOKEN_USAGE, Math.trunc(Number(inputTokens)), { unit: '{token}', bounds: GENAI_TOKEN_BUCKETS, attrs: a, description: 'Number of input tokens used' });
  }
  if (Number.isFinite(Number(outputTokens))) {
    const a = Object.assign({}, base); a[GEN_AI_ATTRS.TOKEN_TYPE] = 'output';
    histogram(GEN_AI_METRICS.TOKEN_USAGE, Math.trunc(Number(outputTokens)), { unit: '{token}', bounds: GENAI_TOKEN_BUCKETS, attrs: a, description: 'Number of output tokens used' });
  }
}

// gen_ai.client.operation.duration — Histogram, unit s (SECONDS not ms).
// value = upstream call seconds (durationMs/1000), error.type when failed.
function genAiOperationDuration({ provider, requestModel, responseModel, operation = 'chat', durationMs, errorType, serverAddress, serverPort } = {}) {
  if (!STATE.enabled) return;
  if (!Number.isFinite(Number(durationMs))) return;
  const a = _genAiMetricAttrs({ provider, requestModel, responseModel, operation, serverAddress, serverPort });
  if (errorType !== undefined && errorType !== null) a[GEN_AI_ATTRS.ERROR_TYPE] = String(errorType);
  histogram(GEN_AI_METRICS.OPERATION_DURATION, Number(durationMs) / 1000, { unit: 's', bounds: GENAI_DURATION_BUCKETS, attrs: a, description: 'GenAI operation duration' });
}

// gen_ai.server.time_to_first_token — Histogram, unit s. SSE first-chunk delta
// (synthetic until true upstream streaming lands).
function genAiTimeToFirstToken({ provider, requestModel, responseModel, operation = 'chat', ttftMs, serverAddress, serverPort } = {}) {
  if (!STATE.enabled) return;
  if (!Number.isFinite(Number(ttftMs))) return;
  const a = _genAiMetricAttrs({ provider, requestModel, responseModel, operation, serverAddress, serverPort });
  histogram(GEN_AI_METRICS.TIME_TO_FIRST_TOKEN, Number(ttftMs) / 1000, { unit: 's', bounds: GENAI_TTFT_BUCKETS, attrs: a, description: 'Time to first token in seconds' });
}

// Shared metric attr set: REQUIRED {operation.name, provider.name} +
// RECOMMENDED {request.model, response.model, server.address, server.port}.
function _genAiMetricAttrs({ provider, requestModel, responseModel, operation = 'chat', serverAddress, serverPort }) {
  const a = {};
  a[GEN_AI_ATTRS.OPERATION_NAME] = operation;
  a[GEN_AI_ATTRS.PROVIDER_NAME] = mapProviderToGenAi(provider);
  if (requestModel) a[GEN_AI_ATTRS.REQUEST_MODEL] = String(requestModel);
  if (responseModel) a[GEN_AI_ATTRS.RESPONSE_MODEL] = String(responseModel);
  if (serverAddress) a[GEN_AI_ATTRS.SERVER_ADDRESS] = String(serverAddress);
  if (Number.isFinite(Number(serverPort))) a[GEN_AI_ATTRS.SERVER_PORT] = Math.trunc(Number(serverPort));
  return a;
}

function listGenAiAttrs() { return Object.assign({}, GEN_AI_ATTRS); }
function listGenAiMetrics() { return Object.assign({}, GEN_AI_METRICS); }
function getGenAiStatus() {
  return {
    ok: true,
    version: OTEL_GENAI_VERSION,
    active: _genAiActive(),
    native_enabled: STATE.enabled,
    tracer_registered: !!_getRegisteredTracer(),
    attrs: Object.keys(GEN_AI_ATTRS).length,
    metrics: Object.values(GEN_AI_METRICS),
  };
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
  // W921 — OTel GenAI semantic conventions (gen_ai.*) surface.
  OTEL_GENAI_VERSION,
  GEN_AI_ATTRS,
  GEN_AI_METRICS,
  GENAI_TOKEN_BUCKETS,
  GENAI_DURATION_BUCKETS,
  GENAI_TTFT_BUCKETS,
  mapProviderToGenAi,
  mapFinishReason,
  extractFinishReasons,
  startGenAiSpan,
  finishGenAiSpan,
  histogram,
  genAiTokenUsage,
  genAiOperationDuration,
  genAiTimeToFirstToken,
  listGenAiAttrs,
  listGenAiMetrics,
  getGenAiStatus,
};
