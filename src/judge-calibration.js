// src/judge-calibration.js
//
// W921 — Judge calibration with conformal prediction intervals + multi-judge
// disagreement for the K-score / release gate.
//
// Turns a scalar ship/no-ship gate into a CALIBRATED THREE-STATE decision with
// finite-sample coverage guarantees and an explicit ABSTAIN zone, plus a
// multi-judge disagreement signal that detects when the gate itself is
// unreliable. Pure JS (no numeric dep) so it runs in the K-score hot path and
// in a no-Python recalibration CLI — deliberately mirrors src/bradley-terry.js.
//
// THREE LAYERS:
//   1. Split-conformal interval on the judge/K score. Nonconformity
//      s_i = |yhat_i - y_i|; qhat = ceil((n+1)(1-alpha))/n empirical quantile;
//      interval C = [yhat - qhat, yhat + qhat] with marginal coverage
//      1-alpha <= P(y in C) <= 1-alpha + 1/(n+1) under exchangeability
//      (Sheng et al., EMNLP 2025, arXiv:2509.18658). Ordinal boundary
//      adjustment for discrete 1-10 rubric scores (Theorem 1 shrink).
//   2. Mondrian (class-conditional) conformal per task category, so a thin
//      category never borrows a fat category's slack (insufficient_data).
//   3. Multi-judge disagreement gate (PoLL, Verga et al., arXiv:2404.18796):
//      spread >= sigma_max OR n_completed < quorum => UNRELIABLE => abstain.
//
// DECISION FUSION (three-state):
//   SHIP   if conformal lower bound >= GATE AND spread < sigma_max AND quorum met
//   ABSTAIN if interval straddles GATE, or spread >= sigma_max, or quorum unmet
//   REJECT  if conformal upper bound < GATE
// Falls back to the exact legacy scalar decision when no calibration exists
// (basis:'scalar_fallback') — zero behavior change for existing users.

export const CONFORMAL_SPEC = 'kolm-split-conformal-1';
export const GATE_DECISION_VERSION = 'kolm-gate-decision-1';

// Default coverage target alpha=0.10 (90% coverage). Chosen so solidly-good
// models still ship while genuinely-uncertain ones abstain.
export const DEFAULT_ALPHA = 0.10;
// Minimum labeled pairs per Mondrian category before a per-category qhat is
// trusted; below this the category reports insufficient_data (honest contract,
// never silent pooling). Mirrors the W810 MIN_PAIRS_PER_CATEGORY convention.
export const MIN_PAIRS_PER_CATEGORY = 20;
// Judge-panel reliability defaults.
export const DEFAULT_SIGMA_MAX = 0.15;
export const DEFAULT_QUORUM = 2;

function _isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// conformalQuantile(scores, alpha) — the ceil((n+1)(1-alpha))/n empirical
// quantile of nonconformity scores. Returns +Infinity when the required rank
// exceeds n (the coverage level cannot be met from this calibration set), which
// the interval builder turns into the trivial [min,max] band.
export function conformalQuantile(scores, alpha = DEFAULT_ALPHA) {
  if (!Array.isArray(scores)) throw new Error('conformalQuantile: scores must be an array');
  const s = scores.filter(_isFiniteNum).slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  if (!_isFiniteNum(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error('conformalQuantile: alpha must be in (0,1)');
  }
  // Rank: ceil((n+1)*(1-alpha)). 1-indexed.
  const rank = Math.ceil((n + 1) * (1 - alpha));
  if (rank > n) return Infinity; // cannot guarantee coverage from this n
  return s[rank - 1];
}

// fitSplitConformal(residuals, alpha) — fit qhat on absolute residuals.
export function fitSplitConformal(residuals, alpha = DEFAULT_ALPHA) {
  const clean = (Array.isArray(residuals) ? residuals : []).filter(_isFiniteNum).map(Math.abs);
  const n = clean.length;
  const qhat = conformalQuantile(clean, alpha);
  return {
    spec: CONFORMAL_SPEC,
    qhat,
    n,
    alpha,
    coverage_lo: 1 - alpha,
    coverage_hi: n > 0 ? Math.min(1, 1 - alpha + 1 / (n + 1)) : 1,
    status: n === 0 ? 'insufficient_data' : (qhat === Infinity ? 'unbounded' : 'ok'),
  };
}

// ordinalBoundaryAdjust(lower, upper) — Theorem-1 coverage-preserving shrink
// for discrete integer-rubric scores. Round the interval INWARD (ceil lower,
// floor upper) so the integer interval is a subset that still covers; never
// widen. If the shrink would invert the interval (lo>hi), snap both to the
// nearest integer of the midpoint so we never return an empty set.
export function ordinalBoundaryAdjust(lower, upper, ratingMin = 1, ratingMax = 10) {
  if (!_isFiniteNum(lower) || !_isFiniteNum(upper)) return { lower, upper };
  let lo = Math.ceil(lower);
  let hi = Math.floor(upper);
  if (lo > hi) {
    const mid = Math.round((lower + upper) / 2);
    lo = mid; hi = mid;
  }
  lo = Math.max(ratingMin, Math.min(ratingMax, lo));
  hi = Math.max(ratingMin, Math.min(ratingMax, hi));
  if (lo > hi) { const m = Math.round((lo + hi) / 2); lo = m; hi = m; }
  return { lower: lo, upper: hi };
}

// conformalInterval(yhat, qhat, opts) — build the prediction interval around a
// new prediction. clamp01 keeps continuous [0,1] K-scores in range; ordinal
// applies the integer-rubric shrink.
export function conformalInterval(yhat, qhat, opts = {}) {
  const { ordinal = false, ratingMin = 1, ratingMax = 10, clamp01 = false } = opts;
  if (!_isFiniteNum(yhat)) throw new Error('conformalInterval: yhat must be a number');
  let lower, upper;
  if (qhat === Infinity || qhat === null) {
    // Unbounded — trivial coverage band.
    lower = clamp01 ? 0 : (ordinal ? ratingMin : -Infinity);
    upper = clamp01 ? 1 : (ordinal ? ratingMax : Infinity);
  } else {
    lower = yhat - qhat;
    upper = yhat + qhat;
  }
  if (clamp01) {
    lower = Math.max(0, lower);
    upper = Math.min(1, upper);
  }
  if (ordinal) {
    const adj = ordinalBoundaryAdjust(lower, upper, ratingMin, ratingMax);
    lower = adj.lower; upper = adj.upper;
  }
  const midpoint = (lower + upper) / 2;
  const width = upper - lower;
  return { lower, upper, midpoint, width };
}

// fitMondrianConformal(rowsByCategory, alpha, minPairs) — per-category +
// pooled split-conformal. rowsByCategory: { coding:[{yhat,y},...], ... }.
export function fitMondrianConformal(rowsByCategory, alpha = DEFAULT_ALPHA, minPairs = MIN_PAIRS_PER_CATEGORY) {
  const by_category = {};
  const pooledResiduals = [];
  if (rowsByCategory && typeof rowsByCategory === 'object') {
    for (const [cat, rows] of Object.entries(rowsByCategory)) {
      const residuals = (Array.isArray(rows) ? rows : [])
        .filter((r) => r && _isFiniteNum(r.yhat) && _isFiniteNum(r.y))
        .map((r) => Math.abs(r.yhat - r.y));
      for (const r of residuals) pooledResiduals.push(r);
      if (residuals.length < minPairs) {
        by_category[cat] = { qhat: null, n: residuals.length, status: 'insufficient_data' };
      } else {
        const fit = fitSplitConformal(residuals, alpha);
        by_category[cat] = { qhat: fit.qhat, n: fit.n, status: fit.status };
      }
    }
  }
  const pooledFit = fitSplitConformal(pooledResiduals, alpha);
  return {
    spec: CONFORMAL_SPEC,
    version: CONFORMAL_SPEC,
    alpha,
    min_pairs: minPairs,
    by_category,
    pooled: { qhat: pooledFit.qhat, n: pooledFit.n, status: pooledFit.status },
  };
}

// applyConformal(mapping, category, yhat) — look up the right qhat (category
// first, never silently pooled) and build the interval for a new prediction.
// Returns status:'insufficient_data' when the category lacks data (the caller
// decides whether to fall back to pooled EXPLICITLY).
export function applyConformal(mapping, category, yhat, opts = {}) {
  if (!mapping || typeof mapping !== 'object') return null;
  const alpha = _isFiniteNum(mapping.alpha) ? mapping.alpha : DEFAULT_ALPHA;
  const coverage_target = 1 - alpha;
  const cat = mapping.by_category && mapping.by_category[category];
  if (cat && cat.status === 'ok' && _isFiniteNum(cat.qhat)) {
    const iv = conformalInterval(yhat, cat.qhat, { clamp01: true, ...opts });
    return { status: 'ok', ...iv, qhat: cat.qhat, coverage_target, n_pairs: cat.n, scope: 'category' };
  }
  if (cat && cat.status === 'insufficient_data') {
    return { status: 'insufficient_data', qhat: null, coverage_target, n_pairs: cat.n, scope: 'category' };
  }
  // Unknown category — if explicitly allowed, fall back to pooled.
  if (opts.allow_pooled && mapping.pooled && mapping.pooled.status === 'ok' && _isFiniteNum(mapping.pooled.qhat)) {
    const iv = conformalInterval(yhat, mapping.pooled.qhat, { clamp01: true, ...opts });
    return { status: 'ok', ...iv, qhat: mapping.pooled.qhat, coverage_target, n_pairs: mapping.pooled.n, scope: 'pooled' };
  }
  return { status: 'unknown_category', qhat: null, coverage_target, n_pairs: 0, scope: 'none' };
}

// ── Multi-judge disagreement ───────────────────────────────────────────────

function _mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function _pstdev(a) {
  if (a.length === 0) return 0;
  const m = _mean(a);
  return Math.sqrt(_mean(a.map((x) => (x - m) * (x - m))));
}

// judgeDisagreement(perJudgeScores) — spread (population stdev) + range over a
// panel of per-judge scalar scores. unreliable is left to the caller's
// sigma_max threshold (decideGate); here we report the raw signals.
export function judgeDisagreement(perJudgeScores, opts = {}) {
  const sigma_max = _isFiniteNum(opts.sigma_max) ? opts.sigma_max : DEFAULT_SIGMA_MAX;
  const quorum = Number.isInteger(opts.quorum) ? opts.quorum : DEFAULT_QUORUM;
  const s = (Array.isArray(perJudgeScores) ? perJudgeScores : []).filter(_isFiniteNum);
  const n = s.length;
  if (n === 0) {
    return { spread: null, range: null, n: 0, unreliable: true, reason: 'no_judges' };
  }
  const spread = _pstdev(s);
  const range = Math.max(...s) - Math.min(...s);
  const unreliable = n < quorum || spread >= sigma_max;
  return {
    spread: Number(spread.toFixed(6)),
    range: Number(range.toFixed(6)),
    n,
    unreliable,
    reason: n < quorum ? 'quorum_unmet' : (spread >= sigma_max ? 'high_spread' : 'reliable'),
  };
}

// ── Three-state gate fusion ────────────────────────────────────────────────

// decideGate(args) — fuse a conformal interval + judge disagreement into a
// three-state decision. When `conformal` is null and `judge_spread` is null,
// falls back to the legacy scalar decision (composite >= gate) with
// basis:'scalar_fallback' so existing users see zero change.
export function decideGate({
  composite,
  conformal = null,
  judge_spread = null,
  n_completed = null,
  gate = 0.85,
  alpha = DEFAULT_ALPHA,
  sigma_max = DEFAULT_SIGMA_MAX,
  quorum = DEFAULT_QUORUM,
} = {}) {
  const reasons = [];
  const haveConformal = conformal && conformal.status === 'ok' &&
    _isFiniteNum(conformal.lower) && _isFiniteNum(conformal.upper);
  const havePanel = _isFiniteNum(judge_spread) || _isFiniteNum(n_completed);

  let basis;
  if (haveConformal && havePanel) basis = 'conformal+panel';
  else if (haveConformal) basis = 'conformal';
  else if (havePanel) basis = 'panel';
  else basis = 'scalar_fallback';

  // Panel reliability.
  let panelUnreliable = false;
  if (havePanel) {
    if (_isFiniteNum(n_completed) && n_completed < quorum) {
      panelUnreliable = true;
      reasons.push(`quorum_unmet:${n_completed}<${quorum}`);
    }
    if (_isFiniteNum(judge_spread) && judge_spread >= sigma_max) {
      panelUnreliable = true;
      reasons.push(`high_judge_spread:${judge_spread.toFixed(3)}>=${sigma_max}`);
    }
  }

  let state, lower = null, upper = null, qhat = null, coverage_target = null;

  if (haveConformal) {
    lower = conformal.lower;
    upper = conformal.upper;
    qhat = _isFiniteNum(conformal.qhat) ? conformal.qhat : null;
    coverage_target = _isFiniteNum(conformal.coverage_target) ? conformal.coverage_target : (1 - alpha);
    if (upper < gate) {
      state = 'reject';
      reasons.push(`interval_below_gate:[${lower.toFixed(3)},${upper.toFixed(3)}]<${gate}`);
    } else if (lower >= gate) {
      state = 'ship';
      reasons.push(`interval_above_gate:[${lower.toFixed(3)},${upper.toFixed(3)}]>=${gate}`);
    } else {
      state = 'abstain';
      reasons.push(`interval_straddles_gate:[${lower.toFixed(3)},${upper.toFixed(3)}] around ${gate}`);
    }
    // Panel unreliability can DOWNGRADE a ship to abstain, never upgrade.
    if (state === 'ship' && panelUnreliable) {
      state = 'abstain';
      reasons.push('downgraded_ship_to_abstain_on_panel');
    }
  } else if (havePanel) {
    // No conformal interval — use the scalar composite but let the panel force
    // abstain when unreliable.
    const scalarShip = _isFiniteNum(composite) && composite >= gate;
    if (!scalarShip) {
      state = 'reject';
      reasons.push(`scalar_below_gate:${_isFiniteNum(composite) ? composite.toFixed(3) : 'na'}<${gate}`);
    } else if (panelUnreliable) {
      state = 'abstain';
      reasons.push('scalar_ship_but_panel_unreliable');
    } else {
      state = 'ship';
      reasons.push(`scalar_above_gate:${composite.toFixed(3)}>=${gate}`);
    }
  } else {
    // Pure scalar fallback — exactly the legacy decision.
    const scalarShip = _isFiniteNum(composite) && composite >= gate;
    state = scalarShip ? 'ship' : 'reject';
    reasons.push(scalarShip
      ? `scalar_fallback_ship:${composite.toFixed(3)}>=${gate}`
      : `scalar_fallback_reject:${_isFiniteNum(composite) ? composite.toFixed(3) : 'na'}<${gate}`);
  }

  return {
    spec: GATE_DECISION_VERSION,
    state,
    lower,
    upper,
    qhat,
    coverage_target,
    judge_spread: _isFiniteNum(judge_spread) ? judge_spread : null,
    n_judges: _isFiniteNum(n_completed) ? n_completed : null,
    basis,
    gate,
    reasons,
  };
}

// _attachGateDecision(envelope, input) — ADDITIVE decoration of a K-score
// envelope. NEVER mutates ships/weights/axes; sets envelope.gate_decision only.
// `input` carries the optional conformal mapping + category + panel signals.
export function attachGateDecision(envelope, input = {}) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const composite = _isFiniteNum(envelope.composite) ? envelope.composite
    : (envelope.k_score && _isFiniteNum(envelope.k_score.composite) ? envelope.k_score.composite : null);
  const gate = _isFiniteNum(input.gate) ? input.gate : 0.85;
  const alpha = _isFiniteNum(input.alpha) ? input.alpha : DEFAULT_ALPHA;

  let conformal = null;
  if (input.conformal_mapping && input.category != null && _isFiniteNum(composite)) {
    const iv = applyConformal(input.conformal_mapping, input.category, composite, { clamp01: true, allow_pooled: !!input.allow_pooled });
    if (iv && iv.status === 'ok') conformal = iv;
  } else if (input.conformal && typeof input.conformal === 'object') {
    conformal = input.conformal;
  }

  const decision = decideGate({
    composite,
    conformal,
    judge_spread: _isFiniteNum(input.judge_spread) ? input.judge_spread : null,
    n_completed: _isFiniteNum(input.n_completed) ? input.n_completed : null,
    gate,
    alpha,
    sigma_max: _isFiniteNum(input.sigma_max) ? input.sigma_max : DEFAULT_SIGMA_MAX,
    quorum: Number.isInteger(input.quorum) ? input.quorum : DEFAULT_QUORUM,
  });
  // Additive only — do not touch any existing field.
  return { ...envelope, gate_decision: decision };
}

export default {
  CONFORMAL_SPEC,
  GATE_DECISION_VERSION,
  DEFAULT_ALPHA,
  MIN_PAIRS_PER_CATEGORY,
  DEFAULT_SIGMA_MAX,
  DEFAULT_QUORUM,
  conformalQuantile,
  fitSplitConformal,
  ordinalBoundaryAdjust,
  conformalInterval,
  fitMondrianConformal,
  applyConformal,
  judgeDisagreement,
  decideGate,
  attachGateDecision,
};
