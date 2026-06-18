// W702 - bounded memory fit calculator.
//
// "Will this model at this quant fit in my VRAM at this context length?"
//
// This is an estimator, not a runtime allocator. It deliberately keeps the
// same public fields W866 introduced while bounding every caller-controlled
// numeric input so public /v1/fit responses never contain NaN or Infinity.

import crypto from 'node:crypto';

export const FIT_VERSION = 'forge-fit-v1';
export const FIT_CONTRACT_VERSION = 'w702-v1';

export const FIT_LIMITS = Object.freeze({
  MIN_MODEL_PARAMS_B: 0.01,
  MAX_MODEL_PARAMS_B: 1_000_000,
  MIN_VRAM_GB: 0.1,
  MAX_VRAM_GB: 1_000_000,
  MIN_CONTEXT: 1,
  MAX_CONTEXT: 1_048_576,
  MIN_BATCH: 1,
  MAX_BATCH: 1024,
  MAX_SUPPORTED_METHODS: 128,
});

export const BYTES_PER_PARAM = Object.freeze({
  fp16: 2.0,
  bf16: 2.0,
  fp8: 1.0,
  nvfp4: 0.5,
  int8: 1.0,
  int4: 0.55,
  'gguf-q8': 1.07,
  'gguf-q6k': 0.82,
  'gguf-q5km': 0.69,
  'gguf-q4km': 0.56,
  'gguf-q3km': 0.45,
  'gguf-q2k': 0.35,
  'gguf-iq4xs': 0.53,
  'gguf-iq3xxs': 0.40,
  'gguf-iq2xs': 0.30,
  exl2: 0.50,
  'gptq-4bit': 0.56,
  'awq-4bit': 0.56,
  hqq: 0.50,
  'mlx-4bit': 0.55,
});

export const KV_PRECISION_BYTES = Object.freeze({
  fp16: 4,
  bf16: 4,
  fp8: 2,
  int8: 2,
  int4: 1,
});

export const QUALITY_ORDER = Object.freeze([
  'fp16', 'bf16', 'fp8', 'nvfp4', 'gguf-q8', 'gguf-q6k', 'gguf-q5km',
  'awq-4bit', 'gptq-4bit', 'gguf-q4km', 'gguf-iq4xs', 'int4', 'exl2',
  'mlx-4bit', 'hqq', 'gguf-q3km', 'gguf-iq3xxs', 'gguf-q2k', 'gguf-iq2xs',
]);

const KV_GB_PER_BPARAM_8K = 0.18;
const ACTIVATION_RATIO = 0.08;
const OVERHEAD_GB = 1.0;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const FIT_CLIENT_ERROR_CODES = new Set([
  'fit_requires_model_params_b',
  'fit_requires_vram_gb',
  'fit_requires_context',
  'fit_requires_batch',
  'fit_unknown_quant',
  'fit_unknown_kv_precision',
  'fit_supported_methods_invalid',
]);

function _error(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function _round1(value) {
  if (!Number.isFinite(value)) throw _error('fit_non_finite_estimate');
  return Math.round(value * 10) / 10;
}

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map((v) => _canonicalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = _canonicalize(value[key]);
    return out;
  }
  return value;
}

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(JSON.stringify(_canonicalize(value))).digest('hex');
}

function _withHash(envelope, field) {
  const body = { ...envelope };
  delete body[field];
  return { ...body, [field]: _sha256Hex(body) };
}

function _finiteNumber(value, code, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw _error(code);
  return n;
}

function _finiteInt(value, code, min, max) {
  const n = _finiteNumber(value, code, min, max);
  return Math.trunc(n);
}

function _normalizeQuant(quant) {
  const q = String(quant || '').trim().toLowerCase();
  if (!q || CONTROL_RE.test(q) || !BYTES_PER_PARAM[q]) throw _error('fit_unknown_quant');
  return q;
}

function _normalizeKvPrecision(kvPrecision) {
  const q = String(kvPrecision || 'fp16').trim().toLowerCase();
  if (!q || CONTROL_RE.test(q) || !KV_PRECISION_BYTES[q]) throw _error('fit_unknown_kv_precision');
  return q;
}

function _normalizeInputs(input = {}) {
  return {
    model_params_b: _finiteNumber(
      input.model_params_b,
      'fit_requires_model_params_b',
      FIT_LIMITS.MIN_MODEL_PARAMS_B,
      FIT_LIMITS.MAX_MODEL_PARAMS_B,
    ),
    quant: _normalizeQuant(input.quant),
    vram_gb: _finiteNumber(
      input.vram_gb,
      'fit_requires_vram_gb',
      FIT_LIMITS.MIN_VRAM_GB,
      FIT_LIMITS.MAX_VRAM_GB,
    ),
    context: _finiteInt(
      input.context ?? 8192,
      'fit_requires_context',
      FIT_LIMITS.MIN_CONTEXT,
      FIT_LIMITS.MAX_CONTEXT,
    ),
    batch: _finiteInt(
      input.batch ?? 1,
      'fit_requires_batch',
      FIT_LIMITS.MIN_BATCH,
      FIT_LIMITS.MAX_BATCH,
    ),
    kv_precision: _normalizeKvPrecision(input.kv_precision),
  };
}

function _assumptions() {
  return {
    kv_gb_per_bparam_8k_fp16: KV_GB_PER_BPARAM_8K,
    activation_ratio: ACTIVATION_RATIO,
    overhead_gb: OVERHEAD_GB,
    conservative_estimator: true,
  };
}

function _recommendation({ fits, tight, headroomGb, totalGb, vramGb, bpp }) {
  if (!fits) {
    const smaller = Object.entries(BYTES_PER_PARAM)
      .filter(([, value]) => value < bpp)
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key);
    return smaller.length
      ? `try ${smaller[0]} or smaller - current quant exceeds VRAM by ${_round1(totalGb - vramGb)} GB`
      : `model too large for ${vramGb} GB VRAM - needs sharding or CPU offload`;
  }
  if (tight) return 'fits but headroom <10% - long contexts may OOM. Consider quant tier down or shorter ctx';
  return `comfortable fit (${headroomGb} GB free)`;
}

export function estimateMemoryFit(input = {}) {
  const normalized = _normalizeInputs(input);
  const bpp = BYTES_PER_PARAM[normalized.quant];
  const est_weights_gb = _round1(normalized.model_params_b * bpp);
  const kvByteRatio = KV_PRECISION_BYTES[normalized.kv_precision] / KV_PRECISION_BYTES.fp16;
  const est_kv_gb = _round1(
    normalized.model_params_b
      * KV_GB_PER_BPARAM_8K
      * (normalized.context / 8192)
      * normalized.batch
      * kvByteRatio,
  );
  const est_activations_gb = _round1(est_weights_gb * ACTIVATION_RATIO);
  const overhead_gb = OVERHEAD_GB;
  const est_total_gb = _round1(est_weights_gb + est_kv_gb + est_activations_gb + overhead_gb);
  const headroom_gb = _round1(normalized.vram_gb - est_total_gb);
  const fits = est_total_gb <= normalized.vram_gb;
  const tight = fits && headroom_gb < normalized.vram_gb * 0.10;
  const fit_class = fits ? (tight ? 'tight' : 'comfortable') : 'over';
  const recommendation = _recommendation({
    fits,
    tight,
    headroomGb: headroom_gb,
    totalGb: est_total_gb,
    vramGb: normalized.vram_gb,
    bpp,
  });

  return _withHash({
    fits,
    tight,
    fit_class,
    est_total_gb,
    est_weights_gb,
    est_kv_gb,
    est_activations_gb,
    overhead_gb,
    headroom_gb,
    bytes_per_param: bpp,
    context: normalized.context,
    batch: normalized.batch,
    kv_precision: normalized.kv_precision,
    recommendation,
    assumptions: _assumptions(),
    forge_fit_version: FIT_VERSION,
    contract_version: FIT_CONTRACT_VERSION,
  }, 'fit_sha256');
}

function _normalizeSupportedMethods(methods) {
  const source = Array.isArray(methods) ? methods : QUALITY_ORDER;
  if (source.length > FIT_LIMITS.MAX_SUPPORTED_METHODS) throw _error('fit_supported_methods_invalid');
  const out = [];
  const seen = new Set();
  for (const method of source) {
    const q = String(method || '').trim().toLowerCase();
    if (!q || CONTROL_RE.test(q) || seen.has(q) || !BYTES_PER_PARAM[q]) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}

export function pickBestFitTarget(input = {}) {
  const supported = _normalizeSupportedMethods(input.supported_methods);
  const base = {
    model_params_b: input.model_params_b,
    vram_gb: input.vram_gb,
    context: input.context ?? 8192,
    batch: input.batch ?? 1,
    kv_precision: input.kv_precision ?? 'fp16',
  };
  const attempts = [];

  for (const quant of QUALITY_ORDER) {
    if (!supported.includes(quant)) continue;
    const fit = estimateMemoryFit({ ...base, quant });
    attempts.push({
      quant,
      fit_class: fit.fit_class,
      est_total_gb: fit.est_total_gb,
      headroom_gb: fit.headroom_gb,
    });
    if (fit.fits && !fit.tight) {
      return _withHash({
        picked: quant,
        fit,
        rationale: 'highest-quality quant that fits with headroom',
        candidates_evaluated: attempts.length,
        forge_fit_version: FIT_VERSION,
        contract_version: FIT_CONTRACT_VERSION,
      }, 'pick_sha256');
    }
  }

  for (const attempt of attempts) {
    if (attempt.fit_class === 'tight') {
      const fit = estimateMemoryFit({ ...base, quant: attempt.quant });
      return _withHash({
        picked: attempt.quant,
        fit,
        rationale: 'tight fit - last viable target',
        candidates_evaluated: attempts.length,
        forge_fit_version: FIT_VERSION,
        contract_version: FIT_CONTRACT_VERSION,
      }, 'pick_sha256');
    }
  }

  const smallest = attempts.slice().sort((a, b) => a.est_total_gb - b.est_total_gb)[0] || null;
  return _withHash({
    picked: null,
    fit: null,
    rationale: `nothing fits - model ${base.model_params_b}B too large for ${base.vram_gb} GB VRAM. Needs sharding or CPU.`,
    candidates_evaluated: attempts.length,
    smallest_attempt: smallest,
    forge_fit_version: FIT_VERSION,
    contract_version: FIT_CONTRACT_VERSION,
  }, 'pick_sha256');
}

export function safeFitError(error) {
  const code = String(error && (error.code || error.message) || 'fit_error');
  if (FIT_CLIENT_ERROR_CODES.has(code)) return code;
  const match = code.match(/\bfit_[a-z0-9_]+\b/);
  if (match && FIT_CLIENT_ERROR_CODES.has(match[0])) return match[0];
  return 'fit_error';
}

export function fitErrorStatus(error) {
  return FIT_CLIENT_ERROR_CODES.has(safeFitError(error)) ? 400 : 500;
}

export const _internal = {
  ACTIVATION_RATIO,
  FIT_CLIENT_ERROR_CODES,
  KV_GB_PER_BPARAM_8K,
  OVERHEAD_GB,
  _normalizeInputs,
  _normalizeSupportedMethods,
};

export default {
  FIT_VERSION,
  FIT_CONTRACT_VERSION,
  FIT_LIMITS,
  BYTES_PER_PARAM,
  KV_PRECISION_BYTES,
  QUALITY_ORDER,
  estimateMemoryFit,
  fitErrorStatus,
  pickBestFitTarget,
  safeFitError,
};
