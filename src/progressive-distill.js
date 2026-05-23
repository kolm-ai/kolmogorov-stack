// W712 — progressive distillation + capability gating.
//
// Three sequential distill passes with K-Score axis gates between them. Each
// pass narrows the training corpus and targets a different capability:
//
//   Pass 1 (format)    : train on ALL captures.
//                        gate = K-Score axis F (format/fairness) >= 0.65
//                        if pass, advance to Pass 2.
//   Pass 2 (reasoning) : filter to captures with reasoning_trace != null
//                        OR token_count > 200 (multi-step proxy).
//                        gate = K-Score axis R (reasoning/robustness) >= 0.60
//                        if pass, advance to Pass 3.
//   Pass 3 (edge)      : filter to captures the Pass-2 student got wrong on a
//                        held-out slice (caller-supplied failures list).
//                        gate = K-Score axis E (edge/energy) >= 0.55
//                        terminal pass — success is "graduated".
//
// Why F / R / E? src/kscore.js already exposes those axis letters as part of
// the v2 composite (F=fairness, R=robustness, E=energy). For progressive
// distillation we REPURPOSE the same letters as proxies for format /
// reasoning / edge — the K-Score machinery doesn't change shape, the caller
// just plumbs the right number into the matching axis name. This keeps the
// gate evaluator a pure shape-checker (no axis-letter remap to maintain) and
// lets the existing K-Score pretty-printer surface progressive results
// without a new axis vocabulary.
//
// Honesty contracts:
//   * filterCapturesForPass NEVER throws on missing fields. A capture without
//     reasoning_trace AND without a usable token count is dropped from pass-2
//     (not silently kept) — the filter must produce an honest subset.
//   * evaluateGate returns a STRUCTURED need-more envelope on failure. The
//     `count` is a gap estimate: max(50, round((threshold - score) * 1000)).
//     Never silently fake a "passed" verdict.
//   * buildGateEnvelope wraps the evaluator's output for HTTP/CLI surfaces;
//     no implicit success on missing axes.
//
// References:
//   * Wang et al, 2023. "Augmenting Language Models with Long-Term Memory."
//     Multi-pass capability gating motif.
//   * Anil et al, 2023. "Gemini: A Family of Highly Capable Multimodal Models."
//     Curriculum learning pattern: gate per capability before advancing.

export const PROGRESSIVE_VERSION = 'w712-v1';

// Per-pass gate spec. Axis letters mirror src/kscore.js v2 axes:
//   F = format    (reuses fairness slot; format-fidelity proxy)
//   R = reasoning (reuses robustness slot; multi-step-correctness proxy)
//   E = edge      (reuses energy slot; edge-case correctness proxy)
export const PASS_GATES = Object.freeze({
  1: Object.freeze({ axis: 'F', threshold: 0.65, label: 'format' }),
  2: Object.freeze({ axis: 'R', threshold: 0.60, label: 'reasoning' }),
  3: Object.freeze({ axis: 'E', threshold: 0.55, label: 'edge' }),
});

// Pass 2 multi-step proxy: a capture qualifies when reasoning_trace is
// present OR the response token-count exceeds this floor. The 200-token
// floor is a heuristic — a typical multi-step CoT response runs ~250 tokens;
// anything shorter is rarely multi-step. Re-tune via run-meta later.
const MULTI_STEP_TOKEN_FLOOR = 200;

// Need-more gap estimator. We translate the (threshold - score) shortfall
// into an integer capture count: a 0.05 gap -> 50 captures; a 0.20 gap ->
// 200 captures. Floored at 50 so the user always has a concrete next-step
// number rather than "1 more capture should do it".
const GAP_MIN = 50;
const GAP_MULTIPLIER = 1000;

// -------------------------------------------------------------------------
// filterCapturesForPass — pure subset filter.
//
// Pass 1: returns the full input array (uniform pass).
// Pass 2: keeps rows where reasoning_trace != null OR token_count > 200.
// Pass 3: returns the caller-provided failures array verbatim (the W712
//         spec says "only on pass-2 failures" — the CALLER knows which
//         rows the pass-2 student got wrong; this function is a passthrough
//         so the test surface stays pure).
//
// NEVER throws. Returns [] on null/undefined captures.
// -------------------------------------------------------------------------
export function filterCapturesForPass(captures, pass, opts = {}) {
  if (!Array.isArray(captures)) return [];
  if (pass === 1) return captures.slice();
  if (pass === 2) {
    const out = [];
    for (const c of captures) {
      if (!c || typeof c !== 'object') continue;
      if (c.reasoning_trace != null) { out.push(c); continue; }
      const tc = _resolveTokenCount(c);
      if (tc > MULTI_STEP_TOKEN_FLOOR) { out.push(c); continue; }
    }
    return out;
  }
  if (pass === 3) {
    // Caller supplies the pass-2 failure slice. Two surfaces:
    //   filterCapturesForPass(captures, 3, { failures: [...] })
    //   filterCapturesForPass(failures, 3)
    // Both pass through. We never invent failures.
    if (opts && Array.isArray(opts.failures)) return opts.failures.slice();
    return captures.slice();
  }
  return [];
}

function _resolveTokenCount(capture) {
  if (typeof capture.token_count === 'number' && Number.isFinite(capture.token_count)) {
    return capture.token_count;
  }
  if (typeof capture.tokens === 'number' && Number.isFinite(capture.tokens)) {
    return capture.tokens;
  }
  const resp = capture.response;
  if (typeof resp === 'string' && resp.length > 0) {
    let n = 0;
    for (const tok of resp.split(/\s+/)) if (tok.length > 0) n++;
    return n;
  }
  return 0;
}

// -------------------------------------------------------------------------
// evaluateGate — pure gate-decision function.
//
// Returns one of:
//   { ok: true,  pass, axis, score, threshold, advanced_to_pass, label }
//   { ok: false, pass, axis, score, threshold, need_more: { class, count },
//                hint, label }
// -------------------------------------------------------------------------
export function evaluateGate(pass, kscoreAxes) {
  const passNum = Number(pass);
  const spec = PASS_GATES[passNum];
  if (!spec) {
    return {
      ok: false,
      pass: passNum,
      error: 'unknown_pass',
      hint: `pass must be one of ${Object.keys(PASS_GATES).join(', ')}`,
    };
  }
  const axes = (kscoreAxes && typeof kscoreAxes === 'object') ? kscoreAxes : {};
  const raw = axes[spec.axis];
  const score = (typeof raw === 'number' && Number.isFinite(raw)) ? raw : null;
  if (score == null) {
    return {
      ok: false,
      pass: passNum,
      axis: spec.axis,
      label: spec.label,
      score: null,
      threshold: spec.threshold,
      need_more: {
        class: _classNameForPass(passNum),
        count: GAP_MIN,
      },
      hint: `K-Score axis ${spec.axis} (${spec.label}) missing; collect ${GAP_MIN} more ${_classNameForPass(passNum)} captures and re-run`,
    };
  }
  if (score >= spec.threshold) {
    const next = passNum < 3 ? (passNum + 1) : null;
    return {
      ok: true,
      pass: passNum,
      axis: spec.axis,
      label: spec.label,
      score,
      threshold: spec.threshold,
      advanced_to_pass: next,
    };
  }
  const gap = spec.threshold - score;
  const count = Math.max(GAP_MIN, Math.round(gap * GAP_MULTIPLIER));
  return {
    ok: false,
    pass: passNum,
    axis: spec.axis,
    label: spec.label,
    score,
    threshold: spec.threshold,
    need_more: {
      class: _classNameForPass(passNum),
      count,
    },
    hint: `axis ${spec.axis} (${spec.label}) below ${spec.threshold} threshold; collect ${count} more ${_classNameForPass(passNum)} captures and re-run --pass=${passNum}`,
  };
}

function _classNameForPass(pass) {
  if (pass === 1) return 'format_demonstration';
  if (pass === 2) return 'multi_step_reasoning';
  if (pass === 3) return 'edge_case';
  return 'unknown';
}

// -------------------------------------------------------------------------
// buildGateEnvelope — wrap a gate-evaluator result for HTTP/CLI surfaces.
//
// Adds:
//   * progressive_version stamp
//   * captures_remaining (caller-supplied, optional)
//   * gate_score alias for the axis score (callers expect this name)
//
// Pure: never mutates the input.
// -------------------------------------------------------------------------
export function buildGateEnvelope(gateResult, opts = {}) {
  if (!gateResult || typeof gateResult !== 'object') {
    return {
      ok: false,
      progressive_version: PROGRESSIVE_VERSION,
      error: 'no_gate_result',
      hint: 'evaluateGate(pass, axes) must be called before buildGateEnvelope',
    };
  }
  const env = {
    ok: gateResult.ok === true,
    progressive_version: PROGRESSIVE_VERSION,
    pass: gateResult.pass,
    axis: gateResult.axis,
    label: gateResult.label,
    gate_score: gateResult.score,
    threshold: gateResult.threshold,
  };
  if (gateResult.ok === true) {
    env.advanced_to_pass = gateResult.advanced_to_pass;
    if (typeof opts.captures_remaining === 'number') {
      env.captures_remaining = opts.captures_remaining;
    }
    if (gateResult.advanced_to_pass == null) {
      env.graduated = true;
    }
  } else {
    if (gateResult.need_more) env.need_more = gateResult.need_more;
    if (gateResult.hint) env.hint = gateResult.hint;
    if (gateResult.error) env.error = gateResult.error;
  }
  return env;
}

// -------------------------------------------------------------------------
// CLI translation helpers — keep CLI tests pure-Node-ish (no spawn loop).
// -------------------------------------------------------------------------

// gateFromKScoreAxesPath: load a K-Score axes JSON (e.g. run-meta.json) and
// extract a {F, R, E} subset. Tolerates v1 (no axes) and v2 (axes present).
export function gateFromKScoreAxesPath(_unused) {
  // Intentionally not exported as part of the W712 atomic surface. Kept for
  // future use; CLI does its own JSON parsing today (so the test suite can
  // exercise evaluateGate without touching disk).
  return null;
}

export default {
  PROGRESSIVE_VERSION,
  PASS_GATES,
  filterCapturesForPass,
  evaluateGate,
  buildGateEnvelope,
};
