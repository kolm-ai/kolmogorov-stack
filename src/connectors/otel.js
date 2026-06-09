// S10 onramp connector - OpenTelemetry spans -> AuditEvents.
//
// OpenTelemetry is where most teams already have agent traces, via the GenAI
// semantic conventions (gen_ai.*) for model/tool calls and the HTTP conventions
// (http.* / url.*) for the network calls an agent makes. This connector reads
// both, from either OTLP/JSON (resourceSpans -> scopeSpans -> spans, attributes
// as [{key,value:{stringValue}}]) or a flattened span list ({spans:[{name,
// attributes:{...}}]}).
//
//   - gen_ai.request.model / gen_ai.system:   model + egress host
//   - gen_ai.operation.name / gen_ai.tool.name:  chat vs tool execution
//   - http.request.method / url.full / server.address:  network egress
//   - enduser.id / user.id / service.name:    the agent / identity
//
// normalize(rawExport) returns canonical AuditEvents (src/audit-event.js shape).
// Each event also carries a `request` projection (the originating exchange) so
// kolm's server-side ingest (src/audit-ingest.js coerceExchange) re-derives the
// SAME event with no change to the audit engine; the canonical fields stay
// authoritative for direct analyzer consumption.
//
// Defensive contract: never throws. Unknown / malformed shapes yield [].

import { normalizeEvent } from '../audit-event.js';
import { scanPii } from '../pii-redactor.js';

const SOURCE = 'otel';
const CONTENT_CAP = 16 * 1024;

const PROVIDER_HOSTS = {
  openai: 'api.openai.com',
  azure: 'azure-openai',
  az_openai: 'azure-openai',
  anthropic: 'api.anthropic.com',
  aws_bedrock: 'bedrock.amazonaws.com',
  bedrock: 'bedrock.amazonaws.com',
  vertex_ai: 'aiplatform.googleapis.com',
  gcp_vertex_ai: 'aiplatform.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  cohere: 'api.cohere.com',
  mistral_ai: 'api.mistral.ai',
  groq: 'api.groq.com',
  deepseek: 'api.deepseek.com',
  ollama: 'localhost',
  xai: 'api.x.ai',
};

/* ----------------------------- tiny coercions ----------------------------- */

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : null; }
function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function firstStr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

// Resolve an OTLP attribute value object {stringValue|intValue|...} OR a plain
// scalar (flattened form) to a JS value.
function attrVal(v) {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) { const a = obj(v.arrayValue); return a && arr(a.values) ? a.values.map(attrVal) : []; }
  if ('kvlistValue' in v) { const k = obj(v.kvlistValue); return k ? attrsToMap(k.values) : {}; }
  if (Array.isArray(v)) return v.map(attrVal);
  return v;
}

// Build a flat { key: value } map from either OTLP attribute arrays
// ([{key,value}]) or an already-flat object.
function attrsToMap(attributes) {
  const map = {};
  if (Array.isArray(attributes)) {
    for (const a of attributes) {
      const ao = obj(a); if (!ao || typeof ao.key !== 'string') continue;
      map[ao.key] = attrVal(ao.value);
    }
  } else if (obj(attributes)) {
    for (const [k, val] of Object.entries(attributes)) map[k] = attrVal(val);
  }
  return map;
}

function jsonl(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
  }
  return out;
}

// Flatten any OTel export into a list of { span, attrs } where attrs merges
// resource + scope + span attributes (span wins). Supports OTLP/JSON nesting
// and flat span arrays / wrappers.
function records(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    if (t[0] === '[' || t[0] === '{') { try { root = JSON.parse(t); } catch { root = jsonl(t); } }
    else root = jsonl(t);
  }
  const out = [];
  const pushSpan = (span, baseAttrs) => {
    const so = obj(span); if (!so) return;
    const spanAttrs = attrsToMap(so.attributes);
    const eventAttrs = collectEventAttrs(so);
    out.push({ span: so, attrs: { ...baseAttrs, ...eventAttrs, ...spanAttrs } });
  };
  const fromResourceSpans = (rsList) => {
    for (const rs of rsList || []) {
      const rso = obj(rs); if (!rso) continue;
      const resAttrs = attrsToMap(obj(rso.resource) && rso.resource.attributes);
      const scopeSpans = arr(rso.scopeSpans) || arr(rso.instrumentationLibrarySpans) || [];
      for (const ss of scopeSpans) {
        const sso = obj(ss); if (!sso) continue;
        for (const sp of arr(sso.spans) || []) pushSpan(sp, resAttrs);
      }
    }
  };
  if (Array.isArray(root)) {
    for (const node of root) {
      const no = obj(node);
      if (no && arr(no.resourceSpans)) fromResourceSpans(no.resourceSpans);
      else pushSpan(node, {});
    }
  } else {
    const o = obj(root);
    if (o) {
      if (arr(o.resourceSpans)) fromResourceSpans(o.resourceSpans);
      else if (arr(o.spans)) for (const sp of o.spans) pushSpan(sp, attrsToMap(obj(o.resource) && o.resource.attributes));
      else if (arr(o.data)) for (const d of o.data) { const dd = obj(d); if (dd && arr(dd.resourceSpans)) fromResourceSpans(dd.resourceSpans); else pushSpan(d, {}); }
      else pushSpan(o, {});
    }
  }
  return out;
}

// gen_ai prompt/completion content is increasingly carried as span EVENTS
// (gen_ai.user.message / gen_ai.choice). Fold any body text they carry so PII
// and egress re-derive. Returns a partial attr map.
function collectEventAttrs(span) {
  const events = arr(span.events) || arr(span.logs);
  if (!events) return {};
  const texts = [];
  for (const e of events) {
    const eo = obj(e); if (!eo) continue;
    const ea = attrsToMap(eo.attributes);
    for (const k of Object.keys(ea)) {
      if (/content|message|prompt|completion|body/i.test(k) && ea[k] != null) texts.push(str(ea[k]));
    }
  }
  return texts.length ? { '_kolm.event_body': texts.join('\n') } : {};
}

/* ------------------------------ span helpers ------------------------------ */

function spanTs(span) {
  const nano = span.startTimeUnixNano ?? span.start_time_unix_nano ?? span.startTimenano;
  if (nano != null) {
    const n = typeof nano === 'string' ? Number(nano) : nano;
    if (Number.isFinite(n)) { try { return new Date(n / 1e6).toISOString(); } catch { /* fall through */ } }
  }
  const t = span.start_time ?? span.startTime ?? span.timestamp;
  if (typeof t === 'string' && t.trim() !== '') return t.trim();
  if (typeof t === 'number' && Number.isFinite(t)) { const ms = t > 1e12 ? t : t * 1000; try { return new Date(ms).toISOString(); } catch { /* fall through */ } }
  return null;
}

function asHost(value) {
  const v = firstStr(value);
  if (!v) return null;
  try { return new URL(v).host.toLowerCase() || null; } catch { /* not a full url */ }
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(v);
  if (m) return m[1].toLowerCase();
  const bare = v.replace(/^\/+/, '').split(/[/?#]/)[0];
  return bare && (bare.includes('.') || bare.includes('@')) ? bare.toLowerCase() : null;
}

function urlPath(full) {
  const v = firstStr(full);
  if (!v) return null;
  try { return new URL(v).pathname || null; } catch { /* not a full url */ }
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/i.exec(v);
  return m ? m[1] : (v.startsWith('/') ? v.split(/[?#]/)[0] : null);
}

function providerHost(system, model) {
  const p = firstStr(system);
  if (p && PROVIDER_HOSTS[p.toLowerCase()]) return PROVIDER_HOSTS[p.toLowerCase()];
  const m = firstStr(model);
  if (m && m.includes('/')) { const pre = m.slice(0, m.indexOf('/')).toLowerCase(); return PROVIDER_HOSTS[pre] || pre; }
  return null;
}

function genaiContent(attrs) {
  const parts = [];
  for (const k of ['gen_ai.prompt', 'gen_ai.completion', 'gen_ai.request.messages', 'gen_ai.response.messages', '_kolm.event_body']) {
    if (attrs[k] != null) parts.push(str(attrs[k]));
  }
  return parts.join('\n');
}

/* --------------------------- event construction --------------------------- */

function buildExchange(ev, content) {
  const a = ev.action;
  const ex = { model: ev.meta.model || undefined, user: ev.actor.agent || undefined, metadata: {} };
  if (ev.actor.key_id) ex.metadata.key_id = ev.actor.key_id;
  if (ev.actor.agent) ex.metadata.agent = ev.actor.agent;
  if (Array.isArray(ev.scopes.granted) && ev.scopes.granted.length) {
    ex.tools = ev.scopes.granted.filter((s) => s.startsWith('tool:')).map((s) => ({ type: 'function', function: { name: s.slice(5) } }));
  }
  const text = content == null ? '' : String(content).slice(0, CONTENT_CAP);
  if (a.type === 'tool' && a.tool) {
    const args = {};
    if (a.host) args.url = a.host;
    if (text) args.content = text;
    ex.messages = [{ role: 'assistant', tool_calls: [{ id: ev.id, type: 'function', function: { name: a.tool, arguments: JSON.stringify(args) } }] }];
  } else {
    if (a.host) ex.api_base = /^[a-z][a-z0-9+.-]*:\/\//i.test(a.host) ? a.host : 'https://' + a.host;
    ex.messages = [{ role: 'user', content: text }];
  }
  return ex;
}

function toEvent(fields, content, sensitiveHint) {
  const text = content == null ? '' : String(content).slice(0, CONTENT_CAP);
  let sensitive = !!sensitiveHint;
  if (!sensitive && text) { try { sensitive = scanPii({ text }).classes_hit.length > 0; } catch { sensitive = false; } }
  const ev = normalizeEvent({
    id: fields.id,
    ts: fields.ts,
    namespace: SOURCE,
    actor: { key_id: fields.key_id, agent: fields.agent },
    action: { type: fields.type, tool: fields.tool, server: fields.server, host: fields.host, method: fields.method, endpoint: fields.endpoint },
    scopes: { granted: fields.granted || null, used: fields.used },
    data: { has_sensitive: sensitive, redacted: !!fields.redacted, egress: fields.egress != null ? fields.egress : !!fields.host },
    hash: fields.hash,
    prev_hash: fields.prev_hash,
    meta: { source: SOURCE, model: fields.model || null, kind: fields.kind, span_id: fields.span_id || null, trace_id: fields.trace_id || null },
  });
  ev.request = buildExchange(ev, text);
  return ev;
}

function eventFromSpan(entry) {
  const { span, attrs } = entry;
  const ts = spanTs(span);
  const spanId = firstStr(span.spanId, span.span_id, span.id);
  const traceId = firstStr(span.traceId, span.trace_id);
  const agent = firstStr(attrs['enduser.id'], attrs['user.id'], attrs['gen_ai.agent.name'], attrs['service.name'], attrs['peer.service']);
  const keyId = firstStr(attrs['gen_ai.api_key_id'], attrs['enduser.id'], attrs['api_key.id'], attrs['gen_ai.openai.api_key_id']);
  const redacted = attrs['gen_ai.redacted'] === true || attrs['kolm.redacted'] === true;
  const sensitiveHint = attrs['kolm.sensitive'] === true || attrs['gen_ai.sensitive'] === true;
  const hash = firstStr(attrs['kolm.hash'], attrs['log.record.hash']);
  const prevHash = firstStr(attrs['kolm.prev_hash']);

  const hasGenai = Object.keys(attrs).some((k) => k.startsWith('gen_ai.'));
  const hasHttp = Object.keys(attrs).some((k) => k.startsWith('http.') || k.startsWith('url.') || k === 'server.address' || k === 'net.peer.name');

  if (hasGenai) {
    const model = firstStr(attrs['gen_ai.request.model'], attrs['gen_ai.response.model'], attrs['gen_ai.model']);
    const system = firstStr(attrs['gen_ai.system'], attrs['gen_ai.provider.name']);
    const op = firstStr(attrs['gen_ai.operation.name']);
    const toolName = firstStr(attrs['gen_ai.tool.name'], attrs['gen_ai.tool.call.name']);
    const content = genaiContent(attrs);
    if (toolName || op === 'execute_tool') {
      const host = asHost(attrs['server.address']) || asHost(attrs['url.full']) || asHost(attrs['http.url']);
      return [toEvent({
        id: spanId, ts, key_id: keyId, agent, type: 'tool', tool: (toolName || span.name || 'tool').toLowerCase(),
        host, used: null, granted: null, model, kind: 'tool', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
      }, content || str(attrs['gen_ai.tool.call.arguments']), sensitiveHint)];
    }
    const host = asHost(attrs['server.address']) || providerHost(system, model);
    return [toEvent({
      id: spanId, ts, key_id: keyId, agent, type: 'model', host, method: 'post', endpoint: '/' + (op || 'chat'),
      used: null, granted: null, model, kind: 'llm', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, content, sensitiveHint)];
  }

  if (hasHttp) {
    const method = firstStr(attrs['http.request.method'], attrs['http.method']);
    const full = firstStr(attrs['url.full'], attrs['http.url']);
    const host = asHost(attrs['server.address']) || asHost(attrs['net.peer.name']) || asHost(attrs['http.host']) || asHost(full);
    const endpoint = firstStr(attrs['url.path'], urlPath(full), attrs['http.target'], attrs['http.route']);
    const status = attrs['http.response.status_code'] ?? attrs['http.status_code'];
    return [toEvent({
      id: spanId, ts, key_id: keyId, agent, type: 'api', host, method: method ? method.toLowerCase() : null, endpoint,
      used: null, granted: null, kind: 'http', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, [method, full, status != null ? 'status:' + status : ''].filter(Boolean).join(' '), sensitiveHint)];
  }

  // Not a gen_ai or http span (a pure internal/process span): no direct action.
  return [];
}

/**
 * normalize - OpenTelemetry span export -> canonical AuditEvent[].
 * @param {string|object|object[]} rawExport
 * @returns {object[]} AuditEvents (never throws)
 */
export function normalize(rawExport) {
  try {
    const entries = records(rawExport);
    const events = [];
    for (const entry of entries) {
      try { for (const e of eventFromSpan(entry)) if (e) events.push(e); }
      catch { /* one bad span never sinks the export */ }
    }
    return events;
  } catch {
    return [];
  }
}

export default { normalize, source: SOURCE };
