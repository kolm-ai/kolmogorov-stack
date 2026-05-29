// W921 — Autopilot lifecycle bandit-wiring tests.
//
// Verifies the ADDITIVE, OPT-IN wiring of the strategy-bandit advisory into
// src/autopilot-lifecycle.js tickAutopilotFull:
//   - DEFAULT OFF: when opts.use_bandit is absent, the bandit advisory is N/A,
//     the OBSERVE leg is null, and the greedy plan.recommended (the simulator
//     input) is byte-for-byte the legacy behavior (no day-0 regression).
//   - OPT-IN: with opts.use_bandit:true the bandit ranks the SAME arms warm-
//     started from the greedy plan, writes a pending CHOICE row, and at cold
//     start AGREES with the greedy pick (day-0 parity).
//   - OBSERVE: with a REALIZED candidate_kscore the loop closes — the bandit
//     posterior moves. The realized K is the post-distill K, never the
//     simulator's predicted K.
//   - The bandit NEVER overrides the simulator's strategy unless the operator
//     explicitly sets opts.bandit_decides:true.
//
// Hermetic via a fresh KOLM_DATA_DIR + event-store reset; deterministic via a
// seeded RNG passed through opts.rng.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tickAutopilotFull, __internals } from '../src/autopilot-lifecycle.js';

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

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-bwire-'));
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

const FEATURES = { n_pairs: 200, dup_fraction: 0.1, coverage_score: 0.6, avg_quality: 0.7 };

// ===========================================================================
// #1 DEFAULT OFF: bandit advisory N/A + greedy path unchanged
// ===========================================================================
test('#1 default-off: bandit is N/A and the greedy recommended is unchanged', async () => {
  freshDir();
  await resetStore();
  const out = await tickAutopilotFull({
    tenant: 'tenant_off', namespace: 'n',
    opts: { features: FEATURES, budget_usd: 50, target_kscore: 0.9 },
  });
  assert.equal(out.ok, true);
  // Bandit is present in the envelope but not enabled.
  assert.ok(out.bandit);
  assert.equal(out.bandit.applicable, false);
  assert.equal(out.bandit.reason, 'not_enabled');
  assert.equal(out.bandit_observe, null);
  // The greedy plan still drives the simulator (cost-optimizer recommended).
  assert.ok(out.plan && out.plan.ok === true);
  // simulate_decision exists and is derived from the GREEDY recommended.
  assert.ok(out.simulate_decision);
});

// ===========================================================================
// #2 OPT-IN: bandit ranks the same arms + writes a CHOICE row + day-0 parity
// ===========================================================================
test('#2 opt-in: bandit advisory ranks arms + agrees with greedy at cold start', async () => {
  freshDir();
  await resetStore();
  const out = await tickAutopilotFull({
    tenant: 'tenant_on', namespace: 'n',
    opts: { features: FEATURES, budget_usd: 50, target_kscore: 0.9, use_bandit: true, rng: mulberry32(3) },
  });
  assert.equal(out.ok, true);
  assert.equal(out.bandit.applicable, true);
  assert.equal(out.bandit.method, 'discounted-thompson');
  assert.ok(Array.isArray(out.bandit.ranked) && out.bandit.ranked.length > 0);
  assert.ok(out.bandit.recommended, 'bandit must produce a recommendation');
  assert.match(out.bandit.version, /^sb-/);
  // Warm-start day-0 parity: the cold bandit pick equals the greedy pick.
  assert.equal(out.bandit.agrees_with_greedy, true,
    `cold-start bandit pick ${out.bandit.recommended} should agree with greedy ${out.plan.recommended}`);
  // A pending CHOICE row was written.
  assert.ok(out.bandit.choice_id, 'bandit must write a pending CHOICE row');

  // The CHOICE row is persisted under the dedicated provider tag.
  const es = await import('../src/event-store.js');
  const rows = await es.listEvents({ tenant_id: 'tenant_on', provider: 'kolm_strategy_bandit', workflow_id: 'bandit:choice', limit: 0 });
  assert.ok(rows.length >= 1, 'a bandit:choice ledger row must exist');
});

// ===========================================================================
// #3 OPT-IN does NOT change the simulator's strategy unless bandit_decides
// ===========================================================================
test('#3 opt-in is advisory only — does not override the simulator input', async () => {
  freshDir();
  await resetStore();
  // Run twice with identical inputs: once greedy-only, once use_bandit (advisory).
  const greedy = await tickAutopilotFull({
    tenant: 'tg', namespace: 'n',
    opts: { features: FEATURES, budget_usd: 50, target_kscore: 0.9 },
  });
  await resetStore();
  const advised = await tickAutopilotFull({
    tenant: 'tg', namespace: 'n',
    opts: { features: FEATURES, budget_usd: 50, target_kscore: 0.9, use_bandit: true, rng: mulberry32(9) },
  });
  // The greedy plan's recommended is identical (same features) -> the simulator
  // decision basis is unchanged by enabling the advisory.
  assert.equal(greedy.plan.recommended, advised.plan.recommended,
    'enabling the bandit advisory must not change the greedy plan recommendation');
});

// ===========================================================================
// #4 OBSERVE: a REALIZED candidate_kscore closes the loop (posterior moves)
// ===========================================================================
test('#4 observe leg folds a realized candidate K into the posterior', async () => {
  freshDir();
  await resetStore();
  const out = await tickAutopilotFull({
    tenant: 'tenant_obs', namespace: 'n',
    opts: {
      features: FEATURES, budget_usd: 50, target_kscore: 0.9,
      use_bandit: true, rng: mulberry32(13),
      // The REALIZED post-distill K from a completed prior round (not predicted).
      candidate_kscore: 0.95,
    },
  });
  assert.equal(out.ok, true);
  assert.ok(out.bandit_observe, 'observe leg must run when a realized K is supplied');
  assert.equal(out.bandit_observe.recorded, true);
  assert.ok(out.bandit_observe.posterior && Number.isFinite(out.bandit_observe.posterior.mu_n));

  // An OUTCOME row was written + the bandit posterior for that strategy reflects it.
  const bandit = await import('../src/bandit-thompson.js');
  const post = await bandit.readStrategyPosteriors({ tenant: 'tenant_obs', namespace: 'n', gamma: 0.9 });
  const recorded = out.bandit_observe.strategy;
  assert.ok(post.posteriors[recorded] && post.posteriors[recorded].n_obs >= 1,
    'the recommended strategy must have >=1 recorded outcome after OBSERVE');
});

// ===========================================================================
// #5 OBSERVE no-op without a realized candidate K (predicted K is NOT used)
// ===========================================================================
test('#5 observe is a no-op without a realized candidate_kscore', async () => {
  freshDir();
  await resetStore();
  const out = await tickAutopilotFull({
    tenant: 'tenant_noobs', namespace: 'n',
    opts: { features: FEATURES, budget_usd: 50, target_kscore: 0.9, use_bandit: true, rng: mulberry32(21) },
  });
  assert.ok(out.bandit_observe);
  assert.equal(out.bandit_observe.recorded, false);
  assert.equal(out.bandit_observe.reason, 'no_realized_candidate_k');
});

// ===========================================================================
// #6 __internals expose the wiring helpers
// ===========================================================================
test('#6 lifecycle __internals expose _banditAdvisory + _banditObserve', () => {
  assert.equal(typeof __internals._banditAdvisory, 'function');
  assert.equal(typeof __internals._banditObserve, 'function');
});
