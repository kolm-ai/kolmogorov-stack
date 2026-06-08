// W716 - capture-distribution stats for task-adaptive architecture search (TAAS).
//
// Pure analytic module. Given an array of capture rows (the same shape
// listCaptures returns) it produces a distribution profile the
// student-arch-recommender consumes:
//
//   - output_length       p50 / p95 / mean over response token-count proxies
//   - vocab_entropy_bits  Shannon entropy of the unigram distribution (top-5000)
//   - reasoning_chain_depth_avg
//                         average number of reasoning steps in a response
//                         (counts <think>...</think> blocks, paragraph
//                         breaks, and Step-marker regex matches)
//   - tool_use_rate       fraction of captures with non-empty tool_calls OR
//                         a JSON-shaped response (the "tool intent" proxy)
//   - task_complexity_proxy
//                         normalized composite [0..1] over the three signals
//                         above, used by the recommender's branch logic
//
// Honest empty contract: empty input returns n=0 with zero stats - the
// CLI surfaces this as `no_captures` and exits 3. NO synthesis of fake
// stats; no NaN; no silent zero-pad.

export const CAPTURE_STATS_VERSION = 'w716-v1';

// Maximum tokens we keep in the unigram counter. Real captures can dwarf
// the available memory if a single tenant has thousands of long responses;
// 5000 is the established cap for the v1 entropy estimator (W716 spec).
const VOCAB_TOP_K = 5000;

// =============================================================================
// Internal helpers (not exported - keep the public surface tight).
// =============================================================================

function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Cheap whitespace-split token count. Real tokenization is base-model specific
// (BPE / SentencePiece / etc.) but for the architecture recommender we just
// need a stable proxy that scales with response length.
function approxTokenCount(text) {
  if (!text) return 0;
  // Match consecutive non-whitespace runs; counts URLs/punctuation as one
  // token which is fine for length percentiles.
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

// Shannon entropy of a unigram distribution over the top-K tokens (cap is
// for perf - without it a tenant with millions of unique tokens explodes the
// counter). The cap biases entropy LOW (we throw away the long tail's
// contribution), which is the safe direction for the recommender - under-
// rather than over-estimating complexity.
function unigramEntropyBits(captures) {
  const counts = new Map();
  let total = 0;
  for (const cap of captures) {
    const text = toText(cap && cap.response);
    if (!text) continue;
    // Lowercase + alnum-run tokenization; same proxy as approxTokenCount but
    // we need the actual token values now, not just count.
    const toks = text.toLowerCase().match(/[a-z0-9]+/g);
    if (!toks) continue;
    for (const t of toks) {
      counts.set(t, (counts.get(t) || 0) + 1);
      total += 1;
    }
  }
  if (total === 0) return 0;
  // Keep top-K by count.
  let entries = Array.from(counts.entries());
  if (entries.length > VOCAB_TOP_K) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, VOCAB_TOP_K);
  }
  // Renormalize over kept tokens so the probabilities sum to 1.
  let keptTotal = 0;
  for (const [, c] of entries) keptTotal += c;
  if (keptTotal === 0) return 0;
  let H = 0;
  for (const [, c] of entries) {
    const p = c / keptTotal;
    if (p > 0) H -= p * Math.log2(p);
  }
  // Numeric guard. log2 with p extremely close to 0 can produce -0 cases.
  if (!Number.isFinite(H) || H < 0) return 0;
  return H;
}

// Count reasoning-step markers in a response. We sum three independent
// signals (think blocks, paragraph breaks, numbered steps) and pick the
// MAX so a response that uses any of the three conventions registers
// the same depth as one that uses all three.
function reasoningChainDepth(text) {
  if (!text) return 0;
  const thinkBlocks = (text.match(/<think>/gi) || []).length;
  // \n\n paragraph breaks; only count if the response actually has body
  // text (a single response with no \n\n is depth 1, not 0).
  const paragraphBreaks = (text.match(/\n\n+/g) || []).length;
  const paragraphDepth = paragraphBreaks > 0 ? paragraphBreaks + 1 : (text.trim() ? 1 : 0);
  // Step markers: "Step 1", "Step 2", ... or line-leading "1." "2." ...
  const stepMatches = text.match(/Step\s+\d+|^\s*\d+\.\s/gm) || [];
  const stepDepth = stepMatches.length;
  // MAX of the signals - never 0 for non-empty text.
  return Math.max(thinkBlocks, paragraphDepth, stepDepth);
}

// A capture counts as "tool use" if any of:
//   - it carries a non-empty tool_calls array
//   - its response parses as JSON (the "function-call response" proxy)
//   - the response text contains a fenced ```json block
function isToolUse(cap) {
  if (!cap) return false;
  if (Array.isArray(cap.tool_calls) && cap.tool_calls.length > 0) return true;
  const text = toText(cap.response).trim();
  if (!text) return false;
  // ```json fenced block
  if (/```json/i.test(text)) return true;
  // Bare JSON object/array
  if ((text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('[') && text.endsWith(']'))) {
    try {
      JSON.parse(text);
      return true;
    } catch { /* not actually JSON */ }
  }
  return false;
}

// Normalize a signal to [0..1] given a soft "high" anchor. We use a soft
// saturation (x / (x + anchor)) rather than a hard clip so the score keeps
// rising past the anchor without ever exceeding 1.
function softNorm(x, anchor) {
  const v = Number(x) || 0;
  if (v <= 0) return 0;
  return v / (v + anchor);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute the distribution profile of a capture set.
 *
 * @param {Array<object>} captures - capture rows (any source - listCaptures, raw JSONL, etc.)
 * @returns {{
 *   version: string,
 *   n: number,
 *   output_length: { p50: number, p95: number, mean: number },
 *   vocab_entropy_bits: number,
 *   reasoning_chain_depth_avg: number,
 *   tool_use_rate: number,
 *   task_complexity_proxy: number,
 * }}
 *
 * Honest empty: n=0 returns zeroed stats (never NaN, never null).
 */
export function computeCaptureStats(captures) {
  const list = Array.isArray(captures) ? captures.filter(Boolean) : [];
  if (list.length === 0) {
    return {
      version: CAPTURE_STATS_VERSION,
      n: 0,
      output_length: { p50: 0, p95: 0, mean: 0 },
      vocab_entropy_bits: 0,
      reasoning_chain_depth_avg: 0,
      tool_use_rate: 0,
      task_complexity_proxy: 0,
    };
  }

  // Output length distribution (in approx tokens).
  const lens = list.map((c) => approxTokenCount(toText(c.response)));
  const sortedLens = lens.slice().sort((a, b) => a - b);
  const p50 = percentile(sortedLens, 50);
  const p95 = percentile(sortedLens, 95);
  const meanLen = mean(lens);

  // Vocabulary entropy over the union of all responses.
  const vocabEntropy = unigramEntropyBits(list);

  // Reasoning chain depth (avg over per-capture max).
  const depths = list.map((c) => reasoningChainDepth(toText(c.response)));
  const reasoningAvg = mean(depths);

  // Tool-use rate.
  const toolHits = list.reduce((s, c) => s + (isToolUse(c) ? 1 : 0), 0);
  const toolRate = toolHits / list.length;

  // Composite [0..1] complexity proxy. Soft saturation against anchors:
  //   length p95 anchor = 1000 tokens (long-form responses)
  //   entropy anchor    = 10 bits   (a moderately diverse vocab)
  //   depth anchor      = 5 steps   (clear multi-step reasoning)
  // The three normalized signals are averaged (each in [0..1]) so the
  // composite stays in [0..1] without manual clipping.
  const lenNorm = softNorm(p95, 1000);
  const entropyNorm = softNorm(vocabEntropy, 10);
  const depthNorm = softNorm(reasoningAvg, 5);
  const composite = (lenNorm + entropyNorm + depthNorm) / 3;

  return {
    version: CAPTURE_STATS_VERSION,
    n: list.length,
    output_length: {
      p50: Math.round(p50 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      mean: Math.round(meanLen * 100) / 100,
    },
    vocab_entropy_bits: Math.round(vocabEntropy * 1000) / 1000,
    reasoning_chain_depth_avg: Math.round(reasoningAvg * 1000) / 1000,
    tool_use_rate: Math.round(toolRate * 1000) / 1000,
    task_complexity_proxy: Math.round(composite * 1000) / 1000,
  };
}

// Re-export internal helpers for testing only.
export const __internals = {
  approxTokenCount,
  percentile,
  mean,
  unigramEntropyBits,
  reasoningChainDepth,
  isToolUse,
  softNorm,
};
