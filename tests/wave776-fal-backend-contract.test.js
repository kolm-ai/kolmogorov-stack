// W776 - direct contract test for src/compute/backends/fal.js.
//
// This pins the fal.ai compute backend atom: provider path normalization,
// bounded queue input, bounded polling, injectable transport, sanitized
// provider errors, safe request ids, and direct depth verification.

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAL_BACKEND_CONTRACT_VERSION,
  FAL_BACKEND_LIMITS,
  detect,
  run,
} from '../src/compute/backends/fal.js';

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (old == null) delete process.env[key];
      else process.env[key] = old;
    });
}

function makeFalRequest({ statusSequence = ['COMPLETED'], resultText = '{"ok":true}' } = {}) {
  const calls = [];
  async function request(method, host, pathname, headers, body) {
    calls.push({ method, host, pathname, headers, body });
    assert.equal(host, 'queue.fal.run');
    if (method === 'POST') {
      assert.equal(headers.Authorization, 'Key test-fal-token');
      return { status: 200, text: JSON.stringify({ request_id: 'req_123:ok' }) };
    }
    if (pathname.endsWith('/status')) {
      return { status: 200, text: JSON.stringify({ status: statusSequence.shift() || 'COMPLETED' }) };
    }
    return { status: 200, text: resultText };
  }
  return { calls, request };
}

test('W776 fal backend is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/compute/backends/fal.js');

  assert.equal(FAL_BACKEND_CONTRACT_VERSION, 'w776-fal-backend-v1');
  assert.equal(FAL_BACKEND_LIMITS.max_input_json_bytes, 256 * 1024);
  assert.equal(FAL_BACKEND_LIMITS.max_poll_attempts, 1200);
  assert.equal(Object.isFrozen(FAL_BACKEND_LIMITS), true);
  assert.equal(
    pkg.scripts['verify:fal-backend'],
    'node --test --test-concurrency=1 tests/wave776-fal-backend-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /FAL_BACKEND_CONTRACT_VERSION/);
  assert.match(source, /_normalizeAppId/);
  assert.match(source, /_normalizeInput/);
  assert.match(source, /_providerFailure/);
  assert.match(source, /request = _req/);
  assert.match(source, /secret_values_included: false/);
});

test('W776 detect and missing-token envelopes never include secret values', async () => {
  await withEnv('KOLM_FAL_TOKEN', null, async () => {
    const d = await detect();
    assert.equal(d.available, false);
    assert.equal(d.contract_version, FAL_BACKEND_CONTRACT_VERSION);
    assert.equal(d.secret_values_included, false);

    const out = await run({ request: async () => assert.fail('request must not run without token') });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'KOLM_FAL_TOKEN not set');
    assert.equal(out.secret_values_included, false);
  });
});

test('W776 run submits safe app paths, bounded input, polls once, and returns result metadata', async () => {
  await withEnv('KOLM_FAL_TOKEN', 'test-fal-token', async () => {
    const { calls, request } = makeFalRequest();
    const out = await run({
      image: 'fal-ai/any-llm',
      command: ['hello', 'world'],
      timeoutMs: 5000,
      pollIntervalMs: 0,
      request,
      sleep: async () => {},
      now: () => 1000,
    });

    assert.equal(out.ok, true);
    assert.equal(out.contract_version, FAL_BACKEND_CONTRACT_VERSION);
    assert.equal(out.secret_values_included, false);
    assert.equal(out.request_id, 'req_123:ok');
    assert.equal(out.artifact_url, 'https://queue.fal.run/fal-ai/any-llm/requests/req_123%3Aok');
    assert.equal(out.poll_count, 1);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.pathname}`), [
      'POST /fal-ai/any-llm',
      'GET /fal-ai/any-llm/requests/req_123%3Aok/status',
      'GET /fal-ai/any-llm/requests/req_123%3Aok',
    ]);
    assert.deepEqual(calls[0].body, { prompt: 'hello world' });
  });
});

test('W776 invalid app ids, oversized JSON, and bad request ids fail before unsafe use', async () => {
  await withEnv('KOLM_FAL_TOKEN', 'test-fal-token', async () => {
    let called = false;
    const invalidApp = await run({
      image: '../fal-ai/evil?token=secret',
      request: async () => { called = true; },
    });
    assert.equal(invalidApp.ok, false);
    assert.equal(invalidApp.reason, 'invalid_app_id');
    assert.equal(called, false);
    assert.doesNotMatch(JSON.stringify(invalidApp), /supersecret|evil/);

    const hugeInput = await run({
      env: { FAL_INPUT_JSON: JSON.stringify({ prompt: 'x'.repeat(FAL_BACKEND_LIMITS.max_input_json_bytes) }) },
      request: async () => assert.fail('oversized input must not submit'),
    });
    assert.equal(hugeInput.ok, false);
    assert.match(hugeInput.reason, /size limit/);

    const badRequestId = await run({
      image: 'fal-ai/any-llm',
      request: async () => ({ status: 200, text: JSON.stringify({ request_id: '../bad' }) }),
    });
    assert.equal(badRequestId.ok, false);
    assert.equal(badRequestId.reason, 'fal submit returned no valid request_id');
    assert.match(badRequestId.error_sha256, /^[a-f0-9]{64}$/);
  });
});

test('W776 provider errors are capped, redacted, and hash-backed', async () => {
  await withEnv('KOLM_FAL_TOKEN', 'test-fal-token', async () => {
    const out = await run({
      image: 'fal-ai/any-llm',
      request: async () => ({
        status: 503,
        text: 'token=supersecret customer@example.com provider down',
      }),
    });
    const json = JSON.stringify(out);

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'fal submit 503');
    assert.equal(out.exit_code, 1);
    assert.match(out.error_sha256, /^[a-f0-9]{64}$/);
    assert.match(out.stderr, /token=\[redacted\]/);
    assert.doesNotMatch(json, /supersecret|customer@example\.com/);

    const failed = await run({
      image: 'fal-ai/any-llm',
      pollIntervalMs: 0,
      sleep: async () => {},
      now: () => 1000,
      request: makeFalRequest({ statusSequence: ['FAILED'] }).request,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'fal FAILED');
    assert.equal(failed.request_id, 'req_123:ok');
  });
});
