// Proves src/data-valuation-eval.js: measured K-score-delta attribution +
// scaling-law-informed budget allocation across valuation signals.
//
// The counterfactual harness NEVER invokes a GPU - we inject a deterministic
// runDistillEval stand-in that returns a K monotone in the number of "good"
// pairs the corpus carries, so a signal that adds good pairs measurably raises
// the holdout K and a signal that adds noise does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VALUATION_EVAL_VERSION,
  VALUATION_SIGNALS,
  VALUATION_BLOCK_KIND,
  buildMatchedCorpora,
  pairedBootstrapCI,
  measureSignalDelta,
  allocateDataBudget,
  buildValuationLeaderboardBlock,
} from '../src/data-valuation-eval.js';

import { fitDataScalingLaw } from '../src/data-scaling-law.js';
import { verifySignatureBlock } from '../src/ed25519.js';
import { canonicalJson } from '../src/cid.js';

// ── deterministic distill+eval stand-in ──────────────────────────────────────
// K = floor + slope * (fraction of "good" pairs in the corpus), with a tiny
// per-item spread so the bootstrap has variance. A pair is "good" when
// pair.good === true. Pure, no GPU, no network.
function makeRunner({ floor = 0.5, slope = 0.4, holdoutN = 24 } = {}) {
  return function runDistillEval(corpus) {
    const n = corpus.length || 1;
    const good = corpus.filter((p) => p && p.good === true).length;
    const frac = good / n;
    const meanK = Math.min(0.999, floor + slope * frac);
    // deterministic per-holdout-item scores spread around meanK.
    const per = [];
    for (let i = 0; i < holdoutN; i++) {
      const wob = ((i % 5) - 2) * 0.01; // -0.02..+0.02
      per.push(Math.max(0, Math.min(1, meanK + wob)));
    }
    return { k: meanK, per_item: per };
  };
}

function pair(id, good, outLen = 200) {
  return { input: `q-${id}`, teacher_output: 'a'.repeat(outLen), good };
}

// ── 1. version + matched corpora ──────────────────────────────────────────────

test('version stamp + matched corpora differ only in the added pairs (size-matched)', () => {
  assert.equal(VALUATION_EVAL_VERSION, 'dval-v1');
  const baseline = [pair('b1', false), pair('b2', false)];
  const added = [pair('g1', true), pair('g2', true)];
  const filler = [pair('f1', false), pair('f2', false), pair('f3', false)];

  const c = buildMatchedCorpora({ baseline, added, filler });
  assert.equal(c.include.length, 4);
  assert.equal(c.exclude.length, 4, 'exclude size-matched to include');
  assert.equal(c.matched, true);
  assert.equal(c.n_added, 2);
  assert.ok(c.added_tokens > 0, 'added pairs carry teacher tokens');
  // include carries the good pairs; exclude does not.
  assert.equal(c.include.filter((p) => p.good).length, 2);
  assert.equal(c.exclude.filter((p) => p.good).length, 0);
});

// ── 2. paired bootstrap CI is deterministic + detects a real effect ───────────

test('pairedBootstrapCI is deterministic and flags a real positive effect significant', () => {
  const inc = Array.from({ length: 20 }, (_, i) => 0.7 + ((i % 5) - 2) * 0.01);
  const exc = Array.from({ length: 20 }, (_, i) => 0.5 + ((i % 5) - 2) * 0.01);
  const a = pairedBootstrapCI(inc, exc, { seed: 'fixed', iters: 1000 });
  const b = pairedBootstrapCI(inc, exc, { seed: 'fixed', iters: 1000 });
  assert.deepEqual(a, b, 'bit-stable given the same seed');
  assert.equal(a.basis, 'paired-bootstrap');
  assert.ok(a.delta > 0.18 && a.delta < 0.22, 'delta ~ 0.2');
  assert.equal(a.significant, true, 'CI excludes 0 for a clear effect');
  assert.ok(a.lo > 0, 'lower bound above 0');
});

test('pairedBootstrapCI on a null effect is NOT significant', () => {
  const inc = Array.from({ length: 20 }, (_, i) => 0.6 + ((i % 5) - 2) * 0.01);
  const exc = Array.from({ length: 20 }, (_, i) => 0.6 + ((i % 5) - 2) * 0.01);
  const r = pairedBootstrapCI(inc, exc, { seed: 'x', iters: 1000 });
  assert.equal(r.significant, false);
  assert.ok(Math.abs(r.delta) < 1e-9);
});

// ── 3. measureSignalDelta: realized payoff + per-token efficiency + signature ─

test('measureSignalDelta records a signed, significant delta_K + dk_per_ktoken for a paying signal', async () => {
  const runDistillEval = makeRunner({ floor: 0.5, slope: 0.4 });
  const baseline = Array.from({ length: 8 }, (_, i) => pair(`b${i}`, false));
  const added = Array.from({ length: 8 }, (_, i) => pair(`g${i}`, true, 400));
  const filler = Array.from({ length: 8 }, (_, i) => pair(`f${i}`, false));

  const r = await measureSignalDelta({
    signal: 'dsir', baseline, added, filler, runDistillEval,
    bootstrap_iters: 1000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.basis, 'measured');
  assert.ok(r.delta_K > 0, 'good pairs raise the holdout K');
  assert.ok(r.k_include > r.k_exclude);
  assert.ok(r.teacher_tokens > 0);
  assert.ok(r.dk_per_ktoken > 0, 'positive per-teacher-token efficiency');
  assert.equal(r.ci.significant, true, 'effect is significant');
  assert.ok(typeof r.include_hash === 'string' && r.include_hash.length === 64);

  // the signed block verifies over the canonical (timestamp-excluded) payload.
  assert.ok(r.signature_ed25519 && r.signature_ed25519.signature, 'measurement is signed');
  const { signature_ed25519, ok, measured_at, ...rest } = r;
  const v = verifySignatureBlock(signature_ed25519, canonicalJson(rest));
  assert.equal(v.ok, true, 'Ed25519 signature verifies against the realized measurement');
});

test('measureSignalDelta fails LOUD (unmeasured) when an arm produces no readable K', async () => {
  // runner returns nothing readable for the include arm.
  const runner = (corpus, ctx) => (ctx.arm === 'include' ? { broken: true } : { k: 0.5, per_item: [0.5, 0.5] });
  const r = await measureSignalDelta({
    signal: 'shapley',
    baseline: [pair('b', false)],
    added: [pair('g', true)],
    filler: [pair('f', false)],
    runDistillEval: runner,
  });
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'unmeasured', 'refuses to fabricate a delta');
  assert.equal(r.delta_K, null);
  assert.ok(/arm_unreadable/.test(r.reason));
});

test('measureSignalDelta rejects a missing runner with an install/inject hint (no GPU here)', async () => {
  const r = await measureSignalDelta({ signal: 'dsir', baseline: [], added: [pair('g', true)] });
  assert.equal(r.ok, false);
  assert.ok(/runDistillEval/.test(r.error));
});

// ── 3b. it READS the holdout K through data-evaluate from a run_dir ───────────

test('measureSignalDelta reads holdout K via data-evaluate.evaluateRun from a run_dir artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-dval-'));
  function writeRun(meanK) {
    const dir = fs.mkdtempSync(path.join(root, 'run-'));
    const studentDir = path.join(dir, 'student');
    fs.mkdirSync(studentDir, { recursive: true });
    const results = Array.from({ length: 10 }, (_, i) => ({
      id: `it-${i}`, question: `q${i}`, student_answer: 'ok',
      verdict: { score: Math.max(0, Math.min(1, meanK + ((i % 3) - 1) * 0.01)) },
    }));
    const mean = results.reduce((a, r) => a + r.verdict.score, 0) / results.length;
    fs.writeFileSync(path.join(studentDir, 'eval-mixeval-hard.json'),
      JSON.stringify({ bench: 'mixeval-hard', mean_score: mean, n: results.length, cot_contaminated: 0, results }));
    return dir;
  }
  // include arm -> high K, exclude arm -> low K.
  const runner = (corpus, ctx) => ({ run_dir: writeRun(ctx.arm === 'include' ? 0.8 : 0.55) });
  const r = await measureSignalDelta({
    signal: 'influence-less',
    baseline: [pair('b', false)],
    added: [pair('g', true, 300)],
    filler: [pair('f', false)],
    runDistillEval: runner,
    bootstrap_iters: 500,
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.basis, 'measured');
  assert.ok(r.delta_K > 0.2 && r.delta_K < 0.3, 'reads ~0.25 holdout-K delta from the eval artifacts');
  assert.ok(r.dk_per_ktoken > 0);
});

// ── 4. allocator: split proportional to measured dK/token + explore floor ─────

test('allocateDataBudget splits proportional to measured dk/token with an explore floor + exact sum', () => {
  const measurements = [
    { signal: 'dsir', dk_per_ktoken: 0.4, significant: true },
    { signal: 'shapley', dk_per_ktoken: 0.1, significant: true },
    { signal: 'diversity', dk_per_ktoken: 0.0, significant: false },
    // semdedup-kept + influence-less: unmeasured (null) -> floor only.
  ];
  const a = allocateDataBudget({ measurements, budget: 1000, explore_floor: 0.05 });
  assert.equal(a.ok, true);
  const alloc = a.allocation;
  const total = VALUATION_SIGNALS.reduce((s, k) => s + alloc[k], 0);
  assert.equal(total, 1000, 'allocation sums to the budget exactly');

  // every known signal gets at least the explore floor (5% of 1000 = 50).
  for (const s of VALUATION_SIGNALS) assert.ok(alloc[s] >= 50, `${s} >= explore floor`);

  // the 4x-more-efficient signal gets strictly more than the weaker one.
  assert.ok(alloc['dsir'] > alloc['shapley'], 'higher dk/token -> more budget');
  // unmeasured signals get ONLY the floor.
  assert.equal(alloc['semdedup-kept'], 50);
  assert.equal(alloc['influence-less'], 50);
  assert.equal(a.basis, 'measured-proportional');
});

test('allocateDataBudget: no measured efficiency anywhere -> uniform exploration', () => {
  const a = allocateDataBudget({ measurements: [], budget: 100, explore_floor: 0.05 });
  const total = VALUATION_SIGNALS.reduce((s, k) => s + a.allocation[k], 0);
  assert.equal(total, 100);
  assert.equal(a.basis, 'explore-uniform');
  // roughly even (each ~20).
  for (const s of VALUATION_SIGNALS) assert.ok(a.allocation[s] >= 19 && a.allocation[s] <= 21);
});

test('allocator throttles via the rectified scaling-law saturation envelope', async () => {
  // fit a saturating curve, then check a saturated current size throttles vs a
  // fresh one (saturation < 1 shrinks the proportional weight uniformly, but the
  // RATIO across signals is preserved; we assert saturation is reported < 1).
  const points = [[50, 0.55], [100, 0.66], [200, 0.74], [400, 0.80], [800, 0.83], [1600, 0.845]];
  const fit = await fitDataScalingLaw({ points, min_points: 4, rmsd_gate: 0.1 });
  assert.equal(fit.basis, 'rectified');
  const measurements = [{ signal: 'dsir', dk_per_ktoken: 0.5, significant: true }];
  const fresh = allocateDataBudget({ measurements, budget: 500, fit, current_pairs: 50 });
  const saturated = allocateDataBudget({ measurements, budget: 500, fit, current_pairs: 1500 });
  assert.ok(saturated.saturation <= fresh.saturation, 'later corpus is at least as saturated');
  assert.ok(saturated.saturation < 1, 'saturation throttle active deep in the curve');
});

test('allocateDataBudget: zero budget -> all zeros', () => {
  const a = allocateDataBudget({ measurements: [{ signal: 'dsir', dk_per_ktoken: 1 }], budget: 0 });
  assert.equal(a.basis, 'empty-budget');
  for (const s of VALUATION_SIGNALS) assert.equal(a.allocation[s], 0);
});

// ── 5. leaderboard block for the curate/compile report ────────────────────────

test('buildValuationLeaderboardBlock ranks signals by realized payoff + names the winner', () => {
  const measurements = [
    { signal: 'shapley', basis: 'measured', delta_K: 0.02, dk_per_ktoken: 0.1, teacher_tokens: 200, ci: { lo: 0.005, hi: 0.03, significant: true }, signature_ed25519: { signature: 'x' } },
    { signal: 'dsir', basis: 'measured', delta_K: 0.05, dk_per_ktoken: 0.5, teacher_tokens: 100, ci: { lo: 0.03, hi: 0.07, significant: true }, signature_ed25519: { signature: 'y' } },
    { signal: 'diversity', basis: 'measured', delta_K: 0.01, dk_per_ktoken: 0.05, teacher_tokens: 200, ci: { lo: -0.01, hi: 0.03, significant: false } },
    { signal: 'semdedup-kept', basis: 'unmeasured', delta_K: null, dk_per_ktoken: null },
  ];
  const alloc = allocateDataBudget({ measurements, budget: 200 });
  const block = buildValuationLeaderboardBlock({ measurements, allocation: alloc });

  assert.equal(block.block_kind, VALUATION_BLOCK_KIND);
  assert.equal(block.leaderboard[0].signal, 'dsir', 'most efficient significant signal ranks #1');
  assert.equal(block.leaderboard[0].rank, 1);
  assert.equal(block.leaderboard[0].signed, true);
  assert.equal(block.winner.signal, 'dsir');
  assert.equal(block.winner.significant, true);
  // unmeasured signal sinks to the bottom.
  assert.equal(block.leaderboard[block.leaderboard.length - 1].signal, 'semdedup-kept');
  // the report records the next-batch plan the payoff drove.
  assert.ok(block.next_batch_allocation && typeof block.next_batch_allocation === 'object');
  assert.ok(/dsir/.test(block.interpretation_hint));
});

test('buildValuationLeaderboardBlock handles the empty / all-unmeasured case', () => {
  const block = buildValuationLeaderboardBlock({ measurements: [] });
  assert.equal(block.winner, null);
  assert.ok(/No signal/.test(block.interpretation_hint));
});

// ── 6. end-to-end: measure two signals, allocate, leaderboard ─────────────────

test('end-to-end: a paying signal beats a noise signal, drives more next-batch budget', async () => {
  const runDistillEval = makeRunner({ floor: 0.5, slope: 0.45 });
  const baseline = Array.from({ length: 10 }, (_, i) => pair(`b${i}`, false));
  const filler = Array.from({ length: 10 }, (_, i) => pair(`f${i}`, false));

  // "dsir" adds GOOD pairs; "diversity" adds noise (good:false) -> ~no delta.
  const dsir = await measureSignalDelta({
    signal: 'dsir', baseline,
    added: Array.from({ length: 10 }, (_, i) => pair(`g${i}`, true, 300)),
    filler, runDistillEval, bootstrap_iters: 800,
  });
  const diversity = await measureSignalDelta({
    signal: 'diversity', baseline,
    added: Array.from({ length: 10 }, (_, i) => pair(`n${i}`, false, 300)),
    filler, runDistillEval, bootstrap_iters: 800,
  });

  assert.ok(dsir.delta_K > diversity.delta_K, 'good-pair signal pays off more');
  assert.ok(dsir.dk_per_ktoken > 0);

  const measurements = [dsir, diversity];
  const alloc = allocateDataBudget({ measurements, budget: 600, explore_floor: 0.05 });
  assert.ok(alloc.allocation['dsir'] > alloc.allocation['diversity'], 'budget follows realized payoff');

  const block = buildValuationLeaderboardBlock({ measurements, allocation: alloc });
  assert.equal(block.winner.signal, 'dsir');
});
