// W735 - Agent / Tool-Use distillation: capture-phase primitives.
//
// Closes W735-1 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md line 392:
//
//   W735-1: "Capture tool-use patterns during capture phase" → tool_calls
//           capture. The wrapper-mode capture path (src/router.js
//           /v1/capture/log) calls parseToolCalls() against the upstream
//           LLM's raw response body. The parsed {tool_calls,parse_source}
//           record is then folded onto the capture row alongside the
//           existing prompt + response + retrieved_context fields.
//
// Design contract:
//
//   * PURE module. No I/O, no timers, no persistence. The capture row is
//     persisted by src/router.js + src/capture-store.js; this module only
//     parses tool-call shapes from upstream response bodies and clusters
//     captures by tool-name frequency.
//   * Multi-vendor: handles Anthropic (content[].type === 'tool_use'),
//     OpenAI (message.tool_calls[]), and generic (function_call field)
//     shapes. Returns a normalised {tool_calls,parse_source} record so
//     downstream consumers never have to switch on the upstream vendor.
//   * Honest absence: a non-tool-using response returns
//     {tool_calls:[], parse_source:'none'} - pure no-op, never throws.
//     The W735-2 formatter detects parse_source==='none' and falls
//     through to the legacy USER/ASSISTANT format.
//   * Privacy: parseToolCalls() never logs raw arguments - it only
//     normalises shape. The capture row is what carries the data into
//     the persisted store (where it belongs - it IS training data).
//   * Additive: when a capture has no tool_calls field, the W735-2
//     formatter falls through to the legacy USER/ASSISTANT format.
//     Nothing about the W735 change breaks existing distill flows.
//
// Public surface:
//
//   TOOL_USE_VERSION
//   parseToolCalls(response_body)
//   extractToolPatterns(captures, {top_n?, namespace?})

export const TOOL_USE_VERSION = 'w735-v1';

// Largest single tool-call we will normalise. Tool argument blobs over
// 64 KiB are almost certainly a misuse of tools (file payloads belong in
// /v1/capture/log items[], not tool arguments). The parser truncates the
// argument string to this length and surfaces a `truncated:true` flag.
const MAX_TOOL_ARGS_BYTES = 64 * 1024;

// Largest number of tool calls per response we will surface. Real-world
// agent traces top out around 20 sequential calls; anything above 200 is
// almost certainly a runaway loop the upstream model went into.
const MAX_TOOL_CALLS_PER_RESPONSE = 200;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_PATTERN_TOP_N = 100;

function _cleanToolName(value) {
  const cleaned = String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TOOL_NAME_CHARS);
  if (cleaned === '__proto__' || cleaned === 'constructor' || cleaned === 'prototype') return '';
  return cleaned;
}

// =============================================================================
// parseToolCalls
// =============================================================================

/**
 * Parse tool-call records out of an upstream LLM response body.
 *
 * Returns {tool_calls:[{name, arguments, id?}], parse_source:'anthropic'|
 * 'openai'|'generic'|'none'}. Never throws - pathological inputs return
 * the honest-empty envelope {tool_calls:[], parse_source:'none'}.
 *
 * Shape priority (first match wins):
 *
 *   1) Anthropic - body.content is an array, with one or more items where
 *      item.type === 'tool_use'. Each item has {id, name, input}.
 *
 *   2) OpenAI - body.choices[0].message.tool_calls is an array. Each item
 *      has {id, type:'function', function:{name, arguments:JSON_STRING}}.
 *      We also accept the legacy {message.function_call} shape (single
 *      call) as a degenerate OpenAI case.
 *
 *   3) Generic - body.function_call or body.tool_calls at top level. This
 *      covers custom adapters, Ollama function-mode, and Mistral
 *      tool-use. We treat top-level tool_calls as an OpenAI-shaped array.
 *
 *   4) None - no recognised shape. Returns the empty envelope.
 *
 * The `arguments` field is ALWAYS a plain object on the returned record,
 * even when the upstream wire format used a JSON string (OpenAI's
 * convention). Parser failures on the arguments string fall through to
 * {raw_arguments: <string>} so the caller still sees what came down the
 * wire - we don't silently drop malformed payloads.
 */
export function parseToolCalls(response_body) {
  // Honest empty envelope. Used by every fall-through branch below.
  const EMPTY = { tool_calls: [], parse_source: 'none' };

  if (response_body == null) return EMPTY;
  // Body might already be parsed (object) OR be a JSON string from the
  // wire. We tolerate both - the SDK callers vary on this.
  let body = response_body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (_e) { return EMPTY; }
  }
  if (typeof body !== 'object' || Array.isArray(body)) return EMPTY;

  // ----- 1) Anthropic shape: body.content[].type === 'tool_use' -----
  if (Array.isArray(body.content)) {
    const calls = [];
    for (const item of body.content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type !== 'tool_use') continue;
      const name = _cleanToolName(item.name);
      if (!name) continue;
      const args = _normaliseArgs(item.input);
      const rec = { name, arguments: args.value };
      if (args.truncated) rec.truncated = true;
      if (args.raw_arguments != null) rec.raw_arguments = args.raw_arguments;
      if (typeof item.id === 'string' && item.id) rec.id = item.id;
      calls.push(rec);
      if (calls.length >= MAX_TOOL_CALLS_PER_RESPONSE) break;
    }
    if (calls.length > 0) return { tool_calls: calls, parse_source: 'anthropic' };
  }

  // ----- 2) OpenAI shape: choices[0].message.tool_calls[] -----
  if (Array.isArray(body.choices) && body.choices.length > 0) {
    const msg = body.choices[0] && body.choices[0].message;
    if (msg && typeof msg === 'object') {
      // Modern shape: message.tool_calls[] with function-named entries.
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const calls = [];
        for (const tc of msg.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const fn = tc.function || tc;
          if (!fn || typeof fn !== 'object') continue;
          const name = _cleanToolName(fn.name);
          if (!name) continue;
          const args = _normaliseArgs(fn.arguments);
          const rec = { name, arguments: args.value };
          if (args.truncated) rec.truncated = true;
          if (args.raw_arguments != null) rec.raw_arguments = args.raw_arguments;
          if (typeof tc.id === 'string' && tc.id) rec.id = tc.id;
          calls.push(rec);
          if (calls.length >= MAX_TOOL_CALLS_PER_RESPONSE) break;
        }
        if (calls.length > 0) return { tool_calls: calls, parse_source: 'openai' };
      }
      // Legacy shape: message.function_call (single call).
      if (msg.function_call && typeof msg.function_call === 'object'
          && typeof msg.function_call.name === 'string' && msg.function_call.name) {
        const name = _cleanToolName(msg.function_call.name);
        if (!name) return EMPTY;
        const args = _normaliseArgs(msg.function_call.arguments);
        const rec = { name, arguments: args.value };
        if (args.truncated) rec.truncated = true;
        if (args.raw_arguments != null) rec.raw_arguments = args.raw_arguments;
        return { tool_calls: [rec], parse_source: 'openai' };
      }
    }
  }

  // ----- 3) Generic shapes -----
  // 3a) Top-level function_call (legacy custom adapters / Ollama).
  if (body.function_call && typeof body.function_call === 'object'
      && typeof body.function_call.name === 'string' && body.function_call.name) {
    const name = _cleanToolName(body.function_call.name);
    if (!name) return EMPTY;
    const args = _normaliseArgs(body.function_call.arguments);
    const rec = { name, arguments: args.value };
    if (args.truncated) rec.truncated = true;
    if (args.raw_arguments != null) rec.raw_arguments = args.raw_arguments;
    return { tool_calls: [rec], parse_source: 'generic' };
  }
  // 3b) Top-level tool_calls array (some forked OpenAI-compatible APIs).
  if (Array.isArray(body.tool_calls) && body.tool_calls.length > 0) {
    const calls = [];
    for (const tc of body.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const fn = tc.function || tc;
      if (!fn || typeof fn !== 'object') continue;
      const name = _cleanToolName(fn.name);
      if (!name) continue;
      const args = _normaliseArgs(fn.arguments);
      const rec = { name, arguments: args.value };
      if (args.truncated) rec.truncated = true;
      if (args.raw_arguments != null) rec.raw_arguments = args.raw_arguments;
      if (typeof tc.id === 'string' && tc.id) rec.id = tc.id;
      calls.push(rec);
      if (calls.length >= MAX_TOOL_CALLS_PER_RESPONSE) break;
    }
    if (calls.length > 0) return { tool_calls: calls, parse_source: 'generic' };
  }

  return EMPTY;
}

// Internal: normalise the `arguments` field of a tool call. OpenAI passes
// it as a JSON-encoded string; Anthropic passes it as a plain object.
// Returns {value: object, raw_arguments?: string, truncated?: boolean}.
function _normaliseArgs(raw) {
  if (raw == null) return { value: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    // Anthropic-shape - already an object. No truncation needed for the
    // wire payload since it was already deserialised by the caller.
    return { value: raw };
  }
  if (typeof raw === 'string') {
    let truncated = false;
    let s = raw;
    if (s.length > MAX_TOOL_ARGS_BYTES) {
      s = s.slice(0, MAX_TOOL_ARGS_BYTES);
      truncated = true;
    }
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out = { value: parsed };
        if (truncated) out.truncated = true;
        return out;
      }
      // JSON parsed but didn't yield an object (e.g. literal number/array
      // for a single-arg tool). Surface it as raw_arguments so the caller
      // can decide how to format.
      return { value: {}, raw_arguments: s, ...(truncated ? { truncated: true } : {}) };
    } catch (_e) {
      // Wire was a string but not valid JSON. Surface raw_arguments
      // verbatim so the operator can debug the upstream model output.
      return { value: {}, raw_arguments: s, ...(truncated ? { truncated: true } : {}) };
    }
  }
  // Anything else (number, array, boolean) - surface as raw_arguments.
  return { value: {}, raw_arguments: String(raw) };
}

// =============================================================================
// extractToolPatterns
// =============================================================================

/**
 * Cluster captures by tool-name and return the top-N most-called tools.
 *
 * Each capture is expected to carry a `tool_calls` array (the field added
 * by the W735-1 capture-path edit in src/router.js). Captures without
 * tool_calls are skipped - they contribute to the total-captures
 * denominator but not to any specific tool bucket.
 *
 * The optional `namespace` filter restricts the input set to captures
 * with `corpus_namespace === namespace`. When absent, all captures are
 * scanned.
 *
 * Returns:
 *
 *   {
 *     top:    [{name, count, share}],          // sorted desc by count
 *     total_captures:        Number,
 *     captures_with_tools:   Number,
 *     unique_tool_count:     Number,
 *     namespace:             String | null,
 *   }
 *
 * `share` is the fraction of captures-with-tools that included this
 * specific tool, in [0, 1]. The sum can exceed 1 because a single
 * capture can call multiple tools.
 */
export function extractToolPatterns(captures, options) {
  const opts = options || {};
  const top_n = (typeof opts.top_n === 'number' && opts.top_n > 0)
    ? Math.min(MAX_PATTERN_TOP_N, Math.floor(opts.top_n))
    : 20;
  const namespace = (typeof opts.namespace === 'string' && opts.namespace) ? opts.namespace : null;

  const arr = Array.isArray(captures) ? captures : [];
  const counts = new Map(); // name → count
  let total = 0;
  let withTools = 0;

  for (const cap of arr) {
    if (!cap || typeof cap !== 'object') continue;
    if (namespace != null) {
      const ns = cap.corpus_namespace || cap.namespace || null;
      if (ns !== namespace) continue;
    }
    total += 1;
    const tcs = Array.isArray(cap.tool_calls) ? cap.tool_calls : [];
    if (tcs.length === 0) continue;
    withTools += 1;
    // De-duplicate per capture so a tool called 5 times in one capture
    // still counts as "1 capture used this tool" for the share metric.
    const seen = new Set();
    for (const tc of tcs) {
      if (!tc || typeof tc !== 'object') continue;
      const name = _cleanToolName(tc.name);
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, top_n).map(([name, count]) => ({
    name,
    count,
    share: withTools > 0 ? count / withTools : 0,
  }));

  return {
    top,
    total_captures: total,
    captures_with_tools: withTools,
    unique_tool_count: counts.size,
    namespace,
  };
}
