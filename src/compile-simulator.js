// src/compile-simulator.js
//
// KOLM AUTOPILOT — COMPILE SIMULATOR.
//
// A thin, PURE decision wrapper over the Quality Predictor (src/quality-predictor.js).
// Before the autopilot spends GPU/teacher money on a recompile, it asks:
//
//   "Given the data features I have NOW, and a proposed feature delta from some
//    improvement action, would the predicted K-Score gain clear the ship gate's
//    minimum delta? If not, SKIP the compile."
//
// Every skip it logs is measurable money the autopilot did NOT spend on a
// marginal recompile. This module never trains and never compiles — it only
// predicts two K-Scores (current vector vs current+delta) and compares the gain
// against the ship gate threshold (default 0.02, from
// src/improvement-orchestrator.js compareAndDecide).
//
// CONTRACT (cs-v1) — every exported async function returns an envelope
//   {ok:true, version:'cs-v1', ...} | {ok:false, error:'<snake_case>', version:'cs-v1'}
// and NEVER throws across the public API. Persistence is best-effort: if the
// event store is unavailable the call still returns ok:true with
// persist:{persisted:false, error}.
//
// Reuses (no new deps):
//   - src/quality-predictor.js : predictKScore (qp-v1 contract, frozen)
//   - src/event-store.js       : best-effort decision logging (_persist)
//
// Caveats / Limitations:
//   - The decision is only as calibrated as the predictor underneath it. In the
//     cold-start regime predictKScore returns basis:'heuristic' with LOW
//     confidence; this module surfaces that basis + the min of the two
//     predictions' confidence so callers never over-trust a skip/compile call.
//   - delta_k is the difference of two point predictions, not a paired interval.
//     The threshold comparison is deliberately simple and transparent.

import { predictKScore } from './quality-predictor.js';
import * as eventStore from './event-store.js';

export const COMPILE_SIM_VERSION = 'cs-v1';

// Minimum K-Score delta that justifies a compile. Mirrors the ship-gate default
// in src/improvement-orchestrator.js compareAndDecide (gate.min_kscore_delta).
const DEFAULT_MIN_DELTA_K = 0.02;

const PROVIDER = 'kolm_compile_sim';
const DEFAULT_TENANT = 'tenant_local';
const DEFAULT_NAMESPACE = 'default';

// ---------------------------------------------------------------------------
// Persistence — EXACT mandated pattern (copied from src/data-feedback.js).
// Best-effort; never throws across the public API.
// ---------------------------------------------------------------------------

async function _persist({ tenant, namespace, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant, namespace: namespace || DEFAULT_NAMESPACE,
      provider: PROVIDER, vendor: 'kolm', model: 'compile-simulator/v1',
      workflow_id: 'compile:simulate', status: 'ok',
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
function _round6(x) { return Number(Number(x).toFixed(6)); }
function _clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// Recognized predictor features. Keys NOT in this set are passed through to the
// predictor untouched (it ignores unrecognized keys), but a delta on an unknown
// key still merges so a future predictor feature is not silently dropped.
const FRACTION_OR_SCORE_KEYS = new Set([
  'dup_fraction', 'coverage_score', 'avg_quality', 'cot_contam_fraction',
]);
const NONNEG_KEYS = new Set(['n_pairs', 'teacher_diversity']);

// Neutral starting value for a feature that has NO current value but DOES have a
// proposed delta. Mirrors the predictor's own neutral defaults in
// quality-predictor.js _subScores so a delta applied from "nothing" lands where
// the predictor would have defaulted before the delta was added.
function _neutralFor(key) {
  switch (key) {
    case 'n_pairs': return 0;
    case 'dup_fraction': return 0.1;
    case 'coverage_score': return 0.6;
    case 'avg_quality': return 0.6;
    case 'cot_contam_fraction': return 0.1;
    case 'teacher_diversity': return 0.5;
    default: return 0;
  }
}

// Clamp a merged feature value to its valid range: fractions/scores to [0,1],
// counts/diversity to >=0, everything else left numeric and untouched.
function _clampFeature(key, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return _neutralFor(key);
  if (FRACTION_OR_SCORE_KEYS.has(key)) return _clamp01(v);
  if (NONNEG_KEYS.has(key)) return Math.max(0, v);
  return v;
}

// Apply an additive feature delta to a current feature vector. For each key in
// the delta we start from the current numeric value, or — when the current
// vector omits it — from the feature's neutral default, then add the delta and
// clamp. Keys present only in current_features pass through unchanged so the
// predictor sees the full vector.
function _applyDelta(current, delta) {
  const merged = { ...current };
  for (const key of Object.keys(delta)) {
    const base = Number(current?.[key]);
    const start = Number.isFinite(base) ? base : _neutralFor(key);
    merged[key] = _clampFeature(key, start + Number(delta[key]));
  }
  return merged;
}

// ---------------------------------------------------------------------------
// decideFromDeltaK — PURE decision helper (no async, no predictor, no persist).
// Lets callers/tests reason about a compile-vs-skip decision from a raw delta.
// ---------------------------------------------------------------------------

/**
 * @param {number} delta_k       predicted K-Score gain (k_proposed - k_current)
 * @param {number} [min_delta_k] threshold that justifies a compile (default 0.02)
 * @returns {{decision:'compile'|'skip', reason:string}}
 */
export function decideFromDeltaK(delta_k, min_delta_k = DEFAULT_MIN_DELTA_K) {
  const d = Number(delta_k);
  const thr = Number.isFinite(Number(min_delta_k)) ? Number(min_delta_k) : DEFAULT_MIN_DELTA_K;
  if (!Number.isFinite(d)) {
    return { decision: 'skip', reason: 'delta_k is not a finite number; skipping compile' };
  }
  if (d >= thr) {
    return {
      decision: 'compile',
      reason: `predicted K gain ${_round6(d)} clears the ${thr} ship-gate threshold; compile is justified`,
    };
  }
  return {
    decision: 'skip',
    reason: `predicted K gain ${_round6(d)} is below the ${thr} ship-gate threshold; skipping compile to save spend`,
  };
}

// ---------------------------------------------------------------------------
// simulateCompile — predict K for current vs current+delta, decide compile/skip.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {object} args.current_features  recognized predictor features (object)
 * @param {object} args.proposed_delta    per-feature additive deltas (object)
 * @param {number} [args.min_delta_k]      threshold; default 0.02 (ship gate)
 * @returns {Promise<object>} cs-v1 envelope (see module header)
 */
export async function simulateCompile({
  tenant, namespace, current_features, proposed_delta, min_delta_k,
} = {}) {
  try {
    if (!current_features || typeof current_features !== 'object' || Array.isArray(current_features)) {
      return { ok: false, error: 'current_features_required', version: COMPILE_SIM_VERSION };
    }
    if (!proposed_delta || typeof proposed_delta !== 'object' || Array.isArray(proposed_delta)) {
      return { ok: false, error: 'proposed_delta_required', version: COMPILE_SIM_VERSION };
    }

    const t = _tenant(tenant);
    const ns = _ns(namespace);
    const threshold = Number.isFinite(Number(min_delta_k)) ? Number(min_delta_k) : DEFAULT_MIN_DELTA_K;

    const proposed_features = _applyDelta(current_features, proposed_delta);

    // Predict both vectors. The predictor enforces its own qp-v1 contract; we
    // surface its error verbatim so the failure reason is traceable upstream.
    const [curRes, propRes] = await Promise.all([
      predictKScore({ tenant: t, namespace: ns, features: current_features }),
      predictKScore({ tenant: t, namespace: ns, features: proposed_features }),
    ]);

    if (!curRes || curRes.ok !== true) {
      return { ok: false, error: (curRes && curRes.error) || 'predict_current_failed', version: COMPILE_SIM_VERSION };
    }
    if (!propRes || propRes.ok !== true) {
      return { ok: false, error: (propRes && propRes.error) || 'predict_proposed_failed', version: COMPILE_SIM_VERSION };
    }

    const k_current = _round6(curRes.kscore_predicted);
    const k_proposed = _round6(propRes.kscore_predicted);
    const delta_k = _round6(k_proposed - k_current);

    const { decision, reason } = decideFromDeltaK(delta_k, threshold);

    // Confidence is the WEAKER of the two predictions — a decision is only as
    // trustworthy as its least-supported endpoint. Basis degrades to 'heuristic'
    // if either prediction is heuristic (a single cold endpoint makes the
    // comparison cold).
    const confidence = _round6(Math.min(Number(curRes.confidence) || 0, Number(propRes.confidence) || 0));
    const basis = (curRes.basis === 'learned' && propRes.basis === 'learned') ? 'learned' : 'heuristic';

    const persist = await _persist({
      tenant: t, namespace: ns,
      payload: { k_current, k_proposed, delta_k, min_delta_k: threshold, decision, reason },
    });

    return {
      ok: true,
      version: COMPILE_SIM_VERSION,
      k_current,
      k_proposed,
      delta_k,
      min_delta_k: threshold,
      decision,
      reason,
      confidence,
      basis,
      persist,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: COMPILE_SIM_VERSION };
  }
}
