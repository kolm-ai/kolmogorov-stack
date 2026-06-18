// W698 - direct contract for src/dp-aggregation.js.
//
// Focus: epsilon floor, endpoint-safe Laplace sampling, strict finite count
// bounds, deterministic RNG injection, and privacy-safe proof metadata.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DP_AGGREGATION_CONTRACT_VERSION,
  DP_DELTA,
  DP_MECHANISM,
  DP_VERSION,
  MAX_DP_KEYS,
  aggregateWithDP,
  dpEpsilonFloor,
  laplaceNoise,
  validateEpsilon,
} from '../src/dp-aggregation.js';

const HEX64_RE = /^[a-f0-9]{64}$/;

function assertCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code);
    return true;
  });
}

test('W698 validates epsilon floor before publishing a DP aggregate', () => {
  assert.equal(dpEpsilonFloor(), 0.1);
  assert.equal(validateEpsilon('0.5'), 0.5);

  assertCode(() => validateEpsilon(0), 'EPSILON_INVALID');
  assertCode(() => validateEpsilon(Infinity), 'EPSILON_INVALID');
  assertCode(() => validateEpsilon(0.099), 'EPSILON_BELOW_FLOOR');
});

test('W698 Laplace sampler is finite at legal RNG endpoints and rejects bad RNGs', () => {
  const lower = laplaceNoise(2, () => 0);
  const middle = laplaceNoise(2, () => 0.5);
  const upper = laplaceNoise(2, () => 1 - Number.EPSILON);

  assert.equal(Number.isFinite(lower), true);
  assert.equal(Number.isFinite(middle), true);
  assert.equal(Number.isFinite(upper), true);
  assert.equal(middle, 0);
  assert.ok(lower < 0);
  assert.ok(upper > 0);

  assertCode(() => laplaceNoise(0), 'DP_SCALE_INVALID');
  assertCode(() => laplaceNoise(1, 'not-a-function'), 'DP_RNG_INVALID');
  assertCode(() => laplaceNoise(1, () => -0.1), 'DP_RNG_INVALID');
  assertCode(() => laplaceNoise(1, () => 1), 'DP_RNG_INVALID');
  assertCode(() => laplaceNoise(1, () => NaN), 'DP_RNG_INVALID');
});

test('W698 aggregateWithDP keeps legacy fields and emits privacy-safe proof metadata', () => {
  const out = aggregateWithDP({
    counts: { alpha: 3, beta: '4' },
    epsilon: 1,
    sensitivity: 2,
    rng: () => 0.5,
  });

  assert.deepEqual(out.noised_counts, { alpha: 3, beta: 4 });
  assert.equal(out.epsilon, 1);
  assert.equal(out.sensitivity, 2);
  assert.equal(out.scale, 2);
  assert.equal(out.mechanism, DP_MECHANISM);
  assert.equal(out.delta, DP_DELTA);
  assert.equal(out.version, DP_VERSION);
  assert.equal(out.contract_version, DP_AGGREGATION_CONTRACT_VERSION);

  assert.deepEqual(out.privacy_budget, {
    epsilon: 1,
    delta: 0,
    sensitivity: 2,
    scale: 2,
    mechanism: 'laplace_v1',
    accountant: 'basic',
    composition: 'single_query_laplace',
  });
  assert.equal(out.proof.input_count, 2);
  assert.match(out.proof.keyset_sha256, HEX64_RE);
  assert.match(out.proof.output_sha256, HEX64_RE);
  assert.match(out.proof.privacy_budget_sha256, HEX64_RE);
  assert.match(out.proof.proof_sha256, HEX64_RE);
  assert.equal(out.proof.raw_count_value_hash, null);
  assert.equal(Object.hasOwn(out.proof, 'input_sha256'), false);
});

test('W698 aggregateWithDP rejects non-finite values, unsafe keys, and unbounded maps', () => {
  assertCode(() => aggregateWithDP({ counts: [], rng: () => 0.5 }), 'DP_COUNTS_INVALID');
  assertCode(() => aggregateWithDP({ counts: { alpha: Infinity }, rng: () => 0.5 }), 'DP_COUNT_INVALID');
  assertCode(() => aggregateWithDP({ counts: { alpha: -1 }, rng: () => 0.5 }), 'DP_COUNT_INVALID');
  assertCode(() => aggregateWithDP({ counts: { 'bad\nkey': 1 }, rng: () => 0.5 }), 'DP_COUNT_KEY_INVALID');
  assertCode(() => aggregateWithDP({ counts: JSON.parse('{"__proto__":1}'), rng: () => 0.5 }), 'DP_COUNT_KEY_INVALID');
  assertCode(() => aggregateWithDP({ counts: { alpha: 1 }, sensitivity: 0, rng: () => 0.5 }), 'DP_SENSITIVITY_INVALID');
  assertCode(() => aggregateWithDP({ counts: { alpha: 1 }, rng: 'not-a-function' }), 'DP_RNG_INVALID');
  assertCode(() => aggregateWithDP({ counts: { alpha: 1 }, random: 'not-a-function' }), 'DP_RNG_INVALID');

  const tooMany = {};
  for (let i = 0; i <= MAX_DP_KEYS; i += 1) tooMany['k' + i] = i;
  assertCode(() => aggregateWithDP({ counts: tooMany, rng: () => 0.5 }), 'DP_COUNTS_TOO_LARGE');
});

test('W698 null count input remains a backwards-compatible empty aggregate', () => {
  const out = aggregateWithDP({ counts: null, rng: () => 0.5 });
  assert.deepEqual(out.noised_counts, {});
  assert.equal(out.proof.input_count, 0);
});
