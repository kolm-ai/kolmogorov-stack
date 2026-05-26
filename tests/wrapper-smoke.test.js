// Wrapper smoke tests - kolm.ai Wrapper surface (12 tests, each <30s).
//
// These tests are AUTHORED against the W-F (Wrapper - Frontend) + W-D
// (Wrapper - Dispatcher) surfaces. They default-skip with an explicit
// opt-in reason so they don't block ordinary `npm test` runs while the
// rest of the wrapper code is still in motion.
//
// To run: set KOLM_WRAPPER_TESTS=1 and run the suite.
//
// Items pinned:
//   #1  - `kolm gateway status` reports mode + reachability
//   #2  - `kolm gateway routes` lists at least 1 default route
//   #3  - `kolm gateway providers` lists 11 known providers
//   #4  - `kolm gateway health` envelope has reachable+unreachable buckets
//   #5  - openai-compat POST /v1/chat/completions returns choices[0].message.content
//   #6  - SSE streaming: stream:true yields data: chunks ending in [DONE]
//   #7  - Receipt generation: kolm-audit-1 receipt envelope present when signing key set
//   #8  - `kolm receipts verify <id>` returns ok:true on a freshly-signed receipt
//   #9  - Capture write: hash chain has prev_hash != null on row 2
//   #10 - PII detection surfaces email in receipt.redaction_applied
//   #11 - Poison detector sets risk[].output_length_anomaly for >99p length response
//   #12 - Rate-limit envelope: 429 + Retry-After + queue_depth over free tier cap

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execPath } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = [path.join(REPO_ROOT, 'cli', 'kolm.js')];

const OPT_IN = process.env.KOLM_WRAPPER_TESTS === '1';
const SKIP_REASON = 'opt-in: set KOLM_WRAPPER_TESTS=1 once W-F + W-D land';

// `runCli` is async (returns a Promise<{status, signal, stdout, stderr}>).
// Tests that drive an in-process mock HTTP server MUST `await runCli(...)` —
// using spawnSync here would block the parent's event loop and starve the
// mock server's request handler, deadlocking until the child times out.
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(execPath, [...CLI, ...args, '--json'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {} // deliberate: cleanup
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000); // deliberate: cleanup
    }, 25_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: stderr + String(e && e.message || e), error: e });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wrapper-smoke-'));
  return {
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
  };
}

// Start a minimal in-process HTTP mock backend that speaks openai-compat.
function startMockOpenAi(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ----------------------------------------------------------------------------
// #1 - gateway status reports mode + reachability
// ----------------------------------------------------------------------------
test('wrapper-smoke #1 - kolm gateway status reports mode + reachability', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const r = await runCli(['gateway', 'status'], env);
  assert.equal(r.status, 0, `kolm gateway status exited ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(typeof out.mode === 'string', `status.mode must be a string; got ${typeof out.mode}`);
  assert.ok(out.reachability && typeof out.reachability === 'object',
    `status.reachability must be an object; got ${typeof out.reachability}`);
});

// ----------------------------------------------------------------------------
// #2 - gateway routes lists at least 1 default route
// ----------------------------------------------------------------------------
test('wrapper-smoke #2 - kolm gateway routes lists at least 1 default route', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const r = await runCli(['gateway', 'routes'], env);
  assert.equal(r.status, 0, `kolm gateway routes exited ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.routes), `routes must be an array; got ${typeof out.routes}`);
  assert.ok(out.routes.length >= 1, `expected >=1 default route; got ${out.routes.length}`);
});

// ----------------------------------------------------------------------------
// #3 - gateway providers lists 11 known providers
// ----------------------------------------------------------------------------
test('wrapper-smoke #3 - kolm gateway providers lists 11 known providers', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const r = await runCli(['gateway', 'providers'], env);
  assert.equal(r.status, 0, `kolm gateway providers exited ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const ids = (out.providers || []).map((p) => p.id || p.name);
  const need = [
    'openai', 'anthropic', 'google', 'deepseek', 'groq',
    'together', 'fireworks', 'openrouter',
    'local-vllm', 'local-ollama', 'local-kolm',
  ];
  for (const n of need) {
    assert.ok(ids.includes(n), `missing provider ${n}; got ${ids.join(',')}`);
  }
});

// ----------------------------------------------------------------------------
// #4 - gateway health envelope has reachable+unreachable buckets
// ----------------------------------------------------------------------------
test('wrapper-smoke #4 - kolm gateway health envelope has reachable+unreachable buckets', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const r = await runCli(['gateway', 'health'], env);
  assert.equal(r.status, 0, `kolm gateway health exited ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.reachable), `health.reachable must be an array; got ${typeof out.reachable}`);
  assert.ok(Array.isArray(out.unreachable), `health.unreachable must be an array; got ${typeof out.unreachable}`);
});

// ----------------------------------------------------------------------------
// #5 - openai-compat POST /v1/chat/completions returns choices[0].message.content
// ----------------------------------------------------------------------------
test('wrapper-smoke #5 - openai-compat /v1/chat/completions returns choices[0].message.content', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const { server, url } = await startMockOpenAi((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok from mock' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      }));
    });
  });
  try {
    const r = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'hello'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(r.status, 0, `gateway call exited ${r.status}; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const content = out?.choices?.[0]?.message?.content;
    assert.equal(content, 'ok from mock', `expected mock content; got ${JSON.stringify(content)}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #6 - SSE streaming yields data: chunks ending in [DONE]
// ----------------------------------------------------------------------------
test('wrapper-smoke #6 - SSE streaming: stream:true yields data: chunks ending in [DONE]', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const { server, url } = await startMockOpenAi((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const r = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'hi', '--stream'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(r.status, 0, `streaming call exited ${r.status}; stderr=${r.stderr}`);
    // CLI in --json mode collects stream and emits a structured envelope.
    const out = JSON.parse(r.stdout);
    assert.equal(out.stream_done, true, `stream_done must be true; got ${out.stream_done}`);
    assert.ok(typeof out.assembled_content === 'string' && out.assembled_content.length > 0,
      `assembled_content must be non-empty string; got ${JSON.stringify(out.assembled_content)}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #7 - Receipt generation: every /v1/chat/completions call returns kolm-audit-1 envelope
// ----------------------------------------------------------------------------
test('wrapper-smoke #7 - receipt: /v1/chat/completions returns kolm-audit-1 envelope when signing key present', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMockOpenAi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'receipt-bearing reply' } }],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    }));
  });
  try {
    const r = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'hi', '--receipt'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_RECEIPT_SIGNING_KEY: signingKey, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(r.status, 0, `gateway call exited ${r.status}; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out?.receipt?.schema, 'kolm-audit-1', `receipt.schema must be kolm-audit-1; got ${out?.receipt?.schema}`);
    assert.ok(typeof out?.receipt?.signature === 'string' && out.receipt.signature.length > 0,
      `receipt.signature must be non-empty string`);
    assert.ok(typeof out?.receipt?.id === 'string', `receipt.id must be a string`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #8 - receipt verification CLI on a freshly-signed receipt returns ok:true
// ----------------------------------------------------------------------------
test('wrapper-smoke #8 - kolm receipts verify <id> on a freshly-signed receipt returns ok:true', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMockOpenAi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'verifiable' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    const callRes = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'go', '--receipt'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_RECEIPT_SIGNING_KEY: signingKey, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(callRes.status, 0, `gateway call exited ${callRes.status}; stderr=${callRes.stderr}`);
    const receiptId = JSON.parse(callRes.stdout)?.receipt?.id;
    assert.ok(receiptId, `receipt.id missing in call response`);

    const verifyRes = await runCli(
      ['receipts', 'verify', receiptId],
      { ...env, KOLM_RECEIPT_SIGNING_KEY: signingKey },
    );
    assert.equal(verifyRes.status, 0, `receipts verify exited ${verifyRes.status}; stderr=${verifyRes.stderr}`);
    const verify = JSON.parse(verifyRes.stdout);
    assert.equal(verify.ok, true, `receipts verify must return ok:true; got ${JSON.stringify(verify)}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #9 - Capture write: hash chain has prev_hash != null on row 2
// ----------------------------------------------------------------------------
test('wrapper-smoke #9 - capture write: row 2 has prev_hash != null (hash chain)', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const { server, url } = await startMockOpenAi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'capture me' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await runCli(
        ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', `m${i}`, '--capture'],
        { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_GATEWAY_MODE: 'cloud' },
      );
      assert.equal(r.status, 0, `call ${i} exited ${r.status}; stderr=${r.stderr}`);
    }
    const list = await runCli(['captures', 'list', '--limit', '5'], env);
    assert.equal(list.status, 0, `captures list exited ${list.status}; stderr=${list.stderr}`);
    const out = JSON.parse(list.stdout);
    const rows = out.rows || out.captures || [];
    assert.ok(rows.length >= 2, `expected >=2 capture rows; got ${rows.length}`);
    // Find the second-oldest row (row 2 in chain order).
    const ordered = rows.slice().sort((a, b) => (a.ts || a.timestamp || 0) - (b.ts || b.timestamp || 0));
    const second = ordered[1];
    const prev = second.prev_hash || second.prev_chain_hash;
    assert.ok(prev && prev !== 'null' && prev.length > 0,
      `row 2 must have prev_hash non-null; got ${JSON.stringify(prev)}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #10 - PII detection surfaces email in receipt.redaction_applied
// ----------------------------------------------------------------------------
test('wrapper-smoke #10 - PII detection: request with "test@example.com" surfaces in receipt.redaction_applied', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMockOpenAi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'noted' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }));
  });
  try {
    const r = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'please email me at test@example.com', '--receipt', '--redact', 'detect_only'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_RECEIPT_SIGNING_KEY: signingKey, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(r.status, 0, `gateway call exited ${r.status}; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const applied = out?.receipt?.redaction_applied;
    assert.ok(Array.isArray(applied), `receipt.redaction_applied must be an array; got ${typeof applied}`);
    const emailHit = applied.find((a) => (a.kind || a.type) === 'email');
    assert.ok(emailHit, `expected email PII entry in redaction_applied; got ${JSON.stringify(applied)}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #11 - Poison detector sets risk[].output_length_anomaly for >99p length response
// ----------------------------------------------------------------------------
test('wrapper-smoke #11 - poison detector: long response sets risk[].output_length_anomaly', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  // Generate a deterministic long response (>99p length threshold).
  const huge = 'x'.repeat(50_000);
  const { server, url } = await startMockOpenAi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: huge } }],
      usage: { prompt_tokens: 1, completion_tokens: 12_500, total_tokens: 12_501 },
    }));
  });
  try {
    const r = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'hi', '--risk-scan'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(r.status, 0, `gateway call exited ${r.status}; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const risk = out?.risk || [];
    const hit = risk.find((s) => s.signal === 'output_length_anomaly' || s.kind === 'output_length_anomaly');
    assert.ok(hit, `expected risk[].output_length_anomaly entry; got ${JSON.stringify(risk)}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #12 - Rate-limit envelope on free tier over 50k cap returns 429 + Retry-After + queue_depth
// ----------------------------------------------------------------------------
test('wrapper-smoke #12 - rate-limit envelope: 429 + Retry-After + queue_depth over free tier cap', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  // Drive the simulated cap path; the CLI exposes a `gateway simulate-overflow`
  // verb which trips the rate-limit envelope without making real upstream calls.
  const r = await runCli(
    ['gateway', 'simulate-overflow', '--plan', 'free', '--over-by', '1'],
    env,
  );
  // Non-zero exit IS the contract for rate-limit (CLI mirrors HTTP 429).
  assert.notEqual(r.status, 0, `simulate-overflow must exit non-zero on cap breach; got ${r.status}`);
  const out = JSON.parse(r.stdout || '{}');
  assert.equal(out.status, 429, `envelope.status must be 429; got ${out.status}`);
  assert.ok(typeof out.retry_after === 'number' && out.retry_after > 0,
    `envelope.retry_after must be positive number; got ${out.retry_after}`);
  assert.ok(typeof out.queue_depth === 'number',
    `envelope.queue_depth must be a number; got ${out.queue_depth}`);
});
