// src/kscore-gate-harness.js
//
// ATOM: K-Score Quality Gate - a property-based / metamorphic + adversarial
// test harness PLUS a conformal-bounded ship gate, so the 0.85 ship decision
// carries a STATISTICAL CONFIDENCE GUARANTEE rather than a bare point estimate.
//
// WHY
// ---
// computeKScore (src/kscore.js) returns a point composite and `ships = composite
// >= 0.85`. That is a single deterministic number from declared inputs. It does
// NOT tell us:
//   (1) whether the recipe's quality is robust to small, semantics-preserving
//       perturbations of its inputs (metamorphic stability),
//   (2) whether the K-score is gameable by mutating the recipe to "teach to the
//       eval" (mutation / adversarial testing),
//   (3) whether the declared accuracy survives a distribution-shift holdout,
//   (4) with what confidence the TRUE K clears the gate given finite-sample
//       noise in the measured V/R axes.
//
// This module supplies all four, composing with the existing src/conformal.js
// split-conformal machinery (no re-implementation; we feed it residuals).
//
// MOAT PRESERVED: we NEVER weaken the gate. The conformal layer can only make
// the gate STRICTER (require the lower conformal bound to clear 0.85, or ABSTAIN
// when the interval straddles it). Holdout-disjointness is enforced fail-closed:
// if the holdout overlaps the calibration/train set, we refuse to certify.
//
// Pure-JS, zero new deps. Deterministic given a seed. Every public fn returns an
// envelope; the harness never throws on adversarial input (it REPORTS failures).
// ASCII only. The word "honest" is avoided per repo convention (Caveats below).

import { computeKScore } from './kscore.js';
import { predictInterval, selectiveDecision, splitConformalQuantile, CONFORMAL_VERSION } from './conformal.js';

export const KSCORE_GATE_HARNESS_VERSION = 'ksgh-v1';
export const SHIP_GATE = 0.85;

// -----------------------------------------------------------------------------
// Deterministic RNG (LCG) so the whole harness is reproducible from a seed.
// -----------------------------------------------------------------------------
function makeRng(seed) {
  let s = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => { s = (Math.imul(s, 48271) + 0x6d2b79f5) >>> 0; return s / 0xffffffff; };
}

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round4(x) { return Number(Number(x).toFixed(4)); }

// =============================================================================
// 1) METAMORPHIC RELATIONS
// =============================================================================
//
// A metamorphic relation (MR) asserts how the OUTPUT of `runRecipe(input)` must
// relate when the INPUT is transformed by a semantics-preserving map. These are
// the canonical text-classification/extraction MRs:
//
//   MR_IDEMPOTENT  : runRecipe(x) deep-equals runRecipe(x)            (determinism)
//   MR_WHITESPACE  : trailing/leading whitespace does not change output
//   MR_CASE_LABEL  : (opt) label is invariant to case of the input text
//   MR_PERMUTE_KEYS: (opt) reordering object keys does not change output
//
// Callers supply `runRecipe` (a pure (input)->output fn, e.g. the verifier
// generator or the result of running the isolated sandbox) and a set of seed
// inputs. The harness applies each enabled MR and records violations.

export const METAMORPHIC_RELATIONS = Object.freeze({
  idempotent: {
    name: 'idempotent',
    transform: (x) => x,
    relate: (a, b) => deepEqual(a, b),
    desc: 'runRecipe(x) must equal runRecipe(x) (determinism)',
  },
  whitespace: {
    name: 'whitespace',
    transform: (x) => (typeof x === 'string' ? `  ${x}  ` : x),
    relate: (a, b) => deepEqual(a, b),
    desc: 'leading/trailing whitespace must not change output',
  },
  case_label: {
    name: 'case_label',
    transform: (x) => (typeof x === 'string' ? x.toUpperCase() : x),
    relate: (a, b) => deepEqual(normLabel(a), normLabel(b)),
    desc: 'classification label must be invariant to input case',
  },
  permute_keys: {
    name: 'permute_keys',
    transform: (x) => permuteObjectKeys(x),
    relate: (a, b) => deepEqual(a, b),
    desc: 'reordering object keys must not change output',
  },
});

/**
 * Run a set of metamorphic relations against a recipe.
 *
 * @param {Object} args
 * @param {(input:any)=>any} args.runRecipe   pure recipe call (or sandbox shim)
 * @param {any[]} args.inputs                  seed inputs
 * @param {string[]} [args.relations]          subset of METAMORPHIC_RELATIONS keys
 * @returns {{ ok, version, total, passed, failed, violations, pass_rate }}
 */
export function runMetamorphic({ runRecipe, inputs, relations } = {}) {
  const V = KSCORE_GATE_HARNESS_VERSION;
  if (typeof runRecipe !== 'function') {
    return { ok: false, version: V, error: 'runRecipe must be a function', total: 0, passed: 0, failed: 0, violations: [], pass_rate: null };
  }
  const seeds = Array.isArray(inputs) ? inputs : [];
  const relKeys = Array.isArray(relations) && relations.length
    ? relations.filter((k) => METAMORPHIC_RELATIONS[k])
    : Object.keys(METAMORPHIC_RELATIONS);

  let total = 0, passed = 0;
  const violations = [];
  for (const input of seeds) {
    let base;
    try { base = runRecipe(input); } catch (e) { base = { __error: String((e && e.message) || e) }; }
    for (const key of relKeys) {
      const mr = METAMORPHIC_RELATIONS[key];
      total += 1;
      let follow;
      try { follow = runRecipe(mr.transform(input)); } catch (e) { follow = { __error: String((e && e.message) || e) }; }
      let ok;
      try { ok = mr.relate(base, follow); } catch { ok = false; }
      if (ok) { passed += 1; }
      else {
        violations.push({ relation: key, input: preview(input), base: preview(base), follow: preview(follow), desc: mr.desc });
      }
    }
  }
  return {
    ok: true,
    version: V,
    total,
    passed,
    failed: total - passed,
    pass_rate: total ? round4(passed / total) : null,
    violations,
  };
}

// =============================================================================
// 2) MUTATION TESTING (adversarial: does the eval catch a broken recipe?)
// =============================================================================
//
// A K-score is only meaningful if the eval set it scores against would FAIL a
// deliberately-broken variant of the recipe. We generate mutants by applying
// string-level operators to the recipe source (return-constant, off-by-one,
// negate-condition, drop-branch markers) and re-running the eval through a
// caller-supplied `scoreRecipe(source) -> {accuracy, coverage}`. A mutant that
// the eval still SCORES HIGH is a SURVIVOR - it reveals the eval is weak / the
// K-score is gameable.
//
// mutation_score = killed / total_mutants. A high mutation score means the eval
// is adversarially strong: you cannot teach-to-the-test without being caught.

export const MUTATION_OPERATORS = Object.freeze([
  { id: 'return_empty', apply: (src) => src.replace(/return\s+([^;]+);/, 'return "";') },
  { id: 'return_null', apply: (src) => src.replace(/return\s+([^;]+);/, 'return null;') },
  { id: 'negate_cond', apply: (src) => src.replace(/if\s*\(/, 'if (!(') .replace(/\)\s*{/, ')) {') },
  { id: 'off_by_one', apply: (src) => src.replace(/\b(\d+)\b/, (m, d) => String(Number(d) + 1)) },
  { id: 'swap_true_false', apply: (src) => src.replace(/\btrue\b/, '__TF__').replace(/\bfalse\b/, 'true').replace(/__TF__/, 'false') },
  { id: 'strip_branch', apply: (src) => src.replace(/else\s*{[^}]*}/, '') },
]);

/**
 * Mutation-test a recipe's eval. `scoreRecipe(source)` MUST run the SAME eval
 * the K-score uses and return {accuracy, coverage}. A mutant survives if its
 * scored accuracy stays at-or-above `kill_threshold` of the original accuracy.
 *
 * @param {Object} args
 * @param {string} args.source
 * @param {(source:string)=>{accuracy:number,coverage?:number}} args.scoreRecipe
 * @param {number} [args.kill_threshold=0.95] mutant must drop below this *frac
 *                                            of original accuracy to be "killed"
 * @returns {{ ok, version, original_accuracy, total_mutants, killed, survived,
 *             mutation_score, survivors }}
 */
export function runMutationTesting({ source, scoreRecipe, kill_threshold = 0.95 } = {}) {
  const V = KSCORE_GATE_HARNESS_VERSION;
  if (typeof source !== 'string' || !source) {
    return { ok: false, version: V, error: 'source must be a non-empty string' };
  }
  if (typeof scoreRecipe !== 'function') {
    return { ok: false, version: V, error: 'scoreRecipe must be a function' };
  }
  let original;
  try { original = scoreRecipe(source); } catch (e) {
    return { ok: false, version: V, error: `original scoreRecipe threw: ${String((e && e.message) || e)}` };
  }
  const origAcc = clamp01(original && original.accuracy);
  const killBar = origAcc * clamp01(kill_threshold);

  let total = 0, killed = 0;
  const survivors = [];
  for (const op of MUTATION_OPERATORS) {
    let mutant;
    try { mutant = op.apply(source); } catch { mutant = null; }
    if (mutant == null || mutant === source) continue; // operator did not bite
    total += 1;
    let mscore;
    try { mscore = scoreRecipe(mutant); } catch { mscore = { accuracy: 0 }; }
    const mAcc = clamp01(mscore && mscore.accuracy);
    if (mAcc < killBar) {
      killed += 1;
    } else {
      survivors.push({ operator: op.id, mutant_accuracy: round4(mAcc), original_accuracy: round4(origAcc) });
    }
  }
  return {
    ok: true,
    version: V,
    original_accuracy: round4(origAcc),
    total_mutants: total,
    killed,
    survived: total - killed,
    mutation_score: total ? round4(killed / total) : null,
    survivors,
  };
}

// =============================================================================
// 3) DISTRIBUTION-SHIFT HOLDOUT (fail-closed disjointness)
// =============================================================================
//
// A K-score's accuracy claim is only trustworthy if it was measured on a holdout
// DISJOINT from anything the recipe saw at train/calibration time. This computes
// the held-out accuracy under a (possibly shifted) holdout distribution and
// REFUSES to certify when the holdout overlaps the train set. Overlap detection
// uses a caller-supplied key fn (default JSON canonical of the input).
//
// Returns the holdout accuracy AND the per-residual array (observed-predicted)
// so the conformal layer can bound the gate.

function canonicalKey(x) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

/**
 * @param {Object} args
 * @param {(input:any)=>any} args.runRecipe
 * @param {Array<{input:any, expected:any}>} args.holdout    shifted holdout cases
 * @param {Array<{input:any}>} [args.train]                  train/calibration inputs (for disjointness)
 * @param {(a:any,b:any)=>boolean} [args.matches]           output==expected predicate
 * @param {(input:any)=>string} [args.keyOf]
 * @returns {{ ok, version, disjoint, n, accuracy, residuals, overlap_count, error? }}
 */
export function evaluateHoldout({ runRecipe, holdout, train, matches, keyOf } = {}) {
  const V = KSCORE_GATE_HARNESS_VERSION;
  if (typeof runRecipe !== 'function') return { ok: false, version: V, error: 'runRecipe must be a function' };
  const cases = Array.isArray(holdout) ? holdout : [];
  if (cases.length === 0) return { ok: false, version: V, error: 'holdout must be a non-empty array' };
  const key = typeof keyOf === 'function' ? keyOf : canonicalKey;
  const eq = typeof matches === 'function' ? matches : deepEqual;

  // FAIL-CLOSED disjointness: any holdout input that also appears in train
  // contaminates the measurement. We refuse to certify (disjoint:false) and
  // report the overlap rather than silently scoring a leaky holdout.
  const trainKeys = new Set((Array.isArray(train) ? train : []).map((t) => key(t && t.input !== undefined ? t.input : t)));
  let overlap = 0;
  for (const c of cases) { if (trainKeys.has(key(c.input))) overlap += 1; }
  const disjoint = overlap === 0;

  let correct = 0;
  const residuals = [];
  for (const c of cases) {
    let out, ok = false;
    try { out = runRecipe(c.input); ok = eq(out, c.expected); } catch { ok = false; }
    if (ok) correct += 1;
    // Per-case residual on the 0/1 correctness scale -> feeds conformal width.
    residuals.push(ok ? 0 : 1);
  }
  const accuracy = cases.length ? correct / cases.length : 0;
  return {
    ok: true,
    version: V,
    disjoint,
    overlap_count: overlap,
    n: cases.length,
    accuracy: round4(accuracy),
    residuals,
  };
}

// =============================================================================
// 4) CONFORMAL-BOUNDED SHIP GATE
// =============================================================================
//
// The keystone. Given:
//   - the declared K-score inputs (the same shape computeKScore takes),
//   - a pool of calibration residuals on the K-score predictor (observed K minus
//     predicted K over past artifacts), and
//   - alpha (miscoverage; default 0.10 -> 90% interval),
// we compute a split-conformal interval around the point composite and turn the
// bare `ships` boolean into a THREE-STATE, confidence-bounded decision:
//
//   lo >= gate  -> 'ship'    (we are (1-alpha)-confident TRUE K clears the gate)
//   hi <  gate  -> 'reject'  (we are (1-alpha)-confident TRUE K misses the gate)
//   straddle    -> 'abstain' (the interval crosses the gate; collect more signal)
//
// The point estimate (composite) is preserved; the conformal layer only ever
// makes the gate STRICTER. When the calibration pool is too small to be valid
// (undercalibrated), we FAIL-CLOSED to 'abstain' rather than ship on a point
// estimate alone - preserving the moat.

/**
 * @param {Object} args
 * @param {Object} args.kscoreInput              same shape computeKScore accepts
 * @param {number[]} [args.calibrationResiduals] observed_k - predicted_k residual pool
 * @param {number} [args.alpha=0.10]
 * @param {number} [args.gate=SHIP_GATE]
 * @param {Object} [args.precomputed]            optional {composite} to skip recompute
 * @returns {{ ok, version, conformal_version, composite, gate, alpha,
 *             interval:{lo,hi,half_width}, decision, basis, n_cal,
 *             point_ships, confidence_bounded, kscore }}
 */
export function conformalBoundedGate({ kscoreInput, calibrationResiduals, alpha = 0.10, gate = SHIP_GATE, precomputed } = {}) {
  const V = KSCORE_GATE_HARNESS_VERSION;
  const g = Number.isFinite(Number(gate)) ? Number(gate) : SHIP_GATE;

  let kscore = null;
  let composite;
  if (precomputed && Number.isFinite(Number(precomputed.composite))) {
    composite = Number(precomputed.composite);
  } else {
    try { kscore = computeKScore(kscoreInput || {}); composite = Number(kscore.composite); }
    catch (e) { return { ok: false, version: V, error: `computeKScore threw: ${String((e && e.message) || e)}` }; }
  }
  if (!Number.isFinite(composite)) {
    return { ok: false, version: V, error: 'composite is not finite' };
  }

  const pool = Array.isArray(calibrationResiduals) ? calibrationResiduals : [];
  const interval = predictInterval(pool, alpha, { point: composite, clamp01: true });
  const decision = selectiveDecision({ lo: interval.lo, hi: interval.hi, gate: g });

  // Map the conformal selective-prediction states onto the ship gate vocabulary.
  // ship_safe -> ship ; skip_safe -> reject ; abstain -> abstain.
  // Undercalibrated pools yield [0,1] -> straddle -> abstain (fail-closed).
  let mapped;
  if (decision === 'ship_safe') mapped = 'ship';
  else if (decision === 'skip_safe') mapped = 'reject';
  else mapped = 'abstain';

  return {
    ok: true,
    version: V,
    conformal_version: CONFORMAL_VERSION,
    composite: round4(composite),
    gate: g,
    alpha: Number(alpha),
    point_ships: composite >= g,
    interval: { lo: round4(interval.lo), hi: round4(interval.hi), half_width: Number.isFinite(interval.half_width) ? round4(interval.half_width) : interval.half_width },
    decision: mapped,
    basis: interval.basis,
    n_cal: interval.n_cal,
    confidence_bounded: interval.basis !== 'conformal_undercalibrated',
    kscore,
  };
}

// =============================================================================
// 5) certifyShip - the all-in-one gate that COMPOSES 1..4.
// =============================================================================
//
// A recipe ships ONLY when ALL of these hold:
//   (a) metamorphic pass_rate >= metamorphic_min   (default 1.0 - no MR violations)
//   (b) mutation_score        >= mutation_min      (default 0.8 - eval is strong)
//   (c) holdout is DISJOINT and its accuracy >= holdout_min
//   (d) the conformal-bounded gate decision is 'ship' (lower bound clears 0.85)
//
// ANY failing criterion -> ships:false with the blocking reasons. This is the
// gate the moat depends on: it can only be STRICTER than the bare point gate,
// never looser, and it fails closed on missing/weak signal.

/**
 * @param {Object} args  (all optional sub-reports may be passed precomputed)
 * @returns {{ ok, version, ships, decision, reasons, criteria, ... }}
 */
export function certifyShip({
  kscoreInput,
  calibrationResiduals,
  alpha = 0.10,
  gate = SHIP_GATE,
  metamorphic,           // result of runMetamorphic OR {runRecipe, inputs}
  mutation,              // result of runMutationTesting OR {source, scoreRecipe}
  holdout,               // result of evaluateHoldout OR {runRecipe, holdout, train}
  thresholds = {},
} = {}) {
  const V = KSCORE_GATE_HARNESS_VERSION;
  const T = {
    metamorphic_min: thresholds.metamorphic_min != null ? thresholds.metamorphic_min : 1.0,
    mutation_min: thresholds.mutation_min != null ? thresholds.mutation_min : 0.8,
    holdout_min: thresholds.holdout_min != null ? thresholds.holdout_min : 0.85,
  };

  const mmReport = (metamorphic && metamorphic.version) ? metamorphic
    : (metamorphic ? runMetamorphic(metamorphic) : null);
  const mutReport = (mutation && mutation.version) ? mutation
    : (mutation ? runMutationTesting(mutation) : null);
  const hoReport = (holdout && holdout.version) ? holdout
    : (holdout ? evaluateHoldout(holdout) : null);

  const gateReport = conformalBoundedGate({ kscoreInput, calibrationResiduals, alpha, gate });

  const reasons = [];
  const criteria = {};

  // (a) metamorphic
  if (mmReport) {
    const ok = mmReport.ok && mmReport.pass_rate != null && mmReport.pass_rate >= T.metamorphic_min;
    criteria.metamorphic = { pass: ok, pass_rate: mmReport.pass_rate, min: T.metamorphic_min, violations: mmReport.violations ? mmReport.violations.length : null };
    if (!ok) reasons.push(`metamorphic pass_rate ${mmReport.pass_rate} < ${T.metamorphic_min}`);
  } else {
    criteria.metamorphic = { pass: false, reason: 'no_metamorphic_signal' };
    reasons.push('metamorphic harness not run (fail-closed)');
  }

  // (b) mutation
  if (mutReport) {
    const ok = mutReport.ok && mutReport.mutation_score != null && mutReport.mutation_score >= T.mutation_min;
    criteria.mutation = { pass: ok, mutation_score: mutReport.mutation_score, min: T.mutation_min, survivors: mutReport.survivors ? mutReport.survivors.length : null };
    if (!ok) reasons.push(`mutation_score ${mutReport.mutation_score} < ${T.mutation_min}`);
  } else {
    criteria.mutation = { pass: false, reason: 'no_mutation_signal' };
    reasons.push('mutation harness not run (fail-closed)');
  }

  // (c) holdout disjointness + accuracy
  if (hoReport) {
    const ok = hoReport.ok && hoReport.disjoint && hoReport.accuracy >= T.holdout_min;
    criteria.holdout = { pass: ok, disjoint: hoReport.disjoint, accuracy: hoReport.accuracy, min: T.holdout_min, overlap_count: hoReport.overlap_count };
    if (!hoReport.disjoint) reasons.push(`holdout overlaps train set (${hoReport.overlap_count} leaked) - fail-closed`);
    else if (!ok) reasons.push(`holdout accuracy ${hoReport.accuracy} < ${T.holdout_min}`);
  } else {
    criteria.holdout = { pass: false, reason: 'no_holdout_signal' };
    reasons.push('holdout not evaluated (fail-closed)');
  }

  // (d) conformal-bounded gate
  const gateOk = gateReport.ok && gateReport.decision === 'ship';
  criteria.conformal_gate = {
    pass: gateOk,
    decision: gateReport.decision,
    composite: gateReport.composite,
    interval: gateReport.interval,
    confidence_bounded: gateReport.confidence_bounded,
  };
  if (!gateOk) reasons.push(`conformal gate decision='${gateReport.decision}' (lower bound must clear ${gateReport.gate})`);

  const ships = reasons.length === 0;
  return {
    ok: true,
    version: V,
    ships,
    decision: ships ? 'ship' : (gateReport.decision === 'abstain' ? 'abstain' : 'reject'),
    gate: gateReport.gate,
    reasons,
    criteria,
    metamorphic: mmReport,
    mutation: mutReport,
    holdout: hoReport,
    conformal_gate: gateReport,
  };
}

// =============================================================================
// Internal helpers.
// =============================================================================

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}

function normLabel(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (v && typeof v === 'object' && typeof v.label === 'string') return { ...v, label: v.label.toLowerCase() };
  return v;
}

function permuteObjectKeys(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return x;
  const keys = Object.keys(x).reverse();
  const out = {};
  for (const k of keys) out[k] = x[k];
  return out;
}

function preview(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s == null ? String(v) : (s.length > 200 ? s.slice(0, 200) + '...' : s);
  } catch { return String(v); }
}

export default {
  KSCORE_GATE_HARNESS_VERSION,
  SHIP_GATE,
  METAMORPHIC_RELATIONS,
  MUTATION_OPERATORS,
  runMetamorphic,
  runMutationTesting,
  evaluateHoldout,
  conformalBoundedGate,
  certifyShip,
};
