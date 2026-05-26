// Wrapper integration tests - kolm.ai Wrapper surface (10 tests, each <2m).
//
// These tests are AUTHORED against the W-F (Wrapper - Frontend) + W-D
// (Wrapper - Dispatcher) surfaces. They default-skip with an explicit
// opt-in reason so they don't block ordinary `npm test` runs while the
// rest of the wrapper code is still in motion.
//
// To run: set KOLM_WRAPPER_TESTS=1 and run the suite.
//
// Items pinned:
//   #1  - confidence-routing local hit (low-entropy sticks local)
//   #2  - confidence-routing fallback (high-entropy escalates to frontier)
//   #3  - hash-chain integrity: 10-row chain with HMAC-linked prev_chain_hash
//   #4  - multi-provider: 3 calls across openai/anthropic/google all sign + capture
//   #5  - latency p50 < 50ms gateway overhead (CI-relaxed from spec 5ms)
//   #6  - bulk approval: 1000 rows via --bulk-from completes in <5s (CI-relaxed from 2s)
//   #7  - namespace deploy round-trip: create+config+deploy+status+undeploy all ok:true
//   #8  - key rotation: receipts verify ok on receipt signed by previous key (30-day overlap)
//   #9  - redaction-mode coverage: 4 modes produce expected envelope shapes
//   #10 - poison-quarantine: 3+ signal row auto-quarantines + appears in list --status=quarantined

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

// Async spawn that doesn't block the parent libuv event loop. spawnSync would
// deadlock in-process mock HTTP servers (parent loop frozen → server never
// accepts), so the entire suite must use async + await on every runCli call.
function runCli(args, env = {}, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(execPath, [...CLI, ...args, '--json'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: stderr + String(e?.message || e), error: e });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wrapper-int-'));
  return {
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
  };
}

function startMock(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ----------------------------------------------------------------------------
// #1 - confidence-routing local hit
// ----------------------------------------------------------------------------
test('wrapper-int #1 - confidence-routing local hit: low-entropy response sticks local (route_decision=local)', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  // Stand up a "local" mock backend that returns a confident, deterministic answer.
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'yes' }, logprobs: { content: [{ token: 'yes', logprob: -0.001 }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    // Seed a namespace with primary=local pointing at the mock.
    const create = await runCli(['namespace', 'create', 'ns-low-entropy', '--primary', 'local'], env);
    assert.equal(create.status, 0, `namespace create exited ${create.status}; stderr=${create.stderr}`);
    const conf = await runCli(
      ['namespace', 'config', 'ns-low-entropy', '--local-endpoint', url, '--confidence-threshold', '0.5'],
      env,
    );
    assert.equal(conf.status, 0, `namespace config exited ${conf.status}; stderr=${conf.stderr}`);

    const call = await runCli(
      ['gateway', 'call', '--namespace', 'ns-low-entropy', '--message', 'is the sky blue?'],
      env,
    );
    assert.equal(call.status, 0, `gateway call exited ${call.status}; stderr=${call.stderr}`);
    const out = JSON.parse(call.stdout);
    assert.equal(out.route_decision, 'local',
      `route_decision must be "local" on low-entropy response; got ${out.route_decision}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #2 - confidence-routing fallback
// ----------------------------------------------------------------------------
test('wrapper-int #2 - confidence-routing fallback: high-entropy triggers fallback to frontier', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  // Local mock returns a high-entropy/uncertain response; frontier mock returns a strong one.
  const { server: local, url: localUrl } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'maybe' }, logprobs: { content: [{ token: 'maybe', logprob: -3.5 }] } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
  const { server: frontier, url: frontierUrl } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'definitely yes' } }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }));
  });
  try {
    await runCli(['namespace', 'create', 'ns-high-entropy', '--primary', 'local'], env);
    await runCli(
      ['namespace', 'config', 'ns-high-entropy',
       '--local-endpoint', localUrl,
       '--frontier-endpoint', frontierUrl,
       '--confidence-threshold', '0.9'],
      env,
    );

    const call = await runCli(
      ['gateway', 'call', '--namespace', 'ns-high-entropy', '--message', 'will it rain on Tuesday?'],
      env,
    );
    assert.equal(call.status, 0, `gateway call exited ${call.status}; stderr=${call.stderr}`);
    const out = JSON.parse(call.stdout);
    assert.equal(out.route_decision, 'frontier',
      `route_decision must be "frontier" on high-entropy local; got ${out.route_decision}`);
    assert.equal(out.fallback_reason, 'low_confidence',
      `fallback_reason must be "low_confidence"; got ${out.fallback_reason}`);
    assert.equal(out.capture_eligible, true,
      `capture_eligible must be true for fallback flow; got ${out.capture_eligible}`);
  } finally {
    local.close();
    frontier.close();
  }
});

// ----------------------------------------------------------------------------
// #3 - hash-chain integrity over 10 rows
// ----------------------------------------------------------------------------
test('wrapper-int #3 - hash-chain integrity: 10 rows have HMAC-linked prev_chain_hash', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'chained' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    for (let i = 0; i < 10; i++) {
      const r = await runCli(
        ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', `m-${i}`, '--capture'],
        { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_RECEIPT_SIGNING_KEY: signingKey, KOLM_GATEWAY_MODE: 'cloud' },
      );
      assert.equal(r.status, 0, `call ${i} exited ${r.status}; stderr=${r.stderr}`);
    }
    const list = await runCli(['captures', 'list', '--limit', '20'], env);
    assert.equal(list.status, 0, `captures list exited ${list.status}; stderr=${list.stderr}`);
    const out = JSON.parse(list.stdout);
    const rows = (out.rows || out.captures || [])
      .slice()
      .sort((a, b) => (a.ts || a.timestamp || 0) - (b.ts || b.timestamp || 0));
    assert.ok(rows.length >= 10, `expected >=10 rows; got ${rows.length}`);
    for (let i = 1; i < 10; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      // Recompute HMAC over canonical prev row and assert equality.
      const canonical = JSON.stringify(prev, Object.keys(prev).sort());
      const expected = crypto.createHmac('sha256', signingKey).update(canonical).digest('hex');
      const got = cur.prev_chain_hash || cur.prev_hash;
      assert.equal(got, expected,
        `row ${i} prev_chain_hash mismatch; expected ${expected.slice(0, 16)}…, got ${(got || '').slice(0, 16)}…`);
    }
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #4 - multi-provider: 3 calls across openai/anthropic/google all sign + capture
// ----------------------------------------------------------------------------
test('wrapper-int #4 - multi-provider: 3 calls across openai/anthropic/google sign + capture under same namespace', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    await runCli(['namespace', 'create', 'ns-multi-provider'], env);
    const providers = [
      { id: 'openai', model: 'gpt-4o-mini', envVar: 'KOLM_UPSTREAM_OPENAI_BASE' },
      { id: 'anthropic', model: 'claude-haiku-4-5', envVar: 'KOLM_UPSTREAM_ANTHROPIC_BASE' },
      { id: 'google', model: 'gemini-2.5-flash', envVar: 'KOLM_UPSTREAM_GOOGLE_BASE' },
    ];
    for (const p of providers) {
      const r = await runCli(
        ['gateway', 'call', '--provider', p.id, '--model', p.model, '--namespace', 'ns-multi-provider',
         '--message', `hello ${p.id}`, '--receipt', '--capture'],
        { ...env, [p.envVar]: url, KOLM_RECEIPT_SIGNING_KEY: signingKey, KOLM_GATEWAY_MODE: 'cloud' },
      );
      assert.equal(r.status, 0, `provider ${p.id} call exited ${r.status}; stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out?.receipt?.schema, 'kolm-audit-1',
        `provider ${p.id}: receipt.schema must be kolm-audit-1; got ${out?.receipt?.schema}`);
      assert.ok(out?.receipt?.signature, `provider ${p.id}: receipt.signature missing`);
    }
    const list = await runCli(['captures', 'list', '--namespace', 'ns-multi-provider'], env);
    assert.equal(list.status, 0);
    const rows = JSON.parse(list.stdout).rows || JSON.parse(list.stdout).captures || [];
    const distinctProviders = new Set(rows.map((r) => r.provider));
    for (const p of providers) {
      assert.ok(distinctProviders.has(p.id),
        `provider ${p.id} missing from captures; got ${Array.from(distinctProviders).join(',')}`);
    }
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #5 - latency p50 < 50ms gateway overhead (CI-relaxed from spec 5ms)
// ----------------------------------------------------------------------------
test('wrapper-int #5 - latency p50 < 50ms gateway overhead over fixed in-process mock (CI-relaxed)', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'fast' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    const N = 21;
    const overheads = [];
    for (let i = 0; i < N; i++) {
      const r = await runCli(
        ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', `bench-${i}`, '--report-latency'],
        { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_GATEWAY_MODE: 'cloud' },
      );
      assert.equal(r.status, 0, `bench call ${i} exited ${r.status}; stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      const overheadMs = out?.latency_ms?.gateway_overhead;
      assert.ok(typeof overheadMs === 'number', `latency_ms.gateway_overhead must be number; got ${overheadMs}`);
      overheads.push(overheadMs);
    }
    overheads.sort((a, b) => a - b);
    const p50 = overheads[Math.floor(N / 2)];
    assert.ok(p50 < 50, `p50 gateway overhead must be < 50ms; got ${p50}ms (samples: ${overheads.join(',')})`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #6 - bulk approval: 1000 rows via --bulk-from completes in <5s (CI-relaxed)
// ----------------------------------------------------------------------------
test('wrapper-int #6 - bulk approval: 1000 rows via --bulk-from completes in <5s (CI-relaxed)', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  // Seed 1000 pending capture rows via the synthetic-seed verb (no upstream calls).
  const seed = await runCli(['captures', 'seed', '--count', '1000', '--status', 'pending'], env);
  assert.equal(seed.status, 0, `seed exited ${seed.status}; stderr=${seed.stderr}`);
  const seeded = JSON.parse(seed.stdout);
  const idsFile = seeded.ids_file || seeded.path;
  assert.ok(idsFile && fs.existsSync(idsFile), `seed must produce a usable ids_file; got ${idsFile}`);

  const t0 = Date.now();
  const approve = await runCli(['captures', 'approve', '--bulk-from', idsFile], env, 60_000);
  const elapsedMs = Date.now() - t0;
  assert.equal(approve.status, 0, `bulk approve exited ${approve.status}; stderr=${approve.stderr}`);
  const out = JSON.parse(approve.stdout);
  assert.equal(out.approved_count, 1000, `approved_count must be 1000; got ${out.approved_count}`);
  assert.ok(elapsedMs < 5_000, `bulk approval must complete in <5s; took ${elapsedMs}ms`);
});

// ----------------------------------------------------------------------------
// #7 - namespace deploy round-trip
// ----------------------------------------------------------------------------
test('wrapper-int #7 - namespace deploy round-trip: create+config+deploy+status+undeploy all ok:true', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const steps = [
    ['namespace', 'create', 'ns-deploy-rt'],
    ['namespace', 'config', 'ns-deploy-rt', '--primary', 'local'],
    ['namespace', 'deploy', 'ns-deploy-rt'],
    ['namespace', 'status', 'ns-deploy-rt'],
    ['namespace', 'undeploy', 'ns-deploy-rt'],
  ];
  for (const args of steps) {
    const r = await runCli(args, env);
    assert.equal(r.status, 0, `${args.join(' ')} exited ${r.status}; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `${args.join(' ')} must return ok:true; got ${JSON.stringify(out)}`);
  }
});

// ----------------------------------------------------------------------------
// #8 - key rotation: receipts verify ok on receipt signed by previous key
// ----------------------------------------------------------------------------
test('wrapper-int #8 - key rotation: receipts verify still ok on receipt from previous key (30-day overlap)', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const prevKey = crypto.randomBytes(32).toString('hex');
  const newKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'pre-rotation' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    // 1) Sign a receipt with prevKey.
    const callRes = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'pre-rotate', '--receipt'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_RECEIPT_SIGNING_KEY: prevKey, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(callRes.status, 0, `pre-rotation call exited ${callRes.status}; stderr=${callRes.stderr}`);
    const receiptId = JSON.parse(callRes.stdout)?.receipt?.id;
    assert.ok(receiptId, `receipt.id missing`);

    // 2) Rotate to newKey while keeping prevKey in the overlap set.
    const rot = await runCli(
      ['receipts', 'rotate-key', '--new', newKey, '--overlap-days', '30'],
      { ...env, KOLM_RECEIPT_SIGNING_KEY: prevKey },
    );
    assert.equal(rot.status, 0, `rotate-key exited ${rot.status}; stderr=${rot.stderr}`);

    // 3) Verify the prevKey-signed receipt under the newKey environment.
    const v = await runCli(
      ['receipts', 'verify', receiptId],
      { ...env, KOLM_RECEIPT_SIGNING_KEY: newKey, KOLM_RECEIPT_PREVIOUS_KEY: prevKey },
    );
    assert.equal(v.status, 0, `verify exited ${v.status}; stderr=${v.stderr}`);
    const out = JSON.parse(v.stdout);
    assert.equal(out.ok, true, `verify must return ok:true post-rotation; got ${JSON.stringify(out)}`);
    assert.equal(out.signed_by, 'previous_key',
      `verify must mark signed_by as previous_key; got ${out.signed_by}`);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #9 - redaction-mode coverage: 4 modes produce expected envelope shapes
// ----------------------------------------------------------------------------
test('wrapper-int #9 - redaction-mode coverage: all 4 modes produce expected receipt + capture body shapes', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'noted contact: test@example.com' } }],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
    }));
  });
  try {
    const modes = ['detect_only', 'redact_captures', 'redact_all', 'block'];
    for (const mode of modes) {
      const r = await runCli(
        ['gateway', 'call', '--model', 'gpt-4o-mini',
         '--message', 'reach me at test@example.com',
         '--receipt', '--capture', '--redact', mode],
        { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_RECEIPT_SIGNING_KEY: signingKey, KOLM_GATEWAY_MODE: 'cloud' },
      );
      if (mode === 'block') {
        assert.notEqual(r.status, 0, `mode=block must exit non-zero; got ${r.status}`);
        const out = JSON.parse(r.stdout || '{}');
        assert.equal(out.blocked, true, `mode=block must set blocked:true; got ${JSON.stringify(out)}`);
        continue;
      }
      assert.equal(r.status, 0, `mode=${mode} exited ${r.status}; stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      const applied = out?.receipt?.redaction_applied || [];
      const hit = applied.find((a) => (a.kind || a.type) === 'email');
      assert.ok(hit, `mode=${mode}: expected email in receipt.redaction_applied; got ${JSON.stringify(applied)}`);
      if (mode === 'redact_captures' || mode === 'redact_all') {
        // Capture body must NOT contain the raw email.
        const list = await runCli(['captures', 'list', '--limit', '1'], env);
        assert.equal(list.status, 0);
        const rows = JSON.parse(list.stdout).rows || JSON.parse(list.stdout).captures || [];
        const body = JSON.stringify(rows[0]?.body || rows[0]);
        assert.ok(!body.includes('test@example.com'),
          `mode=${mode}: capture body must not contain raw PII; got ${body.slice(0, 200)}`);
      }
      if (mode === 'redact_all') {
        // Response to the caller must also be redacted.
        const content = out?.choices?.[0]?.message?.content || '';
        assert.ok(!content.includes('test@example.com'),
          `mode=redact_all: response content must not contain raw PII; got ${content}`);
      }
    }
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// #10 - poison-quarantine: 3+ signal row auto-quarantines
// ----------------------------------------------------------------------------
test('wrapper-int #10 - poison-quarantine: row flagged by 3+ signals auto-quarantines + lists as quarantined', { skip: !OPT_IN && SKIP_REASON }, async () => {
  const env = freshHome();
  // Build a maximally suspicious response (long + repetitive + base64-looking).
  const huge = 'A'.repeat(50_000);
  const { server, url } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: huge } }],
      usage: { prompt_tokens: 1, completion_tokens: 12_500, total_tokens: 12_501 },
    }));
  });
  try {
    const call = await runCli(
      ['gateway', 'call', '--model', 'gpt-4o-mini', '--message', 'trigger', '--capture', '--risk-scan'],
      { ...env, KOLM_UPSTREAM_OPENAI_BASE: url, KOLM_GATEWAY_MODE: 'cloud' },
    );
    assert.equal(call.status, 0, `call exited ${call.status}; stderr=${call.stderr}`);
    const callOut = JSON.parse(call.stdout);
    assert.ok((callOut.risk || []).length >= 3,
      `expected >=3 risk signals to trigger quarantine; got ${JSON.stringify(callOut.risk)}`);

    const list = await runCli(['captures', 'list', '--status', 'quarantined'], env);
    assert.equal(list.status, 0, `captures list exited ${list.status}; stderr=${list.stderr}`);
    const out = JSON.parse(list.stdout);
    const rows = out.rows || out.captures || [];
    assert.ok(rows.length >= 1, `expected >=1 quarantined row; got ${rows.length}`);
    assert.ok(rows.every((r) => r.status === 'quarantined'),
      `every row must have status=quarantined; got ${rows.map((r) => r.status).join(',')}`);
  } finally {
    server.close();
  }
});
