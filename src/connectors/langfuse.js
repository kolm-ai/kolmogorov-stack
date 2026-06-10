// S10 onramp connector - Langfuse traces -> AuditEvents.
//
// A Langfuse trace is a top-level Trace object with a flat list of Observations.
// Each observation carries the dimensions an agent security audit needs:
//
//   - type:        GENERATION | SPAN | EVENT
//   - model:       the model a GENERATION invoked
//   - input / output:  messages, tool arguments, generations (with tool_calls)
//   - usage:       prompt / completion / total token counts
//   - name + metadata:  a SPAN/EVENT named like a tool ("send_email") or a
//                       retrieval is the tool / retrieval action
//   - trace.user_id / session_id / tags:  the agent / identity, propagated onto
//                                          every event's meta
//
// The export accepts a single trace, an array of traces, a { data: [...] } page
// (the Langfuse public API list shape), or a trace whose observations are nested
// under observations[] / data[]. One AuditEvent is emitted per GENERATION
// (request/response) and per tool-shaped SPAN/EVENT; structural spans carry no
// direct action.
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

const SOURCE = 'langfuse';
const CONTENT_CAP = 16 * 1024;

// Langfuse model/provider tokens -> the host the inference call reached.
const PROVIDER_HOSTS = {
  openai: 'api.openai.com',
  azure: 'azure-openai',
  azure_openai: 'azure-openai',
  anthropic: 'api.anthropic.com',
  bedrock: 'bedrock.amazonaws.com',
  aws_bedrock: 'bedrock.amazonaws.com',
  vertexai: 'aiplatform.googleapis.com',
  vertex: 'aiplatform.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  google_vertex: 'aiplatform.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  cohere: 'api.cohere.com',
  mistral: 'api.mistral.ai',
  mistralai: 'api.mistral.ai',
  groq: 'api.groq.com',
  deepseek: 'api.deepseek.com',
  together: 'api.together.xyz',
  fireworks: 'api.fireworks.ai',
  ollama: 'localhost',
  xai: 'api.x.ai',
};

// Field names that commonly carry a destination URL/host inside a tool's input.
const URL_KEYS = ['url', 'endpoint', 'uri', 'host', 'hostname', 'base_url', 'api_base', 'to', 'recipient', 'address', 'webhook'];

// Observation names / metadata markers that denote a tool or retrieval action.
const RETRIEVAL_RE = /retriev|vector|embed|search|knowledge|rag/i;
const TOOL_RE = /tool|function|action|call|api|http|fetch|send|email|charge|webhook|exec/i;

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

function jsonl(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
  }
  return out;
}

// Parse an export into a flat list of { trace, obs } pairs - one per observation
// - so each observation keeps a reference back to its parent trace (for the
// trace-level user_id / session_id / tags propagated onto event meta). Accepts a
// single trace, an array, a { data:[...] } page, or a trace with observations[].
function records(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    if (t[0] === '[' || t[0] === '{') { try { root = JSON.parse(t); } catch { root = jsonl(t); } }
    else root = jsonl(t);
  }
  let traces = [];
  if (Array.isArray(root)) traces = root;
  else {
    const o = obj(root);
    if (o) {
      if (arr(o.data)) traces = o.data;
      else if (arr(o.traces)) traces = o.traces;
      else if (obj(o.trace) && (arr(o.observations) || arr(o.data))) traces = [o];
      else traces = [o];
    }
  }
  const out = [];
  for (const t of traces) {
    const to = obj(t); if (!to) continue;
    // A trace may carry its own fields, OR wrap a `trace` object alongside a
    // sibling observations[] list (the Langfuse fetch-trace response shape).
    const traceObj = obj(to.trace) || to;
    const observations = arr(to.observations) || arr(traceObj.observations) || arr(to.data);
    if (observations) {
      for (const o of observations) { const oo = obj(o); if (oo) out.push({ trace: traceObj, obs: oo }); }
    } else {
      // A bare observation passed without a wrapping trace.
      out.push({ trace: traceObj, obs: traceObj });
    }
  }
  return out;
}

/* --------------------------- trace / obs helpers --------------------------- */

function obsTs(obs) {
  const t = obs.startTime ?? obs.start_time ?? obs.timestamp ?? obs.start;
  if (typeof t === 'string' && t.trim() !== '') return t.trim();
  if (typeof t === 'number' && Number.isFinite(t)) {
    const ms = t > 1e12 ? t : t * 1000;
    try { return new Date(ms).toISOString(); } catch { /* fall through */ }
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

// Find a destination host buried in a tool's input (object or stringified JSON).
function egressFrom(input) {
  let o = obj(input);
  if (!o && typeof input === 'string') { try { o = obj(JSON.parse(input)); } catch { /* not json */ } }
  if (o) {
    const src = obj(o.value) || o;
    for (const k of URL_KEYS) if (src[k] != null) { const h = asHost(src[k]); if (h) return h; }
  }
  return asHost(typeof input === 'string' ? input : (o && o.value));
}

// Flatten an input/output side (a string, a messages[] list, or a value blob)
// to scannable text.
function sideText(side) {
  const o = obj(side);
  if (!o) return typeof side === 'string' ? side : (side == null ? '' : str(side));
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

// tool_calls declared inside a GENERATION's output -> [{name, args, id}].
function toolCallsFromOutput(output) {
  const o = obj(output);
  const calls = [];
  // output may be a message, a {messages:[...]} list, or a {tool_calls:[...]}.
  const pools = [];
  if (o) {
    if (arr(o.tool_calls)) pools.push(o.tool_calls);
    if (arr(o.messages)) for (const m of o.messages) { const mo = obj(m); if (mo && arr(mo.tool_calls)) pools.push(mo.tool_calls); }
    const ak = obj(o.additional_kwargs);
    if (ak && arr(ak.tool_calls)) pools.push(ak.tool_calls);
  }
  for (const list of pools) {
    for (const tc of list) {
      const tco = obj(tc); if (!tco) continue;
      const fn = obj(tco.function) || tco;
      const name = firstStr(fn.name, tco.name);
      if (name) calls.push({ name, args: fn.arguments != null ? fn.arguments : (fn.args != null ? fn.args : tco.args), id: firstStr(tco.id) });
    }
  }
  return calls;
}

// The tools a GENERATION was permitted to call, if the SDK logged them.
function grantedTools(obs) {
  const md = obj(obs.metadata) || {};
  const lists = [arr(md.tools), arr(md.functions), arr(obj(obs.modelParameters) && obs.modelParameters.tools)];
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

// Pull trace-level identity + tags, propagated onto every event's meta.
function traceContext(trace) {
  const t = obj(trace) || {};
  const userId = firstStr(t.userId, t.user_id);
  const sessionId = firstStr(t.sessionId, t.session_id);
  const tags = arr(t.tags) ? t.tags.map((x) => str(x)).filter(Boolean) : null;
  const tagStr = tags ? tags.join(',') : '';
  return { userId, sessionId, tags, tagStr, traceName: firstStr(t.name), traceId: firstStr(t.id, t.traceId, t.trace_id) };
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
  const meta = { source: SOURCE, model: fields.model || null, kind: fields.kind, obs_id: fields.obs_id || null, trace_id: fields.trace_id || null };
  if (fields.user_id) meta.user_id = fields.user_id;
  if (fields.session_id) meta.session_id = fields.session_id;
  if (fields.tags && fields.tags.length) meta.tags = fields.tags;
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
    meta,
  });
  ev.request = buildExchange(ev, text);
  return ev;
}

function eventsFromObservation(entry) {
  const { trace, obs } = entry;
  const ctx = traceContext(trace);
  const md = obj(obs.metadata) || {};
  const typeRaw = firstStr(obs.type, obs.observationType);
  const type = typeRaw ? typeRaw.toUpperCase() : '';
  const name = firstStr(obs.name) || '';
  const ts = obsTs(obs) || (typeof trace === 'object' && trace ? firstStr(trace.timestamp, trace.start_time) : null);
  const obsId = firstStr(obs.id, obs.observationId);
  const traceId = firstStr(obs.traceId, obs.trace_id) || ctx.traceId;
  const agent = firstStr(ctx.userId, md.agent, md.agent_name, ctx.traceName, name);
  const keyId = firstStr(md.api_key_id, md.key_id, md.api_key_hash, ctx.sessionId);
  const redacted = /redact/i.test(ctx.tagStr) || md.redacted === true;
  const sensitiveHint = /pii|phi|sensitive/i.test(ctx.tagStr) || md.has_sensitive === true || md.sensitive === true;
  const hash = firstStr(obs.hash, md.hash);
  const prevHash = firstStr(obs.prev_hash, md.prev_hash);
  const out = [];

  const common = {
    ts, key_id: keyId, agent, user_id: ctx.userId, session_id: ctx.sessionId, tags: ctx.tags,
    trace_id: traceId, obs_id: obsId, hash, prev_hash: prevHash, redacted,
  };

  if (type === 'GENERATION') {
    const model = firstStr(obs.model, md.model, obj(obs.modelParameters) && obs.modelParameters.model);
    const provider = firstStr(md.provider, md.model_provider, obs.modelProvider);
    const host = modelHost(provider, model);
    const granted = grantedTools(obs);
    const io = sideText(obs.input) + '\n' + sideText(obs.output);
    out.push(toEvent({
      ...common, id: obsId, type: 'model', host, method: 'post', endpoint: '/chat/completions',
      used: null, granted, model, kind: 'llm', egress: !!host,
    }, io, sensitiveHint));
    // Tool calls the model emitted in its output become their own tool events.
    let n = 0;
    for (const call of toolCallsFromOutput(obs.output)) {
      const callHost = egressFrom(call.args);
      out.push(toEvent({
        ...common, id: obsId ? obsId + ':tc' + n : null, type: 'tool', tool: call.name.toLowerCase(),
        host: callHost, used: null, granted, model, kind: 'tool', egress: !!callHost,
      }, str(call.args), sensitiveHint));
      n++;
    }
    return out;
  }

  // SPAN / EVENT: a tool or retrieval action when the name/metadata says so.
  const isRetrieval = RETRIEVAL_RE.test(name) || /retriev/i.test(str(md.type)) || /retriev/i.test(str(md.kind));
  const isTool = isRetrieval || TOOL_RE.test(name) || /tool|function|action|retriev/i.test(str(md.type)) || /tool|function|action|retriev/i.test(str(md.kind)) || md.tool === true;
  if (type === 'SPAN' || type === 'EVENT') {
    if (isRetrieval) {
      out.push(toEvent({
        ...common, id: obsId, type: 'tool', tool: (name || 'retrieval').toLowerCase(),
        host: null, used: null, granted: null, kind: 'retrieval', egress: false,
      }, sideText(obs.input) + '\n' + sideText(obs.output), sensitiveHint));
      return out;
    }
    if (isTool) {
      const host = egressFrom(obs.input) || asHost(md.host) || asHost(md.url);
      out.push(toEvent({
        ...common, id: obsId, type: 'tool', tool: (name || 'tool').toLowerCase(),
        host, used: null, granted: null, kind: 'tool', egress: !!host,
      }, sideText(obs.input) + '\n' + sideText(obs.output), sensitiveHint));
      return out;
    }
  }

  // Structural span / event with no tool/model/retrieval signal: no direct action.
  return out;
}

/**
 * normalize - Langfuse trace export -> canonical AuditEvent[].
 * @param {string|object|object[]} rawExport
 * @returns {object[]} AuditEvents (never throws)
 */
export function normalize(rawExport) {
  try {
    const entries = records(rawExport);
    const events = [];
    for (const entry of entries) {
      try { for (const e of eventsFromObservation(entry)) if (e) events.push(e); }
      catch { /* one bad observation never sinks the export */ }
    }
    return events;
  } catch {
    return [];
  }
}

export default { normalize, source: SOURCE };
