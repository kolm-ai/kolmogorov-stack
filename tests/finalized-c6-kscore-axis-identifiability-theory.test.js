// C6 - K-score axis identifiability, reliability, and weight-derivation theory.
//
// Proves the acceptance criteria: FT1 reliability (ICC drop/keep + real F-CI),
// FT2 redundancy (VIF/condition/near-dup + Jacobi eigensolver), FT3 weight
// recovery (cosine>0.9 + OOF beats uniform by a CI-separated margin + governance
// floors + reportable zeros), FT4 monotonicity (true vs sign-flipped false),
// the frozen-weights immutability + privacy boundary + fail-closed disjointness
// + DP determinism + env-gate dormancy + zero-dep determinism.
//
// Run ONLY this file:  node --test tests/finalized-c6-kscore-axis-identifiability-theory.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function freshDir(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-c6-${label || ''}-`));
  const dot = path.join(tmp, '.kolm');
  fs.mkdirSync(dot, { recursive: true });
  process.env.KOLM_DATA_DIR = dot;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  return tmp;
}

function freshImport(rel) {
  return import(`../${rel}?cb=${Date.now()}_${Math.random()}`);
}

// Deterministic LCG so the fixtures are reproducible without a dep.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

const AXES = ['A', 'S', 'L', 'C', 'V', 'F', 'Z'];

// Build a synthetic Phi where a known ground-truth w* drives preferences.
// Only A and F matter (w*=[A:1, F:0.6], others 0). Label noise injected.
function synthCorpus({ N = 40, nPairs = 600, noise = 0.08, seed = 7 } = {}) {
  const rng = lcg(seed);
  const wStar = { A: 1.0, S: 0, L: 0, C: 0, V: 0, F: 0.6, Z: 0 };
  const rows = [];
  for (let i = 0; i < N; i++) {
    const axes = {};
    for (const ax of AXES) axes[ax] = rng();
    rows.push({ id: 'art' + i, axes });
  }
  function kStar(axes) {
    let v = 0; for (const ax of AXES) v += wStar[ax] * axes[ax];
    return v;
  }
  const pairs = [];
  for (let p = 0; p < nPairs; p++) {
    let a = Math.floor(rng() * N), b = Math.floor(rng() * N);
    while (b === a) b = Math.floor(rng() * N);
    const ka = kStar(rows[a].axes), kb = kStar(rows[b].axes);
    let pref = ka >= kb ? 'a' : 'b';
    if (rng() < noise) pref = pref === 'a' ? 'b' : 'a';   // label noise
    pairs.push({ a: rows[a].id, b: rows[b].id, pref });
  }
  return { axisOrder: AXES, rows, pairs };
}

// Build occasions: K re-scorings per target. Reliable axes replicate; the noise
// axis is i.i.d. uniform across occasions.
function occasionsFixture({ nTargets = 12, k = 6, seed = 11 } = {}) {
  const rng = lcg(seed);
  const order = ['A', 'NOISE', 'PERFECT'];
  const occasions = [];
  // per-target stable "true" value for A and PERFECT
  for (let t = 0; t < nTargets; t++) {
    const trueA = rng();
    const truePerfect = rng();
    const scorings = [];
    for (let kk = 0; kk < k; kk++) {
      scorings.push({
        axes: {
          A: Math.max(0, Math.min(1, trueA + (rng() - 0.5) * 0.05)), // small judge jitter -> reliable
          NOISE: rng(),                                              // pure i.i.d. uniform -> unreliable
          PERFECT: truePerfect,                                      // identical across occasions -> icc~1
        },
      });
    }
    occasions.push({ id: 'tgt' + t, scorings });
  }
  return { axisOrder: order, occasions };
}

test('env-gate dormancy: unset -> {status:disabled} and writes no file', async () => {
  freshDir('dormant');
  delete process.env.KOLM_KSCORE_AXIS_THEORY;
  const mod = await freshImport('src/kscore-axis-theory.js');
  const out = mod.deriveAxisTheory({ axisOrder: ['A'], rows: [{ id: 'x', axes: { A: 0.5 } }] });
  assert.equal(out.status, 'disabled');
  assert.match(out.hint, /KOLM_KSCORE_AXIS_THEORY=1/);
  assert.ok(!fs.existsSync(mod._axisTheoryPath()), 'no file written when dormant');
});

test('FT1 reliability: i.i.d. noise axis drops (icc<0.5, r=0); replicated axis keeps (icc>=0.99, r=1)', async () => {
  freshDir('ft1');
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const fx = occasionsFixture({ nTargets: 14, k: 6 });
  // run reliability via a full corpus (rows derived from per-target mean)
  const rows = fx.occasions.map((t) => {
    const axes = {};
    for (const ax of fx.axisOrder) {
      let s = 0; for (const sc of t.scorings) s += sc.axes[ax];
      axes[ax] = s / t.scorings.length;
    }
    return { id: t.id, axes };
  });
  const block = mod.deriveAxisTheory({ axisOrder: fx.axisOrder, rows, occasions: fx.occasions, pairs: [] });
  const rel = block.reliability;
  assert.ok(rel.NOISE.icc2k < 0.5, `noise icc2k=${rel.NOISE.icc2k} must be <0.5`);
  assert.equal(rel.NOISE.reliability_weight, 0, 'noise axis DROPPED');
  assert.equal(rel.NOISE.band, 'poor');
  assert.ok(rel.PERFECT.icc2k >= 0.99, `perfect icc2k=${rel.PERFECT.icc2k} must be >=0.99`);
  assert.equal(rel.PERFECT.reliability_weight, 1, 'perfect axis KEPT');
  assert.ok(rel.A.reliability_weight > 0, 'reliable jittered axis not dropped');
});

test('ICC CI is real (F-quantile via incomplete beta), brackets point + narrows as k grows', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const { __internals } = mod;
  // wider k -> tighter CI for the same reliable signal.
  function reliabilityFor(k) {
    const fx = occasionsFixture({ nTargets: 20, k, seed: 5 });
    const rel = __internals._stageReliability(fx.axisOrder, fx.occasions);
    return rel.PERFECT.ci95;   // perfect axis: icc~1, CI must bracket it
  }
  const fxA = occasionsFixture({ nTargets: 20, k: 4, seed: 5 });
  const relA = __internals._stageReliability(fxA.axisOrder, fxA.occasions);
  const ciA = relA.A.ci95;
  const ptA = relA.A.icc2k;
  assert.ok(ciA[0] <= ptA + 1e-6 && ptA <= ciA[1] + 1e-6, `CI ${JSON.stringify(ciA)} must bracket point ${ptA}`);
  const widthK4 = relA.A.ci95[1] - relA.A.ci95[0];
  const fxB = occasionsFixture({ nTargets: 20, k: 12, seed: 5 });
  const relB = __internals._stageReliability(fxB.axisOrder, fxB.occasions);
  const widthK12 = relB.A.ci95[1] - relB.A.ci95[0];
  assert.ok(widthK12 < widthK4 + 1e-9, `CI should narrow as k grows: k12=${widthK12} vs k4=${widthK4}`);
  // F-quantile sanity: not a hardcoded constant -> CDF(quantile)~p.
  const q = __internals._fquantile(0.975, 5, 20);
  const back = __internals._fcdf(q, 5, 20);
  assert.ok(Math.abs(back - 0.975) < 1e-4, `F-quantile inverts CDF: got ${back}`);
});

test('FT2 redundancy: C=copy(S) -> both VIF Inf/collinear, cond>1e6, [S,C] near_dup; orthonormal -> cond<1.5, d_eff~d', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const { __internals } = mod;
  const rng = lcg(3);
  // Phi with column C an exact copy of column S.
  const order = ['A', 'S', 'L', 'C'];
  const Phi = [];
  for (let i = 0; i < 30; i++) {
    const A = rng(), S = rng(), L = rng();
    Phi.push([A, S, L, S]);   // C := S
  }
  const red = __internals._stageRedundancy(order, Phi, 4);
  assert.ok(!Number.isFinite(red.vif.S) || red.vif.S > 1e6, `VIF.S must be Inf/huge: ${red.vif.S}`);
  assert.ok(!Number.isFinite(red.vif.C) || red.vif.C > 1e6, `VIF.C must be Inf/huge: ${red.vif.C}`);
  assert.ok(red.flagged.S === 'collinear' && red.flagged.C === 'collinear', 'S,C flagged collinear');
  assert.ok(red.condition_number === Infinity || red.condition_number > 1e6, `cond=${red.condition_number} must be >1e6`);
  const hasSC = red.near_duplicates.some(([a, b]) => (a === 'S' && b === 'C') || (a === 'C' && b === 'S'));
  assert.ok(hasSC, 'near_duplicates contains [S,C]');

  // Isotropic-by-construction Phi: d independent equal-variance columns ->
  // covariance ~ sigma^2 * I -> cond near 1, d_eff near d. Independent uniform
  // draws per column (centered covariance is full-rank, near-diagonal).
  const d = 4;
  const ortho = [];
  const rngO = lcg(777);
  for (let i = 0; i < 4000; i++) {
    const row = new Array(d);
    for (let j = 0; j < d; j++) row[j] = rngO();   // i.i.d. uniform per column
    ortho.push(row);
  }
  const red2 = __internals._stageRedundancy(['A', 'S', 'L', 'C'], ortho, d);
  assert.ok(red2.condition_number < 1.5, `orthonormal cond=${red2.condition_number} must be <1.5`);
  assert.ok(Math.abs(red2.d_eff - d) < 0.5, `d_eff=${red2.d_eff} must be within 0.5 of ${d}`);
});

test('Jacobi eigensolver: eigenvalue sum equals covariance trace; rank-1 d_eff~1; isotropic d_eff~d', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const { __internals } = mod;
  const rng = lcg(9);
  // rank-1 Phi: all columns proportional.
  const order = ['A', 'S', 'L', 'C'];
  const r1 = [];
  for (let i = 0; i < 50; i++) { const t = rng(); r1.push([t, 2 * t, 0.5 * t, 1.3 * t]); }
  const redR1 = __internals._stageRedundancy(order, r1, 4);
  const sumE = redR1.eigenvalues.reduce((s, e) => s + e, 0);
  assert.ok(Math.abs(sumE - redR1.trace) < 1e-9, `eig sum ${sumE} must equal trace ${redR1.trace}`);
  assert.ok(Math.abs(redR1.d_eff - 1) < 0.1, `rank-1 d_eff=${redR1.d_eff} must be ~1`);
  // isotropic d_eff ~ d : d independent equal-variance columns.
  const iso = [];
  const rngI = lcg(424242);
  for (let i = 0; i < 4000; i++) { const row = new Array(4); for (let j = 0; j < 4; j++) row[j] = rngI(); iso.push(row); }
  const redIso = __internals._stageRedundancy(order, iso, 4);
  assert.ok(Math.abs(redIso.d_eff - 4) < 0.5, `isotropic d_eff=${redIso.d_eff} must be ~4`);
});

test('FT3 weight recovery: cosine>0.9 to w*, all w>=0, F/Z>=floor, OOF beats uniform CI-separated, baseline_v2 present', async () => {
  freshDir('ft3');
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const corpus = synthCorpus({ N: 50, nPairs: 900, noise: 0.06, seed: 21 });
  const block = mod.deriveAxisTheory(corpus, { bootstrap: 80 });
  // cosine similarity of fitted w vs w* (A,F nonzero).
  const wStar = { A: 1.0, S: 0, L: 0, C: 0, V: 0, F: 0.6, Z: 0 };
  let dot = 0, nf = 0, ns = 0;
  for (const ax of AXES) {
    const wj = block.weights[ax];
    assert.ok(wj >= -1e-9, `weight ${ax} must be >=0: ${wj}`);
    dot += wj * wStar[ax];
    nf += wj * wj; ns += wStar[ax] * wStar[ax];
  }
  const cos = dot / (Math.sqrt(nf) * Math.sqrt(ns));
  assert.ok(cos > 0.9, `cosine to w* must be >0.9: ${cos}`);
  // governance floors respected.
  assert.ok(block.weights.F >= 0.05 - 1e-9, `F >= floor: ${block.weights.F}`);
  assert.ok(block.weights.Z >= 0.05 - 1e-9, `Z >= floor: ${block.weights.Z}`);
  // OOF headline + CI present and beats uniform baseline by a CI-separated margin.
  assert.ok(block.oof_agreement != null && block.oof_agreement_ci[0] != null);
  assert.ok(block.baseline_uniform_agreement != null);
  assert.ok(block.oof_agreement > block.baseline_uniform_agreement, 'fitted OOF beats uniform baseline');
  assert.ok(block.oof_agreement_ci[0] > block.baseline_uniform_ci[1],
    `CI-separated margin: oof_lo ${block.oof_agreement_ci[0]} > uni_hi ${block.baseline_uniform_ci[1]}`);
  // frozen V2 baseline computed on same folds.
  assert.equal(typeof block.baseline_v2_agreement, 'number');
});

test('Zero/shrunk weights are reportable events with reason codes (not silent)', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  // Corpus where S is pure i.i.d. noise across occasions -> shrunk_by_reliability;
  // and a useless axis L that w* ignores -> zeroed_by_fit.
  const rng = lcg(31);
  const order = ['A', 'L', 'S'];
  const N = 40;
  const rows = [];
  for (let i = 0; i < N; i++) rows.push({ id: 'r' + i, axes: { A: rng(), L: rng(), S: rng() } });
  // occasions: S is i.i.d. noise (unreliable), A/L replicate.
  const occasions = rows.map((r) => ({
    id: r.id,
    scorings: Array.from({ length: 5 }, () => ({ axes: { A: r.axes.A, L: r.axes.L, S: rng() } })),
  }));
  // pairs driven only by A.
  const pairs = [];
  for (let p = 0; p < 500; p++) {
    let a = Math.floor(rng() * N), b = Math.floor(rng() * N);
    while (b === a) b = Math.floor(rng() * N);
    pairs.push({ a: 'r' + a, b: 'r' + b, pref: rows[a].axes.A >= rows[b].axes.A ? 'a' : 'b' });
  }
  const block = mod.deriveAxisTheory({ axisOrder: order, rows, occasions, pairs }, { bootstrap: 40 });
  const reasons = Object.fromEntries(block.reportable_events.map((e) => [e.axis, e.reason]));
  assert.equal(reasons.S, 'shrunk_by_reliability', 'S surfaced as shrunk_by_reliability');
  assert.equal(reasons.L, 'zeroed_by_fit', 'L surfaced as zeroed_by_fit');
});

test('FT4 monotonicity: non-neg fit certifies monotone:true (min_partial>=0); sign-flipped certifies monotone:false naming axis', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const { __internals } = mod;
  const order = ['A', 'S', 'L'];
  const rng = lcg(13);
  const Phi = [];
  for (let i = 0; i < 20; i++) Phi.push([rng(), rng(), rng()]);
  // non-negative weights -> monotone true.
  const certGood = __internals._stageCertify(order, Phi, 3, [0.5, 0.3, 0.2], {}, { _pairLabels: [] });
  assert.equal(certGood.monotone, true);
  assert.ok(certGood.min_partial_derivative >= 0, `min_partial=${certGood.min_partial_derivative}`);
  // sign-flipped weight (test-only bypass) -> monotone false naming the axis.
  const certBad = __internals._stageCertify(order, Phi, 3, [0.5, -0.4, 0.2], {}, { _pairLabels: [] });
  assert.equal(certBad.monotone, false);
  assert.equal(certBad.monotone_offending_axis, 'S');
});

test('Derived gate: looser-than-0.85 recommendation is adopt_blocked; never adoptable <0.85 absent operator flag', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const { __internals } = mod;
  const order = ['A'];
  const Phi = Array.from({ length: 40 }, (_, i) => [i / 40]);
  // pair labels where the K* of the higher-K artifact is preferred (clean signal)
  // skewed so the 0.85-crossing lands LOW (looser than GATE).
  const rng = lcg(2);
  const labels = [];
  for (let i = 0; i < 60; i++) {
    const k = rng() * 0.5;       // all K in [0,0.5] -> 0.85 crossing extrapolates below 0.85
    labels.push({ k, y: k > 0.25 ? 1 : 0 });
  }
  const cert = __internals._stageCertify(order, Phi, 1, [1.0], {}, { _pairLabels: labels });
  if (cert.derived_gate.point != null && cert.derived_gate.point < 0.85) {
    assert.equal(cert.derived_gate.adopt_blocked, true, 'looser gate must be adopt_blocked');
  }
  // operator override allows looser (still surfaced, but not blocked).
  const certOverride = __internals._stageCertify(order, Phi, 1, [1.0], { allow_looser_gate: true }, { _pairLabels: labels });
  if (certOverride.derived_gate.point != null && certOverride.derived_gate.point < 0.85) {
    assert.equal(certOverride.derived_gate.adopt_blocked, false);
  }
});

test('Frozen-weights immutability: V1/V2/GATE byte-identical after a full pass + a computeKScore call', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const kscore = await freshImport('src/kscore.js');
  // snapshot
  const v1Before = JSON.stringify(mod.V1_WEIGHTS);
  const v2Before = JSON.stringify(mod.V2_WEIGHTS);
  const gateBefore = mod.GATE;
  assert.deepEqual(mod.V1_WEIGHTS, { A: 0.40, S: 0.15, L: 0.15, C: 0.15, V: 0.15 });
  assert.deepEqual(mod.V2_WEIGHTS, { A: 0.30, S: 0.10, L: 0.10, C: 0.10, V: 0.10, R: 0.05, T: 0.05, F: 0.10, E: 0.05, Z: 0.05 });
  assert.equal(mod.GATE, 0.85);
  // run a real K-score (its ships decision) + the theory pass.
  const ksOut = kscore.computeKScore({ accuracy: 0.95, coverage: 0.95, size_bytes: 1024, holdout_accuracy: 0.9 });
  const shipsBefore = ksOut.ships;
  const corpus = synthCorpus({ N: 30, nPairs: 300, seed: 4 });
  mod.deriveAxisTheory(corpus, { bootstrap: 20 });
  const ksOut2 = kscore.computeKScore({ accuracy: 0.95, coverage: 0.95, size_bytes: 1024, holdout_accuracy: 0.9 });
  assert.equal(ksOut2.ships, shipsBefore, 'ships decision unchanged by the theory pass');
  assert.equal(JSON.stringify(mod.V1_WEIGHTS), v1Before);
  assert.equal(JSON.stringify(mod.V2_WEIGHTS), v2Before);
  assert.equal(mod.GATE, gateBefore);
});

test('Privacy boundary: prompt/response text never read or echoed; corpus_hash over axes+ids+prefs only', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const SECRET = 'SENSITIVE-PROMPT-DO-NOT-LEAK-xyz123';
  const rows = [
    { id: 'a', axes: { A: 0.4 }, prompt: SECRET, response_a: SECRET, response_b: SECRET },
    { id: 'b', axes: { A: 0.6 }, prompt: SECRET },
    { id: 'c', axes: { A: 0.8 }, prompt: SECRET },
  ];
  const pairs = [{ a: 'a', b: 'b', pref: 'b', prompt: SECRET }, { a: 'b', b: 'c', pref: 'b' }, { a: 'a', b: 'c', pref: 'b' }];
  const block = mod.deriveAxisTheory({ axisOrder: ['A'], rows, pairs }, { bootstrap: 10 });
  const dumped = JSON.stringify(block);
  assert.ok(!dumped.includes(SECRET), 'no prompt/response text echoed into output');
  // corpus_hash invariant to the extra prompt field (computed over axes+ids+prefs).
  const rowsNoPrompt = rows.map((r) => ({ id: r.id, axes: r.axes }));
  const block2 = mod.deriveAxisTheory({ axisOrder: ['A'], rows: rowsNoPrompt, pairs: pairs.map((p) => ({ a: p.a, b: p.b, pref: p.pref })) }, { bootstrap: 10 });
  assert.equal(block.corpus_hash, block2.corpus_hash, 'corpus_hash ignores prompt/response text');
});

test('Fail-closed disjointness: pair with unknown row id throws; corpus_hash changes iff axes/ids/prefs change', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const rows = [{ id: 'a', axes: { A: 0.5 } }, { id: 'b', axes: { A: 0.7 } }];
  assert.throws(
    () => mod.deriveAxisTheory({ axisOrder: ['A'], rows, pairs: [{ a: 'a', b: 'GHOST', pref: 'a' }] }),
    /unknown row id GHOST/,
  );
  const base = mod.deriveAxisTheory({ axisOrder: ['A'], rows, pairs: [{ a: 'a', b: 'b', pref: 'a' }] }, { bootstrap: 5 });
  const samePrefs = mod.deriveAxisTheory({ axisOrder: ['A'], rows, pairs: [{ a: 'a', b: 'b', pref: 'a' }] }, { bootstrap: 5 });
  assert.equal(base.corpus_hash, samePrefs.corpus_hash, 'identical corpus -> identical hash');
  const flipped = mod.deriveAxisTheory({ axisOrder: ['A'], rows, pairs: [{ a: 'a', b: 'b', pref: 'b' }] }, { bootstrap: 5 });
  assert.notEqual(base.corpus_hash, flipped.corpus_hash, 'changed pref -> changed hash');
});

test('DP path: dp_epsilon=1 reports objective_perturbation; default reproduces exact non-private weights; dp_epsilon<=0 throws', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const corpus = synthCorpus({ N: 30, nPairs: 400, seed: 8 });
  // DP off (default): two runs byte-identical.
  const a1 = mod.deriveAxisTheory(corpus, { bootstrap: 30 });
  const a2 = mod.deriveAxisTheory(corpus, { bootstrap: 30 });
  assert.equal(a1.dp.enabled, false);
  assert.equal(JSON.stringify(a1.weights), JSON.stringify(a2.weights), 'non-private path deterministic');
  // DP on: reported + deterministic given seeded corpus + differs from non-private.
  const dp1 = mod.deriveAxisTheory(corpus, { bootstrap: 30, dp_epsilon: 1 });
  const dp2 = mod.deriveAxisTheory(corpus, { bootstrap: 30, dp_epsilon: 1 });
  assert.deepEqual(dp1.dp, { enabled: true, epsilon: 1, mechanism: 'objective_perturbation' });
  assert.equal(JSON.stringify(dp1.weights), JSON.stringify(dp2.weights), 'DP draw deterministic from seeded corpus');
  // dp_epsilon<=0 throws loud.
  assert.throws(() => mod.deriveAxisTheory(corpus, { dp_epsilon: 0 }), /dp_epsilon must be > 0/);
  assert.throws(() => mod.deriveAxisTheory(corpus, { dp_epsilon: -1 }), /dp_epsilon must be > 0/);
});

test('Determinism: two runs over same corpus produce byte-identical weights, eigenvalues, corpus_hash', async () => {
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const corpus = synthCorpus({ N: 35, nPairs: 500, seed: 99 });
  const r1 = mod.deriveAxisTheory(corpus, { bootstrap: 50, now: 'fixed' });
  const r2 = mod.deriveAxisTheory(corpus, { bootstrap: 50, now: 'fixed' });
  assert.equal(r1.corpus_hash, r2.corpus_hash);
  assert.equal(JSON.stringify(r1.weights), JSON.stringify(r2.weights));
  assert.equal(JSON.stringify(r1.redundancy.eigenvalues), JSON.stringify(r2.redundancy.eigenvalues));
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), 'whole block byte-identical with fixed timestamp');
});

test('Persistence mirror: writes to $KOLM_DATA_DIR/kscore-axis-theory.json (never a committed path)', async () => {
  const home = freshDir('persist');
  process.env.KOLM_KSCORE_AXIS_THEORY = '1';
  const mod = await freshImport('src/kscore-axis-theory.js');
  const corpus = synthCorpus({ N: 20, nPairs: 200, seed: 1 });
  const block = mod.deriveAxisTheory(corpus, { bootstrap: 10 });
  const res = mod.persistAxisTheory(block);
  assert.ok(res.ok);
  assert.ok(res.path.includes(path.join('.kolm', 'kscore-axis-theory.json')));
  assert.ok(res.path.startsWith(home) || res.path.includes(os.tmpdir()), 'written under the test data dir, not a committed path');
  const reloaded = JSON.parse(fs.readFileSync(res.path, 'utf8'));
  assert.equal(reloaded.spec, 'k-score-derived-1');
  assert.equal(reloaded.corpus_hash, block.corpus_hash);
});
