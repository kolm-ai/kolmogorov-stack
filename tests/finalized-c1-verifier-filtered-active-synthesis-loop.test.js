// finalized-c1 — Verifier-gated, student-loss-driven active synthesis loop.
//
// Proves the BUILD SPEC end-to-end against src/active-synthesis-loop.js:
//   (1) every synthetic row passes through a TASK-APPROPRIATE verifier
//       (exact-match / unit-test / json-schema / llm-judge) and FAILING rows are
//       DROPPED — generate-then-verify-then-filter.
//   (2) survivors are scored by the STUDENT's prediction loss on a probe and the
//       high-loss / high-info-gain set is selected by ARGMAX (NOT softmax) —
//       difficulty beats reward, student-pred beats ground-truth.
//   (3) the selected set feeds back as the next generation's seeds, iterating
//       until eval / K-score PLATEAUS.
//   - REUSE: applyThreshold (keep-fraction) + selectDiverseBatch (diversity gate).
//   - SURFACE: per-iteration verify_pass_rate and k_score_delta.
//
// Pure JS, zero new deps, deterministic. Run ONLY this file to self-check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_SYNTH_LOOP_VERSION,
  TASK_TYPES,
  runActiveSynthesisLoop,
  __internals,
} from '../src/active-synthesis-loop.js';

const {
  verifyExactMatch,
  verifyUnitTest,
  verifyJsonSchema,
  verifyLlmJudge,
  verifyBatch,
  argmaxTopK,
  scoreByStudentLoss,
  defaultDifficultyProxy,
  _validateSchema,
} = __internals;

// ── (1) TASK-APPROPRIATE VERIFIERS ───────────────────────────────────────────

test('exact-match verifier passes only the matching reference', () => {
  assert.equal(verifyExactMatch({ output: 'hello  world', expected: 'hello world' }).pass, true);
  assert.equal(verifyExactMatch({ output: 'nope', expected: 'hello world' }).pass, false);
  // no reference declared => fail-closed
  assert.equal(verifyExactMatch({ output: 'x' }).pass, false);
  // byte-exact mode rejects whitespace-only difference
  assert.equal(verifyExactMatch({ output: 'a  b', expected: 'a b' }, { normalize: false }).pass, false);
});

test('unit-test verifier runs declared assertions and is fail-closed on throw', () => {
  // declared got/expect
  assert.equal(verifyUnitTest({ output: '4', tests: [{ got: 4, expect: 4 }] }).pass, true);
  assert.equal(verifyUnitTest({ output: '5', tests: [{ got: 4, expect: 5 }] }).pass, false);
  // no tests declared => fail-closed
  assert.equal(verifyUnitTest({ output: 'x' }).pass, false);
  // assertFn predicate path
  assert.equal(verifyUnitTest({ output: 'abc' }, { assertFn: (o) => o.length === 3 }).pass, true);
  // a throwing assertion never silently passes
  assert.equal(verifyUnitTest({ output: 'x' }, { assertFn: () => { throw new Error('boom'); } }).pass, false);
});

test('json-schema verifier enforces parse + types + required + enum', () => {
  const schema = {
    type: 'object',
    required: ['name', 'age'],
    properties: { name: { type: 'string' }, age: { type: 'integer' }, role: { enum: ['a', 'b'] } },
  };
  assert.equal(verifyJsonSchema({ output: '{"name":"x","age":3}', schema }).pass, true);
  assert.equal(verifyJsonSchema({ output: 'not json', schema }).pass, false);            // not parseable
  assert.equal(verifyJsonSchema({ output: '{"name":"x"}', schema }).pass, false);        // missing required
  assert.equal(verifyJsonSchema({ output: '{"name":"x","age":1.5}', schema }).pass, false); // wrong type
  assert.equal(verifyJsonSchema({ output: '{"name":"x","age":1,"role":"z"}', schema }).pass, false); // enum
  // no schema => fail-closed
  assert.equal(verifyJsonSchema({ output: '{}' }).pass, false);
  // direct validator: nested arrays
  assert.equal(_validateSchema([1, 2], { type: 'array', items: { type: 'integer' } }), '');
  assert.notEqual(_validateSchema([1, 'x'], { type: 'array', items: { type: 'integer' } }), '');
});

test('llm-judge verifier consumes a caller verdict and fails LOUD without one', async () => {
  // no judge wired => fail-closed with an install/config hint (never a silent pass)
  const noJudge = await verifyLlmJudge({ output: 'x' }, {});
  assert.equal(noJudge.pass, false);
  assert.match(noJudge.hint, /judgeFn/);
  // boolean judge
  assert.equal((await verifyLlmJudge({ output: 'x' }, { judgeFn: () => true })).pass, true);
  // score judge with threshold
  assert.equal((await verifyLlmJudge({ output: 'x' }, { judgeFn: () => ({ score: 0.9 }), judgeThreshold: 0.5 })).pass, true);
  assert.equal((await verifyLlmJudge({ output: 'x' }, { judgeFn: () => ({ score: 0.2 }), judgeThreshold: 0.5 })).pass, false);
  // a judge that throws is fail-closed
  assert.equal((await verifyLlmJudge({ output: 'x' }, { judgeFn: () => { throw new Error('net'); } })).pass, false);
});

test('verifyBatch drops failures, reports pass_rate, and honours per-row task_type', async () => {
  const batch = [
    { task_type: 'exact-match', output: 'a', expected: 'a' },             // pass
    { task_type: 'exact-match', output: 'b', expected: 'c' },             // fail
    { task_type: 'json-schema', output: '{"k":1}', schema: { type: 'object', required: ['k'] } }, // pass
    { task_type: 'json-schema', output: 'broken', schema: { type: 'object' } },                   // fail
  ];
  const r = await verifyBatch(batch, 'exact-match', {});
  assert.equal(r.survivors.length, 2);
  assert.equal(r.pass_rate, 0.5);
  // rejected rows are accounted for with reasons
  const totalRejected = Object.values(r.reasons).reduce((a, b) => a + b, 0);
  assert.equal(totalRejected, 2);
});

// ── (2) STUDENT-LOSS PROBE + ARGMAX (NOT softmax) ────────────────────────────

test('argmaxTopK picks the highest-loss rows deterministically (no sampling)', () => {
  const losses = [0.1, 0.9, 0.5, 0.95, 0.2];
  const pick = argmaxTopK(losses, 2);
  // top-2 by loss are indices 3 (0.95) and 1 (0.9); returned sorted ascending
  assert.deepEqual(pick, [1, 3]);
  // deterministic across repeats
  assert.deepEqual(argmaxTopK(losses, 2), pick);
  // ties break on original index (stable)
  assert.deepEqual(argmaxTopK([0.5, 0.5, 0.5], 2), [0, 1]);
});

test('student-loss scoring drives selection by student-pred, not ground-truth', async () => {
  // A custom student probe: loss is HIGH where the student is wrong. This must
  // override any notion of "looks nice" — difficulty beats reward.
  const rows = [
    { input: 'easy', output: 'short' },
    { input: 'hard', output: 'a long detailed structured multi-step answer 1 2 3' },
  ];
  const studentLossFn = (row) => (row.input === 'hard' ? 5.0 : 0.01);
  const losses = await scoreByStudentLoss(rows, studentLossFn);
  assert.ok(losses[1] > losses[0]);
  // the default proxy is difficulty-monotone (longer/denser => higher), never reward
  assert.ok(defaultDifficultyProxy(rows[1]) > defaultDifficultyProxy(rows[0]));
  assert.equal(defaultDifficultyProxy({ output: '' }), 0); // empty target carries no signal
});

// ── (1)+(2)+(3) FULL LOOP ─────────────────────────────────────────────────────

// A deterministic generator: each round emits a candidate batch derived from the
// seeds. Half the candidates are intentionally BROKEN so the verifier has work.
// Difficulty (a tagged numeric) is embedded in the row so a student probe can
// score it; the loop must keep the verified + hardest + diverse rows.
function makeGenerator() {
  let round = 0;
  return async (seeds) => {
    round += 1;
    const out = [];
    // 6 candidates per round across distinct topics (so the diversity gate bites)
    const topics = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    for (let i = 0; i < topics.length; i++) {
      const hard = i % 2 === 0;                 // even => hard, odd => easy
      const broken = i >= 4;                    // last two are verifier-FAIL rows
      const ans = `${topics[i]} answer r${round} ${hard ? 'with many detailed steps 1 2 3 4 5' : 'ok'}`;
      out.push({
        task_type: 'exact-match',
        topic: topics[i],
        input: `solve ${topics[i]} case from ${(seeds[0] && seeds[0].topic) || 'root'}`,
        output: broken ? 'WRONG' : ans,
        expected: ans,                          // broken rows mismatch => dropped
        difficulty: hard ? 1.0 : 0.1,
      });
    }
    return out;
  };
}

test('full loop: verify -> student-loss argmax -> feedback, surfacing pass_rate + k_delta', async () => {
  const studentLossFn = (row) => Number(row.difficulty) || 0; // probe = embedded difficulty
  const res = await runActiveSynthesisLoop({
    seeds: [{ topic: 'root', input: 'seed', output: 'x', expected: 'x' }],
    generate: makeGenerator(),
    taskType: 'exact-match',
    studentLossFn,
    selectFraction: 0.5,
    diversityTau: 0.95,
    seedBudget: 3,
    maxIterations: 5,
  });

  assert.equal(res.ok, true);
  assert.equal(res.version, ACTIVE_SYNTH_LOOP_VERSION);
  assert.ok(res.iterations.length >= 1);

  for (const it of res.iterations) {
    // (1) generate-then-verify-then-filter: 2 of 6 are broken => pass_rate ~ 0.667
    assert.equal(it.generated, 6);
    assert.equal(it.verify_pass_rate, Number((4 / 6).toFixed(6)));
    assert.equal(it.verified, 4);               // exactly the 4 non-broken rows
    // surfaced metrics exist
    assert.ok(typeof it.verify_pass_rate === 'number');
    assert.ok(typeof it.k_score_delta === 'number');
    assert.ok('verify_reasons' in it);
    // (2) selection bounded by seedBudget and never exceeds survivors
    assert.ok(it.selected <= 3);
    assert.ok(it.selected <= it.verified);
  }

  // (2) the loop preferentially keeps HARD rows: among accumulated train rows the
  // mean embedded difficulty must beat a pass-through average of the survivors
  // (0.5: two hard, two easy survive each round). Active synthesis kept the hard.
  const meanDiff = res.train.reduce((a, r) => a + (Number(r.difficulty) || 0), 0) / res.train.length;
  assert.ok(meanDiff > 0.5, `expected high-loss bias, got mean difficulty ${meanDiff}`);

  // (3) feedback: every selected train row is a VERIFIED row (output === expected,
  // never a 'WRONG' broken candidate). Proves only survivors feed forward.
  for (const r of res.train) {
    assert.equal(r.output, r.expected);
    assert.notEqual(r.output, 'WRONG');
  }
});

test('loop STOPS on a K-score plateau (not just max iterations)', async () => {
  // A generator that always emits the SAME verified rows => K-score (intrinsic
  // proxy or constant evalFn) does not move => plateau fires before the ceiling.
  const fixed = async () => ([
    { task_type: 'exact-match', topic: 't1', input: 'a', output: 'aaa bbb ccc', expected: 'aaa bbb ccc', difficulty: 0.8 },
    { task_type: 'exact-match', topic: 't2', input: 'b', output: 'ddd eee fff', expected: 'ddd eee fff', difficulty: 0.8 },
  ]);
  let evalCalls = 0;
  const res = await runActiveSynthesisLoop({
    seeds: [{ topic: 'root', input: 's', output: 'x', expected: 'x' }],
    generate: fixed,
    taskType: 'exact-match',
    evalFn: () => { evalCalls += 1; return 0.7; }, // constant K-score => delta 0
    selectFraction: 1.0,
    diversityTau: 0.99,
    seedBudget: 2,
    maxIterations: 10,
    plateauEps: 1e-6,
    plateauPatience: 2,
  });
  assert.equal(res.plateaued, true);
  assert.equal(res.stopped_reason, 'k_score_plateau');
  assert.ok(res.iterations.length < 10, 'must stop before the hard ceiling');
  // first iteration delta == k_score (no prior baseline); subsequent deltas ~ 0
  const lastTwo = res.iterations.slice(-2);
  for (const it of lastTwo) assert.ok(Math.abs(it.k_score_delta) <= 1e-6);
  assert.equal(res.final_k_score, 0.7);
  assert.ok(evalCalls >= 2);
});

test('K-score IMPROVES then plateaus on a converging eval signal', async () => {
  // evalFn returns a saturating curve in the accumulated train size: it climbs
  // for the first rounds then flattens — exactly the "iterate until plateau" shape.
  const gen = async (seeds) => ([
    { task_type: 'exact-match', topic: 'k' + Math.random(), input: 'x', output: 'foo bar baz qux', expected: 'foo bar baz qux', difficulty: 0.6 },
  ]);
  const res = await runActiveSynthesisLoop({
    seeds: [{ topic: 'r', input: 's', output: 'x', expected: 'x' }],
    generate: gen,
    taskType: 'exact-match',
    // saturating K-score: 1 - 1/(1+n). delta shrinks each round -> plateau.
    evalFn: (train) => 1 - 1 / (1 + train.length),
    selectFraction: 1.0,
    seedBudget: 1,
    maxIterations: 30,
    plateauEps: 0.02,
    plateauPatience: 2,
  });
  assert.equal(res.ok, true);
  // K-score is monotone non-decreasing across rounds
  const ks = res.iterations.map((it) => it.k_score);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] >= ks[i - 1] - 1e-9);
  // it converged via plateau, not by exhausting the 30-round ceiling
  assert.equal(res.plateaued, true);
  assert.ok(res.final_k_score > res.iterations[0].k_score);
});

test('verify-pass-rate is reported even when EVERY candidate fails (loud, not silent)', async () => {
  const allBad = async () => ([
    { task_type: 'exact-match', output: 'x', expected: 'y' },
    { task_type: 'exact-match', output: 'p', expected: 'q' },
  ]);
  const res = await runActiveSynthesisLoop({
    seeds: [{ input: 's', output: 'x', expected: 'x' }],
    generate: allBad,
    taskType: 'exact-match',
    maxIterations: 3,
  });
  assert.equal(res.ok, true);
  assert.equal(res.iterations[0].verify_pass_rate, 0);
  assert.equal(res.iterations[0].verified, 0);
  assert.equal(res.stopped_reason, 'all_candidates_failed_verification');
  assert.equal(res.n_train, 0); // nothing unverified ever entered the train set
});

test('determinism: identical inputs produce identical loop traces', async () => {
  const cfg = () => ({
    seeds: [{ topic: 'root', input: 'seed', output: 'x', expected: 'x' }],
    generate: makeGenerator(),
    taskType: 'exact-match',
    studentLossFn: (row) => Number(row.difficulty) || 0,
    selectFraction: 0.5,
    diversityTau: 0.95,
    seedBudget: 3,
    maxIterations: 4,
  });
  const a = await runActiveSynthesisLoop(cfg());
  const b = await runActiveSynthesisLoop(cfg());
  assert.deepEqual(
    a.iterations.map((i) => [i.verify_pass_rate, i.selected, i.k_score]),
    b.iterations.map((i) => [i.verify_pass_rate, i.selected, i.k_score]),
  );
  assert.equal(a.n_train, b.n_train);
});

test('guards: missing generate is a loud config error; TASK_TYPES is the declared set', async () => {
  const res = await runActiveSynthesisLoop({ seeds: [] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_generate_fn');
  assert.match(res.hint, /generate/);
  assert.deepEqual([...TASK_TYPES].sort(), ['exact-match', 'json-schema', 'llm-judge', 'unit-test']);
});
