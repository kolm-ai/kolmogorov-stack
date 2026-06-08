// W711-1 - capture importance scorer.
//
// Wave 709 attached `routing_decision` (with entropy_summary) to every
// captured request. Wave 710 piped non-student rows into an active-learning
// queue. W711 closes the loop: rank each capture by training value so the
// downstream distiller can OVERSAMPLE the high-value rows via a
// WeightedRandomSampler instead of treating every capture equally.
//
// Score is a weighted blend of three signals:
//
//   token_density     = response_tokens / prompt_tokens, clamped to [0.1, 10].
//                       High density = "a lot of output from a little prompt"
//                       = pedagogically dense (the student has to learn how a
//                       short prompt expands into a long, structured response).
//
//   entropy_proxy     = if a W709 routing_decision is attached, use
//                       entropy_summary.max directly (already computed in the
//                       router). Otherwise we approximate via the
//                       unique-word-ratio of the response - a cheap stand-in
//                       for token-level entropy when routing wasn't logged.
//
//   novelty           = MinHash-style cosine distance between this capture's
//                       5-gram set and a rolling 1000-capture window. First
//                       capture scores 1.0 (maximally novel); duplicates drift
//                       to 0 as the window saturates with similar examples.
//                       Implemented per-scorer-instance (createScorerWindow)
//                       because the rolling window is the only stateful piece;
//                       scoreCapture(opts.window) accepts a window to thread
//                       state through pure-ish calls.
//
//   score = 0.4 * token_density_normalized + 0.35 * entropy_proxy + 0.25 * novelty
//
// Weights are deliberately conservative: token-density is the loudest signal
// (it doesn't depend on whether W709 routing was enabled), entropy_proxy is
// the most informed (when present), and novelty acts as a dedup-pressure
// breaker. v2 (planned post-W741 feedback aggregation) will retune from
// run-meta `importance_feedback` blocks.
//
// Honesty contract: scoreCapture NEVER throws. Missing fields yield
// neutral-midpoint components so a partially-populated capture still gets a
// rank, and the downstream sampler gets a finite weight for every row.

import crypto from 'node:crypto';

export const IMPORTANCE_VERSION = 'w711-v1';

const WEIGHT_TOKEN_DENSITY = 0.4;
const WEIGHT_ENTROPY = 0.35;
const WEIGHT_NOVELTY = 0.25;

const TOKEN_DENSITY_MIN = 0.1;
const TOKEN_DENSITY_MAX = 10;

// MinHash-style novelty uses 5-grams. 5 is the smallest window that captures
// stylistic fingerprints (smaller = bag-of-tokens; larger = needs long shared
// spans before novelty drops, which under-discriminates).
const NGRAM_K = 5;

// -------------------------------------------------------------------------
// Token counters. We do NOT pull a real tokenizer here (that would require
// torch+transformers in the JS path). The whitespace-split is a known
// underestimate (the BPE-equivalent multiplier is ~1.3x) - but the score is
// a RATIO, so the multiplier cancels and the ranking stays correct.
// -------------------------------------------------------------------------

function _countTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  // Split on whitespace; filter empty so leading/trailing space doesn't lie.
  let n = 0;
  for (const tok of text.split(/\s+/)) if (tok.length > 0) n++;
  return n;
}

// Extract prompt and response strings from a wide variety of capture shapes.
// W144/W709 events use {request,response}; some W454 captures use
// {messages:[...]} with role/content; tests sometimes pass {prompt,response}
// directly. We probe in priority order and stop at the first hit.
function _extractPromptResponse(capture) {
  if (!capture || typeof capture !== 'object') return { prompt: '', response: '' };
  // Direct path (test / scorer harness shape).
  if (typeof capture.prompt === 'string' && typeof capture.response === 'string') {
    return { prompt: capture.prompt, response: capture.response };
  }
  // Capture-event shape: { request: { messages|prompt }, response: { ... } }.
  let prompt = '';
  let response = '';
  if (capture.request && typeof capture.request === 'object') {
    if (typeof capture.request.prompt === 'string') prompt = capture.request.prompt;
    else if (Array.isArray(capture.request.messages)) {
      prompt = capture.request.messages
        .map(m => (m && typeof m.content === 'string') ? m.content : '')
        .filter(Boolean).join('\n');
    } else if (typeof capture.request.input === 'string') prompt = capture.request.input;
  }
  if (capture.response && typeof capture.response === 'object') {
    if (typeof capture.response.text === 'string') response = capture.response.text;
    else if (typeof capture.response.output === 'string') response = capture.response.output;
    else if (typeof capture.response.content === 'string') response = capture.response.content;
    else if (Array.isArray(capture.response.choices) && capture.response.choices.length > 0) {
      const c0 = capture.response.choices[0];
      if (c0 && c0.message && typeof c0.message.content === 'string') {
        response = c0.message.content;
      } else if (c0 && typeof c0.text === 'string') {
        response = c0.text;
      }
    }
  } else if (typeof capture.response === 'string') {
    response = capture.response;
  }
  // Fallbacks for older capture shapes:
  if (!prompt && typeof capture.input === 'string') prompt = capture.input;
  if (!response && typeof capture.output === 'string') response = capture.output;
  return { prompt, response };
}

// -------------------------------------------------------------------------
// 1. token_density
// -------------------------------------------------------------------------

function _computeTokenDensity(promptText, responseText) {
  const pTok = _countTokens(promptText);
  const rTok = _countTokens(responseText);
  if (pTok <= 0) {
    // Empty prompt + non-empty response: maximally dense (no input -> output).
    // Empty both: neutral midpoint.
    return rTok > 0 ? TOKEN_DENSITY_MAX : 1.0;
  }
  if (rTok <= 0) return TOKEN_DENSITY_MIN;
  const ratio = rTok / pTok;
  if (ratio < TOKEN_DENSITY_MIN) return TOKEN_DENSITY_MIN;
  if (ratio > TOKEN_DENSITY_MAX) return TOKEN_DENSITY_MAX;
  return ratio;
}

// Map [TOKEN_DENSITY_MIN, TOKEN_DENSITY_MAX] -> [0, 1] via log-scale so the
// long tail above ratio=1 doesn't dominate the linear blend. log10(10/0.1)=2.
function _normalizeTokenDensity(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const clamped = Math.max(TOKEN_DENSITY_MIN, Math.min(TOKEN_DENSITY_MAX, ratio));
  const log10 = Math.log(clamped) / Math.log(10);
  // Min log10 = -1, max log10 = 1 -> map to [0, 1].
  return (log10 + 1) / 2;
}

// -------------------------------------------------------------------------
// 2. entropy_proxy
// -------------------------------------------------------------------------

function _computeEntropyProxy(capture, responseText) {
  // Prefer the W709 routing-decision summary if present.
  const rd = capture && capture.routing_decision;
  if (rd && rd.entropy_summary && typeof rd.entropy_summary === 'object') {
    const m = Number(rd.entropy_summary.max);
    if (Number.isFinite(m) && m >= 0) {
      // entropy_summary.max can exceed 1.0 (it's nats, not normalized). Clamp
      // for the blend; the raw value lives in components for debugging.
      return Math.min(1.0, m);
    }
  }
  // Fallback: unique-word ratio of the response. A perfectly repetitive
  // response (e.g. "yes yes yes") scores low; a varied response scores high.
  if (typeof responseText !== 'string' || responseText.length === 0) return 0.5;
  const toks = responseText.toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return 0.5;
  const uniq = new Set(toks);
  return uniq.size / toks.length;
}

// -------------------------------------------------------------------------
// 3. novelty (MinHash-style cosine distance against a rolling window)
// -------------------------------------------------------------------------

function _shingles(text, k = NGRAM_K) {
  if (typeof text !== 'string' || text.length === 0) return new Set();
  // Word-level n-grams (not character) so stylistic structure surfaces.
  const toks = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return new Set();
  const out = new Set();
  if (toks.length < k) {
    // Short text: use a single shingle of the whole sequence so two equally
    // short identical texts collide cleanly.
    out.add(toks.join(' '));
    return out;
  }
  for (let i = 0; i <= toks.length - k; i++) {
    out.add(toks.slice(i, i + k).join(' '));
  }
  return out;
}

// Jaccard distance between two sets. Returns 1.0 for disjoint sets, 0.0 for
// identical, 0.5 for half-overlap. We use 1 - Jaccard as the "novelty" score
// because higher = more novel = more training value.
function _jaccardDistance(a, b) {
  if (!a || a.size === 0) return b && b.size > 0 ? 1.0 : 0.5;
  if (!b || b.size === 0) return 1.0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  if (union === 0) return 1.0;
  return 1 - (inter / union);
}

/**
 * Create a rolling novelty window. The returned object encapsulates the only
 * stateful piece of the scorer - pure scoreCapture() composes cleanly when
 * called with the window threaded through opts.window, or you can use the
 * object's own .score() / .add() methods directly.
 *
 * @param {number} maxSize  rolling window cap (default 1000)
 */
export function createScorerWindow(maxSize = 1000) {
  const cap = Math.max(1, Math.trunc(Number(maxSize) || 1000));
  /** @type {Array<{shingles: Set<string>}>} */
  const window = [];
  return {
    /**
     * Add a capture to the window WITHOUT scoring. Used to seed.
     */
    add(capture) {
      const { response } = _extractPromptResponse(capture);
      const sh = _shingles(response);
      window.push({ shingles: sh });
      if (window.length > cap) window.shift();
    },
    /**
     * Score a capture against the current window, then add it to the window
     * so subsequent calls see it as "already seen". Returns the same envelope
     * scoreCapture returns.
     */
    score(capture) {
      const out = scoreCapture(capture, { window: this });
      this.add(capture);
      return out;
    },
    clear() {
      window.length = 0;
    },
    // Expose for testing & introspection only.
    _peek() { return window.slice(); },
    _noveltyAgainst(capture) {
      const { response } = _extractPromptResponse(capture);
      const sh = _shingles(response);
      if (window.length === 0) return 1.0;
      // We want the MINIMUM Jaccard distance (= max similarity) - the most
      // similar prior capture is the one that bounds how novel this one is.
      let minDist = 1.0;
      for (const w of window) {
        const d = _jaccardDistance(sh, w.shingles);
        if (d < minDist) minDist = d;
      }
      return minDist;
    },
    size() { return window.length; },
  };
}

// -------------------------------------------------------------------------
// scoreCapture (the headline export)
// -------------------------------------------------------------------------

/**
 * Score a single capture for training value.
 *
 * @param {object} capture  capture row (W144/W709/W454 shape - best-effort
 *                          field extraction; never throws on unknown shape).
 * @param {object} [opts]
 * @param {object} [opts.window]  optional scorer window (createScorerWindow).
 *                                When absent, novelty defaults to 1.0 (treat
 *                                as maximally novel - the safe over-estimate
 *                                so a stateless caller never under-weights).
 * @returns {{
 *   score: number,
 *   components: {
 *     token_density: number,
 *     token_density_normalized: number,
 *     entropy_proxy: number,
 *     novelty: number,
 *   },
 *   version: string,
 * }}
 */
export function scoreCapture(capture, opts = {}) {
  const { prompt, response } = _extractPromptResponse(capture);
  const tokenDensity = _computeTokenDensity(prompt, response);
  const tokenDensityNorm = _normalizeTokenDensity(tokenDensity);
  const entropyProxy = _computeEntropyProxy(capture, response);
  let novelty = 1.0;
  if (opts && opts.window && typeof opts.window._noveltyAgainst === 'function') {
    novelty = opts.window._noveltyAgainst(capture);
  }
  const score =
    WEIGHT_TOKEN_DENSITY * tokenDensityNorm
    + WEIGHT_ENTROPY * entropyProxy
    + WEIGHT_NOVELTY * novelty;
  return {
    score,
    components: {
      token_density: tokenDensity,
      token_density_normalized: tokenDensityNorm,
      entropy_proxy: entropyProxy,
      novelty,
    },
    version: IMPORTANCE_VERSION,
  };
}

// -------------------------------------------------------------------------
// topN / bottomN (diagnostic surfacing + W741 hook)
// -------------------------------------------------------------------------

/**
 * Score `captures` (a list) and return the top-N by importance, descending.
 *
 * Single-pass through a shared scorer window so novelty is computed against
 * the running prefix - the FIRST capture is always the most novel (window is
 * empty), and subsequent duplicates get progressively lower novelty.
 *
 * @param {Array<object>} captures
 * @param {number} n
 * @returns {Array<{capture_id: string|null, score: number, components: object}>}
 */
export function topNByImportance(captures, n) {
  return _rankN(captures, n, 'desc');
}

/**
 * Mirror of topNByImportance for diagnostic surfacing of LOW-value captures
 * (candidates for dedup / drop on the next sweep).
 *
 * @param {Array<object>} captures
 * @param {number} n
 */
export function bottomNByImportance(captures, n) {
  return _rankN(captures, n, 'asc');
}

function _rankN(captures, n, direction) {
  if (!Array.isArray(captures) || captures.length === 0) return [];
  const cap = Math.max(0, Math.trunc(Number(n) || 0));
  if (cap === 0) return [];
  const win = createScorerWindow(Math.max(1000, captures.length));
  const scored = [];
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i];
    const r = win.score(c);
    scored.push({
      capture_id: _captureId(c, i),
      score: r.score,
      components: r.components,
    });
  }
  scored.sort((a, b) => direction === 'desc' ? (b.score - a.score) : (a.score - b.score));
  return scored.slice(0, cap);
}

function _captureId(capture, fallback_idx) {
  if (capture && typeof capture === 'object') {
    if (typeof capture.capture_id === 'string' && capture.capture_id.length > 0) return capture.capture_id;
    if (typeof capture.id === 'string' && capture.id.length > 0) return capture.id;
    if (typeof capture.event_id === 'string' && capture.event_id.length > 0) return capture.event_id;
    if (typeof capture.trace_id === 'string' && capture.trace_id.length > 0) return capture.trace_id;
  }
  return `capture_idx_${fallback_idx}`;
}

// -------------------------------------------------------------------------
// Helper: turn (capture, score) pairs into the JSONL row the Python trainer
// consumes. We expose this so the CLI can ship the file without re-implementing
// the contract.
// -------------------------------------------------------------------------

/**
 * Compute one importance-weights JSONL row per capture. The row shape is the
 * exact contract apps/trainer/distill.py reads when --importance-weights is
 * passed: {"capture_id": str, "importance": float in [0, 1]}.
 *
 * Score is normalized to [0, 1] by clamping (weights sum to 1.0, so the raw
 * score is already in [0, 1] in practice, but we clamp defensively).
 *
 * @param {Array<object>} captures
 * @returns {Array<{capture_id: string, importance: number, score: number, components: object}>}
 */
export function buildImportanceJsonlRows(captures) {
  if (!Array.isArray(captures) || captures.length === 0) return [];
  const win = createScorerWindow(Math.max(1000, captures.length));
  const out = [];
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i];
    const r = win.score(c);
    const importance = Math.max(0, Math.min(1, r.score));
    out.push({
      capture_id: _captureId(c, i),
      importance,
      score: r.score,
      components: r.components,
    });
  }
  return out;
}

// Stable hash for tests that want a deterministic "this scored the same twice"
// check. Used by tests and the report block alike.
export function hashScore(scoreEnvelope) {
  if (!scoreEnvelope || typeof scoreEnvelope !== 'object') return null;
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({
    score: scoreEnvelope.score,
    components: scoreEnvelope.components,
    version: scoreEnvelope.version,
  }));
  return h.digest('hex').slice(0, 16);
}

export default {
  IMPORTANCE_VERSION,
  scoreCapture,
  topNByImportance,
  bottomNByImportance,
  createScorerWindow,
  buildImportanceJsonlRows,
  hashScore,
};
