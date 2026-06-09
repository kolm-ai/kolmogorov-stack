// S10 onramp connectors - the registry.
//
// One place to turn "wherever the seller already runs their agents" into the
// canonical AuditEvents kolm audits. Each connector (datadog / langsmith / otel)
// exports normalize(rawExport) -> AuditEvent[] (src/audit-event.js shape); the
// events are self-ingesting (they carry a `request` projection) so the SAME
// events drive both the analyzers directly AND kolm's server-side ingest at
// POST /v1/audit/scan, with no change to the audit engine.
//
//   normalizeWith(source, raw) - normalize with a named connector.
//   detectConnector(raw)       - sniff which platform a raw export came from.
//   normalizeAuto(raw)         - detect then normalize; { source, events }.
//
// Everything here is defensive: unknown source / shape -> [] (never throws).

import { normalize as datadogNormalize } from './datadog.js';
import { normalize as langsmithNormalize } from './langsmith.js';
import { normalize as otelNormalize } from './otel.js';

export const connectors = Object.freeze({
  datadog: { source: 'datadog', normalize: datadogNormalize },
  langsmith: { source: 'langsmith', normalize: langsmithNormalize },
  otel: { source: 'otel', normalize: otelNormalize },
});

export const SOURCES = Object.freeze(Object.keys(connectors));

const DATADOG_KINDS = new Set(['llm', 'tool', 'agent', 'workflow', 'task', 'embedding', 'retrieval']);

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : null; }

// A best-effort sniff parse: turn raw into a small list of candidate record
// objects WITHOUT fully flattening (enough to recognize the platform). Mirrors
// the wrapper shapes each connector accepts. Never throws.
function sample(raw, limit = 8) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return { root: null, recs: [] };
    if (t[0] === '[' || t[0] === '{') {
      try { root = JSON.parse(t); } catch { root = firstJsonl(t, limit); }
    } else {
      root = firstJsonl(t, limit);
    }
  }
  const recs = [];
  const push = (x) => { const o = obj(x); if (o && recs.length < limit) recs.push(o); };
  if (Array.isArray(root)) { for (const r of root) { push(r); if (recs.length >= limit) break; } }
  else {
    const o = obj(root);
    if (o) {
      let pulled = false;
      for (const k of ['runs', 'spans', 'data', 'results', 'events', 'rows']) {
        if (arr(o[k])) { for (const r of o[k]) { push(r); if (recs.length >= limit) break; } pulled = true; break; }
      }
      if (!pulled) push(o);
    }
  }
  return { root: obj(root) || (Array.isArray(root) ? { __array: root } : null), recs };
}

function firstJsonl(text, limit) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
    if (out.length >= limit) break;
  }
  return out;
}

function attrKeys(rec) {
  // gather attribute keys from OTLP array or flat object form.
  const a = rec.attributes;
  if (Array.isArray(a)) return a.map((x) => (obj(x) && typeof x.key === 'string' ? x.key : '')).filter(Boolean);
  if (obj(a)) return Object.keys(a);
  return [];
}

function looksDatadog(recs) {
  for (const r of recs) {
    const meta = obj(r.meta);
    if (meta && typeof meta.kind === 'string' && DATADOG_KINDS.has(meta.kind.toLowerCase())) return true;
    if (r.ml_app != null) return true;
    if (r.start_ns != null && (meta || obj(r.metrics))) return true;
    if (obj(r.attributes) && r.attributes.spans && Array.isArray(r.attributes.spans)) return true;
  }
  return false;
}

function looksLangsmith(recs) {
  for (const r of recs) {
    if (typeof r.run_type === 'string') return true;
    if (Array.isArray(r.child_runs)) return true;
    if (r.dotted_order != null && (r.inputs != null || r.outputs != null)) return true;
    const extra = obj(r.extra);
    if (extra && obj(extra.metadata) && (extra.metadata.ls_model_name != null || extra.metadata.ls_provider != null)) return true;
  }
  return false;
}

function looksOtel(root, recs) {
  if (root && Array.isArray(root.resourceSpans)) return true;
  for (const r of recs) {
    if (Array.isArray(r.resourceSpans) || Array.isArray(r.scopeSpans)) return true;
    if (r.startTimeUnixNano != null) return true;
    const keys = attrKeys(r);
    if (keys.some((k) => k.startsWith('gen_ai.') || k.startsWith('http.') || k.startsWith('url.') || k === 'server.address')) return true;
    if ((r.spanId != null || r.span_id != null) && (r.traceId != null || r.trace_id != null) && r.attributes != null) return true;
  }
  return false;
}

/**
 * detectConnector - sniff which connector a raw export belongs to.
 * Order matters: OTLP and Datadog carry the most specific markers, LangSmith's
 * run_type is checked before the looser fallbacks. Returns the source string or
 * null when nothing matches. Never throws.
 * @param {string|object|object[]} raw
 * @returns {'datadog'|'langsmith'|'otel'|null}
 */
export function detectConnector(raw) {
  try {
    const { root, recs } = sample(raw);
    if (looksOtel(root, recs)) return 'otel';
    if (looksLangsmith(recs)) return 'langsmith';
    if (looksDatadog(recs)) return 'datadog';
    return null;
  } catch {
    return null;
  }
}

/**
 * normalizeWith - normalize a raw export with a named connector.
 * @param {string} source  one of SOURCES
 * @param {string|object|object[]} raw
 * @returns {object[]} AuditEvents (empty for an unknown source; never throws)
 */
export function normalizeWith(source, raw) {
  const c = connectors[String(source || '').toLowerCase()];
  if (!c) return [];
  try { const events = c.normalize(raw); return Array.isArray(events) ? events : []; }
  catch { return []; }
}

/**
 * normalizeAuto - detect the connector then normalize. Returns the detected
 * source (or null) and the AuditEvents. Never throws.
 * @param {string|object|object[]} raw
 * @returns {{ source: string|null, events: object[] }}
 */
export function normalizeAuto(raw) {
  const source = detectConnector(raw);
  if (!source) return { source: null, events: [] };
  return { source, events: normalizeWith(source, raw) };
}

export default { connectors, SOURCES, detectConnector, normalizeWith, normalizeAuto };
