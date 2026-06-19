// W641 - production upstream MCP executor registry.
//
// Pins the env-backed registry and route wiring that lets /v1/mcp/dispatch
// invoke a configured upstream MCP tools/call server when the request body does
// not carry a precomputed result.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import { verifyMcpReceipt, hashMcpResult } from '../src/mcp-gateway.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';
import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_UPSTREAM_REGISTRY_VERSION,
  makeMcpUpstreamRegistry,
  mcpUpstreamsFromEnv,
  parseMcpUpstreams,
} from '../src/mcp-upstream-registry.js';

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

const TENANT = 'tenant_w641';
const TOOL = 'crm.lookup';
const ARGS = { customer_id: 'c_123' };
const RESULT = {
  content: [{ type: 'text', text: 'Customer c_123 is active' }],
  structuredContent: { customer_id: 'c_123', state: 'active' },
  isError: false,
};

const passAuth = async (_req, _res, next) => { await next(); };

test('W641 #1 parseMcpUpstreams keeps explicit tool and tenant allow-lists', () => {
  const rows = parseMcpUpstreams(JSON.stringify({
    servers: [
      {
        id: 'crm',
        url: 'https://mcp.example.test/rpc',
        tools: [TOOL, 'bad tool with spaces'],
        tenants: [TENANT],
        headers_env: { 'x-api-key': 'CRM_KEY' },
        timeout_ms: 1234,
      },
    ],
  }), { CRM_KEY: 'sekret' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'crm');
  assert.deepEqual(rows[0].tools, [TOOL]);
  assert.deepEqual(rows[0].tenants, [TENANT]);
  assert.equal(rows[0].headers['x-api-key'], 'sekret');
  assert.equal(rows[0].timeout_ms, 1234);
});

test('W641 #2 env shorthand builds a configured upstream registry', () => {
  const rows = mcpUpstreamsFromEnv({
    KOLM_MCP_UPSTREAM_URL: 'https://mcp.example.test/rpc',
    KOLM_MCP_UPSTREAM_TOOLS: `${TOOL},weather.get`,
    KOLM_MCP_UPSTREAM_SERVER_ID: 'default-crm',
    KOLM_MCP_UPSTREAM_TOKEN: 'tok_123',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'default-crm');
  assert.ok(rows[0].tools.includes(TOOL));
  assert.equal(rows[0].headers.authorization, 'Bearer tok_123');
});

test('W641 #3 registry executes MCP tools/call JSON-RPC with protocol header', async () => {
  let seen = null;
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [TOOL], tenants: [TENANT], session_transcript: false }],
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: RESULT });
    },
  });

  assert.equal(registry.version, MCP_UPSTREAM_REGISTRY_VERSION);
  assert.equal(registry.configured, true);
  const out = await registry.execute({ tool: TOOL, args: ARGS, tenant: TENANT, server_id: 'crm' });
  assert.deepEqual(out, RESULT);
  assert.equal(seen.url, 'https://mcp.example.test/rpc');
  assert.equal(seen.body.method, 'tools/call');
  assert.deepEqual(seen.body.params, { name: TOOL, arguments: ARGS });
  assert.equal(seen.init.headers['mcp-protocol-version'], MCP_LATEST_PROTOCOL_VERSION);
});

test('W641 #4 dispatch signs the actual upstream result when no precomputed result is supplied', async () => {
  const signer = makeSigner();
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [TOOL], tenants: [TENANT], session_transcript: false }],
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: RESULT }),
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, { authMiddleware: passAuth, getSigner: () => signer, execute: registry.execute });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, server_id: 'crm', transport: 'http', arguments: ARGS, now: 1748476800000 },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(disp.payload.receipt.server_id, 'crm');
  assert.equal(disp.payload.receipt.transport, 'http');
  assert.equal(disp.payload.result_passthrough_contract.result_hash, hashMcpResult(RESULT));
  assert.deepEqual(disp.payload.result_passthrough_contract.result, RESULT);
  assert.equal(verifyMcpReceipt(disp.payload.receipt).ok, true);
});

test('W641 #5 upstream JSON-RPC errors become signed tool execution errors', async () => {
  const signer = makeSigner();
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: [TOOL], session_transcript: false }],
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad customer id' } }),
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, { authMiddleware: passAuth, getSigner: () => signer, execute: registry.execute });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, server_id: 'crm', arguments: ARGS, now: 1748476800000 },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(disp.payload.receipt.is_error, true);
  assert.equal(disp.payload.result_passthrough_contract.result.isError, true);
  assert.equal(disp.payload.result_passthrough_contract.result.structuredContent.jsonrpc_error.code, -32602);
  assert.equal(verifyMcpReceipt(disp.payload.receipt).ok, true);
});

test('W641 #6 missing upstream tool returns an explicit route error', async () => {
  const signer = makeSigner();
  const registry = makeMcpUpstreamRegistry({
    servers: [{ id: 'crm', url: 'https://mcp.example.test/rpc', tools: ['crm.other'], session_transcript: false }],
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: RESULT }),
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, { authMiddleware: passAuth, getSigner: () => signer, execute: registry.execute });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, arguments: ARGS },
  });

  assert.equal(disp.statusCode, 404);
  assert.equal(disp.payload.error, 'mcp_upstream_tool_not_registered');
  assert.equal(disp.payload.upstream, true);
});

test('W641 #7 precomputed results still bypass the upstream executor', async () => {
  const signer = makeSigner();
  let called = false;
  const router = makeRouterStub();
  registerMcpRoutes(router, {
    authMiddleware: passAuth,
    getSigner: () => signer,
    execute: async () => { called = true; return RESULT; },
  });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, arguments: ARGS, result: RESULT, now: 1748476800000 },
  });

  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(called, false);
  assert.equal(verifyMcpReceipt(disp.payload.receipt).ok, true);
});
