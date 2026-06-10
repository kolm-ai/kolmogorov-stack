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
import { normalize as openinferenceNormalize } from './openinference.js';
import { normalize as langfuseNormalize } from './langfuse.js';

export const connectors = Object.freeze({
  datadog: { source: 'datadog', normalize: datadogNormalize },
  langsmith: { source: 'langsmith', normalize: langsmithNormalize },
  otel: { source: 'otel', normalize: otelNormalize },
  openinference: { source: 'openinference', normalize: openinferenceNormalize },
  langfuse: { source: 'langfuse', normalize: langfuseNormalize },
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

// Pull spans out of an OTLP wrapper (or a flat span list) so OpenInference's
// dot-namespaced attribute markers are reachable from the same root/recs sniff.
function otelSpanAttrKeys(root, recs) {
  const out = [];
  const fromSpan = (sp) => { const k = attrKeys(obj(sp) || {}); if (k.length) out.push(...k); };
  const fromRs = (rsList) => {
    for (const rs of rsList || []) {
      const rso = obj(rs); if (!rso) continue;
      const scopeSpans = arr(rso.scopeSpans) || arr(rso.instrumentationLibrarySpans) || [];
      for (const ss of scopeSpans) { const sso = obj(ss); if (sso) for (const sp of arr(sso.spans) || []) fromSpan(sp); }
    }
  };
  if (root && arr(root.resourceSpans)) fromRs(root.resourceSpans);
  if (root && arr(root.spans)) for (const sp of root.spans) fromSpan(sp);
  for (const r of recs) {
    if (arr(r.resourceSpans)) fromRs(r.resourceSpans);
    if (arr(r.spans)) for (const sp of r.spans) fromSpan(sp);
    fromSpan(r);
  }
  return out;
}

// OpenInference rides OTLP, but its spans carry the OpenInference semantic
// convention markers (openinference.span.kind, llm.model_name, tool.parameters,
// retrieval.documents) instead of gen_ai.*. Checked BEFORE looksOtel.
function looksOpenInference(root, recs) {
  const keys = otelSpanAttrKeys(root, recs);
  if (!keys.length) return false;
  return keys.some((k) =>
    k === 'openinference.span.kind' || k === 'openinference.kind' ||
    k.startsWith('openinference.') ||
    k === 'llm.model_name' || k.startsWith('llm.input_messages') || k.startsWith('llm.output_messages') ||
    k.startsWith('llm.token_count') || k === 'tool.parameters' || k.startsWith('retrieval.documents'));
}

// A Langfuse trace carries observations[] of type GENERATION/SPAN/EVENT (or the
// list-page shape under data[]). Checked BEFORE looksLangsmith because a bare
// generation looks like a loose run otherwise.
function looksLangfuse(root, recs) {
  const obsLooksLangfuse = (list) => {
    if (!arr(list)) return false;
    for (const o of list) {
      const oo = obj(o); if (!oo) continue;
      const t = typeof oo.type === 'string' ? oo.type.toUpperCase() : '';
      if (['GENERATION', 'SPAN', 'EVENT'].includes(t)) return true;
    }
    return false;
  };
  if (root && obsLooksLangfuse(root.observations)) return true;
  if (root && obj(root.trace) && (obsLooksLangfuse(root.observations) || obsLooksLangfuse(root.data))) return true;
  for (const r of recs) {
    if (obsLooksLangfuse(r.observations)) return true;
    if (obj(r.trace) && (obsLooksLangfuse(r.observations) || obsLooksLangfuse(r.data))) return true;
    // A bare observation record: a Langfuse GENERATION/SPAN/EVENT with the
    // Langfuse-distinctive fields (not a LangSmith run_type).
    const t = typeof r.type === 'string' ? r.type.toUpperCase() : '';
    if (['GENERATION', 'SPAN', 'EVENT'].includes(t) && r.run_type == null &&
        (r.observationId != null || r.traceId != null || r.modelParameters != null || r.startTime != null || r.usage != null)) {
      return true;
    }
  }
  return false;
}

/**
 * detectConnector - sniff which connector a raw export belongs to.
 * Order matters, most-specific markers first: OpenInference rides OTLP so its
 * openinference.span.kind / llm.* / tool.* markers are checked BEFORE the
 * generic OTLP sniff; Langfuse's observations[] (GENERATION/SPAN/EVENT) is
 * checked BEFORE LangSmith's looser run_type. Returns the source string or null
 * when nothing matches. Never throws.
 * @param {string|object|object[]} raw
 * @returns {'datadog'|'langsmith'|'otel'|'openinference'|'langfuse'|null}
 */
export function detectConnector(raw) {
  try {
    const { root, recs } = sample(raw);
    if (looksOpenInference(root, recs)) return 'openinference';
    if (looksOtel(root, recs)) return 'otel';
    if (looksLangfuse(root, recs)) return 'langfuse';
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
