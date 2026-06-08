// W718 - MULTI-TEACHER ENSEMBLE BLENDING (Teacher Council)
//
// Implements the Teacher Council weighting formula from the 2026-05-24
// research doc Breakthrough 3 (docs/research/kolm-billion-dollar-distillation-
// lab-2026-05-24.md). Per-task, per-capture teacher selection driven by a
// softmaxed linear combination of reliability + cost + risk signals:
//
//   teacher_weight_j(i) = softmax(
//       gamma_domain   * domain_reliability_j[d_i]
//     + gamma_task     * task_reliability_j[t_i]
//     + gamma_verifier * verifier_agreement_j[i]
//     + gamma_human    * human_preference_j[i]
//     - gamma_cost     * normalized_cost_j
//     - gamma_risk     * policy_risk_j
//   )
//
// Why softmax: the formula returns a *distribution* over teachers per capture,
// not a hard winner. The downstream blender (blendTargets) can either pick
// argmax (text outputs - picking a weighted mean of two distinct strings is
// meaningless) OR weighted-mean across logits (numeric vectors).
//
// Honesty contract:
//   - Default reliability is 0.5 for an unknown (teacher, domain, task) - never
//     fabricated, never 1.0. The caller MUST run a bakeoff to upgrade the
//     prior.
//   - cost / risk are LOWERED contributions (gamma_cost / gamma_risk are
//     subtracted from the softmax logit), so a high-cost teacher gets less
//     weight all else equal.
//   - Every weight carries a `contributions` breakdown so a downstream auditor
//     can answer "why did this teacher win?" without re-running the formula.
//
// Tenant fence: this module is PURE compute. It does not read or write the
// event-store. The caller (distill-pipeline.js) is responsible for tenant
// scoping. Per W604 the math is gentle on zero-population edge cases - 
// computeTeacherWeights([], ...) returns [] not a divide-by-zero.

export const TEACHER_COUNCIL_VERSION = 'w718-v1';

// W718 - gamma defaults. Tuned to put human preference > domain/task
// reliability > verifier agreement > cost > risk. Operators who want a
// different mix pass opts.gamma to computeTeacherWeights().
//
// Why these specific numbers:
//   - gamma_human (1.2) - outranks all reliability signals because a real
//     human preference rating is the highest-information signal we have.
//   - gamma_domain / gamma_task (1.0) - equal-weighted reliability priors.
//   - gamma_verifier (0.8) - slightly downweighted vs. reliability because an
//     auto-verifier (regex / classifier) is more brittle than a real human.
//   - gamma_cost (0.3) - a small cost penalty. Cost matters but should not
//     dominate quality. Operators on a budget can raise this to 1.0+.
//   - gamma_risk (0.6) - a moderate policy-risk penalty. A capture flagged
//     'high_risk' (e.g. tool-use that touches prod, regulated-data prompts)
//     should bias toward the most conservative teacher.
export const GAMMA_DEFAULTS = Object.freeze({
  domain: 1.0,
  task: 1.0,
  verifier: 0.8,
  human: 1.2,
  cost: 0.3,
  risk: 0.6,
});

// W718 - softmax helper. Numerically stable (subtract max before exp). Returns
// an array of probabilities summing to ~1.0 within float epsilon.
function softmax(logits) {
  if (!Array.isArray(logits) || logits.length === 0) return [];
  const m = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    // Degenerate input - uniform fallback.
    return logits.map(() => 1 / logits.length);
  }
  return exps.map((e) => e / sum);
}

// W718 - extract a capture's domain + task + risk + cost-normalisation hints.
// Captures in this codebase are NOT uniformly shaped (the event-store row, the
// approval row, the distill seed, and the bakeoff row all differ), so we
// accept several aliases and fall back gracefully when a field is missing.
function _captureDomain(capture) {
  if (!capture || typeof capture !== 'object') return 'default';
  return String(capture.domain || capture.namespace || capture.corpus_namespace || 'default');
}
function _captureTask(capture) {
  if (!capture || typeof capture !== 'object') return 'generation';
  return String(capture.task || capture.task_type || capture.intent || 'generation');
}
function _captureRisk(capture) {
  if (!capture || typeof capture !== 'object') return 0;
  const r = capture.policy_risk;
  if (typeof r === 'number' && Number.isFinite(r)) return Math.max(0, Math.min(1, r));
  if (capture.risk_level === 'high') return 1.0;
  if (capture.risk_level === 'medium') return 0.5;
  if (capture.risk_level === 'low') return 0.1;
  return 0;
}

// W718 - pull verifier_agreement / human_preference signals OFF the capture
// (per-teacher dict). The capture row may carry pre-computed per-teacher
// scores from a prior verification pass; if not, we fall back to a neutral
// 0.5 prior so the math doesn't crash.
function _verifierAgreement(capture, teacher) {
  if (!capture || typeof capture !== 'object') return 0.5;
  const v = capture.verifier_agreement;
  if (v && typeof v === 'object' && teacher in v) return _clamp01(v[teacher]);
  return 0.5;
}
function _humanPreference(capture, teacher) {
  if (!capture || typeof capture !== 'object') return 0.5;
  const v = capture.human_preference;
  if (v && typeof v === 'object' && teacher in v) return _clamp01(v[teacher]);
  return 0.5;
}
function _clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// W718 - normalized cost per teacher. Operators can pass opts.cost_table
// mapping teacher slug -> USD/call. We rank-normalize (most-expensive teacher
// gets 1.0, cheapest gets 0.0) so the cost penalty is scale-invariant. A
// teacher absent from the table is treated as median (0.5) so its weight
// isn't punished for lack of pricing data.
function _normalizedCosts(teachers, costTable) {
  const table = costTable || {};
  const raw = teachers.map((t) => {
    const c = table[t];
    return typeof c === 'number' && c >= 0 ? c : null;
  });
  const known = raw.filter((c) => c != null);
  if (known.length === 0) return teachers.map(() => 0.5);
  const max = Math.max(...known);
  const min = Math.min(...known);
  if (max <= min) return teachers.map(() => 0);
  return raw.map((c) => (c == null ? 0.5 : (c - min) / (max - min)));
}

// W718 - compute per-teacher softmax weight for a single capture.
//
// teachers       : array of teacher slugs (['claude-opus-4-7', 'gpt-4o', ...])
// capture        : the row whose target we're trying to blend. May carry
//                  domain / task / policy_risk / verifier_agreement /
//                  human_preference fields. Missing fields fall back to
//                  neutral priors (0.5 reliability, 0 risk, etc.)
// reliability    : optional TeacherReliabilityTable instance OR a plain
//                  function (teacher, domain, task) => {domain, task} numbers
//                  in [0,1]. When null/undefined every teacher gets 0.5 in
//                  both axes - pure "no information" prior.
// opts           :
//   gamma        : override GAMMA_DEFAULTS. Partial overrides merged.
//   cost_table   : {teacher_slug: usd_per_call} for cost normalisation.
//
// Returns an array of {teacher, weight, contributions: {...}} sorted by
// weight descending. Weights sum to 1.0 within float epsilon.
export function computeTeacherWeights(teachers, capture, reliability, opts = {}) {
  if (!Array.isArray(teachers) || teachers.length === 0) return [];
  const gamma = Object.assign({}, GAMMA_DEFAULTS, (opts && opts.gamma) || {});
  const domain = _captureDomain(capture);
  const task = _captureTask(capture);
  const risk = _captureRisk(capture);
  const costs = _normalizedCosts(teachers, opts.cost_table);

  // Resolve per-teacher reliability via the table OR the callback.
  const reliabilityOf = (teacher) => {
    if (!reliability) return { domain: 0.5, task: 0.5 };
    if (typeof reliability.getReliability === 'function') {
      const r = reliability.getReliability(teacher, domain, task);
      if (r && typeof r === 'object') {
        return {
          domain: _clamp01(r.domain != null ? r.domain : 0.5),
          task: _clamp01(r.task != null ? r.task : 0.5),
        };
      }
      return { domain: 0.5, task: 0.5 };
    }
    if (typeof reliability === 'function') {
      const r = reliability(teacher, domain, task);
      if (r && typeof r === 'object') {
        return {
          domain: _clamp01(r.domain != null ? r.domain : 0.5),
          task: _clamp01(r.task != null ? r.task : 0.5),
        };
      }
    }
    return { domain: 0.5, task: 0.5 };
  };

  const rows = teachers.map((teacher, i) => {
    const r = reliabilityOf(teacher);
    const v = _verifierAgreement(capture, teacher);
    const h = _humanPreference(capture, teacher);
    const c = costs[i];
    const contrib = {
      domain: gamma.domain * r.domain,
      task: gamma.task * r.task,
      verifier: gamma.verifier * v,
      human: gamma.human * h,
      cost_penalty: -gamma.cost * c,
      risk_penalty: -gamma.risk * risk,
    };
    const logit = contrib.domain + contrib.task + contrib.verifier + contrib.human
      + contrib.cost_penalty + contrib.risk_penalty;
    return {
      teacher,
      _logit: logit,
      contributions: Object.assign({}, contrib, {
        domain_reliability: r.domain,
        task_reliability: r.task,
        verifier_agreement: v,
        human_preference: h,
        normalized_cost: c,
        policy_risk: risk,
      }),
    };
  });

  const probs = softmax(rows.map((r) => r._logit));
  for (let i = 0; i < rows.length; i++) {
    rows[i].weight = probs[i];
    delete rows[i]._logit;
  }
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
}

// W718 - pick the highest-weight teacher for a single capture, with an
// English-language explanation of WHY. Used by distill-pipeline.js to stamp
// per-capture metadata so the receipt chain can answer "why did capture #42
// route to gpt-4o instead of claude-opus-4-7?".
//
// Returns {teacher, weight, explanation, weights[]} where:
//   teacher     : the slug that won
//   weight      : its softmax probability
//   explanation : one-sentence "X beat Y because <reason>" string
//   weights[]   : the full ranked array (for the audit trail)
export function selectTeacherForCapture(teachers, capture, reliability, opts = {}) {
  if (!Array.isArray(teachers) || teachers.length === 0) {
    return {
      teacher: null,
      weight: 0,
      explanation: 'no_teachers_configured',
      weights: [],
    };
  }
  const weights = computeTeacherWeights(teachers, capture, reliability, opts);
  if (weights.length === 0) {
    return { teacher: null, weight: 0, explanation: 'empty_weight_vector', weights: [] };
  }
  const winner = weights[0];
  const domain = _captureDomain(capture);
  const task = _captureTask(capture);
  // Cheap explanation: name the dominant +contribution.
  const c = winner.contributions;
  const positives = [
    ['domain_reliability', c.domain],
    ['task_reliability', c.task],
    ['verifier_agreement', c.verifier],
    ['human_preference', c.human],
  ].sort((a, b) => b[1] - a[1]);
  const dominant = positives[0][0];
  const runnerUp = weights[1] ? weights[1].teacher : '(no runner-up)';
  const explanation = `${winner.teacher} beat ${runnerUp} for (domain=${domain}, task=${task}) `
    + `on weight=${winner.weight.toFixed(3)}; dominant factor: ${dominant}.`;
  return {
    teacher: winner.teacher,
    weight: winner.weight,
    explanation,
    weights,
  };
}

// W718 - blend per-teacher target signals into a single distillation target.
//
// teacher_signals[]  : one entry per teacher, in the same order as `weights`.
//                      Each entry is EITHER:
//                        - a number / array-of-numbers (logits, embeddings,
//                          probability vectors) -> weighted mean
//                        - a string (text output) -> argmax (return the
//                          highest-weighted teacher's text verbatim).
//                          Weighted mean of strings is meaningless.
//                        - an object {logits:[...]} -> blend the .logits field
//                          but pass-through everything else from the winner.
// weights[]          : softmax weights from computeTeacherWeights().
//                      Sums to 1.0 within float epsilon.
//
// Returns the blended target. Mode is auto-detected from the first non-null
// signal type. Mixed types (some strings, some logits) falls back to argmax
// (the safer / more honest path).
export function blendTargets(teacher_signals, weights) {
  if (!Array.isArray(teacher_signals) || teacher_signals.length === 0) return null;
  if (!Array.isArray(weights) || weights.length !== teacher_signals.length) {
    throw new Error('blendTargets: weights array must align with teacher_signals length');
  }
  // Argmax fallback - picks the highest-weighted teacher's signal verbatim.
  const argmax = () => {
    let maxIdx = 0;
    let maxW = -Infinity;
    for (let i = 0; i < weights.length; i++) {
      const w = typeof weights[i] === 'number' ? weights[i] : (weights[i] && weights[i].weight) || 0;
      if (w > maxW) { maxW = w; maxIdx = i; }
    }
    return teacher_signals[maxIdx];
  };
  // Detect mode from the first non-null signal.
  const first = teacher_signals.find((s) => s != null);
  if (first == null) return null;
  // Text mode - weighted mean is meaningless; return argmax.
  if (typeof first === 'string') return argmax();
  // Mixed types - fall back to argmax (defensive: never silently mix strings
  // with numbers).
  for (const s of teacher_signals) {
    if (s != null && typeof s !== typeof first) return argmax();
  }
  // Number mode - weighted mean.
  if (typeof first === 'number') {
    let acc = 0;
    let wsum = 0;
    for (let i = 0; i < teacher_signals.length; i++) {
      const s = teacher_signals[i];
      if (typeof s !== 'number' || !Number.isFinite(s)) continue;
      const w = typeof weights[i] === 'number' ? weights[i] : (weights[i] && weights[i].weight) || 0;
      acc += s * w;
      wsum += w;
    }
    return wsum > 0 ? acc / wsum : 0;
  }
  // Vector mode - element-wise weighted mean. All vectors must align in length
  // OR we fall back to argmax (defensive).
  if (Array.isArray(first)) {
    const dim = first.length;
    for (const s of teacher_signals) {
      if (!Array.isArray(s) || s.length !== dim) return argmax();
    }
    const out = new Array(dim).fill(0);
    let wsum = 0;
    for (let i = 0; i < teacher_signals.length; i++) {
      const s = teacher_signals[i];
      const w = typeof weights[i] === 'number' ? weights[i] : (weights[i] && weights[i].weight) || 0;
      for (let d = 0; d < dim; d++) out[d] += s[d] * w;
      wsum += w;
    }
    if (wsum <= 0) return argmax();
    return out.map((v) => v / wsum);
  }
  // Object-with-.logits mode - blend the .logits field and pass-through
  // everything else from the winner.
  if (typeof first === 'object' && Array.isArray(first.logits)) {
    const logitSignals = teacher_signals.map((s) => (s && Array.isArray(s.logits)) ? s.logits : null);
    const blendedLogits = blendTargets(logitSignals, weights);
    const winner = argmax();
    return Object.assign({}, winner, { logits: blendedLogits });
  }
  // Unknown shape - argmax.
  return argmax();
}

export default {
  TEACHER_COUNCIL_VERSION,
  GAMMA_DEFAULTS,
  computeTeacherWeights,
  selectTeacherForCapture,
  blendTargets,
};
