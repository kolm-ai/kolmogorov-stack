// Wave 609: production-wire MCP signed receipts.
//
// W921 built the MCP receipt route module, but router.js mounted it with only
// authMiddleware. These checks pin the production dependencies: durable store,
// default signer, and Merkle anchor batcher/stamp-back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import { verifyMcpReceipt } from '../src/mcp-gateway.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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
    async invoke(method, routePath, { tenant, body, params } = {}) {
      const handlers = routes[method][routePath];
      assert.ok(handlers, `no handler for ${method} ${routePath}`);
      const req = {
        tenant_record: tenant ? { id: tenant } : null,
        tenant,
        body: body || {},
        params: params || {},
        query: {},
        headers: {},
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
        if (!h) return;
        await h(req, res, next);
      };
      await next();
      return { statusCode, payload };
    },
  };
}

test('1. router mounts MCP and in-toto receipt routes with prod store/signer/anchor deps', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  assert.match(src, /startBatcher as __startReceiptAnchorBatcher_w609/);
  assert.match(src, /const __w609ReceiptStore = \{ all, find, findByTenant, insert, update, backendInfo: storeBackendInfo \}/);
  assert.match(src, /const __w609GetReceiptSigner = \(\) =>/);
  assert.match(src, /__startReceiptAnchorBatcher_w609\(\{/);
  assert.match(src, /update\('mcp_tool_receipts'/);
  assert.match(src, /makeMcpUpstreamExecutorFromEnv as __makeMcpUpstreamExecutor_w641/);
  assert.match(src, /const __w641McpUpstream = \(\(\) =>/);
  assert.match(src, /__registerIntotoReceiptRoutes_w921\(r, \{ authMiddleware, store: __w609ReceiptStore, getSigner: __w609GetReceiptSigner \}\)/);
  assert.match(src, /__registerMcpGatewayRoutes_w921\(r, \{/);
  assert.match(src, /anchorBatcher: __w609McpAnchorBatcher/);
  assert.match(src, /execute: __w641McpUpstream\.execute/);
  assert.match(src, /toolContractFor: __w641McpUpstream\.toolContractFor/);
});

test('1b. backend spec records W609/W640/W641 closures and leaves remaining policy gaps open', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');
  assert.match(spec, /CLOSED W609: wire MCP gateway to durable store \+ signer in prod/);
  assert.match(spec, /CLOSED W609: anchor MCP receipts into the existing Merkle transparency log/);
  assert.match(spec, /CLOSED W640: let the in-toto route resolve mcp_tool_receipts by call_id/i);
  assert.match(spec, /CLOSED W641: wire a production upstream MCP executor\/registry/i);
  assert.doesNotMatch(spec, /\[major\] No production upstream MCP client registry\/executor/);
  assert.doesNotMatch(spec, /\(surgical-now, S\/low, v7\) \*\*Let the in-toto route resolve mcp_tool_receipts by call_id/);
});

test('2. MCP route verify survives a fresh route instance when backed by store', async () => {
  const signer = makeSigner();
  const rows = [];
  const store = {
    insert(table, row) {
      assert.equal(table, 'mcp_tool_receipts');
      rows.push(row);
      return row;
    },
    findByTenant(table, tenant) {
      assert.equal(table, 'mcp_tool_receipts');
      return rows.filter((r) => r && (r.tenant === tenant || r.tenant_id === tenant));
    },
  };

  const router1 = makeRouterStub();
  registerMcpRoutes(router1, { getSigner: () => signer, store });
  const disp = await router1.invoke('post', '/v1/mcp/dispatch', {
    tenant: 'tenant_w609',
    body: {
      tool: 'lookup',
      arguments: { q: 'status' },
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
      now: 1748476800000,
    },
  });
  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(rows.length, 1, 'dispatch must write one durable receipt row');

  const router2 = makeRouterStub();
  registerMcpRoutes(router2, { getSigner: () => signer, store });
  const ver = await router2.invoke('get', '/v1/mcp/verify/:id', {
    tenant: 'tenant_w609',
    params: { id: disp.payload.receipt.call_id },
  });
  assert.equal(ver.statusCode, 200, JSON.stringify(ver.payload));
  assert.equal(ver.payload.verify.ok, true);
  assert.equal(ver.payload.receipt.call_id, disp.payload.receipt.call_id);
});

test('3. stored anchor proof is returned as a non-signed additive receipt field', async () => {
  const signer = makeSigner();
  const rows = [];
  const store = {
    insert(_table, row) { rows.push(row); return row; },
    findByTenant(_table, tenant) {
      return rows.filter((r) => r && (r.tenant === tenant || r.tenant_id === tenant));
    },
  };

  const router = makeRouterStub();
  registerMcpRoutes(router, { getSigner: () => signer, store });
  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: 'tenant_w609_anchor',
    body: {
      tool: 'lookup',
      arguments: { q: 'anchor' },
      result: { content: [{ type: 'text', text: 'anchored' }], isError: false },
      now: 1748476800000,
    },
  });
  const receipt = disp.payload.receipt;
  rows[0].anchor = {
    version: 'w921-anchor-v1',
    batch_id: 'batch_test',
    leaf_index: 0,
    tree_size: 1,
    audit_path: [],
    batch_root: '0'.repeat(64),
    state: 'local',
    checkpoint: null,
    rekor: null,
    stamped_at: '2026-06-17T00:00:00.000Z',
  };

  const ver = await router.invoke('get', '/v1/mcp/verify/:id', {
    tenant: 'tenant_w609_anchor',
    params: { id: receipt.call_id },
  });
  assert.equal(ver.statusCode, 200, JSON.stringify(ver.payload));
  assert.deepEqual(ver.payload.receipt.anchor, rows[0].anchor);
  assert.equal(verifyMcpReceipt(ver.payload.receipt).ok, true, 'anchor is outside signed MCP fields');
});
