// W921 — conformal-calibration + three-state gate tests (src/judge-calibration.js).
//
// Pins:
//  1) COVERAGE: seeded calibration, empirical coverage within [1-alpha, 1-alpha+1/(n+1)] band
//  2) QUANTILE formula: ceil((n+1)(1-alpha))/n index; +inf clamp edge
//  3) ORDINAL adjustment: integer bounds, shrink never widens
//  4) MONDRIAN: per-category coverage; thin category -> insufficient_data
//  5) THREE-STATE: above->ship, straddle->abstain, below->reject; panel forces abstain
//  6) SCALAR fallback: no calibration -> basis 'scalar_fallback' matching legacy ships
//  7) attachGateDecision is additive (gate_decision is the only new field)
//  8) judgeDisagreement spread/quorum

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conformalQuantile, fitSplitConformal, ordinalBoundaryAdjust, conformalInterval,
  fitMondrianConformal, applyConformal, judgeDisagreement, decideGate,
  attachGateDecision, DEFAULT_ALPHA, GATE_DECISION_VERSION,
} from '../src/judge-calibration.js';

// Deterministic LCG so coverage tests are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 48271) % 0x7fffffff; return s / 0x7fffffff; };
}
function gauss(rnd) { let x = 0; for (let i = 0; i < 12; i++) x += rnd(); return x - 6; }

test('1) coverage guarantee (averaged over calibration fits)', () => {
  // Split-conformal guarantees marginal coverage IN EXPECTATION over calibration
  // draws (a single fit can undercover by O(1/sqrt(n))). So we average empirical
  // coverage over many independent calibration fits and assert the MEAN lands in
  // the proven band [1-alpha, 1-alpha + 1/(n+1)] within monte-carlo tolerance.
  const rnd = lcg(20250529);
  for (const alpha of [0.05, 0.1, 0.2]) {
    const n = 200;
    const FITS = 40;
    const T = 600;
    let covAcc = 0;
    for (let f = 0; f < FITS; f++) {
      const cal = Array.from({ length: n }, () => Math.abs(gauss(rnd)));
      const fit = fitSplitConformal(cal, alpha);
      let cov = 0;
      for (let i = 0; i < T; i++) if (Math.abs(gauss(rnd)) <= fit.qhat) cov++;
      covAcc += cov / T;
    }
    const meanCov = covAcc / FITS;
    // Marginal coverage band: [1-alpha, 1-alpha + 1/(n+1)] with MC slack.
    assert.ok(meanCov >= (1 - alpha) - 0.015, `alpha=${alpha}: mean coverage ${meanCov.toFixed(4)} < ${1 - alpha}`);
    assert.ok(meanCov <= (1 - alpha) + 1 / (n + 1) + 0.02, `alpha=${alpha}: mean coverage ${meanCov.toFixed(4)} above band`);
  }
  // Band sanity on a single fit.
  const fit = fitSplitConformal(Array.from({ length: 500 }, () => Math.abs(gauss(rnd))), 0.1);
  assert.equal(fit.coverage_lo, 0.9);
  assert.ok(fit.coverage_hi <= 0.9 + 1 / 501 + 1e-9);
});

test('2) quantile formula + +inf clamp edge', () => {
  // n=3, alpha=0.25 -> ceil(4*0.75)=3 -> 3rd smallest = 0.3
  assert.equal(conformalQuantile([0.1, 0.2, 0.3], 0.25), 0.3);
  // n=3, alpha=0.1 -> ceil(4*0.9)=4 > 3 -> +Infinity
  assert.equal(conformalQuantile([0.1, 0.2, 0.3], 0.1), Infinity);
  assert.equal(conformalQuantile([], 0.1), null);
  // +inf qhat -> trivial [0,1] band when clamp01
  const iv = conformalInterval(0.8, Infinity, { clamp01: true });
  assert.deepEqual([iv.lower, iv.upper], [0, 1]);
});

test('3) ordinal adjustment shrinks to integers, never widens', () => {
  const adj = ordinalBoundaryAdjust(3.2, 7.8);
  assert.deepEqual(adj, { lower: 4, upper: 7 });
  // shrink width <= original width
  assert.ok((adj.upper - adj.lower) <= (7.8 - 3.2));
  // degenerate interval snaps to a single integer, never empty
  const deg = ordinalBoundaryAdjust(5.4, 5.6);
  assert.ok(deg.lower <= deg.upper);
});

test('4) Mondrian per-category + thin-category insufficient_data', () => {
  const rnd = lcg(7);
  const big = Array.from({ length: 60 }, () => ({ yhat: 0.8, y: 0.8 + gauss(rnd) * 0.05 }));
  const thin = Array.from({ length: 5 }, () => ({ yhat: 0.8, y: 0.81 }));
  const map = fitMondrianConformal({ coding: big, writing: thin }, 0.1, 20);
  assert.equal(map.by_category.coding.status, 'ok');
  assert.equal(map.by_category.writing.status, 'insufficient_data');
  // applyConformal never silently borrows pooled for a thin category
  const r = applyConformal(map, 'writing', 0.8);
  assert.equal(r.status, 'insufficient_data');
  const ok = applyConformal(map, 'coding', 0.8);
  assert.equal(ok.status, 'ok');
  assert.ok(ok.qhat >= 0);
});

test('5) three-state gate: ship / abstain / reject + panel forces abstain', () => {
  const ship = decideGate({ composite: 0.9, conformal: { status: 'ok', lower: 0.87, upper: 0.93, qhat: 0.03, coverage_target: 0.9 }, gate: 0.85 });
  const abstain = decideGate({ composite: 0.86, conformal: { status: 'ok', lower: 0.80, upper: 0.92, qhat: 0.06, coverage_target: 0.9 }, gate: 0.85 });
  const reject = decideGate({ composite: 0.7, conformal: { status: 'ok', lower: 0.6, upper: 0.8, qhat: 0.1, coverage_target: 0.9 }, gate: 0.85 });
  assert.equal(ship.state, 'ship');
  assert.equal(abstain.state, 'abstain');
  assert.equal(reject.state, 'reject');
  // high spread downgrades a ship to abstain
  const downgraded = decideGate({ composite: 0.9, conformal: { status: 'ok', lower: 0.87, upper: 0.93, qhat: 0.03, coverage_target: 0.9 }, judge_spread: 0.3, n_completed: 3, gate: 0.85, sigma_max: 0.15 });
  assert.equal(downgraded.state, 'abstain');
  // quorum unmet forces abstain on a scalar ship
  const quorum = decideGate({ composite: 0.9, judge_spread: 0.05, n_completed: 1, gate: 0.85, quorum: 2 });
  assert.equal(quorum.state, 'abstain');
});

test('6) scalar fallback exactly reproduces legacy ships', () => {
  assert.equal(decideGate({ composite: 0.851, gate: 0.85 }).state, 'ship');
  assert.equal(decideGate({ composite: 0.849, gate: 0.85 }).state, 'reject');
  assert.equal(decideGate({ composite: 0.851, gate: 0.85 }).basis, 'scalar_fallback');
});

test('7) attachGateDecision is additive', () => {
  const env = { composite: 0.9, ships: true, weights: { a: 1 }, axes: { x: 0.9 } };
  const out = attachGateDecision(env, { gate: 0.85 });
  // existing fields unchanged
  assert.equal(out.composite, 0.9);
  assert.equal(out.ships, true);
  assert.deepEqual(out.weights, { a: 1 });
  assert.deepEqual(out.axes, { x: 0.9 });
  // gate_decision is the only new field
  assert.ok(out.gate_decision);
  assert.equal(out.gate_decision.spec, GATE_DECISION_VERSION);
  assert.equal(out.gate_decision.state, 'ship');
});

test('8) judgeDisagreement spread/quorum', () => {
  const tight = judgeDisagreement([0.9, 0.91, 0.89], { sigma_max: 0.15, quorum: 2 });
  assert.equal(tight.unreliable, false);
  const split = judgeDisagreement([0.9, 0.4, 0.92], { sigma_max: 0.15, quorum: 2 });
  assert.equal(split.unreliable, true);
  assert.equal(split.reason, 'high_spread');
  const one = judgeDisagreement([0.9], { sigma_max: 0.15, quorum: 2 });
  assert.equal(one.unreliable, true);
  assert.equal(one.reason, 'quorum_unmet');
  assert.equal(judgeDisagreement([]).reason, 'no_judges');
});

test('conformal mapping via attachGateDecision (category path)', () => {
  const rnd = lcg(99);
  const big = Array.from({ length: 60 }, () => ({ yhat: 0.88, y: 0.88 + gauss(rnd) * 0.02 }));
  const map = fitMondrianConformal({ coding: big }, 0.1, 20);
  const env = { composite: 0.9 };
  const out = attachGateDecision(env, { conformal_mapping: map, category: 'coding', gate: 0.85 });
  assert.ok(['ship', 'abstain', 'reject'].includes(out.gate_decision.state));
  assert.equal(out.gate_decision.basis, 'conformal');
});
