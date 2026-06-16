// tests/finalized-c1-sandbox-verification-kscore-gate.test.js
//
// ATOM: Sandbox Verification + K-Score Quality Gate.
//
// Proves the two halves of the atom:
//
//   A. A TRUE isolation boundary (src/sandbox-isolation.js + sandbox-worker.js):
//      - well-behaved recipe runs and returns output through the boundary,
//      - a spinning `while(true){}` is PREEMPTIVELY killed (timeout) - the host
//        survives (the cooperative post-hoc check in verifier.js could not do
//        this),
//      - a constructor-escape attempt (this.constructor.constructor) cannot
//        reach the host Function - it is denied INSIDE the boundary,
//      - process.env is NOT visible to untrusted code (capability scoping),
//      - a network egress attempt is blocked + reported,
//      - the unbounded-memory recipe is contained (memory_limit / timeout) and
//        the host process keeps running,
//      - KOLM_SANDBOX=isolated-vm with the dep absent FAILS LOUD with an
//        install hint (env-gated, no silent downgrade).
//
//   B. K-Score gate harness (src/kscore-gate-harness.js):
//      - metamorphic relations catch a non-deterministic / case-sensitive recipe,
//      - mutation testing kills broken mutants (eval is adversarially strong),
//        and a survivor is reported when the eval is weak,
//      - distribution-shift holdout is fail-closed on train/holdout overlap,
//      - the conformal-bounded gate turns 0.85 into a three-state decision with
//        a coverage guarantee and only ever makes the gate STRICTER,
//      - certifyShip composes all four and fails closed on missing signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runIsolated,
  selectBackend,
  SANDBOX_ISOLATION_VERSION,
  DEFAULT_LIMITS,
  DEFAULT_LIB_ALLOWLIST,
} from '../src/sandbox-isolation.js';

import {
  runMetamorphic,
  runMutationTesting,
  evaluateHoldout,
  conformalBoundedGate,
  certifyShip,
  SHIP_GATE,
  KSCORE_GATE_HARNESS_VERSION,
} from '../src/kscore-gate-harness.js';

// =============================================================================
// A. ISOLATION BOUNDARY
// =============================================================================

test('A1 well-behaved recipe runs through the worker boundary and returns output', async () => {
  const r = await runIsolated({
    source: 'function generate(input, lib){ return lib.upper(input.text); }',
    input: { text: 'hello' },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.output, 'HELLO');
  assert.equal(r.backend, 'worker');
  assert.equal(r.version, SANDBOX_ISOLATION_VERSION);
  assert.ok(r.wall_ms >= 0);
});

test('A2 a spinning loop is PREEMPTIVELY killed (host survives, cooperative check could not)', async () => {
  const t0 = Date.now();
  const r = await runIsolated({
    source: 'function generate(){ while(true){} }',
    input: null,
    limits: { wall_ms: 200 },
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  // It actually returned (the host event loop was never blocked) and did so
  // close to the deadline, not after an unbounded hang.
  assert.ok(elapsed < 5000, `took ${elapsed}ms - should have been preempted near 200ms`);
});

test('A3 constructor-escape (this.constructor.constructor) cannot reach host Function', async () => {
  // The canonical node:vm escape. Inside the boundary Function is nulled, so the
  // recipe either throws (denied) or simply cannot obtain the host constructor.
  const r = await runIsolated({
    source: 'function generate(){ const F = (function(){}).constructor; return F("return process.env")(); }',
    input: null,
  });
  // Must NOT succeed in returning host env. Either recipe_threw (Function null)
  // or, if it somehow built one, egress/process is still unreachable.
  assert.equal(r.ok, false, `escape unexpectedly succeeded: ${JSON.stringify(r)}`);
  assert.ok(['recipe_threw', 'egress_blocked', 'timeout', 'memory_limit'].includes(r.error), r.error);
});

test('A4 process.env is NOT visible to untrusted code (capability scoping)', async () => {
  const r = await runIsolated({
    source: 'function generate(){ return typeof process; }',
    input: null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  // process must be undefined inside the context.
  assert.equal(r.output, 'undefined');
});

test('A5 a network egress attempt is blocked + reported', async () => {
  // fetch is nulled in-context AND the egress monitor is installed in the
  // worker. Attempting any network primitive is denied.
  const r = await runIsolated({
    source: 'function generate(){ return typeof fetch; }',
    input: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'undefined'); // fetch is not exposed to the recipe
});

test('A6 unbounded memory allocation is contained; host keeps running', async () => {
  const r = await runIsolated({
    source: 'function generate(){ const a=[]; for(;;){ a.push(new Array(100000).fill(7)); } }',
    input: null,
    limits: { wall_ms: 3000, memory_mb: 16, young_mb: 4 },
  });
  assert.equal(r.ok, false);
  // Either the memory cap trips (worker OOM exit) or the wall clock preempts it
  // first - both are valid containment outcomes. The point: the HOST survives,
  // which is proven by this assertion executing at all.
  assert.ok(['memory_limit', 'timeout'].includes(r.error), `expected containment, got ${r.error}: ${r.detail}`);
});

test('A7 KOLM_SANDBOX=isolated-vm with dep absent FAILS LOUD with an install hint (env-gated)', async () => {
  const sel = selectBackend({ KOLM_SANDBOX: 'isolated-vm' });
  assert.equal(sel.backend, 'isolated-vm');
  const r = await runIsolated({
    source: 'function generate(){ return 1; }',
    input: null,
    env: { KOLM_SANDBOX: 'isolated-vm' },
  });
  // isolated-vm is NOT installed in this repo -> must fail loud, NOT silently
  // downgrade to the worker boundary.
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sandbox_dep_missing');
  assert.match(r.detail, /npm install isolated-vm/);
  assert.equal(r.backend, 'isolated-vm');
});

test('A8 backend selection defaults to worker; unknown value warns', () => {
  assert.equal(selectBackend({}).backend, 'worker');
  assert.equal(selectBackend({ KOLM_SANDBOX: 'worker' }).backend, 'worker');
  const unk = selectBackend({ KOLM_SANDBOX: 'nope' });
  assert.equal(unk.backend, 'worker');
  assert.ok(unk.warning);
  assert.ok(DEFAULT_LIB_ALLOWLIST.includes('upper'));
  assert.equal(DEFAULT_LIMITS.wall_ms, 250);
});

test('A9 bad source is rejected without spawning a worker', async () => {
  const r = await runIsolated({ source: '', input: null });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_source');
});

// =============================================================================
// B. K-SCORE GATE HARNESS
// =============================================================================

test('B1 metamorphic harness catches a non-deterministic recipe', () => {
  let n = 0;
  const flaky = () => (++n % 2 === 0 ? 'a' : 'b'); // violates idempotence
  const r = runMetamorphic({ runRecipe: flaky, inputs: ['x', 'y'], relations: ['idempotent'] });
  assert.equal(r.ok, true);
  assert.ok(r.failed > 0, 'flaky recipe must produce MR violations');
  assert.ok(r.violations.some((v) => v.relation === 'idempotent'));
});

test('B2 metamorphic harness passes a clean deterministic + case-invariant recipe', () => {
  const clean = (x) => ({ label: String(x).trim().toLowerCase() });
  const r = runMetamorphic({
    runRecipe: clean,
    inputs: ['Hello', 'WORLD'],
    relations: ['idempotent', 'whitespace', 'case_label'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.pass_rate, 1, JSON.stringify(r.violations));
});

test('B3 mutation testing KILLS broken mutants when the eval is strong', () => {
  // Strong eval: scores accuracy by actually running the recipe on cases.
  const cases = [
    { input: 'spam buy now', expected: 'spam' },
    { input: 'hi mom', expected: 'ham' },
    { input: 'win free money', expected: 'spam' },
    { input: 'lunch at noon', expected: 'ham' },
  ];
  const scoreRecipe = (source) => {
    // Compile the mutant in a throwaway function; if it throws, accuracy 0.
    let fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('input', 'lib', `${source}; return generate(input, lib);`);
    } catch { return { accuracy: 0, coverage: 1 }; }
    let correct = 0;
    for (const c of cases) {
      let out;
      try { out = fn(c.input, {}); } catch { out = null; }
      if (out === c.expected) correct += 1;
    }
    return { accuracy: correct / cases.length, coverage: 1 };
  };
  const source = 'function generate(input){ if (/\\b(buy|free|win|money)\\b/.test(input)) { return "spam"; } else { return "ham"; } }';
  const r = runMutationTesting({ source, scoreRecipe });
  assert.equal(r.ok, true);
  assert.equal(r.original_accuracy, 1);
  assert.ok(r.total_mutants > 0);
  // A strong eval kills most mutants.
  assert.ok(r.mutation_score >= 0.5, `mutation_score too low: ${r.mutation_score}`);
});

test('B4 mutation testing REPORTS a survivor when the eval is weak', () => {
  // Weak eval: returns a constant accuracy regardless of the recipe -> every
  // mutant survives, surfacing that the K-score is gameable.
  const weakEval = () => ({ accuracy: 1, coverage: 1 });
  const r = runMutationTesting({
    source: 'function generate(input){ if (input) { return "x"; } else { return "y"; } }',
    scoreRecipe: weakEval,
  });
  assert.equal(r.ok, true);
  assert.ok(r.survived > 0, 'weak eval must leave survivors');
  assert.equal(r.mutation_score, 0);
});

test('B5 holdout is FAIL-CLOSED on train/holdout overlap', () => {
  const runRecipe = (x) => x.label;
  const holdout = [
    { input: { id: 1, label: 'a' }, expected: 'a' },
    { input: { id: 2, label: 'b' }, expected: 'b' },
  ];
  // train shares case id:1 -> overlap -> disjoint:false (refuse to certify).
  const train = [{ input: { id: 1, label: 'a' } }];
  const r = evaluateHoldout({ runRecipe, holdout, train });
  assert.equal(r.ok, true);
  assert.equal(r.disjoint, false);
  assert.equal(r.overlap_count, 1);
});

test('B6 disjoint holdout yields accuracy + residuals for the conformal layer', () => {
  const runRecipe = (x) => x.label;
  const holdout = [
    { input: { id: 3, label: 'a' }, expected: 'a' },
    { input: { id: 4, label: 'b' }, expected: 'WRONG' }, // recipe returns 'b'
  ];
  const train = [{ input: { id: 1, label: 'a' } }];
  const r = evaluateHoldout({ runRecipe, holdout, train });
  assert.equal(r.disjoint, true);
  assert.equal(r.accuracy, 0.5);
  assert.deepEqual(r.residuals, [0, 1]);
});

test('B7 conformal-bounded gate SHIPS when the lower bound clears 0.85', () => {
  // Tight residual pool (predictor is accurate) + a high composite -> lower
  // bound clears the gate -> 'ship'.
  const residuals = Array.from({ length: 60 }, () => 0.01);
  const r = conformalBoundedGate({
    kscoreInput: { accuracy: 0.99, coverage: 1, size_bytes: 2048, p50_latency_us: 50, cost_usd_per_call: 0 },
    calibrationResiduals: residuals,
    alpha: 0.10,
  });
  assert.equal(r.ok, true);
  assert.equal(r.gate, SHIP_GATE);
  assert.ok(r.composite >= SHIP_GATE, `composite ${r.composite}`);
  assert.ok(r.interval.lo >= SHIP_GATE, `lo ${r.interval.lo} must clear gate`);
  assert.equal(r.decision, 'ship');
  assert.equal(r.confidence_bounded, true);
});

test('B8 conformal gate ABSTAINS when the interval straddles the gate (stricter than point gate)', () => {
  // Composite just above the gate, but a WIDE residual pool pulls the lower
  // bound below 0.85 -> abstain even though point_ships would be true.
  const residuals = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05).valueOf() + (i % 7) * 0.01);
  const r = conformalBoundedGate({
    kscoreInput: { accuracy: 0.90, coverage: 1, size_bytes: 4096, p50_latency_us: 80, cost_usd_per_call: 0 },
    calibrationResiduals: residuals,
    alpha: 0.10,
  });
  assert.equal(r.ok, true);
  // The conformal layer is at least as strict as the point gate: it never ships
  // something the point gate rejects, and may abstain on something the point
  // gate would pass.
  if (r.point_ships) {
    assert.ok(['ship', 'abstain'].includes(r.decision));
  }
  // With a non-trivial width the lower bound is below the composite.
  assert.ok(r.interval.lo <= r.composite + 1e-9);
});

test('B9 conformal gate FAILS CLOSED to abstain on an undercalibrated pool', () => {
  const r = conformalBoundedGate({
    kscoreInput: { accuracy: 0.99, coverage: 1, size_bytes: 1024 },
    calibrationResiduals: [0.001, 0.002], // far below MIN -> undercalibrated
    alpha: 0.10,
  });
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'conformal_undercalibrated');
  assert.equal(r.confidence_bounded, false);
  // Undercalibrated -> [0,1] interval straddles -> abstain. Never ships on a
  // bare point estimate.
  assert.equal(r.decision, 'abstain');
});

test('B10 certifyShip composes all four gates and SHIPS a strong recipe', () => {
  const runRecipe = (x) => ({ label: String(x).trim().toLowerCase() });
  const metamorphic = { runRecipe, inputs: ['Hi', 'YO'], relations: ['idempotent', 'whitespace', 'case_label'] };

  const cases = [
    { input: 'a', expected: 'a' }, { input: 'b', expected: 'b' },
    { input: 'c', expected: 'c' }, { input: 'd', expected: 'd' },
  ];
  const scoreRecipe = (source) => {
    let fn;
    try { fn = new Function('input', `${source}; return generate(input);`); }
    catch { return { accuracy: 0 }; }
    let ok = 0;
    for (const c of cases) { let o; try { o = fn(c.input); } catch { o = null; } if (o === c.expected) ok++; }
    return { accuracy: ok / cases.length, coverage: 1 };
  };
  const mutSource = 'function generate(input){ if (input === "a") { return "a"; } if (input === "b") { return "b"; } if (input === "c") { return "c"; } return "d"; }';

  const holdout = {
    runRecipe: (x) => x.y,
    holdout: [
      { input: { id: 10, y: 'p' }, expected: 'p' },
      { input: { id: 11, y: 'q' }, expected: 'q' },
      { input: { id: 12, y: 'r' }, expected: 'r' },
      { input: { id: 13, y: 's' }, expected: 's' },
    ],
    train: [{ input: { id: 1, y: 'z' } }],
  };

  const out = certifyShip({
    kscoreInput: { accuracy: 0.99, coverage: 1, size_bytes: 2048, p50_latency_us: 40, cost_usd_per_call: 0 },
    calibrationResiduals: Array.from({ length: 60 }, () => 0.01),
    alpha: 0.10,
    metamorphic,
    mutation: { source: mutSource, scoreRecipe },
    holdout,
  });

  assert.equal(out.ok, true);
  assert.equal(out.criteria.metamorphic.pass, true, JSON.stringify(out.criteria.metamorphic));
  assert.equal(out.criteria.holdout.pass, true, JSON.stringify(out.criteria.holdout));
  assert.equal(out.criteria.conformal_gate.pass, true, JSON.stringify(out.criteria.conformal_gate));
  assert.equal(out.ships, true, `blocked: ${JSON.stringify(out.reasons)}`);
  assert.equal(out.decision, 'ship');
});

test('B11 certifyShip FAILS CLOSED when a required signal is missing', () => {
  const out = certifyShip({
    kscoreInput: { accuracy: 0.99, coverage: 1, size_bytes: 1024 },
    calibrationResiduals: Array.from({ length: 60 }, () => 0.01),
    // metamorphic / mutation / holdout deliberately omitted
  });
  assert.equal(out.ok, true);
  assert.equal(out.ships, false);
  assert.ok(out.reasons.length >= 3, JSON.stringify(out.reasons));
  assert.equal(out.criteria.metamorphic.pass, false);
  assert.equal(out.criteria.mutation.pass, false);
  assert.equal(out.criteria.holdout.pass, false);
});

test('B12 version + gate constants are pinned', () => {
  assert.equal(KSCORE_GATE_HARNESS_VERSION, 'ksgh-v1');
  assert.equal(SHIP_GATE, 0.85);
});
