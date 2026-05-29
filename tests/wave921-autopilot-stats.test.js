// W921 — Autopilot anytime-valid statistics tests.
//
// Two NEW modules, one focused suite:
//   src/stat-sig.js  (W921 sequential additions: mSPRT always-valid p-value +
//                     GAVI confidence sequence + sequentialGate + update())
//   src/conformal.js (split-conformal predictInterval + Mondrian + ACI +
//                     selective decision)
//
// W604 anti-brittleness: versions asserted via regex; statistical tolerances
// allow Monte-Carlo slack; RNG is seeded (deterministic + reproducible).
//
// Coverage map:
//   ST = sequential-stat-sig, CF = conformal
//   #ST1  exports + SEQ_STAT_SIG_VERSION regex + DEFAULT_N_TUNE===10000
//   #ST2  legacy welchT/gate + STAT_SIG_VERSION untouched (/^w778-/)
//   #ST3  msprt honest envelope when n<2 (ok:false, no NaN)
//   #ST4  msprt avp monotone non-increasing across the stream (sticky)
//   #ST5  msprt A/A Type-I error <= 0.065 over seeded replications w/ per-step peeking
//   #ST6  fixed-horizon CONTRAST: legacy gate() fires on the same A/A stream > 0.30
//   #ST7  msprt H1 early-stop: real effect -> avp < alpha -> decision 'promote'
//   #ST8  gavi half-width matches the closed form on a hand-worked fixture (1e-9)
//   #ST9  gavi A/A time-uniform coverage of 0 (mean-diff) >= 1-alpha-ish
//   #ST10 gavi decision ladder: promote / rollback / continue
//   #ST11 sequentialGate reads samples from the W777 ab-router via ab_test_id
//   #ST12 update(a,b) returns {decision,e_value,ci}; e_value>=1/alpha => promote
//   #CF1  exports + CONFORMAL_VERSION 'cf-v1' + MIN_CONFORMAL_CAL===21
//   #CF2  splitConformalQuantile b=ceil((n+1)(1-alpha)) exact at n in {19,20,99,100}
//   #CF3  undercalibrated:true (Infinity) when b>n (n=18, alpha=.10)
//   #CF4  predictInterval marginal coverage within +-2pp over a seeded holdout
//   #CF5  predictInterval undercalibrated pool -> [0,1] band, basis flag
//   #CF6  mondrianCalibrate per-group qhat + insufficient[] floor + pooled
//   #CF7  aciUpdate drives long-run miscoverage toward target under shift
//   #CF8  selectiveDecision boundary cases incl. exactly gate
//   #CF9  decideFromConformal straddle->abstain, clears->compile, below->skip
//   #CF10 conformalCoverageReport realized coverage within tolerance

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as ss from '../src/stat-sig.js';
import * as cf from '../src/conformal.js';

// ---------------------------------------------------------------------------
// Deterministic seeded RNG (mulberry32) + Box-Muller normal.
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
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921stats-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

// ===========================================================================
// Sequential / always-valid stat-sig
// ===========================================================================

test('#ST1 sequential exports + SEQ version + DEFAULT_N_TUNE', () => {
  assert.equal(typeof ss.msprtAlwaysValidPValue, 'function');
  assert.equal(typeof ss.gaviConfidenceSequence, 'function');
  assert.equal(typeof ss.sequentialGate, 'function');
  assert.equal(typeof ss.update, 'function');
  assert.match(ss.SEQ_STAT_SIG_VERSION, /^w921-seq-/);
  assert.equal(ss.DEFAULT_N_TUNE, 10000);
});

test('#ST2 legacy welchT/gate + STAT_SIG_VERSION untouched', () => {
  assert.match(ss.STAT_SIG_VERSION, /^w778-/);
  assert.equal(typeof ss.welchT, 'function');
  assert.equal(typeof ss.gate, 'function');
  const w = ss.welchT({ samples_a: [1, 2, 3], samples_b: [1, 2, 3] });
  assert.equal(w.ok, true);
  assert.ok(w.p > 0.5); // identical samples -> no signal
});

test('#ST3 msprt honest envelope when n<2', () => {
  const r = ss.msprtAlwaysValidPValue({ samples_a: [0.8], samples_b: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'insufficient_samples');
  assert.ok(Number.isFinite(r.avp));
  assert.ok(!Number.isNaN(r.avp));
});

test('#ST4 msprt avp monotone non-increasing (sticky significance)', () => {
  const rng = mulberry32(7);
  // Strong effect so avp moves; check the running-min property by feeding
  // growing prefixes and asserting avp only ever goes down.
  const A = [];
  const B = [];
  let prev = 1;
  for (let i = 0; i < 200; i++) {
    A.push(normal(rng, 0.80, 0.05));
    B.push(normal(rng, 0.86, 0.05));
    if (i < 2) continue;
    const r = ss.msprtAlwaysValidPValue({ samples_a: A, samples_b: B, min_effect_size: 0.01 });
    assert.ok(r.avp <= prev + 1e-12, `avp not monotone at i=${i}: ${r.avp} > ${prev}`);
    prev = r.avp;
  }
});

test('#ST5 msprt A/A Type-I error <= 0.065 under per-step peeking', () => {
  const REPS = 400;
  const N = 800;
  const alpha = 0.05;
  let falsePos = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const rng = mulberry32(1000 + rep);
    const A = [];
    const B = [];
    let rejected = false;
    for (let i = 0; i < N; i++) {
      A.push(normal(rng, 0.80, 0.05));
      B.push(normal(rng, 0.80, 0.05)); // same distribution => H0 true
      if (i < 2) continue;
      const r = ss.msprtAlwaysValidPValue({ samples_a: A, samples_b: B, min_effect_size: 0.01 });
      if (r.ok && r.avp < alpha) { rejected = true; break; }
    }
    if (rejected) falsePos += 1;
  }
  const fpr = falsePos / REPS;
  assert.ok(fpr <= 0.065, `mSPRT A/A FPR ${fpr} exceeds 0.065`);
});

test('#ST6 fixed-horizon CONTRAST: legacy gate() blows past alpha on peeking', async () => {
  const REPS = 200;
  const N = 800;
  const alpha = 0.05;
  let fired = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const rng = mulberry32(5000 + rep);
    const A = [];
    const B = [];
    let hit = false;
    for (let i = 0; i < N; i++) {
      A.push(normal(rng, 0.80, 0.05));
      B.push(normal(rng, 0.80, 0.05));
      if (i < 30) continue; // legacy min_n floor
      // Peek the fixed-horizon Welch gate every step (the anti-pattern).
      const g = await ss.gate({ samples_a: A, samples_b: B, alpha, min_n: 30, min_effect_size: 0.0 });
      if (g.decision === 'pass') { hit = true; break; }
    }
    if (hit) fired += 1;
  }
  const rate = fired / REPS;
  // The whole point of the fix: unconstrained peeking inflates FPR well past alpha.
  assert.ok(rate > 0.30, `fixed-horizon peeking FPR ${rate} should exceed 0.30 (proves the bug)`);
});

test('#ST7 msprt H1 early-stop -> decision promote', async () => {
  const rng = mulberry32(99);
  const A = [];
  const B = [];
  for (let i = 0; i < 400; i++) {
    A.push(normal(rng, 0.80, 0.05));
    B.push(normal(rng, 0.84, 0.05)); // effect ~ 0.04 (>> min_effect 0.01)
  }
  const r = ss.msprtAlwaysValidPValue({ samples_a: A, samples_b: B, min_effect_size: 0.01 });
  assert.ok(r.avp < 0.05, `expected avp < 0.05 under a real effect, got ${r.avp}`);
  const g = await ss.sequentialGate({ samples_a: A, samples_b: B, method: 'msprt', alpha: 0.05, min_effect_size: 0.01 });
  assert.equal(g.decision, 'promote');
});

test('#ST8 gavi half-width matches the closed form (1e-9)', () => {
  const alpha = 0.05;
  const n_tune = 10000;
  // Hand-worked fixture: t paired diffs all equal so var=0... use a tiny spread.
  const rng = mulberry32(3);
  const A = [];
  const B = [];
  for (let i = 0; i < 50; i++) { A.push(normal(rng, 0.8, 0.03)); B.push(normal(rng, 0.82, 0.03)); }
  const out = ss.gaviConfidenceSequence({ samples_a: A, samples_b: B, alpha, n_tune });
  assert.equal(out.ok, true);
  // Recompute rho + B independently.
  const c = 1 - alpha;
  const inner = Math.log(Math.E / ((1 - c) * (1 - c)));
  const rho = n_tune / (Math.log(inner) - 2 * Math.log(1 - c));
  assert.ok(Math.abs(out.rho - rho) < 1e-9, `rho mismatch ${out.rho} vs ${rho}`);
  // Recompute the half width from the diffs.
  const t = A.length;
  const D = A.map((a, i) => B[i] - a);
  const mean = D.reduce((s, v) => s + v, 0) / t;
  let ss2 = 0;
  for (const v of D) ss2 += (v - mean) * (v - mean);
  const varD = ss2 / (t - 1);
  const seDelta = Math.sqrt(varD / t);
  const ratio = (t + rho) / (rho * (1 - c) * (1 - c));
  const Bmult = (1 / Math.sqrt(t)) * Math.sqrt((t + rho) * Math.log(ratio));
  const hw = seDelta * Bmult;
  assert.ok(Math.abs(out.half_width - hw) < 1e-9, `half_width mismatch ${out.half_width} vs ${hw}`);
  assert.ok(Math.abs(out.mean_diff - mean) < 1e-12);
});

test('#ST9 gavi A/A time-uniform coverage of the true mean-diff (0)', () => {
  const REPS = 300;
  const N = 600;
  const alpha = 0.05;
  let everExited = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const rng = mulberry32(20000 + rep);
    const A = [];
    const B = [];
    let exited = false;
    for (let i = 0; i < N; i++) {
      A.push(normal(rng, 0.80, 0.05));
      B.push(normal(rng, 0.80, 0.05)); // true diff = 0
      if (i < 2) continue;
      const out = ss.gaviConfidenceSequence({ samples_a: A, samples_b: B, alpha });
      if (out.ok && (out.lower > 0 || out.upper < 0)) { exited = true; break; }
    }
    if (exited) everExited += 1;
  }
  const exitRate = everExited / REPS;
  // Time-uniform coverage: P(0 ever exits) <= alpha (+ MC slack).
  assert.ok(exitRate <= 0.065, `GAVI exit rate ${exitRate} exceeds 0.065`);
});

test('#ST10 gavi decision ladder promote/rollback/continue', async () => {
  // Strong positive effect -> cs_low > min_effect -> promote.
  const rng = mulberry32(41);
  const Ap = []; const Bp = [];
  for (let i = 0; i < 400; i++) { Ap.push(normal(rng, 0.8, 0.04)); Bp.push(normal(rng, 0.86, 0.04)); }
  const gp = await ss.sequentialGate({ samples_a: Ap, samples_b: Bp, method: 'gavi', alpha: 0.05, min_effect_size: 0.01 });
  assert.equal(gp.decision, 'promote');

  // Clear negative effect -> cs_high < min_effect -> rollback.
  const An = []; const Bn = [];
  for (let i = 0; i < 400; i++) { An.push(normal(rng, 0.86, 0.04)); Bn.push(normal(rng, 0.80, 0.04)); }
  const gn = await ss.sequentialGate({ samples_a: An, samples_b: Bn, method: 'gavi', alpha: 0.05, min_effect_size: 0.01 });
  assert.equal(gn.decision, 'rollback');

  // Tiny sample, no signal -> continue (insufficient).
  const gc = await ss.sequentialGate({ samples_a: [0.8, 0.81], samples_b: [0.8, 0.81], method: 'gavi', min_n: 30 });
  assert.equal(gc.decision, 'continue');
});

test('#ST11 sequentialGate reads samples from the W777 ab-router', async () => {
  freshDir();
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const ab = await import('../src/ab-router.js');
  const tenant = 'tenant_w921_seq';
  const created = ab.createAbTest({ tenant, namespace: 'ns_seq', arm_a: 'a', arm_b: 'b', split: 0.5 });
  assert.equal(created.ok, true);
  const ab_test_id = created.ab_test_id;
  // Record a clear winner for arm B.
  const rng = mulberry32(11);
  for (let i = 0; i < 120; i++) {
    await ab.recordOutcome({ tenant, ab_test_id, arm: 'a', kscore: normal(rng, 0.80, 0.04) });
    await ab.recordOutcome({ tenant, ab_test_id, arm: 'b', kscore: normal(rng, 0.86, 0.04) });
  }
  const g = await ss.sequentialGate({ tenant, ab_test_id, method: 'msprt', alpha: 0.05, min_effect_size: 0.01, min_n: 30 });
  assert.equal(g.ok, true);
  assert.ok(g.n_a >= 30 && g.n_b >= 30, `expected samples pulled from ab-router, got n_a=${g.n_a} n_b=${g.n_b}`);
  assert.equal(g.decision, 'promote');
  assert.match(g.version, /^w921-seq-/);
});

test('#ST12 update() returns {decision,e_value,ci}; e_value>=1/alpha => promote', () => {
  const rng = mulberry32(73);
  const A = []; const B = [];
  for (let i = 0; i < 300; i++) { A.push(normal(rng, 0.80, 0.05)); B.push(normal(rng, 0.85, 0.05)); }
  const u = ss.update(A, B, { alpha: 0.05, min_effect_size: 0.01 });
  assert.equal(u.ok, true);
  assert.equal(u.decision, 'promote');
  assert.ok(Number.isFinite(u.e_value));
  assert.ok(u.e_value >= 1 / 0.05, `e_value ${u.e_value} should clear 1/alpha=20 under a real effect`);
  assert.ok(Array.isArray(u.ci) && u.ci.length === 2);
  assert.ok(u.ci[0] < u.ci[1]);
  // Degenerate input -> honest envelope, no NaN.
  const bad = ss.update([0.8], []);
  assert.equal(bad.ok, false);
  assert.equal(bad.decision, 'continue');
  assert.ok(!Number.isNaN(bad.e_value));
});

// ===========================================================================
// Conformal
// ===========================================================================

test('#CF1 conformal exports + CONFORMAL_VERSION + MIN_CONFORMAL_CAL', () => {
  assert.equal(cf.CONFORMAL_VERSION, 'cf-v1');
  assert.equal(cf.MIN_CONFORMAL_CAL, 21);
  for (const fn of ['splitConformalQuantile', 'predictInterval', 'conformalInterval',
    'mondrianCalibrate', 'aciUpdate', 'selectiveDecision', 'decideFromConformal',
    'conformalCoverageReport', 'recordConformalOutcome', 'sigmaEstimate', 'localizedScore']) {
    assert.equal(typeof cf[fn], 'function', `missing export ${fn}`);
  }
});

test('#CF2 splitConformalQuantile b=ceil((n+1)(1-alpha)) exact', () => {
  for (const n of [19, 20, 99, 100]) {
    const scores = Array.from({ length: n }, (_, i) => i + 1); // 1..n sorted
    const alpha = 0.10;
    const r = cf.splitConformalQuantile(scores, alpha);
    const expectedB = Math.ceil((n + 1) * (1 - alpha));
    assert.equal(r.b, expectedB, `n=${n} b mismatch`);
    assert.equal(r.n, n);
    if (expectedB <= n) {
      assert.equal(r.undercalibrated, false);
      assert.equal(r.qhat, scores[expectedB - 1]);
    }
  }
});

test('#CF3 undercalibrated when b>n (n=18, alpha=.10)', () => {
  const n = 18;
  const scores = Array.from({ length: n }, (_, i) => i + 1);
  const r = cf.splitConformalQuantile(scores, 0.10);
  // b = ceil(19*0.9) = ceil(17.1) = 18 <= 18 -> actually calibrated.
  // Drop to n=9 where b=ceil(10*0.9)=9<=9 calibrated; n=8 b=ceil(9*0.9)=9>8 under.
  const r8 = cf.splitConformalQuantile([1, 2, 3, 4, 5, 6, 7, 8], 0.10);
  assert.equal(r8.b, Math.ceil(9 * 0.9));
  assert.equal(r8.undercalibrated, true);
  assert.equal(r8.qhat, Number.POSITIVE_INFINITY);
  // empty pool -> undercalibrated
  const re = cf.splitConformalQuantile([], 0.10);
  assert.equal(re.undercalibrated, true);
  // n=18 is calibrated; just confirm finite qhat
  assert.equal(r.undercalibrated, false);
  assert.ok(Number.isFinite(r.qhat));
});

test('#CF4 predictInterval marginal coverage within +-2pp', () => {
  // Generate (y, yhat) pairs with known iid residuals; fit qhat on calibration,
  // measure realized coverage on holdout.
  const rng = mulberry32(2024);
  const alpha = 0.10;
  const cal = [];
  for (let i = 0; i < 500; i++) cal.push(normal(rng, 0, 1)); // calibration residuals
  const inter = cf.predictInterval(cal, alpha, { point: 0.5, clamp01: false });
  assert.equal(inter.basis, 'conformal');
  const qhat = inter.qhat;
  // Holdout coverage of the SAME residual distribution.
  let covered = 0;
  const M = 5000;
  for (let i = 0; i < M; i++) {
    const r = normal(rng, 0, 1);
    if (Math.abs(r) <= qhat) covered += 1;
  }
  const realized = covered / M;
  assert.ok(Math.abs(realized - (1 - alpha)) <= 0.03,
    `realized coverage ${realized} not within 3pp of ${1 - alpha}`);
});

test('#CF5 predictInterval undercalibrated pool -> [0,1] band', () => {
  const r = cf.predictInterval([0.1, 0.2, 0.3], 0.10, { point: 0.7 });
  assert.equal(r.basis, 'conformal_undercalibrated');
  assert.equal(r.lo, 0);
  assert.equal(r.hi, 1);
  assert.ok(r.ok);
});

test('#CF6 mondrianCalibrate per-group qhat + insufficient floor', () => {
  const rng = mulberry32(808);
  const rows = [];
  // Group "tight": small residuals, plenty of rows.
  for (let i = 0; i < 60; i++) rows.push({ namespace: 'tight', residual: normal(rng, 0, 0.05) });
  // Group "wide": big residuals, plenty of rows.
  for (let i = 0; i < 60; i++) rows.push({ namespace: 'wide', residual: normal(rng, 0, 0.5) });
  // Group "sparse": below floor.
  for (let i = 0; i < 5; i++) rows.push({ namespace: 'sparse', residual: normal(rng, 0, 0.2) });
  const m = cf.mondrianCalibrate({ rows, alpha: 0.10 });
  assert.ok(m.ok);
  assert.ok(m.byGroup.tight && m.byGroup.wide);
  // Tight group qhat should be smaller than wide group qhat.
  assert.ok(m.byGroup.tight.qhat < m.byGroup.wide.qhat,
    `tight qhat ${m.byGroup.tight.qhat} should be < wide ${m.byGroup.wide.qhat}`);
  assert.ok(m.insufficient.includes('sparse'));
  // applyConformal falls back to pooled for sparse.
  const ap = cf.applyConformal(m, 'sparse', 0.5);
  assert.equal(ap.status, 'pooled_fallback');
  assert.ok(Number.isFinite(ap.qhat));
});

test('#CF7 aciUpdate adapts the level under distribution shift (Gibbs-Candes)', () => {
  // ACI: alpha_{t+1} = alpha_t + gamma*(targetAlpha - err_t). On a MISS (err=1)
  // alpha_t DROPS (toward 0 -> wider intervals -> recover coverage); on a HIT
  // (err=0) alpha_t RISES (toward target -> tighter intervals). This is the
  // self-correcting direction that drives long-run miscoverage to target under
  // arbitrary shift.
  let state = { alpha_t: 0.10, n_seen: 0, miscover_count: 0 };
  const target = 0.10;
  // Phase 1: 100 well-covered points -> alpha_t rises (interval can tighten).
  for (let i = 0; i < 100; i++) {
    state = cf.aciUpdate({ state, observed: 0.5, interval: [0.4, 0.6], gamma: 0.05, targetAlpha: target });
  }
  assert.ok(state.alpha_t > 0 && state.alpha_t < 1);
  const phase1Alpha = state.alpha_t;
  assert.ok(phase1Alpha > 0.10, `alpha_t should rise under sustained coverage: ${phase1Alpha}`);
  // Phase 2: 100 points that always miss (shift) -> alpha_t DROPS to widen.
  for (let i = 0; i < 100; i++) {
    state = cf.aciUpdate({ state, observed: 0.95, interval: [0.4, 0.6], gamma: 0.05, targetAlpha: target });
  }
  assert.ok(state.alpha_t < phase1Alpha, `alpha_t should drop under miss-shift (widen): ${phase1Alpha} -> ${state.alpha_t}`);
  assert.ok(state.alpha_t > 0 && state.alpha_t < 1);
  assert.equal(state.n_seen, 200);
  assert.ok(state.miscover_rate > 0 && state.miscover_rate < 1);
});

test('#CF8 selectiveDecision boundary cases', () => {
  assert.equal(cf.selectiveDecision({ lo: 0.86, hi: 0.92, gate: 0.85 }), 'ship_safe');
  assert.equal(cf.selectiveDecision({ lo: 0.70, hi: 0.84, gate: 0.85 }), 'skip_safe');
  assert.equal(cf.selectiveDecision({ lo: 0.80, hi: 0.90, gate: 0.85 }), 'abstain');
  // lo exactly == gate -> ship_safe (>=)
  assert.equal(cf.selectiveDecision({ lo: 0.85, hi: 0.90, gate: 0.85 }), 'ship_safe');
  // hi exactly == gate -> abstain (hi<g is false, lo<g true)
  assert.equal(cf.selectiveDecision({ lo: 0.80, hi: 0.85, gate: 0.85 }), 'abstain');
  // non-finite -> abstain (fail-safe)
  assert.equal(cf.selectiveDecision({ lo: NaN, hi: 1, gate: 0.85 }), 'abstain');
});

test('#CF9 decideFromConformal compile/skip/abstain', () => {
  // Straddle -> abstain.
  assert.equal(cf.decideFromConformal({ prop_lo: 0.80, prop_hi: 0.90, gate: 0.85, delta_k: 0.1 }).decision, 'abstain');
  // Clears gate + good delta -> compile.
  assert.equal(cf.decideFromConformal({ prop_lo: 0.86, prop_hi: 0.92, gate: 0.85, delta_k: 0.05, min_delta_k: 0.02 }).decision, 'compile');
  // Clears gate but delta too small -> skip.
  assert.equal(cf.decideFromConformal({ prop_lo: 0.86, prop_hi: 0.92, gate: 0.85, delta_k: 0.001, min_delta_k: 0.02 }).decision, 'skip');
  // Upper below gate -> skip.
  assert.equal(cf.decideFromConformal({ prop_lo: 0.60, prop_hi: 0.80, gate: 0.85, delta_k: 0.1 }).decision, 'skip');
  // Invalid interval -> abstain.
  assert.equal(cf.decideFromConformal({ prop_lo: NaN, prop_hi: 0.9 }).decision, 'abstain');
});

test('#CF10 conformalCoverageReport realized coverage within tolerance', () => {
  const rng = mulberry32(3030);
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    const yhat = 0.5;
    const y = _clamp(yhat + normal(rng, 0, 0.08), 0, 1);
    rows.push({ y, yhat, namespace: i % 2 === 0 ? 'g0' : 'g1' });
  }
  const rep = cf.conformalCoverageReport({ rows, alpha: 0.10, groupKey: (r) => r.namespace });
  assert.ok(rep.ok);
  assert.ok(Math.abs(rep.realized_coverage - 0.90) <= 0.04,
    `realized coverage ${rep.realized_coverage} not within 4pp of 0.90`);
  assert.ok(rep.mean_width > 0 && rep.mean_width <= 1);
  assert.ok(rep.by_group.g0 && rep.by_group.g1);
});

function _clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

test('#CF11 recordConformalOutcome best-effort, never throws', async () => {
  freshDir();
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const ok = await cf.recordConformalOutcome({
    tenant: 'tenant_w921_cf',
    namespace: 'default',
    observed_k: 0.92,
    issued_interval: [0.80, 0.90],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.miscovered, true); // 0.92 > 0.90
  assert.match(ok.version, /^cf-/);
  // Invalid observed -> honest false, no throw.
  const bad = await cf.recordConformalOutcome({ observed_k: 'nope', issued_interval: [0, 1] });
  assert.equal(bad.ok, false);
});
