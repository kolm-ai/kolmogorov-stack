// W691 - direct contract test for src/teacher-response-hmac.js.
//
// This primitive binds captured rows to teacher responses. The test pins the
// crypto boundary, v2 stable-message canonicalization, legacy verification
// compatibility, bounds, and depth verifier wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  _keyFingerprint,
  attachBindingToCapture,
  bindTeacherResponse,
  HMAC_ALGORITHM,
  MIN_KEY_BYTES,
  TEACHER_HMAC_KEY_ENV,
  TEACHER_HMAC_LIMITS,
  TEACHER_HMAC_VERSION,
  verifyCaptureBinding,
  verifyTeacherResponse,
} from '../src/teacher-response-hmac.js';

const HEX_64 = /^[a-f0-9]{64}$/;
const TEST_KEY_HEX = 'a'.repeat(MIN_KEY_BYTES * 2);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableJson(value) {
  const sortRecursive = (v) => {
    if (Array.isArray(v)) return v.map(sortRecursive);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = sortRecursive(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortRecursive(value));
}

function requestHash(seed = 'request') {
  return sha256(seed);
}

function withTeacherKey(value, fn) {
  const previous = process.env[TEACHER_HMAC_KEY_ENV];
  if (value == null) delete process.env[TEACHER_HMAC_KEY_ENV];
  else process.env[TEACHER_HMAC_KEY_ENV] = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env[TEACHER_HMAC_KEY_ENV];
    else process.env[TEACHER_HMAC_KEY_ENV] = previous;
  }
}

function legacyMessage({ teacher_id, request_hash, response_body, timestamp_ms }) {
  return [
    String(teacher_id),
    String(request_hash),
    sha256(String(response_body == null ? '' : response_body)),
    String(timestamp_ms),
  ].join(':');
}

test('W691 teacher HMAC source is wired into depth and pins v2 controls', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../src/teacher-response-hmac.js', import.meta.url), 'utf8');

  assert.equal(TEACHER_HMAC_VERSION, 'w761-v2');
  assert.equal(HMAC_ALGORITHM, 'sha256');
  assert.equal(
    pkg.scripts['verify:teacher-hmac'],
    'node --test --test-concurrency=1 tests/wave691-teacher-response-hmac-contract.test.js',
  );
  assert.ok(pkg.scripts['verify:depth'].includes('npm run verify:teacher-hmac'));
  assert.match(source, /function _v2HashChainMessage/);
  assert.match(source, /function _legacyHashChainMessage/);
  assert.match(source, /crypto\.timingSafeEqual/);
  assert.match(source, /request_hash_must_be_sha256_hex/);
  assert.match(source, /response_body_too_large/);
  assert.match(source, /binding_sha256/);
});

test('W691 bind/verify uses stable v2 payloads and preserves receipt digests', () => withTeacherKey(TEST_KEY_HEX, () => {
  const response = { z: 2, a: 1 };
  const sameResponseDifferentOrder = { a: 1, z: 2 };
  const binding = bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: response,
    response_headers: { 'X-B': '2', 'X-A': '1' },
    timestamp_ms: 1700000000000,
  });

  assert.equal(binding.ok, true, JSON.stringify(binding));
  assert.equal(binding.version, TEACHER_HMAC_VERSION);
  assert.equal(binding.canonicalization, 'kolm.teacher_response_hmac.v2');
  assert.match(binding.response_hmac, HEX_64);
  assert.match(binding.response_sha256, HEX_64);
  assert.match(binding.message_sha256, HEX_64);
  assert.match(binding.binding_sha256, HEX_64);
  assert.equal(binding.response_sha256, sha256(stableJson(response)));
  assert.equal(binding.header_count, 2);
  assert.match(binding.headers_hash, HEX_64);

  const verified = verifyTeacherResponse({ binding, response_body: sameResponseDifferentOrder });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.valid, true);
  assert.equal(verified.reason, 'valid_signature');
  assert.equal(verified.response_sha256, binding.response_sha256);
  assert.equal(verified.message_sha256, binding.message_sha256);
  assert.equal(verified.binding_sha256, binding.binding_sha256);

  const capture = { response: sameResponseDifferentOrder };
  attachBindingToCapture(capture, binding);
  assert.equal(capture.teacher_binding.response_sha256, binding.response_sha256);
  assert.equal(capture.teacher_binding.message_sha256, binding.message_sha256);
  assert.equal(capture.teacher_binding.binding_sha256, binding.binding_sha256);
  const captureVerify = verifyCaptureBinding(capture);
  assert.equal(captureVerify.valid, true, JSON.stringify(captureVerify));

  attachBindingToCapture(capture, binding);
  assert.equal(capture._teacher_binding_skipped, 'already_bound');
}));

test('W691 bindTeacherResponse rejects ambiguous or oversized inputs before signing', () => {
  const noKey = withTeacherKey(null, () => bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: 'ok',
  }));
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error, 'hmac_key_not_configured');

  const shortKey = withTeacherKey('short', () => bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: 'ok',
  }));
  assert.equal(shortKey.ok, false);
  assert.equal(shortKey.error, 'hmac_key_too_short');

  const badRequestHash = withTeacherKey(TEST_KEY_HEX, () => bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: 'abc:def',
    response_body: 'ok',
  }));
  assert.equal(badRequestHash.ok, false);
  assert.equal(badRequestHash.error, 'request_hash_must_be_sha256_hex');

  const tooLarge = withTeacherKey(TEST_KEY_HEX, () => bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: 'x'.repeat(TEACHER_HMAC_LIMITS.MAX_RESPONSE_BODY_CHARS + 1),
  }));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error, 'response_body_too_large');

  const manyHeaders = Object.fromEntries(
    Array.from({ length: TEACHER_HMAC_LIMITS.MAX_HEADER_KEYS + 1 }, (_, i) => [`x-${i}`, String(i)]),
  );
  const tooManyHeaders = withTeacherKey(TEST_KEY_HEX, () => bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: 'ok',
    response_headers: manyHeaders,
  }));
  assert.equal(tooManyHeaders.ok, false);
  assert.equal(tooManyHeaders.error, 'response_headers_too_many');

  const duplicateHeaders = withTeacherKey(TEST_KEY_HEX, () => bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: 'ok',
    response_headers: { 'X-Trace': 'a', 'x-trace': 'b' },
  }));
  assert.equal(duplicateHeaders.ok, false);
  assert.equal(duplicateHeaders.error, 'response_header_key_duplicate');
});

test('W691 verifyTeacherResponse rejects malformed HMACs and detects key rotation', () => withTeacherKey(TEST_KEY_HEX, () => {
  const binding = bindTeacherResponse({
    teacher_id: 'openai:gpt-4.1',
    request_hash: requestHash(),
    response_body: 'ok',
    timestamp_ms: 1700000000000,
  });
  assert.equal(binding.ok, true);

  const malformed = verifyTeacherResponse({
    binding: { ...binding, response_hmac: 'zz'.repeat(32) },
    response_body: 'ok',
  });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.reason, 'signature_mismatch');

  const rotated = withTeacherKey('b'.repeat(MIN_KEY_BYTES * 2), () => verifyTeacherResponse({
    binding,
    response_body: 'ok',
  }));
  assert.equal(rotated.ok, false);
  assert.equal(rotated.valid, false);
  assert.equal(rotated.reason, 'hmac_key_mismatch_post_rotation');

  const mutated = verifyTeacherResponse({ binding, response_body: 'mutated' });
  assert.equal(mutated.ok, true);
  assert.equal(mutated.valid, false);
  assert.equal(mutated.reason, 'signature_mismatch');
}));

test('W691 verifyTeacherResponse can still verify legacy w761-v1 bindings', () => withTeacherKey(TEST_KEY_HEX, () => {
  const key = Buffer.from(TEST_KEY_HEX, 'hex');
  const timestamp_ms = 1700000000000;
  const legacy = {
    version: 'w761-v1',
    teacher_id: 'legacy:teacher',
    request_hash: 'legacy:request:hash',
    timestamp_ms,
    key_fingerprint: _keyFingerprint(key),
  };
  const msg = legacyMessage({
    teacher_id: legacy.teacher_id,
    request_hash: legacy.request_hash,
    response_body: 'legacy body',
    timestamp_ms,
  });
  legacy.response_hmac = crypto.createHmac(HMAC_ALGORITHM, key).update(msg).digest('hex');

  const verified = verifyTeacherResponse({ binding: legacy, response_body: 'legacy body' });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.valid, true);
  assert.equal(verified.reason, 'valid_signature');
  assert.equal(verified.teacher_id, legacy.teacher_id);
}));
