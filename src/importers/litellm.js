// W918 P3.3 - LiteLLM proxy log export importer.
//
// Ingests a LiteLLM proxy log export (JSONL) and emits kolm capture rows
// ready to feed into the distill / eval pipelines.
//
// LiteLLM ships request/response logs in three observed shapes. This module
// detects which shape each row uses and normalises all three to the same
// kolm capture row.
//
// Supported source shapes
//   1. Proxy log JSONL (the default `success_callback: ["json"]` writer):
//        {
//          "request_id": "...",
//          "timestamp": "2026-01-01T00:00:00Z",
//          "model": "azure/gpt-4o" | "openai/gpt-4o" | "anthropic/...",
//          "messages": [{"role": "user", "content": "..."}, ...],
//          "response": {
//            "choices": [{"message": {"content": "..."}}],
//            "usage": {...}
//          },
//          "api_base": "...",
//          "user": "...",
//          "metadata": {...}
//        }
//
//   2. SpendLogs DB row (LiteLLM Enterprise spend_logs export). Same fields
//      but `messages` and `response` arrive as JSON-encoded strings rather
//      than objects, plus columns like `startTime` / `endTime` / `spend`:
//        {
//          "request_id": "...",
//          "startTime": "2026-01-01T00:00:00Z",
//          "model": "...",
//          "messages": "[{\"role\":\"user\",\"content\":\"...\"}]",
//          "response": "{\"choices\":[...],\"usage\":{...}}",
//          "api_base": "...",
//          "user": "...",
//          "metadata": {...} | "{...}"
//        }
//
//   3. Langfuse-style observation (when LiteLLM exports via the langfuse
//      integration). Input/output are nested arrays/strings rather than
//      OpenAI-shaped messages/response objects:
//        {
//          "id": "...",
//          "timestamp" | "startTime": "...",
//          "model": "...",
//          "input": [{"role": "user", "content": "..."}] | "..." | {...},
//          "output": [{"role": "assistant", "content": "..."}] | "..." | {...},
//          "metadata": {...}
//        }
//
// Emitted shape (one row per valid input line):
//   { id, ts, namespace, input, output,
//     meta: { source: "litellm",
//             model: <full prefixed model name or null>,
//             request_id: <request id or null>,
//             api_base: <api base url or null>,
//             usage: <usage object or null> } }
//
// id   = first 16 hex chars of sha256(input + "" + output)
// ts   = row timestamp if present, else ISO 8601 ingest timestamp
// namespace defaults to "litellm"; the caller can override.
//
// The provider prefix in `model` (azure/, openai/, anthropic/, bedrock/,
// vertex/, cohere/, gemini/, ollama/, ...) is preserved verbatim because
// downstream tooling uses it to attribute training data to a teacher.
//
// Malformed rows do NOT throw - they are skipped and recorded in the
// `errors` array as { line, reason } so the caller can surface them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_TAG = 'litellm';
const DEFAULT_NAMESPACE = 'litellm';
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
  // OpenAI-style content can be an array of typed parts (text / image_url).
  // For text rows we keep only text segments; non-text parts are dropped.
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return String(value);
}

function rolePrefix(role) {
  switch (role) {
    case 'system': return '[system] ';
    case 'user': return '[user] ';
    case 'developer': return '[developer] ';
    case 'tool': return '[tool] ';
    case 'function': return '[function] ';
    case 'assistant': return '[assistant] ';
    default: return '[' + (role || 'unknown') + '] ';
  }
}

function tryJsonObject(value) {
  // SpendLogs rows store messages/response/metadata as JSON-encoded strings.
  // Accept either already-parsed objects or JSON strings; return null on
  // anything we cannot turn into an object/array.
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

function flattenMessages(messages) {
  // Take system / user / developer / tool / function messages in order as
  // the input; assistant turns are skipped because they are the target.
  if (!Array.isArray(messages)) return '';
  const segments = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : '';
    if (role === 'assistant') continue;
    const text = asString(m.content);
    if (text) segments.push(rolePrefix(role) + text);
  }
  return segments.join('\n');
}

function lastAssistantFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === 'object' && m.role === 'assistant') {
      const text = asString(m.content);
      if (text) return text;
    }
  }
  return null;
}

function assistantFromResponse(response) {
  // OpenAI-style response: { choices: [{ message: { content, role } }], ... }
  // Anthropic-style normalised by LiteLLM: same shape.
  if (!response || typeof response !== 'object') return null;
  const choices = Array.isArray(response.choices) ? response.choices : null;
  if (!choices || choices.length === 0) return null;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    if (choice.message && typeof choice.message === 'object') {
      const text = asString(choice.message.content);
      if (text) return text;
    }
    if (typeof choice.text === 'string' && choice.text) return choice.text;
    if (typeof choice.delta === 'object' && choice.delta) {
      const text = asString(choice.delta.content);
      if (text) return text;
    }
  }
  return null;
}

function detectShape(obj) {
  // Shape 3 - langfuse: explicit input/output keys with no OpenAI-style
  // messages/response. Detected first because LiteLLM-via-langfuse rows can
  // still carry a stray `model` and would otherwise look ambiguous.
  const hasInputOutput =
    Object.prototype.hasOwnProperty.call(obj, 'input') ||
    Object.prototype.hasOwnProperty.call(obj, 'output');
  const hasMessagesOrResponse =
    Object.prototype.hasOwnProperty.call(obj, 'messages') ||
    Object.prototype.hasOwnProperty.call(obj, 'response');
  if (hasInputOutput && !hasMessagesOrResponse) return 'langfuse';

  // Shape 2 - SpendLogs: messages and/or response arrive as JSON strings,
  // and the row commonly carries startTime / endTime / spend columns.
  const messagesIsString = typeof obj.messages === 'string';
  const responseIsString = typeof obj.response === 'string';
  if (messagesIsString || responseIsString) return 'spendlogs';

  // Shape 1 - proxy log JSONL: messages array + response object.
  return 'proxy';
}

function fromProxyRow(obj) {
  const messages = Array.isArray(obj.messages) ? obj.messages : null;
  if (!messages || messages.length === 0) {
    return { error: 'messages array missing or empty' };
  }
  const input = flattenMessages(messages);
  if (!input) return { error: 'no non-assistant messages found' };
  const output =
    assistantFromResponse(obj.response) ||
    lastAssistantFromMessages(messages);
  if (output == null) return { error: 'no assistant content found in response or messages' };
  if (output === '') return { error: 'assistant content is empty' };
  return {
    input,
    output,
    usage:
      obj.response && typeof obj.response === 'object' && obj.response.usage && typeof obj.response.usage === 'object'
        ? obj.response.usage
        : null,
  };
}

function fromSpendLogsRow(obj) {
  const messages = tryJsonObject(obj.messages);
  const response = tryJsonObject(obj.response);
  const messagesArr = Array.isArray(messages) ? messages : null;
  if (!messagesArr || messagesArr.length === 0) {
    return { error: 'messages JSON missing, unparseable, or empty' };
  }
  const input = flattenMessages(messagesArr);
  if (!input) return { error: 'no non-assistant messages found' };
  const output =
    assistantFromResponse(response) ||
    lastAssistantFromMessages(messagesArr);
  if (output == null) return { error: 'no assistant content found in response or messages' };
  if (output === '') return { error: 'assistant content is empty' };
  return {
    input,
    output,
    usage:
      response && typeof response === 'object' && response.usage && typeof response.usage === 'object'
        ? response.usage
        : null,
  };
}

function langfuseSideToString(side) {
  // Langfuse input/output may be: a string, an array of message objects, a
  // single message object, or a wrapper like { messages: [...] }.
  if (side == null) return '';
  if (typeof side === 'string') return side;
  if (Array.isArray(side)) {
    const segments = [];
    for (const item of side) {
      if (typeof item === 'string') {
        if (item) segments.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        const role = typeof item.role === 'string' ? item.role : '';
        const text = asString(item.content != null ? item.content : item.text);
        if (text) segments.push(role ? rolePrefix(role) + text : text);
      }
    }
    return segments.join('\n');
  }
  if (typeof side === 'object') {
    if (Array.isArray(side.messages)) return langfuseSideToString(side.messages);
    if (typeof side.content === 'string') return side.content;
    if (typeof side.text === 'string') return side.text;
    if (Array.isArray(side.content)) return asString(side.content);
  }
  return '';
}

function fromLangfuseRow(obj) {
  const input = langfuseSideToString(obj.input);
  const output = langfuseSideToString(obj.output);
  if (!input) return { error: 'input side missing, unparseable, or empty' };
  if (!output) return { error: 'output side missing, unparseable, or empty' };
  // Langfuse rows sometimes carry usage on a top-level `usage` or `usageDetails`.
  let usage = null;
  if (obj.usage && typeof obj.usage === 'object') usage = obj.usage;
  else if (obj.usageDetails && typeof obj.usageDetails === 'object') usage = obj.usageDetails;
  return { input, output, usage };
}

function pickTimestamp(obj, fallbackTs) {
  // Accept the various timestamp keys LiteLLM emits across shapes.
  const candidates = [obj.timestamp, obj.startTime, obj.start_time, obj.created_at, obj.createdAt];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      // Heuristic: seconds vs ms since epoch.
      const ms = candidate > 1e12 ? candidate : candidate * 1000;
      try { return new Date(ms).toISOString(); } catch { /* fall through */ }
    }
  }
  return fallbackTs;
}

function pickRequestId(obj) {
  if (typeof obj.request_id === 'string' && obj.request_id) return obj.request_id;
  if (typeof obj.requestId === 'string' && obj.requestId) return obj.requestId;
  if (typeof obj.id === 'string' && obj.id) return obj.id;
  return null;
}

function pickApiBase(obj) {
  if (typeof obj.api_base === 'string' && obj.api_base) return obj.api_base;
  if (typeof obj.apiBase === 'string' && obj.apiBase) return obj.apiBase;
  return null;
}

function pickModel(obj) {
  // Preserve the full prefixed name (e.g. "azure/gpt-4o") verbatim - this is
  // load-bearing for downstream provenance.
  if (typeof obj.model === 'string' && obj.model) return obj.model;
  if (typeof obj.model_name === 'string' && obj.model_name) return obj.model_name;
  if (typeof obj.modelName === 'string' && obj.modelName) return obj.modelName;
  return null;
}

function toCaptureRow(obj, fallbackTs, namespace) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'row is not a JSON object' };
  }
  const shape = detectShape(obj);
  let extracted;
  if (shape === 'proxy') extracted = fromProxyRow(obj);
  else if (shape === 'spendlogs') extracted = fromSpendLogsRow(obj);
  else extracted = fromLangfuseRow(obj);
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
        model: pickModel(obj),
        request_id: pickRequestId(obj),
        api_base: pickApiBase(obj),
        usage: extracted.usage || null,
      },
    },
  };
}

/**
 * Parse a LiteLLM proxy log export string (JSONL).
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
 * Parse a LiteLLM proxy log export file (JSONL).
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
