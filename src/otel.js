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
 *   const otel = require('./src/otel');
 *   otel.init();                          // call once at server start
 *   const span = otel.startSpan('kolm.run', { 'kolm.artifact_id': 'art_x' });
 *   try { ... } finally { otel.endSpan(span, { status: 'ok' }); }
 *   otel.metric('kolm.k_score', 0.94, { artifact: 'art_x' });
 *   otel.shutdown();                      // flush before exit
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

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

module.exports = {
  init,
  startSpan,
  endSpan,
  metric,
  counter,
  flush,
  shutdown,
  isEnabled,
  expressMiddleware,
};
