// Wave 551: compute/training contract lock-ins.
//
// This catches the production-readiness gaps that matter for the rented
// training + inference surface:
//   * every registry backend has a callable adapter module
//   * self-hosted OpenAI-compatible inference engines are not just catalog rows
//   * Together managed fine-tuning uses the current upload/create/download API
//   * quantize docs describe the real script + method-specific readiness

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REGISTRY = path.join(ROOT, 'src', 'compute', 'registry.json');
const BACKENDS = path.join(ROOT, 'src', 'compute', 'backends');
const TOGETHER_URL = pathToFileURL(path.join(BACKENDS, 'together.js')).href;
const OPENAI_COMPAT_URL = pathToFileURL(path.join(BACKENDS, 'openai-compatible.js')).href;
const ANTHROPIC_URL = pathToFileURL(path.join(BACKENDS, 'anthropic.js')).href;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function binaryResponse(bytes) {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

test('1. every compute registry backend has an adapter with detect/test/run', async () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  assert.ok(registry.backends.length >= 18, 'registry should keep the full local/cloud/serving matrix');

  for (const backend of registry.backends) {
    const adapterPath = path.join(BACKENDS, `${backend.name}.js`);
    assert.ok(fs.existsSync(adapterPath), `${backend.name} must have src/compute/backends/${backend.name}.js`);
    const mod = await import(pathToFileURL(adapterPath).href + `?wave551=${Date.now()}-${backend.name}`);
    const adapter = mod.default || mod;
    assert.equal(typeof adapter.detect, 'function', `${backend.name}.detect must exist`);
    assert.equal(typeof adapter.test, 'function', `${backend.name}.test must exist`);
    assert.equal(typeof adapter.run, 'function', `${backend.name}.run must exist`);

    if (backend.kind === 'serving-engine') {
      assert.equal(backend.train, false, `${backend.name} serving engine must not advertise training`);
      assert.equal(backend.infer, true, `${backend.name} serving engine must advertise inference`);
    }
  }
});

test('2. OpenAI-compatible serving adapter posts chat completions and returns choices', async () => {
  const { createOpenAICompatibleAdapter } = await import(OPENAI_COMPAT_URL + `?wave551=${Date.now()}`);
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.KOLM_W551_OPENAI_URL;
  const oldKey = process.env.KOLM_W551_OPENAI_KEY;
  process.env.KOLM_W551_OPENAI_URL = 'https://inference.local/v1';
  process.env.KOLM_W551_OPENAI_KEY = 'test-key';
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'tiny');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
  };
  try {
    const adapter = createOpenAICompatibleAdapter({
      name: 'test-openai-compatible',
      urlEnv: 'KOLM_W551_OPENAI_URL',
      keyEnv: 'KOLM_W551_OPENAI_KEY',
      device: 'test-device',
    });
    const out = await adapter.run({ model: 'tiny', prompt: 'ping' });
    assert.equal(out.ok, true);
    assert.equal(out.exit_code, 0);
    assert.equal(out.choices[0].message.content, 'pong');
    assert.equal(seen[0].url, 'https://inference.local/v1/chat/completions');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl == null) delete process.env.KOLM_W551_OPENAI_URL; else process.env.KOLM_W551_OPENAI_URL = oldUrl;
    if (oldKey == null) delete process.env.KOLM_W551_OPENAI_KEY; else process.env.KOLM_W551_OPENAI_KEY = oldKey;
  }
});

test('3. Together upload form matches current Files API contract', async () => {
  const { buildTrainingFileForm } = await import(TOGETHER_URL + `?wave551=form-${Date.now()}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wave551-'));
  const file = path.join(dir, 'train.jsonl');
  fs.writeFileSync(file, '{"messages":[]}\n');
  const form = buildTrainingFileForm(file);
  assert.equal(form.get('purpose'), 'fine-tune');
  assert.equal(form.get('file_name'), 'train.jsonl');
  assert.equal(form.get('file_type'), 'jsonl');
  assert.ok(form.get('file'), 'multipart form must include file content');
});

test('4. Together managed LoRA path uploads, creates, polls, and downloads without network', async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.KOLM_TOGETHER_TOKEN;
  process.env.KOLM_TOGETHER_TOKEN = 'test-token';
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    seen.push({ pathname, init });
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    if (pathname === '/v1/files/upload') {
      assert.equal(init.method, 'POST');
      assert.equal(init.body.get('purpose'), 'fine-tune');
      assert.equal(init.body.get('file_name'), 'corpus.jsonl');
      assert.equal(init.body.get('file_type'), 'jsonl');
      return jsonResponse({ id: 'file-test' });
    }
    if (pathname === '/v1/fine-tunes' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.training_file, 'file-test');
      assert.equal(body.model, 'Qwen/Qwen2.5-7B-Instruct');
      assert.equal(body.validation_file, 'file-val');
      assert.equal(body.n_evals, 1);
      return jsonResponse({ id: 'ft-test', status: 'running' });
    }
    if (pathname === '/v1/fine-tunes/ft-test') {
      return jsonResponse({
        id: 'ft-test',
        status: 'completed',
        output_name: 'tenant/qwen-kolm',
        total_price: 1500,
        token_count: 850000,
      });
    }
    if (pathname === '/v1/fine-tunes/ft-test/download') {
      return binaryResponse([1, 2, 3, 4]);
    }
    throw new Error(`unexpected fetch ${pathname}`);
  };

  try {
    const { run } = await import(TOGETHER_URL + `?wave551=run-${Date.now()}`);
    const cases = Array.from({ length: 10 }, (_, i) => ({ input: `prompt ${i}`, expected: `completion ${i}` }));
    const result = await run({
      id: 'wave551',
      base_model: 'Qwen/Qwen2.5-7B-Instruct',
      validation_file: 'file-val',
      n_evals: 1,
      poll_interval_ms: 0,
      evals: { cases },
    });
    assert.equal(result.metrics.backend, 'together');
    assert.equal(result.metrics.pair_count, 10);
    assert.equal(result.adapter.sha256, 'sha256-9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a');
    assert.equal(result.compute.provenance.together_job_id, 'ft-test');
    assert.equal(result.compute.provider_price.token_count, 850000);
    assert.deepEqual(seen.map((s) => s.pathname), [
      '/v1/files/upload',
      '/v1/fine-tunes',
      '/v1/fine-tunes/ft-test',
      '/v1/fine-tunes/ft-test/download',
    ]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken == null) delete process.env.KOLM_TOGETHER_TOKEN; else process.env.KOLM_TOGETHER_TOKEN = oldToken;
  }
});

test('5. Together rejects too-small training corpora with an explicit minimum', async () => {
  const oldToken = process.env.KOLM_TOGETHER_TOKEN;
  process.env.KOLM_TOGETHER_TOKEN = 'test-token';
  try {
    const { run } = await import(TOGETHER_URL + `?wave551=min-${Date.now()}`);
    await assert.rejects(
      run({ evals: { cases: [{ input: 'a', expected: 'b' }] }, poll_interval_ms: 0 }),
      />=10 training pairs/
    );
  } finally {
    if (oldToken == null) delete process.env.KOLM_TOGETHER_TOKEN; else process.env.KOLM_TOGETHER_TOKEN = oldToken;
  }
});

test('6. quantize README and worker expose method-specific readiness', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'workers', 'quantize', 'README.md'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'workers', 'quantize', 'quantize.mjs'), 'utf8');
  assert.match(readme, /ready_by_method/);
  assert.match(readme, /toolchain_not_ready/);
  assert.doesNotMatch(readme, /python script not yet shipped/i);
  assert.match(worker, /missing_by_method/);
  assert.match(worker, /auto_gptq_ok/);
  assert.match(worker, /autoawq_ok/);
});

test('7. Anthropic compute backend speaks native Messages API, not OpenAI protocol', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  const oldBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.test';
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    assert.equal(String(url), 'https://api.anthropic.test/v1/messages');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-api-key'], 'test-anthropic-key');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.ok(!String(url).includes('/chat/completions'), 'Claude backend must not use OpenAI chat route');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-sonnet-4-6');
    assert.equal(body.system, 'be terse');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
    return jsonResponse({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      usage: { input_tokens: 4, output_tokens: 2 },
    });
  };
  try {
    const { run } = await import(ANTHROPIC_URL + `?wave551=${Date.now()}`);
    const out = await run({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'ping' },
      ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.text, 'pong');
    assert.equal(out.usage.input_tokens, 4);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    if (oldBase == null) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = oldBase;
  }
});
