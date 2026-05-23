// W719 — Distillation-Aware Quantization (DAQ) per-layer bit budget profile.
//
// Atomic items pinned:
//   1) Layer-importance analysis (Hessian/Fisher proxy via kl_sensitivity)
//   2) Mixed-precision per-layer bit allocation
//   3) Bakeoff harness across candidate profiles (see src/quantize-bakeoff.js)
//   4) Manifest records per-layer bit budget (see src/artifact.js
//      mixed_precision_profile field)
//
// Design (per docs/research/kolm-billion-dollar-distillation-lab-2026-05-24.md
// Invention 1): a DAQ profile is an ordered ARRAY of per-layer objects whose
// fields are bit-budgets, group sizes, protected channels, scale modes, and
// the kl_sensitivity proxy that drove the decision. The profile is consumed
// by workers/quantize/scripts/quantize.py --mixed-precision <profile.json>
// and gets embedded in manifest.mixed_precision_profile so a verifier can
// re-run quantize.py against the same per-layer schedule and reproduce the
// quantized weights bit-for-bit.
//
// Honesty contract: kl_sensitivity defaults to a deterministic proxy when
// real teacher-vs-student KL telemetry is not available (zero per layer).
// The bakeoff envelope makes the missing-telemetry case obvious; the CLI
// auto path exits 3 with an honest envelope.

import crypto from 'node:crypto';

export const DAQ_VERSION = 'w719-v1';

// Allowed-range invariants. Bits are integer in [1, 16]; group_size is a
// power-of-two in [16, 512]; clip_percentile is a float in (0, 100].
const ALLOWED_BITS = { min: 1, max: 16 };
const ALLOWED_GROUP_SIZES = new Set([16, 32, 64, 128, 256, 512]);
const ALLOWED_SCALE_MODES = new Set([
  'smoothquant',
  'smoothquant+awq',
  'awq',
  'gptq',
  'rtn',
  'hqq',
  'none',
]);
const ALLOWED_FALLBACK_DTYPES = new Set(['bf16', 'fp16', 'fp32', 'int8']);

// Threshold for the bit-decision rule. > HIGH_THRESHOLD → 8 bits (preserve
// quality on the layers that move student KL the most). < LOW_THRESHOLD →
// 4 bits flat (no protected channels — the layer is near-lossless to
// aggressive quant). Otherwise 4 bits with a small protected-channel list.
const KL_HIGH_THRESHOLD = 0.05;
const KL_LOW_THRESHOLD = 0.01;

// DEFAULT_PROFILE is the per-layer object filled in when telemetry omits
// fields. Verifiers consume this shape as the canonical schema.
export const DEFAULT_PROFILE = Object.freeze({
  layer_id: 'unknown',
  weight_bits: 4,
  activation_bits: 8,
  kv_bits: 8,
  group_size: 128,
  protected_channels: [],
  clip_percentile: 99.95,
  scale_mode: 'smoothquant+awq',
  fallback_dtype: 'bf16',
  kl_sensitivity: 0.0,
});

/**
 * Decide a bit-width profile for ONE layer based on its telemetry.
 *
 * Rule (Hessian/Fisher proxy — see research doc Invention 1):
 *   - kl_sensitivity > 0.05  → 8-bit weights, 8-bit activations, no protected channels
 *     (the layer is too sensitive to push under 8 bits; preserve quality outright)
 *   - kl_sensitivity < 0.01  → 4-bit weights, 4-bit activations, no protected channels
 *     (the layer is near-lossless under aggressive quant; push hardest here)
 *   - otherwise              → 4-bit weights, 8-bit activations, top-k protected
 *     channels surfaced from telemetry.outlier_channels if present, else []
 *
 * @param {object} layer_telemetry — { layer_id, kl_sensitivity?, outlier_channels?,
 *   group_size?, scale_mode?, fallback_dtype?, clip_percentile? }
 * @returns {object} a per-layer DAQ profile (frozen schema-valid object)
 */
export function decideBitsForLayer(layer_telemetry) {
  if (!layer_telemetry || typeof layer_telemetry !== 'object') {
    throw new TypeError('decideBitsForLayer requires a layer_telemetry object');
  }
  const layer_id = String(layer_telemetry.layer_id || 'unknown');
  const kl = Number.isFinite(layer_telemetry.kl_sensitivity)
    ? Number(layer_telemetry.kl_sensitivity)
    : 0.0;
  const group_size = ALLOWED_GROUP_SIZES.has(layer_telemetry.group_size)
    ? layer_telemetry.group_size
    : DEFAULT_PROFILE.group_size;
  const scale_mode = ALLOWED_SCALE_MODES.has(layer_telemetry.scale_mode)
    ? layer_telemetry.scale_mode
    : DEFAULT_PROFILE.scale_mode;
  const fallback_dtype = ALLOWED_FALLBACK_DTYPES.has(layer_telemetry.fallback_dtype)
    ? layer_telemetry.fallback_dtype
    : DEFAULT_PROFILE.fallback_dtype;
  const clip_percentile = Number.isFinite(layer_telemetry.clip_percentile)
    ? Number(layer_telemetry.clip_percentile)
    : DEFAULT_PROFILE.clip_percentile;

  let weight_bits;
  let activation_bits;
  let kv_bits;
  let protected_channels = [];

  if (kl > KL_HIGH_THRESHOLD) {
    // High-sensitivity branch: protect everything with 8 bits.
    weight_bits = 8;
    activation_bits = 8;
    kv_bits = 8;
  } else if (kl < KL_LOW_THRESHOLD) {
    // Low-sensitivity branch: push hardest.
    weight_bits = 4;
    activation_bits = 4;
    kv_bits = 8;
  } else {
    // Mid-range: keep activations at 8 bits and protect outlier channels.
    weight_bits = 4;
    activation_bits = 8;
    kv_bits = 8;
    const outliers = Array.isArray(layer_telemetry.outlier_channels)
      ? layer_telemetry.outlier_channels.filter((x) => Number.isInteger(x) && x >= 0)
      : [];
    // Cap the protected list to keep manifest size bounded; 16 channels covers
    // empirically observed SmoothQuant outlier counts (Xiao 2023).
    protected_channels = outliers.slice(0, 16);
  }

  return {
    layer_id,
    weight_bits,
    activation_bits,
    kv_bits,
    group_size,
    protected_channels,
    clip_percentile,
    scale_mode,
    fallback_dtype,
    kl_sensitivity: Number(kl.toFixed(6)),
  };
}

/**
 * Build a full DAQ profile (one entry per layer) from a layer-telemetry array.
 *
 * @param {Array<object>} layer_telemetry — array of per-layer telemetry rows
 * @param {object} opts
 *   - default_group_size: override the per-layer group_size when telemetry omits
 *   - default_scale_mode: override the per-layer scale_mode when telemetry omits
 * @returns {Array<object>} per-layer profile objects, ordered as input
 */
export function buildDaqProfile(layer_telemetry, opts = {}) {
  if (!Array.isArray(layer_telemetry)) {
    throw new TypeError('buildDaqProfile requires an array of layer telemetry rows');
  }
  const default_group_size = ALLOWED_GROUP_SIZES.has(opts.default_group_size)
    ? opts.default_group_size
    : DEFAULT_PROFILE.group_size;
  const default_scale_mode = ALLOWED_SCALE_MODES.has(opts.default_scale_mode)
    ? opts.default_scale_mode
    : DEFAULT_PROFILE.scale_mode;
  return layer_telemetry.map((row) => {
    const merged = {
      group_size: default_group_size,
      scale_mode: default_scale_mode,
      ...row,
    };
    return decideBitsForLayer(merged);
  });
}

/**
 * Summarize a built DAQ profile: total layer count, weighted average bits,
 * savings vs uniform int8, and how many layers carry protected channels.
 *
 * Weighted average is over `weight_bits` only (the storage axis that drives
 * VRAM consumption); activations/kv are runtime axes the inference engine
 * scales separately and are not part of the saved-weights footprint.
 *
 * @param {Array<object>} profile_array — output of buildDaqProfile
 * @returns {{
 *   total_layers: number,
 *   weighted_avg_bits: number,
 *   vs_uniform_int8_savings_pct: number,
 *   layers_protected: number,
 * }}
 */
export function summarizeBitBudget(profile_array) {
  if (!Array.isArray(profile_array)) {
    throw new TypeError('summarizeBitBudget requires an array');
  }
  if (profile_array.length === 0) {
    return {
      total_layers: 0,
      weighted_avg_bits: 0,
      vs_uniform_int8_savings_pct: 0,
      layers_protected: 0,
    };
  }
  let sum_bits = 0;
  let layers_protected = 0;
  for (const p of profile_array) {
    const b = Number(p.weight_bits) || 0;
    sum_bits += b;
    if (Array.isArray(p.protected_channels) && p.protected_channels.length > 0) {
      layers_protected += 1;
    }
  }
  const weighted_avg_bits = Number((sum_bits / profile_array.length).toFixed(4));
  // Uniform int8 = 8 bits per layer. Savings is the % reduction in average bits.
  const vs_uniform_int8_savings_pct = Number((((8 - weighted_avg_bits) / 8) * 100).toFixed(2));
  return {
    total_layers: profile_array.length,
    weighted_avg_bits,
    vs_uniform_int8_savings_pct,
    layers_protected,
  };
}

/**
 * Validate a per-layer profile object against the DAQ schema.
 *
 * @param {object} profile — a single per-layer profile object
 * @returns {{ok: boolean, errors: Array<string>}}
 */
export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') {
    return { ok: false, errors: ['profile is not an object'] };
  }
  if (!profile.layer_id || typeof profile.layer_id !== 'string') {
    errors.push('layer_id missing or not a string');
  }
  for (const k of ['weight_bits', 'activation_bits', 'kv_bits']) {
    const v = profile[k];
    if (!Number.isInteger(v)) {
      errors.push(`${k} must be an integer`);
    } else if (v < ALLOWED_BITS.min || v > ALLOWED_BITS.max) {
      errors.push(`${k}=${v} out of allowed range [${ALLOWED_BITS.min},${ALLOWED_BITS.max}]`);
    }
  }
  if (!ALLOWED_GROUP_SIZES.has(profile.group_size)) {
    errors.push(`group_size=${profile.group_size} not in {${[...ALLOWED_GROUP_SIZES].join(',')}}`);
  }
  if (!Array.isArray(profile.protected_channels)) {
    errors.push('protected_channels must be an array');
  } else {
    for (const c of profile.protected_channels) {
      if (!Number.isInteger(c) || c < 0) {
        errors.push(`protected_channels entry ${c} not a non-negative integer`);
        break;
      }
    }
  }
  if (!Number.isFinite(profile.clip_percentile)
    || profile.clip_percentile <= 0
    || profile.clip_percentile > 100) {
    errors.push(`clip_percentile=${profile.clip_percentile} must be in (0, 100]`);
  }
  if (!ALLOWED_SCALE_MODES.has(profile.scale_mode)) {
    errors.push(`scale_mode=${profile.scale_mode} not in {${[...ALLOWED_SCALE_MODES].join(',')}}`);
  }
  if (!ALLOWED_FALLBACK_DTYPES.has(profile.fallback_dtype)) {
    errors.push(`fallback_dtype=${profile.fallback_dtype} not in {${[...ALLOWED_FALLBACK_DTYPES].join(',')}}`);
  }
  if (!Number.isFinite(profile.kl_sensitivity) || profile.kl_sensitivity < 0) {
    errors.push(`kl_sensitivity=${profile.kl_sensitivity} must be a finite non-negative number`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Stable sha256 over a canonical-JSON of the DAQ profile array. Used by
 * src/artifact.js to bind the profile into artifact_hash via the
 * mixed_precision_profile_hash field (extends the W460/W409q pattern).
 */
export function hashDaqProfile(profile_array) {
  const canonical = JSON.stringify(profile_array, Object.keys(profile_array[0] || {}).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
