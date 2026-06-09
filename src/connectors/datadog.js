// S10 onramp connector - Datadog LLM Observability spans -> AuditEvents.
//
// Datadog LLM Observability emits one span per agent step. The export (the
// LLM Observability spans API, the trace JSON, or a Datadog Events wrapper)
// carries the dimensions an agent security audit needs:
//
//   - kind:        llm | tool | agent | workflow | task | embedding | retrieval
//   - meta.input / meta.output:  messages or a value blob (tool args, model io)
//   - meta.metadata.model_name / model_provider:  which model, which host
//   - service / ml_app / tags:   the agent + (occasionally) the credential id
//   - tool_calls inside an llm span's output:  the tools the agent invoked
//
// normalize(rawExport) returns canonical AuditEvents (src/audit-event.js shape).
// Each event is ALSO self-ingesting: it carries a `request` projection (the
// originating exchange) so kolm's server-side ingest (src/audit-ingest.js
// coerceExchange) re-derives the SAME event with no change to the audit engine.
// The canonical fields stay authoritative for direct analyzer consumption.
//
// Defensive contract: never throws. Unknown / malformed shapes yield [].

import { normalizeEvent } from '../audit-event.js';
import { scanPii } from '../pii-redactor.js';

const SOURCE = 'datadog';
// Cap the content we carry into the re-ingest projection so a giant span body
// cannot bloat the event. Far above any tool-argument / message that matters.
const CONTENT_CAP = 16 * 1024;

// Datadog model_provider -> the host the inference call actually reached. Used
// to attribute model egress when no explicit endpoint is logged.
const PROVIDER_HOSTS = {
  openai: 'api.openai.com',
  azure: 'azure-openai',
  azure_openai: 'azure-openai',
  anthropic: 'api.anthropic.com',
  bedrock: 'bedrock.amazonaws.com',
  amazon_bedrock: 'bedrock.amazonaws.com',
  vertex: 'aiplatform.googleapis.com',
  vertexai: 'aiplatform.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  cohere: 'api.cohere.com',
  mistral: 'api.mistral.ai',
  groq: 'api.groq.com',
  deepseek: 'api.deepseek.com',
  together: 'api.together.xyz',
  fireworks: 'api.fireworks.ai',
  ollama: 'localhost',
  xai: 'api.x.ai',
};

// Field names that commonly carry a destination URL/host inside a tool's input.
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

// Parse a Datadog export into a flat list of span objects. Accepts a JSON
// string, a JSONL string, an array, or any of Datadog's wrapper shapes:
//   { data: [span|{attributes:span}|{attributes:{spans:[...]}}] }
//   { spans: [...] }  |  bare array  |  one span object
function records(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    if (t[0] === '[' || t[0] === '{') {
      try { root = JSON.parse(t); } catch { root = jsonl(t); }
    } else {
      root = jsonl(t);
    }
  }
  const out = [];
  const pushSpan = (s) => { const o = obj(s); if (o) out.push(o); };
  const walk = (node, depth) => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    const o = obj(node);
    if (!o) return;
    // A Datadog Events row wraps the span under `attributes`.
    if (o.attributes && obj(o.attributes)) {
      const a = o.attributes;
      if (arr(a.spans)) { for (const s of a.spans) pushSpan(s); return; }
      pushSpan(a); return;
    }
    if (arr(o.spans)) { for (const s of o.spans) pushSpan(s); return; }
    if (arr(o.data)) { for (const d of o.data) walk(d, depth + 1); return; }
    pushSpan(o);
  };
  walk(root, 0);
  return out;
}

function jsonl(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try { out.push(JSON.parse(s)); } catch { /* skip bad line */ }
  }
  return out;
}

/* ------------------------------ span helpers ------------------------------ */

// tags arrive as ["k:v", ...] or { k: v }. Resolve a tag value by key.
function tagValue(span, key) {
  const tags = span.tags;
  if (Array.isArray(tags)) {
    const pre = key + ':';
    for (const t of tags) {
      if (typeof t === 'string' && t.startsWith(pre)) return t.slice(pre.length);
    }
  } else if (obj(tags) && tags[key] != null) {
    return String(tags[key]);
  }
  return null;
}

function spanTs(span) {
  // Datadog logs start_ns (nanoseconds). Also tolerate ms/seconds + ISO strings.
  const ns = span.start_ns ?? span.startNs ?? span.start;
  if (typeof ns === 'number' && Number.isFinite(ns)) {
    const ms = ns > 1e15 ? ns / 1e6 : ns > 1e12 ? ns : ns * 1000;
    try { return new Date(ms).toISOString(); } catch { /* fall through */ }
  }
  return firstStr(span.timestamp, span.start_time, span['@timestamp']);
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

function asHost(value) {
  const v = firstStr(value);
  if (!v) return null;
  try { return new URL(v).host.toLowerCase() || null; } catch { /* not a full url */ }
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(v);
  if (m) return m[1].toLowerCase();
  const bare = v.replace(/^\/+/, '').split(/[/?#]/)[0];
  return bare && (bare.includes('.') || bare.includes('@')) ? bare.toLowerCase() : null;
}

// Find a destination host buried in a tool's input (object or stringified JSON).
function egressFromInput(input) {
  let o = obj(input);
  if (!o && typeof input === 'string') { try { o = obj(JSON.parse(input)); } catch { /* not json */ } }
  if (o) {
    const src = obj(o.value) || o;
    for (const k of URL_KEYS) if (src[k] != null) { const h = asHost(src[k]); if (h) return h; }
  }
  return asHost(typeof input === 'string' ? input : (o && o.value));
}

// Flatten a Datadog input/output side (messages[] or value) to scannable text.
function sideText(side) {
  const o = obj(side);
  if (!o) return typeof side === 'string' ? side : '';
  if (arr(o.messages)) {
    return o.messages.map((m) => {
      const mo = obj(m); if (!mo) return typeof m === 'string' ? m : '';
      const c = mo.content;
      return typeof c === 'string' ? c : str(c);
    }).filter(Boolean).join('\n');
  }
  if (typeof o.value === 'string') return o.value;
  return str(o);
}

// tool_calls declared inside an llm span's output messages -> [{name, args}].
function toolCallsFromOutput(output) {
  const o = obj(output);
  const calls = [];
  const msgs = o && arr(o.messages);
  if (!msgs) return calls;
  for (const m of msgs) {
    const mo = obj(m); if (!mo) continue;
    const tcs = arr(mo.tool_calls);
    if (!tcs) continue;
    for (const tc of tcs) {
      const tco = obj(tc); if (!tco) continue;
      const fn = obj(tco.function) || tco;
      const name = firstStr(fn.name);
      if (name) calls.push({ name, args: fn.arguments != null ? fn.arguments : fn.args, id: firstStr(tco.id) });
    }
  }
  return calls;
}

// The tools the agent was permitted to call, if the instrumentation logged
// them (some Datadog SDKs put a tool schema list on the llm span input).
function grantedTools(span, metaInput) {
  const lists = [arr(metaInput && metaInput.tools), arr(span.tools), arr(metaInput && metaInput.functions)];
  for (const list of lists) {
    if (!list) continue;
    const out = [];
    for (const t of list) {
      const to = obj(t); if (!to) continue;
      const name = firstStr((obj(to.function) || to).name);
      if (name) out.push('tool:' + name.toLowerCase());
    }
    if (out.length) return Array.from(new Set(out));
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
    if (a.host) args.url = a.host;            // egress destination, re-derived by coerceExchange
    if (text) args.content = text;            // carry the body so PII re-detects server-side
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

function eventsFromSpan(span) {
  const kindRaw = firstStr(obj(span.meta) && span.meta.kind, span.kind, span.span_kind);
  const kind = kindRaw ? kindRaw.toLowerCase() : (obj(span.meta) && obj(span.meta).metadata ? 'llm' : 'unknown');
  const meta = obj(span.meta) || {};
  const metadata = obj(meta.metadata) || {};
  const model = firstStr(metadata.model_name, metadata.model, span.model);
  const provider = firstStr(metadata.model_provider, metadata.provider);
  const ts = spanTs(span);
  const traceId = firstStr(span.trace_id, span.traceId);
  const spanId = firstStr(span.span_id, span.spanId);
  const agent = firstStr(span.ml_app, tagValue(span, 'agent'), tagValue(span, 'ml_app'), span.service, tagValue(span, 'service'), metadata.agent);
  const keyId = firstStr(tagValue(span, 'api_key_id'), tagValue(span, 'key_id'), metadata.api_key_id, metadata.key_id);
  const redacted = /redact/i.test(str(span.tags)) || metadata.redacted === true;
  const sensitiveHint = /pii|phi|sensitive/i.test(str(span.tags)) || metadata.has_sensitive === true || metadata.sensitive === true;
  const hash = firstStr(span.hash, metadata.hash);
  const prevHash = firstStr(span.prev_hash, metadata.prev_hash);
  const baseId = spanId || (traceId ? traceId + ':' + (span.name || kind) : null);

  const out = [];

  if (kind === 'tool') {
    const input = meta.input;
    const host = egressFromInput(input) || asHost(metadata.host) || asHost(tagValue(span, 'host'));
    out.push(toEvent({
      id: baseId, ts, key_id: keyId, agent, type: 'tool', tool: (span.name || 'tool').toLowerCase(),
      host, used: null, granted: grantedTools(span, obj(meta.input)),
      model, kind, span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, sideText(input), sensitiveHint));
    return out;
  }

  if (kind === 'retrieval' || kind === 'embedding') {
    const host = kind === 'embedding' ? modelHost(provider, model) : (asHost(metadata.host) || null);
    out.push(toEvent({
      id: baseId, ts, key_id: keyId, agent, type: kind === 'embedding' ? 'model' : 'tool',
      tool: kind === 'retrieval' ? (span.name || 'retrieval').toLowerCase() : null,
      host, used: null, model, kind, span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash,
      egress: !!host,
    }, sideText(meta.input) + '\n' + sideText(meta.output), sensitiveHint));
    return out;
  }

  if (kind === 'llm') {
    const host = modelHost(provider, model);
    const granted = grantedTools(span, obj(meta.input));
    const io = sideText(meta.input) + '\n' + sideText(meta.output);
    out.push(toEvent({
      id: baseId, ts, key_id: keyId, agent, type: 'model', host, method: 'post', endpoint: '/chat/completions',
      used: null, granted, model, kind, span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, io, sensitiveHint));
    // Any tools the model called in its output become their own tool events.
    let n = 0;
    for (const call of toolCallsFromOutput(meta.output)) {
      const argText = str(call.args);
      const callHost = egressFromInput(call.args);
      out.push(toEvent({
        id: baseId ? baseId + ':tc' + n : null, ts, key_id: keyId, agent, type: 'tool',
        tool: call.name.toLowerCase(), host: callHost, used: null, granted,
        model, kind: 'tool', span_id: spanId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!callHost,
      }, argText, sensitiveHint));
      n++;
    }
    return out;
  }

  // agent / workflow / task / unknown: structural spans with no direct egress.
  // We skip them as actions (they carry no tool/model/host) so the audit is not
  // padded with phantom events; their identity is already attributed to the
  // child llm/tool spans above.
  return out;
}

/**
 * normalize - Datadog LLM Observability export -> canonical AuditEvent[].
 * @param {string|object|object[]} rawExport
 * @returns {object[]} AuditEvents (never throws)
 */
export function normalize(rawExport) {
  try {
    const spans = records(rawExport);
    const events = [];
    for (const span of spans) {
      try { for (const e of eventsFromSpan(span)) if (e) events.push(e); }
      catch { /* one bad span never sinks the export */ }
    }
    return events;
  } catch {
    return [];
  }
}

export default { normalize, source: SOURCE };
