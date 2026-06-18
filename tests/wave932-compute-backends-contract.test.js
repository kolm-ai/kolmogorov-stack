// W932 - compute backend registry and OpenAI-compatible serving contracts.
//
// Covers:
//   src/compute/index.js
//   src/compute/backends/local-openvino.js
//   src/compute/backends/local-qnn.js
//   src/compute/backends/tgi.js
//   src/compute/backends/trt-llm.js
//   src/compute/backends/vllm.js
//   src/compute/backends/openai-compatible.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY_REL = 'src/compute/registry.json';
const COMPUTE_INDEX_REL = 'src/compute/index.js';
const OPENAI_COMPAT_REL = 'src/compute/backends/openai-compatible.js';

const BACKEND_RELS = {
  'local-openvino': 'src/compute/backends/local-openvino.js',
  'local-qnn': 'src/compute/backends/local-qnn.js',
  tgi: 'src/compute/backends/tgi.js',
  'trt-llm': 'src/compute/backends/trt-llm.js',
  vllm: 'src/compute/backends/vllm.js',
};

function abs(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function importFresh(rel, tag) {
  const cacheBust = `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return import(`${pathToFileURL(abs(rel)).href}?w932=${cacheBust}`);
}

async function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetch(stub, fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('W932 compute registry and uncovered wrappers stay explicit and immutable to callers', async () => {
  const registry = JSON.parse(read(REGISTRY_REL));
  const rows = new Map(registry.backends.map((row) => [row.name, row]));

  const expected = {
    'local-openvino': { kind: 'local', train: false, infer: true, auth: 'KOLM_OPENVINO_URL', env: 'KOLM_OPENVINO_URL' },
    'local-qnn': { kind: 'local', train: false, infer: true, auth: 'KOLM_QNN_URL', env: 'KOLM_QNN_URL' },
    tgi: { kind: 'serving-engine', train: false, infer: true, auth: 'KOLM_TGI_URL', env: 'KOLM_TGI_URL' },
    'trt-llm': { kind: 'serving-engine', train: false, infer: true, auth: 'KOLM_TRT_LLM_URL', env: 'KOLM_TRT_LLM_URL' },
    vllm: { kind: 'serving-engine', train: false, infer: true, auth: 'KOLM_VLLM_URL', env: 'KOLM_VLLM_URL' },
  };

  for (const [name, contract] of Object.entries(expected)) {
    assert.deepEqual(
      {
        kind: rows.get(name)?.kind,
        train: rows.get(name)?.train,
        infer: rows.get(name)?.infer,
        auth: rows.get(name)?.auth,
      },
      {
        kind: contract.kind,
        train: contract.train,
        infer: contract.infer,
        auth: contract.auth,
      },
      `${name} registry row must advertise the right local/serving capability`,
    );

    const src = read(BACKEND_RELS[name]);
    assert.match(src, /createOpenAICompatibleAdapter/, `${name} must use the shared hardened OpenAI-compatible adapter`);
    assert.match(src, new RegExp(contract.env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} wrapper must expose the documented URL env var`);

    const mod = await importFresh(BACKEND_RELS[name], name);
    const adapter = mod.default || mod;
    assert.equal(typeof adapter.detect, 'function', `${name}.detect must exist`);
    assert.equal(typeof adapter.test, 'function', `${name}.test must exist`);
    assert.equal(typeof adapter.run, 'function', `${name}.run must exist`);
  }

  const compute = await importFresh(COMPUTE_INDEX_REL, 'index');
  const listed = compute.list();
  const originalVllmSummary = compute.info('vllm').summary;
  listed.find((row) => row.name === 'vllm').summary = 'mutated-by-test';
  assert.equal(compute.info('vllm').summary, originalVllmSummary, 'list() must not expose mutable registry rows');

  const invalid = await compute.test('../vllm');
  assert.deepEqual(invalid, { ok: false, reason: 'no adapter' }, 'malformed backend names must not become dynamic import paths');
});

test('W932 local OpenVINO and QNN shims explain SDK-without-endpoint state', async () => {
  await withEnv({
    KOLM_OPENVINO_URL: null,
    OVMS_URL: null,
    KOLM_OPENVINO_API_KEY: null,
    OVMS_API_KEY: null,
    OPENVINO_HOME: 'C:\\OpenVINO',
    INTEL_OPENVINO_DIR: null,
  }, async () => {
    const mod = await importFresh(BACKEND_RELS['local-openvino'], 'openvino-sdk');
    const out = await mod.detect();
    assert.equal(out.available, false);
    assert.equal(out.device, 'intel-openvino');
    assert.match(out.reason, /OpenVINO runtime detected/);
    assert.match(out.reason, /KOLM_OPENVINO_URL/);
  });

  await withEnv({
    KOLM_QNN_URL: null,
    KOLM_HEXAGON_URL: null,
    KOLM_QNN_API_KEY: null,
    KOLM_HEXAGON_API_KEY: null,
    QNN_SDK_ROOT: 'C:\\Qualcomm\\QNN',
    HEXAGON_SDK_ROOT: null,
  }, async () => {
    const mod = await importFresh(BACKEND_RELS['local-qnn'], 'qnn-sdk');
    const out = await mod.detect();
    assert.equal(out.available, false);
    assert.equal(out.device, 'qualcomm-qnn-hexagon');
    assert.match(out.reason, /Qualcomm QNN\/Hexagon SDK detected/);
    assert.match(out.reason, /KOLM_QNN_URL/);
  });
});

test('W932 OpenAI-compatible adapter rejects unsafe base URLs without leaking URL secrets', async () => {
  const { createOpenAICompatibleAdapter, normalizeBaseUrl } = await importFresh(OPENAI_COMPAT_REL, 'url-hardening');

  assert.equal(normalizeBaseUrl('file:///etc/passwd'), '');
  assert.equal(normalizeBaseUrl('https://user:pass@example.test/v1'), '');
  assert.equal(normalizeBaseUrl(' https://example.test/v1/?token=secret#fragment '), 'https://example.test/v1');

  await withEnv({
    KOLM_W932_URL: 'file:///C:/secret-path/model?token=rawsecret',
    KOLM_W932_KEY: null,
  }, async () => {
    const adapter = createOpenAICompatibleAdapter({
      name: 'w932',
      urlEnv: 'KOLM_W932_URL',
      keyEnv: 'KOLM_W932_KEY',
      device: 'test-device',
    });
    const out = await adapter.detect();
    assert.equal(out.available, false);
    assert.equal(out.reason, 'invalid_base_url');
    assert.equal(out.detail, 'unsupported_scheme');
    assert.match(out.url_sha256, /^[a-f0-9]{64}$/);
    const payload = JSON.stringify(out);
    assert.doesNotMatch(payload, /rawsecret|secret-path|file:\/\//);
  });
});

test('W932 OpenAI-compatible adapter posts once to normalized chat completions endpoint', async () => {
  const { createOpenAICompatibleAdapter } = await importFresh(OPENAI_COMPAT_REL, 'run-path');
  const seen = [];

  await withEnv({
    KOLM_W932_URL: 'https://inference.local/v1/',
    KOLM_W932_KEY: 'test-key',
  }, async () => withFetch(async (url, init = {}) => {
    seen.push({ url: String(url), init });
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), {
      model: 'tiny',
      messages: [{ role: 'user', content: 'ping' }],
    });
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
  }, async () => {
    const adapter = createOpenAICompatibleAdapter({
      name: 'w932',
      urlEnv: 'KOLM_W932_URL',
      keyEnv: 'KOLM_W932_KEY',
      device: 'test-device',
    });
    const out = await adapter.run({ model: 'tiny', prompt: 'ping' });
    assert.equal(out.ok, true);
    assert.equal(out.exit_code, 0);
    assert.equal(out.endpoint, 'https://inference.local/v1');
    assert.equal(out.choices[0].message.content, 'pong');
  }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://inference.local/v1/chat/completions');
});

test('W932 OpenAI-compatible adapter blocks oversized, invalid, and nonserializable requests before fetch', async () => {
  const { createOpenAICompatibleAdapter, OPENAI_COMPATIBLE_LIMITS } = await importFresh(OPENAI_COMPAT_REL, 'request-guards');
  let fetchCalls = 0;

  await withEnv({
    KOLM_W932_URL: 'https://inference.local/v1',
    KOLM_W932_KEY: 'test-key',
  }, async () => withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ choices: [] });
  }, async () => {
    const adapter = createOpenAICompatibleAdapter({
      name: 'w932',
      urlEnv: 'KOLM_W932_URL',
      keyEnv: 'KOLM_W932_KEY',
      device: 'test-device',
    });
    const out = await adapter.run({
      body: { model: 'tiny', messages: [{ role: 'user', content: 'x'.repeat(OPENAI_COMPATIBLE_LIMITS.max_request_body_bytes + 1) }] },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'request_body_too_large');
    assert.equal(out.max_request_body_bytes, OPENAI_COMPATIBLE_LIMITS.max_request_body_bytes);

    const cyclic = {};
    cyclic.self = cyclic;
    const nonserializable = await adapter.run({ body: cyclic });
    assert.equal(nonserializable.ok, false);
    assert.equal(nonserializable.reason, 'request_body_not_json_serializable');
  }));

  await withEnv({
    KOLM_W932_URL: 'https://inference.local/v1',
    KOLM_W932_KEY: 'secret\nvalue',
  }, async () => withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ choices: [] });
  }, async () => {
    const adapter = createOpenAICompatibleAdapter({
      name: 'w932',
      urlEnv: 'KOLM_W932_URL',
      keyEnv: 'KOLM_W932_KEY',
      device: 'test-device',
    });
    const out = await adapter.run({ model: 'tiny', prompt: 'ping' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'invalid_api_key_env');
    assert.match(out.key_sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(out), /secret|value/);
  }));

  assert.equal(fetchCalls, 0, 'guarded request failures must not call fetch');
});

test('W932 compute backend verifier is wired into depth before SOTA readiness', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['verify:compute-backends'],
    'node --test --test-concurrency=1 tests/wave932-compute-backends-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:worker-safety-contracts && npm run verify:compute-backends && node scripts\/audit-sota-readiness\.cjs/,
  );
});
