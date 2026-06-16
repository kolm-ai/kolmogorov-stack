// FINALIZED C5 - Real layer-importance signal driving true per-layer
// mixed-precision allocation.
//
// Proves the atom end-to-end against src/layer-sensitivity-allocator.js:
//   A. A REAL per-layer sensitivity is computed from calibration statistics
//      (GPTQ-style diagonal Hessian E[x^2], empirical Fisher trace, and
//      teacher-vs-student KL) - distinct stats yield distinct, ordered scores.
//   B. Outlier/protected channels are detected from ACTIVATION statistics
//      (AWQ/SmoothQuant salient channels) via robust z-score.
//   C. A GENUINE allocator spends an average-bit budget per layer - high
//      sensitivity gets more bits, flat gets fewer - and DOES NOT collapse to a
//      single uniform width on a per-layer-capable backend.
//   D. Backend honor is real: exl2/hqq/gptq honor per-layer; int4/awq collapse,
//      and the collapse is surfaced LOUDLY (not silently pretended).
//   E. The schedule receipt PROVES applied == requested (hash equality + zero
//      per-layer mismatch) and FAILS CLOSED on divergence / multi-width collapse.
//   F. The REAL signal feeds the EXISTING src/daq-profile.js buildDaqProfile
//      verbatim (no edit to that funnel) and yields distinct per-layer bits.
//   G. The optional torch calibration backend is ENV-GATED and FAILS LOUD with
//      an install hint - the pure-JS path stays the real default.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diagonalHessianTrace,
  fisherTrace,
  teacherStudentKl,
  computeLayerSensitivity,
  computeCohortSensitivities,
  detectProtectedChannels,
  allocateMixedPrecision,
  backendHonorsPerLayer,
  planBackendApplication,
  buildScheduleReceipt,
  hashSchedule,
  planLayerSchedule,
  requireCalibrationBackend,
  SENSITIVITY_VERSION,
} from '../src/layer-sensitivity-allocator.js';

// The existing funnel we must NOT edit but MUST interoperate with.
import { buildDaqProfile, validateProfile, summarizeBitBudget } from '../src/daq-profile.js';

// ---------------------------------------------------------------------------
// A. Real per-layer sensitivity from calibration statistics.
// ---------------------------------------------------------------------------

test('A1 - diagonal Hessian = 2*E[x^2] (GPTQ curvature) from input_sq_mean', () => {
  // GPTQ Hessian diagonal is 2 * E[x_i^2]; trace/d = 2 * mean(E[x^2]).
  const tr = diagonalHessianTrace({ input_sq_mean: [1, 1, 1, 1] });
  assert.equal(tr, 2, 'mean E[x^2]=1 -> diag trace = 2');
  // Precomputed hessian_diag is used as-is (mean of |entries|).
  assert.equal(diagonalHessianTrace({ hessian_diag: [2, 4, 6] }), 4);
  // Scalar trace is normalized by dim.
  assert.equal(diagonalHessianTrace({ hessian_trace: 80, hessian_dim: 10 }), 8);
  // Absent -> null (NOT a silent zero).
  assert.equal(diagonalHessianTrace({}), null);
});

test('A2 - Fisher trace from gradients; KL from distill telemetry', () => {
  assert.equal(fisherTrace({ fisher_diag: [0.5, 1.5] }), 1.0);
  assert.equal(fisherTrace({ grad_sq_mean: 3.2 }), 3.2);
  assert.equal(fisherTrace({}), null);
  assert.equal(teacherStudentKl({ teacher_student_kl: 0.42 }), 0.42);
  assert.equal(teacherStudentKl({ logit_kl: 0.1 }), 0.1);
  assert.equal(teacherStudentKl({}), null);
});

test('A3 - single-signal layers score from THAT signal (not diluted by absent terms)', () => {
  const onlyH = computeLayerSensitivity({ input_sq_mean: [4, 4] });
  assert.equal(onlyH.source, 'hessian');
  assert.deepEqual(onlyH.present, ['hessian']);
  assert.equal(onlyH.components.fisher, null);
  assert.equal(onlyH.components.kl, null);
  const onlyK = computeLayerSensitivity({ kl: 0.9 });
  assert.equal(onlyK.source, 'kl');
  // No real signal at all -> explicit zero with source 'none' (visible gap).
  const none = computeLayerSensitivity({ foo: 1 });
  assert.equal(none.source, 'none');
  assert.equal(none.sensitivity, 0);
});

test('A4 - cohort sensitivities are distinct and ORDERED by real curvature', () => {
  // Three layers with increasing E[x^2] -> increasing sensitivity.
  const stats = [
    { layer_id: 'L0', input_sq_mean: [0.1, 0.1] }, // flat
    { layer_id: 'L1', input_sq_mean: [1.0, 1.0] }, // mid
    { layer_id: 'L2', input_sq_mean: [9.0, 9.0] }, // sharp
  ];
  const s = computeCohortSensitivities(stats);
  assert.equal(s.length, 3);
  assert.ok(s[0].sensitivity < s[1].sensitivity, 'flat < mid');
  assert.ok(s[1].sensitivity < s[2].sensitivity, 'mid < sharp');
  // The sharpest layer normalizes to the cohort max -> 1.0.
  assert.equal(s[2].sensitivity, 1, 'cohort-max layer normalizes to 1.0');
  // Distinct values (the signal actually separates layers).
  assert.equal(new Set(s.map((x) => x.sensitivity)).size, 3);
});

test('A5 - blended signal renormalizes over PRESENT signals (Hessian+Fisher+KL)', () => {
  const r = computeLayerSensitivity(
    { input_sq_mean: [1, 1], fisher_diag: [1, 1], kl: 1 },
    { norm: { hessian: 2, fisher: 1, kl: 1 } }, // each normalized term -> 1.0
  );
  // All three present at full normalized value -> blended sensitivity = 1.0.
  assert.deepEqual(r.present, ['hessian', 'fisher', 'kl']);
  assert.equal(r.source, 'blend');
  assert.equal(r.sensitivity, 1);
});

// ---------------------------------------------------------------------------
// B. AWQ/SmoothQuant outlier (protected channel) detection.
// ---------------------------------------------------------------------------

test('B1 - salient channels detected from activation magnitude (robust z-score)', () => {
  // Bulk channels ~1.0, two extreme outliers. Outliers must be flagged.
  const chans = new Array(64).fill(1.0);
  chans[7] = 50.0;
  chans[42] = 80.0;
  const det = detectProtectedChannels(chans);
  assert.deepEqual(det.protected_channels, [7, 42], 'the two outliers, ascending');
  assert.equal(det.total_channels, 64);
  assert.ok(det.threshold > 1.0, 'threshold above the bulk');
});

test('B2 - uniform activations have NO outliers (MAD=0 degenerate guard)', () => {
  const det = detectProtectedChannels(new Array(32).fill(2.0));
  assert.deepEqual(det.protected_channels, [], 'no channel exceeds an infinite threshold');
});

test('B3 - protected list capped (manifest-bounded, matches daq cap of 16)', () => {
  // Many outliers; cap keeps the 16 most extreme.
  const chans = new Array(100).fill(1.0);
  for (let i = 0; i < 40; i++) chans[i] = 100 + i;
  const det = detectProtectedChannels(chans);
  assert.equal(det.protected_channels.length, 16);
  // Returned ascending.
  for (let i = 1; i < det.protected_channels.length; i++) {
    assert.ok(det.protected_channels[i] > det.protected_channels[i - 1]);
  }
});

// ---------------------------------------------------------------------------
// C. Genuine allocator - budget water-fill, NOT uniform-majority collapse.
// ---------------------------------------------------------------------------

test('C1 - per-layer backend gets DISTINCT widths; budget spent on sensitive layers', () => {
  const layers = [
    { layer_id: 'L0', sensitivity: 0.01 }, // flat -> floor bits
    { layer_id: 'L1', sensitivity: 0.05 },
    { layer_id: 'L2', sensitivity: 0.50 },
    { layer_id: 'L3', sensitivity: 0.95 }, // sharp -> most bits
  ];
  const alloc = allocateMixedPrecision(layers, { method: 'exl2', target_avg_bits: 4.0 });
  assert.equal(alloc.honors_per_layer, true);
  assert.equal(alloc.collapsed, false);
  // The schedule is NOT a single uniform width.
  assert.ok(alloc.distinct_widths.length > 1, `expected mixed widths, got ${alloc.distinct_widths}`);
  // Higher sensitivity -> >= bits (monotone non-decreasing along sorted sens).
  const byId = Object.fromEntries(alloc.schedule.map((s) => [s.layer_id, s.weight_bits]));
  assert.ok(byId.L3 >= byId.L0, 'sharp layer gets at least as many bits as flat');
  assert.ok(byId.L3 > byId.L0, 'and strictly more when budget allows');
  // The average bit budget is respected (within one supported step of target).
  assert.ok(Math.abs(alloc.achieved_avg_bits - 4.0) <= 2.0,
    `achieved avg ${alloc.achieved_avg_bits} near target 4.0`);
});

test('C2 - allocator is deterministic (identical input -> identical schedule)', () => {
  const layers = [
    { layer_id: 'a', sensitivity: 0.2 },
    { layer_id: 'b', sensitivity: 0.8 },
    { layer_id: 'c', sensitivity: 0.5 },
  ];
  const a = allocateMixedPrecision(layers, { method: 'hqq', target_avg_bits: 4 });
  const b = allocateMixedPrecision(layers, { method: 'hqq', target_avg_bits: 4 });
  assert.deepEqual(a.schedule, b.schedule);
  assert.equal(hashSchedule(a.schedule), hashSchedule(b.schedule));
});

test('C3 - higher budget -> higher achieved average bits (budget is real)', () => {
  const layers = Array.from({ length: 6 }, (_, i) => ({ layer_id: `L${i}`, sensitivity: (i + 1) / 6 }));
  const low = allocateMixedPrecision(layers, { method: 'exl2', target_avg_bits: 3 });
  const high = allocateMixedPrecision(layers, { method: 'exl2', target_avg_bits: 6 });
  assert.ok(high.achieved_avg_bits > low.achieved_avg_bits,
    `higher target must raise achieved bits: ${low.achieved_avg_bits} -> ${high.achieved_avg_bits}`);
});

// ---------------------------------------------------------------------------
// D. Backend honor is real (the gap the spec names: no silent uniform collapse).
// ---------------------------------------------------------------------------

test('D1 - exl2/exl3/hqq/gptq/qat honor per-layer; int4/int8/awq do not', () => {
  for (const m of ['exl2', 'exl3', 'hqq', 'gptq', 'qat', 'quip']) {
    assert.equal(backendHonorsPerLayer(m), true, `${m} should honor per-layer`);
  }
  for (const m of ['int4', 'int8', 'awq', 'aqlm']) {
    assert.equal(backendHonorsPerLayer(m), false, `${m} is uniform-only`);
  }
});

test('D2 - uniform-only backend COLLAPSES loudly (collapsed:true, single width)', () => {
  const layers = [
    { layer_id: 'L0', sensitivity: 0.1 },
    { layer_id: 'L1', sensitivity: 0.9 },
  ];
  const alloc = allocateMixedPrecision(layers, { method: 'int4', target_avg_bits: 4 });
  assert.equal(alloc.honors_per_layer, false);
  assert.equal(alloc.collapsed, true, 'collapse must be surfaced, not hidden');
  assert.deepEqual(alloc.distinct_widths, [4], 'int4 collapses to a single width');
});

test('D3 - planBackendApplication snaps to supported set on per-layer backend', () => {
  // Request a 5-bit layer to hqq (supports {2,3,4,8}); it must snap (to 4 here).
  const schedule = [
    { layer_id: 'L0', weight_bits: 5 },
    { layer_id: 'L1', weight_bits: 8 },
  ];
  const plan = planBackendApplication(schedule, 'hqq');
  assert.equal(plan.honors_per_layer, true);
  assert.equal(plan.collapsed, false);
  assert.ok(plan.snapped_layers.includes('L0'), 'the unsupported 5-bit layer must be recorded as snapped');
  const byId = Object.fromEntries(plan.applied.map((l) => [l.layer_id, l.weight_bits]));
  assert.ok([2, 3, 4, 8].includes(byId.L0));
  assert.equal(byId.L1, 8, 'supported width passes through unchanged');
});

// ---------------------------------------------------------------------------
// E. Schedule-equality receipt - proves applied == requested, fails closed.
// ---------------------------------------------------------------------------

test('E1 - identity apply -> schedule_honored true, hashes equal', () => {
  const requested = [
    { layer_id: 'L0', weight_bits: 8 },
    { layer_id: 'L1', weight_bits: 4 },
    { layer_id: 'L2', weight_bits: 3 },
  ];
  const plan = planBackendApplication(requested, 'exl2'); // exactly honors
  const receipt = buildScheduleReceipt(requested, plan.applied,
    { method: plan.method, honors_per_layer: plan.honors_per_layer, collapsed: plan.collapsed });
  assert.equal(receipt.schedule_honored, true);
  assert.equal(receipt.equal, true);
  assert.equal(receipt.requested_hash, receipt.applied_hash);
  assert.deepEqual(receipt.mismatches, []);
});

test('E2 - FAIL CLOSED: a per-layer divergence makes schedule_honored false with a precise diff', () => {
  const requested = [
    { layer_id: 'L0', weight_bits: 8 },
    { layer_id: 'L1', weight_bits: 4 },
  ];
  const applied = [
    { layer_id: 'L0', weight_bits: 4 }, // backend quietly dropped L0 to 4
    { layer_id: 'L1', weight_bits: 4 },
  ];
  const receipt = buildScheduleReceipt(requested, applied, { method: 'gptq', honors_per_layer: true });
  assert.equal(receipt.schedule_honored, false, 'divergence must NOT be honored');
  assert.equal(receipt.equal, false);
  assert.notEqual(receipt.requested_hash, receipt.applied_hash);
  assert.deepEqual(receipt.mismatches, [{ layer_id: 'L0', requested: 8, applied: 4 }]);
});

test('E3 - FAIL CLOSED: a uniform-only backend collapsing a MULTI-width schedule is not honored', () => {
  const requested = [
    { layer_id: 'L0', weight_bits: 8 },
    { layer_id: 'L1', weight_bits: 4 },
    { layer_id: 'L2', weight_bits: 4 },
  ];
  const plan = planBackendApplication(requested, 'int4'); // collapses to one width
  assert.equal(plan.collapsed, true);
  const receipt = buildScheduleReceipt(requested, plan.applied,
    { method: plan.method, honors_per_layer: plan.honors_per_layer, collapsed: plan.collapsed });
  assert.equal(receipt.multi_width_collapsed, true);
  assert.equal(receipt.schedule_honored, false,
    'a backend that flattened a real mixed schedule must report the schedule as NOT honored');
});

test('E4 - receipt verifiable offline: recomputing hashes from the schedules reproduces equality', () => {
  const requested = [
    { layer_id: 'A', weight_bits: 6 },
    { layer_id: 'B', weight_bits: 2 },
  ];
  const plan = planBackendApplication(requested, 'exl2');
  const receipt = buildScheduleReceipt(requested, plan.applied,
    { method: 'exl2', honors_per_layer: true, collapsed: false });
  // An independent verifier recomputes the hashes from the raw schedules.
  assert.equal(hashSchedule(requested), receipt.requested_hash);
  assert.equal(hashSchedule(plan.applied), receipt.applied_hash);
  assert.equal(receipt.schedule_honored, true);
});

// ---------------------------------------------------------------------------
// F. Interop: REAL signal feeds the EXISTING daq-profile funnel unchanged.
// ---------------------------------------------------------------------------

test('F1 - planLayerSchedule -> daq_telemetry drives buildDaqProfile to DISTINCT per-layer bits', () => {
  // Calibration stats for a small stack: a flat layer, a mid layer, and a sharp
  // layer with a couple of outlier channels.
  const layerStats = [
    { layer_id: 'model.layers.0.mlp', input_sq_mean: [0.05, 0.05], channel_abs_mean: [1, 1, 1, 1] },
    { layer_id: 'model.layers.1.mlp', input_sq_mean: [1.0, 1.0], channel_abs_mean: [1, 1, 50, 1] },
    { layer_id: 'model.layers.2.mlp', input_sq_mean: [20.0, 20.0], teacher_student_kl: 0.5, channel_abs_mean: [1, 80, 1, 1] },
  ];
  const out = planLayerSchedule(layerStats, { method: 'exl2', target_avg_bits: 4 });

  // Our allocator produced a genuinely mixed schedule.
  assert.ok(out.allocation.distinct_widths.length > 1, 'allocator produced mixed widths');
  // The receipt for the exl2 (per-layer) backend is honored.
  assert.equal(out.receipt.schedule_honored, true);

  // Now feed our REAL kl_sensitivity straight into the EXISTING daq funnel.
  const daqProfile = buildDaqProfile(out.daq_telemetry);
  assert.equal(daqProfile.length, 3);
  // Every produced profile entry is schema-valid for the unedited funnel.
  for (const p of daqProfile) {
    const v = validateProfile(p);
    assert.equal(v.ok, true, `daq profile invalid: ${v.errors.join('; ')}`);
  }
  // The sharp layer (highest real sensitivity) must NOT be quantized to the same
  // low bits as the flat layer -> distinct per-layer weight_bits emerge.
  const bits = daqProfile.map((p) => p.weight_bits);
  assert.ok(new Set(bits).size > 1,
    `the real signal must drive distinct per-layer bits, got ${bits}`);
  // Outlier channels detected from activation stats propagated into the profile.
  const withProtected = daqProfile.filter((p) => p.protected_channels.length > 0);
  assert.ok(withProtected.length >= 1, 'activation outliers must surface as protected channels');

  // The summary proves real average-bit savings vs uniform int8.
  const summary = summarizeBitBudget(daqProfile);
  assert.ok(summary.vs_uniform_int8_savings_pct > 0, 'mixed precision saves vs uniform int8');
});

test('F2 - end-to-end plan carries a complete, hashable receipt + sensitivities', () => {
  const layerStats = [
    { layer_id: 'q', input_sq_mean: [2, 2] },
    { layer_id: 'k', input_sq_mean: [0.1, 0.1] },
  ];
  const out = planLayerSchedule(layerStats, { method: 'hqq', target_avg_bits: 4 });
  assert.equal(out.sensitivities.length, 2);
  assert.equal(out.receipt.layer_count, 2);
  assert.equal(typeof out.receipt.requested_hash, 'string');
  assert.equal(out.receipt.requested_hash.length, 64);
  assert.equal(out.receipt.version, SENSITIVITY_VERSION);
});

// ---------------------------------------------------------------------------
// G. Optional torch backend is ENV-GATED and FAILS LOUD (real path is pure-JS).
// ---------------------------------------------------------------------------

test('G1 - default backend is pure-js and ready (the real path)', () => {
  const prev = process.env.KOLM_SENSITIVITY_BACKEND;
  delete process.env.KOLM_SENSITIVITY_BACKEND;
  try {
    const r = requireCalibrationBackend();
    assert.equal(r.backend, 'pure-js');
    assert.equal(r.ready, true);
  } finally {
    if (prev !== undefined) process.env.KOLM_SENSITIVITY_BACKEND = prev;
  }
});

test('G2 - torch backend FAILS LOUD with an install hint (no silent stub)', () => {
  const prev = process.env.KOLM_SENSITIVITY_BACKEND;
  process.env.KOLM_SENSITIVITY_BACKEND = 'torch';
  try {
    assert.throws(() => requireCalibrationBackend(), (err) => {
      assert.equal(err.code, 'CALIBRATION_BACKEND_TORCH_REQUIRED');
      assert.match(err.message, /pip install/);
      assert.match(String(err.install_hint), /torch/);
      return true;
    });
  } finally {
    if (prev === undefined) delete process.env.KOLM_SENSITIVITY_BACKEND;
    else process.env.KOLM_SENSITIVITY_BACKEND = prev;
  }
});
