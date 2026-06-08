// W721 - TSAC compiler. Walks captured task attention traces and picks the
// cheapest sparsity pattern per (layer, head) that preserves quality.
//
// Companion to src/tsac-profile.js (schema + validators). The compiler is
// HEURISTIC-ONLY (per the wave brief: "NO heavy ML in Node - keep it pure
// compute"). Real per-head KL telemetry collection happens upstream during
// distillation; this module consumes the resulting attention_traces[] on
// each capture and emits a TSAC profile compatible with the
// workers/tsac/tsac.mjs kernel-selector stub.
//
// Algorithm:
//   For each (layer, head):
//     1. Walk captures[i].attention_traces (when present).
//     2. For each candidate prefill_pattern in DEFAULT_PREFILL_PATTERNS,
//        count captures whose attention map similarity to that pattern's
//        canonical signature exceeds the SIMILARITY_THRESHOLD (0.7).
//     3. Pick the pattern with the highest hit count (ties broken by the
//        order in DEFAULT_PREFILL_PATTERNS - dense first, then
//        vertical_slash, then blocked_local, etc.).
//     4. If no pattern hits > MIN_HITS_FOR_SPARSE captures, fall back to
//        vertical_slash with a high dense_fallback_threshold (the safety
//        net dispatches dense at serve time for this head until more
//        telemetry arrives).
//     5. Decode policy defaults to query_page_topk with page_topk=16
//        UNLESS the head is tagged is_safety_critical (then dense).
//
// The compiler is intentionally string-matching cheap - no embeddings, no
// learned classifiers, no Python dependency. The real cost discrimination
// lives in the serve-time kernel cost model, which is a future wave.
//
// Honesty contract:
//   * Insufficient captures (< 8) → {ok:false, error:'insufficient_captures_for_tsac'}.
//   * No captures carry attention_traces[] → {ok:false, error:'no_attention_telemetry'}.
//   * The returned profile is run through validateProfile before return - 
//     a programming error that produces an invalid entry fails loudly here.

import { canonicalJsonStringify, validateProfile, hashProfile } from './tsac-profile.js';

const MIN_CAPTURES = 8;
const SIMILARITY_THRESHOLD = 0.7;
const MIN_HITS_FOR_SPARSE = 1;

const DEFAULT_PAGE_TOPK = 16;
const DEFAULT_SINK_KEEP = 8;
const DEFAULT_LOCAL_WINDOW = 512;
const DEFAULT_DENSE_FALLBACK_THRESHOLD = 0.06;
const HIGH_DENSE_FALLBACK_THRESHOLD = 0.20;
const DEFAULT_QUALITY_GUARD = 'logit_delta_and_kscore';

// Canonical signature keys for each prefill pattern. The compiler asks
// each capture's attention_traces[] which signature it matches. The
// upstream attention-trace collector (a future wave) is responsible for
// labeling each per-head attention map with one of these signature
// strings; until that collector exists, callers can opt in by hand-
// labeling captures with attention_traces[].signature.
const PATTERN_SIGNATURES = Object.freeze({
  dense: ['dense', 'full_attention', 'uniform'],
  vertical_slash: ['vertical_slash', 'columnar', 'streaming-llm-like'],
  blocked_local: ['blocked_local', 'block_sparse', 'longformer-like'],
  sink_plus_local: ['sink_plus_local', 'sink', 'attention_sink', 'streamingllm'],
  head_pruned: ['head_pruned', 'near_zero', 'inactive', 'low_kl'],
});

/**
 * Compile a TSAC profile from task captures.
 *
 * @param {object} opts
 *   - task_name: string identifying the task this profile is compiled for
 *   - captures: array of capture rows. Each capture may carry
 *       attention_traces: [{ layer, head, signature, similarity?:0..1 }]
 *   - opts.num_layers, opts.num_heads: model dimensions. When omitted the
 *       compiler infers from the captured attention_traces.
 *   - opts.safety_critical_heads: optional Set of "layer:head" strings
 *       that MUST run dense on both axes.
 * @returns {{ok:true, profile, telemetry, warnings:[]} | {ok:false, error, hint}}
 */
export function compileTsacProfile({ task_name, captures, opts = {} }) {
  if (!task_name || typeof task_name !== 'string') {
    return {
      ok: false,
      error: 'invalid_task_name',
      hint: 'pass task_name:string identifying the task this profile covers',
    };
  }
  if (!Array.isArray(captures)) {
    return {
      ok: false,
      error: 'captures_not_array',
      hint: 'captures must be an array of capture rows',
    };
  }
  if (captures.length < MIN_CAPTURES) {
    return {
      ok: false,
      error: 'insufficient_captures_for_tsac',
      hint: `need at least ${MIN_CAPTURES} captures with attention traces (got ${captures.length})`,
    };
  }
  const hasAnyTraces = captures.some(
    (c) => c
      && Array.isArray(c.attention_traces)
      && c.attention_traces.length > 0,
  );
  if (!hasAnyTraces) {
    return {
      ok: false,
      error: 'no_attention_telemetry',
      hint: 'distill with --capture-attention or use buildDefaultProfile()',
    };
  }

  // Discover dimensions when not supplied.
  const dims = discoverDimensions(captures, opts);
  const safetySet = opts.safety_critical_heads instanceof Set
    ? opts.safety_critical_heads
    : new Set(Array.isArray(opts.safety_critical_heads)
        ? opts.safety_critical_heads
        : []);
  const warnings = [];

  // For each (layer, head), bucket captures by which signature they vote for.
  const hitCounts = new Map(); // key=`${l}:${h}` -> Map<patternName, hits>
  for (const cap of captures) {
    const traces = cap && Array.isArray(cap.attention_traces) ? cap.attention_traces : [];
    for (const trace of traces) {
      if (!trace || typeof trace !== 'object') continue;
      if (!Number.isInteger(trace.layer) || trace.layer < 0) continue;
      if (!Number.isInteger(trace.head) || trace.head < 0) continue;
      const key = `${trace.layer}:${trace.head}`;
      if (!hitCounts.has(key)) hitCounts.set(key, new Map());
      const bucket = hitCounts.get(key);
      const sim = typeof trace.similarity === 'number' ? trace.similarity : 1.0;
      if (sim < SIMILARITY_THRESHOLD) continue;
      const sig = String(trace.signature || '').toLowerCase();
      const patternName = matchSignatureToPattern(sig);
      if (!patternName) continue;
      bucket.set(patternName, (bucket.get(patternName) || 0) + 1);
    }
  }

  // Build one entry per (layer, head).
  const entries = [];
  let coveredHeadCount = 0;
  let fallbackHeadCount = 0;
  for (let layer = 0; layer < dims.num_layers; layer += 1) {
    for (let head = 0; head < dims.num_heads; head += 1) {
      const key = `${layer}:${head}`;
      const bucket = hitCounts.get(key);
      const isSafety = safetySet.has(key);
      let chosenPrefill;
      let chosenDecode;
      let denseFallback;
      if (isSafety) {
        chosenPrefill = 'dense';
        chosenDecode = 'dense';
        denseFallback = DEFAULT_DENSE_FALLBACK_THRESHOLD;
      } else if (bucket && bucket.size > 0) {
        chosenPrefill = pickBestPattern(bucket);
        // Decode policy is paired with prefill choice: head_pruned →
        // head_pruned_decode; everything sparse → query_page_topk; only
        // 'dense' prefill stays on dense decode.
        if (chosenPrefill === 'head_pruned') chosenDecode = 'head_pruned_decode';
        else if (chosenPrefill === 'dense') chosenDecode = 'dense';
        else chosenDecode = 'query_page_topk';
        denseFallback = DEFAULT_DENSE_FALLBACK_THRESHOLD;
        coveredHeadCount += 1;
      } else {
        // No telemetry hits for this head - start with vertical_slash and a
        // high dense fallback so the serve-time guard pulls back to dense
        // until more captures arrive.
        chosenPrefill = 'vertical_slash';
        chosenDecode = 'query_page_topk';
        denseFallback = HIGH_DENSE_FALLBACK_THRESHOLD;
        fallbackHeadCount += 1;
      }
      entries.push({
        task: task_name,
        layer,
        head,
        prefill_pattern: chosenPrefill,
        decode_policy: chosenDecode,
        page_topk: DEFAULT_PAGE_TOPK,
        sink_keep: DEFAULT_SINK_KEEP,
        local_window: DEFAULT_LOCAL_WINDOW,
        dense_fallback_threshold: denseFallback,
        quality_guard: DEFAULT_QUALITY_GUARD,
        is_safety_critical: isSafety,
      });
    }
  }

  if (fallbackHeadCount > 0) {
    warnings.push(`${fallbackHeadCount}/${entries.length} heads had no telemetry hits and ` +
      `defaulted to vertical_slash with dense_fallback_threshold=${HIGH_DENSE_FALLBACK_THRESHOLD}`);
  }

  const profile = {
    task: task_name,
    tsac_version: 'w721-v1',
    num_layers: dims.num_layers,
    num_heads: dims.num_heads,
    entries,
  };

  // Defense in depth - never return an invalid profile.
  const v = validateProfile(profile);
  if (!v.ok) {
    return {
      ok: false,
      error: 'internal_validation_failed',
      hint: 'compileTsacProfile produced an invalid profile - this is a bug',
      validation_errors: v.errors.slice(0, 10),
    };
  }

  return {
    ok: true,
    profile,
    telemetry: {
      captures_used: captures.length,
      heads_with_telemetry: coveredHeadCount,
      heads_fallback: fallbackHeadCount,
      profile_hash: hashProfile(profile),
    },
    warnings,
  };
}

// =============================================================================
// helpers
// =============================================================================

function discoverDimensions(captures, opts) {
  let num_layers = Number.isInteger(opts.num_layers) && opts.num_layers > 0
    ? opts.num_layers
    : 0;
  let num_heads = Number.isInteger(opts.num_heads) && opts.num_heads > 0
    ? opts.num_heads
    : 0;
  if (num_layers > 0 && num_heads > 0) return { num_layers, num_heads };
  let maxLayer = -1;
  let maxHead = -1;
  for (const cap of captures) {
    const traces = cap && Array.isArray(cap.attention_traces) ? cap.attention_traces : [];
    for (const trace of traces) {
      if (Number.isInteger(trace?.layer) && trace.layer > maxLayer) maxLayer = trace.layer;
      if (Number.isInteger(trace?.head) && trace.head > maxHead) maxHead = trace.head;
    }
  }
  if (num_layers === 0) num_layers = maxLayer + 1;
  if (num_heads === 0) num_heads = maxHead + 1;
  // Always leave at least one layer/head so the for-loop below produces output.
  if (num_layers <= 0) num_layers = 1;
  if (num_heads <= 0) num_heads = 1;
  return { num_layers, num_heads };
}

function matchSignatureToPattern(sigLower) {
  for (const [patternName, keywords] of Object.entries(PATTERN_SIGNATURES)) {
    for (const kw of keywords) {
      if (sigLower === kw || sigLower.includes(kw)) return patternName;
    }
  }
  return null;
}

function pickBestPattern(bucket) {
  // Iterate DEFAULT_PREFILL_PATTERNS in canonical order so ties resolve
  // deterministically (dense first → safest).
  const CANONICAL_ORDER = ['dense', 'vertical_slash', 'blocked_local', 'sink_plus_local', 'head_pruned'];
  let bestPattern = null;
  let bestCount = -1;
  // Find the max count first.
  for (const [pattern, count] of bucket.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestPattern = pattern;
    }
  }
  // Now resolve ties by canonical order (dense wins over vertical_slash
  // wins over blocked_local etc.).
  if (bestCount >= MIN_HITS_FOR_SPARSE) {
    for (const candidate of CANONICAL_ORDER) {
      if (bucket.get(candidate) === bestCount) {
        return candidate;
      }
    }
  }
  return bestPattern || 'vertical_slash';
}

// Re-export hashProfile for callers that need profile-stable hashes
// without importing the schema module directly.
export { hashProfile, canonicalJsonStringify };
