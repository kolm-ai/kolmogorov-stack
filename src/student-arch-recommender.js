// W716 — student-architecture recommender for task-adaptive arch search (TAAS).
//
// Rule-based v1 (no meta-model). Consumes a capture-stats profile
// (src/capture-stats.js#computeCaptureStats) and produces an arch spec
// the downstream `kolm compile` / trainer can act on.
//
// The recommender's contract: GIVEN distribution stats, RETURN a single
// `recommended` arch plus a smaller `fallback` (so the caller can show
// a "cheaper but plausible" option in the report). Plus `reasoning` — a
// short human-readable string explaining which rule fired.
//
// Honest contract: the recommender NEVER fabricates training. It outputs
// a spec; the trainer side decides whether the recipe is implementable
// for that hardware. MoE is gated behind KOLM_ENABLE_MOE because the
// recipe scaffolding ships before the full mixture trainer does.
//
// Rules (v1 ladder; the FIRST matching branch wins):
//
//   stats.n < 100              -> 1B-class (small / fast distill)
//   complexity > 0.6 + tool>0.3 + MoE-gated -> MoE recipe (3 of 8 experts)
//   complexity > 0.6 OR depth > 3  -> 7B-class
//   complexity 0.3..0.6         -> 3B-class
//   complexity < 0.3 + p95<200  -> 1B-class
//   else                        -> 3B-class  (default safe pick)

export const RECOMMENDER_VERSION = 'w716-v1';

// =============================================================================
// Architecture catalog. Sizes are honest defaults; hidden_dim / depth / heads
// are the "class-typical" geometry for each tier — a v2 meta-model would
// learn the exact numbers per-task but v1 picks from a fixed catalog.
// =============================================================================

const ARCH_1B = Object.freeze({
  family: 'tinyllama-1b-class',
  size_label: '1B',
  depth: 22,
  width: 2048,
  hidden_dim: 2048,
  num_attention_heads: 32,
  quant: 'int4',
});

const ARCH_3B = Object.freeze({
  family: 'qwen2.5-3b-class',
  size_label: '3B',
  depth: 36,
  width: 2048,
  hidden_dim: 2048,
  num_attention_heads: 16,
  quant: 'int4',
});

const ARCH_7B = Object.freeze({
  family: 'qwen2.5-7b-class',
  size_label: '7B',
  depth: 28,
  width: 3584,
  hidden_dim: 3584,
  num_attention_heads: 28,
  quant: 'int4',
});

// MoE = 8 experts, top-3 router. Geometry is per-expert (small dense
// backbone); the recipe scaffold in src/compile.js#buildMoeRecipe stamps
// the routing block.
const ARCH_MOE_8x3 = Object.freeze({
  family: 'qwen2.5-3b-class',
  size_label: '3B-MoE-8x3',
  depth: 28,
  width: 2048,
  hidden_dim: 2048,
  num_attention_heads: 16,
  quant: 'int4',
  moe: {
    num_experts: 8,
    top_k: 3,
    expert_specialization: ['tool_call', 'reasoning', 'general'],
    routing: 'switch-transformer-top-k',
    capacity_factor: 1.25,
  },
});

// Stable catalog accessor — exposed for tests that need to enumerate.
export const ARCH_CATALOG = Object.freeze({
  ARCH_1B, ARCH_3B, ARCH_7B, ARCH_MOE_8x3,
});

// =============================================================================
// Recommender entry point
// =============================================================================

function isMoeEnabled() {
  const v = String(process.env.KOLM_ENABLE_MOE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Recommend a student architecture given a capture-stats profile.
 *
 * @param {ReturnType<import('./capture-stats.js').computeCaptureStats>} stats
 * @returns {{
 *   version: string,
 *   recommended: object,
 *   fallback: object,
 *   reasoning: string,
 *   moe_enabled: boolean,
 *   stats_summary: object,
 * }}
 */
export function recommendArch(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const n = Number(s.n) || 0;
  const complexity = Number(s.task_complexity_proxy) || 0;
  const toolRate = Number(s.tool_use_rate) || 0;
  const depth = Number(s.reasoning_chain_depth_avg) || 0;
  const p95 = Number(s.output_length && s.output_length.p95) || 0;

  const moeOn = isMoeEnabled();
  let recommended = null;
  let fallback = null;
  let reasoning = '';

  // Rule 1: too few captures to overfit anything larger than 1B.
  if (n < 100) {
    recommended = { ...ARCH_1B };
    fallback = { ...ARCH_1B };
    reasoning =
      `Only ${n} captures — distill into a 1B-class student (small + fast). ` +
      `Recommend capturing >=500 before considering larger classes.`;
  }
  // Rule 2: complex + tool-heavy + MoE explicitly enabled.
  else if (complexity > 0.6 && toolRate > 0.3 && moeOn) {
    recommended = { ...ARCH_MOE_8x3, moe: { ...ARCH_MOE_8x3.moe } };
    fallback = { ...ARCH_7B };
    reasoning =
      `complexity ${complexity.toFixed(2)} > 0.6 AND tool_use_rate ` +
      `${toolRate.toFixed(2)} > 0.3 — MoE recipe (8 experts, top-3 routing, ` +
      `expert specialization: tool_call/reasoning/general). ` +
      `Note: MoE recipe is a scaffold — production training requires the full ` +
      `mixture trainer.`;
  }
  // Rule 3: complex OR deeply-reasoning tasks — 7B-class.
  else if (complexity > 0.6 || depth > 3) {
    recommended = { ...ARCH_7B };
    fallback = { ...ARCH_3B };
    reasoning =
      `complexity ${complexity.toFixed(2)} > 0.6 OR reasoning_chain_depth ` +
      `${depth.toFixed(2)} > 3 — recommend 7B-class student to preserve ` +
      `reasoning capacity. Fallback: 3B-class if memory-constrained.`;
  }
  // Rule 4: moderate complexity — 3B-class.
  else if (complexity >= 0.3 && complexity <= 0.6) {
    recommended = { ...ARCH_3B };
    fallback = { ...ARCH_1B };
    reasoning =
      `complexity ${complexity.toFixed(2)} in [0.3, 0.6] — 3B-class is the ` +
      `sweet spot for moderate-difficulty tasks. Fallback: 1B-class for edge.`;
  }
  // Rule 5: low complexity + short outputs — 1B-class.
  else if (complexity < 0.3 && p95 < 200) {
    recommended = { ...ARCH_1B };
    fallback = { ...ARCH_1B };
    reasoning =
      `complexity ${complexity.toFixed(2)} < 0.3 AND output_length p95 ` +
      `${p95.toFixed(0)} < 200 tokens — 1B-class is sufficient and ships ` +
      `fastest to edge devices.`;
  }
  // Rule 6 (default): 3B-class safe pick.
  else {
    recommended = { ...ARCH_3B };
    fallback = { ...ARCH_1B };
    reasoning =
      `Default safe pick: 3B-class (complexity ${complexity.toFixed(2)}, ` +
      `depth ${depth.toFixed(2)}, p95 ${p95.toFixed(0)}). ` +
      `Set KOLM_ENABLE_MOE=1 to allow MoE recommendations.`;
  }

  // If MoE wanted-but-not-enabled, surface that in the reasoning so the
  // user knows why they got a dense fallback.
  if (!moeOn && complexity > 0.6 && toolRate > 0.3 && !recommended.moe) {
    reasoning += ` (MoE could fit this profile; set KOLM_ENABLE_MOE=1 to enable.)`;
  }

  return {
    version: RECOMMENDER_VERSION,
    recommended,
    fallback,
    reasoning,
    moe_enabled: moeOn,
    stats_summary: {
      n,
      task_complexity_proxy: complexity,
      tool_use_rate: toolRate,
      reasoning_chain_depth_avg: depth,
      output_length_p95: p95,
    },
  };
}

// =============================================================================
// W832 — Meta-augmented recommender.
//
// If the kolm-meta trainer has accumulated >= MIN_ROWS_FOR_META training rows
// AND a trained model exists on disk, we consult the meta-model and surface
// its prediction alongside the rule-based pick. The rule pick stays the
// authority on architecture SELECTION — meta predictions ride on the envelope
// as a hint (predicted kscore, compile_time, failure mode) so the operator
// can decide whether to push past the rule's safe pick.
//
// Below MIN_ROWS_FOR_META, the envelope carries `meta_insufficient_data:true`
// so the dashboard can tell the user "we'll start meta-routing at N rows."
//
// `features` is the same shape kolm-meta-trainer expects (META_FEATURES keys).
// `stats` is the same capture-stats profile the rule-based recommendArch eats.
// Callers can pass both — the rule path uses stats, the meta path uses features.
// =============================================================================

export async function recommendArchWithMeta({ stats = null, features = null } = {}) {
  const ruleEnv = recommendArch(stats || {});
  let metaMod;
  try { metaMod = await import('./kolm-meta-trainer.js'); }
  catch (_) {
    return {
      ...ruleEnv,
      source: 'rules',
      meta_insufficient_data: true,
      meta_status: 'meta_module_missing',
      rows: 0,
    };
  }
  let rows = 0;
  try { rows = metaMod.n_rows(); } catch (_) { rows = 0; }
  if (rows < metaMod.MIN_ROWS_FOR_META) {
    return {
      ...ruleEnv,
      source: 'rules',
      meta_insufficient_data: true,
      rows,
      min_rows_for_meta: metaMod.MIN_ROWS_FOR_META,
    };
  }
  // n >= threshold — try the meta model.
  let metaEnv = null;
  try { metaEnv = metaMod.inferKolmMeta({ features: features || {} }); }
  catch (e) { metaEnv = { ok: false, status: 'infer_threw', detail: String(e && e.message || e) }; }
  if (!metaEnv || metaEnv.ok !== true) {
    return {
      ...ruleEnv,
      source: 'rules',
      meta_insufficient_data: false,
      meta_status: (metaEnv && metaEnv.status) || 'meta_unavailable',
      rows,
    };
  }
  // Honest envelope: meta source kicks in. Rule pick stays exposed so the
  // operator can compare; meta adds its prediction block.
  return {
    ...ruleEnv,
    source: 'meta',
    meta_insufficient_data: false,
    rows,
    min_rows_for_meta: metaMod.MIN_ROWS_FOR_META,
    meta_prediction: {
      kscore_predicted: metaEnv.kscore_predicted,
      compile_time_s_predicted: metaEnv.compile_time_s_predicted,
      failure_mode_predicted: metaEnv.failure_mode_predicted,
      failure_mode_scores: metaEnv.failure_mode_scores,
      confidence: metaEnv.confidence,
      n_train_rows: metaEnv.n_train_rows,
      version: metaEnv.version,
    },
  };
}
