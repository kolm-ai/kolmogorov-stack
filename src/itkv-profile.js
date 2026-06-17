// W722 - Importance-Tiered KV Cache (ITKV) profile schema + token-class scorer.
//
// Closes Invention 4 from docs/research/kolm-billion-dollar-distillation-lab-
// 2026-05-24.md (lines 1434-1466). Agent and RAG workloads repeat system
// prompts, policies, schemas, tool descriptions, and retrieved context. KV
// cache memory should be allocated by IMPORTANCE, not uniform recency.
//
// Token classes (research doc lines 1444-1454):
//
//   sink - high precision, never evict during session
//   policy - high precision, long TTL
//   schema - high precision or int8, reusable
//   retrieved_evidence - precision by citation confidence
//   conversation_recent - high precision, recency window
//   boilerplate - low precision or prefix cache
//   irrelevant_span - compress or evict
//
// Default precision policy (research doc lines 1458-1460):
//
//   recent BF16 + sink BF16 + policy FP8/INT8 + warm INT8 + cold INT4/offload
//
// Acceptance criteria (research doc lines 1462-1466):
//
//   - Memory reduction without lower citation precision
//   - Prefix cache reuse for repeated enterprise workflows
//   - Clear route/event telemetry for cache hits, compression tier, fallback
//
// Honesty contract: this module ships the PROFILE SCHEMA + TOKEN-CLASS SCORER.
// W621 threads the profile into src/serve-config.js KV policy params so serve
// dispatch and passports can bind the profile hash. Token-level runtime tier
// enforcement still belongs to the upstream cache executor (vLLM PagedAttention,
// SGLang radix cache, Shard/kvpress sidecars), not this pure classifier. The
// worker stub in workers/itkv/ ships the same classifier so those runtimes can
// call it as a sidecar.
//
// JS/Python parity: workers/itkv/scripts/itkv.py is a verbatim port of
// classifyToken. If you must diverge, document the reason in BOTH file
// headers. The W722 test suite asserts byte-identical outputs between the
// two implementations when both are present on PATH.

import crypto from 'node:crypto';

// Version stamp. Bound into any manifest slot that records the ITKV profile,
// so a verifier can detect a schema-incompatible profile.
export const ITKV_VERSION = 'w722-v1';

// The seven token classes from the research doc (lines 1444-1454). Ordering
// matters for the deterministic fallthrough in classifyToken - sink (position)
// comes first, irrelevant_span (fallthrough) comes last.
export const TOKEN_CLASSES = Object.freeze([
  'sink',
  'policy',
  'schema',
  'retrieved_evidence',
  'conversation_recent',
  'boilerplate',
  'irrelevant_span',
]);

// Precision tiers from the research doc (line 1458). Ordered high-to-low so
// callers iterating the array see most-expensive-first; estimateMemoryReduction
// uses BYTES_PER_TOKEN_BY_TIER for numeric weight.
export const PRECISION_TIERS = Object.freeze([
  'bf16',
  'fp8',
  'int8',
  'int4',
  'offload',
]);

// Bytes-per-token-per-layer for each tier. BF16 = 2 bytes (the runtime
// baseline). FP8 = 1 byte. INT8 = 1 byte. INT4 = 0.5 bytes. offload = 0
// (the token is paged out of GPU memory entirely - accounted as zero
// GPU-resident bytes; the cost shows up as latency at the call site, not
// memory). estimateMemoryReduction reports GPU-resident savings.
const BYTES_PER_TOKEN_BY_TIER = Object.freeze({
  bf16: 2.0,
  fp8: 1.0,
  int8: 1.0,
  int4: 0.5,
  offload: 0.0,
});

// Default class -> precision tier mapping (research doc line 1458-1460
// "recent BF16 + sink BF16 + policy FP8/INT8 + warm INT8 + cold INT4/offload"):
//
//   sink                 -> bf16        (must not evict / not lose precision)
//   policy               -> fp8         (high precision but compressible)
//   schema               -> int8        (highly reusable; int8 keeps shape ok)
//   retrieved_evidence   -> int8        (default; overridden by citation_confidence)
//   conversation_recent  -> bf16        (recency window stays at full precision)
//   boilerplate          -> int4        (cheap to recompute / prefix-cacheable)
//   irrelevant_span      -> offload     (page out / drop)
export const DEFAULT_PRECISION_BY_CLASS = Object.freeze({
  sink: 'bf16',
  policy: 'fp8',
  schema: 'int8',
  retrieved_evidence: 'int8',
  conversation_recent: 'bf16',
  boilerplate: 'int4',
  irrelevant_span: 'offload',
});

// Default sink anchor (first N tokens always classify as sink). 4 follows
// StreamingLLM (Xiao 2024) which finds the first 4 tokens dominate attention
// sinks empirically.
const DEFAULT_SINK_ANCHOR = 4;

// Default recent-window size in tokens. Anything inside the recent window
// (position >= recent_window_start) is conversation_recent. The orchestrator
// passes the actual window start; the buildItkvProfile default just records
// 512 as a sane sliding-window size for a typical chat turn.
const DEFAULT_RECENT_WINDOW_SIZE = 512;

// Citation-confidence thresholds for retrieved_evidence precision tier hint:
//
//   confidence > 0.8 -> int8     (high-trust citation; preserve)
//   confidence > 0.5 -> int4     (mid-trust; compress harder)
//   else             -> offload  (low-trust; page out / drop)
//
// Numbers picked from the W722 brief sub-cases.
const RETRIEVED_TIER_HIGH = 0.8;
const RETRIEVED_TIER_MID = 0.5;

/**
 * Classify a single token into one of the 7 TOKEN_CLASSES.
 *
 * Fallthrough order (matches research-doc importance ranking):
 *   1. position < sink_anchor                 -> sink
 *   2. is_policy_span === true                -> policy
 *   3. is_schema_span === true                -> schema
 *   4. is_retrieved_evidence === true         -> retrieved_evidence
 *   5. position >= recent_window_start        -> conversation_recent
 *   6. role === 'boilerplate' OR is_repeated_prefix -> boilerplate
 *   7. otherwise                              -> irrelevant_span
 *
 * Returns either a plain string class OR an object {class, precision_tier}
 * when the class itself overrides the default precision (currently only
 * retrieved_evidence, whose tier depends on citation_confidence).
 *
 * @param {object} token - {
 *     position,                   // integer index in the sequence
 *     role,                       // optional role hint (e.g. 'boilerplate')
 *     recent_window_start,        // sequence index where recent window begins
 *     sink_anchor,                // default 4
 *     is_policy_span,             // boolean
 *     is_schema_span,             // boolean
 *     is_retrieved_evidence,      // boolean
 *     citation_confidence,        // 0..1 only meaningful when retrieved
 *     is_repeated_prefix,         // boolean
 *   }
 * @returns {string | {class: string, precision_tier: string}}
 */
export function classifyToken(token) {
  if (!token || typeof token !== 'object') {
    throw new TypeError('classifyToken requires a token object');
  }
  const position = Number.isInteger(token.position) ? token.position : -1;
  const sinkAnchor = Number.isInteger(token.sink_anchor) ? token.sink_anchor : DEFAULT_SINK_ANCHOR;
  const recentStart = Number.isInteger(token.recent_window_start)
    ? token.recent_window_start
    : Number.POSITIVE_INFINITY;

  // 1. sink: position < sink_anchor (StreamingLLM attention-sink rule).
  if (position >= 0 && position < sinkAnchor) {
    return 'sink';
  }

  // 2. policy: explicit span flag wins regardless of recency. A policy span
  //    inside the recent window is STILL policy (it must keep its TTL).
  if (token.is_policy_span === true) {
    return 'policy';
  }

  // 3. schema: explicit schema flag.
  if (token.is_schema_span === true) {
    return 'schema';
  }

  // 4. retrieved_evidence: returns {class, precision_tier} since the precision
  //    is a function of citation_confidence (not the static default map).
  if (token.is_retrieved_evidence === true) {
    const conf = Number.isFinite(token.citation_confidence) ? token.citation_confidence : 0.0;
    let tier;
    if (conf > RETRIEVED_TIER_HIGH) tier = 'int8';
    else if (conf > RETRIEVED_TIER_MID) tier = 'int4';
    else tier = 'offload';
    return { class: 'retrieved_evidence', precision_tier: tier };
  }

  // 5. conversation_recent: position is at/after the recent window start.
  if (position >= 0 && position >= recentStart) {
    return 'conversation_recent';
  }

  // 6. boilerplate: explicit role OR repeated-prefix signal. Repeated prefix
  //    is the prefix-cache reuse trigger (research doc line 1465).
  if (token.role === 'boilerplate' || token.is_repeated_prefix === true) {
    return 'boilerplate';
  }

  // 7. irrelevant_span: nothing matched.
  return 'irrelevant_span';
}

/**
 * Helper: given a class (or a {class, precision_tier} from classifyToken),
 * resolve the precision tier using DEFAULT_PRECISION_BY_CLASS unless the
 * classifier overrode it OR the caller's profile.precision_by_class
 * overrode it.
 */
export function precisionTierFor(classResult, precision_by_class) {
  const mapping = precision_by_class || DEFAULT_PRECISION_BY_CLASS;
  if (classResult && typeof classResult === 'object') {
    // classifyToken returned a {class, precision_tier} override.
    return classResult.precision_tier;
  }
  return mapping[classResult] || 'offload';
}

/**
 * Build a complete ITKV profile object that downstream surfaces (worker
 * stub, CLI, future artifact slot) consume.
 *
 * @param {object} opts
 *   - artifact_id - string identifier the profile is scoped to
 *   - token_classes_override - optional partial overrides of TOKEN_CLASSES
 *                                (subset only; you cannot ADD new classes)
 *   - precision_override - optional {class -> tier} overrides
 *   - sink_anchor - default 4
 *   - recent_window_size - default 512
 *   - prefix_cache_enabled - default true (research doc line 1465)
 * @returns {{ok:true, profile} | {ok:false, error, hint}}
 */
export function buildItkvProfile(opts = {}) {
  const artifact_id = String(opts.artifact_id || '');

  // Validate precision_override values up-front. We do this BEFORE class
  // overrides because a bad tier is a hard-fail; an unknown class in the
  // override map just gets ignored (forward-compat for future classes).
  const precisionOverride = opts.precision_override || {};
  for (const [cls, tier] of Object.entries(precisionOverride)) {
    if (!PRECISION_TIERS.includes(tier)) {
      return {
        ok: false,
        error: 'invalid_precision_tier',
        hint: `valid: ${PRECISION_TIERS.join(', ')}`,
        bad_class: cls,
        bad_tier: tier,
      };
    }
  }

  // Apply class override (allow subset only; warn-by-omission, not by error).
  let classes = TOKEN_CLASSES;
  const classOverride = opts.token_classes_override || {};
  if (Array.isArray(classOverride.include) && classOverride.include.length > 0) {
    classes = TOKEN_CLASSES.filter((c) => classOverride.include.includes(c));
  } else if (Array.isArray(classOverride.exclude) && classOverride.exclude.length > 0) {
    classes = TOKEN_CLASSES.filter((c) => !classOverride.exclude.includes(c));
  }

  // Compute final precision_by_class map (defaults merged with overrides).
  const precision_by_class = {};
  for (const cls of classes) {
    precision_by_class[cls] = precisionOverride[cls] || DEFAULT_PRECISION_BY_CLASS[cls];
  }

  const profile = {
    version: ITKV_VERSION,
    artifact_id,
    token_classes: classes,
    precision_by_class,
    sink_anchor: Number.isInteger(opts.sink_anchor) && opts.sink_anchor >= 0
      ? opts.sink_anchor
      : DEFAULT_SINK_ANCHOR,
    recent_window_size: Number.isInteger(opts.recent_window_size) && opts.recent_window_size > 0
      ? opts.recent_window_size
      : DEFAULT_RECENT_WINDOW_SIZE,
    prefix_cache_enabled: opts.prefix_cache_enabled !== false,
  };

  return { ok: true, profile };
}

/**
 * Estimate the GPU-resident KV-cache memory savings from running an ITKV
 * profile against a token-class distribution.
 *
 * Baseline assumption: BF16 across all tokens = 2 bytes/token (per layer per
 * head, but we report relative - the multipliers cancel for a percentage).
 *
 * Inputs:
 *   - profile.precision_by_class      → class -> tier
 *   - total_tokens                    → integer total sequence length
 *   - class_distribution              → {class: count, ...} (must sum ~= total)
 *
 * Returns:
 *   - bf16_bytes_baseline             → total_tokens * 2
 *   - itkv_bytes_estimated            → sum(count_c * bytes_per_tier(tier_c))
 *   - reduction_pct                   → (1 - itkv/baseline) * 100, 2 decimals
 *   - by_class_breakdown              → array of {class, count, tier, bytes}
 *
 * Honest envelope on distribution mismatch: counts do NOT sum to total_tokens
 * within 1% tolerance -> {ok:false, error:'class_distribution_mismatch'}.
 *
 * @returns {{ok:true, ...} | {ok:false, error, hint}}
 */
export function estimateMemoryReduction(profile, opts = {}) {
  if (!profile || typeof profile !== 'object' || !profile.precision_by_class) {
    return {
      ok: false,
      error: 'invalid_profile',
      hint: 'pass a profile produced by buildItkvProfile()',
    };
  }
  const total_tokens = Number.isInteger(opts.total_tokens) && opts.total_tokens > 0
    ? opts.total_tokens
    : 0;
  if (total_tokens === 0) {
    return {
      ok: false,
      error: 'invalid_total_tokens',
      hint: 'total_tokens must be a positive integer',
    };
  }
  const dist = opts.class_distribution || {};
  if (typeof dist !== 'object' || dist === null) {
    return {
      ok: false,
      error: 'invalid_class_distribution',
      hint: 'class_distribution must be an object {class: count, ...}',
    };
  }

  // Sum the distribution and check it matches total_tokens within 1% tolerance.
  let dist_sum = 0;
  for (const c of Object.values(dist)) {
    if (Number.isFinite(c) && c >= 0) dist_sum += c;
  }
  // 1% tolerance, or at least 1 token. This lets a caller pass a slightly
  // rounded distribution (e.g. percentage * total) without a false alarm.
  const tolerance = Math.max(1, Math.ceil(total_tokens * 0.01));
  if (Math.abs(dist_sum - total_tokens) > tolerance) {
    return {
      ok: false,
      error: 'class_distribution_mismatch',
      hint: 'class_distribution counts must sum to ~total_tokens',
      total_tokens,
      distribution_sum: dist_sum,
      tolerance,
    };
  }

  const bf16_bytes_baseline = Number((total_tokens * BYTES_PER_TOKEN_BY_TIER.bf16).toFixed(4));
  let itkv_bytes_estimated = 0;
  const by_class_breakdown = [];
  for (const cls of TOKEN_CLASSES) {
    const count = Number.isFinite(dist[cls]) ? dist[cls] : 0;
    const tier = profile.precision_by_class[cls] || DEFAULT_PRECISION_BY_CLASS[cls];
    const bytes_per = BYTES_PER_TOKEN_BY_TIER[tier] != null
      ? BYTES_PER_TOKEN_BY_TIER[tier]
      : BYTES_PER_TOKEN_BY_TIER.bf16;
    const bytes = Number((count * bytes_per).toFixed(4));
    itkv_bytes_estimated += bytes;
    by_class_breakdown.push({ class: cls, count, tier, bytes });
  }
  itkv_bytes_estimated = Number(itkv_bytes_estimated.toFixed(4));
  const reduction_pct = bf16_bytes_baseline > 0
    ? Number((((bf16_bytes_baseline - itkv_bytes_estimated) / bf16_bytes_baseline) * 100).toFixed(2))
    : 0;

  return {
    ok: true,
    version: ITKV_VERSION,
    bf16_bytes_baseline,
    itkv_bytes_estimated,
    reduction_pct,
    by_class_breakdown,
  };
}

/**
 * Stable sha256 over a canonical-JSON of the ITKV profile object. Future
 * orchestrator wave will use this to bind the profile into artifact_hash via
 * a kv_profile_hash slot in src/artifact.js (analogous to the W460 /
 * W409q / W719 mixed_precision_profile_hash binding). This wave only ships
 * the hash function - the artifact-side wiring is the orchestrator's job
 * (do NOT touch src/artifact.js this wave).
 */
export function hashItkvProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new TypeError('hashItkvProfile requires a profile object');
  }
  // Canonicalize via sorted keys at the top level so re-ordering does not
  // perturb the hash. The precision_by_class sub-object is also sorted.
  const sortedPrecision = {};
  for (const k of Object.keys(profile.precision_by_class || {}).sort()) {
    sortedPrecision[k] = profile.precision_by_class[k];
  }
  const canon = {
    version: profile.version,
    artifact_id: profile.artifact_id,
    token_classes: [...(profile.token_classes || [])],
    precision_by_class: sortedPrecision,
    sink_anchor: profile.sink_anchor,
    recent_window_size: profile.recent_window_size,
    prefix_cache_enabled: profile.prefix_cache_enabled,
  };
  const json = JSON.stringify(canon);
  return crypto.createHash('sha256').update(json).digest('hex');
}
