// W918 P3.4 - OpenRouter generation history importer.
//
// Ingests OpenRouter generation-history exports and emits kolm capture rows
// for the gateway-refugees wedge. OpenRouter ships history in two shapes:
//
//   1. Web-export JSON (the dashboard "Export" button). Either a bare array
//      of generation rows or a `{ "data": [...] }` wrapper:
//        [
//          { "id": "gen-abc123",
//            "model": "anthropic/claude-sonnet-4",
//            "created_at": 1748390400,
//            "tokens_prompt": 1234,
//            "tokens_completion": 567,
//            "total_cost": 0.012,
//            "latency": 1234,
//            "input":  { "messages": [{"role":"user","content":"..."}] },
//            "output": { "choices":  [{"message":{"role":"assistant","content":"..."}}] },
//            "finish_reason": "stop",
//            "usage": { "prompt_tokens": 1234, "completion_tokens": 567 } },
//          ...
//        ]
//
//   2. API JSONL stream (one generation row per line, same per-row shape as
//      above).
//
// Emitted KolmCaptureRow shape (one row per valid input row):
//   { source: "openrouter",
//     source_id: <row.id>,
//     ts: <ms_epoch number>,
//     model: <provider/slug string>,
//     messages: [{role, content}, ...],
//     response: { content, finish_reason },
//     usage: { prompt_tokens, completion_tokens, total_tokens },
//     cost_usd: <number|null>,
//     latency_ms: <number|null>,
//     meta: { /* raw provider fields kept for receipt provenance */ } }
//
// Malformed rows do NOT throw - they are skipped, counted in `skipped`, and
// recorded in `parseErrors` as { idx, reason } so the caller can surface them.

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_TAG = 'openrouter';

function asString(value) {
  // OpenRouter content can be a plain string, an OpenAI-style array of
  // typed parts (text / image_url), or an object with a `text` field.
  if (value == null) return '';
  if (typeof value === 'string') return value;
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

function pickTsMs(row) {
  // OpenRouter emits `created_at` as a unix-seconds integer; some web exports
  // emit a unix-millis integer or an ISO 8601 string. Normalise to ms epoch.
  const candidates = [row.created_at, row.createdAt, row.created, row.timestamp];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      // Heuristic: < 1e12 means seconds, >= 1e12 means millis.
      return c < 1e12 ? Math.round(c * 1000) : Math.round(c);
    }
    if (typeof c === 'string' && c.length > 0) {
      const n = Number(c);
      if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
      const t = Date.parse(c);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

function pickMessages(row) {
  // Input can sit on row.input.messages (chat-completions passthrough),
  // row.messages (already-flattened), or row.input as a plain prompt string.
  const input = row.input;
  if (input && typeof input === 'object' && Array.isArray(input.messages)) {
    return normaliseMessages(input.messages);
  }
  if (Array.isArray(row.messages)) {
    return normaliseMessages(row.messages);
  }
  if (typeof input === 'string' && input.length > 0) {
    return [{ role: 'user', content: input }];
  }
  if (input && typeof input === 'object' && typeof input.prompt === 'string' && input.prompt.length > 0) {
    return [{ role: 'user', content: input.prompt }];
  }
  if (typeof row.prompt === 'string' && row.prompt.length > 0) {
    return [{ role: 'user', content: row.prompt }];
  }
  return [];
}

function normaliseMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    const content = asString(m.content);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function pickResponse(row) {
  // Output sits on row.output.choices[0].message.content (chat-completions),
  // or row.output as a plain string, or row.response as either shape.
  const candidates = [row.output, row.response];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return { content: candidate, finish_reason: row.finish_reason || null };
    }
    if (typeof candidate !== 'object') continue;
    if (Array.isArray(candidate.choices) && candidate.choices.length > 0) {
      for (const choice of candidate.choices) {
        if (!choice || typeof choice !== 'object') continue;
        let text = '';
        if (choice.message && typeof choice.message === 'object') {
          text = asString(choice.message.content);
        }
        if (!text && typeof choice.text === 'string') text = choice.text;
        if (!text && choice.delta && typeof choice.delta === 'object') {
          text = asString(choice.delta.content);
        }
        if (text) {
          const finish = choice.finish_reason || row.finish_reason || null;
          return { content: text, finish_reason: finish };
        }
      }
    }
    if (typeof candidate.content === 'string' && candidate.content.length > 0) {
      return { content: candidate.content, finish_reason: row.finish_reason || null };
    }
    if (Array.isArray(candidate.content)) {
      const text = asString(candidate.content);
      if (text) return { content: text, finish_reason: row.finish_reason || null };
    }
    if (typeof candidate.text === 'string' && candidate.text.length > 0) {
      return { content: candidate.text, finish_reason: row.finish_reason || null };
    }
  }
  return null;
}

function pickUsage(row) {
  // Prefer the explicit `usage` object when present; otherwise synthesise
  // from the flat `tokens_prompt` / `tokens_completion` OpenRouter fields.
  const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
  const prompt =
    pickNumber(usage.prompt_tokens) ??
    pickNumber(usage.promptTokens) ??
    pickNumber(row.tokens_prompt) ??
    pickNumber(row.native_tokens_prompt);
  const completion =
    pickNumber(usage.completion_tokens) ??
    pickNumber(usage.completionTokens) ??
    pickNumber(row.tokens_completion) ??
    pickNumber(row.native_tokens_completion);
  let total = pickNumber(usage.total_tokens) ?? pickNumber(usage.totalTokens);
  if (total == null && prompt != null && completion != null) total = prompt + completion;
  return {
    prompt_tokens: prompt ?? null,
    completion_tokens: completion ?? null,
    total_tokens: total ?? null,
  };
}

function pickNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickCost(row) {
  // OpenRouter exposes `total_cost` in USD on web exports; the API uses
  // `usage.cost`. Either path may be absent (caller may have disabled cost
  // tracking) - null is fine.
  const candidates = [
    row.total_cost,
    row.totalCost,
    row.cost,
    row.usage && row.usage.cost,
    row.usage && row.usage.total_cost,
  ];
  for (const c of candidates) {
    const n = pickNumber(c);
    if (n != null) return n;
  }
  return null;
}

function pickLatencyMs(row) {
  // OpenRouter uses `latency` in milliseconds; some web exports use
  // `generation_time` or `latency_ms`. Accept any of them as a number.
  const candidates = [row.latency, row.latency_ms, row.latencyMs, row.generation_time];
  for (const c of candidates) {
    const n = pickNumber(c);
    if (n != null) return n;
  }
  return null;
}

function pickModel(row) {
  if (typeof row.model === 'string' && row.model.length > 0) return row.model;
  if (typeof row.model_name === 'string' && row.model_name.length > 0) return row.model_name;
  if (row.output && typeof row.output === 'object' && typeof row.output.model === 'string') {
    return row.output.model;
  }
  return null;
}

function pickSourceId(row) {
  if (typeof row.id === 'string' && row.id.length > 0) return row.id;
  if (typeof row.generation_id === 'string' && row.generation_id.length > 0) return row.generation_id;
  if (typeof row.request_id === 'string' && row.request_id.length > 0) return row.request_id;
  return null;
}

function buildMeta(row) {
  // Keep raw provider fields for receipt provenance - downstream verifiers
  // use these to attribute training data to the originating teacher call.
  const meta = {};
  const keysToKeep = [
    'provider',
    'origin',
    'app',
    'streamed',
    'cancelled',
    'native_finish_reason',
    'tokens_prompt',
    'tokens_completion',
    'native_tokens_prompt',
    'native_tokens_completion',
    'generation_time',
    'moderation_latency',
    'num_media_prompt',
    'num_media_completion',
    'finish_reason',
    'created_at',
  ];
  for (const k of keysToKeep) {
    if (Object.prototype.hasOwnProperty.call(row, k)) meta[k] = row[k];
  }
  return meta;
}

/**
 * Parse a single OpenRouter generation row.
 *
 * Returns either `{ row: KolmCaptureRow }` or `{ error: string }`. Used as
 * the per-row pipeline by `parse`; exported so callers ingesting one record
 * at a time can call it directly.
 *
 * @param {object} row
 * @returns {{ row?: object, error?: string }}
 */
export function parseRow(row) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    return { error: 'row is not a JSON object' };
  }
  const messages = pickMessages(row);
  if (messages.length === 0) {
    return { error: 'could not extract input messages from row' };
  }
  const response = pickResponse(row);
  if (!response || !response.content) {
    return { error: 'could not extract assistant response from row' };
  }
  return {
    row: {
      source: SOURCE_TAG,
      source_id: pickSourceId(row),
      ts: pickTsMs(row),
      model: pickModel(row),
      messages,
      response,
      usage: pickUsage(row),
      cost_usd: pickCost(row),
      latency_ms: pickLatencyMs(row),
      meta: buildMeta(row),
    },
  };
}

/**
 * Parse an OpenRouter generation history export.
 *
 * Auto-detects JSON array, JSONL, and `{ "data": [...] }` wrapped payloads.
 *
 * @param {string} text
 * @param {{ }} [opts]  reserved for future options
 * @returns {{ rows: object[], skipped: number, parseErrors: { idx: number, reason: string }[], source: 'openrouter' }}
 */
export function parse(text, _opts = {}) {
  const out = { rows: [], skipped: 0, parseErrors: [], source: SOURCE_TAG };
  if (typeof text !== 'string') {
    out.skipped = 1;
    out.parseErrors.push({ idx: 0, reason: 'input is not a string' });
    return out;
  }
  const trimmed = text.trim();
  if (trimmed === '') return out;

  // Try JSON-first: array, or { data: [...] } wrapper. Fall through to JSONL
  // on parse failure so a stray leading `{` does not break a JSONL stream.
  let arr = null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.data)) {
        arr = parsed.data;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.generations)) {
        arr = parsed.generations;
      } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // A single bare generation row pasted into a file - wrap it.
        arr = [parsed];
      }
    } catch (_e) {
      arr = null;
    }
  }

  if (arr) {
    for (let i = 0; i < arr.length; i++) {
      const result = parseRow(arr[i]);
      if (result.error) {
        out.skipped += 1;
        out.parseErrors.push({ idx: i, reason: result.error });
        continue;
      }
      out.rows.push(result.row);
    }
    return out;
  }

  // JSONL path - one JSON object per non-empty line.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let idx = -1;
  for (const raw of lines) {
    if (!raw || raw.trim() === '') continue;
    idx += 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      out.skipped += 1;
      out.parseErrors.push({
        idx,
        reason: 'invalid JSON: ' + (e && e.message ? e.message : String(e)),
      });
      continue;
    }
    const result = parseRow(parsed);
    if (result.error) {
      out.skipped += 1;
      out.parseErrors.push({ idx, reason: result.error });
      continue;
    }
    out.rows.push(result.row);
  }
  return out;
}

/**
 * Convenience: read a file from disk and parse it.
 *
 * @param {string} filePath
 * @param {{ }} [opts]
 * @returns {{ rows: object[], skipped: number, parseErrors: { idx: number, reason: string }[], source: 'openrouter' }}
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
