// tests/finalized-c2-dp-training-dp-sgd-pate.test.js
//
// FINALIZED-C2 - Differential-privacy TRAINING path (DP-SGD / PATE) for
// distilled students. Pins the contract of src/dp-training.js:
//
//   - RDP / moments accountant emits a REAL (epsilon, delta) upper bound that
//     matches the published SGM reference within tolerance and is monotone in
//     the right directions (more noise -> less epsilon, more steps -> more).
//   - DP-SGD step primitive clips per-example gradients to the L2 bound and
//     injects calibrated Gaussian noise at the accounted scale.
//   - PATE partitioner is DISJOINT and residency-aware (never mixes regions
//     unless cross-region is explicitly opted in).
//   - PATE noisy-argmax aggregation + its RDP budget.
//   - privacy_budget block is stamped with epsilon/delta alongside
//     teacher_source for the .kolm manifest/receipt chain.
//   - zero-noise is a LOUD epsilon=Infinity, never a silent pass.
//   - ENV-GATED Opacus wiring fails loud with an install hint.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DP_TRAINING_VERSION,
  cryptoGaussian,
  sgmRdpAtOrder,
  computeDpSgdBudget,
  defaultRdpOrders,
  clipL2,
  dpSgdStep,
  partitionForPate,
  pateAggregate,
  pateBudget,
  buildPrivacyBudgetBlock,
  reconcileSpentBudget,
  buildDpTrainerEnv,
} from '../src/dp-training.js';

// ============================================================================
// 1) RDP / moments accountant - real (epsilon, delta) budget.
// ============================================================================

test('C2 #1 - accountant is a sound SGM bound near the published reference', () => {
  // Reference point: sigma=1.1, q=0.01, steps=1000, delta=1e-5. TF-Privacy /
  // Opacus (which additionally scan fractional Renyi orders) report epsilon
  // ~ 1.18-1.26. Our dense INTEGER-order binomial bound is a valid upper bound
  // and lands at ~1.7 - the same order of magnitude, and conservative by
  // construction (it can only OVER-report, never under-report, the spend).
  const b = computeDpSgdBudget({
    noise_multiplier: 1.1,
    sample_rate: 0.01,
    steps: 1000,
    delta: 1e-5,
  });
  assert.equal(b.dp_effective, true);
  assert.ok(Number.isFinite(b.epsilon), 'epsilon must be finite');
  assert.ok(b.epsilon > 1.0 && b.epsilon < 2.2,
    `epsilon ${b.epsilon} should be a conservative bound near the ~1.2 SGM reference`);
  assert.equal(b.delta, 1e-5);
  assert.ok(b.optimal_order >= 2, 'an optimal Renyi order was selected');
  assert.equal(b.accountant, 'rdp_moments_v1');
});

test('C2 #1b - accountant is a valid UPPER bound (composition sanity)', () => {
  // The composed epsilon over T steps must never EXCEED the trivial
  // single-step-times-T basic-composition bound at the same order; and the
  // per-step RDP times T equals the composed RDP (additivity) - the core
  // soundness property an auditor relies on.
  const q = 0.05, sigma = 1.0, T = 200, alpha = 16;
  const oneStep = sgmRdpAtOrder(q, sigma, alpha);
  const b = computeDpSgdBudget({ noise_multiplier: sigma, sample_rate: q, steps: T, delta: 1e-5, orders: [alpha] });
  // Re-derive eps from the additive RDP at this single order and confirm the
  // accountant used T * per-step RDP.
  const rdpTotal = oneStep * T;
  const expectedEps = rdpTotal + Math.log((alpha - 1) / alpha) - (Math.log(1e-5) + Math.log(alpha)) / (alpha - 1);
  assert.ok(Math.abs(b.epsilon - expectedEps) < 1e-9, 'composed eps = T*per-step RDP -> (eps,delta)');
});

test('C2 #2 - epsilon is monotone: more noise -> smaller epsilon', () => {
  const lowNoise = computeDpSgdBudget({ noise_multiplier: 0.7, sample_rate: 0.01, steps: 1000 });
  const hiNoise = computeDpSgdBudget({ noise_multiplier: 2.0, sample_rate: 0.01, steps: 1000 });
  assert.ok(hiNoise.epsilon < lowNoise.epsilon,
    `more noise must lower epsilon (${hiNoise.epsilon} < ${lowNoise.epsilon})`);
});

test('C2 #3 - epsilon is monotone: more steps -> larger epsilon', () => {
  const few = computeDpSgdBudget({ noise_multiplier: 1.1, sample_rate: 0.01, steps: 100 });
  const many = computeDpSgdBudget({ noise_multiplier: 1.1, sample_rate: 0.01, steps: 10000 });
  assert.ok(many.epsilon > few.epsilon,
    `more steps must raise epsilon (${many.epsilon} > ${few.epsilon})`);
});

test('C2 #4 - q=1 SGM reduces to plain Gaussian RDP closed form', () => {
  const sigma = 2.0;
  for (const alpha of [2, 8, 32]) {
    const rdp = sgmRdpAtOrder(1, sigma, alpha);
    const closed = alpha / (2 * sigma * sigma);
    assert.ok(Math.abs(rdp - closed) < 1e-9,
      `q=1 RDP at order ${alpha} must equal alpha/(2 sigma^2)`);
  }
});

test('C2 #5 - subsampling amplification: q<1 RDP < q=1 RDP at same sigma', () => {
  const sigma = 1.0;
  const alpha = 8;
  const sub = sgmRdpAtOrder(0.01, sigma, alpha);
  const full = sgmRdpAtOrder(1, sigma, alpha);
  assert.ok(sub < full, 'Poisson subsampling must amplify privacy (lower RDP)');
  assert.ok(sub > 0, 'a non-trivial subsampled step still spends some privacy');
});

test('C2 #6 - zero/negative noise is a LOUD epsilon=Infinity, never a silent pass', () => {
  const b0 = computeDpSgdBudget({ noise_multiplier: 0, sample_rate: 0.01, steps: 1000 });
  assert.equal(b0.epsilon, Infinity);
  assert.equal(b0.dp_effective, false);
  const bneg = computeDpSgdBudget({ noise_multiplier: -1, sample_rate: 0.01, steps: 1000 });
  assert.equal(bneg.epsilon, Infinity);
  assert.equal(bneg.dp_effective, false);
});

test('C2 #7 - accountant validates inputs', () => {
  assert.throws(() => computeDpSgdBudget({ noise_multiplier: 1, sample_rate: 2, steps: 10 }), /sample_rate/);
  assert.throws(() => computeDpSgdBudget({ noise_multiplier: 1, sample_rate: 0.1, steps: -1 }), /steps/);
  assert.throws(() => computeDpSgdBudget({ noise_multiplier: 1, sample_rate: 0.1, steps: 10, delta: 0 }), /delta/);
  assert.throws(() => computeDpSgdBudget({ noise_multiplier: 1, sample_rate: 0.1, steps: 10, delta: 1 }), /delta/);
});

test('C2 #8 - default Renyi order grid is the scanned set and is non-trivial', () => {
  const ord = defaultRdpOrders();
  assert.ok(ord.length > 60, 'a dense order grid is scanned');
  assert.ok(ord.every((a) => a >= 2), 'all orders >= 2 (RDP undefined at alpha=1)');
});

// ============================================================================
// 2) DP-SGD step primitive - clip + calibrated Gaussian noise.
// ============================================================================

test('C2 #9 - clipL2 bounds the gradient norm and flags when it clips', () => {
  const small = clipL2([0.1, 0.1], 1.0);
  assert.equal(small.clip_applied, false);
  const big = clipL2([3, 4], 1.0); // norm 5 -> clipped to 1
  assert.equal(big.clip_applied, true);
  const n = Math.sqrt(big.clipped[0] ** 2 + big.clipped[1] ** 2);
  assert.ok(Math.abs(n - 1.0) < 1e-9, 'clipped norm equals the bound');
});

test('C2 #10 - dpSgdStep clips every example and injects noise at the accounted scale', () => {
  // Two identical large gradients; with noise=0 the averaged update is the
  // clipped value (deterministic), proving the clip+sum+average math.
  const C = 1.0;
  const det = dpSgdStep({
    per_example_grads: [[3, 4], [3, 4]], // each norm 5 -> clipped to norm 1 => [0.6,0.8]
    l2_clip: C,
    noise_multiplier: 0,
  });
  assert.equal(det.dp_applied.examples_clipped, 2);
  assert.equal(det.dp_applied.dp_effective, false);
  assert.ok(Math.abs(det.grad[0] - 0.6) < 1e-9 && Math.abs(det.grad[1] - 0.8) < 1e-9,
    'zero-noise averaged update equals the clipped mean');

  // With noise on, the realized empirical std over many runs ~ sigma*C/lot.
  const sigma = 1.5;
  const lot = 4;
  const samples = [];
  for (let i = 0; i < 4000; i++) {
    const r = dpSgdStep({
      per_example_grads: [[0, 0], [0, 0], [0, 0], [0, 0]],
      l2_clip: C,
      noise_multiplier: sigma,
      lot_size: lot,
    });
    samples.push(r.grad[0]);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const empStd = Math.sqrt(variance);
  const expStd = (sigma * C) / lot; // noise added pre-average, divided by lot
  assert.ok(Math.abs(empStd - expStd) / expStd < 0.15,
    `realized noise std ${empStd} should be within 15% of accounted ${expStd}`);
});

test('C2 #11 - dpSgdStep validates shapes', () => {
  assert.throws(() => dpSgdStep({ per_example_grads: [], l2_clip: 1, noise_multiplier: 1 }), /non-empty/);
  assert.throws(() => dpSgdStep({ per_example_grads: [[1, 2], [1]], l2_clip: 1, noise_multiplier: 1 }), /equal length/);
  assert.throws(() => dpSgdStep({ per_example_grads: [[1]], l2_clip: 0, noise_multiplier: 1 }), /l2_clip/);
});

test('C2 #12 - cryptoGaussian is mean~0, std~1 (sanity on the CSPRNG sampler)', () => {
  const xs = [];
  for (let i = 0; i < 20000; i++) xs.push(cryptoGaussian());
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.05, `mean ${mean} ~ 0`);
  assert.ok(Math.abs(std - 1) < 0.05, `std ${std} ~ 1`);
});

// ============================================================================
// 3) PATE - disjoint, residency-aware partitioning + noisy-argmax.
// ============================================================================

test('C2 #13 - partitionForPate produces DISJOINT partitions covering all captures', () => {
  const captures = Array.from({ length: 50 }, (_, i) => ({ id: i, region: 'US_EAST' }));
  const { partitions, n_teachers, disjoint } = partitionForPate({ captures, n_teachers: 5 });
  assert.equal(disjoint, true);
  assert.equal(n_teachers, 5);
  const seen = new Set();
  let totalCount = 0;
  for (const p of partitions) {
    totalCount += p.captures.length;
    for (const c of p.captures) {
      assert.ok(!seen.has(c.id), `capture ${c.id} must appear in exactly one teacher`);
      seen.add(c.id);
    }
  }
  assert.equal(totalCount, 50, 'every capture is assigned exactly once');
  assert.equal(seen.size, 50);
});

test('C2 #14 - residency fence: no teacher mixes regions unless cross-region opted in', () => {
  const captures = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: 'eu' + i, region: 'EU_WEST' })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: 'us' + i, region: 'US_EAST' })),
  ];
  const res = partitionForPate({ captures, n_teachers: 6 });
  assert.equal(res.cross_region, false);
  // Every teacher must be single-region.
  for (const p of res.partitions) {
    const regions = new Set(p.captures.map((c) => c.region));
    assert.equal(regions.size, 1, `teacher ${p.teacher_id} must hold ONE region`);
    assert.equal([...regions][0], p.region);
  }
  // Both regions are represented (each got >=1 dedicated teacher).
  const teacherRegions = new Set(res.partitions.map((p) => p.region));
  assert.ok(teacherRegions.has('EU_WEST') && teacherRegions.has('US_EAST'));
});

test('C2 #15 - cross-region opt-in is LOUD and recorded; pools globally', () => {
  const captures = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: 'eu' + i, region: 'EU_WEST' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: 'us' + i, region: 'US_EAST' })),
  ];
  const res = partitionForPate({ captures, n_teachers: 4, allow_cross_region: true });
  assert.equal(res.cross_region, true);
  assert.deepEqual(res.regions, ['GLOBAL']);
});

test('C2 #16 - partitionForPate validates teacher count vs corpus size', () => {
  assert.throws(() => partitionForPate({ captures: [{ id: 1 }], n_teachers: 5 }), /exceeds capture count/);
  assert.throws(() => partitionForPate({ captures: [], n_teachers: 1 }), /non-empty/);
});

test('C2 #17 - pateAggregate returns the consensus label and noisy-argmax behaves', () => {
  // Strong consensus on label 2; with no noise argmax is exactly 2.
  const votes = [2, 2, 2, 2, 2, 2, 1, 0, 2, 2];
  const clean = pateAggregate({ votes, n_labels: 3, noise_multiplier: 0 });
  assert.equal(clean.label, 2);
  assert.equal(clean.dp_effective, false);
  assert.deepEqual(clean.histogram, [1, 1, 8]);
  assert.equal(clean.sensitivity, 1);

  // With small noise on a strong-consensus query, the argmax stays 2 nearly
  // always. Empirically check it holds the vast majority of the time.
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const r = pateAggregate({ votes, n_labels: 3, noise_multiplier: 1.0 });
    if (r.label === 2) hits += 1;
    assert.equal(r.mechanism, 'pate_gnmax');
    assert.equal(r.dp_effective, true);
  }
  assert.ok(hits > 180, `strong consensus should survive small noise (${hits}/200)`);
});

test('C2 #18 - pateBudget composes per-query RDP into a real (eps, delta)', () => {
  const b = pateBudget({ n_queries: 200, noise_multiplier: 20, delta: 1e-5 });
  assert.equal(b.mechanism, 'pate_gnmax');
  assert.equal(b.n_queries, 200);
  assert.ok(Number.isFinite(b.epsilon) && b.epsilon > 0);
  // More queries answered must cost more privacy.
  const more = pateBudget({ n_queries: 2000, noise_multiplier: 20, delta: 1e-5 });
  assert.ok(more.epsilon > b.epsilon, 'answering more queries spends more epsilon');
});

// ============================================================================
// 4) Manifest stamp + reconciliation + ENV-gated trainer wiring.
// ============================================================================

test('C2 #19 - privacy_budget block stamps epsilon/delta alongside teacher_source', () => {
  const budget = computeDpSgdBudget({ noise_multiplier: 1.1, sample_rate: 0.01, steps: 1000 });
  const block = buildPrivacyBudgetBlock({
    path: 'dp_sgd',
    budget,
    teacher_source: 'open-weights',
    region: 'EU_WEST',
    region_allocation: { EU_WEST: 3 },
    cross_region: false,
  });
  assert.equal(block.privacy_path, 'dp_sgd');
  assert.equal(block.teacher_source, 'open-weights'); // composes with W708-2 stamp
  assert.equal(block.region, 'EU_WEST');
  assert.equal(block.dp_effective, true);
  assert.ok(typeof block.epsilon === 'number' && block.epsilon > 0);
  assert.equal(block.delta, 1e-5);
  assert.equal(block.accountant, 'rdp_moments_v1');
  assert.equal(block.version, DP_TRAINING_VERSION);
});

test('C2 #20 - "none" stamp explicitly records the ABSENCE of a DP guarantee', () => {
  const block = buildPrivacyBudgetBlock({ path: 'none', teacher_source: 'proprietary' });
  assert.equal(block.privacy_path, 'none');
  assert.equal(block.dp_effective, false);
  assert.equal(block.epsilon, null);
  assert.equal(block.delta, null);
  // Infinity epsilon is serialized as a string so JSON round-trips cleanly.
  const infBudget = computeDpSgdBudget({ noise_multiplier: 0, sample_rate: 0.01, steps: 10 });
  const infBlock = buildPrivacyBudgetBlock({ path: 'dp_sgd', budget: infBudget });
  assert.equal(infBlock.epsilon, 'Infinity');
  assert.equal(infBlock.dp_effective, false);
  assert.equal(JSON.parse(JSON.stringify(infBlock)).epsilon, 'Infinity');
});

test('C2 #21 - reconcileSpentBudget never under-reports: stamps the larger epsilon', () => {
  const requested = { noise_multiplier: 1.1, sample_rate: 0.01, steps: 1000 };
  // Trainer actually ran MORE steps than requested -> spent more privacy.
  const observed = { noise_multiplier: 1.1, sample_rate: 0.01, steps: 1500 };
  const rec = reconcileSpentBudget(requested, observed);
  assert.equal(rec.reconciled, true);
  assert.equal(rec.diverged, true);
  assert.ok(rec.observed_epsilon > rec.requested_epsilon);
  // The binding stamped epsilon equals the larger (observed) spend.
  assert.equal(rec.epsilon, rec.observed_epsilon);

  // Matching config -> no divergence.
  const recMatch = reconcileSpentBudget(requested, requested);
  assert.equal(recMatch.diverged, false);
});

test('C2 #22 - buildDpTrainerEnv is ENV-gated and fails loud on zero-noise DP', () => {
  // Disabled -> empty env, no DP requested.
  const off = buildDpTrainerEnv({ enabled: false });
  assert.equal(off.dp_requested, false);
  assert.deepEqual(off.env, {});

  // Enabled with real noise -> emits KOLM_DP_* env + an Opacus install hint.
  const on = buildDpTrainerEnv({
    enabled: true,
    l2_clip: 1.0,
    noise_multiplier: 1.1,
    sample_rate: 0.01,
    steps: 1000,
  });
  assert.equal(on.dp_requested, true);
  assert.equal(on.env.KOLM_DP_SGD, '1');
  assert.equal(on.env.KOLM_DP_NOISE_MULTIPLIER, '1.1');
  assert.equal(on.env.KOLM_DP_L2_CLIP, '1');
  assert.match(on.install_hint, /opacus/i);

  // Enabled but zero noise -> LOUD throw with a code + hint (no silent non-DP run).
  assert.throws(() => buildDpTrainerEnv({ enabled: true, noise_multiplier: 0 }), (e) => {
    assert.equal(e.code, 'DP_ZERO_NOISE');
    assert.match(e.hint, /noise_multiplier > 0/);
    return true;
  });
});

test('C2 #23 - moat preserved: budget block is JSON-serializable for the receipt chain', () => {
  // The .kolm receipt chain hashes the manifest; the privacy block must
  // round-trip through JSON byte-stably (no functions, no Infinity literal).
  const budget = computeDpSgdBudget({ noise_multiplier: 1.3, sample_rate: 0.02, steps: 500 });
  const block = buildPrivacyBudgetBlock({ path: 'dp_sgd', budget, teacher_source: 'open-weights' });
  const round = JSON.parse(JSON.stringify(block));
  assert.deepEqual(round, block, 'privacy block must survive a JSON round-trip unchanged');
});
