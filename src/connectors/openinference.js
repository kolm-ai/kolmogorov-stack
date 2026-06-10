// S10 onramp connector - OpenInference spans -> AuditEvents.
//
// OpenInference (the Arize Phoenix / OpenLLMetry tracing convention) instruments
// agent traces as OTLP spans whose attributes are dot-namespaced under the
// OpenInference schema rather than gen_ai.*:
//
//   - openinference.span.kind:   LLM | RETRIEVER | TOOL | AGENT | CHAIN | EMBEDDING
//   - llm.model_name:            the model invoked
//   - llm.provider / llm.system: the provider (host attribution)
//   - llm.token_count.*:         prompt / completion token counts
//   - llm.input_messages / llm.output_messages: the exchange (flat-indexed
//       attributes llm.input_messages.0.message.content, or a JSON blob)
//   - tool.name / tool.parameters: the tool the agent called
//   - retrieval.documents:       the docs a RETRIEVER span returned
//
// Spans arrive as OTLP/JSON (resourceSpans -> scopeSpans -> spans, attributes as
// [{key,value:{stringValue}}]) or as a flattened span list ({spans:[{name,
// attributes:{...}}]}). One AuditEvent is emitted per LLM / TOOL / RETRIEVER
// span (request/response/tool/retrieval kinds); AGENT / CHAIN spans are
// structural and carry no direct action.
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

const SOURCE = 'openinference';
const CONTENT_CAP = 16 * 1024;

// OpenInference provider tokens -> the host the inference call actually reached.
const PROVIDER_HOSTS = {
  openai: 'api.openai.com',
  azure: 'azure-openai',
  azure_openai: 'azure-openai',
  anthropic: 'api.anthropic.com',
  bedrock: 'bedrock.amazonaws.com',
  aws: 'bedrock.amazonaws.com',
  aws_bedrock: 'bedrock.amazonaws.com',
  vertexai: 'aiplatform.googleapis.com',
  vertex: 'aiplatform.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  cohere: 'api.cohere.com',
  mistralai: 'api.mistral.ai',
  mistral: 'api.mistral.ai',
  groq: 'api.groq.com',
  deepseek: 'api.deepseek.com',
  together: 'api.together.xyz',
  fireworks: 'api.fireworks.ai',
  ollama: 'localhost',
  xai: 'api.x.ai',
};

// Field names that commonly carry a destination URL/host inside a tool's params.
const URL_KEYS = ['url', 'endpoint', 'uri', 'host', 'hostname', 'base_url', 'api_base', 'to', 'recipient', 'address', 'webhook'];

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

// Flatten any OpenInference/OTel export into a list of { span, attrs } where
// attrs merges resource + scope + span attributes (span wins). Supports OTLP
// nesting and flat span arrays / wrappers.
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
    out.push({ span: so, attrs: { ...baseAttrs, ...spanAttrs } });
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

function modelHost(provider, model) {
  const p = firstStr(provider);
  if (p && PROVIDER_HOSTS[p.toLowerCase()]) return PROVIDER_HOSTS[p.toLowerCase()];
  const m = firstStr(model);
  if (m && m.includes('/')) {
    const pre = m.slice(0, m.indexOf('/')).toLowerCase();
    return PROVIDER_HOSTS[pre] || pre;
  }
  return null;
}

// Find a destination host buried in a tool's parameters (object or stringified).
function egressFrom(input) {
  let o = obj(input);
  if (!o && typeof input === 'string') { try { o = obj(JSON.parse(input)); } catch { /* not json */ } }
  if (o) {
    const src = obj(o.value) || o;
    for (const k of URL_KEYS) if (src[k] != null) { const h = asHost(src[k]); if (h) return h; }
  }
  return asHost(typeof input === 'string' ? input : (o && o.value));
}

// OpenInference carries messages either as a JSON blob (llm.input_messages =
// '[{...}]') or flat-indexed attributes (llm.input_messages.0.message.content).
// Gather scannable text from both forms under the given prefix.
function messagesText(attrs, prefix) {
  const parts = [];
  const blob = attrs[prefix];
  if (blob != null) parts.push(str(blob));
  for (const k of Object.keys(attrs)) {
    if (k === prefix) continue;
    if (k.startsWith(prefix + '.') && /\.(content|message_content|message\.content)$/.test(k) && attrs[k] != null) {
      parts.push(str(attrs[k]));
    }
  }
  return parts;
}

function llmContent(attrs) {
  const parts = [];
  parts.push(...messagesText(attrs, 'llm.input_messages'));
  parts.push(...messagesText(attrs, 'llm.output_messages'));
  for (const k of ['input.value', 'output.value', 'llm.prompts', 'llm.prompt_template.template']) {
    if (attrs[k] != null) parts.push(str(attrs[k]));
  }
  return parts.filter(Boolean).join('\n');
}

// Documents a RETRIEVER span returned, as scannable text.
function retrievalContent(attrs) {
  const parts = [];
  if (attrs['retrieval.documents'] != null) parts.push(str(attrs['retrieval.documents']));
  for (const k of Object.keys(attrs)) {
    if (k.startsWith('retrieval.documents.') && /(content|text)$/.test(k) && attrs[k] != null) parts.push(str(attrs[k]));
  }
  if (attrs['input.value'] != null) parts.push(str(attrs['input.value']));
  return parts.filter(Boolean).join('\n');
}

// The tool params a TOOL span carried, as scannable text + egress source.
function toolInput(attrs) {
  for (const k of ['tool.parameters', 'tool.arguments', 'tool.json_schema', 'input.value', 'tool_call.function.arguments']) {
    if (attrs[k] != null) return attrs[k];
  }
  return null;
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
  const kindRaw = firstStr(attrs['openinference.span.kind'], attrs['openinference.kind'], span.kind);
  const kind = kindRaw ? kindRaw.toUpperCase() : '';
  const ts = spanTs(span);
  const spanId = firstStr(span.spanId, span.span_id, span.id);
  const traceId = firstStr(span.traceId, span.trace_id);
  const agent = firstStr(
    attrs['session.user'], attrs['user.id'], attrs['enduser.id'], attrs['metadata.agent'],
    attrs['agent.name'], attrs['service.name'], attrs['peer.service'],
  );
  const keyId = firstStr(attrs['llm.api_key_id'], attrs['api_key.id'], attrs['enduser.id'], attrs['session.id']);
  const redacted = attrs['kolm.redacted'] === true || attrs['openinference.redacted'] === true;
  const sensitiveHint = attrs['kolm.sensitive'] === true || attrs['openinference.sensitive'] === true;
  const hash = firstStr(attrs['kolm.hash'], attrs['log.record.hash']);
  const prevHash = firstStr(attrs['kolm.prev_hash']);

  if (kind === 'TOOL') {
    const input = toolInput(attrs);
    const host = egressFrom(input) || asHost(attrs['server.address']) || asHost(attrs['url.full']);
    const toolName = firstStr(attrs['tool.name'], attrs['tool_call.function.name'], span.name, 'tool');
    return [toEvent({
      id: spanId, ts, key_id: keyId, agent, type: 'tool', tool: toolName.toLowerCase(),
      host, used: null, granted: null, kind: 'tool', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, str(input), sensitiveHint)];
  }

  if (kind === 'RETRIEVER') {
    const toolName = firstStr(attrs['tool.name'], span.name, 'retrieval');
    return [toEvent({
      id: spanId, ts, key_id: keyId, agent, type: 'tool', tool: toolName.toLowerCase(),
      host: null, used: null, granted: null, kind: 'retrieval', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: false,
    }, retrievalContent(attrs), sensitiveHint)];
  }

  if (kind === 'LLM') {
    const model = firstStr(attrs['llm.model_name'], attrs['llm.model'], attrs['gen_ai.request.model']);
    const provider = firstStr(attrs['llm.provider'], attrs['llm.system'], attrs['gen_ai.system']);
    const host = asHost(attrs['server.address']) || asHost(attrs['url.full']) || modelHost(provider, model);
    return [toEvent({
      id: spanId, ts, key_id: keyId, agent, type: 'model', host, method: 'post', endpoint: '/chat/completions',
      used: null, granted: null, model, kind: 'llm', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, llmContent(attrs), sensitiveHint)];
  }

  // AGENT / CHAIN / EMBEDDING / unknown: structural spans with no direct action.
  return [];
}

/**
 * normalize - OpenInference span export -> canonical AuditEvent[].
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
