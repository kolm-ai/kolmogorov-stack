// W918 P1.1 - OpenAI fine-tuning JSONL importer.
//
// Ingests an OpenAI fine-tuning JSONL file (either format) and emits kolm
// capture rows ready to feed into the distill / eval pipelines.
//
// Supported source formats
//   1. Chat-completions format (current OpenAI ft):
//        {"messages": [{"role":"system","content":"..."},
//                      {"role":"user","content":"..."},
//                      {"role":"assistant","content":"..."}]}
//   2. Legacy completion format (pre-2024 OpenAI ft):
//        {"prompt": "...", "completion": "..."}
//
// Emitted shape (one row per valid input line):
//   { id, ts, namespace, input, output,
//     meta: { source: "openai-finetune",
//             original_format: "chat" | "completion" } }
//
// id   = first 16 hex chars of sha256(input + "" + output)
// ts   = ISO 8601 ingest timestamp (single value per parse call)
// namespace defaults to "openai-finetune"; the caller can override.
//
// Malformed rows do NOT throw - they are skipped and recorded in the
// `errors` array as { line, reason } so the caller can surface them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_TAG = 'openai-finetune';
const DEFAULT_NAMESPACE = 'openai-finetune';
const ID_HEX_LEN = 16;

function rowId(input, output) {
  return crypto
    .createHash('sha256')
    .update(input + '' + output)
    .digest('hex')
    .slice(0, ID_HEX_LEN);
}

function asString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  // OpenAI chat content can be an array of content parts (text / image_url).
  // For ft text rows we only keep text segments; anything else is ignored.
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
  // Stable role tags so distill recipes downstream can split if they need to.
  switch (role) {
    case 'system': return '[system] ';
    case 'user': return '[user] ';
    case 'developer': return '[developer] ';
    case 'tool': return '[tool] ';
    case 'function': return '[function] ';
    default: return '[' + (role || 'unknown') + '] ';
  }
}

function fromChatRow(obj) {
  const messages = Array.isArray(obj.messages) ? obj.messages : null;
  if (!messages || messages.length === 0) {
    return { error: 'messages array missing or empty' };
  }
  // Collect input segments (system / user / developer / tool / function) in
  // order, take only the LAST assistant message as the target output.
  const inputs = [];
  let lastAssistant = null;
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
      continue;
    }
    if (m.role === 'assistant') {
      lastAssistant = asString(m.content);
      continue;
    }
    const text = asString(m.content);
    if (text) inputs.push(rolePrefix(m.role) + text);
  }
  if (inputs.length === 0) return { error: 'no non-assistant messages found' };
  if (lastAssistant == null) return { error: 'no assistant message found' };
  if (lastAssistant === '') return { error: 'assistant message is empty' };
  return {
    input: inputs.join('\n'),
    output: lastAssistant,
    original_format: 'chat',
  };
}

function fromCompletionRow(obj) {
  if (typeof obj.prompt !== 'string') {
    return { error: 'prompt field missing or not a string' };
  }
  if (typeof obj.completion !== 'string') {
    return { error: 'completion field missing or not a string' };
  }
  if (obj.prompt.length === 0) return { error: 'prompt is empty' };
  if (obj.completion.length === 0) return { error: 'completion is empty' };
  return {
    input: obj.prompt,
    output: obj.completion,
    original_format: 'completion',
  };
}

function toCaptureRow(obj, ts, namespace) {
  if (!obj || typeof obj !== 'object') {
    return { error: 'row is not a JSON object' };
  }
  let extracted;
  if (Array.isArray(obj.messages)) {
    extracted = fromChatRow(obj);
  } else if (typeof obj.prompt === 'string' || typeof obj.completion === 'string') {
    extracted = fromCompletionRow(obj);
  } else {
    return { error: 'row matches neither chat (messages) nor completion (prompt+completion) format' };
  }
  if (extracted.error) return { error: extracted.error };
  return {
    row: {
      id: rowId(extracted.input, extracted.output),
      ts,
      namespace,
      input: extracted.input,
      output: extracted.output,
      meta: {
        source: SOURCE_TAG,
        original_format: extracted.original_format,
      },
    },
  };
}

/**
 * Parse an OpenAI fine-tuning JSONL string.
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
  const ts = (opts.ts && String(opts.ts)) || new Date().toISOString();
  const rows = [];
  const errors = [];
  // Normalise line endings then split. Trailing newline produces a final
  // empty token that we just skip.
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
    const result = toCaptureRow(parsed, ts, namespace);
    if (result.error) {
      errors.push({ line: lineNo, reason: result.error });
      continue;
    }
    rows.push(result.row);
  }
  return { rows, errors };
}

/**
 * Parse an OpenAI fine-tuning JSONL file.
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
