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
//   execute - optional ({tool,args,tenant,server_id,transport}) -> CallToolResult. When a
//                    dispatch body carries no precomputed `result`, this invokes
//                    the registered MCP server. Without it (and without a body
//                    result) the dispatch records an empty result.
//   policy - optional ({tenant,tool,server_id,args,caller}) -> {allow,reason}.
//                    Evaluated before guardrails, upstream execution, signing,
//                    anchoring, or persistence. Deny returns 403 and mints no
//                    receipt.

import {
  wrapToolCall,
  verifyMcpReceipt,
  MCP_RECEIPT_SCHEMA,
  MCP_GATEWAY_VERSION,
} from './mcp-gateway.js';
import { anchorLeafHash } from './transparency-anchor.js';

export const MCP_GATEWAY_ROUTES_VERSION = 'w983-mcp-gateway-routes-v4';
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

function _upstreamErrorStatus(code) {
  if (code === 'mcp_upstream_tool_not_registered') return 404;
  if (code === 'mcp_upstream_bad_tool_name' || code === 'mcp_upstream_ambiguous_tool') return 400;
  if (code === 'mcp_upstream_timeout') return 504;
  if (typeof code === 'string' && code.startsWith('mcp_upstream_')) return 502;
  return null;
}

function _headerValue(req, name) {
  const headers = req && req.headers && typeof req.headers === 'object' ? req.headers : {};
  const want = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== want) continue;
    if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && x) || null;
    return typeof v === 'string' && v ? v : null;
  }
  return null;
}

function _callerPolicyContext(req) {
  const tr = req && req.tenant_record && typeof req.tenant_record === 'object' ? req.tenant_record : {};
  const auth = req && req.auth && typeof req.auth === 'object' ? req.auth : {};
  const scopes = Array.isArray(auth.scopes) ? auth.scopes
    : (Array.isArray(tr.scopes) ? tr.scopes : []);
  return {
    subject_id: tr.user_id || tr.owner_id || auth.subject_id || auth.user_id || auth.sub || null,
    api_key_id: tr.api_key_id || auth.api_key_id || null,
    agent_id: tr.mcp_agent_id || tr.agent_id || auth.mcp_agent_id || auth.agent_id || auth.client_id || req?.mcp_agent_id || req?.agent_id || null,
    mcp_session_id: tr.mcp_session_id || tr.session_id || auth.mcp_session_id || auth.session_id || req?.mcp_session_id || _headerValue(req, 'mcp-session-id') || _headerValue(req, 'x-mcp-session-id') || null,
    trust_level: tr.mcp_trust_level || tr.trust_level || auth.mcp_trust_level || auth.trust_level || req?.mcp_trust_level || null,
    scopes: scopes.map((s) => String(s)).slice(0, 64),
  };
}

function _safePolicyDecision(v) {
  if (v == null) {
    return {
      ok: true,
      allow: true,
      action: 'allow',
      reason: 'no policy decision',
      policy_id: null,
      rule_id: null,
      caller_trust_level: null,
      required_trust_level: null,
      version: MCP_GATEWAY_ROUTES_VERSION,
    };
  }
  if (typeof v === 'boolean') {
    return {
      ok: true,
      allow: v,
      action: v ? 'allow' : 'deny',
      reason: v ? 'policy allowed' : 'policy denied',
      policy_id: null,
      rule_id: null,
      caller_trust_level: null,
      required_trust_level: null,
      version: MCP_GATEWAY_ROUTES_VERSION,
    };
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const allow = o.ok === false ? false : (o.allow !== false && o.action !== 'deny' && o.effect !== 'deny');
  const s = (x, max = 256) => (typeof x === 'string' && x ? x.slice(0, max) : null);
  return {
    ok: o.ok !== false,
    allow,
    action: allow ? 'allow' : 'deny',
    reason: s(o.reason, 512) || (allow ? 'policy allowed' : 'policy denied'),
    policy_id: s(o.policy_id || o.policyId, 128),
    rule_id: s(o.rule_id || o.ruleId, 128),
    tool: s(o.tool, 128),
    server_id: s(o.server_id || o.serverId, 128),
    caller_trust_level: s(o.caller_trust_level || o.callerTrustLevel, 64),
    required_trust_level: s(o.required_trust_level || o.requiredTrustLevel, 64),
    version: s(o.version, 128) || MCP_GATEWAY_ROUTES_VERSION,
  };
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
            tool_contract_hash: receipt.tool_contract_hash || null,
            tool_contract_source: receipt.tool_contract_source || null,
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
          if (!row || !row.receipt) return null;
          if (row.anchor && !row.receipt.anchor) return { ...row.receipt, anchor: row.anchor };
          return row.receipt;
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

  // OPTIONAL Merkle anchoring batcher (off the hot path). When injected, each
  // signed receipt's canonical leaf is enqueued for batch anchoring; absent it,
  // dispatch behaves exactly as before (anchor_enqueued:false).
  const anchorBatcher = (deps.anchorBatcher && typeof deps.anchorBatcher.enqueue === 'function')
    ? deps.anchorBatcher : null;

  // OPTIONAL per-tenant guardrail config resolver. guardrailFor(tenant) -> a
  // guardrail config ({mode, threshold, ...}) or null. Absent it, no screening.
  const guardrailFor = typeof deps.guardrailFor === 'function' ? deps.guardrailFor : null;

  // OPTIONAL per-tool policy gate. policy(input) -> {allow, reason, ...}.
  // Deny is fail-closed before upstream execution and before a receipt exists.
  const policy = typeof deps.policy === 'function' ? deps.policy : null;

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
    const server_id = body.server_id != null ? String(body.server_id) : null;
    const transport = body.transport != null ? String(body.transport) : null;

    const caller = _callerPolicyContext(req);
    let policyDecision = null;
    if (policy) {
      try {
        policyDecision = _safePolicyDecision(await policy({
          tenant,
          tool,
          server_id,
          transport,
          args,
          caller,
          caller_trust_level: caller.trust_level,
          req,
        }));
      } catch (e) {
        return res.status(503).json({
          ok: false,
          error: 'mcp_tool_policy_unavailable',
          detail: String((e && e.message) || e).slice(0, 512),
          version: MCP_GATEWAY_ROUTES_VERSION,
        });
      }
      if (!policyDecision.allow) {
        return res.status(403).json({
          ok: false,
          error: 'mcp_tool_policy_denied',
          policy: policyDecision,
          version: MCP_GATEWAY_ROUTES_VERSION,
        });
      }
    }

    // Resolve the per-tenant guardrail config (opt-in). A thrown resolver must
    // never take down dispatch - degrade to no screening.
    let guardrail = null;
    if (guardrailFor) {
      try { guardrail = guardrailFor(tenant) || null; } catch { guardrail = null; }
    }

    try {
      let toolContract = null;
      let toolContractSource = 'unregistered';
      if (typeof deps.toolContractFor === 'function') {
        const resolved = deps.toolContractFor({ tool, tenant, server_id });
        if (resolved && typeof resolved === 'object') {
          toolContract = resolved;
          toolContractSource = 'registry';
        }
      }
      if (!toolContract && body.tool_contract && typeof body.tool_contract === 'object' && !Array.isArray(body.tool_contract)) {
        toolContract = body.tool_contract;
        toolContractSource = 'client_supplied';
      }
      const expectedToolContractHash = body.expected_tool_contract_hash || body.expectedToolContractHash || null;

      const out = await wrapToolCall({
        tool,
        tenant,
        args,
        tool_contract: toolContract,
        tool_contract_source: toolContractSource,
        expected_tool_contract_hash: expectedToolContractHash,
        // precomputed result if the caller already invoked the tool; else the
        // injected executor runs it. `undefined` (not present) triggers execute.
        result: ('result' in body) ? body.result : undefined,
        execute: typeof deps.execute === 'function' ? deps.execute : undefined,
        signer: getSigner() || undefined,
        now: (typeof body.now === 'number' || typeof body.now === 'string') ? body.now : undefined,
        call_id: body.call_id ? String(body.call_id) : undefined,
        transport,
        server_id,
        guardrail,
        caller,
        upstream_request_id: body.upstream_request_id || body.upstreamRequestId || null,
        upstream_request_hash: body.upstream_request_hash || body.upstreamRequestHash || null,
        upstream_response_hash: body.upstream_response_hash || body.upstreamResponseHash || null,
        mcp_session_transcript: body.mcp_session_transcript || body.session_transcript || body.mcpSessionTranscript || null,
        mcp_protocol_version: body.mcp_protocol_version || body.mcpProtocolVersion || null,
        mcp_upstream_session_id: body.mcp_upstream_session_id || body.mcpUpstreamSessionId || null,
        mcp_upstream_session_hash: body.mcp_upstream_session_hash || body.mcpUpstreamSessionHash || null,
        mcp_session_transcript_hash: body.mcp_session_transcript_hash || body.mcpSessionTranscriptHash || null,
        mcp_session_transcript_step_count: body.mcp_session_transcript_step_count || body.mcpSessionTranscriptStepCount || null,
        mcp_initialize_request_hash: body.mcp_initialize_request_hash || body.mcpInitializeRequestHash || null,
        mcp_initialize_response_hash: body.mcp_initialize_response_hash || body.mcpInitializeResponseHash || null,
        mcp_initialized_notification_hash: body.mcp_initialized_notification_hash || body.mcpInitializedNotificationHash || null,
        mcp_tools_list_request_hash: body.mcp_tools_list_request_hash || body.mcpToolsListRequestHash || null,
        mcp_tools_list_response_hash: body.mcp_tools_list_response_hash || body.mcpToolsListResponseHash || null,
        mcp_tools_snapshot_hash: body.mcp_tools_snapshot_hash || body.mcpToolsSnapshotHash || null,
        mcp_tool_call_request_hash: body.mcp_tool_call_request_hash || body.mcpToolCallRequestHash || null,
        mcp_tool_call_response_hash: body.mcp_tool_call_response_hash || body.mcpToolCallResponseHash || null,
      });

      if (policyDecision) out.receipt.policy = policyDecision;

      // Persist the signed receipt so GET /v1/mcp/verify/:id can return it.
      const persisted = persist.save(tenant, out.receipt);

      // Off the hot path: enqueue the canonical receipt leaf for Merkle batch
      // anchoring. enqueue() is bounded + non-blocking + never throws.
      let anchor_enqueued = false;
      if (anchorBatcher) {
        try {
          anchor_enqueued = anchorBatcher.enqueue({
            receipt_id: out.receipt.call_id,
            leaf: anchorLeafHash(out.receipt),
            receipt: out.receipt,
          }) === true;
        } catch { anchor_enqueued = false; }
      }

      return res.status(201).json({
        ok: true,
        receipt: out.receipt,
        result_passthrough_contract: out.result_passthrough_contract,
        guardrail: out.guardrail,
        policy: policyDecision,
        anchor_enqueued,
        verify_url: `/v1/mcp/verify/${out.receipt.call_id}`,
        persisted,
        version: MCP_GATEWAY_ROUTES_VERSION,
      });
    } catch (e) {
      // A guardrail block is a 400 (the caller sent a poisoned input/output),
      // not a server error. Surface the stage so the caller knows which side.
      if (e && e.code === 'mcp_guardrail_blocked') {
        return res.status(400).json({
          ok: false,
          error: 'mcp_guardrail_blocked',
          stage: e.stage || null,
          verdict: e.verdict || null,
          version: MCP_GATEWAY_ROUTES_VERSION,
        });
      }
      if (e && e.code === 'mcp_tool_contract_hash_mismatch') {
        return res.status(409).json({
          ok: false,
          error: 'mcp_tool_contract_hash_mismatch',
          expected_tool_contract_hash: e.expected_tool_contract_hash || null,
          actual_tool_contract_hash: e.actual_tool_contract_hash || null,
          version: MCP_GATEWAY_ROUTES_VERSION,
        });
      }
      const upstreamStatus = _upstreamErrorStatus(e && e.code);
      const code = upstreamStatus || ((e && e.code === 'mcp_no_signer') ? 503 : 500);
      return res.status(code).json({
        ok: false,
        error: (e && e.code) || 'mcp_dispatch_error',
        detail: String((e && e.message) || e),
        ...(upstreamStatus ? { upstream: true } : {}),
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
