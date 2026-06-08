// src/mcp-gateway-routes.js
//
// W921 BET-4 - HTTP routes for the governed MCP tool-gateway.
//
// Exports register(r, deps) so the orchestrator mounts the whole surface with
// ONE call (import + register) and does NOT edit src/router.js's body. Mirrors
// the modular-mount convention used by src/govern-routes.js / src/ab-routes.js.
//
// Routes:
//   POST /v1/mcp/dispatch - govern one MCP tools/call: sign + return a
//                               receipt binding {tool, args_hash, result_hash,
//                               tenant, ts}. Returns the UNMODIFIED tool result
//                               (passthrough contract) alongside the receipt.
//   GET  /v1/mcp/verify/:id - fetch a previously-dispatched receipt for THIS
//                               tenant + a deterministic Ed25519 verify result.
//
// Tenant fence: tenant_id is forced from req.tenant_record.id and NEVER read
// from body/query. A receipt minted under one tenant is invisible to another
// (the verify route filters on req.tenant_record.id).
//
// deps (all injectable seams so the routes unit-test without a live stack):
//   authMiddleware - real middleware from src/auth.js. Falls back to a stamp-
//                    only gate that sets req.tenant_record={id:'anonymous'} for
//                    local-daemon/tests (never sufficient for prod).
//   getSigner - () -> {privateKey,publicKey,key_fingerprint}. FALLBACK:
//                    mcp-gateway.signMcpReceipt calls loadOrCreateDefaultSigner.
//   store - { insert(table,row), findByTenant(table,tenant) } from
//                    src/store.js. FALLBACK: a process-local Map so dispatch +
//                    verify round-trip works in tests with no DB.
//   execute - optional ({tool,args,tenant}) -> CallToolResult. When a
//                    dispatch body carries no precomputed `result`, this invokes
//                    the registered MCP server. Without it (and without a body
//                    result) the dispatch records an empty result.

import {
  wrapToolCall,
  verifyMcpReceipt,
  MCP_RECEIPT_SCHEMA,
  MCP_GATEWAY_VERSION,
} from './mcp-gateway.js';

export const MCP_GATEWAY_ROUTES_VERSION = 'w921-mcp-gateway-routes-v1';
const MCP_RECEIPT_TABLE = 'mcp_tool_receipts';

function _tenantIdOf(req) {
  if (req && req.tenant_record && req.tenant_record.id) return String(req.tenant_record.id);
  if (req && req.tenant_id) return String(req.tenant_id);
  if (req && req.tenant) return String(req.tenant);
  return null;
}

function _safeBody(req) {
  const b = req && req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  return {};
}

function _denyUnauth(res) {
  return res.status(401).json({
    ok: false,
    error: 'auth_required',
    hint: '/v1/mcp/* requires a kolm tenant API key (Authorization: Bearer ks_...)',
    version: MCP_GATEWAY_ROUTES_VERSION,
  });
}

// Build the persistence seam. Prefers an injected store; otherwise a process-
// local Map keyed by `${tenant}::${call_id}` so dispatch->verify round-trips in
// tests without a database. The Map is intentionally scoped to this module
// instance (NOT global) so concurrent test files don't cross-contaminate.
function _makePersistence(deps) {
  if (deps.store && typeof deps.store.insert === 'function' && typeof deps.store.findByTenant === 'function') {
    return {
      save(tenant, receipt) {
        try {
          deps.store.insert(MCP_RECEIPT_TABLE, {
            id: receipt.call_id,
            call_id: receipt.call_id,
            tenant_id: tenant,
            tenant,
            tool: receipt.tool,
            receipt,
            at: receipt.timestamp,
          });
          return true;
        } catch { return false; }
      },
      load(tenant, callId) {
        try {
          const rows = deps.store.findByTenant(MCP_RECEIPT_TABLE, tenant) || [];
          const row = rows.find((x) => x && (x.call_id === callId || x.id === callId));
          return row && row.receipt ? row.receipt : null;
        } catch { return null; }
      },
    };
  }
  const mem = new Map();
  return {
    save(tenant, receipt) {
      mem.set(`${tenant}::${receipt.call_id}`, receipt);
      return true;
    },
    load(tenant, callId) {
      return mem.get(`${tenant}::${callId}`) || null;
    },
  };
}

/**
 * register(r, deps) - single-line modular mount.
 */
export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('mcp-gateway-routes.register: router with get/post required');
  }

  const auth = (typeof deps.authMiddleware === 'function')
    ? deps.authMiddleware
    : (req, _res, next) => {
      if (!req.tenant_record && !req.tenant) req.tenant_record = { id: 'anonymous' };
      next();
    };

  const getSigner = typeof deps.getSigner === 'function'
    ? deps.getSigner
    : () => (deps.signer || null);

  const persist = _makePersistence(deps);

  // ── POST /v1/mcp/dispatch ──────────────────────────────────────────────────
  // Body: {
  //   tool: string (REQUIRED),         // MCP tools/call params.name
  //   arguments|args: object,          // MCP tools/call params.arguments
  //   result?: CallToolResult,         // precomputed result (else `execute` runs)
  //   transport?: 'stdio'|'http'|'sse',
  //   server_id?: string,              // MCP server registry id
  //   call_id?: string,                // pin for a reproducible id
  //   now?: number|string              // injected clock (tests / determinism)
  // }
  r.post('/v1/mcp/dispatch', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);

    const body = _safeBody(req);
    const tool = body.tool != null ? String(body.tool) : null;
    if (!tool) {
      return res.status(400).json({
        ok: false, error: 'tool_required',
        hint: 'POST {"tool":"<mcp tool name>","arguments":{...}}',
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    }
    // MCP wire uses params.arguments; accept `args` as an alias for ergonomics.
    const args = (body.arguments != null) ? body.arguments
      : (body.args != null ? body.args : {});

    try {
      const out = await wrapToolCall({
        tool,
        tenant,
        args,
        // precomputed result if the caller already invoked the tool; else the
        // injected executor runs it. `undefined` (not present) triggers execute.
        result: ('result' in body) ? body.result : undefined,
        execute: typeof deps.execute === 'function' ? deps.execute : undefined,
        signer: getSigner() || undefined,
        now: (typeof body.now === 'number' || typeof body.now === 'string') ? body.now : undefined,
        call_id: body.call_id ? String(body.call_id) : undefined,
        transport: body.transport != null ? String(body.transport) : null,
        server_id: body.server_id != null ? String(body.server_id) : null,
      });

      // Persist the signed receipt so GET /v1/mcp/verify/:id can return it.
      const persisted = persist.save(tenant, out.receipt);

      return res.status(201).json({
        ok: true,
        receipt: out.receipt,
        result_passthrough_contract: out.result_passthrough_contract,
        verify_url: `/v1/mcp/verify/${out.receipt.call_id}`,
        persisted,
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    } catch (e) {
      const code = (e && e.code === 'mcp_no_signer') ? 503 : 500;
      return res.status(code).json({
        ok: false,
        error: (e && e.code) || 'mcp_dispatch_error',
        detail: String((e && e.message) || e),
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    }
  });

  // ── GET /v1/mcp/verify/:id ─────────────────────────────────────────────────
  // Tenant-fenced: only returns a receipt minted under THIS tenant. The verify
  // result is deterministic (recompute canonical + Ed25519 check; no network).
  r.get('/v1/mcp/verify/:id', auth, (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);

    const id = String((req.params && req.params.id) || '');
    if (!/^mtc_[0-9A-Z]{20,}$/.test(id)) {
      return res.status(400).json({
        ok: false, error: 'invalid_call_id',
        hint: 'MCP tool-call ids look like mtc_<26 base32 chars>',
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    }

    const receipt = persist.load(tenant, id);
    if (!receipt) {
      return res.status(404).json({
        ok: false, error: 'receipt_not_found', call_id: id,
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    }
    // Defense-in-depth: never serve a receipt whose tenant_id doesn't match the
    // caller, even if a store mis-keyed it.
    if (receipt.tenant_id && receipt.tenant_id !== tenant) {
      return res.status(404).json({
        ok: false, error: 'receipt_not_found', call_id: id,
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    }

    const verify = verifyMcpReceipt(receipt);
    return res.status(200).json({
      ok: true,
      schema: MCP_RECEIPT_SCHEMA,
      call_id: id,
      receipt,
      verify,
      version: MCP_GATEWAY_ROUTES_VERSION,
    });
  });

  return r;
}

export default register;
