// W694 - direct contract/security test for services/index/qmd.js.
//
// qmd is a service boundary that can cross env config, HTTP MCP, and child
// process execution. Keep it bounded and local-first without requiring a real
// qmd install in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const QMD_PATH = path.join(ROOT, 'services/index/qmd.js');
const MODULE_URL = pathToFileURL(QMD_PATH).href;

async function loadModule() {
  return import(`${MODULE_URL}?wave694=${Date.now()}-${Math.random()}`);
}

function withEnv(patch, fn) {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
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

test('W694 qmd adapter source and depth wiring pin bounded local transports', async () => {
  const source = fs.readFileSync(QMD_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(pkg.scripts['verify:qmd-index'], /wave694-qmd-index-adapter-contract\.test\.js/);
  assert.match(pkg.scripts['verify:depth'], /verify:qmd-index/);
  assert.match(source, /export const QMD_ADAPTER_VERSION = 'w694-v1'/);
  assert.match(source, /MAX_STDERR_CHARS: 8192/);
  assert.match(source, /function fetchWithTimeout/);
  assert.match(source, /function normalizeMcpUrl/);
  assert.match(source, /windowsHide: true/);
  assert.doesNotMatch(source, /err \+= d\.toString\(\)/);
});

test('W694 qmd MCP URL validation is loopback by default and credential-free', async () => {
  const mod = await loadModule();

  assert.equal(mod.normalizeMcpUrl('http://127.0.0.1:8181/mcp?token=drop#frag'), 'http://127.0.0.1:8181/mcp');
  assert.equal(mod.normalizeMcpUrl('http://localhost:8181'), 'http://localhost:8181/mcp');
  assert.throws(() => mod.normalizeMcpUrl('file:///tmp/qmd'), /http or https/);
  assert.throws(() => mod.normalizeMcpUrl('https://token@example.com/mcp'), /must not include credentials/);
  assert.throws(() => mod.normalizeMcpUrl('https://example.com/mcp'), /must be loopback/);
  assert.equal(mod.normalizeMcpUrl('https://example.com/mcp', { allowRemote: true }), 'https://example.com/mcp');
});

test('W694 qmd HTTP transport normalizes MCP query calls and chunks', async () => {
  const mod = await loadModule();
  const calls = [];

  await withEnv({ QMD_MCP_URL: 'http://127.0.0.1:8181/mcp', QMD_BIN: undefined }, async () => {
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.method, 'POST');
      assert.ok(init.signal, 'HTTP calls should carry an abort signal');
      return new Response(JSON.stringify({
        result: {
          content: [
            {
              id: 'doc-1',
              path: 'corpus/private.md',
              score: '0.91',
              text: 'A'.repeat(5000),
              collection: 'kolm-tenant-notes',
            },
            'plain string chunk',
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }, async () => {
      const chunks = await mod.query({ namespace: 'kolm-tenant-notes', query: 'find private answer', k: 500 });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body.params, {
        name: 'query',
        arguments: {
          query: 'find private answer',
          collection: 'kolm-tenant-notes',
          n: 100,
        },
      });
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].docid, 'doc-1');
      assert.equal(chunks[0].score, 0.91);
      assert.equal(chunks[0].snippet.length, 4000);
      assert.equal(chunks[1].snippet, 'plain string chunk');
    });
  });
});

test('W694 qmd availability checks use health URL and sanitize failures', async () => {
  const mod = await loadModule();
  await withEnv({ QMD_MCP_URL: 'http://127.0.0.1:8181/mcp', QMD_BIN: 'bad\u0000bin' }, async () => {
    await withFetch(async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:8181/health');
      assert.equal(init.method, 'GET');
      return new Response('{}', { status: 200 });
    }, async () => {
      const available = await mod.isAvailable();
      assert.deepEqual(available, { available: true, transport: 'http', version: 'w694-v1' });
    });
  });

  await withEnv({ QMD_MCP_URL: 'https://ks_live_secret_should_not_leak@example.com/mcp' }, async () => {
    const unavailable = await mod.isAvailable();
    assert.equal(unavailable.available, false);
    assert.doesNotMatch(unavailable.reason, /secret_should_not_leak/);
    assert.match(unavailable.reason, /credentials|redacted/);
  });
});

test('W694 qmd CLI transport preserves query shape and redacts bounded errors', async () => {
  const mod = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-qmd-'));
  const originalCwd = process.cwd();

  fs.writeFileSync(path.join(tmp, 'query'), [
    "const fs = require('node:fs');",
    "fs.writeFileSync('query-args.json', JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ results: [",
    "  { docid: 'a', path: 'a.md', score: 1, snippet: 'alpha', collection: 'ns-ok' },",
    "  { id: 'b', excerpt: 'beta' }",
    "] }));",
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(tmp, 'status'), [
    "process.stderr.write('bad ks_live_qmd_secret_abcdef123456 ' + 'x'.repeat(20000));",
    'process.exit(9);',
    '',
  ].join('\n'), 'utf8');

  try {
    process.chdir(tmp);
    await withEnv({ QMD_BIN: process.execPath, QMD_MCP_URL: undefined }, async () => {
      const chunks = await mod.query({ namespace: 'ns-ok', query: 'hello cli', k: 2 });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'query-args.json'), 'utf8')), [
        'hello cli',
        '--json',
        '-n',
        '2',
        '-c',
        'ns-ok',
      ]);
      assert.deepEqual(chunks, [
        { docid: 'a', path: 'a.md', score: 1, snippet: 'alpha', collection: 'ns-ok' },
        { docid: 'b', path: null, score: null, snippet: 'beta', collection: null },
      ]);

      const status = await mod.status({ name: 'ns-ok' });
      assert.equal(status.ok, false);
      assert.match(status.error, /qmd status exited 9:/);
      assert.doesNotMatch(status.error, /secret_abcdef/);
      assert.match(status.error, /\[redacted\]/);
      assert.ok(status.error.length < 8300);
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('W694 qmd add/embed/query validate untrusted arguments before transport', async () => {
  const mod = await loadModule();

  await assert.rejects(() => mod.addCollection({ name: '../bad', paths: ['x'] }), /namespace/);
  await assert.rejects(() => mod.addCollection({ name: 'ok', paths: [] }), /non-empty array/);
  await assert.rejects(() => mod.addCollection({ name: 'ok', paths: Array.from({ length: 65 }, (_, i) => `p${i}`) }), /exceed/);
  await assert.rejects(() => mod.embed({ name: 'bad/name' }), /namespace/);
  await assert.rejects(() => mod.query({ namespace: 'ok', query: 'bad\u0000query', k: 1 }), /query/);
  await assert.rejects(() => mod.query({ namespace: 'bad namespace', query: 'hello', k: 1 }), /namespace/);
});
