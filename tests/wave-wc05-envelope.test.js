// WC05 — reconcile envelope.js (W707 standardizer) with the ~478 flat-error call sites.
// errorEnvelope() must dual-emit FLAT (`error` string + `detail`) AND RICH (`error_detail`)
// so legacy clients keep working while new clients can read the nested W707 fields.
// kolm-error.js exports a typed error primitive for retiring untyped throws.

import test from 'node:test';
import assert from 'node:assert/strict';

import { errorEnvelope } from '../src/envelope.js';
import { KolmError, kolmError } from '../src/kolm-error.js';

test('WC05 errorEnvelope returns flat error string + detail + nested error_detail', () => {
  const env = errorEnvelope({ code: 'foo', message: 'bar' });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'foo');
  assert.equal(env.detail, 'bar');
  assert.ok(env.error_detail && typeof env.error_detail === 'object',
    'error_detail must be a nested object');
  assert.equal(env.error_detail.code, 'foo');
  assert.equal(env.error_detail.message, 'bar');
});

test('WC05 errorEnvelope sets ok:false explicitly (not falsy via missing key)', () => {
  const env = errorEnvelope({ code: 'whatever' });
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'ok'), true);
  assert.strictEqual(env.ok, false);
});

test('WC05 errorEnvelope with install_hint emits BOTH install_hint and hint alias', () => {
  const env = errorEnvelope({
    code: 'no_kernel',
    message: 'kernel missing',
    install_hint: 'set KOLM_SPEC_DECODE_BACKEND=llama-cpp',
  });
  assert.equal(env.install_hint, 'set KOLM_SPEC_DECODE_BACKEND=llama-cpp');
  assert.equal(env.hint, 'set KOLM_SPEC_DECODE_BACKEND=llama-cpp',
    'hint alias must be emitted alongside install_hint for legacy call sites like src/accelerate.js:204,405');
});

test('WC05 errorEnvelope without any hint omits both keys (no nulls in shape)', () => {
  const env = errorEnvelope({ code: 'foo', message: 'bar' });
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'install_hint'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'hint'), false);
});

test('WC05 KolmError instance carries code, name, message, and optional fields', () => {
  const err = new KolmError('no_kernel', 'kernel missing', {
    detail: 'install llama-cpp',
    status: 503,
    retryable: true,
    install_hint: 'pip install kolm-runtime',
  });
  assert.equal(err.code, 'no_kernel');
  assert.equal(err.name, 'KolmError');
  assert.equal(err.message, 'kernel missing');
  assert.equal(err.detail, 'install llama-cpp');
  assert.equal(err.status, 503);
  assert.equal(err.retryable, true);
  assert.equal(err.install_hint, 'pip install kolm-runtime');
});

test('WC05 kolmError() factory returns a KolmError instance', () => {
  const err = kolmError('rate_limited', 'too many requests', { status: 429, retryable: true });
  assert.ok(err instanceof KolmError);
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.status, 429);
});

test('WC05 KolmError is a real Error so existing catch(Error) handlers keep working', () => {
  const err = kolmError('foo');
  assert.ok(err instanceof Error, 'must subclass Error so global catch(e) handlers see it');
  assert.equal(typeof err.stack, 'string', 'must carry a stack trace from Error');
  // Defaulted message when none given.
  assert.equal(err.message, 'foo');
});

test('WC05 errorEnvelope top-level key set is stable (snapshot)', () => {
  const env = errorEnvelope({ code: 'foo', message: 'bar' });
  const keys = Object.keys(env).sort();
  // Snapshot of WC05 contract — adding/removing a top-level key is a
  // BC-breaking change that must come with a new wave plan.
  assert.deepEqual(keys, [
    'detail',
    'error',
    'error_detail',
    'evidence',
    'journey',
    'next_actions',
    'ok',
    'readiness',
    'surface',
    'tenant',
  ]);
});

test('WC05 errorEnvelope error_detail propagates severity and retryable from known failure codes', () => {
  // compute_missing is a known FAILURE_CODES entry — severity blocker, retryable true.
  const env = errorEnvelope({ code: 'compute_missing' });
  assert.equal(env.error, 'compute_missing');
  assert.equal(env.error_detail.severity, 'blocker');
  assert.equal(env.error_detail.retryable, true);
});

test('WC05 errorEnvelope error_detail shape matches W707 standardizer contract', () => {
  const env = errorEnvelope({
    code: 'foo',
    message: 'bar',
    status: 500,
    details: { trace_id: 't_1' },
  });
  // W707 contract — these are the fields new clients can rely on inside error_detail.
  const detailKeys = Object.keys(env.error_detail).sort();
  assert.deepEqual(detailKeys, [
    'code',
    'details',
    'message',
    'retryable',
    'severity',
    'status',
  ]);
  assert.equal(env.error_detail.status, 500);
  assert.deepEqual(env.error_detail.details, { trace_id: 't_1' });
});
