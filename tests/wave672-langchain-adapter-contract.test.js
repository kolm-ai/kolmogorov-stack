// W672 - direct contract/security test for packages/langchain-kolm/index.js.
//
// The LangChain adapter is a package-distribution boundary with env config,
// network transport, and subprocess execution. Pin the checked-in adapter
// against URL normalization, timeout, redaction, and receipt preservation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_URL = pathToFileURL(path.join(ROOT, 'packages/langchain-kolm/index.js')).href;

async function loadModule() {
  return import(`${MODULE_URL}?wave672=${Date.now()}-${Math.random()}`);
}

async function withFetch(fakeFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('W672 langchain adapter validates transport setup and base URLs', async () => {
  const { KolmLLM } = await loadModule();

  assert.throws(
    () => new KolmLLM(),
    /either artifactPath \(subprocess\) or baseUrl \(HTTP\) is required/,
  );
  assert.throws(
    () => new KolmLLM({ baseUrl: 'file:///tmp/runtime' }),
    /baseUrl must use http or https/,
  );
  assert.throws(
    () => new KolmLLM({ baseUrl: 'https://token@example.test' }),
    /baseUrl must not include credentials/,
  );

  const llm = new KolmLLM({ baseUrl: 'https://runtime.example///?token=leak#frag', timeoutMs: -1 });
  assert.equal(llm.baseUrl, 'https://runtime.example');
  assert.equal(llm.timeoutMs, 30000);
  await assert.rejects(
    () => llm.invokeWithReceipt({ role: 'user', content: 'not a string' }),
    /prompt must be a string/,
  );
});

test('W672 langchain adapter preserves HTTP receipts and normalizes request shape', async () => {
  const { KolmLLM } = await loadModule();
  const seen = {};
  await withFetch(async (url, init) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify({
      text: 'compiled answer',
      receipt: { cid: 'cidv1:abc', k_score: 0.98 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const llm = new KolmLLM({
      baseUrl: 'https://runtime.example/api/',
      artifactPath: 'models/private artifact.kolm',
      apiKey: 'ks_live_http_secret_123456',
    });
    const out = await llm.invokeWithReceipt('hello');
    assert.equal(seen.url, 'https://runtime.example/api/v1/run/models%2Fprivate%20artifact.kolm');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.authorization, 'Bearer ks_live_http_secret_123456');
    assert.deepEqual(JSON.parse(seen.init.body), { prompt: 'hello' });
    assert.equal(out.text, 'compiled answer');
    assert.deepEqual(out.receipt, { cid: 'cidv1:abc', k_score: 0.98 });
    assert.equal(llm.lastReceipt.cid, 'cidv1:abc');
  });
});

test('W672 langchain adapter redacts HTTP errors and supports plain text responses', async () => {
  const { KolmLLM } = await loadModule();
  const apiKey = 'ks_live_http_secret_abcdef123456';

  await withFetch(async () => new Response(JSON.stringify({
    error: `bad key ${apiKey} and Bearer ${apiKey} and sk-super-secret-abcdef`,
  }), { status: 401, headers: { 'content-type': 'application/json' } }), async () => {
    const llm = new KolmLLM({ baseUrl: 'https://runtime.example', apiKey });
    await assert.rejects(
      () => llm.invokeWithReceipt('hello'),
      (err) => {
        assert.match(err.message, /kolm http 401:/);
        assert.doesNotMatch(err.message, /secret_abcdef|Bearer ks_live|sk-super-secret/);
        assert.match(err.message, /\[redacted\]/);
        return true;
      },
    );
  });

  await withFetch(async () => new Response('plain answer', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  }), async () => {
    const llm = new KolmLLM({ baseUrl: 'https://runtime.example' });
    const out = await llm.invokeWithReceipt('hello');
    assert.deepEqual(out, { text: 'plain answer', receipt: null });
  });
});

test('W672 langchain adapter aborts HTTP calls on timeout', async () => {
  const { KolmLLM } = await loadModule();
  await withFetch(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }), async () => {
    const llm = new KolmLLM({ baseUrl: 'https://runtime.example', timeoutMs: 5 });
    await assert.rejects(
      () => llm.invokeWithReceipt('hello'),
      /kolm http timeout after 5ms/,
    );
  });
});

test('W672 langchain adapter reads KOLM_BIN at construction and bounds subprocess stderr', async () => {
  const { KolmLLM } = await loadModule();
  const originalCwd = process.cwd();
  const originalBin = process.env.KOLM_BIN;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-langchain-'));
  fs.writeFileSync(path.join(tmp, 'run'), [
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { stdin += chunk; });",
    "process.stdin.on('end', () => {",
    "  if (process.argv[2] === 'bad-artifact') {",
    "    process.stderr.write('x'.repeat(20000));",
    "    process.exit(7);",
    '  }',
    '  process.stdout.write(JSON.stringify({',
    "    text: `stdin:${stdin}`,",
    "    receipt: { artifact: process.argv[2], json: process.argv.includes('--json') },",
    '  }));',
    '});',
    '',
  ].join('\n'), 'utf8');

  try {
    process.chdir(tmp);
    process.env.KOLM_BIN = process.execPath;

    const llm = new KolmLLM({ artifactPath: 'local-artifact.kolm', timeoutMs: 1000 });
    assert.equal(llm.bin, process.execPath);
    const out = await llm.invokeWithReceipt('hello subprocess');
    assert.deepEqual(out, {
      text: 'stdin:hello subprocess',
      receipt: { artifact: 'local-artifact.kolm', json: true },
    });
    assert.equal(llm.lastReceipt.artifact, 'local-artifact.kolm');

    const failing = new KolmLLM({ artifactPath: 'bad-artifact', timeoutMs: 1000 });
    await assert.rejects(
      () => failing.invokeWithReceipt('hello'),
      (err) => {
        assert.match(err.message, /kolm run exited 7:/);
        assert.ok(err.message.length < 8300, `stderr should be capped, got ${err.message.length}`);
        return true;
      },
    );
  } finally {
    process.chdir(originalCwd);
    if (originalBin === undefined) delete process.env.KOLM_BIN;
    else process.env.KOLM_BIN = originalBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
