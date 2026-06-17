// W921 BET-4 — governed MCP tool-gateway with SIGNED tool-call receipts.
//
// Every MCP tools/call invocation gets an Ed25519-signed receipt binding
// {tool name, args_hash, result_hash, tenant, ts} so compliance can PROVE which
// tool did what. These tests pin: the receipt covers name+args_hash+result_hash;
// sign->verify; a tamper on args OR result is detected; canonical determinism;
// the result-passthrough contract; and the dispatch/verify route round-trip
// (incl. the tenant fence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  wrapToolCall,
  buildMcpReceipt,
  signMcpReceipt,
  verifyMcpReceipt,
  hashMcpArgs,
  hashMcpResult,
  mcpToolCallId,
  canonicalMcpReceipt,
  MCP_RECEIPT_SCHEMA,
  MCP_SIGNED_FIELDS,
} from '../src/mcp-gateway.js';
import { register as registerMcpRoutes } from '../src/mcp-gateway-routes.js';

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

const NOW = 1748476800000; // fixed clock -> deterministic timestamp
const TENANT = 'tenant_abc123';
const TOOL = 'get_weather';
const ARGS = { location: 'New York', units: 'metric' };
// MCP CallToolResult shape (latest checked spec 2025-11-25 server/tools).
const RESULT = {
  content: [{ type: 'text', text: 'Current weather in New York: 22C, partly cloudy' }],
  structuredContent: { temperature: 22, conditions: 'partly cloudy' },
  isError: false,
};

// ───────────────────────────────────────────────────────────────────────────
// CORE: receipt content + signing
// ───────────────────────────────────────────────────────────────────────────

test('#1 receipt covers name + args_hash + result_hash + tenant + ts', () => {
  const signer = makeSigner();
  const receipt = signMcpReceipt(
    buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW, call_id: 'mtc_TESTFIXEDID0000000000000A' }),
    signer,
  );
  assert.equal(receipt.schema, MCP_RECEIPT_SCHEMA);
  assert.equal(receipt.tool, TOOL);
  assert.equal(receipt.tenant_id, TENANT);
  assert.equal(receipt.args_hash, hashMcpArgs(ARGS));
  assert.equal(receipt.result_hash, hashMcpResult(RESULT));
  assert.equal(receipt.is_error, false);
  assert.equal(receipt.timestamp, new Date(NOW).toISOString());
  assert.match(receipt.args_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.result_hash, /^sha256:[0-9a-f]{64}$/);
  // every signed field is present on the receipt
  for (const f of MCP_SIGNED_FIELDS) assert.ok(f in receipt, `missing signed field ${f}`);
});

test('#2 sign -> verify round-trips ok with the matching public key', () => {
  const signer = makeSigner();
  const receipt = signMcpReceipt(
    buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW }),
    signer,
  );
  assert.ok(receipt.signature_ed25519, 'signature block attached');
  assert.equal(receipt.signature_ed25519.alg, 'ed25519');
  const v = verifyMcpReceipt(receipt);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.key_fingerprint, signer.key_fingerprint);
});

test('#3 tamper on ARGS hash is detected (signature fails)', () => {
  const signer = makeSigner();
  const receipt = signMcpReceipt(
    buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW }),
    signer,
  );
  assert.equal(verifyMcpReceipt(receipt).ok, true);
  // attacker swaps the args hash (e.g. claims different inputs ran)
  const tampered = { ...receipt, args_hash: hashMcpArgs({ location: 'Atlantis' }) };
  const v = verifyMcpReceipt(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reason, /signature does not verify/i);
});

test('#4 tamper on RESULT hash is detected (silent substitution caught)', () => {
  const signer = makeSigner();
  const receipt = signMcpReceipt(
    buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW }),
    signer,
  );
  // attacker rewrites the result the tool "produced"
  const tampered = {
    ...receipt,
    result_hash: hashMcpResult({ content: [{ type: 'text', text: 'forged answer' }], isError: false }),
  };
  const v = verifyMcpReceipt(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reason, /signature does not verify/i);
});

test('#5 tamper on tenant / tool / is_error is detected', () => {
  const signer = makeSigner();
  const base = signMcpReceipt(
    buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW }),
    signer,
  );
  assert.equal(verifyMcpReceipt({ ...base, tenant_id: 'tenant_evil' }).ok, false, 'tenant tamper');
  assert.equal(verifyMcpReceipt({ ...base, tool: 'delete_everything' }).ok, false, 'tool tamper');
  assert.equal(verifyMcpReceipt({ ...base, is_error: true }).ok, false, 'is_error tamper');
  assert.equal(verifyMcpReceipt({ ...base, timestamp: new Date(NOW + 1).toISOString() }).ok, false, 'ts tamper');
});

test('#6 a swapped public key whose fingerprint no longer matches is rejected', () => {
  const signer = makeSigner();
  const other = makeSigner();
  const receipt = signMcpReceipt(
    buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW }),
    signer,
  );
  // attacker substitutes a different public key but keeps the fingerprint claim
  const tampered = {
    ...receipt,
    signature_ed25519: { ...receipt.signature_ed25519, public_key: other.publicKey },
  };
  const v = verifyMcpReceipt(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reason, /fingerprint|verify/i);
});

// ───────────────────────────────────────────────────────────────────────────
// CANONICAL DETERMINISM
// ───────────────────────────────────────────────────────────────────────────

test('#7 args hash is order-independent (canonical determinism)', () => {
  const a = hashMcpArgs({ location: 'NYC', units: 'metric' });
  const b = hashMcpArgs({ units: 'metric', location: 'NYC' });
  assert.equal(a, b, 'key order must not change the args hash');
  const c = hashMcpArgs({ location: 'NYC', units: 'imperial' });
  assert.notEqual(a, c, 'value change must change the args hash');
});

test('#8 result hash is order-independent + binds structuredContent + isError', () => {
  const r1 = hashMcpResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1, b: 2 }, isError: false });
  const r2 = hashMcpResult({ isError: false, structuredContent: { b: 2, a: 1 }, content: [{ type: 'text', text: 'x' }] });
  assert.equal(r1, r2, 'key order across the whole result must not change the hash');
  // structuredContent change is bound
  assert.notEqual(r1, hashMcpResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 9, b: 2 }, isError: false }));
  // isError flip is bound
  assert.notEqual(r1, hashMcpResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1, b: 2 }, isError: true }));
});

test('#9 canonicalMcpReceipt is deterministic + excludes the signature block', () => {
  const r = buildMcpReceipt({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, now: NOW, call_id: 'mtc_FIXED00000000000000000000A' });
  const c1 = canonicalMcpReceipt(r);
  const c2 = canonicalMcpReceipt({ ...r, extra_unsigned: 'ignored', signature_ed25519: { foo: 'bar' } });
  assert.equal(c1, c2, 'canonical must only cover signed fields, in a stable order');
  assert.ok(!c1.includes('signature_ed25519'), 'signature must not be in the signed payload');
  // signing the same inputs twice with the same signer + signed_at yields the
  // SAME signature bytes (Ed25519 is deterministic; payload is deterministic).
  const signer = makeSigner();
  const s1 = signMcpReceipt(r, signer, { signed_at: r.timestamp });
  const s2 = signMcpReceipt(r, signer, { signed_at: r.timestamp });
  assert.equal(s1.signature_ed25519.signature, s2.signature_ed25519.signature, 'deterministic signature');
});

// ───────────────────────────────────────────────────────────────────────────
// wrapToolCall: passthrough contract + executor
// ───────────────────────────────────────────────────────────────────────────

test('#10 wrapToolCall returns the UNMODIFIED result + a verifying receipt', async () => {
  const signer = makeSigner();
  const out = await wrapToolCall({ tool: TOOL, tenant: TENANT, args: ARGS, result: RESULT, signer, now: NOW });
  // passthrough: the exact bytes the tool produced
  assert.deepEqual(out.result_passthrough_contract.result, RESULT);
  assert.equal(out.result_passthrough_contract.unaltered, true);
  assert.equal(out.result_passthrough_contract.bound_by, 'result_hash');
  // the contract's hash is exactly what the receipt signs
  assert.equal(out.result_passthrough_contract.result_hash, out.receipt.result_hash);
  assert.equal(out.result_passthrough_contract.args_hash, out.receipt.args_hash);
  assert.equal(verifyMcpReceipt(out.receipt).ok, true);
});

test('#11 wrapToolCall invokes the injected executor when no result is supplied', async () => {
  const signer = makeSigner();
  let seen = null;
  const out = await wrapToolCall({
    tool: TOOL, tenant: TENANT, args: ARGS, signer, now: NOW,
    execute: async ({ tool, args }) => { seen = { tool, args }; return RESULT; },
  });
  assert.deepEqual(seen, { tool: TOOL, args: ARGS }, 'executor received tool + args');
  assert.equal(out.result_passthrough_contract.result_hash, hashMcpResult(RESULT));
  assert.equal(verifyMcpReceipt(out.receipt).ok, true);
});

test('#12 wrapToolCall propagates isError from a tool execution error result', async () => {
  const signer = makeSigner();
  const errResult = { content: [{ type: 'text', text: 'rate limited' }], isError: true };
  const out = await wrapToolCall({ tool: TOOL, tenant: TENANT, args: ARGS, result: errResult, signer, now: NOW });
  assert.equal(out.receipt.is_error, true);
  assert.equal(verifyMcpReceipt(out.receipt).ok, true);
});

test('#13 buildMcpReceipt requires tool + tenant', () => {
  assert.throws(() => buildMcpReceipt({ tenant: TENANT }), /tool .* required/i);
  assert.throws(() => buildMcpReceipt({ tool: TOOL }), /tenant is required/i);
});

test('#14 mcpToolCallId is well-formed + accepts an injected clock prefix', () => {
  const id = mcpToolCallId(NOW);
  assert.match(id, /^mtc_[0-9A-Z]{26}$/);
  // ids minted from the same clock differ in the random tail
  assert.notEqual(mcpToolCallId(NOW), mcpToolCallId(NOW));
});

// ───────────────────────────────────────────────────────────────────────────
// ROUTES: dispatch -> verify round-trip + tenant fence
// ───────────────────────────────────────────────────────────────────────────

// Minimal express-ish router stub: records handlers, lets us invoke them.
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
      let statusCode = 200; let payload;
      const res = {
        status(c) { statusCode = c; return this; },
        json(p) { payload = p; return this; },
      };
      // run the chain (auth middleware then handler)
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

test('#15 routes: POST /v1/mcp/dispatch signs + GET /v1/mcp/verify/:id round-trips', async () => {
  const signer = makeSigner();
  const router = makeRouterStub();
  registerMcpRoutes(router, { getSigner: () => signer });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT,
    body: { tool: TOOL, arguments: ARGS, result: RESULT, transport: 'http', now: NOW },
  });
  assert.equal(disp.statusCode, 201, JSON.stringify(disp.payload));
  assert.equal(disp.payload.ok, true);
  const receipt = disp.payload.receipt;
  assert.equal(receipt.tool, TOOL);
  assert.equal(receipt.tenant_id, TENANT);
  assert.equal(receipt.transport, 'http');
  assert.equal(disp.payload.result_passthrough_contract.result_hash, receipt.result_hash);
  assert.equal(verifyMcpReceipt(receipt).ok, true);

  // verify by id (same tenant)
  const ver = await router.invoke('get', '/v1/mcp/verify/:id', { tenant: TENANT, params: { id: receipt.call_id } });
  assert.equal(ver.statusCode, 200, JSON.stringify(ver.payload));
  assert.equal(ver.payload.verify.ok, true);
  assert.equal(ver.payload.receipt.result_hash, receipt.result_hash);
});

test('#16 routes: tenant fence — another tenant cannot verify the receipt', async () => {
  const signer = makeSigner();
  const router = makeRouterStub();
  registerMcpRoutes(router, { getSigner: () => signer });

  const disp = await router.invoke('post', '/v1/mcp/dispatch', {
    tenant: TENANT, body: { tool: TOOL, arguments: ARGS, result: RESULT, now: NOW },
  });
  const callId = disp.payload.receipt.call_id;

  const ver = await router.invoke('get', '/v1/mcp/verify/:id', { tenant: 'tenant_other', params: { id: callId } });
  assert.equal(ver.statusCode, 404, 'cross-tenant verify must 404');
  assert.equal(ver.payload.ok, false);
});

test('#17 routes: dispatch requires auth + a tool name', async () => {
  const signer = makeSigner();
  const router = makeRouterStub();
  // Inject a PROD-accurate auth middleware that does NOT stamp a tenant for an
  // unauthenticated request (the no-deps fallback gate intentionally stamps an
  // 'anonymous' tenant for local-daemon/tests; the prod gate rejects).
  const authMiddleware = (req, _res, next) => { next(); };
  registerMcpRoutes(router, { getSigner: () => signer, authMiddleware });

  const noAuth = await router.invoke('post', '/v1/mcp/dispatch', { tenant: null, body: { tool: TOOL } });
  assert.equal(noAuth.statusCode, 401, 'unauthenticated dispatch must 401');
  assert.equal(noAuth.payload.error, 'auth_required');

  const noTool = await router.invoke('post', '/v1/mcp/dispatch', { tenant: TENANT, body: { arguments: ARGS } });
  assert.equal(noTool.statusCode, 400);
  assert.equal(noTool.payload.error, 'tool_required');
});

test('#18 routes: verify rejects a malformed call id', async () => {
  const signer = makeSigner();
  const router = makeRouterStub();
  registerMcpRoutes(router, { getSigner: () => signer });
  const ver = await router.invoke('get', '/v1/mcp/verify/:id', { tenant: TENANT, params: { id: 'not-an-id' } });
  assert.equal(ver.statusCode, 400);
  assert.equal(ver.payload.error, 'invalid_call_id');
});

test('#19 routes: executor runs when dispatch body has no result', async () => {
  const signer = makeSigner();
  const router = makeRouterStub();
  let executed = false;
  registerMcpRoutes(router, {
    getSigner: () => signer,
    execute: async ({ tool }) => { executed = true; return { content: [{ type: 'text', text: `ran ${tool}` }], isError: false }; },
  });
  const disp = await router.invoke('post', '/v1/mcp/dispatch', { tenant: TENANT, body: { tool: TOOL, arguments: ARGS, now: NOW } });
  assert.equal(disp.statusCode, 201);
  assert.equal(executed, true, 'executor must run when no precomputed result');
  assert.equal(verifyMcpReceipt(disp.payload.receipt).ok, true);
});
