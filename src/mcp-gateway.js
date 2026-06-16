// src/mcp-gateway.js
//
// W921 BET-4 - governed MCP tool-gateway with SIGNED tool-call receipts.
//
// Every MCP `tools/call` invocation that flows through the gateway produces an
// Ed25519-signed receipt binding {tool name, args hash, result hash, tenant,
// timestamp} so a compliance reviewer can later PROVE which tool did what - the
// natural extension of kolm's receipt thesis into the fastest-growing slice of
// the gateway market (Bifrost / Portkey / LiteLLM all gateway tool calls; none
// emit a signed, third-party-checkable tool-call record).
//
// MCP wire shape (web-confirmed against the MCP spec, 2025-06-18 server/tools):
//   tools/call REQUEST  params: { name: string, arguments: object }
//   tools/call RESULT   { content: [{type,...}], structuredContent?: object,
//                         isError?: boolean }
// (Spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
//
// Public surface:
//   - wrapToolCall({tool,args,tenant,now,signer,result?,execute?,...})
//       -> { result_passthrough_contract, receipt }
//     The gateway invokes the underlying tool (or accepts a precomputed
//     `result`) and returns the UNMODIFIED tool result plus a signed receipt.
//     The "passthrough contract" is the guarantee that the bytes returned to
//     the caller are exactly what the tool produced - the receipt binds those
//     exact bytes via their hash so a verifier can confirm no middle layer
//     altered them.
//   - buildMcpReceipt({...}) -> unsigned mcp-tool-call-1 receipt object
//   - signMcpReceipt(receipt, signer) -> receipt with signature_ed25519 tail
//   - verifyMcpReceipt(receipt) -> { ok, key_fingerprint?, reason? }
//   - hashMcpArgs(args) / hashMcpResult(result) -> "sha256:<64-hex>"
//   - mcpToolCallId() -> "mtc_<26-char base32 ULID-ish>"
//
// Design constraints (per the wave directive):
//   * ADDITIVE + opt-in. This module imports - never edits - src/ed25519.js,
//     src/gateway-receipt.js, src/cid.js. It reuses the EXACT canonical-JSON
//     helper (cid.canonicalJson), the Ed25519 signer/verifier, and the
//     receipt-id ULID idiom from gateway-receipt.js (FALLBACK pattern: when no
//     signer is available, fall back to loadOrCreateDefaultSigner, same as the
//     gateway receipt builder).
//   * DETERMINISTIC core. The signed material never reads the wall clock or a
//     global RNG: `now` and `signer` (and the receipt id, when reproducibility
//     is needed) are injected. A fresh random id is only minted when the caller
//     does not pin one, exactly like buildAndSignReceipt.
//   * The result is bound by HASH, not by value - args/results can be large or
//     sensitive; only their sha256 enters the receipt. A tamper on either the
//     args or the result changes its hash and the signature stops verifying.

import crypto from 'node:crypto';
import { canonicalJson } from './cid.js';
import {
  buildSignatureBlock,
  verifySignatureBlock,
  loadOrCreateDefaultSigner,
} from './ed25519.js';
import { applyGuardrail } from './gateway-guardrail.js';

// Flatten an MCP CallToolResult (or arbitrary tool output) to the text the
// guardrail screens for an output-poisoning attempt. Concatenates every text
// content block plus a canonical projection of structuredContent so an
// injection hidden in a structured field is still seen. Never throws.
function _resultScreenText(result) {
  try {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    const parts = [];
    const content = Array.isArray(result) ? result : (Array.isArray(result.content) ? result.content : []);
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
      else if (typeof block === 'string') parts.push(block);
    }
    if (result && typeof result === 'object' && !Array.isArray(result) && result.structuredContent != null) {
      parts.push(canonicalJson(result.structuredContent));
    }
    return parts.join('\n');
  } catch { return ''; }
}

// Normalize the guardrail option into { mode, threshold, categories_block,
// detector } or null when screening is not opted in. A bare string is treated
// as a mode.
function _normalizeGuardrail(g) {
  if (!g) return null;
  if (typeof g === 'string') return { mode: g };
  if (typeof g !== 'object') return null;
  if (g.mode == null && g.enabled == null) return null;
  return {
    mode: g.mode || (g.enabled ? 'detect_only' : 'off'),
    threshold: g.threshold,
    categories_block: g.categories_block || null,
    detector: typeof g.detector === 'function' ? g.detector : null,
  };
}

// A guardrail verdict for one stage (input|output): the applyGuardrail envelope
// projected to the fields the receipt stamps + a `blocked` flag computed for the
// active mode. detect_only/flag never set blocked; block sets it when action is
// 'block'.
function _stageVerdict(text, cfg) {
  const v = applyGuardrail({
    text: typeof text === 'string' ? text : '',
    mode: cfg.mode,
    threshold: cfg.threshold,
    categories_block: cfg.categories_block,
    detector: cfg.detector,
  });
  return {
    mode: v.mode,
    action: v.action,
    blocked: cfg.mode === 'block' && v.action === 'block',
    is_adversarial: !!v.is_adversarial,
    categories: v.categories || [],
    score: typeof v.score === 'number' ? v.score : 0,
    detector: v.detector,
    version: v.version,
  };
}

function _guardrailBlockError(stage, verdict) {
  const e = new Error(`mcp guardrail blocked the ${stage} (score ${verdict.score})`);
  e.code = 'mcp_guardrail_blocked';
  e.stage = stage;
  e.verdict = verdict;
  return e;
}

export const MCP_RECEIPT_SCHEMA = 'mcp-tool-call-1';
export const MCP_GATEWAY_VERSION = 'w921-mcp-gateway-v1';

// Crockford-style base32 (no I, L, O, U) - same alphabet family as
// gateway-receipt.js so receipt ids read consistently across the product.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Fields the signature covers, in CANONICAL ORDER. canonicalForSigning sorts
// keys anyway (via cid.canonicalJson), but listing the contract here documents
// exactly what a verifier is trusting. signature_ed25519 is NEVER in this set - 
// a signature cannot cover itself.
export const MCP_SIGNED_FIELDS = Object.freeze([
  'schema',
  'call_id',
  'timestamp',
  'tenant_id',
  'tool',
  'args_hash',
  'result_hash',
  'is_error',
  'transport',
  'server_id',
]);

function _sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Hash over the CANONICAL JSON encoding so semantically-identical payloads with
// different key order hash identically (determinism), while ANY value change
// flips the digest (tamper-evidence). Reuses cid.canonicalJson by import.
function _hashCanonical(value) {
  // `undefined` canonicalizes to the JS string "undefined" via JSON.stringify;
  // normalize absent payloads to null so the hash is stable + documented.
  const v = value === undefined ? null : value;
  return `sha256:${_sha256Hex(Buffer.from(canonicalJson(v), 'utf8'))}`;
}

/**
 * hashMcpArgs - sha256 over canonical-JSON of the MCP `arguments` object.
 * Determinism: key order does not matter; value changes do.
 */
export function hashMcpArgs(args) {
  return _hashCanonical(args == null ? {} : args);
}

/**
 * hashMcpResult - sha256 over the canonical-JSON of the FULL tool result
 * (content + structuredContent + isError). Binding the whole result - not just
 * the text - means a tamper on any content block, the structured payload, or
 * the error flag is detectable.
 */
export function hashMcpResult(result) {
  return _hashCanonical(_normalizeResult(result));
}

// Normalize an MCP CallToolResult to a stable shape for hashing. Accepts:
//   - a full result object { content, structuredContent?, isError? }
//   - a bare array (treated as `content`)
//   - null/undefined (treated as an empty result)
// Unknown extra keys on the result are preserved so the hash covers them too
// (a verifier wants tamper-evidence over the bytes that were actually returned).
function _normalizeResult(result) {
  if (result == null) return { content: [], isError: false };
  if (Array.isArray(result)) return { content: result, isError: false };
  if (typeof result !== 'object') return { content: [], isError: false, value: result };
  const out = { ...result };
  if (!('content' in out) || !Array.isArray(out.content)) {
    out.content = Array.isArray(out.content) ? out.content : [];
  }
  out.isError = !!out.isError;
  return out;
}

/**
 * mcpToolCallId - fresh id like mtc_01J... . Sortable: the leading 6 bytes are
 * a big-endian millisecond timestamp, the trailing 10 are random. Accepts an
 * optional injected clock so a caller that wants a fully reproducible id can
 * pass `now`; the random tail still uses crypto.randomBytes (an id is metadata,
 * NOT part of any determinism contract a verifier relies on - the signature
 * covers whatever id ends up in the receipt).
 */
export function mcpToolCallId(now) {
  const ts = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  const tsBytes = Buffer.alloc(6);
  tsBytes.writeUIntBE(Math.max(0, ts), 0, 6);
  const rand = crypto.randomBytes(10);
  const body = Buffer.concat([tsBytes, rand]);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    out += ULID_ALPHABET[body[i] >> 3];
    out += ULID_ALPHABET[body[i] & 0x1f];
  }
  return `mtc_${out.slice(0, 26)}`;
}

function _isoFrom(now) {
  if (typeof now === 'string') {
    // accept a pre-rendered ISO string
    const t = Date.parse(now);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  if (Number.isFinite(now)) return new Date(Math.trunc(now)).toISOString();
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  return new Date().toISOString();
}

/**
 * buildMcpReceipt - assemble (but DO NOT sign) an mcp-tool-call-1 receipt.
 *
 * Inputs:
 *   - tool         (string, REQUIRED) - MCP tool name (tools/call params.name)
 *   - tenant       (string, REQUIRED) - tenant id (forced from req.tenant_record
 *                                       by the route; never trusted from body)
 *   - args         (object) - MCP tools/call params.arguments
 *   - result       (object|array|null) - MCP CallToolResult (content/structured/isError)
 *   - args_hash    (string) - override (else derived from args)
 *   - result_hash  (string) - override (else derived from result)
 *   - now          (number|string|Date) - injected clock (determinism)
 *   - call_id      (string) - pin for reproducibility (else minted)
 *   - transport    (string) - 'stdio' | 'http' | 'sse' | null
 *   - server_id    (string|null) - MCP server registry id, if any
 *   - is_error     (bool) - override (else read from result.isError)
 *
 * Returns a plain object with MCP_SIGNED_FIELDS populated. Pure + deterministic
 * given (tool, tenant, args/args_hash, result/result_hash, now, call_id).
 */
export function buildMcpReceipt(opts = {}) {
  const tool = String(opts.tool == null ? '' : opts.tool).slice(0, 256);
  if (!tool) {
    const e = new Error('buildMcpReceipt: tool (MCP tool name) is required');
    e.code = 'mcp_tool_required';
    throw e;
  }
  const tenant = String(opts.tenant == null ? '' : opts.tenant).slice(0, 256);
  if (!tenant) {
    const e = new Error('buildMcpReceipt: tenant is required (tenant-fenced receipt)');
    e.code = 'mcp_tenant_required';
    throw e;
  }

  const args_hash = opts.args_hash || hashMcpArgs(opts.args);
  const result_hash = opts.result_hash || hashMcpResult(opts.result);
  const is_error = typeof opts.is_error === 'boolean'
    ? opts.is_error
    : !!(opts.result && typeof opts.result === 'object' && !Array.isArray(opts.result) && opts.result.isError);

  const transport = opts.transport == null ? null : String(opts.transport).slice(0, 32);
  const server_id = opts.server_id == null ? null : String(opts.server_id).slice(0, 256);

  return {
    schema: MCP_RECEIPT_SCHEMA,
    call_id: opts.call_id ? String(opts.call_id) : mcpToolCallId(typeof opts.now === 'number' ? opts.now : undefined),
    timestamp: _isoFrom(opts.now),
    tenant_id: tenant,
    tool,
    args_hash,
    result_hash,
    is_error,
    transport,
    server_id,
  };
}

// canonicalForSigning - emit ONLY the signed fields, in a deterministic byte
// layout, with signature_ed25519 stripped. Reuses cid.canonicalJson (sorted
// keys) so the bytes match across implementations.
function _canonicalForSigning(receipt) {
  const subset = {};
  for (const k of MCP_SIGNED_FIELDS) {
    if (k in receipt) subset[k] = receipt[k];
  }
  return canonicalJson(subset);
}

export { _canonicalForSigning as canonicalMcpReceipt };

/**
 * signMcpReceipt - attach an Ed25519 signature_ed25519 block.
 *
 * `signer` is an injected {privateKey, publicKey, key_fingerprint}. FALLBACK
 * (matching gateway-receipt.buildAndSignReceipt): when no signer is supplied we
 * call loadOrCreateDefaultSigner() - the same per-machine cached key the rest of
 * the product signs with. Pass `signed_at` (or rely on receipt.timestamp) to
 * keep the signature time deterministic.
 *
 * Returns a NEW object (does not mutate `receipt`) with signature_ed25519 at the
 * tail. Throws only if no signer can be obtained AND none was injected.
 */
export function signMcpReceipt(receipt, signer, opts = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('signMcpReceipt: receipt object required');
  }
  const s = signer || loadOrCreateDefaultSigner();
  if (!s || !s.privateKey || !s.publicKey) {
    const e = new Error('signMcpReceipt: no Ed25519 signer available (set KOLM_ED25519_PRIVATE_KEY or pass a signer)');
    e.code = 'mcp_no_signer';
    throw e;
  }
  const out = { ...receipt };
  delete out.signature_ed25519;
  const canonical = _canonicalForSigning(out);
  out.signature_ed25519 = buildSignatureBlock({
    privateKey: s.privateKey,
    publicKey: s.publicKey,
    key_fingerprint: s.key_fingerprint,
    payloadCanonical: canonical,
    signed_at: opts.signed_at || receipt.timestamp || undefined,
  });
  return out;
}

/**
 * verifyMcpReceipt - recompute canonical over the signed fields and check the
 * attached Ed25519 signature. Pure (no network, no secrets). Returns
 * { ok, key_fingerprint?, reason? }.
 *
 * Detects: a tamper on tool / args_hash / result_hash / tenant_id / timestamp /
 * is_error / transport / server_id (any signed field), a swapped public key
 * whose fingerprint claim no longer matches its bytes, and a missing/garbled
 * signature block - all via verifySignatureBlock in src/ed25519.js.
 */
export function verifyMcpReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, reason: 'receipt missing or not an object' };
  }
  if (receipt.schema !== MCP_RECEIPT_SCHEMA) {
    return { ok: false, reason: `schema must be "${MCP_RECEIPT_SCHEMA}", got ${JSON.stringify(receipt.schema)}` };
  }
  const sigBlock = receipt.signature_ed25519;
  if (!sigBlock) return { ok: false, reason: 'receipt has no signature_ed25519 block' };
  const stripped = { ...receipt };
  delete stripped.signature_ed25519;
  const canonical = _canonicalForSigning(stripped);
  return verifySignatureBlock(sigBlock, canonical);
}

/**
 * wrapToolCall - the gateway entry point. Governs ONE MCP tools/call:
 *   1. resolves the tool result (either a precomputed `result`, or by invoking
 *      the injected `execute({tool,args})` - which may be async),
 *   2. hashes args + result,
 *   3. builds + signs the receipt binding {tool, args_hash, result_hash,
 *      tenant, ts},
 *   4. returns the UNMODIFIED tool result alongside the receipt.
 *
 * Inputs:
 *   - tool      (string, REQUIRED)
 *   - tenant    (string, REQUIRED)
 *   - args      (object) - tools/call params.arguments
 *   - result    (object|array) - precomputed CallToolResult (optional)
 *   - execute   (fn({tool,args}) -> result|Promise) - invoked iff no `result`
 *   - signer    (Ed25519 signer) - injected; FALLBACK to default signer
 *   - now       (number|string|Date) - injected clock (determinism)
 *   - call_id   (string) - pin for reproducible ids
 *   - transport / server_id - provenance metadata (signed)
 *
 * Returns { result_passthrough_contract, receipt } where:
 *   result_passthrough_contract = {
 *     result,            // EXACTLY the bytes the tool produced (unaltered)
 *     unaltered: true,   // the gateway promise: it did not touch the result
 *     bound_by: 'result_hash',
 *     result_hash,       // the hash the receipt signs - recompute to confirm
 *   }
 *
 * This function is async only because `execute` may be async; when a `result`
 * is supplied and the call is sync, it still returns a resolved Promise.
 */
export async function wrapToolCall(opts = {}) {
  const tool = String(opts.tool == null ? '' : opts.tool);
  const tenant = String(opts.tenant == null ? '' : opts.tenant);
  const args = opts.args == null ? {} : opts.args;

  // OPT-IN guardrail screening (mirrors the gateway's applyGuardrail). When no
  // config is supplied the legacy path runs untouched (out.guardrail === null,
  // no guardrail field on the receipt).
  const guardrailCfg = _normalizeGuardrail(opts.guardrail);

  // INPUT screen (over the tool arguments) - runs BEFORE the tool executes so a
  // 'block' verdict costs zero tool invocation.
  let inputVerdict = null;
  if (guardrailCfg) {
    inputVerdict = _stageVerdict(canonicalJson(args), guardrailCfg);
    if (inputVerdict.blocked) throw _guardrailBlockError('input', inputVerdict);
  }

  // Resolve the result: precomputed wins; otherwise invoke the injected tool.
  let result = opts.result;
  if (result === undefined) {
    if (typeof opts.execute === 'function') {
      result = await opts.execute({ tool, args, tenant });
    } else {
      result = { content: [], isError: false };
    }
  }

  // OUTPUT screen (over the tool result text) - runs AFTER execution; a 'block'
  // verdict rejects an output-poisoning attempt before the bytes reach the model.
  let outputVerdict = null;
  if (guardrailCfg) {
    outputVerdict = _stageVerdict(_resultScreenText(result), guardrailCfg);
    if (outputVerdict.blocked) throw _guardrailBlockError('output', outputVerdict);
  }

  const args_hash = hashMcpArgs(args);
  const result_hash = hashMcpResult(result);

  const unsigned = buildMcpReceipt({
    tool,
    tenant,
    args_hash,
    result_hash,
    is_error: !!(result && typeof result === 'object' && !Array.isArray(result) && result.isError),
    now: opts.now,
    call_id: opts.call_id,
    transport: opts.transport,
    server_id: opts.server_id,
  });
  const receipt = signMcpReceipt(unsigned, opts.signer, { signed_at: opts.signed_at });

  // Stamp the (NON-signed) guardrail verdicts onto the receipt. The signature
  // covers only MCP_SIGNED_FIELDS, so this field is outside the signed bytes -
  // verifyMcpReceipt is unaffected, exactly like latency_breakdown.
  if (guardrailCfg) {
    receipt.guardrail = { screened: true, mode: guardrailCfg.mode, input: inputVerdict, output: outputVerdict };
  }

  return {
    result_passthrough_contract: {
      result,            // unmodified - the gateway is a pass-through for bytes
      unaltered: true,
      bound_by: 'result_hash',
      result_hash,
      args_hash,
    },
    receipt,
    guardrail: guardrailCfg ? { input: inputVerdict, output: outputVerdict } : null,
  };
}

export default {
  MCP_RECEIPT_SCHEMA,
  MCP_GATEWAY_VERSION,
  MCP_SIGNED_FIELDS,
  hashMcpArgs,
  hashMcpResult,
  mcpToolCallId,
  buildMcpReceipt,
  signMcpReceipt,
  verifyMcpReceipt,
  wrapToolCall,
  canonicalMcpReceipt: _canonicalForSigning,
};
