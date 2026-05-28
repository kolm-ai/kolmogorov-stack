// src/cost-optimizer.js
//
// KOLM AUTOPILOT — COST OPTIMIZER.
//
// The autopilot has a fixed monthly budget and a target K-Score (src/kscore.js
// composite scale, [0,1], ship gate 0.85). At every tick it must answer one
// question: "where does the next dollar buy the most quality?" This module
// answers it by ranking the autopilot's improvement STRATEGIES by predicted
// ΔK-per-dollar, so spend always flows to the highest-yield move first.
//
// THE FIVE STRATEGIES (each described by a characteristic FEATURE DELTA it
// would apply to the current data, plus how that delta translates into teacher
// token spend):
//   dedup        deduplicates the corpus: mainly drops dup_fraction, with a
//                tiny n_pairs loss. NEARLY FREE — local embedding compute, no
//                teacher tokens — so at equal ΔK it must rank ABOVE every paid
//                strategy.
//   ingest-more  acquires + labels more pairs: raises n_pairs. Cost scales with
//                the new-pair count (teacher tokens to label them).
//   gap-fill     targets coverage holes: raises coverage_score AND n_pairs.
//                COSTLY — the teacher generates targeted pairs.
//   preference   SimPO/KTO over existing disagreement: raises avg_quality.
//                Low-to-moderate cost (re-scores existing pairs, no new corpus).
//   evol         Evol-Instruct: raises avg_quality AND coverage_score.
//                Moderate-to-high cost (teacher rewrites + expands pairs).
//
// METHOD: for each strategy we project its feature delta onto current_features,
// call predictKScore on BOTH the current vector and (current + delta), and take
// the difference as predicted ΔK. Cost comes from src/cost-estimator.js, priced
// against the new-pair count the strategy implies (dedup ~ $0). Ranking key is
// predicted_delta_k / max(est_cost_usd, EPSILON) so free strategies float to
// the top. The whole computation is read-only over the data; nothing trains.
//
// CONTRACT (co-v1) — the autopilot tick and the CLI/HTTP surfaces import
// rankStrategies against this EXACT shape:
//   rankStrategies({tenant, namespace, budget_usd, target_kscore,
//     current_features, teacher_spec}) -> {
//       ok, version, current_k, ranked:[{strategy, est_cost_usd,
//         predicted_delta_k, delta_k_per_dollar, fits_budget, reaches_target}],
//       recommended, persist }
// Every exported function returns an envelope and NEVER throws across the public
// API. Persistence is best-effort (a plan is still returned with persisted:false
// if the event store is unavailable).
//
// Reuses (no new deps):
//   - predictKScore (src/quality-predictor.js)   ΔK projection
//   - estimateBatchCost (src/cost-estimator.js)  teacher-token pricing
//   - src/event-store.js                         best-effort plan logging
//
// Caveats / Limitations:
//   - ΔK is a forward projection through the quality predictor, which is itself
//     heuristic until enough runs accumulate (see qp-v1). The ranking is only as
//     calibrated as that predictor; treat absolute ΔK as directional.
//   - The feature deltas are characteristic priors per strategy, not measured
//     outcomes of a specific corpus. A real run may differ; the autopilot is
//     expected to re-rank each tick as features move.
//   - Cost models only teacher TOKENS. GPU/wall-clock for the eventual compile
//     and local embedding compute (dedup) are out of scope here.

import { predictKScore } from './quality-predictor.js';
import { estimateBatchCost } from './cost-estimator.js';
import * as eventStore from './event-store.js';

export const COST_OPTIMIZER_VERSION = 'co-v1';

const PROVIDER = 'kolm_cost_plan';
const DEFAULT_TENANT = 'tenant_local';
const DEFAULT_NAMESPACE = 'default';

// Default priced teacher for token-spending strategies. Mirrors the reference
// model src/data-feedback.js prices against, so the optimizer and the feedback
// stage agree on what a "pair" costs. Callers may override via teacher_spec.
const DEFAULT_TEACHER_SLUG = 'openai:gpt-4o-mini';

// Per-pair token assumptions for pricing new pairs. Same defaults as
// estimateBatchCost (256 in / 384 out) so the numbers reconcile with the rest
// of the data engine.
const AVG_INPUT_TOKENS = 256;
const AVG_OUTPUT_TOKENS = 384;

// Floor used as the denominator for delta_k_per_dollar. A free strategy
// (est_cost_usd === 0) divides by this tiny epsilon, yielding a very large
// yield so it ranks ABOVE any paid strategy at equal ΔK — exactly the behavior
// the autopilot wants (spend the free win first).
const SMALL_EPSILON = 1e-6;

// dedup spends no teacher tokens (local embedding compute). We model it as a
// genuine $0 so it dominates the yield ranking, per the module contract.
const DEDUP_COST_USD = 0;

// ---------------------------------------------------------------------------
// Strategy feature-delta priors.
//
// Each entry is the characteristic change a strategy applies to the current
// feature vector. `new_pairs` is the count of NEW teacher-labeled pairs the
// strategy implies (drives cost); it is 0 for strategies that only re-score or
// remove existing pairs. `delta` is applied additively to current_features with
// per-feature clamping into the predictor's recognized ranges.
//
// Semantics of each delta key (matches quality-predictor.js recognized keys):
//   n_pairs              additive count change (can be negative for dedup)
//   dup_fraction         additive change, clamped [0,1] (negative = cleaner)
//   coverage_score       additive change, clamped [0,1]
//   avg_quality          additive change, clamped [0,1]
// ---------------------------------------------------------------------------
const STRATEGIES = Object.freeze({
  dedup: {
    // Removes duplicates: big dup_fraction drop, small n_pairs loss. No teacher
    // tokens — local embedding pass only.
    delta: { dup_fraction: -0.10, n_pairs: -20 },
    new_pairs: 0,
    free: true,
  },
  'ingest-more': {
    // Acquires + labels more pairs. Cost scales with the new pairs.
    delta: { n_pairs: +500 },
    new_pairs: 500,
    free: false,
  },
  'gap-fill': {
    // Targets coverage holes: lifts coverage AND adds pairs. Costly — every new
    // pair is teacher-generated against a targeted prompt.
    delta: { coverage_score: +0.15, n_pairs: +150 },
    new_pairs: 150,
    free: false,
  },
  preference: {
    // SimPO/KTO over existing disagreement: lifts avg_quality, no new corpus.
    // We still price a light teacher pass to re-score existing pairs.
    delta: { avg_quality: +0.08 },
    new_pairs: 80,
    free: false,
  },
  evol: {
    // Evol-Instruct: lifts avg_quality AND coverage via teacher rewrites +
    // expansions. Moderate-to-high cost.
    delta: { avg_quality: +0.05, coverage_score: +0.05 },
    new_pairs: 200,
    free: false,
  },
});

const STRATEGY_ORDER = Object.freeze(Object.keys(STRATEGIES));

// ---------------------------------------------------------------------------
// Persistence — EXACT mandated pattern (copied from src/data-feedback.js).
// Best-effort; never throws across the public API.
// ---------------------------------------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant, namespace: namespace || DEFAULT_NAMESPACE,
      provider: PROVIDER, vendor: 'kolm', model: 'cost-optimizer/v1',
      workflow_id: workflow, status: 'ok',
      prompt_tokens: 0, completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) { return { persisted: false, error: String((e && e.message) || e) }; }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function _tenant(t) { return (t && String(t)) || DEFAULT_TENANT; }
function _ns(n) { return (n && String(n)) || DEFAULT_NAMESPACE; }
function _round4(x) { return Number(Number(x).toFixed(4)); }
function _round6(x) { return Number(Number(x).toFixed(6)); }
function _clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// Keys that the quality predictor treats as fractions in [0,1] and must be
// clamped after a delta is applied.
const FRACTION_KEYS = Object.freeze(['dup_fraction', 'coverage_score', 'avg_quality', 'cot_contam_fraction']);

// Apply a strategy's additive delta to the current feature vector, clamping
// fraction-valued features into [0,1] and flooring counts at 0. Only keys the
// delta touches are changed; everything else is carried through verbatim so the
// predictor sees the same baseline + a single isolated improvement.
function _applyDelta(current, delta) {
  const next = { ...current };
  for (const [k, dv] of Object.entries(delta)) {
    const base = Number.isFinite(Number(next[k])) ? Number(next[k]) : 0;
    let v = base + Number(dv);
    if (FRACTION_KEYS.includes(k)) v = _clamp01(v);
    else if (k === 'n_pairs') v = Math.max(0, Math.round(v));
    next[k] = v;
  }
  return next;
}

// Normalize the teacher_spec override into the estimateBatchCost teachers shape
// ([{slug, rows}]). Accepts: a slug string, a single {slug|vendor+model} object,
// or an array of such. `rows` is always set from the strategy's new_pairs so the
// caller can't accidentally double-count volume. Returns the default teacher
// when the override is absent or unusable.
function _teacherSlug(teacher_spec) {
  if (typeof teacher_spec === 'string' && teacher_spec.trim()) return teacher_spec.trim();
  const pick = Array.isArray(teacher_spec) ? teacher_spec[0] : teacher_spec;
  if (pick && typeof pick === 'object') {
    if (typeof pick.slug === 'string' && pick.slug.trim()) return pick.slug.trim();
    if (pick.vendor != null && pick.model != null) return `${pick.vendor}:${pick.model}`;
  }
  return DEFAULT_TEACHER_SLUG;
}

// Price a strategy. Free strategies short-circuit to $0; paid strategies price
// their new_pairs through estimateBatchCost against the chosen teacher. A pair
// is one teacher call (avg_input prompt + avg_output completion), so new_pairs
// maps directly to estimateBatchCost's `rows`.
function _estCostUsd(spec, teacherSlug) {
  if (spec.free || spec.new_pairs <= 0) return DEDUP_COST_USD;
  const est = estimateBatchCost({
    teachers: [{ slug: teacherSlug, rows: spec.new_pairs }],
    avg_input_tokens: AVG_INPUT_TOKENS,
    avg_output_tokens: AVG_OUTPUT_TOKENS,
  });
  const usd = Number(est && est.total_usd);
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

// ---------------------------------------------------------------------------
// rankStrategies — the public optimizer.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {number} args.budget_usd        monthly budget ceiling
 * @param {number} [args.target_kscore]   target K; marks reaches_target when given
 * @param {object} args.current_features  recognized data-quality features
 * @param {(string|object|Array)} [args.teacher_spec]  override priced teacher
 * @returns {Promise<{ok:boolean, version:string, current_k?:number,
 *   ranked?:Array<{strategy:string, est_cost_usd:number, predicted_delta_k:number,
 *     delta_k_per_dollar:number, fits_budget:boolean, reaches_target:boolean}>,
 *   recommended?:(string|null), persisted?:boolean, error?:string}>}
 */
export async function rankStrategies({
  tenant, namespace,
  budget_usd,
  target_kscore,
  current_features,
  teacher_spec,
} = {}) {
  try {
    if (!current_features || typeof current_features !== 'object' || Array.isArray(current_features)) {
      return { ok: false, error: 'current_features_required', version: COST_OPTIMIZER_VERSION };
    }

    const t = _tenant(tenant);
    const ns = _ns(namespace);
    const budget = Number(budget_usd);
    const hasBudget = Number.isFinite(budget);
    const hasTarget = Number.isFinite(Number(target_kscore));
    const target = hasTarget ? Number(target_kscore) : null;
    const teacherSlug = _teacherSlug(teacher_spec);

    // Baseline K at the current vector. A failure here means the predictor can't
    // score the input at all — surface its error verbatim (e.g. features_required,
    // no_recognized_features) rather than fabricate a plan.
    const basePred = await predictKScore({ tenant: t, namespace: ns, features: current_features });
    if (!basePred || basePred.ok !== true || !Number.isFinite(Number(basePred.kscore_predicted))) {
      return {
        ok: false,
        error: (basePred && basePred.error) || 'base_prediction_failed',
        version: COST_OPTIMIZER_VERSION,
      };
    }
    const currentK = _round4(basePred.kscore_predicted);

    // Score every strategy: project its delta, predict the new K, difference it,
    // price it. predictKScore over a clamped vector should succeed whenever the
    // baseline did (same recognized keys), but if a projection fails we treat its
    // ΔK as 0 rather than abort the whole plan.
    const ranked = [];
    for (const strategy of STRATEGY_ORDER) {
      const spec = STRATEGIES[strategy];
      const projected = _applyDelta(current_features, spec.delta);

      let deltaK = 0;
      const pred = await predictKScore({ tenant: t, namespace: ns, features: projected });
      if (pred && pred.ok === true && Number.isFinite(Number(pred.kscore_predicted))) {
        deltaK = Number(pred.kscore_predicted) - Number(basePred.kscore_predicted);
      }
      // Clamp tiny negatives (predictor noise / a dedup's small n_pairs dip) to 0
      // so no strategy is ever scored as actively harmful.
      const predicted_delta_k = _round4(Math.max(0, deltaK));

      const est_cost_usd = _round6(_estCostUsd(spec, teacherSlug));
      const delta_k_per_dollar = _round6(predicted_delta_k / Math.max(est_cost_usd, SMALL_EPSILON));
      const fits_budget = hasBudget ? est_cost_usd <= budget : true;
      const reaches_target = hasTarget
        ? (Number(basePred.kscore_predicted) + predicted_delta_k) >= target
        : false;

      ranked.push({
        strategy,
        est_cost_usd,
        predicted_delta_k,
        delta_k_per_dollar,
        fits_budget,
        reaches_target,
      });
    }

    // Sort DESC by yield. Ties broken by lower cost first (cheaper win when the
    // ΔK-per-dollar matches), then by stable strategy order for determinism.
    ranked.sort((a, b) =>
      (b.delta_k_per_dollar - a.delta_k_per_dollar) ||
      (a.est_cost_usd - b.est_cost_usd) ||
      (STRATEGY_ORDER.indexOf(a.strategy) - STRATEGY_ORDER.indexOf(b.strategy))
    );

    // Recommend the highest-yield strategy that fits the budget. A strategy with
    // zero predicted ΔK still has a defined yield (0), so we also require it to
    // actually move K — recommending a no-op move would waste a tick.
    let recommended = null;
    for (const r of ranked) {
      if (r.fits_budget && r.predicted_delta_k > 0) { recommended = r.strategy; break; }
    }

    const plan = {
      current_k: currentK,
      budget_usd: hasBudget ? budget : null,
      target_kscore: target,
      teacher_slug: teacherSlug,
      ranked,
      recommended,
      planned_at: new Date().toISOString(),
    };

    // Best-effort log of the plan for later audit / drift tracking.
    const persist = await _persist({
      tenant: t, namespace: ns, workflow: 'cost:plan', payload: plan,
    });

    return {
      ok: true,
      version: COST_OPTIMIZER_VERSION,
      current_k: currentK,
      ranked,
      recommended,
      persisted: persist.persisted === true,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: COST_OPTIMIZER_VERSION };
  }
}

// Exposed for tests + downstream introspection. Not part of the stable
// contract — do not rely on these from other modules.
export const __internals = Object.freeze({
  STRATEGIES,
  STRATEGY_ORDER,
  DEFAULT_TEACHER_SLUG,
  SMALL_EPSILON,
  _applyDelta,
  _teacherSlug,
  _estCostUsd,
});
