// W918 P3.2 — Helicone request log export importer.
//
// Ingests a Helicone request-log export and emits kolm capture rows ready
// to feed into the distill / eval pipelines.
//
// Helicone has multiple export shapes in the wild — this importer handles
// three of them defensively, picking whichever shape matches each row:
//
//   1. Request-log JSONL (the documented export shape):
//        {
//          "id": "req-uuid",
//          "created_at": "2026-01-01T00:00:00Z",
//          "model": "gpt-4o",
//          "request":  { "messages": [ { "role": "user",      "content": "..." } ] },
//          "response": { "choices":  [ { "message": { "content": "..." } } ] },
//          "latency_ms": 1500,
//          "user_id": "...",
//          "properties": {...}
//        }
//
//   2. Raw OpenAI-proxy shape (Helicone's transparent proxy logs):
//        {
//          "id": "...",
//          "created_at": "...",
//          "model": "gpt-4o",
//          "request_body":  "{\"messages\":[...]}",
//          "response_body": "{\"choices\":[{\"message\":{\"content\":\"...\"}}]}",
//          "latency": 1500
//        }
//      (request_body / response_body are JSON-encoded strings.)
//
//   3. Flat CSV-via-JSONL shape (Helicone's CSV export converted to JSONL):
//        {
//          "id": "...",
//          "created_at": "...",
//          "model": "gpt-4o",
//          "prompt_text":     "user prompt here",
//          "completion_text": "assistant reply here",
//          "latency_ms": 1500
//        }
//
// Emitted shape (one row per valid input line):
//   { id, ts, namespace, input, output,
//     meta: { source: "helicone",
//             model, request_id, latency_ms, user_id } }
//
// id   = first 16 hex chars of sha256(input + "" + output)
// ts   = row.created_at if present, otherwise ISO 8601 ingest timestamp
// namespace defaults to "helicone"; the caller can override.
//
// Malformed rows do NOT throw — they are skipped and recorded in the
// `errors` array as { line, reason } so the caller can surface them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_TAG = 'helicone';
const DEFAULT_NAMESPACE = 'helicone';
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
  // OpenAI-style chat content can be an array of content parts
  // (text / image_url). For text capture rows we keep only text segments.
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

// Some Helicone exports embed request/response bodies as JSON-encoded
// strings; others embed them as objects. Normalise either to an object,
// or null if parsing fails.
function coerceBody(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_e) {
    return null;
  }
}

// Build the [role] prefixed input string from an OpenAI-style request body
// containing a `messages` array.
function inputFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const inputs = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') continue;
    if (typeof m.role !== 'string') continue;
    const text = asString(m.content);
    if (text) inputs.push(rolePrefix(m.role) + text);
  }
  return inputs.join('\n');
}

// Pull the assistant output text out of an OpenAI-style response body.
// Handles chat-completions (choices[].message.content) and legacy
// text-completions (choices[].text). Returns '' if nothing usable found.
function outputFromResponseBody(body) {
  if (!body || typeof body !== 'object') return '';
  const choices = Array.isArray(body.choices) ? body.choices : null;
  if (choices && choices.length > 0) {
    // Pick the last choice with a non-empty content, falling back to first.
    for (let i = choices.length - 1; i >= 0; i--) {
      const c = choices[i];
      if (!c || typeof c !== 'object') continue;
      if (c.message && typeof c.message === 'object') {
        const t = asString(c.message.content);
        if (t) return t;
      }
      if (typeof c.text === 'string' && c.text.length > 0) return c.text;
    }
  }
  // Anthropic-style: content array of { type:'text', text:'...' }.
  if (Array.isArray(body.content)) {
    const t = asString(body.content);
    if (t) return t;
  }
  // Some proxies stash the assistant text in `output_text` or `text`.
  if (typeof body.output_text === 'string' && body.output_text.length > 0) return body.output_text;
  if (typeof body.text === 'string' && body.text.length > 0) return body.text;
  return '';
}

// Shape #1: request-log JSONL — top-level `request` and `response` objects
// (already parsed, not strings).
function fromRequestLogRow(obj) {
  const req = obj.request && typeof obj.request === 'object' ? obj.request : null;
  const res = obj.response && typeof obj.response === 'object' ? obj.response : null;
  if (!req || !res) return { error: 'shape1: missing request or response object' };
  const input = inputFromMessages(req.messages);
  if (!input) return { error: 'shape1: no non-assistant messages in request.messages' };
  const output = outputFromResponseBody(res);
  if (!output) return { error: 'shape1: no assistant output in response' };
  return { input, output };
}

// Shape #2: raw OpenAI-proxy — request_body / response_body fields, which
// may be either strings (JSON-encoded) or already-parsed objects.
function fromRawProxyRow(obj) {
  const reqBody = coerceBody(obj.request_body);
  const resBody = coerceBody(obj.response_body);
  if (!reqBody || !resBody) return { error: 'shape2: missing or unparseable request_body / response_body' };
  const input = inputFromMessages(reqBody.messages);
  if (!input) return { error: 'shape2: no non-assistant messages in request_body.messages' };
  const output = outputFromResponseBody(resBody);
  if (!output) return { error: 'shape2: no assistant output in response_body' };
  return { input, output };
}

// Shape #3: flat CSV-via-JSONL — prompt_text + completion_text columns
// straight on the row object.
function fromFlatRow(obj) {
  const prompt = typeof obj.prompt_text === 'string' ? obj.prompt_text : null;
  const completion = typeof obj.completion_text === 'string' ? obj.completion_text : null;
  if (prompt == null || completion == null) {
    return { error: 'shape3: missing prompt_text or completion_text' };
  }
  if (prompt.length === 0) return { error: 'shape3: prompt_text is empty' };
  if (completion.length === 0) return { error: 'shape3: completion_text is empty' };
  return { input: prompt, output: completion };
}

function pickLatency(obj) {
  // Helicone's docs use latency_ms; their proxy logs use latency; some
  // exports use latencyMs. Accept the first numeric one.
  for (const k of ['latency_ms', 'latency', 'latencyMs']) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickTs(obj, fallbackTs) {
  // Prefer the row's own created_at, falling back to the parse-call ts.
  const t = obj.created_at;
  if (typeof t === 'string' && t.length > 0) return t;
  if (typeof t === 'number' && Number.isFinite(t)) return new Date(t).toISOString();
  return fallbackTs;
}

function pickRequestId(obj) {
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  if (typeof obj.request_id === 'string' && obj.request_id.length > 0) return obj.request_id;
  return null;
}

function pickModel(obj) {
  if (typeof obj.model === 'string' && obj.model.length > 0) return obj.model;
  return null;
}

function pickUserId(obj) {
  if (typeof obj.user_id === 'string' && obj.user_id.length > 0) return obj.user_id;
  if (typeof obj.user === 'string' && obj.user.length > 0) return obj.user;
  return null;
}

function toCaptureRow(obj, fallbackTs, namespace) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'row is not a JSON object' };
  }

  // Try each shape in order, keep the first reason on failure so the
  // caller sees the most-specific complaint for the most-likely shape.
  const attempts = [];
  let extracted = null;

  if (obj.request != null || obj.response != null) {
    const r = fromRequestLogRow(obj);
    if (!r.error) extracted = r;
    else attempts.push(r.error);
  }
  if (!extracted && (obj.request_body != null || obj.response_body != null)) {
    const r = fromRawProxyRow(obj);
    if (!r.error) extracted = r;
    else attempts.push(r.error);
  }
  if (!extracted && (obj.prompt_text != null || obj.completion_text != null)) {
    const r = fromFlatRow(obj);
    if (!r.error) extracted = r;
    else attempts.push(r.error);
  }

  if (!extracted) {
    const reason = attempts.length > 0
      ? attempts.join('; ')
      : 'row matches none of the 3 supported Helicone export shapes (request_log / raw_proxy / flat)';
    return { error: reason };
  }

  const ts = pickTs(obj, fallbackTs);
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
        latency_ms: pickLatency(obj),
        user_id: pickUserId(obj),
      },
    },
  };
}

/**
 * Parse a Helicone request-log export string (JSONL).
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
 * Parse a Helicone request-log export file.
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
