// W983 - MCP session transcript continuity.
//
// W982 bound a single tools/call to caller/upstream provenance. This wave binds
// the surrounding MCP lifecycle transcript so initialize, initialized,
// tools/list, and tools/call form one verifier-facing hash chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  MCP_PROVENANCE_RECEIPT_SCHEMA,
  MCP_RECEIPT_SCHEMA,
  buildMcpReceipt,
  getMcpUpstreamProvenance,
  hashMcpProvenanceValue,
  signMcpReceipt,
  verifyMcpReceipt,
} from '../src/mcp-gateway.js';
import {
  MCP_LATEST_PROTOCOL_VERSION,
  makeMcpUpstreamRegistry,
} from '../src/mcp-upstream-registry.js';
import {
  MCP_SESSION_TRANSCRIPT_VERSION,
  buildMcpSessionTranscript,
  hashMcpSessionTranscript,
  hashMcpToolsSnapshot,
  summarizeMcpSessionTranscript,
} from '../src/mcp-session-transcript.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';
import { toInTotoStatement } from '../src/intoto-receipt.js';
import { getReceiptDescriptor, listReceiptClasses } from '../src/receipt-export-registry.js';

const NOW = 1748476800000;
const TENANT = 'tenant_w983';
const TOOL = 'crm.lookup';
const ARGS = { customer_id: 'c_123' };
const RESULT = {
  content: [{ type: 'text', text: 'Customer c_123 is active' }],
  structuredContent: { customer_id: 'c_123', state: 'active' },
  isError: false,
};
const TOOL_DESCRIPTOR = {
  name: TOOL,
  title: 'CRM Lookup',
  inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
};

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

function makeRouterStub() {
  const routes = { get: {}, post: {} };
  return {
    routes,
    get(p, ...h) { routes.get[p] = h; },
    post(p, ...h) { routes.post[p] = h; },
    async invoke(method, routePath, { tenant, tenantRecord, auth, headers, body, params } = {}) {
      const handlers = routes[method][routePath];
      assert.ok(handlers, `no handler for ${method} ${routePath}`);
      const req = {
        tenant_record: tenantRecord || (tenant ? { id: tenant } : null),
        auth: auth || null,
        tenant,
        body: body || {},
        params: params || {},
        query: {},
        headers: headers || {},
      };
      let statusCode = 200;
      let payload;
      const res = {
        status(c) { statusCode = c; return this; },
        json(p) { payload = p; return this; },
      };
      let idx = 0;
      const next = async () => {
        const h = handlers[idx++];
        if (h) await h(req, res, next);
      };
      await next();
      return { statusCode, payload };
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name || '').toLowerCase()] || null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

function sampleTranscript() {
  const initialize_request = {
    jsonrpc: '2.0',
    id: 'kolm-init-1',
    method: 'initialize',
    params: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'kolm-mcp-gateway' } },
  };
  const initialize_response = {
    jsonrpc: '2.0',
    id: 'kolm-init-1',
    result: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'crm', version: '1.0.0' } },
  };
  const initialized_notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const tools_list_request = { jsonrpc: '2.0', id: 'kolm-tools-1', method: 'tools/list', params: {} };
  const tools_list_response = { jsonrpc: '2.0', id: 'kolm-tools-1', result: { tools: [TOOL_DESCRIPTOR] } };
  const tool_call_request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: ARGS } };
  const tool_call_response = { jsonrpc: '2.0', id: 1, result: RESULT };
  return buildMcpSessionTranscript({
    protocol_version: MCP_LATEST_PROTOCOL_VERSION,
    server_id: 'crm',
    transport: 'streamable_http',
    upstream_session_id: 'upstream-session-123',
    initialize_request,
    initialize_response,
    initialized_notification,
    tools_list_request,
    tools_list_response,
    tool_call_request,
    tool_call_response,
  });
}

test('W983 #1 mcp-tool-call-3 signs a privacy-safe lifecycle transcript summary', () => {
  const signer = makeSigner();
  const transcript = sampleTranscript();
  const summary = summarizeMcpSessionTranscript(transcript);
  const built = buildMcpReceipt({
    tenant: TENANT,
    tool: TOOL,
    args: ARGS,
    result: RESULT,
    now: NOW,
    call_id: 'mtc_W983SIGNED000000000000A',
    transport: 'streamable_http',
    server_id: 'crm',
    caller: { subject_id: 'user_123', mcp_session_id: 'host_session_456' },
    mcp_session_transcript: transcript,
  });
  const receipt = signMcpReceipt(built, signer, { signed_at: built.timestamp });

  assert.equal(receipt.schema, MCP_RECEIPT_SCHEMA);
  assert.equal(receipt.mcp_session_transcript_version, MCP_SESSION_TRANSCRIPT_VERSION);
  assert.equal(receipt.mcp_session_transcript_hash, hashMcpSessionTranscript(transcript));
  assert.equal(receipt.mcp_session_transcript_hash, summary.mcp_session_transcript_hash);
  assert.equal(receipt.mcp_session_transcript_step_count, 7);
  assert.equal(receipt.mcp_protocol_version, MCP_LATEST_PROTOCOL_VERSION);
  assert.equal(receipt.mcp_tools_snapshot_hash, hashMcpToolsSnapshot({ result: { tools: [TOOL_DESCRIPTOR] } }));
  assert.equal(receipt.mcp_tool_call_request_hash, hashMcpProvenanceValue({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: ARGS } }));
  assert.equal(verifyMcpReceipt(receipt).ok, true);
  assert.equal(verifyMcpReceipt({ ...receipt, mcp_session_transcript_hash: hashMcpProvenanceValue({ forged: true }) }).ok, false);
});

test('W983 #2 legacy v2 provenance receipts remain accepted without transcript fields', () => {
  const signer = makeSigner();
  const built = buildMcpReceipt({
    schema: MCP_PROVENANCE_RECEIPT_SCHEMA,
    tenant: TENANT,
    tool: TOOL,
    args: ARGS,
    result: RESULT,
    now: NOW,
    caller: { subject_id: 'user_v2' },
    upstream_provenance: { request_id: 1, response: { jsonrpc: '2.0', id: 1, result: RESULT } },
  });
  const receipt = signMcpReceipt(built, signer, { signed_at: built.timestamp });
  assert.equal(receipt.schema, MCP_PROVENANCE_RECEIPT_SCHEMA);
  assert.equal('mcp_session_transcript_hash' in receipt, false);
  assert.equal(verifyMcpReceipt(receipt).ok, true);
});

test('W983 #3 live upstream execution chains initialize, initialized, tools/list, and tools/call', async () => {
  const signer = makeSigner();
  const seen = [];
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [TOOL], tenants: [TENANT] }],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ method: body.method, headers: init.headers, body });
      if (body.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'crm', version: '1.0.0' } },
        }, 200, { 'MCP-Session-Id': 'upstream-session-123' });
      }
      if (body.method === 'notifications/initialized') return jsonResponse(null, 202);
      if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [TOOL_DESCRIPTOR] } });
      if (body.method === 'tools/call') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: RESULT });
      throw new Error(`unexpected method ${body.method}`);
    },
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, {
    authMiddleware: async (_req, _res, next) => { await next(); },
    getSigner: () => signer,
    execute: registry.execute,
  });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    tenantRecord: { id: TENANT, user_id: 'user_live', mcp_session_id: 'host_session_live' },
    body: { tool: TOOL, server_id: 'crm', transport: 'streamable_http', arguments: ARGS, now: NOW },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.deepEqual(seen.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(seen[1].headers['mcp-session-id'], 'upstream-session-123');
  assert.equal(seen[2].headers['mcp-session-id'], 'upstream-session-123');
  assert.equal(seen[3].headers['mcp-session-id'], 'upstream-session-123');
  const result = disp.payload.result_passthrough_contract.result;
  assert.equal(Object.prototype.propertyIsEnumerable.call(result, '__kolm_mcp_upstream_provenance'), false);
  const provenance = getMcpUpstreamProvenance(result);
  assert.equal(provenance.mcp_session_transcript_step_count, 7);

  const receipt = disp.payload.receipt;
  assert.equal(receipt.schema, MCP_RECEIPT_SCHEMA);
  assert.equal(receipt.upstream_request_id, '1');
  assert.equal(receipt.upstream_request_hash, receipt.mcp_tool_call_request_hash);
  assert.equal(receipt.upstream_response_hash, receipt.mcp_tool_call_response_hash);
  assert.equal(receipt.mcp_upstream_session_hash, hashMcpProvenanceValue('upstream-session-123'));
  assert.equal(receipt.mcp_session_transcript_step_count, 7);
  assert.equal(receipt.mcp_protocol_version, MCP_LATEST_PROTOCOL_VERSION);
  assert.equal(verifyMcpReceipt(receipt).ok, true);
});

test('W983 #4 precomputed route dispatch can submit verifier-facing transcript evidence', async () => {
  const signer = makeSigner();
  const transcript = sampleTranscript();
  const router = makeRouterStub();
  registerMcpRoutes(router, { getSigner: () => signer });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    tenantRecord: { id: TENANT, user_id: 'user_route', mcp_session_id: 'host_session_route' },
    body: { tool: TOOL, arguments: ARGS, result: RESULT, now: NOW, mcp_session_transcript: transcript },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(disp.payload.receipt.mcp_session_transcript_hash, hashMcpSessionTranscript(transcript));
  assert.equal(disp.payload.receipt.mcp_tools_snapshot_hash, hashMcpToolsSnapshot({ result: { tools: [TOOL_DESCRIPTOR] } }));
  assert.equal(verifyMcpReceipt(disp.payload.receipt).ok, true);
});

test('W983 #5 in-toto export registry carries v3 session transcript fields', () => {
  const signer = makeSigner();
  const transcript = sampleTranscript();
  const built = buildMcpReceipt({
    tenant: TENANT,
    tool: TOOL,
    args: ARGS,
    result: RESULT,
    now: NOW,
    caller: { subject_id: 'user_export', mcp_session_id: 'host_session_export' },
    mcp_session_transcript: transcript,
  });
  const receipt = signMcpReceipt(built, signer, { signed_at: built.timestamp });
  const stmt = toInTotoStatement(receipt);

  assert.ok(listReceiptClasses().includes('mcp-tool-call-3'));
  assert.equal(getReceiptDescriptor('mcp-tool-call-3').idField, 'call_id');
  assert.equal(stmt.predicate.tool_call.mcp_session_transcript_hash, receipt.mcp_session_transcript_hash);
  assert.equal(stmt.predicate.tool_call.mcp_tools_snapshot_hash, receipt.mcp_tools_snapshot_hash);
  assert.equal(stmt.predicate.tool_call.mcp_tool_call_response_hash, receipt.mcp_tool_call_response_hash);
});
