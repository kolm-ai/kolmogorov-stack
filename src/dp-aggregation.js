// W757 - Differential-privacy aggregation primitive.
//
// Pure-JS Laplace mechanism for count queries over the W757 pattern lake.
// Separate module from src/pattern-lake.js so the math can be unit-tested
// without spinning up the event-store, AND so non-lake call sites (cost
// breakdowns, federated approval rollups) can reuse the same DP code path
// without importing the entire lake.
//
// HONESTY CONTRACT:
//   - Epsilon floor of 0.1 - never publish an aggregate with weaker noise.
//     The validateEpsilon() helper throws `epsilon_below_floor` on violation.
//   - Mechanism stamp `'laplace_v1'` accompanies every aggregate so the
//     consumer can branch on the exact algorithm (a future Gaussian / RAPPOR
//     mechanism would carry a different stamp and a different contract).
//   - The noise is pseudo-random JS Math.random - NOT cryptographic. The
//     auditor SHOULD treat this as a research-quality DP guarantee, not a
//     load-bearing privacy claim. The lake's primary privacy guarantee is
//     the hash-only contribution surface in src/pattern-lake.js; DP is the
//     belt over the suspenders.
//
// W411 invariant - this module is data-only (no tenant context); the caller
// is responsible for fencing tenant boundaries before passing counts in.

export const DP_VERSION = 'w757-v1';

// dpEpsilonFloor - minimum allowed epsilon. Tighter epsilon (smaller number)
// = stronger privacy = more noise. The 0.1 floor is chosen so the W757
// vertical fingerprint surface always carries SOMETHING the DP literature
// would call "weak but meaningful" privacy.
export function dpEpsilonFloor() {
  return 0.1;
}

// validateEpsilon(eps) - throws `epsilon_below_floor` if below the floor.
// Returns the validated number on success. Tests pin both branches.
export function validateEpsilon(eps) {
  const n = Number(eps);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error('epsilon_invalid: must be a positive finite number');
    e.code = 'EPSILON_INVALID';
    throw e;
  }
  if (n < dpEpsilonFloor()) {
    const e = new Error('epsilon_below_floor: epsilon=' + n + ' < floor=' + dpEpsilonFloor());
    e.code = 'EPSILON_BELOW_FLOOR';
    e.epsilon = n;
    e.floor = dpEpsilonFloor();
    throw e;
  }
  return n;
}

// laplaceNoise(scale) - pure-JS Laplace(0, scale) sampler.
//
// pdf(x) = 1/(2 scale) exp(-|x|/scale)
// inverse CDF for u in (-0.5, 0.5):
//   x = -scale * sign(u) * ln(1 - 2|u|)
//
// scale = sensitivity / epsilon. For count queries with sensitivity 1 the
// caller passes scale = 1 / epsilon. We expose the noise function with the
// scale parameter (NOT epsilon) so callers can compute the scale once and
// re-use it across many counts without redundant arithmetic.
export function laplaceNoise(scale) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) {
    throw new Error('laplaceNoise requires positive finite scale');
  }
  // Math.random returns [0,1); shift to (-0.5, 0.5). Guard against the
  // exact-zero boundary so log() never sees -Infinity.
  let u = Math.random() - 0.5;
  if (u === 0) u = 1e-12;
  return -s * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// aggregateWithDP({counts, epsilon, sensitivity}) - adds Laplace(scale)
// noise to each value in `counts` (a plain object mapping key→count) and
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
} = {}) {
  const eps = validateEpsilon(epsilon);
  const sens = Number(sensitivity);
  if (!Number.isFinite(sens) || sens <= 0) {
    throw new Error('sensitivity must be a positive finite number');
  }
  const scale = sens / eps;
  const noised_counts = {};
  for (const [k, v] of Object.entries(counts || {})) {
    const raw = Number(v) || 0;
    const noised = raw + laplaceNoise(scale);
    // Round to nearest integer, clamp at zero. Negative counts are a DP
    // artifact only - they leak more than they reveal so we clip-at-zero.
    noised_counts[k] = Math.max(0, Math.round(noised));
  }
  return {
    noised_counts,
    epsilon: eps,
    sensitivity: sens,
    scale,
    mechanism: 'laplace_v1',
    version: DP_VERSION,
  };
}
