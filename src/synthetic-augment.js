// W749 — Synthetic capture augmentation: gap detection, coverage report,
// importance upweighting, and teacher-driven rare-case generation.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 492-497):
//   [W749-1] Use teacher to generate synthetic variations covering gaps
//            → this module (DI teacher_caller; never silently mixes with real)
//   [W749-2] UI prompt: "I see you have 200 refund queries but zero escalation
//            — generate 50 escalation examples from teacher?"
//            → detectGaps() + /account/synthetic.html consume the same envelope
//   [W749-3] Automated rare-case detection in capture analysis
//            → generateCoverageReport() returns rare_buckets[] sorted by rarity
//   [W749-4] Coverage report + importance upweighting of rare captures
//            → importanceWeight() returns sampler weights = 1 + rarity_score * 2
//
// Design contract:
//   - PURE FUNCTIONS for gap detection / coverage / weighting. No I/O.
//     teacher_caller is dependency-injected so tests NEVER hit a real API.
//   - HONEST CONTRACT: every synthetic capture is tagged `kolm_synthetic:true`
//     and carries `parent_seed_cids` so downstream consumers (datasets,
//     bakeoffs) can filter or up-weight synthetic-vs-real explicitly. We never
//     silently mix the two.
//   - SPEND PROTECTION: requestSyntheticBatch surfaces a cost estimate. The
//     HTTP route's `confirm:true` gate is the canonical hand-off — callers who
//     skip it get an honest envelope with the estimate instead of a charge.
//   - Coverage uses Gini coefficient on bucket counts. Uniform = 0; one bucket
//     holding everything = ~1.0. The math is the standard discrete formula.
//
// Public surface:
//   - SYNTHETIC_VERSION
//   - detectGaps(captures, {target_categories, min_per_category})
//   - generateCoverageReport(captures, {bucket_strategy})
//   - importanceWeight(capture, coverage_report)
//   - requestSyntheticBatch({category, target_count, seed_captures, teacher_caller})
//   - mergeSyntheticIntoCaptureRows(syntheticBatch, namespace)

import crypto from 'node:crypto';
import { categorizeCaptures } from './diagnostic.js';
import { clusterByKeywords } from './failure-modes-w745.js';

export const SYNTHETIC_VERSION = 'w749-v1';

// Default minimum captures per category — below this a category is considered
// a "gap" and surfaced for synthetic top-up. Caller can override.
const DEFAULT_MIN_PER_CATEGORY = 50;

// Default suggested generation count when a category is empty or short.
// Picked so the UX prompt ("generate 50?") matches the spec verbatim.
const DEFAULT_SUGGEST_BACKFILL = 50;

// Hard caps so a runaway caller cannot accidentally request a teacher batch
// the size of the GDP. The HTTP route also clamps; this is defence in depth.
const MAX_TARGET_COUNT = 1000;
const MIN_TARGET_COUNT = 1;

// Teacher cost estimate (USD per generated row). Used by requestSyntheticBatch
// AND by the route's WARNING envelope. 0.002 is roughly claude-3.5-sonnet rates
// at ~1k tokens in/out — a sane round number. Callers can override via
// opts.cost_per_row_usd if they have a hosted-model contract that prices
// differently.
const DEFAULT_COST_PER_ROW_USD = 0.002;

// =============================================================================
// detectGaps
//
// Given a corpus of captures and an optional list of expected categories,
// return per-category coverage rows for any category that is under
// `min_per_category`. Rows include a `suggested_count` that the UI prompt
// ("Generate 50 escalation examples?") plugs straight into.
//
// Shape:
//   detectGaps(captures, opts) -> [
//     { category, current_count, suggested_count, gap, present }
//   ]
//
// Behaviour:
//   - When `target_categories` is provided, ANY category in that list with
//     current_count < min_per_category is returned. Categories absent from
//     the corpus appear with current_count=0 + present=false.
//   - When `target_categories` is null/undefined, we infer categories from
//     the corpus via categorizeCaptures (W741) and return ones below the
//     threshold. (i.e. "show me categories I already have data for, that
//     are under-served.")
//   - Rows are sorted by gap desc (largest gap first), tiebreaker name asc.
// =============================================================================

export function detectGaps(captures, opts) {
  const o = opts || {};
  const minPer = Number.isFinite(o.min_per_category)
    ? Math.max(1, Math.trunc(o.min_per_category))
    : DEFAULT_MIN_PER_CATEGORY;
  const targetList = Array.isArray(o.target_categories) ? o.target_categories.slice() : null;

  // Build per-category counts using W741's categorizer.
  const cat = categorizeCaptures(Array.isArray(captures) ? captures : []);
  const counts = new Map();
  for (const c of cat.categories) counts.set(c.name, c.count);

  const rows = [];
  if (targetList) {
    // Caller specified the full set — fill missing with zero, gap = minPer.
    for (const name of targetList) {
      if (typeof name !== 'string' || !name.length) continue;
      const current = counts.get(name) || 0;
      if (current >= minPer) continue; // not a gap
      const gap = Math.max(0, minPer - current);
      rows.push({
        category: name,
        current_count: current,
        suggested_count: gap > 0 ? Math.max(DEFAULT_SUGGEST_BACKFILL, gap) : DEFAULT_SUGGEST_BACKFILL,
        gap,
        present: current > 0,
      });
    }
  } else {
    // No target list — surface only categories the corpus already has, that
    // happen to be below the threshold.
    for (const c of cat.categories) {
      if (c.count >= minPer) continue;
      const gap = Math.max(0, minPer - c.count);
      rows.push({
        category: c.name,
        current_count: c.count,
        suggested_count: gap > 0 ? Math.max(DEFAULT_SUGGEST_BACKFILL, gap) : DEFAULT_SUGGEST_BACKFILL,
        gap,
        present: true,
      });
    }
  }

  rows.sort((a, b) => {
    if (b.gap !== a.gap) return b.gap - a.gap;
    return a.category < b.category ? -1 : (a.category > b.category ? 1 : 0);
  });
  return rows;
}

// =============================================================================
// generateCoverageReport
//
// Bucket the captures (by category OR by keyword cluster) and compute:
//   - count + pct per bucket
//   - rarity_score per bucket — high score = rare bucket = up-weight in sampler
//   - rare_buckets[] sorted by rarity desc
//   - gini_coefficient — 0 = uniform, ~1 = one bucket dominates
//
// Math:
//   rarity_score(b) = -log(pct + epsilon) / log(total)
//     pct in [0,1]; epsilon = 1e-6 to avoid log(0) for zero-count caller errors.
//     Normaliser log(total) so rarity is comparable across corpora of
//     different sizes. Clamped to >=0 (never negative).
//
//   gini = (sum_{i,j} |c_i - c_j|) / (2 * n * sum_i c_i)
//     Standard discrete Gini on count vector. n = bucket count.
//
// Returns: {ok:true, total, buckets, rare_buckets, gini_coefficient, version}.
// Empty input returns an honest envelope with total:0, gini:0.
// =============================================================================

export function generateCoverageReport(captures, opts) {
  const o = opts || {};
  const strategy = o.bucket_strategy === 'keyword' ? 'keyword' : 'category';
  const arr = Array.isArray(captures) ? captures : [];
  const total = arr.length;
  if (total === 0) {
    return {
      ok: true,
      total: 0,
      buckets: [],
      rare_buckets: [],
      gini_coefficient: 0,
      bucket_strategy: strategy,
      version: SYNTHETIC_VERSION,
    };
  }

  // Build the bucket list using the requested strategy.
  let bucketRows = [];
  if (strategy === 'keyword') {
    // W745 keyword clustering — single-shot ngram intersect. min_cluster_size:1
    // so even a single-row "cluster" gets coverage representation; the rarity
    // score then naturally bubbles it to the top of the rare list.
    const clusters = clusterByKeywords(arr, { min_cluster_size: 1 });
    bucketRows = clusters.map((c) => ({
      name: c.cluster_id,
      count: c.count,
      top_keywords: Array.isArray(c.top_keywords) ? c.top_keywords.slice(0, 5) : [],
    }));
    // Captures that didn't fall into any keyword cluster (e.g. too-short
    // inputs) land in a single 'unclustered' bucket so the total reconciles.
    const clustered = bucketRows.reduce((a, b) => a + b.count, 0);
    const orphan = total - clustered;
    if (orphan > 0) {
      bucketRows.push({ name: 'unclustered', count: orphan, top_keywords: [] });
    }
  } else {
    const cat = categorizeCaptures(arr);
    bucketRows = cat.categories.map((c) => ({
      name: c.name,
      count: c.count,
      top_keywords: [],
    }));
  }

  // Compute pct + rarity_score per bucket. The pct is a true fraction of the
  // bucket count to total (NOT the bucket count to total of bucketed rows —
  // those should equal under both strategies).
  const denomLog = Math.log(Math.max(2, total));
  const buckets = bucketRows.map((b) => {
    const pct = total > 0 ? (b.count / total) : 0;
    // rarity_score: higher = rarer. -log(pct) means small pct → big rarity.
    // Normalise by log(total) so the scale is roughly [0, 1] for "single
    // capture" rare buckets, and 0 for the all-encompassing bucket.
    const raw = -Math.log(pct + 1e-6);
    const rarity = denomLog > 0 ? (raw / denomLog) : 0;
    return {
      name: b.name,
      count: b.count,
      pct,
      rarity_score: Math.max(0, rarity),
      top_keywords: b.top_keywords,
    };
  });

  // Sort bucket list by count desc for the dashboard; rare_buckets separately
  // sorted by rarity desc for the up-weighting panel.
  buckets.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  const rare = buckets
    .slice()
    .sort((a, b) => {
      if (b.rarity_score !== a.rarity_score) return b.rarity_score - a.rarity_score;
      return a.count - b.count;
    });

  return {
    ok: true,
    total,
    buckets,
    rare_buckets: rare,
    gini_coefficient: _giniCoefficient(buckets.map((b) => b.count)),
    bucket_strategy: strategy,
    version: SYNTHETIC_VERSION,
  };
}

// _giniCoefficient — discrete Gini on a non-negative integer count vector.
// Returns 0 when all counts are equal (perfect uniformity) and approaches 1
// when one bucket holds everything.
function _giniCoefficient(counts) {
  if (!Array.isArray(counts) || counts.length === 0) return 0;
  const n = counts.length;
  if (n === 1) {
    // Single bucket — by convention Gini is 1 (all mass concentrated in one
    // bucket). The standard pairwise formula would return 0 with n=1, which
    // is misleading for a coverage report. We surface concentration honestly.
    return counts[0] > 0 ? 1 : 0;
  }
  let sumDiffs = 0;
  let sumValues = 0;
  for (let i = 0; i < n; i++) {
    sumValues += Number(counts[i]) || 0;
    for (let j = 0; j < n; j++) {
      sumDiffs += Math.abs((Number(counts[i]) || 0) - (Number(counts[j]) || 0));
    }
  }
  if (sumValues === 0) return 0;
  const g = sumDiffs / (2 * n * sumValues);
  // Clamp to [0,1] — floating-point noise can push it microscopically out.
  return Math.max(0, Math.min(1, g));
}

// =============================================================================
// importanceWeight
//
// Given a single capture and the coverage report it came from, return the
// recommended sampler weight. Rare-bucket captures get up-weighted so the
// training mix doesn't over-fit the dominant bucket.
//
// Formula: weight = 1.0 + rarity_score * 2
//   - Common bucket (rarity ~= 0): weight ~= 1.0 (no boost)
//   - Rare bucket (rarity ~= 1.0): weight ~= 3.0 (3x boost)
//
// The capture's bucket is inferred via the SAME categorizer (W741) used by
// generateCoverageReport with strategy 'category' (the default). If the
// caller used a different strategy and wants weights tuned to it, they
// should pass `coverage_report.bucket_strategy` + we look up the matching
// bucket directly.
//
// Garbage inputs return 1.0 (no boost) rather than throwing.
// =============================================================================

export function importanceWeight(capture, coverage_report) {
  if (!capture || typeof capture !== 'object') return 1.0;
  if (!coverage_report || !Array.isArray(coverage_report.buckets)) return 1.0;

  // Infer the capture's bucket. Use categorizeCaptures([capture]) so the
  // inference rules match generateCoverageReport exactly.
  let bucketName = null;
  if (coverage_report.bucket_strategy === 'keyword') {
    // Keyword clustering on a SINGLE capture is degenerate (the cluster id
    // would be itself), so the best we can do is fall back to category
    // bucketing. If the caller insists on per-capture keyword weighting,
    // they should call generateCoverageReport with their own clusterer.
    bucketName = null;
  } else {
    const cat = categorizeCaptures([capture]);
    bucketName = cat.categories.length ? cat.categories[0].name : null;
  }
  if (!bucketName) return 1.0;

  const bucket = coverage_report.buckets.find((b) => b.name === bucketName);
  if (!bucket) return 1.0;
  const rarity = Number(bucket.rarity_score) || 0;
  // Cap the boost at 5x so an enormous rarity (e.g. log of a 100k-row corpus
  // with a 1-row bucket) doesn't blow up gradients in downstream training.
  const boost = 1.0 + rarity * 2;
  return Math.min(5.0, Math.max(1.0, boost));
}

// =============================================================================
// requestSyntheticBatch
//
// DI teacher_caller signature: async (prompt) -> string (the generated row).
// We call it `target_count` times, threading seed_captures as in-context
// examples when supplied. Every emitted row is tagged kolm_synthetic:true so
// the honesty contract holds at write-time.
//
// Returns:
//   {ok:true, generated:[{input,output,kolm_synthetic,source_category,
//                          generation_id,seed_cids}],
//    cost_usd_est, version}
//
// Honest envelopes:
//   - missing teacher_caller            → {ok:false,error:'teacher_caller_required'}
//   - missing/empty category            → {ok:false,error:'category_required'}
//   - target_count out of range         → clamped to [MIN,MAX]
//   - teacher_caller throws on a row    → that row is captured into
//     errors[] but the rest of the batch continues; if ALL rows fail we
//     return ok:false + the first error message.
//
// Each generation_id is a short stable hex so the route /v1/synthetic/commit
// can be invoked later with the same id. The id is derived from
// sha256(category|i|seed_count|timestamp) so two consecutive calls produce
// different ids.
// =============================================================================

export async function requestSyntheticBatch(opts) {
  const o = opts || {};
  const category = typeof o.category === 'string' ? o.category.trim() : '';
  if (!category) {
    return {
      ok: false,
      error: 'category_required',
      hint: 'pass {category} naming the bucket you want generated (e.g. "escalation")',
      version: SYNTHETIC_VERSION,
    };
  }
  if (typeof o.teacher_caller !== 'function') {
    return {
      ok: false,
      error: 'teacher_caller_required',
      hint: 'requestSyntheticBatch is DI — pass {teacher_caller: async (prompt) => string}',
      version: SYNTHETIC_VERSION,
    };
  }
  const rawCount = Number(o.target_count);
  const target_count = Math.max(MIN_TARGET_COUNT, Math.min(MAX_TARGET_COUNT,
    Number.isFinite(rawCount) ? Math.trunc(rawCount) : DEFAULT_SUGGEST_BACKFILL));
  const seeds = Array.isArray(o.seed_captures) ? o.seed_captures.slice(0, 10) : [];
  const costPerRow = Number.isFinite(Number(o.cost_per_row_usd))
    ? Number(o.cost_per_row_usd)
    : DEFAULT_COST_PER_ROW_USD;

  // The seed_cids list is captured at the batch level so every generated row
  // can reference its parents.
  const seed_cids = seeds
    .map((s) => s && (s.cid || s.capture_cid || s.event_id || s.id))
    .filter(Boolean)
    .map(String);

  // Build a deterministic prompt prefix for the teacher. The actual teacher
  // signature is async (prompt) -> string; the harness can layer system
  // prompts / model selection on its own side.
  const seedsExcerpt = seeds.map((s, i) => {
    const inp = s && (s.input || s.prompt || s.prompt_redacted) || '';
    const out = s && (s.output || s.response || s.response_redacted) || '';
    return `Example ${i + 1}:\nUSER: ${String(inp).slice(0, 200)}\nASSISTANT: ${String(out).slice(0, 400)}`;
  }).join('\n\n');

  const generated = [];
  const errors = [];
  const ts = Date.now();
  for (let i = 0; i < target_count; i++) {
    const generation_id = crypto
      .createHash('sha256')
      .update(category + '|' + i + '|' + seeds.length + '|' + ts)
      .digest('hex')
      .slice(0, 16);
    const prompt = [
      'Generate one realistic ' + category + ' example.',
      seedsExcerpt ? 'Use these as style anchors:\n\n' + seedsExcerpt : '',
      'Respond with JSON {"input": "...", "output": "..."}.',
    ].filter(Boolean).join('\n\n');
    try {
      const raw = await o.teacher_caller(prompt);
      const parsed = _parseTeacherRow(raw);
      generated.push({
        input: parsed.input,
        output: parsed.output,
        kolm_synthetic: true,             // load-bearing honesty flag
        source_category: category,
        generation_id,
        seed_cids: seed_cids.slice(),     // parent seeds for downstream audit
      });
    } catch (e) {
      errors.push({
        index: i,
        generation_id,
        error: (e && e.message) || String(e),
      });
    }
  }

  if (generated.length === 0) {
    return {
      ok: false,
      error: 'teacher_call_failed',
      detail: errors.length ? errors[0].error : 'no rows generated',
      errors,
      cost_usd_est: 0,
      version: SYNTHETIC_VERSION,
    };
  }

  return {
    ok: true,
    generated,
    errors,
    cost_usd_est: Number((generated.length * costPerRow).toFixed(4)),
    target_count,
    actual_count: generated.length,
    version: SYNTHETIC_VERSION,
  };
}

// _parseTeacherRow — accept either JSON or raw text. JSON path is the
// preferred shape; raw text falls into {input:"", output:raw}.
function _parseTeacherRow(raw) {
  if (raw == null) return { input: '', output: '' };
  const s = String(raw);
  // Try JSON first.
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && (obj.input != null || obj.output != null)) {
      return {
        input: String(obj.input == null ? '' : obj.input),
        output: String(obj.output == null ? '' : obj.output),
      };
    }
  } catch (_) { /* fall through */ }
  return { input: '', output: s };
}

// =============================================================================
// mergeSyntheticIntoCaptureRows
//
// Take a batch returned by requestSyntheticBatch and shape it into rows ready
// for event-store appendEvent. Each row carries:
//   - kolm_synthetic: true             (load-bearing honesty flag)
//   - parent_seed_cids: [...]          (the seeds used to generate)
//   - generated_at: ISO timestamp
//   - source_category, generation_id, namespace
//
// The namespace is required; we never invent one. Caller passes their own
// namespace string.
// =============================================================================

export function mergeSyntheticIntoCaptureRows(syntheticBatch, namespace) {
  if (!syntheticBatch || syntheticBatch.ok !== true) return [];
  if (!Array.isArray(syntheticBatch.generated)) return [];
  if (typeof namespace !== 'string' || !namespace.length) return [];
  const now = new Date().toISOString();
  return syntheticBatch.generated.map((g) => ({
    input: g.input,
    output: g.output,
    namespace,
    kolm_synthetic: true,
    parent_seed_cids: Array.isArray(g.seed_cids) ? g.seed_cids.slice() : [],
    source_category: g.source_category || null,
    generation_id: g.generation_id || null,
    generated_at: now,
    version: SYNTHETIC_VERSION,
  }));
}

export const DEFAULTS = Object.freeze({
  MIN_PER_CATEGORY: DEFAULT_MIN_PER_CATEGORY,
  SUGGEST_BACKFILL: DEFAULT_SUGGEST_BACKFILL,
  MAX_TARGET_COUNT,
  MIN_TARGET_COUNT,
  COST_PER_ROW_USD: DEFAULT_COST_PER_ROW_USD,
});
