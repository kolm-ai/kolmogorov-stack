// Tests for R-1 runtime passport schema (src/runtime-passport.js).
//
// Three load-bearing properties of the schema:
//   (a) validatePassport rejects malformed rows (unknown fields, bad status,
//       bad runtime, missing required numerics on 'tested' rows).
//   (b) estimatePassport returns a well-shaped 'estimated' row from a spec —
//       memory_mb resolves from params_b + precision, latency/throughput
//       stay null because the compile-time estimator cannot probe them.
//   (c) recordTestedPassport REQUIRES every measurement to be a real number;
//       any missing field or non-numeric value throws. No inference.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_PASSPORT_SCHEMA_VERSION,
  RUNTIME_PASSPORT_FIELDS,
  VALID_STATUS,
  VALID_RUNTIMES,
  validatePassport,
  validatePassports,
  estimatePassport,
  recordTestedPassport,
} from '../src/runtime-passport.js';

test('schema constants are stable identifiers, not booleans', () => {
  assert.equal(RUNTIME_PASSPORT_SCHEMA_VERSION, 'kolm-runtime-passport-1');
  assert.ok(Array.isArray(RUNTIME_PASSPORT_FIELDS));
  assert.ok(RUNTIME_PASSPORT_FIELDS.includes('target_id'));
  assert.ok(RUNTIME_PASSPORT_FIELDS.includes('fallback'));
  assert.deepEqual(VALID_STATUS, ['tested', 'estimated', 'unsupported']);
  assert.ok(VALID_RUNTIMES.includes('llama.cpp'));
  assert.ok(VALID_RUNTIMES.includes('vllm'));
  assert.ok(VALID_RUNTIMES.includes('mlx'));
});

// ---------------------------------------------------------------------------
// (a) validatePassport rejects bad fields
// ---------------------------------------------------------------------------

test('validatePassport rejects unknown field (caught at write time)', () => {
  const bad = {
    target_id: 'gguf-q4_k_m-llama.cpp',
    status: 'estimated',
    runtime: 'llama.cpp',
    runtime_version: 'b3415',
    precision: 'q4_k_m',
    memory_mb: 4096,
    latency_p50_ms: null,
    latency_p95_ms: null,
    tok_s: null,
    quality_delta: null,
    fallback: null,
    // Unknown field — must be rejected so a typo is loud not silent.
    latencyP50ms: 12,
  };
  const v = validatePassport(bad);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unknown field: latencyP50ms/);
});

test('validatePassport rejects bad status', () => {
  const bad = {
    target_id: 'x', status: 'partially-working', runtime: 'llama.cpp',
    runtime_version: 'b1', precision: 'q4_k_m',
    memory_mb: 100, latency_p50_ms: 10, latency_p95_ms: 20, tok_s: 30,
    quality_delta: 0, fallback: null,
  };
  const v = validatePassport(bad);
  assert.equal(v.ok, false);
  assert.match(v.reason, /status must be one of/);
});

test('validatePassport rejects bad runtime', () => {
  const bad = {
    target_id: 'x', status: 'tested', runtime: 'pytorch-eager',
    runtime_version: '2.5', precision: 'fp16',
    memory_mb: 100, latency_p50_ms: 10, latency_p95_ms: 20, tok_s: 30,
    quality_delta: 0, fallback: null,
  };
  const v = validatePassport(bad);
  assert.equal(v.ok, false);
  assert.match(v.reason, /runtime must be one of/);
});

test('validatePassport rejects tested row with missing measurement', () => {
  const bad = {
    target_id: 'gguf-q4_k_m-llama.cpp',
    status: 'tested',
    runtime: 'llama.cpp',
    runtime_version: 'b3415',
    precision: 'q4_k_m',
    memory_mb: 4096,
    // latency_p50_ms missing — tested rows MUST carry every measurement.
    latency_p50_ms: null,
    latency_p95_ms: 25,
    tok_s: 42,
    quality_delta: 0,
    fallback: null,
  };
  const v = validatePassport(bad);
  assert.equal(v.ok, false);
  assert.match(v.reason, /latency_p50_ms/);
});

test('validatePassport rejects unsupported row that fabricates numbers', () => {
  // 'unsupported' rows MUST have null numerics so a UI never accidentally
  // renders a 0 ms latency for a runtime that does not run the artifact.
  const bad = {
    target_id: 'fp8-vllm', status: 'unsupported', runtime: 'vllm',
    runtime_version: '0.6.4', precision: 'fp8',
    memory_mb: 0, latency_p50_ms: 0, latency_p95_ms: 0, tok_s: 0,
    quality_delta: 0, fallback: 'gguf-q4_k_m-llama.cpp',
  };
  const v = validatePassport(bad);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unsupported passport .* must be null/);
});

test('validatePassport accepts a well-formed tested row', () => {
  const good = {
    target_id: 'gguf-q4_k_m-llama.cpp',
    status: 'tested',
    runtime: 'llama.cpp',
    runtime_version: 'b3415',
    precision: 'q4_k_m',
    memory_mb: 4500,
    latency_p50_ms: 18.4,
    latency_p95_ms: 32.1,
    tok_s: 54.2,
    quality_delta: -0.012,
    fallback: null,
  };
  const v = validatePassport(good);
  assert.equal(v.ok, true);
});

test('validatePassports indexes the failing entry', () => {
  const arr = [
    { target_id: 'a', status: 'estimated', runtime: 'llama.cpp',
      runtime_version: 'b1', precision: 'q4_k_m', memory_mb: 100,
      latency_p50_ms: null, latency_p95_ms: null, tok_s: null,
      quality_delta: null, fallback: null },
    { target_id: 'b', status: 'tested', runtime: 'llama.cpp',
      runtime_version: 'b1', precision: 'q4_k_m', memory_mb: 100,
      latency_p50_ms: null, latency_p95_ms: null, tok_s: null,
      quality_delta: null, fallback: null },  // missing measurements on tested
  ];
  const v = validatePassports(arr);
  assert.equal(v.ok, false);
  assert.equal(v.index, 1);
});

// ---------------------------------------------------------------------------
// (b) estimatePassport returns proper shape from a spec
// ---------------------------------------------------------------------------

test('estimatePassport returns full estimated shape from a spec', () => {
  const p = estimatePassport({
    target_id: 'gguf-q4_k_m-llama.cpp',
    runtime: 'llama.cpp',
    runtime_version: 'b3415',
    precision: 'q4_k_m',
    params_b: 7,                    // 7B model
    fallback: null,
  });
  // Shape check: every canonical field is present, in the canonical set.
  for (const f of RUNTIME_PASSPORT_FIELDS) {
    assert.ok(f in p, `field missing: ${f}`);
  }
  assert.equal(p.status, 'estimated');
  assert.equal(p.runtime, 'llama.cpp');
  assert.equal(p.precision, 'q4_k_m');
  // Memory should be roughly 7B * 0.5625 bytes/param + 256 MB baseline ~ 4017 MB.
  // Allow ±10% to avoid wedging the test to a specific constant.
  assert.ok(p.memory_mb > 3500 && p.memory_mb < 4500,
    `expected memory_mb in [3500, 4500], got ${p.memory_mb}`);
  // Latency / throughput intentionally null — compile-time estimator cannot
  // probe them. The UI surfaces the amber pill so a buyer reads them as
  // "estimate" not "measurement".
  assert.equal(p.latency_p50_ms, null);
  assert.equal(p.latency_p95_ms, null);
  assert.equal(p.tok_s, null);
  assert.equal(p.quality_delta, null);
  assert.equal(p.fallback, null);
  // Round-trip the row through the validator — an estimator that emits
  // anything its own validator rejects is broken by construction.
  assert.equal(validatePassport(p).ok, true);
});

test('estimatePassport promotes to unsupported when memory cannot be derived', () => {
  // No params_b → memory_mb cannot be computed → the estimator collapses to
  // 'unsupported' (with null numerics) rather than fabricating a number.
  const p = estimatePassport({
    target_id: 'mlx-fp16',
    runtime: 'mlx',
    runtime_version: '0.20.0',
    precision: 'fp16',
    fallback: 'gguf-q4_k_m-llama.cpp',
  });
  assert.equal(p.status, 'unsupported');
  assert.equal(p.memory_mb, null);
  assert.equal(p.latency_p50_ms, null);
  assert.equal(p.fallback, 'gguf-q4_k_m-llama.cpp');
  assert.equal(validatePassport(p).ok, true);
});

test('estimatePassport throws on invalid spec', () => {
  assert.throws(() => estimatePassport({}), /target_id required/);
  assert.throws(() => estimatePassport({
    target_id: 'x', runtime: 'fake-runtime', runtime_version: '1', precision: 'fp16',
  }), /runtime must be one of/);
});

// ---------------------------------------------------------------------------
// (c) recordTestedPassport requires actual measurements
// ---------------------------------------------------------------------------

test('recordTestedPassport requires actual measurements', () => {
  // Missing every required measurement — must throw, not silently default.
  assert.throws(
    () => recordTestedPassport({
      target_id: 'gguf-q4_k_m-llama.cpp',
      runtime: 'llama.cpp',
      runtime_version: 'b3415',
      precision: 'q4_k_m',
      // memory_mb / latency_p50_ms / latency_p95_ms / tok_s / quality_delta missing
    }),
    /required/,
  );
  // Numeric field is null — also rejected, the contract says "real number".
  assert.throws(
    () => recordTestedPassport({
      target_id: 'gguf-q4_k_m-llama.cpp',
      runtime: 'llama.cpp',
      runtime_version: 'b3415',
      precision: 'q4_k_m',
      memory_mb: 4096,
      latency_p50_ms: null,    // null is not a measurement
      latency_p95_ms: 25,
      tok_s: 42,
      quality_delta: 0,
    }),
    /latency_p50_ms must be a measured finite number/,
  );
  // A complete measurement DOES pass — and its returned row is status='tested'.
  const good = recordTestedPassport({
    target_id: 'gguf-q4_k_m-llama.cpp',
    runtime: 'llama.cpp',
    runtime_version: 'b3415',
    precision: 'q4_k_m',
    memory_mb: 4500,
    latency_p50_ms: 18.4,
    latency_p95_ms: 32.1,
    tok_s: 54.2,
    quality_delta: -0.012,
    fallback: null,
  });
  assert.equal(good.status, 'tested');
  assert.equal(good.tok_s, 54.2);
  assert.equal(validatePassport(good).ok, true);
});
