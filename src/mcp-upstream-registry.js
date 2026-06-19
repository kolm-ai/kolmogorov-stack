// src/mcp-upstream-registry.js
//
// W641 - production upstream MCP executor registry.
//
// This is the client-side piece for /v1/mcp/dispatch: when a dispatch body
// does not include a precomputed result, the route can now invoke a configured
// upstream MCP server through JSON-RPC tools/call and then sign the resulting
// tool-call receipt. It is deliberately small and explicit:
//   - env/config driven, no global mutable registry
//   - explicit tool allow-list per upstream server
//   - optional tenant allow-list per upstream server
//   - HTTP/Streamable-HTTP JSON-RPC only in this wave
//   - JSON-RPC errors become signed MCP tool error results; transport errors
//     remain route errors because no tool result was produced

import {
  attachMcpUpstreamProvenance,
  hashMcpProvenanceValue,
  normalizeMcpToolContract,
} from './mcp-gateway.js';
import { buildMcpSessionTranscript } from './mcp-session-transcript.js';

export const MCP_UPSTREAM_REGISTRY_VERSION = 'w983-mcp-upstream-registry-v2';
export const MCP_LATEST_PROTOCOL_VERSION = '2025-11-25';

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SUPPORTED_TRANSPORTS = new Set(['http', 'streamable_http', 'streamable-http']);

function _asString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function _array(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    return v.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function _plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function _safeHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function _headersFromConfig(server, env) {
  const headers = {};
  const literal = server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
    ? server.headers
    : {};
  for (const [k, v] of Object.entries(literal)) {
    if (_safeHeaderName(k) && typeof v === 'string') headers[k] = v;
  }
  const fromEnv = server.headers_env && typeof server.headers_env === 'object' && !Array.isArray(server.headers_env)
    ? server.headers_env
    : {};
  for (const [k, envName] of Object.entries(fromEnv)) {
    if (!_safeHeaderName(k) || typeof envName !== 'string') continue;
    const value = env[envName];
    if (typeof value === 'string' && value) headers[k] = value;
  }
  const bearerEnv = _asString(server.bearer_token_env || server.token_env);
  if (bearerEnv && typeof env[bearerEnv] === 'string' && env[bearerEnv]) {
    headers.authorization = `Bearer ${env[bearerEnv]}`;
  }
  return headers;
}

function _normalizeToolEntry(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return TOOL_NAME_RE.test(name) ? { name, contract: null } : null;
  }
  if (!_plainObject(entry)) return null;
  const contract = normalizeMcpToolContract(entry);
  const name = contract && contract.name ? contract.name : _asString(entry.name);
  if (!TOOL_NAME_RE.test(name)) return null;
  return { name, contract: contract || { name } };
}

function _toolEntriesFromConfig(server) {
  const entries = _array(server.tools || server.tool_names).map(_normalizeToolEntry).filter(Boolean);
  const contractMap = _plainObject(server.tool_contracts || server.toolContracts)
    ? (server.tool_contracts || server.toolContracts)
    : {};
  for (const [name, raw] of Object.entries(contractMap)) {
    const contract = normalizeMcpToolContract({ ...(_plainObject(raw) ? raw : {}), name });
    if (contract && TOOL_NAME_RE.test(contract.name)) entries.push({ name: contract.name, contract });
  }
  const byName = new Map();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (!existing || (!existing.contract && entry.contract)) byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function _normalizeServer(raw, env, index) {
  const server = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = _asString(server.id || server.server_id || `mcp-${index + 1}`);
  const transport = _asString(server.transport || 'http').toLowerCase();
  const url = _asString(server.url || server.endpoint);
  const toolEntries = _toolEntriesFromConfig(server);
  const tools = toolEntries.map((entry) => entry.name);
  const tool_contracts = {};
  for (const entry of toolEntries) {
    if (entry.contract) tool_contracts[entry.name] = entry.contract;
  }
  const tenants = _array(server.tenants || server.tenant_ids).map(String);
  const timeout_ms = Number(server.timeout_ms || server.timeoutMs || 10000);
  const protocol_version = _asString(server.protocol_version || server.protocolVersion || MCP_LATEST_PROTOCOL_VERSION);
  const session_transcript = server.session_transcript !== false && server.sessionTranscript !== false;

  if (!id || !url || tools.length === 0 || !SUPPORTED_TRANSPORTS.has(transport)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  return {
    id,
    server_id: id,
    transport,
    url,
    tools: [...new Set(tools)].sort(),
    tool_contracts,
    tenants: [...new Set(tenants)].sort(),
    timeout_ms: Number.isFinite(timeout_ms) && timeout_ms > 0 ? Math.min(timeout_ms, 120000) : 10000,
    protocol_version,
    session_transcript,
    headers: _headersFromConfig(server, env),
  };
}

export function parseMcpUpstreams(raw, env = process.env) {
  if (raw == null || raw === '') return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  const rows = Array.isArray(parsed) ? parsed : _array(parsed.servers || parsed.upstreams);
  return rows.map((row, i) => _normalizeServer(row, env, i)).filter(Boolean);
}

export function mcpUpstreamsFromEnv(env = process.env) {
  const raw = env.KOLM_MCP_UPSTREAMS_JSON || env.KOLM_MCP_UPSTREAMS || '';
  const configured = parseMcpUpstreams(raw, env);
  const singleUrl = _asString(env.KOLM_MCP_UPSTREAM_URL);
  const singleTools = _array(env.KOLM_MCP_UPSTREAM_TOOLS);
  if (singleUrl && singleTools.length > 0) {
    const single = _normalizeServer({
      id: env.KOLM_MCP_UPSTREAM_SERVER_ID || 'default',
      url: singleUrl,
      tools: singleTools,
      transport: env.KOLM_MCP_UPSTREAM_TRANSPORT || 'http',
      timeout_ms: env.KOLM_MCP_UPSTREAM_TIMEOUT_MS,
      bearer_token_env: env.KOLM_MCP_UPSTREAM_BEARER_TOKEN_ENV || 'KOLM_MCP_UPSTREAM_TOKEN',
    }, env, configured.length);
    if (single) configured.push(single);
  }
  const seen = new Set();
  return configured.filter((server) => {
    const key = server.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _tenantAllowed(server, tenant) {
  if (!server.tenants || server.tenants.length === 0) return true;
  return server.tenants.includes(String(tenant));
}

function _resolveServer(servers, { tool, tenant, server_id } = {}) {
  const name = _asString(tool);
  if (!TOOL_NAME_RE.test(name)) throw _err('mcp_upstream_bad_tool_name', 'MCP tool name must be 1-128 ASCII letters/digits/_.-');
  const candidates = servers.filter((server) => {
    if (server_id && server.id !== server_id) return false;
    if (!server.tools.includes(name)) return false;
    return _tenantAllowed(server, tenant);
  });
  if (candidates.length === 0) {
    throw _err('mcp_upstream_tool_not_registered', `No configured upstream MCP server for tool "${name}"`, { tool: name, server_id: server_id || null });
  }
  if (candidates.length > 1 && !server_id) {
    throw _err('mcp_upstream_ambiguous_tool', `Multiple upstream MCP servers expose tool "${name}"; pass server_id`, {
      tool: name,
      servers: candidates.map((s) => s.id),
    });
  }
  return candidates[0];
}

function _toolErrorResult(error) {
  const msg = error && typeof error.message === 'string' ? error.message : 'MCP tool error';
  const code = error && Number.isFinite(error.code) ? error.code : null;
  return {
    content: [{ type: 'text', text: code == null ? msg : `${msg} (code ${code})` }],
    structuredContent: { jsonrpc_error: { code, message: msg, ...(error && error.data !== undefined ? { data: error.data } : {}) } },
    isError: true,
  };
}

function _normalizeToolResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }], isError: false };
  return { content: [], structuredContent: result == null ? null : result, isError: false };
}

function _upstreamProvenance(payload, responseBody) {
  return {
    request_id: payload && payload.id != null ? String(payload.id).slice(0, 128) : null,
    request_hash: hashMcpProvenanceValue(payload),
    response_hash: hashMcpProvenanceValue(responseBody),
  };
}

function _responseHeader(res, name) {
  const headers = res && res.headers;
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') {
      const v = headers.get(name) || headers.get(String(name).toLowerCase()) || headers.get(String(name).toUpperCase());
      return typeof v === 'string' && v ? v : null;
    }
    if (typeof headers === 'object') {
      const want = String(name || '').toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() !== want) continue;
        return Array.isArray(v) ? String(v[0] || '') : String(v || '');
      }
    }
  } catch { return null; }
  return null;
}

function _parseJsonOrSse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw[0] === '{' || raw[0] === '[') return JSON.parse(raw);
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m && m[1] && m[1] !== '[DONE]') data.push(m[1]);
  }
  for (let i = data.length - 1; i >= 0; i--) {
    try { return JSON.parse(data[i]); } catch { /* try prior SSE data row */ }
  }
  throw new Error('not_json_or_sse');
}

async function _postJsonRpcEnvelope(server, payload, fetchImpl, opts = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), server.timeout_ms) : null;
  try {
    const protocolVersion = opts.protocol_version || server.protocol_version || MCP_LATEST_PROTOCOL_VERSION;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      ...server.headers,
    };
    if (opts.session_id) headers['mcp-session-id'] = opts.session_id;
    const res = await fetchImpl(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = _parseJsonOrSse(text); } catch {
        if (!res.ok) throw _err('mcp_upstream_http_error', `MCP upstream ${server.id} returned HTTP ${res.status}`, { status: res.status, server_id: server.id });
        throw _err('mcp_upstream_bad_json', `MCP upstream ${server.id} returned non-JSON response`, { server_id: server.id });
      }
    }
    if (opts.notification && res.ok && !body) {
      return { body: null, status: res.status, session_id: _responseHeader(res, 'mcp-session-id') || null };
    }
    if (!res.ok) throw _err('mcp_upstream_http_error', `MCP upstream ${server.id} returned HTTP ${res.status}`, { status: res.status, server_id: server.id, body });
    return { body, status: res.status, session_id: _responseHeader(res, 'mcp-session-id') || null };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw _err('mcp_upstream_timeout', `MCP upstream ${server.id} timed out after ${server.timeout_ms}ms`, { server_id: server.id });
    }
    if (e && e.code) throw e;
    throw _err('mcp_upstream_unreachable', `MCP upstream ${server.id} request failed: ${(e && e.message) || e}`, { server_id: server.id });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function _postJsonRpc(server, payload, fetchImpl, opts = {}) {
  const env = await _postJsonRpcEnvelope(server, payload, fetchImpl, opts);
  const body = env.body;
  if (body && body.error) {
    return attachMcpUpstreamProvenance(_toolErrorResult(body.error), _upstreamProvenance(payload, body));
  }
  if (!body || body.jsonrpc !== '2.0' || !('result' in body)) {
    throw _err('mcp_upstream_bad_response', `MCP upstream ${server.id} response is not a JSON-RPC result`, { server_id: server.id });
  }
  return attachMcpUpstreamProvenance(_normalizeToolResult(body.result), _upstreamProvenance(payload, body));
}

function _initializeRequest(server) {
  return {
    jsonrpc: '2.0',
    id: 'kolm-init-1',
    method: 'initialize',
    params: {
      protocolVersion: server.protocol_version || MCP_LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'kolm-mcp-gateway',
        version: MCP_UPSTREAM_REGISTRY_VERSION,
      },
    },
  };
}

function _initializedNotification() {
  return { jsonrpc: '2.0', method: 'notifications/initialized' };
}

function _toolsListRequest() {
  return { jsonrpc: '2.0', id: 'kolm-tools-1', method: 'tools/list', params: {} };
}

function _toolsFromListResponse(body) {
  const result = body && typeof body === 'object' && body.result && typeof body.result === 'object' ? body.result : {};
  return Array.isArray(result.tools) ? result.tools : null;
}

function _assertToolListed(server, tool, tools) {
  if (!Array.isArray(tools)) return;
  if (tools.some((row) => row && typeof row === 'object' && row.name === tool)) return;
  throw _err('mcp_upstream_tool_not_listed', `MCP upstream ${server.id} tools/list did not advertise "${tool}"`, {
    server_id: server.id,
    tool,
  });
}

async function _executeWithSessionTranscript(server, { tool, args }, fetchImpl) {
  const initialize_request = _initializeRequest(server);
  const init = await _postJsonRpcEnvelope(server, initialize_request, fetchImpl);
  if (!init.body || init.body.error || init.body.jsonrpc !== '2.0' || !init.body.result) {
    throw _err('mcp_upstream_initialize_error', `MCP upstream ${server.id} did not return a valid initialize result`, { server_id: server.id });
  }
  const protocol_version = _asString(init.body.result.protocolVersion) || server.protocol_version || MCP_LATEST_PROTOCOL_VERSION;
  const upstream_session_id = init.session_id;

  const initialized_notification = _initializedNotification();
  const initialized = await _postJsonRpcEnvelope(server, initialized_notification, fetchImpl, {
    notification: true,
    session_id: upstream_session_id,
    protocol_version,
  });

  const tools_list_request = _toolsListRequest();
  const list = await _postJsonRpcEnvelope(server, tools_list_request, fetchImpl, {
    session_id: upstream_session_id,
    protocol_version,
  });
  if (!list.body || list.body.error || list.body.jsonrpc !== '2.0' || !list.body.result) {
    throw _err('mcp_upstream_tools_list_error', `MCP upstream ${server.id} did not return a valid tools/list result`, { server_id: server.id });
  }
  _assertToolListed(server, tool, _toolsFromListResponse(list.body));

  const tool_call_request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args == null ? {} : args },
  };
  const call = await _postJsonRpcEnvelope(server, tool_call_request, fetchImpl, {
    session_id: upstream_session_id,
    protocol_version,
  });

  const transcript = buildMcpSessionTranscript({
    protocol_version,
    server_id: server.id,
    transport: server.transport,
    upstream_session_id,
    initialize_request,
    initialize_response: init.body,
    initialized_notification,
    initialized_ack: initialized.body,
    initialized_ack_status: initialized.status,
    tools_list_request,
    tools_list_response: list.body,
    tool_call_request,
    tool_call_response: call.body,
  });

  const provenance = {
    ..._upstreamProvenance(tool_call_request, call.body),
    mcp_protocol_version: protocol_version,
    mcp_upstream_session_id: upstream_session_id,
    mcp_session_transcript: transcript,
  };
  if (call.body && call.body.error) {
    return attachMcpUpstreamProvenance(_toolErrorResult(call.body.error), provenance);
  }
  if (!call.body || call.body.jsonrpc !== '2.0' || !('result' in call.body)) {
    throw _err('mcp_upstream_bad_response', `MCP upstream ${server.id} response is not a JSON-RPC result`, { server_id: server.id });
  }
  return attachMcpUpstreamProvenance(_normalizeToolResult(call.body.result), provenance);
}

export function makeMcpUpstreamRegistry(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const servers = (opts.servers || []).map((row, i) => _normalizeServer(row, opts.env || process.env, i)).filter(Boolean);
  const configured = servers.length > 0;

  return {
    version: MCP_UPSTREAM_REGISTRY_VERSION,
    configured,
    list() {
      return servers.map((server) => ({
        id: server.id,
        transport: server.transport,
        url: server.url,
        tools: server.tools.slice(),
        tool_contracts: { ...server.tool_contracts },
        tenants: server.tenants.slice(),
        protocol_version: server.protocol_version,
        timeout_ms: server.timeout_ms,
        session_transcript: server.session_transcript,
      }));
    },
    resolve({ tool, tenant, server_id } = {}) {
      return _resolveServer(servers, { tool, tenant, server_id });
    },
    toolContractFor({ tool, tenant, server_id } = {}) {
      const server = _resolveServer(servers, { tool, tenant, server_id });
      const contract = server.tool_contracts && server.tool_contracts[tool];
      return contract ? { ...contract } : null;
    },
    async execute({ tool, args = {}, tenant, server_id } = {}) {
      if (typeof fetchImpl !== 'function') {
        throw _err('mcp_upstream_fetch_unavailable', 'global fetch is not available for MCP upstream execution');
      }
      const server = _resolveServer(servers, { tool, tenant, server_id });
      if (server.session_transcript) {
        return _executeWithSessionTranscript(server, { tool, args }, fetchImpl);
      }
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args == null ? {} : args },
      };
      return _postJsonRpc(server, request, fetchImpl);
    },
  };
}

export function makeMcpUpstreamRegistryFromEnv(opts = {}) {
  const env = opts.env || process.env;
  return makeMcpUpstreamRegistry({
    env,
    fetchImpl: opts.fetchImpl,
    servers: mcpUpstreamsFromEnv(env),
  });
}

export function makeMcpUpstreamExecutorFromEnv(opts = {}) {
  const registry = makeMcpUpstreamRegistryFromEnv(opts);
  return {
    configured: registry.configured,
    registry,
    execute: registry.configured ? registry.execute : undefined,
    toolContractFor: registry.configured ? registry.toolContractFor : undefined,
  };
}

export default {
  MCP_UPSTREAM_REGISTRY_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  parseMcpUpstreams,
  mcpUpstreamsFromEnv,
  makeMcpUpstreamRegistry,
  makeMcpUpstreamRegistryFromEnv,
  makeMcpUpstreamExecutorFromEnv,
};
