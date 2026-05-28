// W918 P3.1 — Portkey trace export importer.
//
// Ingests a Portkey trace / log export (JSONL) and emits kolm capture rows
// ready to feed into the distill / eval pipelines. Portkey ships several
// export shapes across product versions; this importer normalises across
// them and skips rows that fit none.
//
// Supported source shapes (per row of the JSONL)
//
//   1. Trace export (chat-completions passthrough):
//        {
//          "id": "trace-...",
//          "trace_id": "...",
//          "timestamp": "2026-01-01T00:00:00Z",
//          "request":  { "model": "gpt-4o",
//                        "messages": [{"role":"system", "content":"..."},
//                                     {"role":"user",   "content":"..."}] },
//          "response": { "id": "chatcmpl-...",
//                        "choices": [{"message":{"role":"assistant","content":"..."}}],
//                        "usage": { "prompt_tokens": 100, "completion_tokens": 50 } },
//          "metadata": { ... }
//        }
//
//   2. Flat shape (prompt + response as strings):
//        {
//          "id": "trace-...",
//          "timestamp": "...",
//          "model": "gpt-4o",
//          "prompt": "...",
//          "response": "..."
//        }
//
//   3. Logs export (request_body / response_body are JSON strings):
//        {
//          "id": "log-...",
//          "createdAt": "...",
//          "model": "gpt-4o-mini",
//          "request_body":  "{\"messages\":[...]}",
//          "response_body": "{\"choices\":[{\"message\":{...}}]}"
//        }
//
// Emitted shape (one row per valid input line) matches the openai-finetune
// importer envelope so downstream consumers can mix sources freely:
//
//   { id, ts, namespace, input, output,
//     meta: { source: "portkey",
//             model: <string|null>,
//             trace_id: <string|null>,
//             usage: <object|null>,
//             shape: "trace" | "flat" | "logs" } }
//
// id   = first 16 hex chars of sha256(input + "" + output)
// ts   = row.timestamp / row.createdAt / row.created_at if present and
//        parseable, otherwise the ingest timestamp passed via opts.ts (or
//        the call-site time).
// namespace defaults to "portkey"; the caller can override.
//
// Malformed rows do NOT throw — they are skipped and recorded in the
// `errors` array as { line, reason } so the caller can surface them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_TAG = 'portkey';
const DEFAULT_NAMESPACE = 'portkey';
const ID_HEX_LEN = 16;

function rowId(input, output) {
  return crypto
    .createHash('sha256')
    .update(input + '' + output)
    .digest('hex')
    .slice(0, ID_HEX_LEN);
}

function asString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  // OpenAI-style content can be an array of parts (text / image_url).
  // For text capture we keep text segments only; non-text parts are ignored.
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  return String(value);
}

function rolePrefix(role) {
  switch (role) {
    case 'system': return '[system] ';
    case 'user': return '[user] ';
    case 'developer': return '[developer] ';
    case 'tool': return '[tool] ';
    case 'function': return '[function] ';
    default: return '[' + (role || 'unknown') + '] ';
  }
}

function pickTimestamp(obj, fallbackTs) {
  const candidates = [
    obj && obj.timestamp,
    obj && obj.createdAt,
    obj && obj.created_at,
    obj && obj.created,
    obj && obj.time,
    obj && obj.ts,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (typeof c === 'number' && Number.isFinite(c)) {
      // Portkey occasionally emits seconds-since-epoch or millis-since-epoch.
      const ms = c < 1e12 ? c * 1000 : c;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return fallbackTs;
}

function pickModel(obj, requestObj, responseObj) {
  if (requestObj && typeof requestObj.model === 'string' && requestObj.model.length > 0) {
    return requestObj.model;
  }
  if (responseObj && typeof responseObj.model === 'string' && responseObj.model.length > 0) {
    return responseObj.model;
  }
  if (obj && typeof obj.model === 'string' && obj.model.length > 0) return obj.model;
  return null;
}

function pickTraceId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.trace_id === 'string' && obj.trace_id.length > 0) return obj.trace_id;
  if (typeof obj.traceId === 'string' && obj.traceId.length > 0) return obj.traceId;
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  if (obj.metadata && typeof obj.metadata === 'object') {
    const m = obj.metadata;
    if (typeof m.trace_id === 'string' && m.trace_id.length > 0) return m.trace_id;
    if (typeof m.traceId === 'string' && m.traceId.length > 0) return m.traceId;
    if (typeof m.id === 'string' && m.id.length > 0) return m.id;
  }
  return null;
}

function pickUsage(responseObj) {
  if (!responseObj || typeof responseObj !== 'object') return null;
  if (responseObj.usage && typeof responseObj.usage === 'object') return responseObj.usage;
  return null;
}

function tryParseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    return null;
  }
}

function extractInputFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') continue;
    if (m.role === 'assistant') continue;
    const text = asString(m.content);
    if (text) parts.push(rolePrefix(m.role) + text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function extractAssistantFromChoices(choices) {
  if (!Array.isArray(choices) || choices.length === 0) return null;
  // Walk choices and return the first non-empty assistant string we find.
  for (const c of choices) {
    if (!c || typeof c !== 'object') continue;
    if (c.message && typeof c.message === 'object') {
      const text = asString(c.message.content);
      if (text) return text;
    }
    if (typeof c.text === 'string' && c.text.length > 0) return c.text;
    if (c.delta && typeof c.delta === 'object') {
      const text = asString(c.delta.content);
      if (text) return text;
    }
  }
  return null;
}

function fromTraceShape(obj) {
  const request = obj && typeof obj.request === 'object' ? obj.request : null;
  const response = obj && typeof obj.response === 'object' ? obj.response : null;
  if (!request && !response) {
    return { error: 'trace shape missing both request and response' };
  }
  // Input — either OpenAI chat messages, an Anthropic-style messages array,
  // or a plain prompt string carried at request.prompt.
  let input = null;
  if (request) {
    if (Array.isArray(request.messages)) {
      input = extractInputFromMessages(request.messages);
    }
    if (!input && typeof request.prompt === 'string' && request.prompt.length > 0) {
      input = request.prompt;
    }
    if (!input && typeof request.input === 'string' && request.input.length > 0) {
      input = request.input;
    }
  }
  // Output — chat completion choices, plain string, or Anthropic content[].
  let output = null;
  if (response) {
    if (Array.isArray(response.choices)) {
      output = extractAssistantFromChoices(response.choices);
    }
    if (!output && typeof response.content === 'string' && response.content.length > 0) {
      output = response.content;
    }
    if (!output && Array.isArray(response.content)) {
      // Anthropic-style content blocks.
      output = asString(response.content);
    }
    if (!output && typeof response.text === 'string' && response.text.length > 0) {
      output = response.text;
    }
    if (!output && typeof response.output === 'string' && response.output.length > 0) {
      output = response.output;
    }
  }
  if (!input) return { error: 'trace shape: could not extract input from request' };
  if (!output) return { error: 'trace shape: could not extract assistant output from response' };
  return {
    input,
    output,
    shape: 'trace',
    model: pickModel(obj, request, response),
    usage: pickUsage(response),
  };
}

function fromFlatShape(obj) {
  const promptCandidate =
    typeof obj.prompt === 'string' ? obj.prompt :
    typeof obj.input === 'string' ? obj.input :
    typeof obj.query === 'string' ? obj.query :
    null;
  const responseCandidate =
    typeof obj.response === 'string' ? obj.response :
    typeof obj.output === 'string' ? obj.output :
    typeof obj.completion === 'string' ? obj.completion :
    null;
  if (!promptCandidate || promptCandidate.length === 0) {
    return { error: 'flat shape: prompt/input/query missing or empty' };
  }
  if (!responseCandidate || responseCandidate.length === 0) {
    return { error: 'flat shape: response/output/completion missing or empty' };
  }
  return {
    input: promptCandidate,
    output: responseCandidate,
    shape: 'flat',
    model: pickModel(obj, null, null),
    usage: obj && obj.usage && typeof obj.usage === 'object' ? obj.usage : null,
  };
}

function fromLogsShape(obj) {
  const reqRaw = obj.request_body != null ? obj.request_body : obj.requestBody;
  const respRaw = obj.response_body != null ? obj.response_body : obj.responseBody;
  const request = tryParseJson(reqRaw);
  const response = tryParseJson(respRaw);
  if (!request && !response) {
    return { error: 'logs shape: request_body and response_body both unparseable' };
  }
  // Reuse the trace extractor — the parsed bodies have the same internal
  // structure (chat completions style).
  const fused = { request: request || {}, response: response || {} };
  const extracted = fromTraceShape(fused);
  if (extracted.error) {
    return { error: 'logs shape: ' + extracted.error };
  }
  return {
    input: extracted.input,
    output: extracted.output,
    shape: 'logs',
    model: pickModel(obj, request, response),
    usage: pickUsage(response),
  };
}

function detectShape(obj) {
  if (obj == null || typeof obj !== 'object') return null;
  if (obj.request_body != null || obj.response_body != null ||
      obj.requestBody != null || obj.responseBody != null) {
    return 'logs';
  }
  if ((obj.request && typeof obj.request === 'object') ||
      (obj.response && typeof obj.response === 'object')) {
    return 'trace';
  }
  const hasFlatPrompt =
    typeof obj.prompt === 'string' ||
    typeof obj.input === 'string' ||
    typeof obj.query === 'string';
  const hasFlatResponse =
    typeof obj.response === 'string' ||
    typeof obj.output === 'string' ||
    typeof obj.completion === 'string';
  if (hasFlatPrompt && hasFlatResponse) return 'flat';
  return null;
}

function toCaptureRow(obj, fallbackTs, namespace) {
  if (!obj || typeof obj !== 'object') {
    return { error: 'row is not a JSON object' };
  }
  const shape = detectShape(obj);
  if (!shape) {
    return { error: 'row matches none of: trace, flat, logs' };
  }
  let extracted;
  if (shape === 'trace') extracted = fromTraceShape(obj);
  else if (shape === 'flat') extracted = fromFlatShape(obj);
  else extracted = fromLogsShape(obj);
  if (extracted.error) return { error: extracted.error };
  const ts = pickTimestamp(obj, fallbackTs);
  return {
    row: {
      id: rowId(extracted.input, extracted.output),
      ts,
      namespace,
      input: extracted.input,
      output: extracted.output,
      meta: {
        source: SOURCE_TAG,
        model: extracted.model || null,
        trace_id: pickTraceId(obj),
        usage: extracted.usage || null,
        shape: extracted.shape,
      },
    },
  };
}

/**
 * Parse a Portkey trace / log export.
 *
 * Accepts JSONL (one JSON object per line, the documented Portkey export
 * format) and also tolerates a top-level JSON array of objects in case the
 * caller hand-saved an array instead of streaming JSONL.
 *
 * @param {string} text
 * @param {{ namespace?: string, ts?: string }} [opts]
 * @returns {{ rows: object[], errors: { line: number, reason: string }[] }}
 */
export function parse(text, opts = {}) {
  if (typeof text !== 'string') {
    return { rows: [], errors: [{ line: 0, reason: 'input is not a string' }] };
  }
  const namespace = (opts.namespace && String(opts.namespace).trim()) || DEFAULT_NAMESPACE;
  const fallbackTs = (opts.ts && String(opts.ts)) || new Date().toISOString();
  const rows = [];
  const errors = [];

  // If the whole payload parses as a JSON array, treat each element as a row.
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      // Fall through to JSONL handling — maybe it just happens to start with [.
      arr = null;
    }
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        const result = toCaptureRow(item, fallbackTs, namespace);
        if (result.error) {
          errors.push({ line: i + 1, reason: result.error });
          continue;
        }
        rows.push(result.row);
      }
      return { rows, errors };
    }
  }

  // JSONL path — split on newlines, ignore blank lines.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push({ line: lineNo, reason: 'invalid JSON: ' + (e && e.message ? e.message : String(e)) });
      continue;
    }
    const result = toCaptureRow(parsed, fallbackTs, namespace);
    if (result.error) {
      errors.push({ line: lineNo, reason: result.error });
      continue;
    }
    rows.push(result.row);
  }
  return { rows, errors };
}

/**
 * Parse a Portkey trace / log export from disk.
 *
 * @param {string} filePath
 * @param {{ namespace?: string, ts?: string }} [opts]
 * @returns {{ rows: object[], errors: { line: number, reason: string }[] }}
 */
export function parseFile(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    const err = new Error('parseFile: filePath must be a non-empty string');
    err.code = 'ERR_INVALID_ARG';
    throw err;
  }
  const abs = path.resolve(filePath);
  const text = fs.readFileSync(abs, 'utf8');
  return parse(text, opts);
}
