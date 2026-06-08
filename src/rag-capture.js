// W734 - RAG-aware distillation primitives.
//
// Closes W734-1/2/5 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md (lines 382-388):
//
//   W734-1: "Capture not just prompt + response, but retrieved context"
//           via the kolm-retrieved-context request header.
//   W734-2: "Student learns to generate correct responses given specific
//           context patterns" - training-data formatter that prefixes
//           retrieved chunks as <RETRIEVED> blocks.
//   W734-5: "Bakeoff axis: context-faithfulness" - TF-presence heuristic
//           used by src/bakeoff.js to score how much of the response is
//           grounded in the retrieved corpus.
//
// Design contract:
//
//   * PURE module. No I/O, no timers, no persistence. The capture row is
//     persisted by src/router.js + src/capture-store.js; this module only
//     parses the header, formats training rows, and computes the bakeoff
//     axis.
//   * Header is base64-encoded JSON so structured chunks survive HTTP
//     hop-to-hop without escaping nightmares. The decoded shape is an
//     array of {source, text, score?} items.
//   * Honest absence: a non-RAG request (no header) returns
//     {ok:true, retrieved:[]} - pure no-op, not an error. A malformed
//     header returns {ok:false, error:'invalid_header', hint:'...'} so
//     misconfigured callers fail loud.
//   * Privacy: we NEVER log raw retrieved text. Callers log
//     `retrieved.length` + per-item `source` URLs only. The raw `text`
//     fields stay in the persisted capture row (where they belong - they
//     are training data) and never appear in console / audit-log output.
//   * Additive: when a capture has no retrieved_context field, the
//     formatter falls through to the legacy USER/ASSISTANT format. Nothing
//     about the W734 change breaks existing distill flows.
//
// Public surface:
//
//   RAG_CAPTURE_VERSION
//   parseRetrievedContextHeader(req)
//   formatCaptureForTraining(capture)
//   extractRetrievedFromResponse(response_text, response_meta)

export const RAG_CAPTURE_VERSION = 'w734-v1';

// Largest header payload we will accept (base64 chars, pre-decode). 256 KiB
// is generous for "top-k=5 chunks of ~1KB each" while still bounding the
// allocation an attacker can force per request.
const MAX_HEADER_BYTES = 256 * 1024;

// Largest array length we will accept post-decode. Retrieval top-k rarely
// exceeds 50; anything above 500 is almost certainly a misconfiguration.
const MAX_RETRIEVED_ITEMS = 500;

// =============================================================================
// parseRetrievedContextHeader
// =============================================================================

/**
 * Parse the `kolm-retrieved-context` request header.
 *
 * The header is base64-encoded JSON containing an array of
 * `{source, text, score?}` items - one per retrieved chunk that the
 * calling RAG pipeline placed into the LLM's context window.
 *
 * Returns `{ok:true, retrieved:[...]}` on success, with each item
 * normalised so downstream consumers can rely on the shape:
 *
 *   { source: string, text: string, score: number | null }
 *
 * Returns `{ok:true, retrieved:[]}` when the header is absent - non-RAG
 * requests are the common case, so absence is NOT an error.
 *
 * Returns `{ok:false, error:'invalid_header', hint:'...'}` on malformed
 * input (bad base64, bad JSON, non-array, oversize, item missing
 * required fields). Honest envelope: the caller can decide whether to
 * surface the error to the user or just drop the field.
 */
export function parseRetrievedContextHeader(req) {
  const headers = (req && req.headers) || {};
  // Express lowercases header names. Accept the canonical lowercase form
  // and also tolerate the legacy MixedCase form some proxies inject.
  const raw = headers['kolm-retrieved-context']
    || headers['Kolm-Retrieved-Context']
    || headers['KOLM-RETRIEVED-CONTEXT']
    || null;
  if (raw == null || raw === '') {
    // Pure no-op for non-RAG requests. Honest empty array, not null.
    return { ok: true, retrieved: [] };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: 'invalid_header',
      hint: 'kolm-retrieved-context must be a base64 string; got non-string',
    };
  }
  if (raw.length > MAX_HEADER_BYTES) {
    return {
      ok: false,
      error: 'invalid_header',
      hint: `kolm-retrieved-context exceeds ${MAX_HEADER_BYTES} bytes; reduce top-k or chunk size`,
    };
  }
  // base64 decode. Buffer.from with 'base64' is lenient (skips whitespace),
  // so we sanity-check the round-trip to catch garbage that decoded to
  // partial bytes.
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch (e) {
    return {
      ok: false,
      error: 'invalid_header',
      hint: 'kolm-retrieved-context must be base64-encoded; decode failed',
    };
  }
  if (!decoded) {
    return {
      ok: false,
      error: 'invalid_header',
      hint: 'kolm-retrieved-context decoded to empty string',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (e) {
    return {
      ok: false,
      error: 'invalid_header',
      hint: 'kolm-retrieved-context base64 payload must be a JSON array of {source, text, score?}',
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'invalid_header',
      hint: 'kolm-retrieved-context must decode to a JSON array (got ' + typeof parsed + ')',
    };
  }
  if (parsed.length > MAX_RETRIEVED_ITEMS) {
    return {
      ok: false,
      error: 'invalid_header',
      hint: `kolm-retrieved-context exceeds ${MAX_RETRIEVED_ITEMS} items; trim top-k`,
    };
  }
  // Normalise each item. We tolerate missing `score` (returns null) but
  // require `source` (string) and `text` (string) - without those the
  // training-data formatter has nothing to anchor on.
  const retrieved = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        ok: false,
        error: 'invalid_header',
        hint: `kolm-retrieved-context item #${i} must be an object {source, text, score?}`,
      };
    }
    const source = item.source;
    const text = item.text;
    if (typeof source !== 'string' || !source) {
      return {
        ok: false,
        error: 'invalid_header',
        hint: `kolm-retrieved-context item #${i} missing required "source" string`,
      };
    }
    if (typeof text !== 'string') {
      return {
        ok: false,
        error: 'invalid_header',
        hint: `kolm-retrieved-context item #${i} missing required "text" string`,
      };
    }
    const score = (item.score == null) ? null
      : (Number.isFinite(Number(item.score)) ? Number(item.score) : null);
    retrieved.push({ source, text, score });
  }
  return { ok: true, retrieved };
}

// =============================================================================
// formatCaptureForTraining
// =============================================================================

/**
 * Render a capture row as a single training-data text block.
 *
 * When the capture carries a `retrieved_context` array, the output is
 * prefixed with `<RETRIEVED source=... score=...>` blocks (one per
 * chunk) so the student model learns to attend to the retrieved
 * passages when generating the response. Format:
 *
 *   <RETRIEVED source=docs.example.com score=0.92>
 *   <chunk text here>
 *   </RETRIEVED>
 *   <RETRIEVED source=docs.example.com/api score=0.88>
 *   <chunk text here>
 *   </RETRIEVED>
 *
 *   USER: <original prompt>
 *   ASSISTANT: <response>
 *
 * When the capture has no `retrieved_context` (or an empty array), the
 * formatter falls through to the legacy USER/ASSISTANT format. This is
 * the additive, non-breaking contract - existing distill flows keep
 * working untouched.
 *
 * Returns a string. Never throws (a defensive fallback handles even
 * pathological inputs so the training pipeline can keep moving).
 */
export function formatCaptureForTraining(capture) {
  if (!capture || typeof capture !== 'object') return '';
  const prompt = (typeof capture.prompt === 'string') ? capture.prompt
    : (typeof capture.input === 'string' ? capture.input : '');
  const response = (typeof capture.response === 'string') ? capture.response
    : (typeof capture.output === 'string' ? capture.output : '');
  const retrieved = Array.isArray(capture.retrieved_context) ? capture.retrieved_context : [];

  if (retrieved.length === 0) {
    // Legacy fall-through. Identical to the pre-W734 behaviour.
    return `USER: ${prompt}\nASSISTANT: ${response}`;
  }

  const parts = [];
  for (const item of retrieved) {
    if (!item || typeof item !== 'object') continue;
    const source = (typeof item.source === 'string') ? item.source : 'unknown';
    const text = (typeof item.text === 'string') ? item.text : '';
    const score = (item.score == null || !Number.isFinite(Number(item.score))) ? null : Number(item.score);
    // Escape angle brackets in the source URL so the tag opens cleanly.
    const safeSource = source.replace(/[<>]/g, '');
    if (score == null) {
      parts.push(`<RETRIEVED source=${safeSource}>`);
    } else {
      parts.push(`<RETRIEVED source=${safeSource} score=${score.toFixed(2)}>`);
    }
    parts.push(text);
    parts.push('</RETRIEVED>');
  }
  parts.push('');
  parts.push(`USER: ${prompt}`);
  parts.push(`ASSISTANT: ${response}`);
  return parts.join('\n');
}

// =============================================================================
// extractRetrievedFromResponse
// =============================================================================

/**
 * Heuristically pull retrieved-context chunks out of a response that
 * already inlined them.
 *
 * Some upstream APIs (Anthropic citations, OpenAI Assistants with
 * file_search, Perplexity, etc.) return retrieved chunks IN the
 * response body - either as a `<sources>` XML block, an
 * `attachments.citations[]` array on the response_meta, or as
 * `[1] https://...` style footnote markers.
 *
 * This extractor tries each shape and returns the first match. When
 * nothing matches it returns an empty array - never throws.
 *
 * The returned shape matches parseRetrievedContextHeader's output so
 * callers can compose: prefer header-supplied retrieved context, fall
 * back to response-extracted when absent.
 */
export function extractRetrievedFromResponse(response_text, response_meta) {
  const out = [];

  // 1) Response_meta citations array (Anthropic + OpenAI Assistants shape).
  if (response_meta && typeof response_meta === 'object') {
    const cits = Array.isArray(response_meta.citations) ? response_meta.citations
      : (Array.isArray(response_meta.attachments) ? response_meta.attachments : []);
    for (const c of cits) {
      if (!c || typeof c !== 'object') continue;
      const source = c.source || c.url || c.file || c.document_title || null;
      const text = c.text || c.snippet || c.quote || c.content || null;
      if (typeof source === 'string' && typeof text === 'string') {
        const score = (c.score == null) ? null
          : (Number.isFinite(Number(c.score)) ? Number(c.score) : null);
        out.push({ source, text, score });
      }
    }
    if (out.length > 0) return out;
  }

  // 2) <sources>...</sources> block parser. The convention:
  //
  //   <sources>
  //     <source url="https://docs.example.com" score="0.91">
  //       chunk text here
  //     </source>
  //     <source url="...">...</source>
  //   </sources>
  if (typeof response_text === 'string' && response_text.indexOf('<sources>') !== -1) {
    const block = response_text.match(/<sources>([\s\S]*?)<\/sources>/);
    if (block) {
      const inner = block[1];
      const re = /<source\s+([^>]*?)>([\s\S]*?)<\/source>/g;
      let m;
      while ((m = re.exec(inner)) !== null) {
        const attrs = m[1];
        const text = m[2].trim();
        const urlMatch = attrs.match(/url=["']([^"']+)["']/);
        const scoreMatch = attrs.match(/score=["']([^"']+)["']/);
        const source = urlMatch ? urlMatch[1] : null;
        const score = (scoreMatch && Number.isFinite(Number(scoreMatch[1]))) ? Number(scoreMatch[1]) : null;
        if (source && text) out.push({ source, text, score });
      }
    }
    if (out.length > 0) return out;
  }

  return out;
}

// =============================================================================
// computeContextFaithfulness - W734-5 bakeoff axis
// =============================================================================

/**
 * Compute a 0..1 context-faithfulness score for a single (response,
 * retrieved_context) pair. Used by src/bakeoff.js to add a
 * `context_faithfulness` column to bakeoff results when the captures
 * carry retrieved context.
 *
 * Heuristic v1: fraction of response tokens that ALSO appear in the
 * retrieved corpus. Token presence is case-folded + punctuation-stripped
 * + length-filtered (drops 1-char and 2-char tokens to avoid stop-word
 * noise dominating the score).
 *
 * Returns a number in [0, 1]. Returns `null` when retrieved_context is
 * absent or empty - honest absence, NOT 0. The bakeoff column treats
 * `null` distinctly from 0 in display + recommendation logic.
 *
 * This is intentionally a token-presence heuristic, not a semantic
 * embedding score. Semantic faithfulness is W734-future (it needs the
 * sentence-transformers worker that ships in a later wave).
 */
export function computeContextFaithfulness(response_text, retrieved_context) {
  if (!Array.isArray(retrieved_context) || retrieved_context.length === 0) {
    return null;
  }
  if (typeof response_text !== 'string' || !response_text.trim()) {
    // Empty response can't be faithful or unfaithful - honest absence.
    return null;
  }
  const responseTokens = _tokenize(response_text);
  if (responseTokens.length === 0) return null;
  const corpus = new Set();
  for (const item of retrieved_context) {
    if (!item || typeof item.text !== 'string') continue;
    for (const t of _tokenize(item.text)) corpus.add(t);
  }
  if (corpus.size === 0) return null;
  let present = 0;
  for (const t of responseTokens) {
    if (corpus.has(t)) present++;
  }
  const score = present / responseTokens.length;
  // Clamp into [0, 1] defensively. Division can't exceed 1 here but the
  // clamp guards against future heuristic shifts.
  return Math.max(0, Math.min(1, score));
}

// =============================================================================
// internal helpers
// =============================================================================

function _tokenize(s) {
  if (typeof s !== 'string') return [];
  // Case-fold, strip punctuation, split on whitespace, drop tokens shorter
  // than 3 chars (filters stop-words like "a/an/of/to/the" without needing
  // a language-specific list).
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

export default {
  RAG_CAPTURE_VERSION,
  parseRetrievedContextHeader,
  formatCaptureForTraining,
  extractRetrievedFromResponse,
  computeContextFaithfulness,
};
