// src/layer-sensitivity-allocator.js
//
// FINALIZED C5 - Real layer-importance signal driving true per-layer
// mixed-precision allocation.
//
// CONTEXT (the gap this closes)
// -----------------------------
// src/daq-profile.js already maps a per-layer `kl_sensitivity` telemetry value
// to a coarse 3-branch bit decision (>0.05 -> 8b, <0.01 -> 4b, else 4b+8a). But
// NOTHING in the stack actually COMPUTES kl_sensitivity from a real calibration
// pass - decideBitsForLayer takes it as input and DEFAULT_PROFILE pins it to
// 0.0. And workers/quantize/scripts/quantize.py, for backends that can't honor
// per-layer mixing, COLLAPSES the schedule to a single uniform-majority bit
// width (compute_uniform_fallback_from_profile). So the "mixed precision" was,
// for most backends, a no-op.
//
// This module supplies the two missing real pieces, in NEW files so the proven
// daq-profile / quantize.py funnels stay byte-for-byte unchanged:
//
//   1. computeLayerSensitivity(stats) - a REAL per-layer importance score from
//      calibration-pass statistics:
//        * GPTQ-style diagonal Hessian H_ii = E[x_i^2] (Frantar 2022: the GPTQ
//          objective's curvature is the second moment of the layer INPUT, i.e.
//          the diagonal of (2/n) X X^T). The trace of that diagonal is the
//          layer's quantization-error gain - high curvature = quantizing this
//          layer hurts more.
//        * Empirical Fisher trace tr(F) ~ E[||g||^2] when per-layer output
//          gradients (or grad-x-activation, the Fisher diagonal) are supplied.
//        * Teacher-vs-student KL when distilling: the per-layer logit/feature KL
//          that the W711/W719 telemetry can carry directly.
//      These three are blended (whichever are present) into a single normalized
//      sensitivity in [0,1] that daq-profile.js consumes verbatim as
//      `kl_sensitivity`.
//
//   2. detectProtectedChannels(channel_stats) - AWQ / SmoothQuant outlier
//      detection from ACTIVATION statistics: the per-input-channel activation
//      magnitude (AWQ's "salient channel" signal). Channels whose mean-abs
//      activation is a configurable number of robust-sigmas above the median
//      are flagged protected so the allocator keeps them in higher precision.
//
//   3. allocateMixedPrecision(layers, opts) - a GENUINE allocator: a
//      budget-constrained water-filling that spends a target AVERAGE bit budget
//      across layers, giving more bits to high-sensitivity layers and fewer to
//      flat ones, snapped to the chosen backend's supported integer bit set.
//      This is NOT majority-collapse: distinct per-layer nbits survive.
//
//   4. backendHonorsPerLayer(method) + planBackendApplication(schedule, method)
//      - which backends can ACTUALLY apply a per-layer schedule (exl2/exl3/hqq/
//      gptq/qat -> yes; int4/int8/awq -> uniform-only). For honor=false we
//      surface the collapse LOUDLY instead of silently pretending.
//
//   5. buildScheduleReceipt(requested, applied) - proves the APPLIED schedule
//      equals the REQUESTED schedule. Fail-closed: any per-layer divergence (or
//      a backend that collapsed a multi-width schedule) makes `schedule_honored`
//      false with a precise per-layer diff, and the receipt hashes both sides so
//      a verifier can re-derive equality offline.
//
// PRIVACY (load-bearing): the inputs here are AGGREGATE per-layer / per-channel
// STATISTICS (second moments, magnitudes, KL scalars) - never raw activations,
// never customer text. The whole signal is computed locally; nothing in this
// module makes a network call or emits a token. The boundary is provable: the
// public functions accept only numeric stat summaries.
//
// PURE-JS: no new deps. An optional torch-backed calibration extractor is
// ENV-GATED (KOLM_SENSITIVITY_BACKEND=torch) and FAILS LOUD with an install
// hint - the pure-JS stats path remains the real, default code path.
//
// Constraints / Caveats:
//   * The diagonal-Hessian here is the *diagonal* (GPTQ's per-channel scale
//     term), not the full Hessian GPTQ inverts during its error-feedback loop -
//     the diagonal is exactly what drives the per-LAYER sensitivity ranking and
//     is what AWQ/SmoothQuant also use. The full GPTQ solve still happens inside
//     the backend (gptqmodel) at apply time; this module decides the budget.
//   * When only KL is present (pure distill telemetry, no calibration moments)
//     the Hessian/Fisher terms are absent and the score is KL-only - that is the
//     correct behavior, not a fallback to zero.

import crypto from 'node:crypto';

export const SENSITIVITY_VERSION = 'finalized-c5-v1';

// Default blend weights across the three real signals. They are renormalized
// over whichever signals are actually PRESENT for a layer, so a layer with only
// a Hessian gets a Hessian-only score (weight 1.0 after renorm), not a score
// diluted by absent terms.
const DEFAULT_BLEND = Object.freeze({
  hessian: 0.45, // GPTQ-style diagonal curvature - the loudest PTQ signal.
  fisher: 0.30, // empirical Fisher trace - needs gradients (distill/FT).
  kl: 0.25, // teacher-vs-student KL - the distillation telemetry.
});

// AWQ/SmoothQuant outlier detection default: a channel is "salient/protected"
// when its mean-abs activation exceeds median + OUTLIER_SIGMAS * robust_sigma,
// where robust_sigma = 1.4826 * MAD (median absolute deviation). 6.0 is the
// SmoothQuant-era empirical knee (a handful of channels per layer).
const OUTLIER_SIGMAS = 6.0;
const MAX_PROTECTED_CHANNELS = 16; // matches daq-profile.js cap (manifest bound)

// Backends that can apply a genuinely per-layer / variable-bitrate schedule.
// exl2/exl3 are turboderp's variable-bitrate formats; hqq/gptq/qat carry a
// per-Linear nbits config; int4/int8 (bitsandbytes) + awq are uniform-only.
const PER_LAYER_BACKENDS = Object.freeze({
  exl2: { kind: 'variable_bitrate', supported_bits: [2, 3, 4, 5, 6, 8] },
  exl3: { kind: 'variable_bitrate', supported_bits: [2, 3, 4, 5, 6, 8] },
  hqq: { kind: 'per_linear_nbits', supported_bits: [2, 3, 4, 8] },
  gptq: { kind: 'per_linear_nbits', supported_bits: [2, 3, 4, 8] },
  qat: { kind: 'per_linear_nbits', supported_bits: [2, 3, 4, 8] },
  quip: { kind: 'variable_bitrate', supported_bits: [2, 3, 4] },
});
const UNIFORM_ONLY_BACKENDS = Object.freeze({
  int4: { supported_bits: [4] },
  int8: { supported_bits: [8] },
  awq: { supported_bits: [4, 8] },
  aqlm: { supported_bits: [2] },
});

// -------------------------------------------------------------------------
// numeric helpers (deterministic, ASCII)
// -------------------------------------------------------------------------

function _finite(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function _median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _round(n, d = 6) {
  return Number(Number(n).toFixed(d));
}

// -------------------------------------------------------------------------
// 1. REAL per-layer sensitivity
// -------------------------------------------------------------------------

/**
 * GPTQ-style diagonal-Hessian trace from calibration second moments.
 *
 * GPTQ (Frantar 2022) minimizes ||WX - QX||^2; its layer-wise Hessian is
 * H = (2/n) X X^T whose DIAGONAL is 2 * E[x_i^2] over the calibration set. The
 * mean of that diagonal (the trace / d) is the layer's average input curvature:
 * the larger it is, the more a fixed quantization error in W is amplified at the
 * output. We accept either:
 *   - input_sq_mean: array of per-input-channel E[x_i^2]  (preferred, exact), or
 *   - hessian_diag:  array of precomputed diagonal-Hessian entries, or
 *   - hessian_trace: a single scalar trace (already aggregated upstream).
 *
 * Returns the mean diagonal value, or null when no Hessian stat is present.
 */
export function diagonalHessianTrace(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (Array.isArray(stats.hessian_diag) && stats.hessian_diag.length) {
    let s = 0;
    for (const v of stats.hessian_diag) s += Math.abs(_finite(v));
    return s / stats.hessian_diag.length;
  }
  if (Array.isArray(stats.input_sq_mean) && stats.input_sq_mean.length) {
    // diag(H) = 2 * E[x_i^2]; trace/d = 2 * mean(E[x_i^2]).
    let s = 0;
    for (const v of stats.input_sq_mean) s += Math.abs(_finite(v));
    return (2 * s) / stats.input_sq_mean.length;
  }
  if (Number.isFinite(stats.hessian_trace)) {
    const d = Math.max(1, _finite(stats.hessian_dim, 1));
    return Math.abs(_finite(stats.hessian_trace)) / d;
  }
  return null;
}

/**
 * Empirical Fisher trace tr(F) ~ E[||g||^2] (or E[(g*x)^2], the Fisher diagonal)
 * when per-layer gradients are supplied. Accepts:
 *   - fisher_diag:  array of per-param Fisher diagonal entries, or
 *   - grad_sq_mean: scalar E[||grad||^2] over the calibration set, or
 *   - fisher_trace: a single scalar trace.
 *
 * Returns the mean Fisher value, or null when no Fisher stat is present.
 */
export function fisherTrace(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (Array.isArray(stats.fisher_diag) && stats.fisher_diag.length) {
    let s = 0;
    for (const v of stats.fisher_diag) s += Math.abs(_finite(v));
    return s / stats.fisher_diag.length;
  }
  if (Number.isFinite(stats.grad_sq_mean)) return Math.abs(_finite(stats.grad_sq_mean));
  if (Number.isFinite(stats.fisher_trace)) {
    const d = Math.max(1, _finite(stats.fisher_dim, 1));
    return Math.abs(_finite(stats.fisher_trace)) / d;
  }
  return null;
}

/**
 * Teacher-vs-student KL for the layer (distillation telemetry). Accepts a
 * non-negative scalar `kl` / `teacher_student_kl` / `logit_kl`. Returns null
 * when absent. KL is already a sensitivity (high KL = student diverges most on
 * this layer's contribution = protect it).
 */
export function teacherStudentKl(stats) {
  if (!stats || typeof stats !== 'object') return null;
  for (const k of ['teacher_student_kl', 'logit_kl', 'kl']) {
    if (Number.isFinite(stats[k]) && stats[k] >= 0) return Number(stats[k]);
  }
  return null;
}

/**
 * Compute a single REAL sensitivity score for ONE layer from its calibration
 * statistics. Blends whichever of {diagonal Hessian, Fisher trace, KL} are
 * present, renormalizing the blend weights over the present signals.
 *
 * The three raw signals live on different scales, so each is normalized against
 * a per-cohort reference (the `norm` object: max over all layers for that
 * signal) BEFORE blending. computeCohortSensitivities() does that for a whole
 * stack; this single-layer form takes an optional `norm` for the same effect.
 *
 * @param {object} stats - per-layer calibration stat summary (AGGREGATES only).
 * @param {object} [opts]
 *   - blend: {hessian,fisher,kl} weight override
 *   - norm:  {hessian,fisher,kl} per-signal normalizer (max across cohort)
 * @returns {{
 *   sensitivity: number,        // in [0,1]
 *   components: {hessian:number|null, fisher:number|null, kl:number|null},
 *   present: string[],          // which signals contributed
 *   source: 'hessian'|'fisher'|'kl'|'blend'|'none',
 *   version: string,
 * }}
 */
export function computeLayerSensitivity(stats, opts = {}) {
  const blend = { ...DEFAULT_BLEND, ...(opts.blend || {}) };
  const norm = opts.norm || {};
  const hRaw = diagonalHessianTrace(stats);
  const fRaw = fisherTrace(stats);
  const kRaw = teacherStudentKl(stats);

  const present = [];
  if (hRaw !== null) present.push('hessian');
  if (fRaw !== null) present.push('fisher');
  if (kRaw !== null) present.push('kl');

  if (present.length === 0) {
    // No real signal supplied. Return 0 explicitly and mark source 'none' so the
    // caller can SEE the missing-telemetry case (daq-profile's honest-zero path).
    return {
      sensitivity: 0,
      components: { hessian: null, fisher: null, kl: null },
      present: [],
      source: 'none',
      version: SENSITIVITY_VERSION,
    };
  }

  // Normalize each present signal to [0,1] against its cohort max (or itself when
  // no cohort norm given, which yields 1.0 for a single layer - the allocator's
  // cohort path supplies real norms so distinct layers separate).
  const nh = hRaw === null ? null : hRaw / Math.max(_finite(norm.hessian, hRaw), 1e-12);
  const nf = fRaw === null ? null : fRaw / Math.max(_finite(norm.fisher, fRaw), 1e-12);
  const nk = kRaw === null ? null : kRaw / Math.max(_finite(norm.kl, kRaw), 1e-12);

  let wsum = 0;
  let acc = 0;
  if (nh !== null) { acc += blend.hessian * Math.min(1, nh); wsum += blend.hessian; }
  if (nf !== null) { acc += blend.fisher * Math.min(1, nf); wsum += blend.fisher; }
  if (nk !== null) { acc += blend.kl * Math.min(1, nk); wsum += blend.kl; }
  const sensitivity = wsum > 0 ? acc / wsum : 0;

  return {
    sensitivity: _round(Math.max(0, Math.min(1, sensitivity))),
    components: {
      hessian: hRaw === null ? null : _round(hRaw),
      fisher: fRaw === null ? null : _round(fRaw),
      kl: kRaw === null ? null : _round(kRaw),
    },
    present,
    source: present.length === 1 ? present[0] : 'blend',
    version: SENSITIVITY_VERSION,
  };
}

/**
 * Compute sensitivities for a WHOLE stack of layers, deriving the per-signal
 * cohort normalizers (max over layers) first so distinct layers actually
 * separate on the [0,1] scale. This is the form the allocator consumes.
 *
 * @param {Array<object>} layerStats - array of {layer_id, ...stat summary}
 * @param {object} [opts] - blend override
 * @returns {Array<{layer_id, sensitivity, components, present, source}>}
 */
export function computeCohortSensitivities(layerStats, opts = {}) {
  if (!Array.isArray(layerStats)) {
    throw new TypeError('computeCohortSensitivities requires an array');
  }
  // Pass 1: raw signals -> cohort maxima.
  const raws = layerStats.map((s) => ({
    h: diagonalHessianTrace(s),
    f: fisherTrace(s),
    k: teacherStudentKl(s),
  }));
  const norm = {
    hessian: Math.max(1e-12, ...raws.map((r) => (r.h === null ? 0 : r.h))),
    fisher: Math.max(1e-12, ...raws.map((r) => (r.f === null ? 0 : r.f))),
    kl: Math.max(1e-12, ...raws.map((r) => (r.k === null ? 0 : r.k))),
  };
  // Pass 2: per-layer normalized blend.
  return layerStats.map((s, i) => {
    const out = computeLayerSensitivity(s, { ...opts, norm });
    return {
      layer_id: String(s && s.layer_id != null ? s.layer_id : `layer_${i}`),
      ...out,
    };
  });
}

// -------------------------------------------------------------------------
// 2. AWQ / SmoothQuant outlier (protected-channel) detection
// -------------------------------------------------------------------------

/**
 * Detect salient/outlier input channels from ACTIVATION magnitude statistics
 * (AWQ's salient-channel signal / SmoothQuant's per-channel outliers).
 *
 * Robust z-score: a channel is protected when its mean-abs activation exceeds
 * median + sigmas * (1.4826 * MAD). 1.4826 makes MAD a consistent estimator of
 * the std for Gaussian-ish bulk; the few channels above the knee are the
 * outliers AWQ keeps in higher precision.
 *
 * When MAD is degenerate (zero bulk spread - e.g. a synthetic stack where most
 * channels share a value, or where outliers are a large fraction so the MAD
 * itself collapses to 0), we fall back to AWQ's native salient-channel signal:
 * a magnitude RATIO test (channel > median * ratio). This keeps detection real
 * for both Gaussian-bulk activations (z-score) and heavy-tail / degenerate
 * activations (ratio), instead of silently returning "no outliers".
 *
 * @param {number[]} channel_abs_mean - per-input-channel mean |activation|.
 * @param {object} [opts]
 *   - sigmas: robust-sigma multiplier (default 6.0)
 *   - ratio: magnitude-ratio fallback multiplier vs median (default 4.0)
 *   - max_channels: cap on returned channel count (default 16)
 * @returns {{
 *   protected_channels: number[],   // sorted ascending channel indices
 *   threshold: number,
 *   median: number,
 *   robust_sigma: number,
 *   criterion: 'robust_z'|'magnitude_ratio'|'none',
 *   total_channels: number,
 * }}
 */
export function detectProtectedChannels(channel_abs_mean, opts = {}) {
  const sigmas = Number.isFinite(opts.sigmas) ? Number(opts.sigmas) : OUTLIER_SIGMAS;
  const ratio = Number.isFinite(opts.ratio) && opts.ratio > 1 ? Number(opts.ratio) : 4.0;
  const cap = Number.isInteger(opts.max_channels) && opts.max_channels >= 0
    ? opts.max_channels
    : MAX_PROTECTED_CHANNELS;
  if (!Array.isArray(channel_abs_mean) || channel_abs_mean.length === 0) {
    return { protected_channels: [], threshold: 0, median: 0, robust_sigma: 0, criterion: 'none', total_channels: 0 };
  }
  const mags = channel_abs_mean.map((v) => Math.abs(_finite(v)));
  const sorted = [...mags].sort((a, b) => a - b);
  const med = _median(sorted);
  // MAD = median(|x - median|).
  const absDev = mags.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = _median(absDev);
  const robustSigma = 1.4826 * mad;
  const maxMag = sorted[sorted.length - 1];
  let threshold;
  let criterion;
  if (robustSigma > 0) {
    // Gaussian-bulk path: robust z-score.
    threshold = med + sigmas * robustSigma;
    criterion = 'robust_z';
  } else if (maxMag > med && med >= 0) {
    // Degenerate-MAD path with real spread: AWQ magnitude-ratio fallback.
    // Use max(med,eps) so an all-near-zero bulk with a spike still triggers.
    threshold = Math.max(med, 1e-9) * ratio;
    criterion = 'magnitude_ratio';
  } else {
    // Truly flat (all identical): no outliers.
    threshold = Infinity;
    criterion = 'none';
  }
  const flagged = [];
  for (let i = 0; i < mags.length; i++) {
    if (mags[i] > threshold) flagged.push({ idx: i, mag: mags[i] });
  }
  // Keep the most extreme up to the cap, but return indices in ascending order.
  flagged.sort((a, b) => b.mag - a.mag);
  const kept = flagged.slice(0, cap).map((f) => f.idx).sort((a, b) => a - b);
  return {
    protected_channels: kept,
    threshold: Number.isFinite(threshold) ? _round(threshold) : null,
    median: _round(med),
    robust_sigma: _round(robustSigma),
    criterion,
    total_channels: mags.length,
  };
}

// -------------------------------------------------------------------------
// 3. GENUINE mixed-precision allocator (budget water-filling)
// -------------------------------------------------------------------------

function _backendInfo(method) {
  if (PER_LAYER_BACKENDS[method]) {
    return { honors_per_layer: true, ...PER_LAYER_BACKENDS[method] };
  }
  if (UNIFORM_ONLY_BACKENDS[method]) {
    return { honors_per_layer: false, kind: 'uniform_only', ...UNIFORM_ONLY_BACKENDS[method] };
  }
  return null;
}

export function backendHonorsPerLayer(method) {
  const info = _backendInfo(String(method || '').toLowerCase());
  return !!(info && info.honors_per_layer);
}

function _snapToSupported(bits, supported) {
  if (supported.includes(bits)) return bits;
  // nearest supported, tiebreak HIGHER (safer).
  let best = supported[0];
  let bestD = Infinity;
  for (const b of supported) {
    const d = Math.abs(b - bits);
    if (d < bestD || (d === bestD && b > best)) { bestD = d; best = b; }
  }
  return best;
}

/**
 * Allocate a per-layer integer bit schedule from sensitivities under an AVERAGE
 * bit budget. This is the real allocator: it spends a fixed bit budget across
 * layers, giving more bits to the most sensitive layers and fewer to the flat
 * ones, then snaps each to the backend's supported integer bit set.
 *
 * Algorithm (deterministic, no RNG):
 *   1. Each layer starts at the backend's MIN supported bits (the floor).
 *   2. Compute the total "extra bit-units" budget B = (target_avg - min) * L.
 *   3. Water-fill: repeatedly grant +1 supported-step to the layer with the
 *      highest marginal-utility = sensitivity / (current_bits) until B is
 *      exhausted or all layers reach the cap. Dividing by current_bits gives
 *      diminishing returns so budget spreads, not all dumped on one layer.
 *   4. Snap to supported bit set (already snapped because we only step within it).
 *
 * @param {Array<{layer_id, sensitivity}>} layers - cohort sensitivities.
 * @param {object} opts
 *   - method: backend id (drives supported bit set + honor flag)  REQUIRED
 *   - target_avg_bits: desired average weight bits (default 4.0)
 *   - protected_by_layer: optional map layer_id -> protected_channels[]
 * @returns {{
 *   spec, method, honors_per_layer, target_avg_bits, achieved_avg_bits,
 *   supported_bits, schedule: Array<{layer_id, weight_bits, sensitivity, protected_channels}>,
 *   distinct_widths: number[], collapsed: boolean
 * }}
 */
export function allocateMixedPrecision(layers, opts = {}) {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new TypeError('allocateMixedPrecision requires a non-empty layers array');
  }
  const method = String(opts.method || '').toLowerCase();
  const info = _backendInfo(method);
  if (!info) {
    throw new Error(
      `allocateMixedPrecision: unknown backend method '${opts.method}'. `
      + `Known: ${[...Object.keys(PER_LAYER_BACKENDS), ...Object.keys(UNIFORM_ONLY_BACKENDS)].join(', ')}`,
    );
  }
  const supported = [...info.supported_bits].sort((a, b) => a - b);
  const minB = supported[0];
  const maxB = supported[supported.length - 1];
  const target = Number.isFinite(opts.target_avg_bits) ? Number(opts.target_avg_bits) : 4.0;
  const protectedMap = opts.protected_by_layer || {};

  const L = layers.length;
  const sens = layers.map((l) => Math.max(0, _finite(l && l.sensitivity, 0)));

  // Start everyone at the floor.
  const bits = new Array(L).fill(minB);

  if (!info.honors_per_layer) {
    // Backend can only apply ONE width: pick the supported bit nearest target,
    // tiebreak HIGHER (safer). Surfaced as collapsed:true so the receipt is loud.
    const uniform = _snapToSupported(Math.round(target), supported);
    const schedule = layers.map((l, i) => ({
      layer_id: String(l && l.layer_id != null ? l.layer_id : `layer_${i}`),
      weight_bits: uniform,
      sensitivity: _round(sens[i]),
      protected_channels: Array.isArray(protectedMap[l && l.layer_id]) ? protectedMap[l.layer_id].slice(0, MAX_PROTECTED_CHANNELS) : [],
    }));
    return {
      spec: 'kolm-mixed-precision-allocation-1',
      method,
      honors_per_layer: false,
      target_avg_bits: target,
      achieved_avg_bits: uniform,
      supported_bits: supported,
      schedule,
      distinct_widths: [uniform],
      collapsed: true,
    };
  }

  // Per-layer water-fill. Budget in "bit-units above floor".
  let budget = (target - minB) * L;
  // Guard: if target below floor, everyone sits at floor (budget<=0).
  // Each step moves a layer to the NEXT supported width.
  const nextStep = (b) => {
    const idx = supported.indexOf(b);
    return idx >= 0 && idx + 1 < supported.length ? supported[idx + 1] : b;
  };
  // Deterministic greedy: while budget allows a +step somewhere, give it to the
  // layer maximizing sensitivity / current_bits (diminishing returns), with a
  // stable tiebreak on layer index so the schedule is reproducible.
  let guard = L * supported.length + 1;
  while (budget > 0 && guard-- > 0) {
    let bestI = -1;
    let bestU = -Infinity;
    let bestCost = 0;
    for (let i = 0; i < L; i++) {
      if (bits[i] >= maxB) continue;
      const nb = nextStep(bits[i]);
      const cost = nb - bits[i];
      if (cost > budget) continue;
      const utility = sens[i] / bits[i]; // marginal value, diminishing
      if (utility > bestU + 1e-12 || (Math.abs(utility - bestU) <= 1e-12 && bestI === -1)) {
        bestU = utility; bestI = i; bestCost = cost;
      }
    }
    if (bestI === -1) break; // nothing affordable -> stop
    bits[bestI] = nextStep(bits[bestI]);
    budget -= bestCost;
  }

  const schedule = layers.map((l, i) => ({
    layer_id: String(l && l.layer_id != null ? l.layer_id : `layer_${i}`),
    weight_bits: bits[i],
    sensitivity: _round(sens[i]),
    protected_channels: Array.isArray(protectedMap[l && l.layer_id])
      ? protectedMap[l.layer_id].slice(0, MAX_PROTECTED_CHANNELS) : [],
  }));
  const sum = bits.reduce((a, b) => a + b, 0);
  const distinct = [...new Set(bits)].sort((a, b) => a - b);
  return {
    spec: 'kolm-mixed-precision-allocation-1',
    method,
    honors_per_layer: true,
    target_avg_bits: target,
    achieved_avg_bits: _round(sum / L, 4),
    supported_bits: supported,
    schedule,
    distinct_widths: distinct,
    collapsed: false,
  };
}

// -------------------------------------------------------------------------
// 4. backend application plan (what WILL actually be applied)
// -------------------------------------------------------------------------

/**
 * Given a REQUESTED per-layer schedule and a backend method, compute the
 * schedule the backend will ACTUALLY apply. For per-layer backends this is the
 * requested schedule snapped to supported widths (typically identity). For
 * uniform-only backends it is the collapse to a single width - surfaced loudly.
 *
 * @returns {{ method, honors_per_layer, applied: Array<{layer_id,weight_bits}>,
 *            collapsed: boolean, collapse_width: number|null,
 *            snapped_layers: string[] }}
 */
export function planBackendApplication(schedule, method) {
  const m = String(method || '').toLowerCase();
  const info = _backendInfo(m);
  if (!info) throw new Error(`planBackendApplication: unknown backend '${method}'`);
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new TypeError('planBackendApplication requires a non-empty schedule');
  }
  const supported = [...info.supported_bits].sort((a, b) => a - b);
  const snapped = [];

  if (!info.honors_per_layer) {
    // Uniform collapse: majority weight_bits, snapped to supported (tiebreak hi).
    const counts = new Map();
    for (const l of schedule) {
      const wb = Number(l.weight_bits);
      counts.set(wb, (counts.get(wb) || 0) + 1);
    }
    const major = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))[0][0];
    const width = _snapToSupported(major, supported);
    const applied = schedule.map((l) => ({ layer_id: String(l.layer_id), weight_bits: width }));
    return {
      method: m,
      honors_per_layer: false,
      applied,
      collapsed: true,
      collapse_width: width,
      snapped_layers: [],
    };
  }

  const applied = schedule.map((l) => {
    const want = Number(l.weight_bits);
    const got = _snapToSupported(want, supported);
    if (got !== want) snapped.push(String(l.layer_id));
    return { layer_id: String(l.layer_id), weight_bits: got };
  });
  return {
    method: m,
    honors_per_layer: true,
    applied,
    collapsed: false,
    collapse_width: null,
    snapped_layers: snapped,
  };
}

// -------------------------------------------------------------------------
// 5. schedule-equality receipt (applied == requested, fail-closed)
// -------------------------------------------------------------------------

function _canonicalSchedule(sch) {
  // Canonical = ordered array of [layer_id, weight_bits] pairs. Order is
  // significant (matches the layer order quantize.py walks).
  return (sch || []).map((l) => [String(l.layer_id), Number(l.weight_bits)]);
}

export function hashSchedule(sch) {
  const canon = JSON.stringify(_canonicalSchedule(sch));
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/**
 * Build the receipt proving the APPLIED schedule equals the REQUESTED schedule.
 *
 * schedule_honored is true ONLY when every layer's applied weight_bits equals
 * the requested weight_bits AND the layer set/order matches AND the backend did
 * not collapse a multi-width schedule. Any divergence is reported per-layer.
 *
 * @param {Array<{layer_id,weight_bits}>} requested
 * @param {Array<{layer_id,weight_bits}>} applied
 * @param {object} [meta] - {method, honors_per_layer, collapsed}
 * @returns {{
 *   spec, schedule_honored: boolean, requested_hash, applied_hash, equal: boolean,
 *   layer_count, mismatches: Array<{layer_id, requested, applied}>,
 *   order_ok: boolean, collapsed: boolean, version
 * }}
 */
export function buildScheduleReceipt(requested, applied, meta = {}) {
  const req = Array.isArray(requested) ? requested : [];
  const app = Array.isArray(applied) ? applied : [];
  const reqCanon = _canonicalSchedule(req);
  const appCanon = _canonicalSchedule(app);
  const requested_hash = crypto.createHash('sha256').update(JSON.stringify(reqCanon)).digest('hex');
  const applied_hash = crypto.createHash('sha256').update(JSON.stringify(appCanon)).digest('hex');

  const mismatches = [];
  let order_ok = reqCanon.length === appCanon.length;
  const n = Math.max(reqCanon.length, appCanon.length);
  for (let i = 0; i < n; i++) {
    const r = reqCanon[i];
    const a = appCanon[i];
    if (!r || !a) {
      mismatches.push({ layer_id: (r && r[0]) || (a && a[0]) || `idx_${i}`, requested: r ? r[1] : null, applied: a ? a[1] : null });
      order_ok = false;
      continue;
    }
    if (r[0] !== a[0]) order_ok = false; // layer order/identity diverged
    if (r[0] !== a[0] || r[1] !== a[1]) {
      mismatches.push({ layer_id: r[0], requested: r[1], applied: a[1] });
    }
  }
  const equal = requested_hash === applied_hash;
  const collapsed = !!meta.collapsed;
  // Fail-closed: honored requires hash equality, matching order, no mismatch,
  // and no collapse of a real multi-width schedule.
  const reqWidths = new Set(reqCanon.map((p) => p[1]));
  const multiWidthCollapsed = collapsed && reqWidths.size > 1;
  const schedule_honored = equal && order_ok && mismatches.length === 0 && !multiWidthCollapsed;

  return {
    spec: 'kolm-schedule-equality-receipt-1',
    schedule_honored,
    requested_hash,
    applied_hash,
    equal,
    order_ok,
    collapsed,
    multi_width_collapsed: multiWidthCollapsed,
    layer_count: reqCanon.length,
    distinct_requested_widths: [...reqWidths].sort((a, b) => a - b),
    mismatches,
    method: meta.method || null,
    honors_per_layer: meta.honors_per_layer ?? null,
    version: SENSITIVITY_VERSION,
  };
}

// -------------------------------------------------------------------------
// End-to-end convenience: stats -> sensitivities -> allocation -> receipt.
// Returns daq-profile-ready telemetry too (kl_sensitivity + outlier_channels)
// so the EXISTING src/daq-profile.js buildDaqProfile consumes our REAL signal
// without any edit to that funnel.
// -------------------------------------------------------------------------

/**
 * @param {Array<object>} layerStats - per-layer calibration stat summaries.
 *   Each may carry input_sq_mean / hessian_diag / hessian_trace, fisher_*,
 *   teacher_student_kl, and channel_abs_mean (for outlier detection).
 * @param {object} opts - { method, target_avg_bits, blend, outlier_sigmas }
 * @returns {{
 *   sensitivities, allocation, receipt,
 *   daq_telemetry: Array<{layer_id, kl_sensitivity, outlier_channels, group_size}>
 * }}
 */
export function planLayerSchedule(layerStats, opts = {}) {
  if (!Array.isArray(layerStats) || layerStats.length === 0) {
    throw new TypeError('planLayerSchedule requires a non-empty layerStats array');
  }
  const sensitivities = computeCohortSensitivities(layerStats, { blend: opts.blend });

  // Outlier/protected channels per layer from activation magnitudes.
  const protectedMap = {};
  const daq_telemetry = layerStats.map((s, i) => {
    const lid = sensitivities[i].layer_id;
    const det = Array.isArray(s && s.channel_abs_mean)
      ? detectProtectedChannels(s.channel_abs_mean, { sigmas: opts.outlier_sigmas })
      : { protected_channels: [] };
    protectedMap[lid] = det.protected_channels;
    return {
      layer_id: lid,
      // Feed our REAL signal straight into daq-profile.js's kl_sensitivity slot.
      kl_sensitivity: sensitivities[i].sensitivity,
      outlier_channels: det.protected_channels,
      group_size: Number.isInteger(s && s.group_size) ? s.group_size : 128,
    };
  });

  const allocation = allocateMixedPrecision(
    sensitivities.map((x) => ({ layer_id: x.layer_id, sensitivity: x.sensitivity })),
    { method: opts.method, target_avg_bits: opts.target_avg_bits, protected_by_layer: protectedMap },
  );

  const plan = planBackendApplication(allocation.schedule, opts.method);
  const receipt = buildScheduleReceipt(
    allocation.schedule.map((l) => ({ layer_id: l.layer_id, weight_bits: l.weight_bits })),
    plan.applied,
    { method: plan.method, honors_per_layer: plan.honors_per_layer, collapsed: plan.collapsed },
  );

  return { sensitivities, allocation, plan, receipt, daq_telemetry };
}

// -------------------------------------------------------------------------
// ENV-GATED optional torch calibration extractor (REAL path stays pure-JS).
//
// The pure-JS path above consumes stat SUMMARIES (second moments, KL scalars)
// that an upstream calibration pass produced. For operators who want this module
// to drive the calibration forward-pass itself (extract input_sq_mean per Linear
// from a torch model + a calibration set), set KOLM_SENSITIVITY_BACKEND=torch.
// We DO NOT silently no-op: we FAIL LOUD with the install hint. The default
// (pure-JS) path is the real, tested code path.
// -------------------------------------------------------------------------

export function requireCalibrationBackend() {
  const backend = String(process.env.KOLM_SENSITIVITY_BACKEND || 'pure-js').toLowerCase();
  if (backend === 'pure-js' || backend === 'js' || backend === '') {
    return { backend: 'pure-js', ready: true };
  }
  if (backend === 'torch') {
    const err = new Error(
      'KOLM_SENSITIVITY_BACKEND=torch requested but the torch calibration extractor '
      + 'is an optional path. Install it and run the extractor to produce per-layer '
      + 'input_sq_mean / fisher_diag stat summaries, then feed them to '
      + 'computeCohortSensitivities (pure-JS).\n'
      + 'install hint: pip install "torch>=2.1" transformers safetensors  '
      + '(then: python workers/quantize/scripts/quantize.py calibration-stats ...)',
    );
    err.code = 'CALIBRATION_BACKEND_TORCH_REQUIRED';
    err.install_hint = 'pip install "torch>=2.1" transformers safetensors';
    throw err;
  }
  const err = new Error(`Unknown KOLM_SENSITIVITY_BACKEND='${backend}' (expected 'pure-js' or 'torch')`);
  err.code = 'CALIBRATION_BACKEND_UNKNOWN';
  throw err;
}

export default {
  SENSITIVITY_VERSION,
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
};
