// W966 - MCP tool contract pinning.
//
// Signed MCP call receipts already bind tool name, args, result, tenant, and
// time. This wave binds the advertised tool descriptor too, so a tool
// description/inputSchema rug pull is detectable before execution and auditable
// after the call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  hashMcpToolContract,
  normalizeMcpToolContract,
  verifyMcpReceipt,
  verifyMcpToolContract,
  wrapToolCall,
} from '../src/mcp-gateway.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';
import { makeMcpUpstreamRegistry } from '../src/mcp-upstream-registry.js';

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
    async invoke(method, path, { tenant, body, params } = {}) {
      const handlers = routes[method][path];
      assert.ok(handlers, `no handler for ${method} ${path}`);
      const req = { tenant_record: tenant ? { id: tenant } : null, body: body || {}, params: params || {}, query: {}, headers: {} };
      let statusCode = 200;
      let payload;
      const res = { status(c) { statusCode = c; return this; }, json(p) { payload = p; return this; } };
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

const NOW = 1748476800000;
const TENANT = 'tenant_w966';
const TOOL = 'crm.lookup';
const ARGS = { customer_id: 'c_123' };
const RESULT = {
  content: [{ type: 'text', text: 'Customer c_123 is active' }],
  structuredContent: { customer_id: 'c_123', state: 'active' },
  isError: false,
};
const CONTRACT = Object.freeze({
  name: TOOL,
  title: 'CRM Lookup',
  description: 'Read-only lookup of one CRM customer by id.',
  inputSchema: {
    type: 'object',
    properties: { customer_id: { type: 'string' } },
    required: ['customer_id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { customer_id: { type: 'string' }, state: { type: 'string' } },
    required: ['customer_id', 'state'],
  },
  annotations: { readOnlyHint: true },
});

test('W966 #1 tool contract hashes are canonical and descriptor-sensitive', () => {
  const a = hashMcpToolContract(CONTRACT);
  const b = hashMcpToolContract({
    annotations: { readOnlyHint: true },
    outputSchema: CONTRACT.outputSchema,
    inputSchema: {
      required: ['customer_id'],
      additionalProperties: false,
      properties: { customer_id: { type: 'string' } },
      type: 'object',
    },
    description: CONTRACT.description,
    title: CONTRACT.title,
    name: TOOL,
  });
  assert.equal(a, b, 'key order must not change the descriptor hash');
  assert.notEqual(a, hashMcpToolContract({ ...CONTRACT, description: 'Writes CRM customer state.' }));
  assert.deepEqual(normalizeMcpToolContract(CONTRACT).inputSchema, CONTRACT.inputSchema);
});

test('W966 #2 signed receipts bind the tool contract hash and source', async () => {
  const signer = makeSigner();
  const out = await wrapToolCall({
    tool: TOOL,
    tenant: TENANT,
    args: ARGS,
    result: RESULT,
    signer,
    now: NOW,
    tool_contract: CONTRACT,
    tool_contract_source: 'registry',
  });

  assert.equal(out.receipt.tool_contract_hash, hashMcpToolContract(CONTRACT));
  assert.equal(out.receipt.tool_contract_source, 'registry');
  assert.deepEqual(out.receipt.tool_contract, normalizeMcpToolContract(CONTRACT));
  assert.equal(verifyMcpReceipt(out.receipt).ok, true);
  assert.equal(verifyMcpToolContract(out.receipt).ok, true);

  assert.equal(verifyMcpReceipt({ ...out.receipt, tool_contract_hash: 'sha256:' + '0'.repeat(64) }).ok, false);
  assert.equal(verifyMcpReceipt({ ...out.receipt, tool_contract_source: 'client_supplied' }).ok, false);
  assert.equal(
    verifyMcpToolContract({ ...out.receipt, tool_contract: { ...out.receipt.tool_contract, description: 'poisoned' } }).ok,
    false,
  );
});

test('W966 #3 expected tool contract mismatches fail before tool execution', async () => {
  const signer = makeSigner();
  let ran = false;
  await assert.rejects(
    () => wrapToolCall({
      tool: TOOL,
      tenant: TENANT,
      args: ARGS,
      signer,
      now: NOW,
      tool_contract: CONTRACT,
      expected_tool_contract_hash: 'sha256:' + '0'.repeat(64),
      execute: async () => { ran = true; return RESULT; },
    }),
    (e) => {
      assert.equal(e.code, 'mcp_tool_contract_hash_mismatch');
      return true;
    },
  );
  assert.equal(ran, false, 'a descriptor rug-pull mismatch must not spend a tool call');
});

test('W966 #4 upstream registry descriptors are signed by the dispatch route', async () => {
  const signer = makeSigner();
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [CONTRACT], tenants: [TENANT], session_transcript: false }],
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: RESULT }),
  });
  assert.deepEqual(registry.toolContractFor({ tool: TOOL, tenant: TENANT, server_id: 'crm' }), normalizeMcpToolContract(CONTRACT));

  const router = makeRouterStub();
  registerMcpRoutes(router, {
    authMiddleware: async (_req, _res, next) => { await next(); },
    getSigner: () => signer,
    execute: registry.execute,
    toolContractFor: registry.toolContractFor,
  });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, server_id: 'crm', arguments: ARGS, now: NOW },
  });
  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(disp.payload.receipt.tool_contract_source, 'registry');
  assert.equal(disp.payload.receipt.tool_contract_hash, hashMcpToolContract(CONTRACT));
  assert.equal(verifyMcpReceipt(disp.payload.receipt).ok, true);
  assert.equal(verifyMcpToolContract(disp.payload.receipt).ok, true);
});

test('W966 #5 dispatch rejects stale expected contract hashes before upstream execution', async () => {
  const signer = makeSigner();
  let called = false;
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [CONTRACT], tenants: [TENANT], session_transcript: false }],
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: RESULT });
    },
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, {
    authMiddleware: async (_req, _res, next) => { await next(); },
    getSigner: () => signer,
    execute: registry.execute,
    toolContractFor: registry.toolContractFor,
  });

  const stale = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: {
      tool: TOOL,
      server_id: 'crm',
      arguments: ARGS,
      expected_tool_contract_hash: 'sha256:' + 'f'.repeat(64),
    },
  });
  assert.equal(stale.statusCode, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.error, 'mcp_tool_contract_hash_mismatch');
  assert.equal(called, false);
});
