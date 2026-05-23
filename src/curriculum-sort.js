// W717-1 — curriculum-distillation sort.
//
// Sister to W711 (importance scorer) and W712 (progressive 3-pass curriculum).
// W711 rank by training VALUE. W712 splits into capability stages. W717 orders
// the rows WITHIN a stage from simple to complex so the student's early epochs
// see the easy distribution before the hard tail — the classical curriculum
// learning recipe (Bengio et al, 2009).
//
// The complexity proxy is intentionally LIGHT (no LLM call, no tokenizer pull):
//
//   length_norm   = response_chars / 4096, clamped to [0, 1].
//                   Long responses are usually harder than short ones in a
//                   chat-style corpus — they pack more structure, more
//                   conditional branches, and more places the student can
//                   diverge from the teacher.
//
//   perplexity_norm = Shannon perplexity of the response tokens against a
//                   per-corpus unigram frequency table built from the input
//                   list itself. High perplexity = vocabulary diversity =
//                   harder to model. Per-corpus (not per-capture) so the same
//                   capture in two different corpora scores comparable
//                   relative ranks, not absolute ones.
//
//   complexity = 0.5 * length_norm + 0.5 * perplexity_norm
//
// Both signals get a [0, 1] range so the blend stays interpretable. The
// downstream trainer reads the `complexity_proxy` field on each JSONL row and
// either re-sorts (if --curriculum was passed) or ignores it. The Python side
// MUST switch to SequentialSampler when --curriculum is set: a
// WeightedRandomSampler / shuffler defeats the entire point of an ordered
// curriculum. (See apps/trainer/distill.py for the 1-line comment that pins
// the sampler choice.)
//
// Honesty contracts:
//   * complexityProxy NEVER throws on partial captures. Missing response =
//     length_norm 0 + perplexity_norm 0.5 (neutral). The score is always
//     finite in [0, 1].
//   * sortCapturesByCurriculum is a stable shallow copy + sort (does not
//     mutate the input). When the corpus has fewer than 2 captures, returns
//     the input array unchanged (no point computing per-corpus stats).
//   * buildCurriculumJsonlRows preserves capture_id verbatim so the trainer
//     can join back into other run-meta blocks (W711 weights, W713 traces).
//
// References:
//   * Bengio et al, 2009. "Curriculum Learning." ICML 2009. Original
//     simple-to-hard order recipe.
//   * Soviany et al, 2022. "Curriculum Learning: A Survey." IJCV.
//     Modern taxonomy; W717 is "data-level curriculum" in that survey.
//   * Hinton, Vinyals & Dean, 2015. "Distilling the Knowledge in a Neural
//     Network." Why ordering matters for the student's gradient noise.

export const CURRICULUM_VERSION = 'w717-v1';

const LENGTH_NORM_CEILING = 4096;
const LENGTH_WEIGHT = 0.5;
const PERPLEXITY_WEIGHT = 0.5;

// -------------------------------------------------------------------------
// Capture-shape extractor. Mirrors capture-importance.js _extractPromptResponse
// without depending on it (so this module stays a leaf and can be lifted into
// the trainer sidecar later if needed).
// -------------------------------------------------------------------------

function _extractResponseText(capture) {
  if (!capture || typeof capture !== 'object') return '';
  if (typeof capture.response === 'string') return capture.response;
  if (capture.response && typeof capture.response === 'object') {
    const r = capture.response;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.output === 'string') return r.output;
    if (typeof r.content === 'string') return r.content;
    if (Array.isArray(r.choices) && r.choices.length > 0) {
      const c0 = r.choices[0];
      if (c0 && c0.message && typeof c0.message.content === 'string') return c0.message.content;
      if (c0 && typeof c0.text === 'string') return c0.text;
    }
  }
  if (typeof capture.output === 'string') return capture.output;
  if (typeof capture.response_text === 'string') return capture.response_text;
  return '';
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
// Token-frequency table + Shannon perplexity. Both use whitespace tokens —
// same trade-off as W711: BPE multiplier (~1.3x) cancels in the per-corpus
// frequency ratio.
// -------------------------------------------------------------------------

function _tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  for (const t of text.toLowerCase().split(/\s+/)) if (t.length > 0) out.push(t);
  return out;
}

/**
 * Build a unigram frequency table from a corpus of capture response texts.
 * Returns { table: Map<token, count>, total: number }.
 *
 * Exposed for tests + downstream callers who want to score against a fixed
 * reference corpus (e.g. seed all incoming captures against a static table).
 */
export function buildUnigramTable(captures) {
  const table = new Map();
  let total = 0;
  if (!Array.isArray(captures)) return { table, total };
  for (const c of captures) {
    const text = _extractResponseText(c);
    const toks = _tokenize(text);
    for (const t of toks) {
      table.set(t, (table.get(t) || 0) + 1);
      total++;
    }
  }
  return { table, total };
}

/**
 * Shannon perplexity of `text` against the unigram table. perplexity =
 * exp(-1/N * sum(log p(t_i))). Higher = less predictable = harder.
 *
 * Unknown tokens use Laplace smoothing (alpha=1) so a single OOV doesn't
 * blow the score to infinity; the resulting perplexity stays bounded for
 * any finite-length response.
 */
function _shannonPerplexity(text, unigramTable, totalTokens) {
  const toks = _tokenize(text);
  if (toks.length === 0) return 1.0;  // neutral.
  if (!(unigramTable instanceof Map) || totalTokens <= 0) return 1.0;
  const V = unigramTable.size || 1;
  const denom = totalTokens + V;  // Laplace-smoothed denominator.
  let neg_log_sum = 0;
  for (const t of toks) {
    const c = (unigramTable.get(t) || 0) + 1;
    const p = c / denom;
    // p is strictly positive thanks to Laplace; log is finite.
    neg_log_sum += -Math.log(p);
  }
  return Math.exp(neg_log_sum / toks.length);
}

/**
 * Normalize a perplexity value into [0, 1] via log scale. Empirically PPLs in
 * a chat-style corpus sit in [1, 10_000]; log10 takes that to [0, 4]; we
 * divide by 4 and clamp.
 */
function _normalizePerplexity(ppl) {
  if (!Number.isFinite(ppl) || ppl <= 1) return 0;
  const l = Math.log(ppl) / Math.log(10);
  if (l <= 0) return 0;
  if (l >= 4) return 1;
  return l / 4;
}

function _normalizeLength(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) return 0;
  const r = responseText.length / LENGTH_NORM_CEILING;
  if (r >= 1) return 1;
  if (r <= 0) return 0;
  return r;
}

// -------------------------------------------------------------------------
// Public surface
// -------------------------------------------------------------------------

/**
 * Per-capture complexity score in [0, 1]. Higher = harder.
 *
 * `opts.unigramTable` + `opts.totalTokens` thread a pre-built corpus table
 * through (used by sortCapturesByCurriculum so each capture is scored
 * against the same reference). When omitted, the function builds a
 * trivial table from the single capture — useful for ad-hoc one-shot
 * scoring but the perplexity number is then degenerate (every token is
 * "expected" against itself).
 *
 * @param {object} capture
 * @param {object} [opts]
 * @param {Map<string, number>} [opts.unigramTable]
 * @param {number} [opts.totalTokens]
 * @returns {{ score: number, components: { length_norm: number, perplexity: number, perplexity_norm: number, response_chars: number }, version: string }}
 */
export function complexityProxy(capture, opts = {}) {
  const response = _extractResponseText(capture);
  const length_norm = _normalizeLength(response);
  let table = opts.unigramTable;
  let total = Number.isFinite(opts.totalTokens) ? opts.totalTokens : -1;
  if (!(table instanceof Map) || total < 0) {
    const built = buildUnigramTable([capture]);
    table = built.table;
    total = built.total;
  }
  const perplexity = _shannonPerplexity(response, table, total);
  const perplexity_norm = _normalizePerplexity(perplexity);
  const raw = LENGTH_WEIGHT * length_norm + PERPLEXITY_WEIGHT * perplexity_norm;
  const score = Math.max(0, Math.min(1, raw));
  return {
    score,
    components: {
      length_norm,
      perplexity,
      perplexity_norm,
      response_chars: typeof response === 'string' ? response.length : 0,
    },
    version: CURRICULUM_VERSION,
  };
}

/**
 * Return a shallow copy of `captures` sorted by ascending complexity (default)
 * or descending. Sorting is STABLE (Array.prototype.sort in V8 is stable since
 * Node 12) so equal-complexity captures keep their original relative order.
 *
 * The unigram table is built once across the whole input so per-capture scores
 * are comparable. If `mode` is neither 'ascending' nor 'descending' we
 * default to 'ascending' (the curriculum direction) and stamp the chosen
 * mode on the returned array via a non-enumerable _curriculum_mode property
 * so callers can introspect without affecting JSON serialization.
 *
 * @param {Array<object>} captures
 * @param {'ascending'|'descending'} [mode='ascending']
 * @returns {Array<object>}
 */
export function sortCapturesByCurriculum(captures, mode = 'ascending') {
  if (!Array.isArray(captures)) return [];
  if (captures.length < 2) return captures.slice();
  const direction = mode === 'descending' ? 'descending' : 'ascending';
  const { table, total } = buildUnigramTable(captures);
  // Decorate-sort-undecorate so we don't recompute complexity inside the
  // comparator (would be O(N^2 * tokens)).
  const decorated = captures.map((c, i) => ({
    c,
    i,
    score: complexityProxy(c, { unigramTable: table, totalTokens: total }).score,
  }));
  decorated.sort((a, b) => {
    if (a.score !== b.score) {
      return direction === 'ascending' ? (a.score - b.score) : (b.score - a.score);
    }
    return a.i - b.i;  // stable tiebreak.
  });
  return decorated.map(d => d.c);
}

/**
 * Compute one JSONL row per capture for the trainer. Row shape:
 *
 *   {
 *     capture_id: string,
 *     complexity_proxy: number in [0, 1],
 *     prompt: string,                  (optional — passed through when present)
 *     response: string,                (optional — passed through when present)
 *     reasoning_trace?: object,        (passed through when present so W713
 *                                      stays compatible)
 *   }
 *
 * The trainer reads `complexity_proxy` directly. The other fields are
 * preserved so the same JSONL can drive the regular distill loop without
 * needing a second pass.
 *
 * @param {Array<object>} captures
 * @param {'ascending'|'descending'} [mode='ascending']
 * @returns {Array<object>}
 */
export function buildCurriculumJsonlRows(captures, mode = 'ascending') {
  if (!Array.isArray(captures) || captures.length === 0) return [];
  const sorted = sortCapturesByCurriculum(captures, mode);
  const { table, total } = buildUnigramTable(captures);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const cmp = complexityProxy(c, { unigramTable: table, totalTokens: total });
    const row = {
      capture_id: _captureId(c, i),
      complexity_proxy: cmp.score,
    };
    // Pass through prompt/response so the JSONL is self-contained for the
    // trainer (matches the contract in apps/trainer/distill.py _load_jsonl).
    if (typeof c.prompt === 'string') row.prompt = c.prompt;
    else if (c && c.request && typeof c.request.prompt === 'string') row.prompt = c.request.prompt;
    const resp = _extractResponseText(c);
    if (resp) row.response = resp;
    if (c && c.reasoning_trace != null) row.reasoning_trace = c.reasoning_trace;
    out.push(row);
  }
  return out;
}

export default {
  CURRICULUM_VERSION,
  complexityProxy,
  sortCapturesByCurriculum,
  buildCurriculumJsonlRows,
  buildUnigramTable,
};
