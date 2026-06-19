// W982 - MCP caller/session/upstream provenance binding.
//
// W981 closed policy authorization. This wave moves the remaining MCP trail gap
// into signed evidence: W982 receipts introduced mcp-tool-call-2 and bind
// privacy-safe actor/session hashes plus upstream JSON-RPC envelope digests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  MCP_LEGACY_RECEIPT_SCHEMA,
  MCP_RECEIPT_SCHEMA,
  MCP_SIGNED_FIELDS_V1,
  buildMcpReceipt,
  hashMcpProvenanceValue,
  signMcpReceipt,
  verifyMcpReceipt,
} from '../src/mcp-gateway.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';
import { makeMcpUpstreamRegistry } from '../src/mcp-upstream-registry.js';
import { toInTotoStatement } from '../src/intoto-receipt.js';
import { getReceiptDescriptor, listReceiptClasses } from '../src/receipt-export-registry.js';

const NOW = 1748476800000;
const TENANT = 'tenant_w982';
const TOOL = 'crm.lookup';
const ARGS = { customer_id: 'c_123' };
const RESULT = {
  content: [{ type: 'text', text: 'Customer c_123 is active' }],
  structuredContent: { customer_id: 'c_123', state: 'active' },
  isError: false,
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

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('W982 #1 mcp-tool-call-2 signs caller, session, and upstream provenance', () => {
  const signer = makeSigner();
  const requestEnvelope = { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: TOOL, arguments: ARGS } };
  const responseEnvelope = { jsonrpc: '2.0', id: 77, result: RESULT };
  const built = buildMcpReceipt({
    tenant: TENANT,
    tool: TOOL,
    args: ARGS,
    result: RESULT,
    now: NOW,
    call_id: 'mtc_W982SIGNED000000000000A',
    transport: 'http',
    server_id: 'crm',
    caller: {
      subject_id: 'user_123',
      api_key_id: 'key_456',
      agent_id: 'agent_789',
      mcp_session_id: 'sess_abc',
      trust_level: 'trusted',
      scopes: ['tool:crm.lookup', 'mcp:dispatch'],
    },
    upstream_provenance: {
      request_id: requestEnvelope.id,
      request: requestEnvelope,
      response: responseEnvelope,
    },
  });
  const receipt = signMcpReceipt(built, signer, { signed_at: built.timestamp });

  assert.equal(receipt.schema, MCP_RECEIPT_SCHEMA);
  assert.equal(receipt.caller_subject_hash, hashMcpProvenanceValue('user_123'));
  assert.equal(receipt.caller_api_key_hash, hashMcpProvenanceValue('key_456'));
  assert.equal(receipt.caller_agent_hash, hashMcpProvenanceValue('agent_789'));
  assert.equal(receipt.mcp_session_hash, hashMcpProvenanceValue('sess_abc'));
  assert.equal(receipt.caller_trust_level, 'trusted');
  assert.equal(receipt.caller_scopes_hash, hashMcpProvenanceValue(['mcp:dispatch', 'tool:crm.lookup']));
  assert.equal(receipt.upstream_request_id, '77');
  assert.equal(receipt.upstream_request_hash, hashMcpProvenanceValue(requestEnvelope));
  assert.equal(receipt.upstream_response_hash, hashMcpProvenanceValue(responseEnvelope));
  assert.equal(verifyMcpReceipt(receipt).ok, true);

  assert.equal(verifyMcpReceipt({ ...receipt, caller_subject_hash: hashMcpProvenanceValue('user_evil') }).ok, false);
  assert.equal(verifyMcpReceipt({ ...receipt, mcp_session_hash: hashMcpProvenanceValue('sess_evil') }).ok, false);
  assert.equal(verifyMcpReceipt({ ...receipt, upstream_response_hash: hashMcpProvenanceValue({ forged: true }) }).ok, false);
});

test('W982 #2 legacy mcp-tool-call-1 receipts still verify under the v1 signed-field set', () => {
  const signer = makeSigner();
  const built = buildMcpReceipt({
    schema: MCP_LEGACY_RECEIPT_SCHEMA,
    tenant: TENANT,
    tool: TOOL,
    args: ARGS,
    result: RESULT,
    now: NOW,
  });
  const receipt = signMcpReceipt(built, signer, { signed_at: built.timestamp });
  assert.equal(receipt.schema, MCP_LEGACY_RECEIPT_SCHEMA);
  assert.equal('caller_subject_hash' in receipt, false);
  assert.equal(verifyMcpReceipt(receipt).ok, true);
  for (const field of MCP_SIGNED_FIELDS_V1) assert.ok(field in receipt, `missing legacy signed field ${field}`);
});

test('W982 #3 route stamps authenticated caller and MCP session hashes into the signed receipt', async () => {
  const signer = makeSigner();
  const upstreamResponseHash = hashMcpProvenanceValue({ jsonrpc: '2.0', id: 'precomputed', result: RESULT });
  const router = makeRouterStub();
  registerMcpRoutes(router, { getSigner: () => signer });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    tenantRecord: {
      id: TENANT,
      user_id: 'user_route',
      api_key_id: 'key_route',
      mcp_agent_id: 'agent_route',
      mcp_trust_level: 'trusted',
      scopes: ['tool:crm.lookup'],
    },
    headers: { 'MCP-Session-ID': 'sess_route' },
    body: {
      tool: TOOL,
      arguments: ARGS,
      result: RESULT,
      now: NOW,
      upstream_request_id: 'precomputed',
      upstream_response_hash: upstreamResponseHash,
    },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  const receipt = disp.payload.receipt;
  assert.equal(receipt.schema, MCP_RECEIPT_SCHEMA);
  assert.equal(receipt.caller_subject_hash, hashMcpProvenanceValue('user_route'));
  assert.equal(receipt.caller_api_key_hash, hashMcpProvenanceValue('key_route'));
  assert.equal(receipt.caller_agent_hash, hashMcpProvenanceValue('agent_route'));
  assert.equal(receipt.mcp_session_hash, hashMcpProvenanceValue('sess_route'));
  assert.equal(receipt.caller_trust_level, 'trusted');
  assert.equal(receipt.caller_scopes_hash, hashMcpProvenanceValue(['tool:crm.lookup']));
  assert.equal(receipt.upstream_request_id, 'precomputed');
  assert.equal(receipt.upstream_response_hash, upstreamResponseHash);
  assert.equal(verifyMcpReceipt(receipt).ok, true);
  assert.equal(verifyMcpReceipt({ ...receipt, caller_agent_hash: hashMcpProvenanceValue('agent_evil') }).ok, false);
});

test('W982 #4 live upstream JSON-RPC request and response envelopes are signed by dispatch', async () => {
  const signer = makeSigner();
  let seenRequest = null;
  const responseEnvelope = { jsonrpc: '2.0', id: 1, result: RESULT };
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [TOOL], tenants: [TENANT], session_transcript: false }],
    fetchImpl: async (_url, init) => {
      seenRequest = JSON.parse(init.body);
      return jsonResponse(responseEnvelope);
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
    tenantRecord: { id: TENANT, user_id: 'user_live', mcp_session_id: 'sess_live' },
    body: { tool: TOOL, server_id: 'crm', arguments: ARGS, now: NOW },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.deepEqual(disp.payload.result_passthrough_contract.result, RESULT);
  assert.equal(Object.prototype.propertyIsEnumerable.call(disp.payload.result_passthrough_contract.result, '__kolm_mcp_upstream_provenance'), false);
  const receipt = disp.payload.receipt;
  assert.equal(receipt.upstream_request_id, '1');
  assert.equal(receipt.upstream_request_hash, hashMcpProvenanceValue(seenRequest));
  assert.equal(receipt.upstream_response_hash, hashMcpProvenanceValue(responseEnvelope));
  assert.equal(verifyMcpReceipt(receipt).ok, true);
});

test('W982 #5 in-toto export registry carries mcp-tool-call-2 provenance fields', () => {
  const signer = makeSigner();
  const built = buildMcpReceipt({
    tenant: TENANT,
    tool: TOOL,
    args: ARGS,
    result: RESULT,
    now: NOW,
    caller: { subject_id: 'user_export', agent_id: 'agent_export', mcp_session_id: 'sess_export' },
    upstream_provenance: { request_id: '1', response: { jsonrpc: '2.0', id: 1, result: RESULT } },
  });
  const receipt = signMcpReceipt(built, signer, { signed_at: built.timestamp });
  const stmt = toInTotoStatement(receipt);

  assert.ok(listReceiptClasses().includes('mcp-tool-call-2'));
  assert.equal(getReceiptDescriptor('mcp-tool-call-2').idField, 'call_id');
  assert.equal(stmt.predicate.tool_call.caller_subject_hash, receipt.caller_subject_hash);
  assert.equal(stmt.predicate.tool_call.caller_agent_hash, receipt.caller_agent_hash);
  assert.equal(stmt.predicate.tool_call.mcp_session_hash, receipt.mcp_session_hash);
  assert.equal(stmt.predicate.tool_call.upstream_response_hash, receipt.upstream_response_hash);
});
