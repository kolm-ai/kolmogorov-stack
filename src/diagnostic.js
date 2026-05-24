// W741 — Diagnostic envelope: structured per-category K-Score breakdown +
// linked actionable next-step recommendations.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 434-438):
//   [W741-1] "K-Score 0.72: student consistently fails on multi-turn
//            (samples 847, 1203, 1567). Add 100+ multi-turn captures."
//            => structured diagnostic envelope
//   [W741-2] Per-category K-Score breakdown
//   [W741-3] Fix suggestions linked to actionable next steps
//
// Design contract:
//   - PURE HEURISTIC. No LLM calls in this module. categorizeCaptures()
//     buckets by inferred category using existing fields (namespace,
//     tool_calls presence, media_kind, turn_count>1 multi-turn detection).
//   - Wilson 95% CI when n>=30; null when n<30 (honesty — no shaky bands).
//   - Recommendation rules are deterministic + lock-in tested.
//
// Public surface:
//   - DIAGNOSTIC_VERSION
//   - categorizeCaptures(captures) → {categories:[{name,count,sample_cids:[]}]}
//   - perCategoryKScore(captures, bakeoffResults) → per-category rollup
//   - generateDiagnostic(artifact_cid, bakeoffRows, captures) → full envelope

export const DIAGNOSTIC_VERSION = 'w741-v1';

// Per-category fix threshold. Below this k_score, the category is flagged
// for `capture_more` recommendation.
const K_SCORE_THRESHOLD = 0.85;
// Above this, ALL-category coverage triggers `promote_to_production`.
const K_SCORE_PROMOTE_THRESHOLD = 0.95;
// High-variance threshold (per-category stddev). Above this AND n>=30 →
// `adjust_temperature`. Spec: stddev > 0.15.
const VARIANCE_THRESHOLD = 0.15;
// Wilson CI is only meaningful at n>=30. Below this we return null bands.
const MIN_N_FOR_CI = 30;
// Recommendation priority order — high > medium > info (used by stable
// sort). Lower number = higher priority.
const PRIORITY_RANK = { high: 0, medium: 1, info: 2 };

// =============================================================================
// categorizeCaptures
//
// Bucket captures by inferred category using existing fields. No LLM calls.
//
// Inference rules (checked in order, first match wins):
//   - turn_count > 1                       → 'multi-turn'
//   - media_kind in {image,audio,video,pdf}→ '<media_kind>'
//   - Array.isArray(tool_calls) AND len>0  → 'tool-use'
//   - namespace present                    → namespace value
//   - default                              → 'general'
//
// Returns {categories:[{name, count, sample_cids:[]}]} sorted by count desc,
// then name asc for stable diff. sample_cids contains up to 3 capture cids
// per bucket (or event_id if cid absent) for fast spot-checking.
// =============================================================================

export function categorizeCaptures(captures) {
  const buckets = new Map();
  if (!Array.isArray(captures)) {
    return { categories: [] };
  }
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const cat = _inferCategory(cap);
    if (!buckets.has(cat)) buckets.set(cat, { name: cat, count: 0, sample_cids: [] });
    const b = buckets.get(cat);
    b.count += 1;
    if (b.sample_cids.length < 3) {
      const cid = cap.cid || cap.capture_cid || cap.event_id || cap.id;
      if (cid != null) b.sample_cids.push(String(cid));
    }
  }
  // Sort by count desc; tiebreak by name asc for stable diff.
  const categories = [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return { categories };
}

function _inferCategory(cap) {
  // multi-turn: explicit turn_count or implicit messages array
  const tc = cap.turn_count != null ? Number(cap.turn_count) : null;
  if (tc != null && tc > 1) return 'multi-turn';
  if (Array.isArray(cap.messages) && cap.messages.length > 1) return 'multi-turn';
  // media buckets
  if (typeof cap.media_kind === 'string' && cap.media_kind.length) {
    const mk = cap.media_kind.toLowerCase();
    if (mk === 'image' || mk === 'audio' || mk === 'video' || mk === 'pdf') return mk;
  }
  // tool-use
  if (Array.isArray(cap.tool_calls) && cap.tool_calls.length > 0) return 'tool-use';
  // explicit category override always wins above namespace, BELOW the
  // structural buckets so the test 'multi-turn' override still wins when
  // turn_count is the load-bearing signal.
  if (typeof cap.category === 'string' && cap.category.length) return cap.category;
  // namespace bucket
  if (typeof cap.namespace === 'string' && cap.namespace.length) return cap.namespace;
  return 'general';
}

// =============================================================================
// perCategoryKScore
//
// Join per-row bakeoff results to capture categories and roll up per category.
//
// captures: [{cid|capture_cid|event_id, ...categorization fields}]
// bakeoffResults: [{cid|capture_cid|event_id, k_score, pass}] — one per
//   capture that participated in the bakeoff
//
// Returns {categories:[{name, n, k_score, k_score_ci_lo, k_score_ci_hi,
//                       worst_sample_cids:[]}]}.
//
// Wilson 95% CI: only computed when n>=30 (MIN_N_FOR_CI). Otherwise both
// ci_lo and ci_hi are null (honest — don't claim CI on a tiny n).
// worst_sample_cids: lowest-k_score rows in the bucket (up to 3) so the
// caller has spot-check targets.
// =============================================================================

export function perCategoryKScore(captures, bakeoffResults) {
  if (!Array.isArray(captures) || !Array.isArray(bakeoffResults)) {
    return { categories: [] };
  }
  // Index bakeoff rows by capture id.
  const bakeIndex = new Map();
  for (const row of bakeoffResults) {
    if (!row || typeof row !== 'object') continue;
    const id = row.cid || row.capture_cid || row.event_id || row.id;
    if (id == null) continue;
    bakeIndex.set(String(id), row);
  }
  // Bucket captures + carry k_score per row.
  const buckets = new Map();
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const id = cap.cid || cap.capture_cid || cap.event_id || cap.id;
    if (id == null) continue;
    const bake = bakeIndex.get(String(id));
    if (!bake) continue;
    const k = Number(bake.k_score);
    if (!Number.isFinite(k)) continue;
    const cat = _inferCategory(cap);
    if (!buckets.has(cat)) buckets.set(cat, { name: cat, rows: [] });
    buckets.get(cat).rows.push({ cid: String(id), k_score: k });
  }
  const categories = [];
  for (const b of buckets.values()) {
    const n = b.rows.length;
    const mean = b.rows.reduce((s, r) => s + r.k_score, 0) / Math.max(1, n);
    // Wilson 95% CI on the mean (treat k_score as a 0..1 proportion). Skip
    // when n<MIN_N_FOR_CI — honesty floor.
    let ciLo = null;
    let ciHi = null;
    if (n >= MIN_N_FOR_CI) {
      const wilson = _wilson95(mean, n);
      ciLo = _round4(wilson.lo);
      ciHi = _round4(wilson.hi);
    }
    // Worst-sample cids: bottom 3 by k_score.
    const sorted = b.rows.slice().sort((a, b2) => a.k_score - b2.k_score);
    const worst_sample_cids = sorted.slice(0, 3).map((r) => r.cid);
    // Per-category stddev — used by `generateDiagnostic` for the
    // adjust_temperature rule. We surface it here so callers can chart
    // variance without re-iterating the rows array.
    const variance = b.rows.reduce((s, r) => s + Math.pow(r.k_score - mean, 2), 0) / Math.max(1, n);
    const stddev = Math.sqrt(variance);
    categories.push({
      name: b.name,
      n,
      k_score: _round4(mean),
      k_score_ci_lo: ciLo,
      k_score_ci_hi: ciHi,
      k_score_stddev: _round4(stddev),
      worst_sample_cids,
    });
  }
  // Sort by k_score asc (worst first).
  categories.sort((a, b) => a.k_score - b.k_score);
  return { categories };
}

// =============================================================================
// generateDiagnostic
//
// Full diagnostic envelope for an artifact_cid given (a) per-row bakeoff rows
// (each carries cid + k_score + pass) and (b) the captures those rows were
// generated against (so we can re-bucket by category here without trusting
// upstream labels).
//
// Returns:
//   {
//     ok:true,
//     diagnostic_version,
//     artifact_cid,
//     overall_k_score,
//     per_category: [...],
//     worst_categories: [...top 3],
//     recommendations: [
//       {action, category?, priority, reason, ...extras},
//       ...
//     ],
//     generated_at,
//   }
//
// Recommendation rules (deterministic — lock-in tested):
//   - Category k_score < 0.85 AND n < 200 →
//       {action:'capture_more', category, target_count: max(100, 200-n),
//        priority:'high', reason:'k_score 0.xx < threshold 0.85'}
//   - Overall k_score < 0.85 AND ALL categories above 0.85 →
//       {action:'inspect_captures', priority:'medium',
//        reason:'data quality issue — overall < 0.85 with no per-cat below'}
//   - Category k_score stddev > 0.15 AND n >= 30 →
//       {action:'adjust_temperature', category, from:0.7, to:0.4,
//        priority:'medium', reason:'high variance in <cat> category'}
//   - All categories >= 0.95 → single
//       {action:'promote_to_production', priority:'info',
//        reason:'all categories above 0.95'} — NOT combined with others.
// =============================================================================

export function generateDiagnostic(artifact_cid, bakeoffRows, captures) {
  const generated_at = new Date().toISOString();
  if (!artifact_cid || typeof artifact_cid !== 'string') {
    return {
      ok: false,
      error: 'artifact_cid_required',
      diagnostic_version: DIAGNOSTIC_VERSION,
      hint: 'pass artifact_cid as the first argument',
      generated_at,
    };
  }
  if (!Array.isArray(bakeoffRows) || bakeoffRows.length === 0) {
    return {
      ok: false,
      error: 'no_bakeoff_results_yet',
      diagnostic_version: DIAGNOSTIC_VERSION,
      artifact_cid,
      hint: 'run `kolm bakeoff` first against this artifact_cid, then retry',
      generated_at,
    };
  }
  const captureList = Array.isArray(captures) ? captures : [];
  const breakdown = perCategoryKScore(captureList, bakeoffRows);
  // Overall k_score = unweighted mean over bakeoff rows (so a tenant with a
  // long tail of small categories doesn't see overall == worst-category).
  const allK = bakeoffRows
    .map((r) => Number(r && r.k_score))
    .filter((k) => Number.isFinite(k));
  const overall_k_score = allK.length
    ? _round4(allK.reduce((s, k) => s + k, 0) / allK.length)
    : 0;

  // Top 3 worst categories (lowest k_score). breakdown already sorted asc.
  const worst_categories = breakdown.categories.slice(0, 3);

  // Build recommendations from the deterministic rules.
  const recommendations = _buildRecommendations({
    overall_k_score,
    perCategory: breakdown.categories,
  });

  return {
    ok: true,
    diagnostic_version: DIAGNOSTIC_VERSION,
    artifact_cid,
    overall_k_score,
    per_category: breakdown.categories,
    worst_categories,
    recommendations,
    generated_at,
  };
}

function _buildRecommendations({ overall_k_score, perCategory }) {
  const recs = [];
  if (!Array.isArray(perCategory) || perCategory.length === 0) {
    // No per-category data → only signal we can give is the overall, and we
    // can't recommend a specific fix without buckets.
    if (overall_k_score < K_SCORE_THRESHOLD) {
      recs.push({
        action: 'inspect_captures',
        priority: 'medium',
        reason: 'overall k_score ' + overall_k_score + ' < ' + K_SCORE_THRESHOLD
          + ' but no per-category buckets — likely empty/unbucketed captures',
      });
    }
    return recs;
  }

  // Rule 4 (special-case, single-issue): all categories >= 0.95 →
  // promote_to_production. Emit ALONE — no other recs.
  const allHigh = perCategory.every((c) => c.k_score >= K_SCORE_PROMOTE_THRESHOLD);
  if (allHigh) {
    return [{
      action: 'promote_to_production',
      priority: 'info',
      reason: 'all categories above ' + K_SCORE_PROMOTE_THRESHOLD,
    }];
  }

  // Rule 1: per-category capture_more when k_score < 0.85 AND n < 200.
  for (const cat of perCategory) {
    if (cat.k_score < K_SCORE_THRESHOLD && cat.n < 200) {
      const target_count = Math.max(100, 200 - cat.n);
      recs.push({
        action: 'capture_more',
        category: cat.name,
        target_count,
        priority: 'high',
        reason: 'k_score ' + cat.k_score + ' < threshold ' + K_SCORE_THRESHOLD,
      });
    }
  }

  // Rule 2: inspect_captures when overall < 0.85 AND ALL categories above 0.85.
  // Data-quality signal — every per-category bucket is healthy but the
  // unweighted mean isn't, so the row-level distribution must be skewed in
  // a way the category labels don't capture.
  if (overall_k_score < K_SCORE_THRESHOLD
      && perCategory.every((c) => c.k_score >= K_SCORE_THRESHOLD)) {
    recs.push({
      action: 'inspect_captures',
      priority: 'medium',
      reason: 'overall k_score ' + overall_k_score + ' < ' + K_SCORE_THRESHOLD
        + ' but every per-category k_score is above threshold',
    });
  }

  // Rule 3: adjust_temperature when per-category stddev > 0.15 AND n >= 30.
  for (const cat of perCategory) {
    if (cat.k_score_stddev != null
        && cat.k_score_stddev > VARIANCE_THRESHOLD
        && cat.n >= MIN_N_FOR_CI) {
      recs.push({
        action: 'adjust_temperature',
        category: cat.name,
        from: 0.7,
        to: 0.4,
        priority: 'medium',
        reason: 'high variance in ' + cat.name + ' category (stddev '
          + cat.k_score_stddev + ' > ' + VARIANCE_THRESHOLD + ')',
      });
    }
  }

  // Stable sort by priority (high > medium > info), preserving insertion
  // order within a priority tier.
  recs.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99));
  return recs;
}

// =============================================================================
// Helpers
// =============================================================================

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// Wilson 95% CI on a 0..1 proportion. n must be >= 1; caller is responsible
// for the n>=MIN_N_FOR_CI gate (this fn doesn't enforce honesty floors).
function _wilson95(p, n) {
  if (n < 1) return { lo: 0, hi: 0 };
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfwidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - halfwidth),
    hi: Math.min(1, center + halfwidth),
  };
}

export default {
  DIAGNOSTIC_VERSION,
  categorizeCaptures,
  perCategoryKScore,
  generateDiagnostic,
};
