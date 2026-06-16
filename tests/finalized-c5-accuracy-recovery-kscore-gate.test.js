// Proves src/quant-accuracy-recovery.js: the FINALIZED-C5 atom - a REAL
// post-quantize accuracy-recovery + K-score/perplexity gate on the quantized
// artifact.
//
// No GPU, no network. The recovery math (FP4 E2M1 round, learnable clip, bias
// correction, error feedback, perplexity, KL) runs directly on numeric weight
// tensors + a holdout of logit rows. The gate uses the REAL K-score harness
// (computeKScoreV2) - replacing the Jaccard surrogate used by
// src/quantize-bakeoff.js for quant verdicts.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUANT_ACCURACY_RECOVERY_VERSION,
  FP4_E2M1_LEVELS,
  FP4_E2M1_MAX,
  QAT_RECOVERY_ENV,
  quantizeBlockFp4,
  searchClipFp4,
  applyBatquantFp4,
  errorFeedbackRecover,
  qatRecoveryEnabled,
  runQatRecovery,
  perplexityFromLogits,
  teacherQuantKL,
  gateQuantKScore,
  recoverAndGate,
} from '../src/quant-accuracy-recovery.js';

import { computeKScoreV2 } from '../src/kscore.js';

// Deterministic PRNG so the weight tensor is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianWeights(n, seed, scale = 0.05) {
  const r = mulberry32(seed);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    // Box-Muller.
    const u1 = Math.max(1e-9, r());
    const u2 = r();
    out[i] = scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

// ── BATQuant FP4 (E2M1) transform genuinely applied ──────────────────────────

test('FP4 grid is the exact E2M1 magnitude set', () => {
  assert.deepEqual(FP4_E2M1_LEVELS, [0, 0.5, 1, 1.5, 2, 3, 4, 6]);
  assert.equal(FP4_E2M1_MAX, 6);
});

test('quantizeBlockFp4 snaps every weight onto a scaled E2M1 level', () => {
  const block = [0.01, -0.02, 0.05, -0.1, 0.2, 0.0, 0.03, -0.04];
  const { q, scale } = quantizeBlockFp4(block, 1, 0);
  assert.ok(scale > 0, 'a non-degenerate block produces a positive scale');
  for (const v of q) {
    const lvl = Math.abs(v) / scale;
    // lvl must be (numerically) one of the E2M1 levels.
    const onGrid = FP4_E2M1_LEVELS.some((g) => Math.abs(g - lvl) < 1e-6);
    assert.ok(onGrid, `dequantized value ${v} -> level ${lvl} must lie on the E2M1 grid`);
  }
  // The max-magnitude weight maps onto the top level (6 * scale).
  const maxAbs = Math.max(...block.map(Math.abs));
  assert.ok(Math.abs(maxAbs - FP4_E2M1_MAX * scale) < 1e-9, 'block max anchors the top E2M1 level');
});

test('applyBatquantFp4 quantizes a full tensor onto the FP4 grid with real per-block scales', () => {
  const w = gaussianWeights(256, 7);
  const res = applyBatquantFp4(w, { block: 32 });
  assert.equal(res.q.length, w.length, 'output length matches input');
  assert.equal(res.blocks, 8, '256 weights / block 32 = 8 blocks');
  assert.equal(res.scales.length, 8);
  assert.equal(res.clips.length, 8);
  // Effective bits: 4 + 8/32 = 4.25.
  assert.equal(res.bits_per_weight, 4.25);
  // Every dequantized weight lies on its block's scaled E2M1 grid (allowing
  // for the per-block affine zero shift).
  for (let b = 0; b < res.blocks; b++) {
    const scale = res.scales[b];
    const zero = res.zeros[b];
    if (scale === 0) continue;
    for (let i = b * 32; i < (b + 1) * 32; i++) {
      const lvl = Math.abs(res.q[i] - zero) / scale;
      const onGrid = FP4_E2M1_LEVELS.some((g) => Math.abs(g - lvl) < 1e-5);
      assert.ok(onGrid, `weight ${i} (=${res.q[i]}) must lie on its block E2M1 grid`);
    }
  }
  assert.match(res.algorithm, /batquant/);
  assert.match(res.source, /2603\.16590/);
});

test('learnable clipping search reduces (or ties) reconstruction MSE vs no-clip', () => {
  // A heavy-tailed block: a couple of large outliers + many small weights. The
  // clip search should beat the un-clipped round on MSE.
  const block = [0.6, -0.55, 0.01, -0.012, 0.008, -0.009, 0.011, -0.007,
                 0.013, -0.006, 0.009, -0.01, 0.007, -0.008, 0.012, -0.011];
  const noClip = quantizeBlockFp4(block, 1, 0);
  const noClipMse = block.reduce((s, v, i) => s + (v - noClip.q[i]) ** 2, 0) / block.length;
  const searched = searchClipFp4(block);
  assert.ok(searched.mse <= noClipMse + 1e-12,
    `clip search MSE ${searched.mse} must be <= no-clip MSE ${noClipMse}`);
  assert.ok(searched.clip <= 1 && searched.clip > 0, 'chosen clip is a valid fraction');
});

test('bias correction preserves the block mean better than raw rounding', () => {
  // Asymmetric block so naive rounding has a nonzero mean error.
  const block = [0.31, 0.29, 0.305, 0.32, 0.30, 0.315, 0.295, 0.308];
  const raw = quantizeBlockFp4(block, 1, 0);
  const rawMeanErr = Math.abs(
    (raw.q.reduce((a, b) => a + b, 0) - block.reduce((a, b) => a + b, 0)) / block.length);
  const corrected = applyBatquantFp4(block, { block: 8, clipSearch: false, biasCorrect: true });
  const corrMeanErr = Math.abs(
    (corrected.q.reduce((a, b) => a + b, 0) - block.reduce((a, b) => a + b, 0)) / block.length);
  assert.ok(corrMeanErr <= rawMeanErr + 1e-9,
    `bias-corrected mean error ${corrMeanErr} must be <= raw ${rawMeanErr}`);
});

// ── Error-feedback recovery (GPTQ/AWQ residual propagation) ───────────────────

test('errorFeedbackRecover bounds the accumulated (cumulative) error vs naive rounding', () => {
  const w = gaussianWeights(512, 11);
  const res = errorFeedbackRecover(w, { block: 32 });
  assert.equal(res.q.length, w.length);
  // The PROVABLE property of error feedback: the running cumulative error
  // sup-norm stays bounded (no worse than naive), and the matmul-projection
  // error - the quantity that actually drives output error - shrinks.
  assert.ok(res.cumulative_err_sup_error_feedback <= res.cumulative_err_sup_naive + 1e-9,
    `feedback cumulative-err sup ${res.cumulative_err_sup_error_feedback} must be <= naive ${res.cumulative_err_sup_naive}`);
  assert.ok(res.dc_proj_err_error_feedback <= res.dc_proj_err_naive + 1e-9,
    `feedback DC-proj err ${res.dc_proj_err_error_feedback} must be <= naive ${res.dc_proj_err_naive}`);
  assert.equal(res.improved, true);
  assert.match(res.algorithm, /error-feedback/);
});

// ── Perplexity + teacher-vs-quant KL (real math) ──────────────────────────────

test('perplexityFromLogits computes exp(mean NLL); a confident-correct row -> low ppx', () => {
  // Two positions; gold token has a large logit -> low NLL -> ppx near 1.
  const rows = [{
    logits: [[10, 0, 0, 0], [0, 12, 0, 0]],
    targets: [0, 1],
  }];
  const r = perplexityFromLogits(rows);
  assert.equal(r.n_tokens, 2);
  assert.ok(r.perplexity > 1 && r.perplexity < 1.01, `ppx ${r.perplexity} should be ~1 for confident-correct`);
  // A uniform-logit row over a vocab of 4 -> NLL=ln(4) -> ppx=4.
  const uniform = perplexityFromLogits([{ logits: [[0, 0, 0, 0]], targets: [2] }]);
  assert.ok(Math.abs(uniform.perplexity - 4) < 1e-3, `uniform 4-way ppx must be ~4, got ${uniform.perplexity}`);
});

test('teacherQuantKL is 0 for identical distributions and > 0 when quant diverges', () => {
  const same = teacherQuantKL([{
    teacher_logits: [[2, 1, 0, -1]],
    quant_logits: [[2, 1, 0, -1]],
  }]);
  assert.ok(same.mean_kl < 1e-9, `identical -> KL ~0, got ${same.mean_kl}`);

  const diverged = teacherQuantKL([{
    teacher_logits: [[5, 0, 0, 0]],
    quant_logits: [[0, 0, 0, 5]],
  }]);
  assert.ok(diverged.mean_kl > 1, `divergent distributions -> KL >> 0, got ${diverged.mean_kl}`);
});

// ── K-score gate REPLACES Jaccard; gates on MEASURED delta vs fp16 ────────────

test('gateQuantKScore uses the real K-score harness, not Jaccard', () => {
  const v = gateQuantKScore({
    fp16: { perplexity: 8.0, accuracy: 0.94, holdout_accuracy: 0.92, size_bytes: 14e9, p50_latency_us: 40000 },
    quant: { perplexity: 8.1, kl_mean: 0.01, size_bytes: 3.8e9, p50_latency_us: 20000 },
  });
  assert.equal(v.scorer, 'kscore-v2-harness');
  assert.notEqual(v.scorer, 'jaccard');
  // The fp16 + quant K-scores come straight from computeKScoreV2.
  assert.equal(v.fp16_envelope.spec, 'k-score-2');
  assert.equal(v.quant_envelope.spec, 'k-score-2');
});

test('a near-lossless quant (tiny ppx + KL move, smaller+faster) SHIPS with a non-negative delta', () => {
  const v = gateQuantKScore({
    fp16: { perplexity: 8.0, accuracy: 0.94, holdout_accuracy: 0.92, size_bytes: 14e9, p50_latency_us: 40000 },
    // 4x smaller, 2x faster, perplexity barely moved, KL tiny.
    quant: { perplexity: 8.02, kl_mean: 0.005, size_bytes: 3.8e9, p50_latency_us: 20000 },
    maxDeltaDrop: 0.02,
    maxKL: 0.1,
  });
  assert.equal(v.ships, true, `near-lossless quant should ship; reasons=${JSON.stringify(v.reasons)}`);
  assert.equal(v.verdict, 'pass');
  // Smaller + faster quant should actually IMPROVE the composite -> delta >= 0.
  assert.ok(v.k_score_delta >= 0, `delta ${v.k_score_delta} should be >= 0 for a smaller/faster near-lossless quant`);
});

test('a catastrophic quant (perplexity blows up) FAILS the gate via the measured K-score drop', () => {
  const v = gateQuantKScore({
    fp16: { perplexity: 8.0, accuracy: 0.94, holdout_accuracy: 0.92, size_bytes: 14e9, p50_latency_us: 40000 },
    // perplexity 8 -> 80 (10x): NLL gap = ln(10) ~ 2.3 nats -> accuracy collapses.
    quant: { perplexity: 80.0, kl_mean: 2.5, size_bytes: 3.8e9, p50_latency_us: 20000 },
    maxDeltaDrop: 0.02,
    maxKL: 0.1,
  });
  assert.equal(v.ships, false, 'a model whose perplexity 10x-ed must not ship');
  assert.equal(v.verdict, 'fail');
  assert.ok(v.reasons.length >= 1);
  // The drop must be a real, positive number (accuracy axis A actually moved).
  assert.ok(v.k_score_drop > 0, `k_score_drop ${v.k_score_drop} should be > 0`);
  assert.ok(v.quant_accuracy < v.fp16_accuracy, 'quant accuracy must measurably degrade');
});

test('the high-KL guard fails the gate even when the size win would otherwise lift K-score', () => {
  const v = gateQuantKScore({
    fp16: { perplexity: 8.0, accuracy: 0.94, holdout_accuracy: 0.92, size_bytes: 14e9, p50_latency_us: 40000 },
    // ppx barely moved, K-score would rise from the size win, BUT teacher KL is huge.
    quant: { perplexity: 8.05, kl_mean: 0.9, size_bytes: 1.0e9, p50_latency_us: 10000 },
    maxDeltaDrop: 0.05,
    maxKL: 0.1,
  });
  assert.equal(v.ships, false, 'a high teacher-vs-quant KL must block the ship even with a size win');
  assert.ok(v.reasons.some((r) => r.startsWith('teacher_quant_kl_exceeds_max')),
    `expected a KL reason; got ${JSON.stringify(v.reasons)}`);
});

test('the gate matches the real harness exactly (no shadow scorer)', () => {
  const fp16 = { perplexity: 8.0, accuracy: 0.95, holdout_accuracy: 0.93, size_bytes: 14e9, p50_latency_us: 40000, coverage: 1 };
  const quant = { perplexity: 8.0, kl_mean: 0.0, size_bytes: 14e9, p50_latency_us: 40000 };
  const v = gateQuantKScore({ fp16, quant });
  // When ppx is identical and KL=0 and size/latency identical, the quant
  // composite must equal what computeKScoreV2 returns for the same inputs.
  const expectedQuant = computeKScoreV2({
    accuracy: 0.95, size_bytes: 14e9, coverage: 1, p50_latency_us: 40000,
    cost_usd_per_call: 0, holdout_accuracy: 0.95, eval_set_drift: 0,
    teacher_holdout_accuracy: 0.93,
  });
  assert.equal(v.quant_kscore, expectedQuant.composite,
    'gate composite must equal the real K-score harness output');
});

// ── Optional EfficientQAT recovery: env-gated, fails LOUD ──────────────────────

test('QAT recovery is opt-in: default env -> disabled, ran:false (fail-safe)', () => {
  const r = runQatRecovery({ env: {} });
  assert.equal(qatRecoveryEnabled({}), false);
  assert.equal(r.enabled, false);
  assert.equal(r.ran, false);
  assert.match(r.reason, new RegExp(QAT_RECOVERY_ENV));
  assert.equal(r.source, 'arXiv:2407.11062');
});

test('QAT recovery armed but EfficientQAT missing -> fails LOUD with an install hint (never silent-pass)', () => {
  // Inject a spawnSync that reports the package import failed (status 1).
  const fakeSpawn = () => ({ status: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'efficientqat'" });
  const r = runQatRecovery({
    env: { [QAT_RECOVERY_ENV]: '1' },
    _spawnSync: fakeSpawn,
    _existsSync: () => true,
    merged_dir: '/tmp/model',
  });
  assert.equal(r.enabled, true);
  assert.equal(r.ran, false);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'efficientqat_missing');
  assert.match(r.install_hint, /pip install efficientqat/);
  assert.match(r.install_hint, /2407\.11062/);
});

test('QAT recovery armed + package present + driver succeeds -> real run envelope (no fabrication)', () => {
  let calls = 0;
  const fakeSpawn = (py, argv) => {
    calls += 1;
    if (argv[0] === '-c') return { status: 0, stdout: '1.0.0\n', stderr: '' }; // probe ok
    // driver run
    return { status: 0, stdout: '{"ok": true}\n', stderr: '' };
  };
  const r = runQatRecovery({
    env: { [QAT_RECOVERY_ENV]: 'on' },
    _spawnSync: fakeSpawn,
    _existsSync: () => true,
    merged_dir: '/tmp/model',
    target_dir: '/tmp/model.qat',
  });
  assert.equal(r.enabled, true);
  assert.equal(r.ran, true);
  assert.equal(r.ok, true);
  assert.equal(r.output_dir, '/tmp/model.qat');
  assert.ok(calls >= 2, 'probe + driver both invoked');
});

// ── Fail-closed moat guard: holdout disjointness ──────────────────────────────

test('recoverAndGate fails CLOSED when the holdout overlaps the calibration set', () => {
  const out = recoverAndGate({
    fp16_weights: gaussianWeights(64, 3),
    calibration_ids: ['a', 'b', 'c'],
    holdout_ids: ['c', 'd', 'e'], // 'c' leaks
    holdout: { fp16_rows: [], quant_rows: [] },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'holdout_calibration_overlap');
  assert.deepEqual(out.leaked_ids, ['c']);
});

// ── End-to-end: real recovery + measured K-score-delta gate ───────────────────

test('recoverAndGate runs the full atom and ships a near-lossless 4-bit quant', () => {
  const weights = gaussianWeights(1024, 21);
  // fp16 holdout: confident-correct next-token rows (low perplexity).
  const fp16_rows = [];
  const quant_rows = [];
  for (let r = 0; r < 8; r++) {
    const logitsT = [[8, 0, 1, 0], [0, 9, 0, 1], [1, 0, 7, 0]];
    // quant logits: a tiny perturbation (genuine but small divergence).
    const logitsQ = logitsT.map((row) => row.map((x, i) => x + (i === 0 ? -0.05 : 0.02)));
    const targets = [0, 1, 2];
    fp16_rows.push({ logits: logitsT, targets });
    quant_rows.push({ logits: logitsQ, targets });
  }
  const out = recoverAndGate({
    fp16_weights: weights,
    block: 32,
    calibration_ids: ['cal-1', 'cal-2'],
    holdout_ids: ['ho-1', 'ho-2'], // disjoint
    holdout: { fp16_rows, quant_rows },
    fp16_meta: { accuracy: 0.94, holdout_accuracy: 0.92, size_bytes: 14e9, p50_latency_us: 40000, coverage: 1 },
    quant_meta: { p50_latency_us: 20000 }, // 2x faster; size derived from FP4 bits
    maxDeltaDrop: 0.03,
    maxKL: 0.1,
  });
  assert.equal(out.ok, true);
  assert.equal(out.steps.disjointness.ok, true);
  // FP4 step actually ran and produced 4.25 effective bits.
  assert.equal(out.steps.fp4.bits_per_weight, 4.25);
  assert.equal(out.steps.fp4.q.length, 1024);
  // Error-feedback ran and bounded the accumulated error.
  assert.ok(out.steps.error_feedback.cumulative_err_sup_error_feedback
    <= out.steps.error_feedback.cumulative_err_sup_naive + 1e-9);
  // Perplexity + KL measured on the holdout.
  assert.ok(out.steps.perplexity.fp16.n_tokens === 24, '8 rows * 3 tokens = 24');
  assert.ok(out.steps.kl.mean_kl >= 0);
  // The quant size came from the FP4 bit budget (4.25 bits), so it is far
  // smaller than fp16 -> the gate should ship a near-lossless quant.
  assert.equal(out.gate.scorer, 'kscore-v2-harness');
  assert.equal(out.ships, true, `expected ship; reasons=${JSON.stringify(out.gate.reasons)}`);
  assert.equal(out.verdict, 'pass');
  // QAT step present + disabled by default (fail-safe).
  assert.equal(out.steps.qat.enabled, false);
});

test('recoverAndGate fails the gate end-to-end when the quant holdout diverges hard', () => {
  const weights = gaussianWeights(256, 99);
  const fp16_rows = [];
  const quant_rows = [];
  for (let r = 0; r < 6; r++) {
    const logitsT = [[10, 0, 0, 0], [0, 10, 0, 0]];
    // quant predicts the WRONG token confidently -> high NLL + high KL.
    const logitsQ = [[0, 0, 0, 10], [0, 0, 10, 0]];
    const targets = [0, 1];
    fp16_rows.push({ logits: logitsT, targets });
    quant_rows.push({ logits: logitsQ, targets });
  }
  const out = recoverAndGate({
    fp16_weights: weights,
    block: 32,
    holdout: { fp16_rows, quant_rows },
    fp16_meta: { accuracy: 0.94, holdout_accuracy: 0.92, size_bytes: 14e9, p50_latency_us: 40000 },
    maxDeltaDrop: 0.02,
    maxKL: 0.1,
  });
  assert.equal(out.ok, true);
  assert.ok(out.steps.kl.mean_kl > 1, 'wrong-token quant must show a large measured KL');
  assert.equal(out.ships, false, 'a quant that flips predictions must not ship');
  assert.equal(out.verdict, 'fail');
});

test('module version + shape are stable', () => {
  assert.equal(QUANT_ACCURACY_RECOVERY_VERSION, 'finalized-c5-v1');
});
