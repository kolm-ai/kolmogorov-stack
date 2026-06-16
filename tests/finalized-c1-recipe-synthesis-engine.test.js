// Tests for the Recipe Synthesis Engine (finalized-c1).
//
// Proves the best-in-slot synthesis behaviors WITHOUT any network: every
// "teacher" is a deterministic injected `complete` fn, so the loop is fully
// reproducible and the privacy boundary (external_calls counter) is provable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  synthesizeRecipe,
  parseRecipeAst,
  createInducedLibrary,
  extractFailures,
  assertHoldoutDisjoint,
  RECIPE_SYNTHESIS_ENGINE_VERSION,
} from '../src/recipe-synthesis-engine.js';
import { compileJs, verify, QUALITY_GATE } from '../src/verifier.js';

// A correct generator for "input contains 'urgent' -> true" boolean task.
const GOOD_BOOL = `function generate(input, lib) { return lib.containsAny(input, ['urgent', 'asap']); }`;
// A buggy first draft: always returns false (fails the positive cases).
const BUGGY_BOOL = `function generate(input, lib) { return false; }`;
// An unsafe candidate the AST + verifier must reject.
const UNSAFE = `function generate(input, lib) { return process.env.SECRET; }`;

const BOOL_SPEC = {
  output_spec: { type: 'boolean' },
  positives: [
    { input: 'this is urgent please reply', expected: true },
    { input: 'need this asap', expected: true },
    { input: 'just a normal note', expected: false },
    { input: 'nothing pressing here', expected: false },
  ],
  negatives: [],
};

// --------------------------------------------------------------------------
test('parseRecipeAst accepts a clean recipe and induces its subroutines', () => {
  const { ok, node, violations } = parseRecipeAst(GOOD_BOOL);
  assert.equal(ok, true, `violations: ${violations.join(',')}`);
  assert.equal(node.entry, 'generate');
  assert.equal(node.structural_ok, true);
  assert.deepEqual(node.used_subroutines, ['containsAny']);
});

test('parseRecipeAst rejects forbidden identifiers (mirrors verifier sandbox)', () => {
  const { ok, violations } = parseRecipeAst(UNSAFE);
  assert.equal(ok, false);
  assert.ok(violations.some(v => v.startsWith('forbidden:')), violations.join(','));
  // And the real verifier sandbox agrees - the engine never accepts something
  // the sandbox would throw on.
  assert.throws(() => compileJs(UNSAFE), /forbidden identifier/);
});

test('parseRecipeAst rejects missing generate fn and unbalanced braces', () => {
  assert.equal(parseRecipeAst('const x = 1;').ok, false);
  assert.equal(parseRecipeAst('function generate(i, lib) { return 1;').ok, false);
  assert.equal(parseRecipeAst('').ok, false);
});

test('parseRecipeAst does not false-reject forbidden words in comments', () => {
  const src = `// this avoids process and require by design\nfunction generate(i, lib){ return lib.tokenize(i).length; }`;
  const { ok } = parseRecipeAst(src);
  assert.equal(ok, true);
});

// --------------------------------------------------------------------------
test('pattern path accepts a passing recipe with ZERO external calls (privacy)', async () => {
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    patternFn: () => [GOOD_BOOL],
    council: [],
  });
  assert.equal(res.accepted, true);
  assert.equal(res.external_calls, 0, 'pattern path must make no external calls');
  assert.equal(res.recipe_class, 'synthesized_rule');
  assert.ok(res.quality_score >= QUALITY_GATE);
  assert.equal(res.member, 'pattern');
  assert.ok(res.source_hash && res.source_hash.length > 0);
});

test('K-score gating: a below-gate candidate is NOT accepted', async () => {
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    patternFn: () => [BUGGY_BOOL], // always-false fails half the positives
    council: [],
  });
  assert.equal(res.accepted, false);
  assert.match(res.reason, /below gate/);
  assert.ok(res.best_result.quality_score < QUALITY_GATE);
});

// --------------------------------------------------------------------------
test('execution-feedback repair loop: round 2 fixes what round 1 got wrong', async () => {
  const seenPrompts = [];
  // A teacher that emits the buggy draft first, then - ONLY when it sees the
  // failing cases in the repair prompt - emits the correct generator.
  const repairingTeacher = {
    id: 'repair-teacher',
    complete: async (prompt) => {
      seenPrompts.push(prompt);
      if (/FAILING CASES/.test(prompt)) return GOOD_BOOL;
      return BUGGY_BOOL;
    },
  };
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    council: [repairingTeacher],
    rounds: 2,
    samplesPerRound: [0], // one sample per round so the loop is deterministic
  });
  assert.equal(res.accepted, true, JSON.stringify(res));
  assert.equal(res.round, 1, 'should be accepted on the second (repair) round');
  assert.equal(res.member, 'repair-teacher');
  // The repair prompt must contain the actual failing case, not a blind re-roll.
  assert.ok(seenPrompts.length >= 2);
  assert.match(seenPrompts[1], /FAILING CASES/);
  assert.match(seenPrompts[1], /urgent/);
});

test('extractFailures surfaces failing positive cases from a verifier trace', () => {
  const compiled = compileJs(BUGGY_BOOL);
  const r = verify(compiled, { positives: BOOL_SPEC.positives, negatives: [] });
  const failures = extractFailures(r.trace);
  assert.ok(failures.length >= 1);
  assert.equal(failures[0].kind, 'positive');
  assert.ok('expected' in failures[0] && 'got' in failures[0]);
});

// --------------------------------------------------------------------------
test('induced-subroutine library reinforces winners and exposes a hint', () => {
  const lib = createInducedLibrary();
  lib.reinforce(['containsAny'], 0.9);
  lib.reinforce(['containsAny', 'tokenize'], 0.8);
  const ranked = lib.ranked();
  assert.equal(ranked[0].name, 'containsAny'); // reinforced twice -> highest
  assert.ok(lib.hint().includes('lib.containsAny'));
  assert.equal(lib.size(), 2);
});

test('induced library is populated on a real synthesis run', async () => {
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    patternFn: () => [GOOD_BOOL],
  });
  assert.ok(Array.isArray(res.induced_library));
  assert.ok(res.induced_library.some(e => e.name === 'containsAny'));
  assert.deepEqual(res.used_subroutines, ['containsAny']);
});

// --------------------------------------------------------------------------
test('teacher-council voting: higher-weight teacher breaks a verifier tie', async () => {
  // Two teachers each produce a DIFFERENT but equally-correct generator (same
  // quality). The council weight should decide the winner.
  const genA = `function generate(input, lib) { return lib.containsAny(input, ['urgent','asap']); }`;
  const genB = `function generate(input, lib) { const t = lib.tokenize(input); return t.includes('urgent') || t.includes('asap'); }`;
  // Both candidates have identical (perfect-on-train) verifier quality. To
  // exercise the *vote* tie-break we raise the gate above their quality so
  // neither is accepted, then inspect the fused-score best_member ranking.
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    gate: 1.01, // unreachable -> both fall to best-effort ranking
    council: [
      { id: 'weak', complete: async () => genA, weight: 0.1 },
      { id: 'strong', complete: async () => genB, weight: 0.9 },
    ],
    rounds: 1,
    samplesPerRound: [0],
  });
  assert.equal(res.accepted, false); // gate unreachable -> best-effort
  // Both have identical verifier quality; the fused score must pick the
  // higher-weight (strong) teacher's candidate as best.
  assert.equal(res.best_member, 'strong');
});

// --------------------------------------------------------------------------
test('holdout disjointness is fail-CLOSED (overlap throws)', () => {
  const train = [{ input: 'a', expected: true }];
  const holdout = [{ input: 'a', expected: true }]; // identical -> overlap
  assert.throws(() => assertHoldoutDisjoint(train, holdout), /not disjoint/);
});

test('disjoint holdout yields an independent generalization score', async () => {
  const holdout = [
    { input: 'urgent server down', expected: true },
    { input: 'weekly digest', expected: false },
  ];
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    holdout,
    patternFn: () => [GOOD_BOOL],
  });
  assert.equal(res.accepted, true);
  assert.ok(res.holdout_generalization);
  assert.equal(res.holdout_generalization.n, 2);
  assert.ok(res.holdout_generalization.pass_rate_positive >= 0);
  assert.ok(res.holdout_generalization.robustness_ratio <= 1);
});

test('synthesizeRecipe refuses to fit when holdout overlaps train', async () => {
  await assert.rejects(
    synthesizeRecipe({
      output_spec: { type: 'boolean' },
      positives: [{ input: 'urgent', expected: true }],
      holdout: [{ input: 'urgent', expected: true }],
      patternFn: () => [GOOD_BOOL],
    }),
    /not disjoint/,
  );
});

// --------------------------------------------------------------------------
test('engine never accepts a candidate the verifier sandbox would reject', async () => {
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    council: [{ id: 'hostile', complete: async () => UNSAFE }],
    patternFn: () => [UNSAFE],
    rounds: 1,
    samplesPerRound: [0],
  });
  assert.equal(res.accepted, false);
  // No accepted source ever contains the forbidden token.
  assert.ok(!res.source);
});

test('no candidate compiles -> structured no-compile result', async () => {
  const res = await synthesizeRecipe({
    ...BOOL_SPEC,
    council: [{ id: 'garbage', complete: async () => 'not a recipe at all' }],
    rounds: 1,
    samplesPerRound: [0],
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'no candidate compiled');
  assert.ok(Array.isArray(res.attempts));
});

test('version constant is exported and stable', () => {
  assert.equal(RECIPE_SYNTHESIS_ENGINE_VERSION, 'finalized-c1-v1');
});
