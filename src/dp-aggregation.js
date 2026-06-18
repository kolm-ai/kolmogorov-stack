// W698 - Differential-privacy aggregation primitive.
//
// Pure-JS Laplace mechanism for count queries over the W757 pattern lake.
// Separate module from src/pattern-lake.js so the math can be unit-tested
// without spinning up the event-store, and so non-lake call sites can reuse
// the same DP code path without importing the entire lake.
//
// HONESTY CONTRACT:
//   - Epsilon floor of 0.1 - never publish an aggregate below the contract
//     floor. The validateEpsilon() helper throws `epsilon_below_floor`.
//   - Mechanism stamp `laplace_v1` accompanies every aggregate so consumers
//     can branch on the exact algorithm.
//   - The default noise source is pseudo-random JS Math.random - NOT
//     cryptographic. Treat this as a local/research-quality DP primitive,
//     not a standalone production privacy guarantee.
//   - Proof metadata intentionally does NOT include a hash of raw count
//     values. Small count dictionaries are brute-forceable; the proof hashes
//     the public output, public keyset, and budget envelope only.
//
// W411 invariant - this module is data-only (no tenant context); the caller
// is responsible for fencing tenant boundaries before passing counts in.

import crypto from 'node:crypto';

export const DP_AGGREGATION_CONTRACT_VERSION = 'w698-v1';
export const DP_VERSION = DP_AGGREGATION_CONTRACT_VERSION;
export const DP_MECHANISM = 'laplace_v1';
export const DP_DELTA = 0;

export const MAX_DP_KEYS = 1024;
export const MAX_DP_KEY_BYTES = 256;
export const MAX_DP_COUNT = 1_000_000_000_000;
export const MAX_DP_SENSITIVITY = 1_000_000_000_000;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function _dpError(message, code, details = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, details);
  return e;
}

function _byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

function _isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map((v) => _canonicalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = _canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

function _sha256Hex(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(_canonicalize(value)))
    .digest('hex');
}

function _validateSensitivity(sensitivity) {
  const n = Number(sensitivity);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DP_SENSITIVITY) {
    throw _dpError(
      'sensitivity_invalid: must be a positive finite number <= ' + MAX_DP_SENSITIVITY,
      'DP_SENSITIVITY_INVALID',
      { max: MAX_DP_SENSITIVITY },
    );
  }
  return n;
}

function _normalizeCountKey(rawKey) {
  const key = String(rawKey);
  if (!key) {
    throw _dpError('count_key_invalid: empty key', 'DP_COUNT_KEY_INVALID');
  }
  if (CONTROL_RE.test(key)) {
    throw _dpError('count_key_invalid: control character', 'DP_COUNT_KEY_INVALID');
  }
  if (UNSAFE_KEYS.has(key)) {
    throw _dpError('count_key_invalid: unsafe prototype key', 'DP_COUNT_KEY_INVALID');
  }
  if (_byteLen(key) > MAX_DP_KEY_BYTES) {
    throw _dpError(
      'count_key_invalid: key exceeds ' + MAX_DP_KEY_BYTES + ' bytes',
      'DP_COUNT_KEY_INVALID',
      { max_bytes: MAX_DP_KEY_BYTES },
    );
  }
  return key;
}

function _normalizeCountValue(rawValue, key) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DP_COUNT) {
    throw _dpError(
      'count_invalid: count for ' + key + ' must be finite, non-negative, and <= ' + MAX_DP_COUNT,
      'DP_COUNT_INVALID',
      { key, max: MAX_DP_COUNT },
    );
  }
  return n;
}

function _normalizeCounts(counts) {
  if (counts == null) return {};
  if (!_isPlainRecord(counts)) {
    throw _dpError('counts_invalid: counts must be a plain object', 'DP_COUNTS_INVALID');
  }
  const entries = Object.entries(counts);
  if (entries.length > MAX_DP_KEYS) {
    throw _dpError(
      'counts_invalid: too many count keys',
      'DP_COUNTS_TOO_LARGE',
      { max_keys: MAX_DP_KEYS, keys: entries.length },
    );
  }

  const out = {};
  for (const [rawKey, rawValue] of entries) {
    const key = _normalizeCountKey(rawKey);
    out[key] = _normalizeCountValue(rawValue, key);
  }
  return out;
}

function _resolveRng(rngOrOptions) {
  if (typeof rngOrOptions === 'function') return rngOrOptions;
  if (rngOrOptions && typeof rngOrOptions === 'object') {
    if (Object.hasOwn(rngOrOptions, 'rng')) {
      if (typeof rngOrOptions.rng === 'function') return rngOrOptions.rng;
      throw _dpError('rng_invalid: rng option must be a function', 'DP_RNG_INVALID');
    }
    if (Object.hasOwn(rngOrOptions, 'random')) {
      if (typeof rngOrOptions.random === 'function') return rngOrOptions.random;
      throw _dpError('rng_invalid: random option must be a function', 'DP_RNG_INVALID');
    }
  }
  throw _dpError('rng_invalid: expected Math.random-compatible function', 'DP_RNG_INVALID');
}

// dpEpsilonFloor - minimum allowed epsilon. Tighter epsilon (smaller number)
// means stronger privacy and more noise. The 0.1 floor keeps this local
// primitive from advertising unusably small budgets.
export function dpEpsilonFloor() {
  return 0.1;
}

// validateEpsilon(eps) - throws `epsilon_below_floor` if below the floor.
// Returns the validated number on success.
export function validateEpsilon(eps) {
  const n = Number(eps);
  if (!Number.isFinite(n) || n <= 0) {
    throw _dpError('epsilon_invalid: must be a positive finite number', 'EPSILON_INVALID');
  }
  if (n < dpEpsilonFloor()) {
    throw _dpError(
      'epsilon_below_floor: epsilon=' + n + ' < floor=' + dpEpsilonFloor(),
      'EPSILON_BELOW_FLOOR',
      { epsilon: n, floor: dpEpsilonFloor() },
    );
  }
  return n;
}

// laplaceNoise(scale, rng) - pure-JS Laplace(0, scale) sampler.
//
// pdf(x) = 1/(2 scale) exp(-|x|/scale)
// inverse CDF for u in (-0.5, 0.5):
//   x = -scale * sign(u) * ln(1 - 2|u|)
//
// scale = sensitivity / epsilon. For count queries with sensitivity 1 the
// caller passes scale = 1 / epsilon. Tests can pass an injected RNG function;
// production defaults to Math.random.
export function laplaceNoise(scale, rngOrOptions = Math.random) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) {
    throw _dpError('laplaceNoise requires positive finite scale', 'DP_SCALE_INVALID');
  }
  const rng = _resolveRng(rngOrOptions);
  const r = Number(rng());
  if (!Number.isFinite(r) || r < 0 || r >= 1) {
    throw _dpError('rng_invalid: RNG must return a finite number in [0, 1)', 'DP_RNG_INVALID');
  }
  // Math.random returns [0,1). Clamp the lower endpoint away from zero before
  // shifting so a legal r=0 sample cannot make log(0) produce Infinity.
  const clamped = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, r));
  const u = clamped - 0.5;
  if (u === 0) return 0;
  return -s * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// aggregateWithDP({counts, epsilon, sensitivity, rng}) - adds Laplace(scale)
// noise to each value in `counts` (a plain object mapping key to count) and
// returns the noised dict plus the mechanism stamp.
//
// Sensitivity defaults to 1 (the canonical count-query setting). Callers
// over numeric features with a larger range should pass an explicit
// sensitivity bound; the noise scale is sensitivity / epsilon.
//
// Honest envelope: epsilon is validated against the floor BEFORE noise is
// added so a too-small epsilon never produces an "almost noiseless" reply.
export function aggregateWithDP({
  counts = {},
  epsilon = 1.0,
  sensitivity = 1,
  rng = Math.random,
  random,
} = {}) {
  const eps = validateEpsilon(epsilon);
  const sens = _validateSensitivity(sensitivity);
  const scale = sens / eps;
  const normalized = _normalizeCounts(counts);
  const noiseRng = random !== undefined ? random : rng;
  const noised_counts = {};

  for (const [k, raw] of Object.entries(normalized)) {
    const noised = raw + laplaceNoise(scale, noiseRng);
    // Round to nearest integer, clamp at zero. Negative counts are a DP
    // artifact only, so we clip-at-zero and cap at a safe JS integer.
    noised_counts[k] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(noised)));
  }

  const keys = Object.keys(normalized).sort();
  const privacy_budget = {
    epsilon: eps,
    delta: DP_DELTA,
    sensitivity: sens,
    scale,
    mechanism: DP_MECHANISM,
    accountant: 'basic',
    composition: 'single_query_laplace',
  };
  const proof = {
    contract_version: DP_AGGREGATION_CONTRACT_VERSION,
    input_count: keys.length,
    keyset_sha256: _sha256Hex(keys),
    output_sha256: _sha256Hex(noised_counts),
    privacy_budget_sha256: _sha256Hex(privacy_budget),
    raw_count_value_hash: null,
    raw_count_value_hash_reason: 'not_emitted_low_cardinality_counts_are_bruteforceable',
  };
  proof.proof_sha256 = _sha256Hex(proof);

  return {
    noised_counts,
    epsilon: eps,
    sensitivity: sens,
    scale,
    mechanism: DP_MECHANISM,
    delta: DP_DELTA,
    privacy_budget,
    proof,
    contract_version: DP_AGGREGATION_CONTRACT_VERSION,
    version: DP_VERSION,
  };
}
