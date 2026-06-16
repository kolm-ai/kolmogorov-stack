// FINALIZED-C6 - significance-bounded, multiplicity-controlled promotion gate.
//
// Proves the spec for src/significance-bounded-gate.js + significance-bounded-receipt.js:
//
//  1) PAIRED BOOTSTRAP CI is computed on the per-case DELTA vector (not a point
//     composite); lower-CI clearing the threshold drives promotion.
//  2) STRADDLING CI -> abstain (a point delta over the line but a noisy lower
//     bound below it must NOT promote).
//  3) ALWAYS-VALID p-value (mSPRT) is computed on the per-case vectors and feeds
//     the decision (sticky / safe under peeking).
//  4) MULTIPLICITY: Benjamini-Hochberg FDR + Holm FWER correct the joint family
//     {composite, axes, subgroups, regressions}; BH matches a hand reference and
//     Holm is more conservative.
//  5) FDR control under repeated multi-axis peeking: under H0 (no true effect)
//     the realized false-promotion rate is bounded at alpha.
//  6) REGRESSION CLASS: a corrected-significant per-case pass-rate DROP BLOCKS.
//  7) FAIL-CLOSED: insufficient samples -> abstain, never promote.
//  8) RECEIPT BINDING: the signed eval_summary carries the test family, alpha,
//     correction method, and corrected p-values; tampering breaks verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairedBootstrapCI,
  benjaminiHochberg,
  holm,
  correctFamily,
  buildTestFamily,
  significanceBoundedGate,
  buildSignificanceEvalSummary,
  SIG_BOUNDED_GATE_VERSION,
  DEFAULT_GATE,
} from '../src/significance-bounded-gate.js';
import {
  embedSignificanceReceipt,
  verifySignificanceReceipt,
} from '../src/significance-bounded-receipt.js';

// Deterministic LCG so the synthetic per-case vectors are reproducible.
function lcg(seed) {
  // Park-Miller minimal-standard LCG. Uses floating * (not imul) so the modulus
  // stays positive and the output is a clean uniform in (0,1). Seed normalized
  // into the multiplicative group [1, 2^31-2].
  let s = (seed >>> 0) % 0x7fffffff;
  if (s === 0) s = 1;
  return () => { s = (s * 48271) % 0x7fffffff; return s / 0x7fffffff; };
}
function gauss(rnd) { let x = 0; for (let i = 0; i < 12; i++) x += rnd(); return x - 6; }

// Build a paired eval: baseline scores ~ N(mu_b, sd), candidate = baseline + lift
// + independent noise. Returns { candidate, baseline } artifact refs with per_case.
function makeEval({ n, mu_b = 0.80, sd = 0.05, lift = 0.05, noise = 0.02, seed = 1,
                    axes = {}, subgroups = {}, regressions = {} } = {}) {
  const rnd = lcg(seed);
  const base = [], cand = [];
  for (let i = 0; i < n; i++) {
    const b = mu_b + sd * gauss(rnd);
    const c = b + lift + noise * gauss(rnd);
    base.push(b); cand.push(c);
  }
  const cper = { composite: cand, axes: {}, subgroups: {}, regression_classes: {} };
  const bper = { composite: base, axes: {}, subgroups: {}, regression_classes: {} };
  for (const [k, spec] of Object.entries(axes)) {
    const a = makeEval({ n, mu_b: spec.mu_b ?? mu_b, sd, lift: spec.lift ?? 0, noise, seed: seed + 17 + k.length });
    cper.axes[k] = a.candidate.per_case.composite;
    bper.axes[k] = a.baseline.per_case.composite;
  }
  for (const [k, spec] of Object.entries(subgroups)) {
    const a = makeEval({ n, mu_b: spec.mu_b ?? mu_b, sd, lift: spec.lift ?? 0, noise, seed: seed + 41 + k.length });
    cper.subgroups[k] = a.candidate.per_case.composite;
    bper.subgroups[k] = a.baseline.per_case.composite;
  }
  for (const [k, spec] of Object.entries(regressions)) {
    // per-case pass(1)/fail(0). drop=true makes candidate pass-rate fall.
    const cArr = [], bArr = [];
    const r2 = lcg(seed + 91 + k.length);
    const pBase = spec.pBase ?? 0.95;
    const pCand = spec.drop ? (spec.pCand ?? 0.60) : (spec.pCand ?? 0.96);
    for (let i = 0; i < n; i++) {
      bArr.push(r2() < pBase ? 1 : 0);
      cArr.push(r2() < pCand ? 1 : 0);
    }
    cper.regression_classes[k] = cArr;
    bper.regression_classes[k] = bArr;
  }
  return {
    candidate: { id: 'cand-' + seed, per_case: cper },
    baseline: { id: 'base-' + seed, per_case: bper },
  };
}

// ---------------------------------------------------------------------------
test('1) paired bootstrap CI is on the per-case delta, lower-CI drives promote', () => {
  // Strong, low-noise lift of ~0.05 over a 0.02 threshold: lower-CI must clear.
  const ev = makeEval({ n: 200, lift: 0.05, noise: 0.01, seed: 7 });
  const ci = pairedBootstrapCI({
    candidate_per_case: ev.candidate.per_case.composite,
    baseline_per_case: ev.baseline.per_case.composite,
    alpha: 0.05, n_iters: 2000, method: 'bca', seed: 123,
  });
  assert.equal(ci.ok, true);
  assert.equal(ci.method, 'bca');
  assert.ok(ci.ci_low < ci.point && ci.point < ci.ci_high, 'point inside CI');
  assert.ok(ci.ci_low > 0.02, 'lower-CI clears the 0.02 threshold: ' + ci.ci_low);
  // The CI is on the DELTA, so the point estimate ~ lift, not ~ candidate mean.
  assert.ok(Math.abs(ci.point - 0.05) < 0.01, 'point ~ lift 0.05, got ' + ci.point);
});

test('2) straddling CI (point above line, noisy) -> abstain, never promote', () => {
  // Tiny lift just above the threshold but HIGH noise: the point delta clears
  // 0.02 yet the lower-CI does not -> the gate must abstain, not promote.
  const ev = makeEval({ n: 40, lift: 0.025, noise: 0.12, seed: 13 });
  const fam = buildTestFamily({ candidate: ev.candidate, baseline: ev.baseline });
  const g = significanceBoundedGate({
    family: fam, alpha: 0.05, min_kscore_delta: 0.02,
    bootstrap_iters: 2000, seed: 99, min_samples: 12,
  });
  assert.notEqual(g.decision, 'promote', 'must not promote on a straddling CI');
  assert.equal(g.decision, 'abstain');
  // The composite lower-CI must indeed be below the threshold for this to hold.
  assert.ok(g.composite.ci_low < 0.02, 'lower-CI below threshold: ' + g.composite.ci_low);
});

test('3) always-valid (mSPRT) p-value is computed on per-case vectors + drives decision', () => {
  const ev = makeEval({ n: 300, lift: 0.05, noise: 0.01, seed: 21 });
  const fam = buildTestFamily({ candidate: ev.candidate, baseline: ev.baseline });
  const g = significanceBoundedGate({ family: fam, alpha: 0.05, min_kscore_delta: 0.02, seed: 5 });
  const comp = g.composite;
  // avp is a real always-valid p-value in [0,1] and the strong effect makes it small.
  assert.ok(comp.avp >= 0 && comp.avp <= 1, 'avp in [0,1]');
  assert.ok(comp.avp < 0.05, 'strong effect -> small always-valid p: ' + comp.avp);
  assert.ok(comp.corrected_significant, 'composite corrected-significant');
  assert.equal(g.decision, 'promote');

  // Under H0 (no lift) the always-valid p must NOT clear alpha -> abstain.
  const h0 = makeEval({ n: 300, lift: 0.0, noise: 0.03, seed: 22 });
  const fam0 = buildTestFamily({ candidate: h0.candidate, baseline: h0.baseline });
  const g0 = significanceBoundedGate({ family: fam0, alpha: 0.05, min_kscore_delta: 0.02, seed: 5 });
  assert.notEqual(g0.decision, 'promote', 'no effect -> never promote');
});

test('4) BH + Holm correct the joint family; BH matches reference, Holm stricter', () => {
  // Hand reference (Benjamini-Hochberg 1995): m=5 sorted p-values.
  //   thresholds (k/m)*0.05 = [0.01, 0.02, 0.03, 0.04, 0.05]
  //   p_(k)                  = [0.005,0.01, 0.03, 0.04, 0.2 ]
  //   largest k with p_(k) <= threshold: k=4 (0.04 <= 0.04) -> reject ranks 1..4.
  const ps = [0.005, 0.01, 0.03, 0.04, 0.2];
  const bh = benjaminiHochberg(ps, 0.05);
  assert.deepEqual([...bh.rejected].sort((a, b) => a - b), [0, 1, 2, 3], 'BH rejects ranks 1..4');
  assert.ok(!bh.rejected.has(4), 'BH does not reject p=0.2');
  // BH adjusted q-values monotone (in sorted order) and bounded.
  for (const q of bh.adjusted) assert.ok(q >= 0 && q <= 1);

  const hl = holm(ps, 0.05);
  // Holm: p_(1)=0.005 vs 0.05/5=0.01 reject; p_(2)=0.01 vs 0.05/4=0.0125 reject;
  //   p_(3)=0.03 vs 0.05/3=0.0167 NO -> step-down stops. So {0,1} only.
  assert.deepEqual([...hl.rejected].sort((a, b) => a - b), [0, 1], 'Holm rejects only the two smallest');
  assert.ok(hl.rejected.size < bh.rejected.size, 'Holm strictly more conservative than BH here');
  // Holm adjusted >= BH adjusted pointwise (FWER stricter than FDR).
  for (let i = 0; i < ps.length; i++) {
    assert.ok(hl.adjusted[i] + 1e-9 >= bh.adjusted[i], 'Holm adj >= BH adj at ' + i);
  }
  // correctFamily dispatches.
  assert.equal(correctFamily(ps, 0.05, 'holm').method, 'holm');
  assert.equal(correctFamily(ps, 0.05, 'bh').method, 'bh');
});

test('5) FDR/peeking control: under H0 across a multi-axis family, false-promotion <= alpha', () => {
  // Repeated trials, each an A/A comparison (NO true effect) with a multi-axis
  // family. With BH FDR at alpha=0.05 the realized PROMOTE rate must stay at or
  // below alpha (with monte-carlo slack). This is the multiplicity guarantee.
  const TRIALS = 120;
  const alpha = 0.05;
  let promoted = 0;
  for (let t = 0; t < TRIALS; t++) {
    const ev = makeEval({
      n: 120, lift: 0.0, noise: 0.03, seed: 1000 + t,
      axes: { accuracy: { lift: 0 }, coverage: { lift: 0 }, latency: { lift: 0 } },
      subgroups: { region_eu: { lift: 0 }, region_us: { lift: 0 } },
    });
    const fam = buildTestFamily({ candidate: ev.candidate, baseline: ev.baseline });
    const g = significanceBoundedGate({
      family: fam, alpha, min_kscore_delta: 0.02, correction: 'bh',
      bootstrap_iters: 800, seed: t + 1, min_samples: 12,
    });
    if (g.decision === 'promote') promoted++;
  }
  const rate = promoted / TRIALS;
  // The combined lower-CI-clears-threshold + corrected-significance requirement
  // makes the realized false-promotion rate well under alpha. Allow MC slack.
  assert.ok(rate <= alpha + 0.05, 'false-promotion rate ' + rate + ' bounded near alpha ' + alpha);
});

test('6) regression class: corrected-significant per-case pass-rate DROP blocks', () => {
  // Composite genuinely improves, but a regression class drops pass-rate.
  const ev = makeEval({
    n: 200, lift: 0.05, noise: 0.01, seed: 33,
    regressions: { sql_injection: { drop: true, pBase: 0.97, pCand: 0.55 } },
  });
  const fam = buildTestFamily({ candidate: ev.candidate, baseline: ev.baseline });
  const g = significanceBoundedGate({
    family: fam, alpha: 0.05, min_kscore_delta: 0.02, correction: 'bh',
    bootstrap_iters: 2000, seed: 7, min_samples: 12,
  });
  assert.equal(g.decision, 'block', 'a corrected-significant regression must block');
  assert.ok(Array.isArray(g.fired_regressions) && g.fired_regressions.includes('regression:sql_injection'));

  // Control: same composite gain, NO regression drop -> promote.
  const ev2 = makeEval({
    n: 200, lift: 0.05, noise: 0.01, seed: 33,
    regressions: { sql_injection: { drop: false } },
  });
  const fam2 = buildTestFamily({ candidate: ev2.candidate, baseline: ev2.baseline });
  const g2 = significanceBoundedGate({ family: fam2, alpha: 0.05, min_kscore_delta: 0.02, seed: 7 });
  assert.equal(g2.decision, 'promote');
});

test('7) fail-closed: insufficient samples -> abstain, never promote', () => {
  // Big, clean lift but only 5 paired cases (< min_samples 12).
  const ev = makeEval({ n: 5, lift: 0.20, noise: 0.001, seed: 3 });
  const fam = buildTestFamily({ candidate: ev.candidate, baseline: ev.baseline });
  const g = significanceBoundedGate({ family: fam, alpha: 0.05, min_kscore_delta: 0.02, min_samples: 12, seed: 1 });
  assert.equal(g.decision, 'abstain', 'underpowered family must abstain even on a huge point lift');
  assert.match(g.reason, /insufficient_samples/);

  // No per-case vectors at all -> abstain.
  const fam2 = buildTestFamily({ candidate: { id: 'x', k_score: 0.99 }, baseline: { id: 'y', k_score: 0.80 } });
  const g2 = significanceBoundedGate({ family: fam2, alpha: 0.05, min_kscore_delta: 0.02 });
  assert.equal(g2.decision, 'abstain');

  // Direct bootstrap on too few points -> ok:false, ci null.
  const ci = pairedBootstrapCI({ delta_per_case: [0.1, 0.1, 0.1], min_samples: 12 });
  assert.equal(ci.ok, false);
  assert.equal(ci.ci_low, null);
});

test('8) signed receipt binds the test family + alpha + corrected p-values; tamper breaks it', () => {
  const ev = makeEval({
    n: 200, lift: 0.05, noise: 0.01, seed: 55,
    axes: { accuracy: { lift: 0.05 }, coverage: { lift: 0.0 } },
  });
  const fam = buildTestFamily({ candidate: ev.candidate, baseline: ev.baseline });
  const g = significanceBoundedGate({
    family: fam, alpha: 0.05, min_kscore_delta: 0.02, correction: 'bh',
    bootstrap_iters: 1500, seed: 8,
  });

  const summary = buildSignificanceEvalSummary({
    gate: g, candidate_artifact_id: ev.candidate.id, baseline_artifact_id: ev.baseline.id,
  });
  // The significance contract is present in the signed body.
  assert.equal(summary.significance.alpha, 0.05);
  assert.equal(summary.significance.correction, 'bh');
  assert.equal(summary.significance.min_kscore_delta, 0.02);
  assert.ok(summary.test_family.length >= 3, 'family carries composite + axes');
  for (const m of summary.test_family) {
    assert.ok(typeof m.adjusted_p === 'number', 'each member carries a corrected p-value');
    assert.ok(typeof m.avp === 'number', 'each member carries an always-valid p-value');
  }
  assert.equal(summary.decision, g.decision);

  const bound = embedSignificanceReceipt({
    gate: g, candidate_artifact_id: ev.candidate.id, baseline_artifact_id: ev.baseline.id,
    namespace_id: 'test-c6',
  });
  // Receipt verifies against the exact eval_summary it was built from.
  const ok = verifySignificanceReceipt(bound.receipt, bound.eval_summary);
  assert.equal(ok.ok, true, 'fresh receipt verifies: ' + (ok.reason || ''));

  // Tamper with the bound summary -> verification fails.
  const tampered = JSON.parse(JSON.stringify(bound.eval_summary));
  tampered.significance.alpha = 0.5;       // attacker loosens the declared budget
  const bad = verifySignificanceReceipt(bound.receipt, tampered);
  assert.equal(bad.ok, false, 'tampered significance contract must fail verification');

  // Tamper with a member's corrected-significance verdict -> verification fails.
  const tampered2 = JSON.parse(JSON.stringify(bound.eval_summary));
  if (tampered2.test_family[0]) {
    tampered2.test_family[0].corrected_significant = !tampered2.test_family[0].corrected_significant;
    tampered2.test_family[0].adjusted_p = 0.999999;  // flip the recorded p-value too
  }
  const bad2 = verifySignificanceReceipt(bound.receipt, tampered2);
  assert.equal(bad2.ok, false, 'tampered corrected p-value / verdict must fail verification');
});

test('9) version tag + defaults are stable and well-formed', () => {
  assert.match(SIG_BOUNDED_GATE_VERSION, /^fc6-/);
  assert.equal(DEFAULT_GATE.alpha, 0.05);
  assert.equal(DEFAULT_GATE.correction, 'bh');
  assert.ok(DEFAULT_GATE.min_samples >= 2);
  // determinism: same seed -> identical CI bounds.
  const d = Array.from({ length: 50 }, (_, i) => 0.03 + 0.01 * Math.sin(i));
  const a = pairedBootstrapCI({ delta_per_case: d, seed: 42, n_iters: 500, min_samples: 12 });
  const b = pairedBootstrapCI({ delta_per_case: d, seed: 42, n_iters: 500, min_samples: 12 });
  assert.equal(a.ci_low, b.ci_low);
  assert.equal(a.ci_high, b.ci_high);
});
