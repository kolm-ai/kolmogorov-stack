// src/ab-promote.js
//
// W822-4 - Auto-promote / auto-rollback decision engine.
//
// Combines ab-metrics deltas + significance.bootstrap p-values + a small set
// of operator-tunable thresholds to decide one of three outcomes:
//
//   - 'promote'  -> bump version_b to be the new default
//   - 'rollback' -> revert to version_a
//   - 'hold'    -> not enough signal; keep current split
//
// Promotion rule (configurable via thresholds):
//   p_value < 0.05  AND  k_score_delta > +0.02
//
// Rollback rule:
//   fallback_rate_delta > +0.05  OR  latency_p95_pct_delta > +0.25
//
// Both rules require minimum sample sizes per variant (default 30) so a
// thin trickle of traffic can't trigger a promotion.
//
// Emits AUDIT_OPS events on every non-'hold' decision so the audit chain has
// the full promote/rollback history.
//
// AB_PROMOTE_VERSION = 'w822-vN' -- consumers MUST match /^w822-/.

import { aggregate as abAggregate, deltas as abDeltas, AB_METRICS_VERSION } from './ab-metrics.js';
import { bootstrap, SIGNIFICANCE_VERSION } from './significance.js';

export const AB_PROMOTE_VERSION = 'w822-v1';

// Default thresholds (exported so callers + tests share one truth).
export const DEFAULT_PROMOTE_P = 0.05;          // bootstrap p_value upper bound
export const DEFAULT_PROMOTE_K_DELTA = 0.02;    // K-Score uplift floor
export const DEFAULT_ROLLBACK_FALLBACK_DELTA = 0.05; // fallback_rate uplift trigger
export const DEFAULT_ROLLBACK_LATENCY_P95_PCT = 0.25; // p95 latency regression trigger
export const DEFAULT_MIN_SAMPLES = 30;
export const DEFAULT_BOOTSTRAP_ITERS = 1000;

// Audit op names (Object.freeze to discourage live mutation).
export const AB_PROMOTE_AUDIT_OPS = Object.freeze({
  PROMOTED: 'ab.promoted',
  ROLLED_BACK: 'ab.rolled_back',
  EVALUATED: 'ab.evaluated',
});

/**
 * decide({metrics, k_score_samples_a, k_score_samples_b, thresholds})
 *
 * Pure function -- no I/O, no audit emission. Returns:
 *   { decision: 'promote'|'rollback'|'hold',
 *     reason: 'k_score_uplift_significant' | 'fallback_regression'
 *           | 'latency_p95_regression' | 'insufficient_samples'
 *           | 'no_signal' | ...,
 *     deltas: {...}, sig: {...}, thresholds: {...}, version: 'w822-vN' }
 *
 * Inputs:
 *   metrics             -> shape returned by abAggregate() (per-variant rollup).
 *   k_score_samples_a/b -> raw arrays used by the bootstrap step. When absent,
 *                          we fall back to mean-only and report sig:null.
 *   thresholds          -> partial override of the DEFAULT_* constants.
 */
export function decide(opts = {}) {
  const t = Object.freeze({
    promote_p: Number.isFinite(Number(opts?.thresholds?.promote_p)) ? Number(opts.thresholds.promote_p) : DEFAULT_PROMOTE_P,
    promote_k_delta: Number.isFinite(Number(opts?.thresholds?.promote_k_delta)) ? Number(opts.thresholds.promote_k_delta) : DEFAULT_PROMOTE_K_DELTA,
    rollback_fallback_delta: Number.isFinite(Number(opts?.thresholds?.rollback_fallback_delta)) ? Number(opts.thresholds.rollback_fallback_delta) : DEFAULT_ROLLBACK_FALLBACK_DELTA,
    rollback_latency_p95_pct: Number.isFinite(Number(opts?.thresholds?.rollback_latency_p95_pct)) ? Number(opts.thresholds.rollback_latency_p95_pct) : DEFAULT_ROLLBACK_LATENCY_P95_PCT,
    min_samples: Number.isFinite(Number(opts?.thresholds?.min_samples)) ? Math.max(2, Math.trunc(Number(opts.thresholds.min_samples))) : DEFAULT_MIN_SAMPLES,
    bootstrap_iters: Number.isFinite(Number(opts?.thresholds?.bootstrap_iters)) ? Math.max(10, Math.trunc(Number(opts.thresholds.bootstrap_iters))) : DEFAULT_BOOTSTRAP_ITERS,
  });

  const metrics = opts.metrics || {};
  const aMet = metrics.a || metrics.metrics?.a;
  const bMet = metrics.b || metrics.metrics?.b;
  if (!aMet || !bMet) {
    return {
      decision: 'hold',
      reason: 'metrics_missing',
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }
  if (aMet.count < t.min_samples || bMet.count < t.min_samples) {
    return {
      decision: 'hold',
      reason: 'insufficient_samples',
      n_a: aMet.count,
      n_b: bMet.count,
      min_samples: t.min_samples,
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }

  const d = abDeltas({ a: aMet, b: bMet });

  // ── Rollback path runs first so a regression in B always wins over a
  // marginal-significant uplift on K-Score.
  if (Number.isFinite(d.fallback_rate_delta) && d.fallback_rate_delta > t.rollback_fallback_delta) {
    return {
      decision: 'rollback',
      reason: 'fallback_regression',
      deltas: d,
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }
  if (Number.isFinite(d.latency_p95_pct_delta) && d.latency_p95_pct_delta > t.rollback_latency_p95_pct) {
    return {
      decision: 'rollback',
      reason: 'latency_p95_regression',
      deltas: d,
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }

  // ── Promotion path. Needs (a) k_score uplift above floor AND (b) bootstrap
  // p_value below threshold. When raw samples weren't supplied we cannot run
  // the bootstrap -- in that case we hold and report 'no_sig_samples'.
  if (!Number.isFinite(Number(d.k_score_delta)) || Number(d.k_score_delta) <= t.promote_k_delta) {
    return {
      decision: 'hold',
      reason: 'k_score_uplift_below_floor',
      deltas: d,
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }

  let sig = null;
  if (Array.isArray(opts.k_score_samples_a) && Array.isArray(opts.k_score_samples_b)
      && opts.k_score_samples_a.length > 0 && opts.k_score_samples_b.length > 0) {
    try {
      sig = bootstrap({
        arr_a: opts.k_score_samples_a,
        arr_b: opts.k_score_samples_b,
        n_iters: t.bootstrap_iters,
        statistic: 'mean',
        seed: opts.seed,
      });
    } catch (e) {
      sig = { error: 'bootstrap_failed', detail: String(e && e.message || e), p_value: 1 };
    }
  } else {
    return {
      decision: 'hold',
      reason: 'no_sig_samples',
      deltas: d,
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }

  if (sig && Number.isFinite(Number(sig.p_value)) && Number(sig.p_value) < t.promote_p) {
    return {
      decision: 'promote',
      reason: 'k_score_uplift_significant',
      deltas: d,
      sig,
      thresholds: t,
      version: AB_PROMOTE_VERSION,
    };
  }

  return {
    decision: 'hold',
    reason: 'p_value_above_floor',
    deltas: d,
    sig,
    thresholds: t,
    version: AB_PROMOTE_VERSION,
  };
}

/**
 * evaluate({tenant_id, namespace, window_days, thresholds, seed}) -- glue
 * helper that runs the full pipeline: aggregate metrics -> decide -> emit
 * audit. Returns the decision plus the rollup that produced it.
 *
 * When the decision is 'promote' or 'rollback' an AUDIT_OPS row is appended
 * via src/audit.js (best-effort -- audit failure does NOT swallow the
 * decision; it surfaces as audit_emit_failed in the response).
 */
export async function evaluate(opts = {}) {
  const tenant_id = opts.tenant_id ? String(opts.tenant_id) : '';
  const namespace = opts.namespace ? String(opts.namespace) : null;
  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'evaluate({tenant_id, namespace}) requires tenant_id',
      version: AB_PROMOTE_VERSION,
    };
  }

  let metricsRes;
  try {
    metricsRes = await abAggregate({
      tenant_id,
      namespace,
      window_days: opts.window_days,
      since: opts.since,
      until: opts.until,
      ab_test_id: opts.ab_test_id,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'metrics_aggregate_failed',
      detail: String(e && e.message || e),
      version: AB_PROMOTE_VERSION,
    };
  }
  if (!metricsRes.ok) {
    return {
      ok: false,
      error: metricsRes.error || 'metrics_unavailable',
      hint: metricsRes.hint,
      version: AB_PROMOTE_VERSION,
    };
  }

  // Try to harvest raw k_score samples from the event-store for the bootstrap.
  // Best-effort -- on failure decide() falls back to 'no_sig_samples' = 'hold'.
  let samples_a = [];
  let samples_b = [];
  try {
    const es = await import('./event-store.js');
    const since = opts.since || (opts.window_days
      ? new Date(Date.now() - opts.window_days * 24 * 60 * 60 * 1000).toISOString()
      : null);
    const q = { tenant_id, limit: 100000, order: 'desc' };
    if (namespace) q.namespace = namespace;
    if (since) q.since = since;
    const rows = await es.listEvents(q);
    for (const ev of rows || []) {
      if (!ev || ev.tenant_id !== tenant_id) continue;
      let variant = (ev.variant === 'a' || ev.variant === 'b') ? ev.variant : null;
      let k = Number(ev.k_score);
      if (!Number.isFinite(k)) k = Number(ev.kscore);
      if (ev.feedback && typeof ev.feedback === 'string') {
        try {
          const fb = JSON.parse(ev.feedback);
          if (fb && (fb.variant === 'a' || fb.variant === 'b')) variant = fb.variant;
          if (fb && (fb.arm === 'a' || fb.arm === 'b')) variant = fb.arm;
          if (!Number.isFinite(k) && Number.isFinite(Number(fb.k_score))) k = Number(fb.k_score);
          if (!Number.isFinite(k) && Number.isFinite(Number(fb.kscore))) k = Number(fb.kscore);
        } catch { /* skip */ }
      }
      if (!Number.isFinite(k)) continue;
      if (variant === 'a') samples_a.push(k);
      else if (variant === 'b') samples_b.push(k);
    }
  } catch { /* best-effort */ }

  const decision = decide({
    metrics: metricsRes.metrics,
    k_score_samples_a: samples_a,
    k_score_samples_b: samples_b,
    thresholds: opts.thresholds,
    seed: opts.seed,
  });

  // Emit audit for non-'hold' decisions.
  let audit_emit = 'skipped';
  if (decision.decision === 'promote' || decision.decision === 'rollback') {
    try {
      const auditMod = await import('./audit.js');
      const op = decision.decision === 'promote' ? AB_PROMOTE_AUDIT_OPS.PROMOTED : AB_PROMOTE_AUDIT_OPS.ROLLED_BACK;
      auditMod.tryAppendAudit({
        tenant_id,
        op,
        payload: {
          namespace,
          ab_test_id: opts.ab_test_id || null,
          reason: decision.reason,
          deltas: decision.deltas,
          sig: decision.sig ? { p_value: decision.sig.p_value, ci_low: decision.sig.ci_low, ci_high: decision.sig.ci_high } : null,
          thresholds: decision.thresholds,
          n_a: metricsRes.metrics.a.count,
          n_b: metricsRes.metrics.b.count,
          version: AB_PROMOTE_VERSION,
        },
      });
      audit_emit = 'ok';
    } catch (e) {
      audit_emit = 'failed:' + String(e && e.message || e);
    }
  }

  return {
    ok: true,
    decision: decision.decision,
    reason: decision.reason,
    deltas: decision.deltas,
    sig: decision.sig,
    thresholds: decision.thresholds,
    metrics: metricsRes.metrics,
    n_total: metricsRes.n_total,
    audit_emit,
    metrics_version: AB_METRICS_VERSION,
    significance_version: SIGNIFICANCE_VERSION,
    version: AB_PROMOTE_VERSION,
  };
}

export default {
  AB_PROMOTE_VERSION,
  AB_PROMOTE_AUDIT_OPS,
  DEFAULT_PROMOTE_P,
  DEFAULT_PROMOTE_K_DELTA,
  DEFAULT_ROLLBACK_FALLBACK_DELTA,
  DEFAULT_ROLLBACK_LATENCY_P95_PCT,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_BOOTSTRAP_ITERS,
  decide,
  evaluate,
};
