// W921 — Autopilot strategy-bandit tests.
//
// Module under test: src/bandit-thompson.js — a budgeted, non-stationary
// (discounted) Thompson-sampling bandit over the autopilot's 5 improvement
// strategies. Reward = realized ΔK per dollar.
//
// W604 anti-brittleness: STRATEGY_BANDIT_VERSION asserted via regex; all
// stochastic assertions use a seeded mulberry32 RNG and assert on AGGREGATE
// behavior (recommendation share, posterior recovery) over many seeds, never a
// single brittle draw. Hermetic via a fresh KOLM_DATA_DIR per test.
//
// Coverage map:
//   #1  exports + version regex + default constants
//   #2  _normalGammaUpdate gamma=1 matches the closed-form NIG posterior (1e-9)
//   #3  gamma<1 strictly downweights (smaller n_eff) + recent reward moves mu_n faster
//   #4  _sampleGamma mean ~ shape/rate over 50k seeded draws (within 3%)
//   #5  _sampleNormal mean/var over 50k seeded draws (within 3%)
//   #6  every public fn returns an envelope + never throws on bad input
//   #7  recordStrategyChoice persists a pending row + returns a choice_id
//   #8  recordStrategyOutcome folds a realized ΔK; NEVER clamps negatives
//   #9  readStrategyPosteriors warm-starts unseen arms from prior_mu
//   #10 WARM-START day-0 parity: n=0 ranking matches the greedy prior order
//   #11 CONVERGENCE: best-arm recommendation share > 80% over many seeds
//   #12 NON-STATIONARITY: gamma=0.9 re-converges after a mid-run best-arm switch
//   #13 REGRESSION: a truly-negative arm's posterior mean is driven negative
//   #14 COST-AWARE: a free arm (cost 0) outranks a paid arm at equal sampled reward
//   #15 BUDGET: an infeasible arm (fits_budget:false) is NEVER recommended
//   #16 TENANT FENCE (W411): a foreign tenant's outcomes are invisible
//   #17 IDEMPOTENCE: recordStrategyOutcome with the same choice_id twice no-ops

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STRATEGY_BANDIT_VERSION,
  BANDIT_PROVIDER,
  BANDIT_WORKFLOW,
  DEFAULT_GAMMA,
  DEFAULT_EPSILON,
  rankByThompson,
  sampleStrategyPosterior,
  recordStrategyChoice,
  recordStrategyOutcome,
  readStrategyPosteriors,
  __internals,
} from '../src/bandit-thompson.js';

// ---------------------------------------------------------------------------
// Deterministic seeded RNG (mulberry32) + Box-Muller normal for fixtures.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng, mean, sd) {
  let u = 0;
  let v = 0;
  while (u <= 0) u = rng();
  v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-bandit-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

async function resetStore() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
}

// ===========================================================================
// #1 exports + version + constants
// ===========================================================================
test('#1 exports + STRATEGY_BANDIT_VERSION + defaults', () => {
  assert.equal(typeof rankByThompson, 'function');
  assert.equal(typeof sampleStrategyPosterior, 'function');
  assert.equal(typeof recordStrategyChoice, 'function');
  assert.equal(typeof recordStrategyOutcome, 'function');
  assert.equal(typeof readStrategyPosteriors, 'function');
  assert.match(STRATEGY_BANDIT_VERSION, /^sb-/);
  assert.equal(BANDIT_PROVIDER, 'kolm_strategy_bandit');
  assert.equal(BANDIT_WORKFLOW.CHOICE, 'bandit:choice');
  assert.equal(BANDIT_WORKFLOW.OUTCOME, 'bandit:outcome');
  assert.equal(DEFAULT_GAMMA, 0.9);
  assert.ok(DEFAULT_EPSILON > 0 && DEFAULT_EPSILON < 1e-3);
});

// ===========================================================================
// #2 _normalGammaUpdate gamma=1 == closed-form NIG (1e-9)
// ===========================================================================
test('#2 _normalGammaUpdate matches the closed-form NIG posterior (gamma=1)', () => {
  const { _normalGammaUpdate } = __internals;
  const prior = { mu0: 0, kappa0: 1, alpha0: 1, beta0: 0.01 };
  const rewards = [0.1, 0.2, 0.3]; // newest first
  const p = _normalGammaUpdate(prior, rewards, 1);
  // Hand-computed: n=3, xbar=0.2, S=sum((r-0.2)^2)=0.02.
  const n = 3;
  const xbar = 0.2;
  const S = 0.02;
  const kappa_n = 1 + n;
  const mu_n = (1 * 0 + n * xbar) / kappa_n;
  const alpha_n = 1 + n / 2;
  const beta_n = 0.01 + 0.5 * S + (0.5 * 1 * n * (xbar - 0) * (xbar - 0)) / kappa_n;
  assert.ok(Math.abs(p.mu_n - mu_n) < 1e-9, `mu_n ${p.mu_n} vs ${mu_n}`);
  assert.equal(p.kappa_n, kappa_n);
  assert.equal(p.alpha_n, alpha_n);
  assert.ok(Math.abs(p.beta_n - beta_n) < 1e-9, `beta_n ${p.beta_n} vs ${beta_n}`);
  assert.equal(p.n_eff, n);
});

// ===========================================================================
// #3 gamma<1 downweights + a recent shift moves mu_n faster
// ===========================================================================
test('#3 discounting: gamma<1 -> smaller n_eff + faster adaptation', () => {
  const { _normalGammaUpdate } = __internals;
  const prior = { mu0: 0, kappa0: 1, alpha0: 1, beta0: 0.01 };
  const rewards = [0.3, 0.2, 0.1, 0.05]; // newest first

  const g1 = _normalGammaUpdate(prior, rewards, 1.0);
  const g05 = _normalGammaUpdate(prior, rewards, 0.5);
  assert.ok(g05.n_eff < g1.n_eff, `gamma=0.5 n_eff ${g05.n_eff} must be < gamma=1 ${g1.n_eff}`);

  // A recent upward shift: newest reward jumps to 0.5. With discounting the
  // posterior mean tracks the recent value more (closer to 0.5) than with no
  // discounting, which averages over the long stale tail.
  const shifted = [0.5, 0.05, 0.05, 0.05, 0.05, 0.05];
  const sg1 = _normalGammaUpdate(prior, shifted, 1.0);
  const sg05 = _normalGammaUpdate(prior, shifted, 0.5);
  assert.ok(sg05.mu_n > sg1.mu_n,
    `discounted mu_n ${sg05.mu_n} must exceed stationary ${sg1.mu_n} after a recent up-shift`);
});

// ===========================================================================
// #4 _sampleGamma mean ~ shape/rate
// ===========================================================================
test('#4 _sampleGamma mean ~ shape/rate over 50k seeded draws', () => {
  const { _sampleGamma } = __internals;
  const rng = mulberry32(42);
  let s = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) s += _sampleGamma(3, 2, rng);
  const mean = s / N;
  assert.ok(Math.abs(mean - 1.5) / 1.5 <= 0.03, `gamma mean ${mean} not within 3% of 1.5`);
  // shape<1 boosting path is finite + non-negative.
  const rng2 = mulberry32(9);
  let s2 = 0;
  for (let i = 0; i < N; i++) { const x = _sampleGamma(0.5, 1, rng2); assert.ok(x >= 0 && Number.isFinite(x)); s2 += x; }
  assert.ok(Math.abs((s2 / N) - 0.5) / 0.5 <= 0.06, `gamma(0.5,1) mean ${s2 / N} not within 6% of 0.5`);
});

// ===========================================================================
// #5 _sampleNormal mean/var
// ===========================================================================
test('#5 _sampleNormal mean/var over 50k seeded draws', () => {
  const { _sampleNormal } = __internals;
  const rng = mulberry32(7);
  let m = 0;
  let m2 = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) { const x = _sampleNormal(0.5, 0.04, rng); m += x; m2 += x * x; }
  m /= N;
  const variance = m2 / N - m * m;
  assert.ok(Math.abs(m - 0.5) <= 0.01, `normal mean ${m} not within 0.01 of 0.5`);
  assert.ok(Math.abs(variance - 0.04) / 0.04 <= 0.05, `normal var ${variance} not within 5% of 0.04`);
  // variance 0 -> returns the mean exactly (degenerate).
  assert.equal(_sampleNormal(0.7, 0, rng), 0.7);
});

// ===========================================================================
// #6 every public fn returns an envelope + never throws on bad input
// ===========================================================================
test('#6 envelope returns, never throws on bad input', async () => {
  freshDir();
  await resetStore();
  const a = await rankByThompson({ tenant: 't', namespace: 'n', arms: [] });
  assert.equal(a.ok, false);
  assert.equal(a.error, 'arms_required');
  assert.match(a.version, /^sb-/);

  const b = await recordStrategyChoice({ tenant: 't', namespace: 'n' });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'missing_strategy');

  const c = await recordStrategyOutcome({ tenant: 't', namespace: 'n', strategy: 'dedup' });
  assert.equal(c.ok, false);
  assert.equal(c.error, 'no_realized_reward');

  const d = await sampleStrategyPosterior({ tenant: 't', namespace: 'n' });
  assert.equal(d.ok, false);

  const e = await readStrategyPosteriors({ tenant: 't', namespace: 'n' });
  assert.equal(e.ok, true); // empty ledger is a valid (empty) posterior set
  assert.deepEqual(e.posteriors, {});
});

// ===========================================================================
// #7 recordStrategyChoice persists a pending row + returns a choice_id
// ===========================================================================
test('#7 recordStrategyChoice persists + returns choice_id', async () => {
  freshDir();
  await resetStore();
  const res = await recordStrategyChoice({
    tenant: 'tenant_c', namespace: 'ns', strategy: 'ingest-more',
    base_kscore: 0.8, est_cost_usd: 5, sampled_ratio: 0.01, run_id: 'run_1',
  });
  assert.equal(res.ok, true);
  assert.ok(res.choice_id && res.choice_id.startsWith('sbc_'));
  assert.equal(res.persisted, true);
});

// ===========================================================================
// #8 recordStrategyOutcome folds a realized ΔK; NEVER clamps negatives
// ===========================================================================
test('#8 recordStrategyOutcome folds reward + never clamps negatives', async () => {
  freshDir();
  await resetStore();
  const tenant = 'tenant_o';
  const ns = 'ns';
  // A genuinely harmful strategy: realized ΔK = -0.05.
  const out = await recordStrategyOutcome({
    tenant, namespace: ns, strategy: 'evol', realized_delta_k: -0.05,
  });
  assert.equal(out.ok, true);
  assert.equal(out.reward, -0.05); // NOT clamped to 0
  assert.ok(out.posterior && Number.isFinite(out.posterior.mu_n));

  // Folding more negatives drives the posterior mean below the prior.
  for (let i = 0; i < 8; i++) {
    await recordStrategyOutcome({ tenant, namespace: ns, strategy: 'evol', realized_delta_k: -0.05 });
  }
  const post = await readStrategyPosteriors({ tenant, namespace: ns, gamma: 0.9, prior_mu: 0.02 });
  assert.ok(post.posteriors.evol.posterior_mean < 0,
    `evol posterior mean ${post.posteriors.evol.posterior_mean} should be negative (regression masking gone)`);
});

// ===========================================================================
// #9 readStrategyPosteriors warm-starts unseen arms from prior_mu
// ===========================================================================
test('#9 readStrategyPosteriors warm-starts unseen arms', async () => {
  freshDir();
  await resetStore();
  const post = await readStrategyPosteriors({
    tenant: 'tenant_w', namespace: 'ns', gamma: 0.9,
    prior_mu: { dedup: 0.01, 'ingest-more': 0.05 },
    strategies: ['dedup', 'ingest-more'],
  });
  assert.equal(post.ok, true);
  assert.equal(post.posteriors.dedup.warm_started, true);
  assert.equal(post.posteriors.dedup.n_obs, 0);
  // Warm-start mean equals the supplied prior_mu (n=0 -> mu_n == mu0).
  assert.ok(Math.abs(post.posteriors.dedup.posterior_mean - 0.01) < 1e-9);
  assert.ok(Math.abs(post.posteriors['ingest-more'].posterior_mean - 0.05) < 1e-9);
});

// ===========================================================================
// #10 WARM-START day-0 parity: n=0 ranking matches the greedy prior order
// ===========================================================================
test('#10 warm-start day-0 parity with the greedy prior ranking', async () => {
  freshDir();
  await resetStore();
  // Greedy ranking (by predicted_delta_k / cost ratio): give each arm a prior
  // and cost; the bandit at n=0 should recommend the same top arm as the greedy
  // ratio on the large majority of seeds (sampling noise allows a few misses).
  const arms = [
    { strategy: 'dedup', prior_mu: 0.02, est_cost_usd: 0, fits_budget: true },        // ratio huge
    { strategy: 'ingest-more', prior_mu: 0.05, est_cost_usd: 5, fits_budget: true },
    { strategy: 'gap-fill', prior_mu: 0.03, est_cost_usd: 3, fits_budget: true },
    { strategy: 'preference', prior_mu: 0.02, est_cost_usd: 2, fits_budget: true },
    { strategy: 'evol', prior_mu: 0.025, est_cost_usd: 4, fits_budget: true },
  ];
  // Greedy ratio: dedup = 0.02/eps (dominates). So the greedy pick is dedup.
  let match = 0;
  const SEEDS = 200;
  for (let s = 0; s < SEEDS; s++) {
    const rng = mulberry32(2000 + s);
    const r = await rankByThompson({ tenant: 'tenant_p', namespace: 'ns', arms, gamma: 0.9, rng });
    if (r.recommended === 'dedup') match += 1;
  }
  // dedup is recommended whenever its sampled reward > 0 (free arm dominates the
  // ratio). The cold-start posterior at mu0=0.02 samples positive most of the
  // time, so day-0 parity with the greedy free-arm pick clears a clear majority.
  assert.ok(match / SEEDS >= 0.55,
    `day-0 dedup parity share ${match / SEEDS} should be a clear majority`);
});

// ===========================================================================
// #11 CONVERGENCE: best-arm recommendation share > 80% over many seeds
// ===========================================================================
test('#11 converges to the best arm (>80% share over seeds)', async () => {
  // Equal cost so ratio == sampled reward; ingest-more is clearly best.
  const trueMean = { dedup: 0.01, 'ingest-more': 0.06, 'gap-fill': 0.02, preference: 0.015, evol: 0.012 };
  let totalShare = 0;
  const SEEDS = 16;
  for (let seed = 0; seed < SEEDS; seed++) {
    freshDir();
    await resetStore();
    const tenant = 'tc_' + seed;
    const ns = 'sim';
    const rng = mulberry32(1000 + seed);
    const arms = Object.keys(trueMean).map((s) => ({ strategy: s, prior_mu: 0.02, est_cost_usd: 1, fits_budget: true }));
    let best = 0;
    for (let tick = 0; tick < 60; tick++) {
      const r = await rankByThompson({ tenant, namespace: ns, arms, gamma: 1.0, rng });
      const pick = r.recommended;
      const reward = normal(rng, trueMean[pick] || 0, 0.012);
      await recordStrategyOutcome({ tenant, namespace: ns, strategy: pick, realized_delta_k: reward, gamma: 1.0 });
      if (tick >= 50) { if (pick === 'ingest-more') best += 1; }
    }
    totalShare += best / 10;
  }
  const avgShare = totalShare / SEEDS;
  assert.ok(avgShare > 0.8, `avg best-arm share ${avgShare} should exceed 0.80`);
});

// ===========================================================================
// #12 NON-STATIONARITY: gamma=0.9 re-converges after a mid-run best-arm switch
// ===========================================================================
test('#12 non-stationary: discounting re-converges after a best-arm switch', async () => {
  // dedup pays early then collapses; ingest-more takes over at tick 25. We
  // measure the LAST-10-tick share of the new best arm; gamma=0.9 (forgets the
  // stale dedup yield) should out-track gamma=1 (which averages the stale tail).
  function runWithGamma(gamma, seed) {
    return (async () => {
      freshDir();
      await resetStore();
      const tenant = 'tns_' + gamma + '_' + seed;
      const ns = 'sim';
      const rng = mulberry32(7000 + seed);
      const arms = ['dedup', 'ingest-more', 'gap-fill'].map((s) => ({ strategy: s, prior_mu: 0.02, est_cost_usd: 1, fits_budget: true }));
      let newBestLast10 = 0;
      for (let tick = 0; tick < 60; tick++) {
        const r = await rankByThompson({ tenant, namespace: ns, arms, gamma, rng });
        const pick = r.recommended;
        // Phase 1 (tick<25): dedup best (0.06). Phase 2: ingest-more best (0.06),
        // dedup collapses to ~0.
        let mean;
        if (tick < 25) mean = { dedup: 0.06, 'ingest-more': 0.01, 'gap-fill': 0.015 }[pick] || 0;
        else mean = { dedup: 0.0, 'ingest-more': 0.06, 'gap-fill': 0.015 }[pick] || 0;
        const reward = normal(rng, mean, 0.012);
        await recordStrategyOutcome({ tenant, namespace: ns, strategy: pick, realized_delta_k: reward, gamma });
        if (tick >= 50 && pick === 'ingest-more') newBestLast10 += 1;
      }
      return newBestLast10 / 10;
    })();
  }
  let share09 = 0;
  let share10 = 0;
  const SEEDS = 8;
  for (let s = 0; s < SEEDS; s++) {
    share09 += await runWithGamma(0.9, s);
    share10 += await runWithGamma(1.0, s);
  }
  share09 /= SEEDS;
  share10 /= SEEDS;
  // gamma=0.9 re-converges to the new best arm; it must at least match (and in
  // practice exceed) gamma=1's tracking of the post-switch regime.
  assert.ok(share09 >= 0.6, `gamma=0.9 post-switch share ${share09} should re-converge (>=0.6)`);
  assert.ok(share09 >= share10 - 0.1,
    `gamma=0.9 (${share09}) should track the switch at least as well as gamma=1 (${share10})`);
});

// ===========================================================================
// #13 REGRESSION: a truly-negative arm's posterior mean is driven negative
// ===========================================================================
test('#13 regression: negative-reward arm posterior mean goes negative + share -> 0', async () => {
  freshDir();
  await resetStore();
  const tenant = 'tneg';
  const ns = 'sim';
  const rng = mulberry32(303);
  // Feed evol a clearly negative reward stream.
  for (let i = 0; i < 20; i++) {
    await recordStrategyOutcome({ tenant, namespace: ns, strategy: 'evol', realized_delta_k: normal(rng, -0.05, 0.01), gamma: 0.9 });
  }
  const post = await readStrategyPosteriors({ tenant, namespace: ns, gamma: 0.9, prior_mu: 0.02 });
  assert.ok(post.posteriors.evol.posterior_mean < -0.01,
    `evol mean ${post.posteriors.evol.posterior_mean} should be driven well negative`);

  // With a positive arm present, the negative arm is essentially never picked.
  const arms = [
    { strategy: 'evol', prior_mu: 0.02, est_cost_usd: 1, fits_budget: true },
    { strategy: 'ingest-more', prior_mu: 0.04, est_cost_usd: 1, fits_budget: true },
  ];
  let evolPicks = 0;
  for (let i = 0; i < 100; i++) {
    const r = await rankByThompson({ tenant, namespace: ns, arms, gamma: 0.9, rng: mulberry32(40000 + i) });
    if (r.recommended === 'evol') evolPicks += 1;
  }
  assert.ok(evolPicks / 100 <= 0.1, `evol pick share ${evolPicks / 100} should be near 0`);
});

// ===========================================================================
// #14 COST-AWARE: a free arm outranks a paid arm at equal sampled reward
// ===========================================================================
test('#14 cost-aware ratio: free arm dominates a paid arm at equal reward', async () => {
  freshDir();
  await resetStore();
  // Two arms with the SAME positive prior; one is free (cost 0), one costs $5.
  // The free arm's ratio (reward/eps) dwarfs the paid arm's (reward/5) whenever
  // BOTH sample positive, so the free arm wins the large majority of draws.
  const arms = [
    { strategy: 'dedup', prior_mu: 0.05, est_cost_usd: 0, fits_budget: true },
    { strategy: 'ingest-more', prior_mu: 0.05, est_cost_usd: 5, fits_budget: true },
  ];
  let freeWins = 0;
  let bothPositive = 0;
  for (let i = 0; i < 300; i++) {
    const r = await rankByThompson({ tenant: 'tcost', namespace: 'ns', arms, gamma: 0.9, rng: mulberry32(i) });
    const free = r.ranked.find((x) => x.strategy === 'dedup');
    const paid = r.ranked.find((x) => x.strategy === 'ingest-more');
    if (free.sampled_reward > 0 && paid.sampled_reward > 0) {
      bothPositive += 1;
      // When both are positive, the free arm MUST rank first (ratio dominance).
      assert.equal(r.ranked[0].strategy, 'dedup',
        `free arm must rank first when both sample positive (i=${i})`);
    }
    if (r.recommended === 'dedup') freeWins += 1;
  }
  assert.ok(bothPositive > 50, 'sanity: enough both-positive draws to test ratio dominance');
  assert.ok(freeWins / 300 >= 0.5, `free-arm recommendation share ${freeWins / 300} should be a majority`);
});

// ===========================================================================
// #15 BUDGET: an infeasible arm is NEVER recommended
// ===========================================================================
test('#15 budget filtering: infeasible arm never recommended', async () => {
  freshDir();
  await resetStore();
  const arms = [
    { strategy: 'dedup', prior_mu: 0.05, est_cost_usd: 0, fits_budget: false }, // would dominate but infeasible
    { strategy: 'ingest-more', prior_mu: 0.04, est_cost_usd: 5, fits_budget: true },
  ];
  for (let i = 0; i < 150; i++) {
    const r = await rankByThompson({ tenant: 'tbud', namespace: 'ns', arms, gamma: 0.9, rng: mulberry32(500 + i) });
    assert.notEqual(r.recommended, 'dedup', `infeasible dedup must never be recommended (i=${i})`);
  }
});

// ===========================================================================
// #16 TENANT FENCE (W411): a foreign tenant's outcomes are invisible
// ===========================================================================
test('#16 W411 tenant fence: foreign outcomes invisible to readStrategyPosteriors', async () => {
  freshDir();
  await resetStore();
  const ns = 'ns';
  // Tenant A records a big positive stream for ingest-more.
  for (let i = 0; i < 10; i++) {
    await recordStrategyOutcome({ tenant: 'tenant_A', namespace: ns, strategy: 'ingest-more', realized_delta_k: 0.05, gamma: 0.9 });
  }
  // Tenant B sees NONE of it.
  const postB = await readStrategyPosteriors({ tenant: 'tenant_B', namespace: ns, gamma: 0.9, prior_mu: 0.02, strategies: ['ingest-more'] });
  assert.equal(postB.posteriors['ingest-more'].n_obs, 0,
    'tenant B must not see tenant A outcome rows (W411 fence)');
  assert.equal(postB.posteriors['ingest-more'].warm_started, true);

  const postA = await readStrategyPosteriors({ tenant: 'tenant_A', namespace: ns, gamma: 0.9, prior_mu: 0.02, strategies: ['ingest-more'] });
  assert.equal(postA.posteriors['ingest-more'].n_obs, 10);
});

// ===========================================================================
// #17 IDEMPOTENCE: same choice_id twice does not double-count
// ===========================================================================
test('#17 idempotence: same choice_id twice no-ops', async () => {
  freshDir();
  await resetStore();
  const tenant = 'tidem';
  const ns = 'ns';
  const choice = await recordStrategyChoice({ tenant, namespace: ns, strategy: 'gap-fill', base_kscore: 0.8 });
  assert.ok(choice.choice_id);

  const first = await recordStrategyOutcome({
    tenant, namespace: ns, strategy: 'gap-fill', realized_delta_k: 0.03, choice_id: choice.choice_id, gamma: 0.9,
  });
  assert.equal(first.ok, true);
  assert.notEqual(first.idempotent_hit, true);

  const dup = await recordStrategyOutcome({
    tenant, namespace: ns, strategy: 'gap-fill', realized_delta_k: 0.03, choice_id: choice.choice_id, gamma: 0.9,
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.idempotent_hit, true);

  // Only ONE outcome row counted for the strategy.
  const post = await readStrategyPosteriors({ tenant, namespace: ns, gamma: 0.9, prior_mu: 0.02, strategies: ['gap-fill'] });
  assert.equal(post.posteriors['gap-fill'].n_obs, 1, 'duplicate outcome must not double-count');
});
