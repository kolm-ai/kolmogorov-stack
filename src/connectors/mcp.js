// Connector - MCP server logs (JSON-RPC tools/call traffic) -> AuditEvents.
//
// The Model Context Protocol speaks JSON-RPC 2.0. A server-side log of that
// traffic carries exactly the dimensions the audit needs:
//
//   - tools/call requests  {jsonrpc:'2.0', id, method:'tools/call',
//                           params:{name, arguments}}  - the action
//   - paired results       {jsonrpc:'2.0', id, result:{content[],
//                           structuredContent?, isError?}} - the outcome text
//   - tools/list results   {result:{tools:[{name,...}]}} - the DECLARED tool
//                           surface (granted scopes), and a discovery action
//                           in its own right (the mcp-discovery probe's verb)
//   - initialize results   {result:{serverInfo:{name,version},
//                           protocolVersion}} - which server, which version
//
// Also absorbed: kolm's own mcp-gateway receipts (src/mcp-gateway.js,
// schema 'mcp-tool-call-1/2/3': {tool, args_hash, result_hash, is_error,
// server_id, tenant_id, timestamp, call_id}) and a generic wrapper
// {server, entries[]}. Requests pair with results by JSON-RPC id; an unpaired
// request still emits its event.
//
// One tool AuditEvent per tools/call, with action.server set - the
// load-bearing field: it feeds the red-team mcp-discovery probe
// (src/red-team.js) and the model-provenance mcp_servers surface. The server's
// self-reported version is NOT folded into action.server (a reported version
// is not a deployment pin); it stays visible in meta.server_version so the
// provenance analyzer's unpinned-server finding remains true to the evidence.
//
// normalize(raw) returns canonical AuditEvents (src/audit-event.js shape),
// each with a `request` projection so the events are self-ingesting (same
// contract as the other connectors). Defensive: never throws; unknown or
// malformed shapes yield [].

import { normalizeEvent } from '../audit-event.js';
import { scanPii } from '../pii-redactor.js';

const SOURCE = 'mcp';
const CONTENT_CAP = 16 * 1024;
const RECEIPT_SCHEMAS = new Set(['mcp-tool-call-1', 'mcp-tool-call-2', 'mcp-tool-call-3']);

// Field names that commonly carry a destination URL/host inside tool arguments
// (the URL_ARG_KEYS idiom shared with src/audit-ingest.js and the connectors).
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

// Find a destination host buried in tool arguments (object or stringified JSON).
function egressFrom(input) {
  let o = obj(input);
  if (!o && typeof input === 'string') { try { o = obj(JSON.parse(input)); } catch { /* not json */ } }
  if (o) for (const k of URL_KEYS) if (o[k] != null) { const h = asHost(o[k]); if (h) return h; }
  return null;
}

function rowTs(row) {
  const t = row.ts ?? row.timestamp ?? row.time ?? row.logged_at;
  if (typeof t === 'string' && t.trim() !== '') return t.trim();
  if (typeof t === 'number' && Number.isFinite(t)) {
    const ms = t > 1e12 ? t : t * 1000;
    try { return new Date(ms).toISOString(); } catch { /* fall through */ }
  }
  return null;
}

/* ------------------------------ record parsing ----------------------------- */

// Parse the export into { server, rows }: a flat ordered row list plus an
// export-level server name when a {server, entries[]} wrapper supplied one.
function records(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return { server: null, rows: [] };
    if (t[0] === '[' || t[0] === '{') { try { root = JSON.parse(t); } catch { root = jsonl(t); } }
    else root = jsonl(t);
  }
  let server = null;
  let list = null;
  if (Array.isArray(root)) list = root;
  else {
    const o = obj(root);
    if (o) {
      server = firstStr(o.server, o.server_name, o.serverName);
      for (const k of ['entries', 'rows', 'events', 'data', 'logs', 'messages']) {
        if (arr(o[k])) { list = o[k]; break; }
      }
      if (!list) list = [o];
    }
  }
  const rows = [];
  for (const r of list || []) { const ro = obj(r); if (ro) rows.push(ro); }
  return { server, rows };
}

function isReceipt(row) {
  return RECEIPT_SCHEMAS.has(row.schema) || RECEIPT_SCHEMAS.has(row.receipt_version);
}

/* --------------------------- event construction --------------------------- */

// Self-ingest projection: the same exchange shape the other connectors emit so
// kolm's server-side ingest re-derives the SAME event with no engine change.
function buildExchange(ev, content) {
  const a = ev.action;
  const ex = { user: ev.actor.agent || undefined, metadata: {} };
  if (ev.actor.key_id) ex.metadata.key_id = ev.actor.key_id;
  if (ev.actor.agent) ex.metadata.agent = ev.actor.agent;
  if (a.server) ex.metadata.server = a.server;
  if (Array.isArray(ev.scopes.granted) && ev.scopes.granted.length) {
    ex.tools = ev.scopes.granted.filter((s) => s.startsWith('tool:')).map((s) => ({ type: 'function', function: { name: s.slice(5) } }));
  }
  const text = content == null ? '' : String(content).slice(0, CONTENT_CAP);
  const args = {};
  if (a.host) args.url = a.host;
  if (text) args.content = text;
  ex.messages = [{ role: 'assistant', tool_calls: [{ id: ev.id, type: 'function', function: { name: a.tool || 'tool', arguments: JSON.stringify(args) } }] }];
  return ex;
}

function toEvent(fields, content, sensitiveHint) {
  const text = content == null ? '' : String(content).slice(0, CONTENT_CAP);
  let sensitive = !!sensitiveHint;
  if (!sensitive && text) { try { sensitive = scanPii({ text }).classes_hit.length > 0; } catch { sensitive = false; } }
  const meta = { source: SOURCE, kind: fields.kind, server: fields.server || null };
  if (fields.request_id != null) meta.request_id = String(fields.request_id);
  if (fields.mcp_version) meta.mcp_version = fields.mcp_version;
  if (fields.server_version) meta.server_version = fields.server_version;
  if (fields.is_error != null) meta.is_error = !!fields.is_error;
  if (fields.tenant_id) meta.tenant_id = fields.tenant_id;
  if (fields.transport) meta.transport = fields.transport;
  const ev = normalizeEvent({
    id: fields.id,
    ts: fields.ts,
    namespace: SOURCE,
    actor: { key_id: fields.key_id, agent: fields.agent },
    action: { type: 'tool', tool: fields.tool, server: fields.server, host: fields.host },
    scopes: { granted: fields.granted || null, used: fields.tool ? ['tool:' + fields.tool] : [] },
    data: { has_sensitive: sensitive, redacted: false, egress: fields.egress != null ? fields.egress : !!fields.host },
    disc: fields.request_id != null ? String(fields.request_id) : undefined,
    meta,
  });
  ev.request = buildExchange(ev, text);
  return ev;
}

// Flatten an MCP CallToolResult to scannable text: text content items,
// structuredContent, and any bare value.
function resultText(result) {
  const r = obj(result);
  if (!r) return str(result);
  const parts = [];
  for (const c of arr(r.content) || []) {
    const co = obj(c);
    if (co && typeof co.text === 'string') parts.push(co.text);
    else if (co && co.type !== 'image' && co.type !== 'audio') parts.push(str(co));
  }
  if (r.structuredContent != null) parts.push(str(r.structuredContent));
  if (r.value != null) parts.push(str(r.value));
  return parts.join('\n');
}

/* --------------------------------- normalize ------------------------------- */

function eventsFromRows(exportServer, rows) {
  // Pass 1: fix the server identity for the whole export - initialize results
  // carry serverInfo; rows / receipts may carry server / server_id directly.
  let server = exportServer;
  let serverVersion = null;
  let mcpVersion = null;
  let clientName = null;
  for (const row of rows) {
    const res = obj(row.result);
    const si = res && obj(res.serverInfo);
    if (si) {
      server = server || firstStr(si.name);
      serverVersion = serverVersion || firstStr(si.version);
      mcpVersion = mcpVersion || firstStr(res.protocolVersion);
    }
    const params = obj(row.params);
    const ci = params && obj(params.clientInfo);
    if (ci) {
      clientName = clientName || firstStr(ci.name);
      mcpVersion = mcpVersion || firstStr(params.protocolVersion);
    }
    if (!server) server = firstStr(row.server, row.server_name, row.serverName, isReceipt(row) ? row.server_id : null);
  }

  // Pass 2: ordered walk. Pair tools/call requests with results by JSON-RPC id;
  // a tools/list result fixes the granted tool surface for subsequent calls.
  const pendingCalls = new Map();   // id -> { row, params, ts }
  const pendingMethods = new Map(); // id -> method (tools/list / initialize)
  let granted = null;               // ['tool:<name>', ...] once a list result lands
  const events = [];

  const actorOf = (row) => ({
    key_id: firstStr(row.session_id, row.sessionId, row.client_id, row.clientId),
    agent: firstStr(row.agent, row.client, clientName),
  });

  const emitCall = (reqRow, params, resRow) => {
    const name = firstStr(params && params.name);
    if (!name) return;
    const args = params ? params.arguments : null;
    const host = egressFrom(args);
    const result = resRow ? obj(resRow.result) : null;
    const isError = result ? !!result.isError : (resRow && resRow.error != null ? true : null);
    const actor = actorOf(resRow || reqRow || {});
    const reqActor = reqRow ? actorOf(reqRow) : { key_id: null, agent: null };
    events.push(toEvent({
      kind: 'tool_call', tool: name.toLowerCase(), server, host,
      ts: (reqRow && rowTs(reqRow)) || (resRow && rowTs(resRow)),
      request_id: (reqRow && reqRow.id != null) ? reqRow.id : (resRow ? resRow.id : null),
      key_id: reqActor.key_id || actor.key_id, agent: reqActor.agent || actor.agent,
      granted, mcp_version: mcpVersion, server_version: serverVersion, is_error: isError,
    }, str(args) + '\n' + resultText(result)));
  };

  for (const row of rows) {
    if (isReceipt(row)) {
      // kolm mcp-gateway receipt: hashes only - no argument/result content to
      // scan, no egress host to derive. The action + server surface still land.
      const tool = firstStr(row.tool);
      if (!tool) continue;
      events.push(toEvent({
        kind: 'tool_call', tool: tool.toLowerCase(),
        server: firstStr(row.server_id) || server, host: null,
        ts: firstStr(row.timestamp), id: firstStr(row.call_id),
        request_id: firstStr(row.call_id), granted,
        mcp_version: mcpVersion, server_version: serverVersion,
        is_error: typeof row.is_error === 'boolean' ? row.is_error : null,
        tenant_id: firstStr(row.tenant_id), transport: firstStr(row.transport),
      }, ''));
      continue;
    }

    const method = firstStr(row.method);
    const params = obj(row.params);
    const result = obj(row.result);

    if (method === 'tools/call' && params) {
      if (result || row.error != null) { emitCall(row, params, row); continue; } // single-row req+res log
      if (row.id != null) pendingCalls.set(String(row.id), { row, params });
      else emitCall(row, params, null);
      continue;
    }
    if (method && row.id != null && !result) { pendingMethods.set(String(row.id), method); continue; }

    if (result && row.id != null) {
      const id = String(row.id);
      const pendingCall = pendingCalls.get(id);
      if (pendingCall) { pendingCalls.delete(id); emitCall(pendingCall.row, pendingCall.params, row); continue; }
      const m = pendingMethods.get(id);
      pendingMethods.delete(id);
      const tools = arr(result.tools);
      if (m === 'tools/list' || (!m && tools)) {
        // The declared tool surface, AND a discovery action in its own right:
        // tools/list enumerates the tool surface (the mcp-discovery verb).
        if (tools) {
          const names = [];
          for (const t of tools) { const to = obj(t); const n = to && firstStr(to.name); if (n) names.push('tool:' + n.toLowerCase()); }
          if (names.length) granted = Array.from(new Set(names));
        }
        const actor = actorOf(row);
        events.push(toEvent({
          kind: 'discovery', tool: 'list_tools', server, host: null,
          ts: rowTs(row), request_id: row.id,
          key_id: actor.key_id, agent: actor.agent,
          granted: null, mcp_version: mcpVersion, server_version: serverVersion, egress: false,
        }, ''));
        continue;
      }
      // initialize (or unknown) results carry no direct action; serverInfo was
      // already absorbed in pass 1.
      continue;
    }

    if (row.error != null && row.id != null) {
      const id = String(row.id);
      const pendingCall = pendingCalls.get(id);
      if (pendingCall) { pendingCalls.delete(id); emitCall(pendingCall.row, pendingCall.params, row); }
      pendingMethods.delete(id);
    }
  }

  // Unpaired tools/call requests still happened - emit them result-less.
  for (const { row, params } of pendingCalls.values()) emitCall(row, params, null);

  return events;
}

/**
 * normalize - MCP server log (JSON-RPC / gateway receipts) -> AuditEvent[].
 * @param {string|object|object[]} raw
 * @returns {object[]} AuditEvents (never throws)
 */
export function normalize(raw) {
  try {
    const { server, rows } = records(raw);
    if (!rows.length) return [];
    try { return eventsFromRows(server, rows); } catch { return []; }
  } catch {
    return [];
  }
}

export default { normalize, source: SOURCE };
