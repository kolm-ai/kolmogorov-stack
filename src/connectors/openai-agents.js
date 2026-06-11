// Connector - OpenAI Agents SDK trace exports -> AuditEvents.
//
// The Agents SDK tracing surface exports two object kinds:
//
//   {object:'trace', id:'trace_...', workflow_name, group_id, metadata}
//   {object:'trace.span', id:'span_...', trace_id, parent_id,
//    started_at, ended_at, span_data:{type, ...}, error}
//
// span_data.type maps onto the audit dimensions:
//
//   generation - a model call:  {model, input, output, model_config, usage}
//                -> model event (input/output text feeds the sensitivity scan)
//   function   - a tool call:   {name, input, output}
//                -> tool event (argument-derived egress host)
//   handoff    - a delegation:  {from_agent, to_agent}
//                -> tool event 'handoff' with meta.to_agent/target_agent, the
//                   explicit edge src/delegation-analyzer.js TARGET_KEYS reads
//   guardrail  - a runtime control: {name, triggered}
//                -> tool event carrying a 'guardrail' token in its name so the
//                   red-team runtime-guardrails-absent probe sees the control
//   agent      - structural: {name, tools[], handoffs[]} - no direct action;
//                names the actor for descendant spans (parent_id chain) and
//                declares the granted tool surface
//
// Accepts an array, a {data:[...]} page, JSONL, or a single object. The trace's
// group_id (the SDK's conversation/thread grouping) lands in meta.thread_id;
// workflow_name in meta.workflow. Generations default to api.openai.com unless
// model_config names another base.
//
// normalize(raw) returns canonical AuditEvents (src/audit-event.js shape) with
// a `request` projection (self-ingesting, same contract as the other
// connectors). Defensive: never throws; unknown / malformed shapes yield [].

import { normalizeEvent } from '../audit-event.js';
import { scanPii } from '../pii-redactor.js';

const SOURCE = 'openai-agents';
const CONTENT_CAP = 16 * 1024;
const DEFAULT_MODEL_HOST = 'api.openai.com';
const SPAN_TYPES = new Set(['agent', 'generation', 'function', 'handoff', 'guardrail', 'response', 'custom']);
const PARENT_DEPTH_CAP = 64;

// Field names that commonly carry a destination URL/host inside tool arguments.
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

function jsonl(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
  }
  return out;
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

function egressFrom(input) {
  let o = obj(input);
  if (!o && typeof input === 'string') { try { o = obj(JSON.parse(input)); } catch { /* not json */ } }
  if (o) for (const k of URL_KEYS) if (o[k] != null) { const h = asHost(o[k]); if (h) return h; }
  return null;
}

function records(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    if (t[0] === '[' || t[0] === '{') { try { root = JSON.parse(t); } catch { root = jsonl(t); } }
    else root = jsonl(t);
  }
  let list = null;
  if (Array.isArray(root)) list = root;
  else {
    const o = obj(root);
    if (o) {
      for (const k of ['data', 'spans', 'items', 'events', 'rows']) { if (arr(o[k])) { list = o[k]; break; } }
      if (!list) list = [o];
    }
  }
  const out = [];
  for (const r of list || []) { const ro = obj(r); if (ro) out.push(ro); }
  return out;
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
    if (ev.meta.to_agent) args.to_agent = ev.meta.to_agent;
    ex.messages = [{ role: 'assistant', tool_calls: [{ id: ev.id, type: 'function', function: { name: a.tool, arguments: JSON.stringify(args) } }] }];
  } else {
    if (a.host) ex.api_base = 'https://' + a.host;
    ex.messages = [{ role: 'user', content: text }];
  }
  return ex;
}

function toEvent(fields, content) {
  const text = content == null ? '' : String(content).slice(0, CONTENT_CAP);
  let sensitive = false;
  if (text) { try { sensitive = scanPii({ text }).classes_hit.length > 0; } catch { sensitive = false; } }
  const meta = { source: SOURCE, kind: fields.kind, model: fields.model || null };
  if (fields.trace_id) meta.trace_id = fields.trace_id;
  if (fields.request_id) meta.request_id = fields.request_id;
  if (fields.thread_id) meta.thread_id = fields.thread_id;
  if (fields.workflow) meta.workflow = fields.workflow;
  if (fields.to_agent) { meta.to_agent = fields.to_agent; meta.target_agent = fields.to_agent; }
  if (fields.from_agent) meta.from_agent = fields.from_agent;
  if (fields.triggered != null) meta.triggered = !!fields.triggered;
  if (fields.is_error != null) meta.is_error = !!fields.is_error;
  const ev = normalizeEvent({
    id: fields.id,
    ts: fields.ts,
    namespace: SOURCE,
    actor: { key_id: fields.key_id, agent: fields.agent },
    action: { type: fields.type, tool: fields.tool, host: fields.host, method: fields.method, endpoint: fields.endpoint },
    scopes: { granted: fields.granted || null, used: fields.used || [] },
    data: { has_sensitive: sensitive, redacted: false, egress: fields.egress != null ? fields.egress : !!fields.host },
    meta,
  });
  ev.request = buildExchange(ev, text);
  return ev;
}

/* --------------------------------- normalize ------------------------------- */

function normalizeRows(rows) {
  // Pass 1: index traces and spans.
  const traces = new Map(); // trace_id -> { workflow, group_id }
  const spans = new Map();  // span_id  -> span row
  const spanRows = [];
  for (const row of rows) {
    if (row.object === 'trace' || (row.workflow_name != null && row.span_data == null)) {
      const id = firstStr(row.id, row.trace_id);
      if (id) traces.set(id, { workflow: firstStr(row.workflow_name), group_id: firstStr(row.group_id) });
      continue;
    }
    const sd = obj(row.span_data);
    if (!sd || typeof sd.type !== 'string') continue;
    const id = firstStr(row.id, row.span_id);
    if (id) spans.set(id, row);
    spanRows.push(row);
  }

  // Nearest ancestor agent span (parent_id chain) names the actor and declares
  // the granted tool surface for its descendants.
  const agentFor = (row) => {
    let cur = row;
    for (let i = 0; i < PARENT_DEPTH_CAP && cur; i++) {
      const sd = obj(cur.span_data);
      if (sd && sd.type === 'agent') {
        const tools = [];
        for (const t of arr(sd.tools) || []) {
          const n = typeof t === 'string' ? t : (obj(t) && firstStr(obj(t).name));
          if (n) tools.push('tool:' + n.toLowerCase());
        }
        return { name: firstStr(sd.name), granted: tools.length ? Array.from(new Set(tools)) : null };
      }
      const pid = firstStr(cur.parent_id);
      cur = pid ? spans.get(pid) : null;
    }
    return { name: null, granted: null };
  };

  const events = [];
  for (const row of spanRows) {
    const sd = obj(row.span_data);
    const type = sd.type;
    if (!SPAN_TYPES.has(type) || type === 'agent' || type === 'response' || type === 'custom') continue;

    const traceId = firstStr(row.trace_id);
    const trace = (traceId && traces.get(traceId)) || { workflow: null, group_id: null };
    const anc = agentFor(row);
    const common = {
      ts: firstStr(row.started_at, row.ended_at),
      id: firstStr(row.id, row.span_id),
      request_id: firstStr(row.id, row.span_id),
      trace_id: traceId,
      thread_id: trace.group_id,
      workflow: trace.workflow,
      agent: anc.name || trace.workflow,
      key_id: null,
      granted: anc.granted,
      is_error: row.error != null ? true : null,
    };

    if (type === 'generation') {
      const model = firstStr(sd.model);
      const cfg = obj(sd.model_config);
      const host = (cfg && asHost(cfg.base_url)) || DEFAULT_MODEL_HOST;
      events.push(toEvent({
        ...common, kind: 'llm', type: 'model', model, host,
        method: 'post', endpoint: '/chat/completions', egress: true,
      }, str(sd.input) + '\n' + str(sd.output)));
      continue;
    }
    if (type === 'function') {
      const name = firstStr(sd.name) || 'tool';
      const host = egressFrom(sd.input);
      events.push(toEvent({
        ...common, kind: 'tool', type: 'tool', tool: name.toLowerCase(), host,
        used: ['tool:' + name.toLowerCase()], egress: !!host,
      }, str(sd.input) + '\n' + str(sd.output)));
      continue;
    }
    if (type === 'handoff') {
      const toAgent = firstStr(sd.to_agent);
      events.push(toEvent({
        ...common, kind: 'handoff', type: 'tool', tool: 'handoff', host: null,
        used: ['tool:handoff'], egress: false,
        to_agent: toAgent, from_agent: firstStr(sd.from_agent) || anc.name,
        agent: firstStr(sd.from_agent) || common.agent,
      }, ''));
      continue;
    }
    if (type === 'guardrail') {
      // Carry a 'guardrail' token in the tool name so the red-team
      // runtime-guardrails-absent probe recognizes the control step.
      const base = (firstStr(sd.name) || '').toLowerCase();
      const tool = !base ? 'guardrail' : (/(^|[^a-z])guardrail/.test(base) ? base : base + '_guardrail');
      events.push(toEvent({
        ...common, kind: 'guardrail', type: 'tool', tool, host: null,
        used: ['tool:' + tool], egress: false,
        triggered: sd.triggered === true,
      }, ''));
      continue;
    }
  }
  return events;
}

/**
 * normalize - OpenAI Agents SDK trace export -> canonical AuditEvent[].
 * @param {string|object|object[]} raw
 * @returns {object[]} AuditEvents (never throws)
 */
export function normalize(raw) {
  try {
    const rows = records(raw);
    if (!rows.length) return [];
    try { return normalizeRows(rows); } catch { return []; }
  } catch {
    return [];
  }
}

export default { normalize, source: SOURCE };
