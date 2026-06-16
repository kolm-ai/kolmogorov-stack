// W-finalized C3 - Training-Data Valuation via Data Shapley / KNN-Shapley.
//
// Proves src/data-shapley.js:
//   (1) KNN-Shapley closed form (Jia et al. 2019) MATCHES brute-force EXACT
//       Shapley (full permutation expectation) on a small KNN utility - this is
//       the load-bearing correctness pin: the O(N log N) recursion must equal
//       the combinatorial definition.
//   (2) signed values + harmful_indices: a deliberately mislabeled / off-target
//       pair gets a NEGATIVE value and is flagged harmful; a perfectly aligned
//       pair gets the highest value.
//   (3) determinism: identical (pairs, val_pairs, seed) => byte-identical output.
//   (4) Truncated Monte-Carlo Shapley converges (convergence.converged) and its
//       values correlate with the exact KNN ranking; truncation fires.
//   (5) method:'auto' DEGRADES to KNN-Shapley when MC is starved of permutations
//       (maxPermutations too small to converge).
//   (6) envelope NEVER throws: empty pairs, empty val, garbage rows, bad opts.
//   (7) injected utility proxy (e.g. the quality head) is honored by MC.
//   (8) curate-integration surface: harmful_indices can drive an optional
//       drop/flag stage (the values let a caller filter pairs deterministically).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_SHAPLEY_VERSION,
  valuePairsByShapley,
} from '../src/data-shapley.js';
import { embed, cosine } from '../src/embedding.js';

// -- brute-force EXACT Shapley over all permutations, for the KNN utility -------
// This is the ground truth the closed form must reproduce. We define the same
// KNN utility the module's KNN-Shapley assumes: for each val point, the fraction
// of its K nearest TRAIN neighbors (within the coalition) whose label matches.
function _label(p) {
  if (p && p.label != null) return String(p.label);
  return 'topic_default';
}
function _text(p) { return ((p.input || '') + '\n\n' + (p.output || '')).trim(); }

function _bruteForceKnnShapley(pairs, valPairs, K) {
  const N = pairs.length;
  const trainVecs = pairs.map((p) => embed(_text(p)));
  const valVecs = valPairs.map((p) => embed(_text(p)));
  const trainLabels = pairs.map(_label);
  const valLabels = valPairs.map(_label);

  // KNN utility of a coalition (set of train indices) over the whole val set.
  // This is the EXACT utility the Jia et al. (2019) closed form assumes:
  //   U(S) = (1/|val|) * sum_val (1/K) * sum_{top-K nearest in S} 1[label match]
  // Note the normalizer is the CONSTANT K, not min(K, |S|): a coalition with
  // fewer than K points still divides by K (its utility is just smaller). This
  // is what makes the backward recursion's min(K,i)/i term exact.
  function util(setArr) {
    if (setArr.length === 0) return 0;
    let tot = 0;
    for (let v = 0; v < valVecs.length; v++) {
      const sims = setArr.map((i) => ({ i, s: cosine(valVecs[v], trainVecs[i]) }));
      sims.sort((a, b) => b.s - a.s);
      const top = sims.slice(0, Math.min(K, sims.length));
      let agree = 0;
      for (const t of top) if (trainLabels[t.i] === valLabels[v]) agree += 1;
      tot += agree / K;
    }
    return tot / valVecs.length;
  }

  // all permutations of [0..N)
  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
  }
  const idx = [];
  for (let i = 0; i < N; i++) idx.push(i);
  const perms = permutations(idx);

  const phi = new Array(N).fill(0);
  for (const perm of perms) {
    const prefix = [];
    let prevU = 0;
    for (const j of perm) {
      prefix.push(j);
      const u = util(prefix);
      phi[j] += (u - prevU);
      prevU = u;
    }
  }
  for (let i = 0; i < N; i++) phi[i] /= perms.length;
  return phi;
}

// -- fixtures ------------------------------------------------------------------

// Two clear topics: cats and finance. The val set is all "cats".
function catFinanceCorpus() {
  const pairs = [
    { input: 'how do cats purr', output: 'cats purr by vibrating their larynx muscles', label: 'cat' },
    { input: 'why do kittens knead', output: 'kittens knead soft surfaces as a comfort instinct', label: 'cat' },
    { input: 'what is a mortgage rate', output: 'a mortgage rate is the interest charged on a home loan', label: 'finance' },
    { input: 'explain compound interest', output: 'compound interest accrues on principal plus prior interest', label: 'finance' },
  ];
  const val_pairs = [
    { input: 'do cats meow at humans', output: 'adult cats meow mainly to communicate with humans', label: 'cat' },
    { input: 'are cats nocturnal', output: 'cats are crepuscular, most active at dawn and dusk', label: 'cat' },
  ];
  return { pairs, val_pairs };
}

// -- (0) version + shape -------------------------------------------------------

test('version constant + envelope shape', () => {
  assert.equal(DATA_SHAPLEY_VERSION, 'shapley-v1');
  const { pairs, val_pairs } = catFinanceCorpus();
  const r = valuePairsByShapley({ pairs, val_pairs });
  assert.equal(r.ok, true);
  assert.equal(r.version, 'shapley-v1');
  assert.equal(r.method, 'knn');
  assert.equal(r.values.length, pairs.length);
  assert.equal(r.n, pairs.length);
  assert.equal(r.n_val, val_pairs.length);
  assert.ok(Array.isArray(r.harmful_indices));
  assert.ok(r.convergence && typeof r.convergence === 'object');
});

// -- (1) closed form == brute-force EXACT Shapley (the correctness pin) --------

test('KNN-Shapley closed form matches brute-force exact Shapley', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const K = 2;
  const r = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K });
  const brute = _bruteForceKnnShapley(pairs, val_pairs, K);
  assert.equal(r.values.length, brute.length);
  for (let i = 0; i < brute.length; i++) {
    assert.ok(
      Math.abs(r.values[i] - brute[i]) < 1e-6,
      `pair ${i}: closed-form ${r.values[i]} vs brute ${brute[i]}`,
    );
  }
});

test('closed form matches brute force at K=1 and K=3 too', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  for (const K of [1, 3]) {
    const r = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K });
    const brute = _bruteForceKnnShapley(pairs, val_pairs, K);
    for (let i = 0; i < brute.length; i++) {
      assert.ok(Math.abs(r.values[i] - brute[i]) < 1e-6, `K=${K} pair ${i}`);
    }
  }
});

// -- (2) signed values + harmful detection -------------------------------------

test('aligned pairs get positive value; off-target pairs get <= 0 and are flagged harmful', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const r = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2 });
  // cat pairs (idx 0,1) are aligned with the all-cat val set -> positive value.
  assert.ok(r.values[0] > 0, `cat pair 0 value ${r.values[0]} should be > 0`);
  assert.ok(r.values[1] > 0, `cat pair 1 value ${r.values[1]} should be > 0`);
  // finance pairs (idx 2,3) are off-target -> value <= 0, flagged harmful.
  assert.ok(r.values[2] <= 0, `finance pair 2 value ${r.values[2]} should be <= 0`);
  assert.ok(r.values[3] <= 0, `finance pair 3 value ${r.values[3]} should be <= 0`);
  assert.ok(r.harmful_indices.includes(2));
  assert.ok(r.harmful_indices.includes(3));
  assert.ok(!r.harmful_indices.includes(0));
  assert.equal(r.harmful_count, r.harmful_indices.length);
});

test('a MISLABELED neighbor of the val set is actively harmful (negative value)', () => {
  // A pair that looks/embeds like a cat query but carries the WRONG label will
  // pull KNN votes the wrong way for cat val points -> negative Shapley value.
  const pairs = [
    { input: 'how do cats purr', output: 'cats purr via laryngeal vibration', label: 'cat' },
    { input: 'why do kittens knead', output: 'kittens knead for comfort', label: 'cat' },
    // mislabeled: cat-shaped query, labeled finance.
    { input: 'do cats like to sleep a lot', output: 'cats sleep 12-16 hours a day', label: 'finance' },
  ];
  const val_pairs = [
    { input: 'are cats playful', output: 'cats play to practice hunting', label: 'cat' },
    { input: 'do cats purr when happy', output: 'cats often purr when content', label: 'cat' },
  ];
  const r = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2 });
  assert.ok(r.values[2] < 0, `mislabeled near-neighbor value ${r.values[2]} should be < 0`);
  assert.ok(r.harmful_indices.includes(2));
});

test('harmfulThreshold is configurable', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const strict = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2, harmfulThreshold: 0.05 });
  const lax = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2, harmfulThreshold: -1 });
  // strict threshold flags at least as many as the default-0 lax-ish threshold.
  assert.ok(strict.harmful_indices.length >= lax.harmful_indices.length);
  // a threshold of -1 should flag nothing here (all values > -1).
  assert.equal(lax.harmful_indices.length, 0);
});

// -- (3) determinism -----------------------------------------------------------

test('identical inputs + seed => byte-identical values (knn and mc)', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const a = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2 });
  const b = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2 });
  assert.deepEqual(a.values, b.values);

  const m1 = valuePairsByShapley({ pairs, val_pairs, method: 'mc', K: 2, seed: 'fixed-seed', maxPermutations: 60 });
  const m2 = valuePairsByShapley({ pairs, val_pairs, method: 'mc', K: 2, seed: 'fixed-seed', maxPermutations: 60 });
  assert.deepEqual(m1.values, m2.values);
  assert.deepEqual(m1.harmful_indices, m2.harmful_indices);
});

test('different seeds can produce different MC permutation traces', () => {
  // Use a corpus large enough that MC is not forced to converge instantly, so
  // the seed actually changes the permutation order / eval count.
  const pairs = [];
  for (let i = 0; i < 8; i++) {
    pairs.push({ input: 'cat question number ' + i + ' about felines', output: 'cats are great ' + i, label: 'cat' });
    pairs.push({ input: 'finance question number ' + i + ' on loans', output: 'rates vary ' + i, label: 'finance' });
  }
  const val_pairs = [{ input: 'tell me about cats and kittens', output: 'cats are mammals', label: 'cat' }];
  const s1 = valuePairsByShapley({ pairs, val_pairs, method: 'mc', K: 3, seed: 'aaa', maxPermutations: 12, minPermutations: 12, convergenceTol: 1e-9 });
  const s2 = valuePairsByShapley({ pairs, val_pairs, method: 'mc', K: 3, seed: 'zzz', maxPermutations: 12, minPermutations: 12, convergenceTol: 1e-9 });
  // not asserting inequality of every value (could coincide), but the eval
  // traces should differ for different permutation seeds.
  assert.notDeepEqual(
    [s1.convergence.utility_evals, s1.values],
    [s2.convergence.utility_evals, s2.values],
  );
});

// -- (4) Truncated Monte-Carlo: converges + correlates + truncates -------------

test('TMC-Shapley converges and ranks aligned > off-target like the exact KNN', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const r = valuePairsByShapley({
    pairs, val_pairs, method: 'mc', K: 2, seed: 'mc-seed',
    minPermutations: 8, maxPermutations: 400, convergenceTol: 0.08, convergenceWindow: 3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'mc');
  assert.equal(r.convergence.converged, true);
  assert.ok(r.convergence.permutations >= 8);
  assert.ok(r.convergence.permutations <= 400);
  // ranking agreement with exact KNN: cat pairs outrank finance pairs.
  const minCat = Math.min(r.values[0], r.values[1]);
  const maxFin = Math.max(r.values[2], r.values[3]);
  assert.ok(minCat > maxFin, `cat min ${minCat} should exceed finance max ${maxFin}`);
  // off-target pairs still flagged harmful by MC.
  assert.ok(r.harmful_indices.includes(2) && r.harmful_indices.includes(3));
});

test('performance truncation fires (truncated_steps > 0) on a saturating utility', () => {
  // A corpus where a few pairs saturate the KNN utility quickly => later
  // marginals ~0 => truncation should skip steps.
  const pairs = [];
  for (let i = 0; i < 10; i++) pairs.push({ input: 'cat topic ' + i, output: 'felines ' + i, label: 'cat' });
  const val_pairs = [{ input: 'cats question', output: 'about cats', label: 'cat' }];
  const r = valuePairsByShapley({
    pairs, val_pairs, method: 'mc', K: 1, seed: 's', minPermutations: 4,
    maxPermutations: 50, truncationTol: 1e-6,
  });
  assert.equal(r.ok, true);
  assert.ok(r.convergence.truncated_steps > 0, 'expected truncation to skip some marginal evals');
  assert.ok(r.convergence.utility_evals > 0);
});

// -- (5) auto degrade to KNN when MC cannot converge ---------------------------

test("method:'auto' degrades to exact KNN-Shapley when MC is starved", () => {
  // Force non-convergence: tiny maxPermutations + impossibly tight tol so the
  // running mean cannot stabilize, with a corpus big enough to keep changing.
  const pairs = [];
  for (let i = 0; i < 12; i++) {
    pairs.push({ input: 'distinct cat query ' + i + ' lorem ipsum ' + i, output: 'cat ans ' + i, label: 'cat' });
  }
  pairs.push({ input: 'mortgage interest amortization schedule', output: 'finance', label: 'finance' });
  const val_pairs = [{ input: 'cats and kittens behavior', output: 'cats', label: 'cat' }];

  const auto = valuePairsByShapley({
    pairs, val_pairs, method: 'auto', K: 3, seed: 'd',
    minPermutations: 2, maxPermutations: 2, convergenceTol: 1e-9, convergenceWindow: 3,
  });
  assert.equal(auto.ok, true);
  assert.equal(auto.convergence.converged, false);
  assert.equal(auto.method, 'knn (mc-degraded)');
  assert.equal(auto.convergence.degraded_to, 'knn');
  // degraded values must EQUAL the pure-KNN result (it is the same closed form).
  const knn = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 3 });
  assert.deepEqual(auto.values, knn.values);
});

test("method:'mc' (explicit) returns a non-converged estimate labeled as such", () => {
  const pairs = [];
  for (let i = 0; i < 10; i++) pairs.push({ input: 'topic ' + i + ' unique text ' + i, output: 'o' + i, label: i % 2 ? 'a' : 'b' });
  const val_pairs = [{ input: 'topic 0 unique text 0', output: 'x', label: 'b' }];
  const r = valuePairsByShapley({ pairs, val_pairs, method: 'mc', minPermutations: 2, maxPermutations: 2, convergenceTol: 1e-12 });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'mc (not-converged)');
  assert.equal(r.convergence.converged, false);
});

// -- (6) envelope never throws -------------------------------------------------

test('empty pairs => ok with empty values, no throw', () => {
  const r = valuePairsByShapley({ pairs: [], val_pairs: [{ input: 'x', output: 'y', label: 'cat' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, []);
  assert.deepEqual(r.harmful_indices, []);
  assert.equal(r.method, 'none');
});

test('empty validation set => zeros, recorded reason, no throw', () => {
  const { pairs } = catFinanceCorpus();
  const r = valuePairsByShapley({ pairs, val_pairs: [] });
  assert.equal(r.ok, true);
  assert.equal(r.values.length, pairs.length);
  assert.ok(r.values.every((v) => v === 0));
  assert.equal(r.convergence.reason, 'no_validation_pairs');
});

test('garbage / missing-arg inputs never throw', () => {
  const cases = [
    {},
    { pairs: null, val_pairs: null },
    { pairs: [null, 42, 'str', { input: 'ok', output: 'fine', label: 'a' }], val_pairs: [{ input: 'q', output: 'r', label: 'a' }] },
    { pairs: [{}], val_pairs: [{}] },
  ];
  for (const c of cases) {
    const r = valuePairsByShapley(c);
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(r.version, 'shapley-v1');
    assert.ok(Array.isArray(r.values));
    assert.ok(Array.isArray(r.harmful_indices));
  }
  // calling with NO argument at all must also not throw.
  const r0 = valuePairsByShapley();
  assert.equal(r0.ok, true);
});

// -- (7) injected utility proxy honored by MC ----------------------------------

test('injected utility proxy drives MC marginals', () => {
  // Utility that rewards including index 0 only (a deterministic toy proxy
  // standing in for the data-quality-classifier head reading a coalition).
  const pairs = [
    { input: 'a', output: 'a', label: 'x' },
    { input: 'b', output: 'b', label: 'x' },
    { input: 'c', output: 'c', label: 'x' },
  ];
  const val_pairs = [{ input: 'q', output: 'q', label: 'x' }];
  const utility = (set) => (set.has(0) ? 1 : 0); // only pair 0 has value
  const r = valuePairsByShapley({
    pairs, val_pairs, method: 'mc', utility, seed: 'u',
    minPermutations: 6, maxPermutations: 100, convergenceTol: 0.05,
  });
  assert.equal(r.ok, true);
  // pair 0 should carry essentially ALL the value; 1 and 2 ~ 0.
  assert.ok(r.values[0] > 0.8, `pair0 value ${r.values[0]}`);
  assert.ok(Math.abs(r.values[1]) < 1e-6 && Math.abs(r.values[2]) < 1e-6);
});

// -- (8) curate-integration surface: harmful_indices drives a drop/flag stage --

test('harmful_indices supports a deterministic optional DROP stage', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const r = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2 });
  // Simulate the curate "drop harmful" stage a caller would wire in.
  const drop = new Set(r.harmful_indices);
  const kept = pairs.filter((_, i) => !drop.has(i));
  assert.equal(kept.length, pairs.length - r.harmful_indices.length);
  // the surviving set must be exactly the aligned (cat) pairs.
  assert.ok(kept.every((p) => p.label === 'cat'));
  assert.equal(kept.length, 2);
});

test('harmful_indices supports a FLAG (non-drop) stage by stamping the pairs', () => {
  const { pairs, val_pairs } = catFinanceCorpus();
  const r = valuePairsByShapley({ pairs, val_pairs, method: 'knn', K: 2 });
  const flagged = new Set(r.harmful_indices);
  const stamped = pairs.map((p, i) => Object.assign({}, p, {
    shapley_value: r.values[i],
    shapley_harmful: flagged.has(i),
  }));
  // every pair carries its value; only off-target pairs are flagged.
  assert.ok(stamped.every((p) => typeof p.shapley_value === 'number'));
  assert.equal(stamped.filter((p) => p.shapley_harmful).length, r.harmful_indices.length);
  assert.equal(stamped[0].shapley_harmful, false);
  assert.equal(stamped[2].shapley_harmful, true);
});
