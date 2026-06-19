// src/mcp-session-transcript.js
//
// W983 - privacy-safe MCP session transcript continuity.
//
// The receipt path signs per-call hashes. This module builds the companion
// session object that lets an external verifier replay the MCP lifecycle shape
// without seeing raw tool arguments, results, auth headers, or user content.

import crypto from 'node:crypto';
import { canonicalJson } from './cid.js';

export const MCP_SESSION_TRANSCRIPT_VERSION = 'kolm-mcp-session-transcript-1';

function _sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function _hashCanonical(value) {
  const v = value === undefined ? null : value;
  return `sha256:${_sha256Hex(Buffer.from(canonicalJson(v), 'utf8'))}`;
}

function _plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _str(v, max = 256) {
  if (v == null || v === '') return null;
  return String(v).slice(0, max);
}

function _hash(v) {
  if (typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)) return v;
  if (v == null) return null;
  return _hashCanonical(v);
}

function _normalizeToolDescriptor(tool) {
  if (!_plainObject(tool)) return null;
  const name = _str(tool.name, 128);
  if (!name) return null;
  const out = { name };
  for (const k of ['title', 'description']) {
    const s = _str(tool[k], k === 'description' ? 8192 : 512);
    if (s) out[k] = s;
  }
  if (_plainObject(tool.inputSchema)) out.inputSchema = tool.inputSchema;
  if (_plainObject(tool.outputSchema)) out.outputSchema = tool.outputSchema;
  if (_plainObject(tool.annotations)) out.annotations = tool.annotations;
  if (_plainObject(tool.execution)) out.execution = tool.execution;
  if (Array.isArray(tool.icons)) out.icons = tool.icons;
  return out;
}

function _toolsFromResponse(response) {
  const body = _plainObject(response) ? response : {};
  const result = _plainObject(body.result) ? body.result : body;
  return Array.isArray(result.tools)
    ? result.tools.map(_normalizeToolDescriptor).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
    : null;
}

export function hashMcpToolsSnapshot(response) {
  const tools = _toolsFromResponse(response);
  return tools ? _hashCanonical(tools) : null;
}

function _event({ phase, direction, message, hash, method, id, status } = {}) {
  const h = _hash(hash || message);
  if (!h) return null;
  const out = {
    phase: _str(phase, 64),
    direction: _str(direction, 16) || 'client_to_server',
    hash: h,
  };
  const msg = _plainObject(message) ? message : {};
  const m = _str(method || msg.method, 128);
  if (m) out.method = m;
  const eventId = id != null ? id : msg.id;
  if (eventId != null) out.id = String(eventId).slice(0, 128);
  if (status != null) out.status = String(status).slice(0, 32);
  return out;
}

export function buildMcpSessionTranscript(opts = {}) {
  if (opts && opts.version === MCP_SESSION_TRANSCRIPT_VERSION && Array.isArray(opts.events)) {
    return {
      version: MCP_SESSION_TRANSCRIPT_VERSION,
      protocol_version: _str(opts.protocol_version || opts.protocolVersion, 64),
      server_id: _str(opts.server_id || opts.serverId, 256),
      transport: _str(opts.transport, 32),
      upstream_session_hash: _hash(opts.upstream_session_hash) || null,
      tools_snapshot_hash: _hash(opts.tools_snapshot_hash) || null,
      events: opts.events.map((ev) => _event(ev)).filter(Boolean),
    };
  }

  const upstreamSessionHash = _hash(opts.upstream_session_hash)
    || (opts.upstream_session_id ? _hashCanonical(String(opts.upstream_session_id)) : null);
  const events = [
    _event({ phase: 'initialize_request', direction: 'client_to_server', message: opts.initialize_request }),
    _event({ phase: 'initialize_response', direction: 'server_to_client', message: opts.initialize_response }),
    _event({ phase: 'initialized_notification', direction: 'client_to_server', message: opts.initialized_notification }),
    _event({ phase: 'initialized_ack', direction: 'server_to_client', message: opts.initialized_ack, status: opts.initialized_ack_status }),
    _event({ phase: 'tools_list_request', direction: 'client_to_server', message: opts.tools_list_request }),
    _event({ phase: 'tools_list_response', direction: 'server_to_client', message: opts.tools_list_response }),
    _event({ phase: 'tool_call_request', direction: 'client_to_server', message: opts.tool_call_request }),
    _event({ phase: 'tool_call_response', direction: 'server_to_client', message: opts.tool_call_response }),
  ].filter(Boolean);

  return {
    version: MCP_SESSION_TRANSCRIPT_VERSION,
    protocol_version: _str(
      opts.protocol_version
        || opts.protocolVersion
        || opts.initialize_response?.result?.protocolVersion
        || opts.initialize_request?.params?.protocolVersion,
      64,
    ),
    server_id: _str(opts.server_id || opts.serverId, 256),
    transport: _str(opts.transport, 32),
    upstream_session_hash: upstreamSessionHash,
    tools_snapshot_hash: opts.tools_snapshot_hash || hashMcpToolsSnapshot(opts.tools_list_response),
    events,
  };
}

export function hashMcpSessionTranscript(transcript) {
  const t = buildMcpSessionTranscript(transcript || {});
  return t.events.length ? _hashCanonical(t) : null;
}

function _phaseHash(t, phase) {
  const ev = (t.events || []).find((row) => row && row.phase === phase);
  return ev ? ev.hash : null;
}

export function summarizeMcpSessionTranscript(transcript) {
  const t = buildMcpSessionTranscript(transcript || {});
  const transcriptHash = hashMcpSessionTranscript(t);
  return {
    mcp_protocol_version: t.protocol_version || null,
    mcp_upstream_session_hash: t.upstream_session_hash || null,
    mcp_session_transcript_version: transcriptHash ? t.version : null,
    mcp_session_transcript_hash: transcriptHash,
    mcp_session_transcript_step_count: t.events.length,
    mcp_initialize_request_hash: _phaseHash(t, 'initialize_request'),
    mcp_initialize_response_hash: _phaseHash(t, 'initialize_response'),
    mcp_initialized_notification_hash: _phaseHash(t, 'initialized_notification'),
    mcp_tools_list_request_hash: _phaseHash(t, 'tools_list_request'),
    mcp_tools_list_response_hash: _phaseHash(t, 'tools_list_response'),
    mcp_tools_snapshot_hash: t.tools_snapshot_hash || null,
    mcp_tool_call_request_hash: _phaseHash(t, 'tool_call_request'),
    mcp_tool_call_response_hash: _phaseHash(t, 'tool_call_response'),
  };
}

export default {
  MCP_SESSION_TRANSCRIPT_VERSION,
  buildMcpSessionTranscript,
  hashMcpSessionTranscript,
  hashMcpToolsSnapshot,
  summarizeMcpSessionTranscript,
};
