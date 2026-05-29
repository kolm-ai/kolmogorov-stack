// W921 — KOLM AUTOPILOT cost optimizer contract (src/cost-optimizer.js).
//
// rankStrategies({tenant, namespace, budget_usd, target_kscore,
//   current_features, teacher_spec}) ranks the five improvement strategies
//   {dedup, ingest-more, gap-fill, preference, evol} by predicted ΔK-per-dollar
//   so the autopilot always spends the next dollar where it buys the most K.
//
// DETERMINISM: this suite sets KOLM_DATA_DIR to a fresh, process-unique temp dir
// BEFORE importing the module, so the event store + W832 meta-trainer row store
// start empty. With zero accumulated rows (well below MIN_ROWS_FOR_META=1000),
// predictKScore always takes its pure heuristic path — no learned-model state,
// no network, no wall-clock branching. Every call is tenant-fenced with a unique
// test tenant id so nothing leaks across tests. The cost side is priced offline
// against the static provider-registry price table (default teacher
// openai:gpt-4o-mini), so the dollar figures are fixed constants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Isolate persisted state to a throwaway dir so the predictor stays on the
// deterministic heuristic path and the event-store writes nowhere shared.
process.env.KOLM_DATA_DIR = path.join(
  os.tmpdir(),
  `kolm-w921-cost-opt-${process.pid}-${Date.now()}`,
);

const { rankStrategies, COST_OPTIMIZER_VERSION } = await import('../src/cost-optimizer.js');

// Unique tenant per call — fences event-store + meta-trainer reads.
let _seq = 0;
function tid() { return `tenant_w921_cost_${process.pid}_${++_seq}`; }

// A mid-range vector where every strategy's characteristic delta produces a
// strictly positive ΔK (nothing is pre-clamped at the [0,1] edges): moderate
// dup_fraction so dedup helps, sub-max coverage so gap-fill/evol help, n_pairs
// well above 0 so the small dedup dip nets positive.
function baseFeatures() {
  return {
    n_pairs: 300,
    dup_fraction: 0.25,
    coverage_score: 0.55,
    avg_quality: 0.6,
    cot_contam_fraction: 0.1,
    teacher_diversity: 0.5,
  };
}

function byStrategy(ranked) {
  return Object.fromEntries(ranked.map((r) => [r.strategy, r]));
}

test('cost-optimizer: version export is co-v1', () => {
  assert.equal(COST_OPTIMIZER_VERSION, 'co-v1');
});

test('cost-optimizer: missing current_features => ok:false error envelope', async () => {
  for (const bad of [undefined, null, [], 'nope', 42]) {
    const r = await rankStrategies({ tenant: tid(), namespace: 'ns', budget_usd: 100, current_features: bad });
    assert.equal(r.ok, false, `bad input ${JSON.stringify(bad)} rejected`);
    assert.equal(r.error, 'current_features_required');
    assert.equal(r.version, 'co-v1');
    // The error envelope must not leak a plan.
    assert.equal(r.ranked, undefined);
    assert.equal(r.recommended, undefined);
  }
});

test('cost-optimizer: success envelope carries the full co-v1 contract shape', async () => {
  const r = await rankStrategies({
    tenant: tid(), namespace: 'ns', budget_usd: 1000, target_kscore: 0.9,
    current_features: baseFeatures(),
  });

  assert.equal(r.ok, true);
  assert.equal(r.version, 'co-v1');
  assert.equal(typeof r.current_k, 'number');
  assert.equal(typeof r.persisted, 'boolean');

  // ranked[] covers exactly the five named strategies.
  assert.ok(Array.isArray(r.ranked));
  assert.equal(r.ranked.length, 5);
  assert.deepEqual(
    r.ranked.map((x) => x.strategy).sort(),
    ['dedup', 'evol', 'gap-fill', 'ingest-more', 'preference'],
  );

  // Each ranked entry exposes the documented per-strategy fields.
  for (const x of r.ranked) {
    for (const k of ['strategy', 'est_cost_usd', 'predicted_delta_k', 'delta_k_per_dollar', 'fits_budget']) {
      assert.ok(Object.prototype.hasOwnProperty.call(x, k), `${x.strategy} has ${k}`);
    }
    assert.equal(typeof x.est_cost_usd, 'number');
    assert.equal(typeof x.predicted_delta_k, 'number');
    assert.equal(typeof x.delta_k_per_dollar, 'number');
    assert.equal(typeof x.fits_budget, 'boolean');
    assert.ok(x.est_cost_usd >= 0);
    assert.ok(x.predicted_delta_k >= 0); // tiny negatives are clamped to 0
  }

  // recommended names one of the ranked strategies (a real K-moving fit).
  assert.ok(r.ranked.some((x) => x.strategy === r.recommended));
});

test('cost-optimizer: a free strategy (dedup) outranks a costly one (gap-fill) by ΔK/$', async () => {
  const r = await rankStrategies({
    tenant: tid(), namespace: 'ns', budget_usd: 1000,
    current_features: baseFeatures(),
  });
  assert.equal(r.ok, true);
  const m = byStrategy(r.ranked);

  // Both strategies genuinely help on this vector.
  assert.ok(m.dedup.predicted_delta_k > 0, 'dedup moves K');
  assert.ok(m['gap-fill'].predicted_delta_k > 0, 'gap-fill moves K');

  // dedup spends no teacher tokens; gap-fill is teacher-priced.
  assert.equal(m.dedup.est_cost_usd, 0, 'dedup is free');
  assert.ok(m['gap-fill'].est_cost_usd > 0, 'gap-fill costs teacher tokens');

  // The free win dominates the yield ranking and is recommended first.
  assert.ok(m.dedup.delta_k_per_dollar > m['gap-fill'].delta_k_per_dollar);
  assert.ok(
    r.ranked.indexOf(m.dedup) < r.ranked.indexOf(m['gap-fill']),
    'dedup is sorted above gap-fill',
  );
  assert.equal(r.recommended, 'dedup');
});

test('cost-optimizer: a tiny budget flags costly strategies fits_budget:false and the recommendation still fits', async () => {
  // $0.03: cheaper than gap-fill / evol / ingest-more (all teacher-priced
  // above this), but covers the free dedup pass and the light preference pass.
  const budget = 0.03;
  const r = await rankStrategies({
    tenant: tid(), namespace: 'ns', budget_usd: budget,
    current_features: baseFeatures(),
  });
  assert.equal(r.ok, true);
  const m = byStrategy(r.ranked);

  // Costly strategies fall outside the tiny budget.
  for (const s of ['gap-fill', 'evol', 'ingest-more']) {
    assert.ok(m[s].est_cost_usd > budget, `${s} exceeds tiny budget`);
    assert.equal(m[s].fits_budget, false, `${s} flagged out of budget`);
  }
  // The free dedup pass always fits.
  assert.equal(m.dedup.fits_budget, true);

  // fits_budget is exactly "cost within budget" for every strategy.
  for (const x of r.ranked) {
    assert.equal(x.fits_budget, x.est_cost_usd <= budget, `${x.strategy} fits_budget consistent`);
  }

  // The recommendation must itself fit the budget (and actually move K).
  assert.ok(r.recommended != null, 'a recommendation is made');
  assert.equal(m[r.recommended].fits_budget, true, 'recommended fits the budget');
  assert.ok(m[r.recommended].predicted_delta_k > 0, 'recommended is not a no-op');
});

test('cost-optimizer: ranked is sorted DESC by delta_k_per_dollar (free dedup on top)', async () => {
  const r = await rankStrategies({
    tenant: tid(), namespace: 'ns', budget_usd: 1000,
    current_features: baseFeatures(),
  });
  assert.equal(r.ok, true);
  for (let i = 1; i < r.ranked.length; i++) {
    assert.ok(
      r.ranked[i - 1].delta_k_per_dollar >= r.ranked[i].delta_k_per_dollar - 1e-9,
      `ranked[${i - 1}] >= ranked[${i}] by ΔK/$`,
    );
  }
  assert.equal(r.ranked[0].strategy, 'dedup', 'the free strategy floats to the top');
});
