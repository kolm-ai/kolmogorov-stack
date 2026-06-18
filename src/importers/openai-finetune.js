// W918 P1.1 / W703 - OpenAI fine-tuning JSONL importer.
//
// Ingests OpenAI fine-tuning JSONL rows and emits Kolm capture rows ready for
// distill/eval pipelines. The parser is intentionally pure and bounded: it
// skips malformed rows, caps untrusted JSONL size/shape, and returns a
// digest-backed import envelope.
//
// Supported source formats:
//   1. Chat-completions format:
//        {"messages":[{"role":"system","content":"..."},
//                     {"role":"user","content":"..."},
//                     {"role":"assistant","content":"..."}]}
//   2. Legacy completion format:
//        {"prompt":"...","completion":"..."}
//
// Emitted row shape:
//   { id, ts, namespace, input, output,
//     meta: { source: "openai-finetune",
//             original_format: "chat" | "completion",
//             importer_version, source_line, input_sha256, output_sha256,
//             row_sha256 } }
//
// id = first 16 hex chars of sha256(input + "\x01" + output), preserving the
// legacy importer id contract while keeping the source file ASCII-clean.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OPENAI_FINETUNE_IMPORTER_VERSION = 'w703-openai-finetune-v1';
export const OPENAI_FINETUNE_CONTRACT_VERSION = 'w703-v1';

export const OPENAI_FINETUNE_LIMITS = Object.freeze({
  MAX_INPUT_BYTES: 16 * 1024 * 1024,
  MAX_FILE_BYTES: 16 * 1024 * 1024,
  MAX_LINES: 50000,
  MAX_LINE_BYTES: 1024 * 1024,
  MAX_MESSAGES_PER_ROW: 128,
  MAX_CONTENT_PARTS: 128,
  MAX_CONTENT_CHARS: 256000,
  MAX_NAMESPACE_CHARS: 128,
  MAX_ERRORS: 1000,
});

const SOURCE_TAG = 'openai-finetune';
const DEFAULT_NAMESPACE = 'openai-finetune';
const ID_HEX_LEN = 16;
const ROW_ID_SEPARATOR = '\x01';
const HEX64_RE = /^[a-f0-9]{64}$/;

const ROLE_PREFIXES = Object.freeze({
  system: '[system] ',
  user: '[user] ',
  developer: '[developer] ',
  assistant: '[assistant] ',
  tool: '[tool] ',
  function: '[function] ',
  unknown: '[unknown] ',
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function rowId(input, output) {
  return sha256(input + ROW_ID_SEPARATOR + output).slice(0, ID_HEX_LEN);
}

function rowDigest(input, output, originalFormat) {
  return sha256(stableJson({ input, output, original_format: originalFormat }));
}

function normalizeNamespace(value) {
  if (value == null || String(value).trim() === '') return { ok: true, namespace: DEFAULT_NAMESPACE };
  const namespace = String(value).trim();
  if (namespace.length > OPENAI_FINETUNE_LIMITS.MAX_NAMESPACE_CHARS) {
    return { ok: false, error: 'namespace_too_large' };
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(namespace)) {
    return { ok: false, error: 'namespace_invalid' };
  }
  return { ok: true, namespace };
}

function normalizeTimestamp(value) {
  if (value == null || String(value).trim() === '') {
    return { ok: true, ts: new Date().toISOString() };
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return { ok: false, error: 'timestamp_invalid' };
  return { ok: true, ts: new Date(parsed).toISOString() };
}

function normalizeRole(role) {
  if (typeof role !== 'string') return null;
  const clean = role.trim().toLowerCase();
  if (!clean) return null;
  return Object.prototype.hasOwnProperty.call(ROLE_PREFIXES, clean) ? clean : 'unknown';
}

function rolePrefix(role) {
  return ROLE_PREFIXES[normalizeRole(role) || 'unknown'];
}

function boundedText(value, codePrefix = 'content') {
  if (value == null) return { ok: true, text: '' };

  if (typeof value === 'string') {
    if (value.length > OPENAI_FINETUNE_LIMITS.MAX_CONTENT_CHARS) {
      return { ok: false, error: `${codePrefix}_too_large` };
    }
    return { ok: true, text: value };
  }

  if (Array.isArray(value)) {
    if (value.length > OPENAI_FINETUNE_LIMITS.MAX_CONTENT_PARTS) {
      return { ok: false, error: `${codePrefix}_too_many_parts` };
    }
    const parts = [];
    for (const part of value) {
      const next = boundedContentPart(part, codePrefix);
      if (!next.ok) return next;
      if (next.text) parts.push(next.text);
      if (parts.join('\n').length > OPENAI_FINETUNE_LIMITS.MAX_CONTENT_CHARS) {
        return { ok: false, error: `${codePrefix}_too_large` };
      }
    }
    return { ok: true, text: parts.join('\n') };
  }

  if (typeof value === 'object') {
    if (typeof value.text === 'string') return boundedText(value.text, codePrefix);
    if (typeof value.content === 'string') return boundedText(value.content, codePrefix);
    return { ok: true, text: '' };
  }

  return boundedText(String(value), codePrefix);
}

function boundedContentPart(part, codePrefix) {
  if (typeof part === 'string') return boundedText(part, codePrefix);
  if (part && typeof part === 'object') {
    if (typeof part.text === 'string') return boundedText(part.text, codePrefix);
    if (typeof part.content === 'string') return boundedText(part.content, codePrefix);
  }
  return { ok: true, text: '' };
}

function fromChatRow(obj) {
  const messages = Array.isArray(obj.messages) ? obj.messages : null;
  if (!messages || messages.length === 0) {
    return { error: 'messages_array_missing_or_empty' };
  }
  if (messages.length > OPENAI_FINETUNE_LIMITS.MAX_MESSAGES_PER_ROW) {
    return { error: 'messages_array_too_large' };
  }

  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && typeof m === 'object' && normalizeRole(m.role) === 'assistant') {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0) return { error: 'assistant_message_missing' };

  const target = boundedText(messages[targetIndex].content, 'assistant_content');
  if (!target.ok) return { error: target.error };
  if (target.text.trim() === '') return { error: 'assistant_message_empty' };

  const inputs = [];
  for (let i = 0; i < targetIndex; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const role = normalizeRole(m.role);
    if (!role) continue;
    const text = boundedText(m.content, 'message_content');
    if (!text.ok) return { error: text.error };
    if (text.text.trim() !== '') inputs.push(rolePrefix(role) + text.text);
  }

  if (inputs.length === 0) return { error: 'input_messages_missing' };
  return {
    input: inputs.join('\n'),
    output: target.text,
    original_format: 'chat',
  };
}

function fromCompletionRow(obj) {
  if (typeof obj.prompt !== 'string') return { error: 'prompt_field_missing_or_not_string' };
  if (typeof obj.completion !== 'string') return { error: 'completion_field_missing_or_not_string' };

  const prompt = boundedText(obj.prompt, 'prompt');
  if (!prompt.ok) return { error: prompt.error };
  const completion = boundedText(obj.completion, 'completion');
  if (!completion.ok) return { error: completion.error };

  if (prompt.text.trim() === '') return { error: 'prompt_empty' };
  if (completion.text.trim() === '') return { error: 'completion_empty' };
  return {
    input: prompt.text,
    output: completion.text,
    original_format: 'completion',
  };
}

function toCaptureRow(obj, ts, namespace, lineNo) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'row_not_json_object' };
  }

  let extracted;
  if (Array.isArray(obj.messages)) {
    extracted = fromChatRow(obj);
  } else if (typeof obj.prompt === 'string' || typeof obj.completion === 'string') {
    extracted = fromCompletionRow(obj);
  } else {
    return { error: 'row_matches_no_supported_openai_finetune_shape' };
  }
  if (extracted.error) return { error: extracted.error };

  const digest = rowDigest(extracted.input, extracted.output, extracted.original_format);
  const inputSha = sha256(extracted.input);
  const outputSha = sha256(extracted.output);
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
        importer_version: OPENAI_FINETUNE_IMPORTER_VERSION,
        source_line: lineNo,
        input_sha256: inputSha,
        output_sha256: outputSha,
        row_sha256: digest,
      },
    },
  };
}

function emptyResult(inputSha256 = null) {
  return {
    rows: [],
    errors: [],
    source: SOURCE_TAG,
    importer_version: OPENAI_FINETUNE_IMPORTER_VERSION,
    contract_version: OPENAI_FINETUNE_CONTRACT_VERSION,
    input_sha256: inputSha256,
    stats: {
      lines_seen: 0,
      lines_parsed: 0,
      rows_emitted: 0,
      rows_skipped: 0,
      errors_truncated: 0,
    },
    import_sha256: null,
  };
}

function pushError(out, line, code) {
  out.stats.rows_skipped += 1;
  if (out.errors.length >= OPENAI_FINETUNE_LIMITS.MAX_ERRORS) {
    out.stats.errors_truncated += 1;
    return;
  }
  out.errors.push({ line, code, reason: code });
}

function finalize(out) {
  out.stats.rows_emitted = out.rows.length;
  const digestRows = out.rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    namespace: row.namespace,
    original_format: row.meta.original_format,
    source_line: row.meta.source_line,
    row_sha256: row.meta.row_sha256,
  }));
  out.import_sha256 = sha256(stableJson({
    source: out.source,
    importer_version: out.importer_version,
    contract_version: out.contract_version,
    input_sha256: out.input_sha256,
    stats: out.stats,
    rows: digestRows,
    errors: out.errors,
  }));
  return out;
}

/**
 * Parse an OpenAI fine-tuning JSONL string.
 *
 * @param {string} text
 * @param {{ namespace?: string, ts?: string }} [opts]
 * @returns {{ rows: object[], errors: { line: number, reason: string, code?: string }[] }}
 */
export function parse(text, opts = {}) {
  const inputSha256 = typeof text === 'string' ? sha256(text) : null;
  const out = emptyResult(inputSha256);

  if (typeof text !== 'string') {
    pushError(out, 0, 'input_not_string');
    return finalize(out);
  }
  if (Buffer.byteLength(text, 'utf8') > OPENAI_FINETUNE_LIMITS.MAX_INPUT_BYTES) {
    pushError(out, 0, 'input_too_large');
    return finalize(out);
  }

  const namespace = normalizeNamespace(opts.namespace);
  if (!namespace.ok) {
    pushError(out, 0, namespace.error);
    return finalize(out);
  }
  const ts = normalizeTimestamp(opts.ts);
  if (!ts.ok) {
    pushError(out, 0, ts.error);
    return finalize(out);
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  out.stats.lines_seen = lines.length;
  if (lines.length > OPENAI_FINETUNE_LIMITS.MAX_LINES) {
    pushError(out, OPENAI_FINETUNE_LIMITS.MAX_LINES + 1, 'line_count_limit_exceeded');
    return finalize(out);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    if (Buffer.byteLength(raw, 'utf8') > OPENAI_FINETUNE_LIMITS.MAX_LINE_BYTES) {
      pushError(out, lineNo, 'line_too_large');
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      out.stats.lines_parsed += 1;
    } catch {
      pushError(out, lineNo, 'invalid_json');
      continue;
    }

    const result = toCaptureRow(parsed, ts.ts, namespace.namespace, lineNo);
    if (result.error) {
      pushError(out, lineNo, result.error);
      continue;
    }
    out.rows.push(result.row);
  }

  return finalize(out);
}

function makeFileError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function allowedRootsFromOpts(opts) {
  const raw = opts.allowed_roots ?? opts.allowedRoots;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((root) => typeof root === 'string' && root.trim() !== '')
    .map((root) => fs.realpathSync(path.resolve(root)));
}

function assertWithinAllowedRoots(realFile, allowedRoots) {
  if (allowedRoots.length === 0) return;
  const ok = allowedRoots.some((root) => realFile === root || realFile.startsWith(root + path.sep));
  if (!ok) throw makeFileError('openai_finetune_file_outside_allowed_roots');
}

/**
 * Parse an OpenAI fine-tuning JSONL file.
 *
 * @param {string} filePath
 * @param {{ namespace?: string, ts?: string, allowed_roots?: string[] }} [opts]
 * @returns {{ rows: object[], errors: { line: number, reason: string, code?: string }[] }}
 */
export function parseFile(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw makeFileError('ERR_INVALID_ARG', 'parseFile: filePath must be a non-empty string');
  }
  const abs = path.resolve(filePath);
  const real = fs.realpathSync(abs);
  assertWithinAllowedRoots(real, allowedRootsFromOpts(opts));

  const stat = fs.statSync(real);
  if (!stat.isFile()) throw makeFileError('openai_finetune_file_not_regular');
  if (stat.size > OPENAI_FINETUNE_LIMITS.MAX_FILE_BYTES) {
    throw makeFileError('openai_finetune_file_too_large');
  }

  return parse(fs.readFileSync(real, 'utf8'), opts);
}

export const _internal = Object.freeze({
  boundedText,
  normalizeNamespace,
  normalizeRole,
  normalizeTimestamp,
  rowDigest,
  rowId,
  stableJson,
});
