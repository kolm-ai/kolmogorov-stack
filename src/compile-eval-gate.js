// compile-eval-gate.js - eval + regression gate bound to the receipt (P1).
//
// The promotion decision for a freshly-compiled candidate artifact must be
//   (a) computed from a REAL eval run (K-Score + regression classes), and
//   (b) bound into the signed receipt so the decision is tamper-evident.
//
// This module is the single chokepoint both `kolm compile` and the
// self-improvement orchestrator (src/improvement-orchestrator.js
// compareAndDecide) can call to BLOCK promotion. It reuses the exact scoring
// the rest of the codebase uses:
//   - src/kscore.js   computeKScore(input) -> { composite, ships, ... }
//   - the same regression-class delta logic compareAndDecide already uses
//     (candidate regression classes minus the ones the baseline already failed)
//   - src/gateway-receipt.js buildAndSignReceipt / verifyReceipt for the
//     Ed25519-signed binding.
//
// Public surface (ES module - the codebase is type:module):
//   evaluateAndGate({ candidate_artifact, baseline, thresholds })
//       -> { promote:bool, reason, eval_summary }
//   embedEvalSummaryReceipt({ eval_summary, namespace_id, candidate_artifact_id,
//                             artifact_id, signer })
//       -> { receipt, eval_summary_hash, key_fingerprint }   (signed binding)
//   verifyEvalSummaryReceipt(receipt, eval_summary)
//       -> { ok, reason? }
//   assertPromotable(gateResult) -> gateResult | throws EVAL_GATE_BLOCKED
//
// Design notes / traps honored:
//   - kscore.js computeKScore takes PER-AXIS numbers (accuracy, coverage,
//     size_bytes, p50_latency_us, cost_usd_per_call, + optional v2 axes), NOT a
//     {tasks:[]} shape. We normalize whatever the caller hands us into that
//     input. When the caller already has a composite K-Score on the artifact
//     (manifest.k_score / eval_results.kscore) we use it directly rather than
//     recompute from missing axes.
//   - The gateway receipt is a FIXED-FIELD kolm-audit-1 schema; arbitrary
//     fields cannot be stuffed into the signed body or validateReceipt() throws.
//     So we bind the eval_summary by hashing its canonical form and carrying
//     that digest in the receipt's `output_hash` slot (which is exactly a
//     sha256 of decision-relevant output) + the candidate artifact id in
//     `artifact_id`. Tampering with either the summary or the receipt breaks
//     verification. This keeps the binding inside the Ed25519 signature without
//     forking the receipt schema.
//   - Fail-closed defaults: no eval -> block; min_kscore_delta default mirrors
//     compareAndDecide's 0.02; max regression classes default 0.

import { computeKScore } from './kscore.js';
import { buildAndSignReceipt, verifyReceipt, hashOutput } from './gateway-receipt.js';
// finalized-c6 - significance-bounded gate (multiplicity-controlled). Imported
// statically (it only depends on stat-sig.js -> no import cycle). evaluateAndGate
// delegates to it ONLY when per_case vectors are present AND the flag is armed;
// the point-delta path below stays the default + fallback.
import { buildTestFamily as sigBuildTestFamily, significanceBoundedGate } from './significance-bounded-gate.js';
import { envBool as sigEnvBool } from './env.js';

export const EVAL_GATE_VERSION = 'w-eval-gate-v1';

// Mirror compareAndDecide's defaults so the two decision paths agree.
const DEFAULT_THRESHOLDS = Object.freeze({
  min_kscore_delta: 0.02,   // candidate composite must beat baseline by this much
  max_regression_classes: 0,
  min_kscore_abs: 0,        // optional absolute floor on the candidate composite
});

function isObject(v) { return v !== null && typeof v === 'object'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---------------------------------------------------------------------------
// extract a composite K-Score from whatever artifact/eval shape we were given.
// Resolution order:
//   1. explicit composite already on the artifact/manifest/eval_results
//   2. compute from per-axis eval fields via kscore.computeKScore
//   3. null  (caller decides whether that blocks)
// Returns { score:number|null, source:string, kscore_envelope:object|null }.
// ---------------------------------------------------------------------------
function resolveKScore(ref) {
  if (!isObject(ref)) return { score: null, source: 'none', kscore_envelope: null };

  // unwrap common containers
  const manifest = isObject(ref.manifest) ? ref.manifest : ref;
  const evalResults =
    (isObject(ref.eval_results) && ref.eval_results) ||
    (isObject(manifest.eval_results) && manifest.eval_results) ||
    (isObject(ref.eval) && ref.eval) ||
    null;

  // 1 - explicit composite
  const explicit =
    num(ref.k_score) ?? num(manifest.k_score) ?? num(ref.kscore) ?? num(manifest.kscore) ??
    (evalResults ? (num(evalResults.kscore) ?? num(evalResults.k_score) ?? num(evalResults.composite)) : null) ??
    num(ref.composite);
  if (explicit != null) {
    return { score: explicit, source: 'explicit_k_score', kscore_envelope: null };
  }

  // 2 - compute from per-axis fields if accuracy is present
  const axisSource = evalResults || ref.kscore_input || manifest.kscore_input || ref;
  const accuracy = num(axisSource.accuracy);
  if (accuracy != null) {
    const env = computeKScore({
      accuracy,
      coverage: num(axisSource.coverage) ?? 0,
      size_bytes: num(axisSource.size_bytes) ?? num(manifest.size_bytes) ?? 0,
      p50_latency_us: num(axisSource.p50_latency_us),
      cost_usd_per_call: num(axisSource.cost_usd_per_call) ?? 0,
      // optional v2 axes - pass through when present so the gate honors them
      holdout_accuracy: num(axisSource.holdout_accuracy),
      subgroup_min_accuracy: num(axisSource.subgroup_min_accuracy),
      joules_per_call: num(axisSource.joules_per_call),
      eval_set_drift: num(axisSource.eval_set_drift),
      teacher_holdout_accuracy: num(axisSource.teacher_holdout_accuracy),
    });
    return { score: num(env.composite), source: 'computed_k_score', kscore_envelope: env };
  }

  return { score: null, source: 'none', kscore_envelope: null };
}

// Pull the regression-class list from an artifact/manifest. Matches the field
// names compareAndDecide + _readKScoreFromArtifact already read.
function resolveRegressionClasses(ref) {
  if (!isObject(ref)) return [];
  const manifest = isObject(ref.manifest) ? ref.manifest : ref;
  const fromAny =
    (Array.isArray(ref.regression_classes) && ref.regression_classes) ||
    (Array.isArray(ref.regressions) && ref.regressions) ||
    (Array.isArray(manifest.regression_classes) && manifest.regression_classes) ||
    (Array.isArray(manifest.regressions) && manifest.regressions) ||
    (isObject(manifest.eval_results) && Array.isArray(manifest.eval_results.regressions) && manifest.eval_results.regressions) ||
    (isObject(ref.eval_results) && Array.isArray(ref.eval_results.regressions) && ref.eval_results.regressions) ||
    [];
  return fromAny.slice();
}

function artifactId(ref) {
  if (!isObject(ref)) return null;
  return ref.id || ref.artifact_id ||
    (isObject(ref.manifest) ? (ref.manifest.id || ref.manifest.artifact_id) : null) || null;
}

// Stable canonical stringify so the eval_summary hash is reproducible
// regardless of key insertion order. Sorts object keys recursively.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export function hashEvalSummary(eval_summary) {
  return hashOutput(canonical(eval_summary || {}));
}

// ---------------------------------------------------------------------------
// evaluateAndGate - the gate.
// ---------------------------------------------------------------------------
//
// candidate_artifact / baseline may each be:
//   - an artifact object ({ id, manifest:{ k_score, regression_classes, ... } })
//   - a manifest object
//   - an eval_results object ({ accuracy, coverage, kscore, regressions:[...] })
//   - or carry an explicit composite ({ k_score } / { composite })
// baseline may be null (first compile - no incumbent). With no baseline, delta
// is computed against 0 and the decision falls back to the absolute floor.
//
// Returns { promote, reason, eval_summary }. Pure + synchronous: the caller is
// responsible for having RUN the eval and attached results before calling, so
// the decision is deterministic and the receipt is reproducible.
export function evaluateAndGate({ candidate_artifact, baseline, thresholds } = {}) {
  // finalized-c6 - delegate to the significance-bounded, multiplicity-controlled
  // gate when BOTH artifacts carry index-aligned per_case score vectors and the
  // operator armed KOLM_EVAL_GATE_SIGNIFICANCE=1 (or thresholds.significance is
  // explicitly set). This turns an N-axis/N-subgroup report into a single
  // corrected go/no-go (BH/Holm + paired bootstrap + mSPRT) instead of N
  // independent claims. When per_case vectors are absent OR the flag is off, the
  // point-delta path below runs unchanged (the load-bearing fallback), so no
  // existing caller / test outcome changes.
  const _wantSig = (thresholds && thresholds.significance != null)
    ? !!thresholds.significance
    : sigEnvBool('KOLM_EVAL_GATE_SIGNIFICANCE', false);
  const _hasPerCase = !!(candidate_artifact && candidate_artifact.per_case
    && baseline && baseline.per_case);
  if (_wantSig && _hasPerCase) {
    const sigOpts = (thresholds && typeof thresholds.significance === 'object') ? thresholds.significance : {};
    const family = sigBuildTestFamily({ candidate: candidate_artifact, baseline });
    const g = significanceBoundedGate({
      family,
      alpha: sigOpts.alpha,
      min_kscore_delta: (sigOpts.min_kscore_delta != null) ? sigOpts.min_kscore_delta
        : (thresholds && thresholds.min_kscore_delta),
      correction: sigOpts.correction,
      bootstrap_method: sigOpts.bootstrap_method,
      bootstrap_iters: sigOpts.bootstrap_iters,
      min_samples: sigOpts.min_samples,
      regression_min_drop: sigOpts.regression_min_drop,
      seed: sigOpts.seed,
    });
    // fail-closed: only an explicit 'promote' promotes; block/abstain do not.
    const promote = g.decision === 'promote';
    return {
      promote,
      reason: `significance-bounded gate: ${g.decision} (${g.reason})`,
      eval_summary: {
        schema: 'kolm.eval_gate.significance.v1',
        eval_gate_version: EVAL_GATE_VERSION,
        decision: g.decision,
        promote,
        mode: 'significance_bounded',
        significance: g,
        candidate_artifact_id: artifactId(candidate_artifact),
        baseline_artifact_id: artifactId(baseline),
        evaluated_at: new Date().toISOString(),
      },
    };
  }
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const minDelta = num(th.min_kscore_delta) ?? DEFAULT_THRESHOLDS.min_kscore_delta;
  const maxRegress = num(th.max_regression_classes) ?? DEFAULT_THRESHOLDS.max_regression_classes;
  const minAbs = num(th.min_kscore_abs) ?? 0;

  const cand = resolveKScore(candidate_artifact);
  const base = resolveKScore(baseline);

  const candScore = cand.score;
  const baseScore = base.score == null ? 0 : base.score;
  const delta = candScore == null ? null : Number((candScore - baseScore).toFixed(6));

  // New regressions = candidate classes the baseline did not already fail.
  const candRegr = resolveRegressionClasses(candidate_artifact);
  const baseRegr = resolveRegressionClasses(baseline);
  const newRegressions = candRegr.filter((c) => !baseRegr.includes(c));
  const regressionCount = newRegressions.length;

  // ---- decision (fail-closed) -------------------------------------------
  let promote = true;
  let reason = 'promoted: meets K-Score delta and regression thresholds';

  if (candScore == null) {
    promote = false;
    reason = 'blocked: candidate has no resolvable K-Score (run an eval before gating)';
  } else if (candScore < minAbs) {
    promote = false;
    reason = `blocked: candidate K-Score ${candScore.toFixed(4)} < absolute floor ${minAbs}`;
  } else if (delta < minDelta) {
    promote = false;
    reason = `blocked: K-Score delta ${delta.toFixed(4)} < min ${minDelta} ` +
             `(candidate ${candScore.toFixed(4)} vs baseline ${baseScore.toFixed(4)})`;
  } else if (regressionCount > maxRegress) {
    promote = false;
    reason = `blocked: ${regressionCount} new regression class(es) > max ${maxRegress} ` +
             `[${newRegressions.join(', ')}]`;
  }

  const eval_summary = {
    schema: 'kolm.eval_gate.v1',
    eval_gate_version: EVAL_GATE_VERSION,
    decision: promote ? 'promote' : 'block',
    promote,
    reason,
    evaluated_at: new Date().toISOString(),
    candidate_artifact_id: artifactId(candidate_artifact),
    baseline_artifact_id: artifactId(baseline),
    kscore: {
      candidate: candScore,
      baseline: base.score,            // null when no baseline
      delta,
      candidate_source: cand.source,
      baseline_source: base.source,
      candidate_envelope: cand.kscore_envelope, // null when explicit/precomputed
    },
    regressions: {
      new_count: regressionCount,
      new_classes: newRegressions,
      candidate_classes: candRegr,
      baseline_classes: baseRegr,
    },
    thresholds: {
      min_kscore_delta: minDelta,
      max_regression_classes: maxRegress,
      min_kscore_abs: minAbs,
    },
  };

  return { promote, reason, eval_summary };
}

// ---------------------------------------------------------------------------
// embedEvalSummaryReceipt - bind the eval_summary into a signed receipt.
// ---------------------------------------------------------------------------
//
// The gateway receipt is a fixed-field kolm-audit-1 schema, so we bind the
// summary by hashing its canonical form into the receipt's `output_hash` and
// carrying the candidate artifact id in `artifact_id`. The Ed25519 signature
// then covers both - tampering with the summary OR the receipt fails
// verifyEvalSummaryReceipt(). This is the "embed the eval_summary INTO the
// signed receipt" step the integrator calls right after evaluateAndGate().
//
// Returns { receipt, eval_summary_hash, key_fingerprint, signed_at }.
export function embedEvalSummaryReceipt({
  eval_summary,
  namespace_id,
  candidate_artifact_id,
  artifact_id,
  signer,
  signing_key_id,
  verify_url_base,
} = {}) {
  const summaryHash = hashEvalSummary(eval_summary);
  const aid = candidate_artifact_id || artifact_id ||
    (eval_summary && eval_summary.candidate_artifact_id) || null;
  const built = buildAndSignReceipt({
    namespace_id: namespace_id || 'eval-gate',
    route_decision: 'local',           // a compile/promotion decision, not a frontier call
    provider: 'local-kolm',
    model: 'kolm-eval-gate',
    artifact_id: aid,
    // bind the canonical eval_summary digest as the receipt output hash:
    output_hash: summaryHash,
    // input_hash anchors the decision context (candidate vs baseline ids).
    input_hash: hashOutput(canonical({
      candidate: aid,
      baseline: eval_summary && eval_summary.baseline_artifact_id,
      decision: eval_summary && eval_summary.decision,
    })),
    capture_eligible: false,
    signer,
    signing_key_id,
    verify_url_base,
  });
  return {
    receipt: built.receipt,
    eval_summary_hash: summaryHash,
    key_fingerprint: built.key_fingerprint,
    signed_at: built.signed_at,
  };
}

// verifyEvalSummaryReceipt - confirm the signature AND that the receipt's
// output_hash still matches the canonical hash of the supplied eval_summary.
// Returns { ok, reason? }.
export function verifyEvalSummaryReceipt(receipt, eval_summary) {
  const sig = verifyReceipt(receipt);
  if (!sig.ok) return { ok: false, reason: 'signature: ' + (sig.reason || 'invalid') };
  const expected = hashEvalSummary(eval_summary);
  if (receipt.output_hash !== expected) {
    return { ok: false, reason: 'eval_summary hash does not match receipt.output_hash (tampered)' };
  }
  return { ok: true, key_fingerprint: sig.key_fingerprint };
}

// assertPromotable - fail-closed control flow for callers that prefer throwing
// over inspecting .promote. Throws an error tagged EVAL_GATE_BLOCKED carrying
// the eval_summary so the caller can surface / persist the refusal.
export function assertPromotable(gateResult) {
  if (!gateResult || gateResult.promote !== true) {
    const err = new Error((gateResult && gateResult.reason) || 'eval gate blocked promotion');
    err.code = 'EVAL_GATE_BLOCKED';
    err.eval_summary = gateResult && gateResult.eval_summary;
    throw err;
  }
  return gateResult;
}

export { DEFAULT_THRESHOLDS };
