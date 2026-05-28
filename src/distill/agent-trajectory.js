// W918 P2.3 - Agent trajectory parser / normalizer.
//
// Converts tool-use trajectories from the three shapes we see in the wild
// into uniform kolm distill rows that downstream council / SeqKD code can
// compare byte-for-byte:
//
//   * OpenAI Chat Completions:
//       messages[].tool_calls = [{id, type:'function',
//                                  function:{name, arguments:<JSON string>}}]
//       tool results arrive as role:'tool' turns with tool_call_id.
//   * Anthropic Messages API:
//       assistant content blocks of {type:'tool_use', id, name, input:{}}
//       results arrive as user content blocks of {type:'tool_result',
//                                                  tool_use_id, content, is_error}.
//   * MCP turns:
//       {method:'tools/call', params:{name, arguments}} plus a sibling
//       {result:{content:[...], isError}} or {error:{...}} response.
//
// Output row shape (one per assistant turn):
//   { kind:'agent_turn', step, user_input, assistant_text,
//     tool_calls: [{name, args, args_normalized}],
//     tool_results: [{name, result_excerpt, ok}],
//     teacher_source, raw }
//
// Pure node, zero npm deps. Malformed turns are skipped + recorded in
// parseErrors; the function never throws to the caller.

import fs from 'node:fs';
import path from 'node:path';

const RESULT_EXCERPT_CAP = 4096; // 4 KB cap on result excerpts.

// ---------------------------------------------------------------------------
// Small utilities

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isObject(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (isObject(value) && typeof value.text === 'string') return value.text;
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return String(value);
  }
}

function clipExcerpt(text) {
  const s = typeof text === 'string' ? text : asText(text);
  if (s.length <= RESULT_EXCERPT_CAP) return s;
  return s.slice(0, RESULT_EXCERPT_CAP);
}

/**
 * Stable JSON.stringify with sorted object keys. Strings, numbers, booleans,
 * null, arrays, and plain objects are supported. Non-finite numbers become
 * null (matching JSON.stringify). Strings that already parse as JSON objects
 * are re-canonicalized; strings that don't are returned as-is JSON-quoted.
 */
export function canonicalizeArgs(input) {
  let value = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      try {
        value = JSON.parse(trimmed);
      } catch (_e) {
        value = input;
      }
    }
  }
  return stableStringify(value);
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => stableStringify(v));
    return '[' + parts.join(',') + ']';
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(String(value));
}

/**
 * Normalize a tool name across providers:
 *   mcp__github__create_issue  -> create_issue
 *   functions.search_web       -> search_web
 *   GitHub-API.CreateIssue     -> github_api_createissue
 * Lower-cased, non-word chars collapse to underscores, leading/trailing
 * underscores stripped.
 */
export function normalizeToolName(name) {
  if (name == null) return '';
  let s = String(name);
  // Anthropic / Claude-Code MCP prefix: mcp__<server>__<tool> -> <tool>.
  const mcpMatch = s.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  if (mcpMatch) s = mcpMatch[1];
  // OpenAI sometimes namespaces as "functions.search_web" or "namespace.tool".
  if (s.includes('.')) {
    const parts = s.split('.');
    s = parts[parts.length - 1];
  }
  s = s.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  s = s.replace(/^_+|_+$/g, '');
  return s;
}

// ---------------------------------------------------------------------------
// Shape detection

function looksLikeAlreadyNormalised(v) {
  return isObject(v) && v.kind === 'agent_turn';
}

function looksLikeAnthropic(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!isObject(m)) continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!isObject(block)) continue;
        if (block.type === 'tool_use' || block.type === 'tool_result' ||
            block.type === 'text' || block.type === 'input_text') {
          return true;
        }
      }
    }
  }
  return false;
}

function looksLikeOpenAI(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!isObject(m)) continue;
    if (typeof m.role !== 'string') continue;
    if (m.role === 'tool') return true;
    if (Array.isArray(m.tool_calls)) return true;
    if (typeof m.content === 'string') return true;
  }
  return false;
}

function looksLikeMcp(value) {
  if (Array.isArray(value)) {
    for (const turn of value) {
      if (isObject(turn) &&
          (turn.method === 'tools/call' || isObject(turn.params) || isObject(turn.result))) {
        return true;
      }
    }
    return false;
  }
  return isObject(value) && (value.method === 'tools/call' || isObject(value.params));
}

// ---------------------------------------------------------------------------
// OpenAI extractor

function extractToolCallsOpenAI(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (const tc of toolCalls) {
    if (!isObject(tc)) continue;
    const fn = isObject(tc.function) ? tc.function : tc;
    const rawName = fn && (fn.name || tc.name);
    if (!rawName) continue;
    const rawArgs = fn && (fn.arguments != null ? fn.arguments : fn.args);
    let argsObj = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        argsObj = JSON.parse(rawArgs);
      } catch (_e) {
        argsObj = rawArgs;
      }
    }
    out.push({
      _id: tc.id || null,
      name: normalizeToolName(rawName),
      args: argsObj,
      args_normalized: canonicalizeArgs(argsObj),
    });
  }
  return out;
}

function buildOpenAIRows(messages, parseErrors) {
  const rows = [];
  let step = 0;
  let pendingUserInput = null;
  // Map tool_call_id -> {name, args} so we can attach tool results to the
  // assistant turn that issued them.
  const callIdToName = new Map();
  // Tool results that arrive AFTER the assistant turn are appended to the
  // most recent row.
  let lastAssistantRow = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isObject(m) || typeof m.role !== 'string') {
      parseErrors.push({ idx: i, reason: 'message missing role' });
      continue;
    }
    if (m.role === 'system' || m.role === 'developer') {
      // System / developer turns are folded into the next user input slot so
      // teacher comparisons see the same context window.
      const t = asText(m.content);
      if (t) {
        pendingUserInput = pendingUserInput ? pendingUserInput + '\n' + t : t;
      }
      continue;
    }
    if (m.role === 'user') {
      const t = asText(m.content);
      pendingUserInput = pendingUserInput ? pendingUserInput + '\n' + t : t;
      continue;
    }
    if (m.role === 'tool' || m.role === 'function') {
      if (!lastAssistantRow) {
        parseErrors.push({ idx: i, reason: 'tool result has no preceding assistant turn' });
        continue;
      }
      const callId = m.tool_call_id || m.id || null;
      const name = callId && callIdToName.has(callId)
        ? callIdToName.get(callId)
        : normalizeToolName(m.name || '');
      const excerpt = clipExcerpt(m.content);
      let ok = null;
      if (typeof m.is_error === 'boolean') ok = !m.is_error;
      lastAssistantRow.tool_results.push({
        name,
        result_excerpt: excerpt,
        ok,
      });
      continue;
    }
    if (m.role === 'assistant') {
      const text = asText(m.content);
      const toolCalls = extractToolCallsOpenAI(m.tool_calls);
      for (const tc of toolCalls) {
        if (tc._id) callIdToName.set(tc._id, tc.name);
      }
      const row = {
        kind: 'agent_turn',
        step,
        user_input: pendingUserInput,
        assistant_text: text,
        tool_calls: toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          args_normalized: tc.args_normalized,
        })),
        tool_results: [],
        teacher_source: 'openai',
        raw: m,
      };
      rows.push(row);
      lastAssistantRow = row;
      pendingUserInput = null;
      step += 1;
      continue;
    }
    parseErrors.push({ idx: i, reason: 'unknown role: ' + m.role });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Anthropic extractor

function splitAnthropicContent(content) {
  const out = { text: '', toolUses: [], toolResults: [] };
  if (typeof content === 'string') {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) return out;
  const textParts = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    const t = block.type;
    if (t === 'text' || t === 'output_text' || t === 'input_text') {
      if (typeof block.text === 'string') textParts.push(block.text);
    } else if (t === 'tool_use') {
      out.toolUses.push({
        _id: block.id || null,
        name: normalizeToolName(block.name || ''),
        args: block.input,
        args_normalized: canonicalizeArgs(block.input),
      });
    } else if (t === 'tool_result') {
      out.toolResults.push({
        _tool_use_id: block.tool_use_id || null,
        result_excerpt: clipExcerpt(block.content),
        ok: typeof block.is_error === 'boolean' ? !block.is_error : null,
      });
    }
  }
  out.text = textParts.join('\n');
  return out;
}

function buildAnthropicRows(messages, parseErrors) {
  const rows = [];
  let step = 0;
  let pendingUserInput = null;
  const callIdToName = new Map();
  let lastAssistantRow = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isObject(m) || typeof m.role !== 'string') {
      parseErrors.push({ idx: i, reason: 'message missing role' });
      continue;
    }
    const split = splitAnthropicContent(m.content);
    if (m.role === 'system') {
      if (split.text) {
        pendingUserInput = pendingUserInput ? pendingUserInput + '\n' + split.text : split.text;
      }
      continue;
    }
    if (m.role === 'user') {
      if (split.text) {
        pendingUserInput = pendingUserInput ? pendingUserInput + '\n' + split.text : split.text;
      }
      // Anthropic packs tool_result blocks into the next user message.
      for (const tr of split.toolResults) {
        if (!lastAssistantRow) {
          parseErrors.push({ idx: i, reason: 'tool_result has no preceding assistant turn' });
          continue;
        }
        const name = tr._tool_use_id && callIdToName.has(tr._tool_use_id)
          ? callIdToName.get(tr._tool_use_id)
          : '';
        lastAssistantRow.tool_results.push({
          name,
          result_excerpt: tr.result_excerpt,
          ok: tr.ok,
        });
      }
      continue;
    }
    if (m.role === 'assistant') {
      for (const tu of split.toolUses) {
        if (tu._id) callIdToName.set(tu._id, tu.name);
      }
      const row = {
        kind: 'agent_turn',
        step,
        user_input: pendingUserInput,
        assistant_text: split.text,
        tool_calls: split.toolUses.map((tu) => ({
          name: tu.name,
          args: tu.args,
          args_normalized: tu.args_normalized,
        })),
        tool_results: [],
        teacher_source: 'anthropic',
        raw: m,
      };
      rows.push(row);
      lastAssistantRow = row;
      pendingUserInput = null;
      step += 1;
      continue;
    }
    parseErrors.push({ idx: i, reason: 'unknown role: ' + m.role });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// MCP extractor
//
// We model MCP as a stream of {method:'tools/call', params:{name, arguments}}
// requests, each optionally followed by a {result:{...}} or {error:{...}}
// response (matched by `id` when present, otherwise by position).

function buildMcpRows(turns, parseErrors) {
  const rows = [];
  let step = 0;
  // Index responses by id so we can match request->response.
  const responseById = new Map();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!isObject(t)) continue;
    if ((isObject(t.result) || isObject(t.error)) && t.method == null) {
      if (t.id != null) responseById.set(String(t.id), t);
    }
  }
  // Walk requests in order; pair with response either by id or by next-in-line.
  const remainingResponses = [];
  for (const t of turns) {
    if (isObject(t) && (isObject(t.result) || isObject(t.error)) && t.method == null) {
      if (t.id == null) remainingResponses.push(t);
    }
  }
  let responseCursor = 0;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!isObject(t)) {
      parseErrors.push({ idx: i, reason: 'mcp turn is not an object' });
      continue;
    }
    if (t.method !== 'tools/call') continue;
    const params = isObject(t.params) ? t.params : {};
    const rawName = params.name || '';
    const rawArgs = params.arguments != null ? params.arguments : params.args;
    let resp = null;
    if (t.id != null && responseById.has(String(t.id))) {
      resp = responseById.get(String(t.id));
    } else if (responseCursor < remainingResponses.length) {
      resp = remainingResponses[responseCursor];
      responseCursor += 1;
    }
    let result_excerpt = '';
    let ok = null;
    if (resp) {
      if (isObject(resp.error)) {
        ok = false;
        result_excerpt = clipExcerpt(asText(resp.error.message || resp.error));
      } else if (isObject(resp.result)) {
        ok = resp.result.isError === true ? false :
             resp.result.isError === false ? true : true;
        result_excerpt = clipExcerpt(asText(resp.result.content != null ? resp.result.content : resp.result));
      }
    }
    const name = normalizeToolName(rawName);
    rows.push({
      kind: 'agent_turn',
      step,
      user_input: null,
      assistant_text: '',
      tool_calls: [{
        name,
        args: rawArgs,
        args_normalized: canonicalizeArgs(rawArgs),
      }],
      tool_results: resp ? [{ name, result_excerpt, ok }] : [],
      teacher_source: 'mcp',
      raw: t,
    });
    step += 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Parse a trajectory in any of the supported shapes.
 *
 * @param {unknown} input - OpenAI messages[], Anthropic messages[], MCP turn
 *                          array, a single MCP turn, a JSONL string, or a
 *                          wrapper object {messages|conversation|turns}.
 * @param {{ source?: 'openai'|'anthropic'|'mcp'|'auto' }} [opts]
 * @returns {{rows: object[], skipped: number, parseErrors: {idx:number, reason:string}[]}}
 */
export function parseTrajectory(input, opts = {}) {
  const parseErrors = [];
  let skipped = 0;

  // Flat JSONL string -> parse each line, recurse, aggregate.
  if (typeof input === 'string') {
    const aggregateRows = [];
    const lines = input.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw || raw.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parseErrors.push({ idx: i, reason: 'invalid JSON: ' + (e && e.message ? e.message : String(e)) });
        skipped += 1;
        continue;
      }
      const sub = parseTrajectory(parsed, opts);
      for (const r of sub.rows) aggregateRows.push(r);
      for (const pe of sub.parseErrors) parseErrors.push({ idx: i, reason: pe.reason });
      skipped += sub.skipped;
    }
    return { rows: aggregateRows, skipped, parseErrors };
  }

  if (input == null || typeof input !== 'object') {
    parseErrors.push({ idx: 0, reason: 'input is not an object, array, or JSONL string' });
    return { rows: [], skipped: 1, parseErrors };
  }

  // Idempotency: an array of already-normalised rows is returned as-is.
  if (Array.isArray(input) && input.length > 0 && input.every(looksLikeAlreadyNormalised)) {
    return { rows: input.slice(), skipped: 0, parseErrors };
  }
  if (looksLikeAlreadyNormalised(input)) {
    return { rows: [input], skipped: 0, parseErrors };
  }

  // Unwrap common envelopes.
  let payload = input;
  if (!Array.isArray(payload)) {
    if (Array.isArray(payload.messages)) payload = payload.messages;
    else if (Array.isArray(payload.conversation)) payload = payload.conversation;
    else if (Array.isArray(payload.turns)) payload = payload.turns;
    else if (looksLikeMcp(payload)) payload = [payload];
  }

  const sourceHint = opts && typeof opts.source === 'string' ? opts.source : 'auto';
  let source = sourceHint;
  if (source === 'auto') {
    if (looksLikeMcp(payload)) source = 'mcp';
    else if (looksLikeAnthropic(payload)) source = 'anthropic';
    else if (looksLikeOpenAI(payload)) source = 'openai';
    else source = 'unknown';
  }

  let rows = [];
  if (source === 'openai') {
    rows = buildOpenAIRows(Array.isArray(payload) ? payload : [], parseErrors);
  } else if (source === 'anthropic') {
    rows = buildAnthropicRows(Array.isArray(payload) ? payload : [], parseErrors);
  } else if (source === 'mcp') {
    rows = buildMcpRows(Array.isArray(payload) ? payload : [payload], parseErrors);
  } else {
    // Best-effort: try anthropic then openai, take whichever yields rows.
    const aErrs = [];
    const a = buildAnthropicRows(Array.isArray(payload) ? payload : [], aErrs);
    if (a.length > 0) {
      rows = a.map((r) => ({ ...r, teacher_source: 'unknown' }));
    } else {
      const oErrs = [];
      const o = buildOpenAIRows(Array.isArray(payload) ? payload : [], oErrs);
      rows = o.map((r) => ({ ...r, teacher_source: 'unknown' }));
      if (rows.length === 0) {
        parseErrors.push({ idx: 0, reason: 'could not match any supported shape' });
        skipped += 1;
      }
    }
  }

  return { rows, skipped, parseErrors };
}

/**
 * Read a JSONL file from disk and parse every line as a trajectory snippet.
 * Aggregates rows / errors across the whole file.
 */
export function parseFile(jsonlPath) {
  if (typeof jsonlPath !== 'string' || jsonlPath.length === 0) {
    const err = new Error('parseFile: jsonlPath must be a non-empty string');
    err.code = 'ERR_INVALID_ARG';
    throw err;
  }
  const abs = path.resolve(jsonlPath);
  const text = fs.readFileSync(abs, 'utf8');
  return parseTrajectory(text);
}
