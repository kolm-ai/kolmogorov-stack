// S10 onramp connector - LangSmith run trees -> AuditEvents.
//
// A LangSmith trace is a tree of Run nodes. Each run carries the dimensions an
// agent security audit needs:
//
//   - run_type:   llm | chat_model | tool | retriever | chain | prompt | parser
//   - inputs / outputs:  messages, tool arguments, generations (with tool_calls)
//   - extra.metadata:    ls_model_name, ls_provider, user_id (the agent/identity)
//   - extra.invocation_params.tools:  the tools the model was permitted to call
//   - child_runs:        the nested run tree (flattened here)
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

const SOURCE = 'langsmith';
const CONTENT_CAP = 16 * 1024;

const PROVIDER_HOSTS = {
  openai: 'api.openai.com',
  azure: 'azure-openai',
  azure_openai: 'azure-openai',
  anthropic: 'api.anthropic.com',
  bedrock: 'bedrock.amazonaws.com',
  vertexai: 'aiplatform.googleapis.com',
  vertex: 'aiplatform.googleapis.com',
  google_vertexai: 'aiplatform.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  google_genai: 'generativelanguage.googleapis.com',
  cohere: 'api.cohere.com',
  mistralai: 'api.mistral.ai',
  groq: 'api.groq.com',
  fireworks: 'api.fireworks.ai',
  together: 'api.together.xyz',
  ollama: 'localhost',
};

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

// Flatten an export (string JSON/JSONL, array, wrapper, single run) plus every
// run's child_runs subtree into a flat list of runs.
function records(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    if (t[0] === '[' || t[0] === '{') { try { root = JSON.parse(t); } catch { root = jsonl(t); } }
    else root = jsonl(t);
  }
  let top = [];
  if (Array.isArray(root)) top = root;
  else {
    const o = obj(root);
    if (o) {
      if (arr(o.runs)) top = o.runs;
      else if (arr(o.data)) top = o.data;
      else if (arr(o.results)) top = o.results;
      else top = [o];
    }
  }
  const flat = [];
  const walk = (run, depth) => {
    const r = obj(run);
    if (!r || depth > 64) return;
    flat.push(r);
    const kids = arr(r.child_runs) || arr(r.children);
    if (kids) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of top) walk(r, 0);
  return flat;
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

/* ------------------------------ run helpers ------------------------------ */

function runTs(run) {
  const t = run.start_time ?? run.startTime ?? run.start;
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

function metaOf(run) {
  const extra = obj(run.extra) || {};
  return { extra, metadata: obj(extra.metadata) || {}, invocation: obj(extra.invocation_params) || obj(extra.invocation_metadata) || {} };
}

function identity(run, metadata) {
  const agent = firstStr(metadata.user_id, metadata.agent, metadata.agent_name, run.session_name, metadata.ls_project_name, metadata.LANGSMITH_PROJECT, run.name);
  const keyId = firstStr(metadata.api_key_id, metadata.ls_api_key_id, metadata.key_id, metadata.api_key_hash);
  return { agent, keyId };
}

// The tool allow-list the model was bound to (invocation_params.tools), as
// tool: scopes - what the credential MAY call.
function grantedTools(invocation) {
  const list = arr(invocation && invocation.tools) || arr(invocation && invocation.functions);
  if (!list) return null;
  const out = [];
  for (const t of list) {
    const to = obj(t); if (!to) continue;
    const name = firstStr((obj(to.function) || to).name, obj(to.function) && to.function.name);
    if (name) out.push('tool:' + name.toLowerCase());
  }
  return out.length ? Array.from(new Set(out)) : null;
}

// Dig a LangChain message object (possibly serialized as {kwargs:{...}}) for
// tool calls. Returns [{name, args, id}].
function toolCallsFromMessage(message) {
  const m = obj(message); if (!m) return [];
  const k = obj(m.kwargs) || m;
  const out = [];
  const collect = (list, openaiShape) => {
    if (!arr(list)) return;
    for (const tc of list) {
      const tco = obj(tc); if (!tco) continue;
      if (openaiShape) {
        const fn = obj(tco.function) || tco;
        const name = firstStr(fn.name);
        if (name) out.push({ name, args: fn.arguments != null ? fn.arguments : fn.args, id: firstStr(tco.id) });
      } else {
        const name = firstStr(tco.name);
        if (name) out.push({ name, args: tco.args != null ? tco.args : tco.arguments, id: firstStr(tco.id) });
      }
    }
  };
  collect(k.tool_calls, false);                                   // LangChain core shape: {name, args}
  const addl = obj(k.additional_kwargs) || obj(m.additional_kwargs);
  if (addl) collect(addl.tool_calls, true);                       // OpenAI shape: {function:{name,arguments}}
  return out;
}

// Pull the assistant output message out of a run's outputs.generations tree.
function outputMessages(outputs) {
  const o = obj(outputs); if (!o) return [];
  const gens = arr(o.generations);
  const msgs = [];
  if (gens) {
    for (const g of gens) {
      const list = arr(g) || [g];
      for (const gen of list) {
        const go = obj(gen); if (!go) continue;
        if (obj(go.message)) msgs.push(go.message);
        else if (typeof go.text === 'string') msgs.push({ content: go.text });
      }
    }
  }
  if (!msgs.length && obj(o.message)) msgs.push(o.message);
  return msgs;
}

function inputText(inputs) {
  const o = obj(inputs);
  if (!o) return typeof inputs === 'string' ? inputs : '';
  if (arr(o.messages)) {
    return o.messages.map((m) => {
      const mo = obj(m) || obj(obj(m) && obj(m).kwargs);
      if (!mo) return typeof m === 'string' ? m : '';
      const c = (obj(mo.kwargs) || mo).content;
      return typeof c === 'string' ? c : str(c);
    }).filter(Boolean).join('\n');
  }
  if (typeof o.input === 'string') return o.input;
  return str(o);
}

function egressFrom(inputs) {
  const o = obj(inputs);
  if (o) for (const k of URL_KEYS) if (o[k] != null) { const h = asHost(o[k]); if (h) return h; }
  return asHost(typeof inputs === 'string' ? inputs : (o && (o.url || o.endpoint)));
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
    meta: { source: SOURCE, model: fields.model || null, kind: fields.kind, run_id: fields.run_id || null, trace_id: fields.trace_id || null },
  });
  ev.request = buildExchange(ev, text);
  return ev;
}

function eventsFromRun(run) {
  const type = firstStr(run.run_type, run.runType);
  const rt = type ? type.toLowerCase() : '';
  const { metadata, invocation } = metaOf(run);
  const { agent, keyId } = identity(run, metadata);
  const ts = runTs(run);
  const runId = firstStr(run.id, run.run_id);
  const traceId = firstStr(run.trace_id, run.traceId, run.session_id);
  const tags = str(run.tags);
  const redacted = /redact/i.test(tags) || metadata.redacted === true;
  const sensitiveHint = /pii|phi|sensitive/i.test(tags) || metadata.has_sensitive === true;
  const hash = firstStr(run.hash, metadata.hash);
  const prevHash = firstStr(run.prev_hash, metadata.prev_hash);
  const out = [];

  if (rt === 'tool') {
    const host = egressFrom(run.inputs);
    out.push(toEvent({
      id: runId, ts, key_id: keyId, agent, type: 'tool', tool: (run.name || 'tool').toLowerCase(),
      host, used: null, granted: null, kind: 'tool', run_id: runId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, inputText(run.inputs) + '\n' + str(run.outputs), sensitiveHint));
    return out;
  }

  if (rt === 'retriever') {
    out.push(toEvent({
      id: runId, ts, key_id: keyId, agent, type: 'tool', tool: (run.name || 'retriever').toLowerCase(),
      host: null, used: null, granted: null, kind: 'retrieval', run_id: runId, trace_id: traceId, hash, prev_hash: prevHash, egress: false,
    }, inputText(run.inputs), sensitiveHint));
    return out;
  }

  if (rt === 'llm' || rt === 'chat_model' || rt === 'chat') {
    const model = firstStr(metadata.ls_model_name, invocation.model, invocation.model_name, metadata.model_name);
    const provider = firstStr(metadata.ls_provider, metadata.ls_model_type, invocation.provider);
    const host = modelHost(provider, model);
    const granted = grantedTools(invocation);
    const msgs = outputMessages(run.outputs);
    const io = inputText(run.inputs) + '\n' + msgs.map((m) => { const c = (obj(m) && (obj(obj(m).kwargs) || obj(m)).content); return typeof c === 'string' ? c : str(c); }).filter(Boolean).join('\n');
    out.push(toEvent({
      id: runId, ts, key_id: keyId, agent, type: 'model', host, method: 'post', endpoint: '/chat/completions',
      used: null, granted, model, kind: 'llm', run_id: runId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!host,
    }, io, sensitiveHint));
    let n = 0;
    for (const m of msgs) {
      for (const call of toolCallsFromMessage(m)) {
        const callHost = egressFrom(call.args);
        out.push(toEvent({
          id: runId ? runId + ':tc' + n : null, ts, key_id: keyId, agent, type: 'tool', tool: call.name.toLowerCase(),
          host: callHost, used: null, granted, model, kind: 'tool', run_id: runId, trace_id: traceId, hash, prev_hash: prevHash, egress: !!callHost,
        }, str(call.args), sensitiveHint));
        n++;
      }
    }
    return out;
  }

  // chain / prompt / parser / unknown: structural runs with no direct action.
  return out;
}

/**
 * normalize - LangSmith run-tree export -> canonical AuditEvent[].
 * @param {string|object|object[]} rawExport
 * @returns {object[]} AuditEvents (never throws)
 */
export function normalize(rawExport) {
  try {
    const runs = records(rawExport);
    const events = [];
    for (const run of runs) {
      try { for (const e of eventsFromRun(run)) if (e) events.push(e); }
      catch { /* one bad run never sinks the export */ }
    }
    return events;
  } catch {
    return [];
  }
}

export default { normalize, source: SOURCE };
