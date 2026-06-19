// W981 - MCP per-tool policy gate.
//
// The MCP receipt path already signs tool calls, pins descriptors, and screens
// prompt injection. This wave adds the enterprise gateway control that must run
// before tool execution: per-tool allow/deny and trust-level policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import { verifyMcpReceipt } from '../src/mcp-gateway.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';
import {
  MCP_TOOL_POLICY_VERSION,
  evaluateMcpToolPolicy,
  makeMcpToolPolicy,
  mcpToolPolicyFromEnv,
  normalizeMcpToolPolicy,
} from '../src/mcp-tool-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TENANT = 'tenant_w981';
const TOOL = 'crm.lookup';
const RESULT = { content: [{ type: 'text', text: 'ok' }], isError: false };

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
    async invoke(method, routePath, { tenant, tenantRecord, body, params } = {}) {
      const handlers = routes[method][routePath];
      assert.ok(handlers, `no handler for ${method} ${routePath}`);
      const req = {
        tenant_record: tenantRecord || (tenant ? { id: tenant } : null),
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
        if (h) await h(req, res, next);
      };
      await next();
      return { statusCode, payload };
    },
  };
}

test('W981 #1 policy normalization keeps deny precedence, wildcard tools, and default deny', () => {
  const policy = normalizeMcpToolPolicy({
    id: 'tenant-crm',
    default_action: 'deny',
    rules: [
      { id: 'allow-crm-read', effect: 'allow', tools: ['crm.*'], tenants: [TENANT], servers: ['crm'], min_trust_level: 'trusted' },
      { id: 'deny-crm-delete', effect: 'deny', tools: ['crm.delete'], reason: 'dangerous write' },
    ],
  });
  assert.equal(policy.version, MCP_TOOL_POLICY_VERSION);
  assert.equal(policy.default_action, 'deny');
  assert.equal(policy.rules.length, 2);

  const low = evaluateMcpToolPolicy(policy, { tenant: TENANT, tool: TOOL, server_id: 'crm', caller_trust_level: 'low' });
  assert.equal(low.allow, false);
  assert.equal(low.required_trust_level, 'trusted');

  const allowed = evaluateMcpToolPolicy(policy, { tenant: TENANT, tool: TOOL, server_id: 'crm', caller_trust_level: 'trusted' });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.rule_id, 'allow-crm-read');

  const denied = evaluateMcpToolPolicy(policy, { tenant: TENANT, tool: 'crm.delete', server_id: 'crm', caller_trust_level: 'admin' });
  assert.equal(denied.allow, false);
  assert.equal(denied.rule_id, 'deny-crm-delete');

  const defaultClosed = evaluateMcpToolPolicy({
    rules: [{ id: 'allow-crm-only', effect: 'allow', tools: ['crm.*'] }],
  }, { tenant: TENANT, tool: 'finance.lookup', caller_trust_level: 'admin' });
  assert.equal(defaultClosed.allow, false, 'base allow rules must imply default deny');
});

test('W981 #2 env shorthand builds allow/deny policy without exposing secrets', () => {
  const p = mcpToolPolicyFromEnv({
    KOLM_MCP_TOOL_ALLOWLIST: 'crm.lookup,weather.*',
    KOLM_MCP_TOOL_DENYLIST: 'crm.delete',
    KOLM_MCP_TOOL_MIN_TRUST_LEVEL: 'medium',
  });
  assert.equal(p.configured, true);
  const crm = p.evaluate({ tenant: TENANT, tool: TOOL, caller_trust_level: 'medium' });
  assert.equal(crm.allow, true);
  const missingTrust = p.evaluate({ tenant: TENANT, tool: 'weather.get', caller_trust_level: 'low' });
  assert.equal(missingTrust.allow, false);
  assert.equal(missingTrust.required_trust_level, 'medium');
  const deleteDenied = p.evaluate({ tenant: TENANT, tool: 'crm.delete', caller_trust_level: 'admin' });
  assert.equal(deleteDenied.allow, false);

  const jsonAliases = mcpToolPolicyFromEnv({
    KOLM_MCP_TOOL_POLICY_JSON: JSON.stringify({ allowlist: ['ops.*'], minTrustLevel: 'trusted' }),
  });
  assert.equal(jsonAliases.evaluate({ tenant: TENANT, tool: 'ops.read', caller_trust_level: 'trusted' }).allow, true);
  assert.equal(jsonAliases.evaluate({ tenant: TENANT, tool: 'crm.lookup', caller_trust_level: 'trusted' }).allow, false);

  const invalid = mcpToolPolicyFromEnv({ KOLM_MCP_TOOL_POLICY_JSON: '{' });
  const invalidDecision = invalid.evaluate({ tenant: TENANT, tool: TOOL, caller_trust_level: 'root' });
  assert.equal(invalidDecision.allow, false);
  assert.equal(invalidDecision.rule_id, 'invalid_policy_json');
});

test('W981 #3 route denies before upstream execution, signing, persistence, or anchoring', async () => {
  const signer = makeSigner();
  let called = false;
  let persisted = false;
  let anchored = false;
  const policy = makeMcpToolPolicy({
    rules: [{ id: 'deny-crm', effect: 'deny', tools: [TOOL], reason: 'tenant not approved for CRM' }],
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, {
    getSigner: () => signer,
    policy: policy.evaluate,
    execute: async () => { called = true; return RESULT; },
    store: { insert: () => { persisted = true; }, findByTenant: () => [] },
    anchorBatcher: { enqueue: () => { anchored = true; return true; } },
  });

  const denied = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, arguments: { customer_id: 'c_123' } },
  });
  assert.equal(denied.statusCode, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.error, 'mcp_tool_policy_denied');
  assert.equal(denied.payload.policy.rule_id, 'deny-crm');
  assert.equal(called, false, 'deny must happen before upstream execution');
  assert.equal(persisted, false, 'deny must not mint/persist a receipt');
  assert.equal(anchored, false, 'deny must not enqueue transparency evidence');
});

test('W981 #4 allowed dispatch stamps policy as non-signed receipt metadata', async () => {
  const signer = makeSigner();
  const rows = [];
  const policy = makeMcpToolPolicy({
    default_action: 'deny',
    rules: [{ id: 'allow-crm-read', effect: 'allow', tools: [TOOL], tenants: [TENANT], min_trust_level: 'trusted' }],
  });
  const router = makeRouterStub();
  registerMcpRoutes(router, {
    getSigner: () => signer,
    policy: policy.evaluate,
    store: {
      insert(_table, row) { rows.push(row); return row; },
      findByTenant(_table, tenant) { return rows.filter((r) => r.tenant_id === tenant || r.tenant === tenant); },
    },
  });

  const ok = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    tenantRecord: { id: TENANT, mcp_trust_level: 'trusted' },
    body: { tool: TOOL, arguments: { customer_id: 'c_123' }, result: RESULT, now: 1748476800000 },
  });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
  assert.equal(ok.payload.policy.allow, true);
  assert.equal(ok.payload.receipt.policy.rule_id, 'allow-crm-read');
  assert.equal(verifyMcpReceipt(ok.payload.receipt).ok, true, 'policy is non-signed additive metadata');

  const ver = await router.invoke('get', '/v1/mcp/verify/:id', {
    tenant: TENANT,
    params: { id: ok.payload.receipt.call_id },
  });
  assert.equal(ver.statusCode, 200, JSON.stringify(ver.payload));
  assert.equal(ver.payload.receipt.policy.rule_id, 'allow-crm-read');
  assert.equal(ver.payload.verify.ok, true);
});

test('W981 #5 route treats not-ok policy decisions as fail-closed denial', async () => {
  const signer = makeSigner();
  let called = false;
  const router = makeRouterStub();
  registerMcpRoutes(router, {
    getSigner: () => signer,
    policy: () => ({ ok: false, reason: 'policy backend unhealthy' }),
    execute: async () => { called = true; return RESULT; },
  });

  const denied = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, arguments: { customer_id: 'c_123' } },
  });
  assert.equal(denied.statusCode, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.policy.ok, false);
  assert.equal(denied.payload.policy.allow, false);
  assert.equal(called, false);
});

test('W981 #6 router production wiring loads env-backed MCP tool policy', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  assert.match(src, /mcpToolPolicyFromEnv as __mcpToolPolicyFromEnv_w981/);
  assert.match(src, /const __w981McpToolPolicy = \(\(\) =>/);
  assert.match(src, /policy: __w981McpToolPolicy\.evaluate/);
});
