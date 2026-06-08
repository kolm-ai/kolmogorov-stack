// Agent Security-Review — /v1/audit/* error-path + edge-case tests (spawned).
//
// The happy paths live in tests/agent-audit-routes.test.js. This file pins the
// EVERY-OTHER-BRANCH behavior the deliverable depends on, against a real
// server.js process, so a reviewer who handles the report's failure modes sees
// the same shapes the code promises:
//
//   Config A (signer ENABLED):
//     - run/scan with sign:false           → 200, signed:false, no signature
//     - scan with persist:false            → 200, id:null, report inline
//     - GET report before run              → 409 report_not_ready
//     - ingest / scan over the record cap  → 413 too_many_records
//     - ingest over the byte cap           → 413 session_too_large
//     - unknown ?format=                   → 200 JSON (graceful default)
//     - report Content-Disposition         → attachment; filename=*.pdf / *.json
//     - pathological-but-parseable logs    → 200 (runAudit never-throw contract)
//
//   Config B (KOLM_ED25519_DISABLE=1, no signer):
//     - run/scan requiring a signature     → 503 no_signer_configured
//     - GET /v1/audit/issuer-key           → 503 no_issuer_key
//     - run/scan with sign:false           → 200 (no signer needed)
//
// Two servers are spawned in sequence (A then B) within this single file so the
// disable flag is process-wide and cannot bleed across configs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(b, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(b + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + b);
}

// Spawn a fully-seeded server with the supplied extra env. Returns the handle.
async function bootServer(extraEnv, tag) {
  const PORT = await freePort();
  const b = `http://127.0.0.1:${PORT}`;
  const scratchDir = path.join(os.tmpdir(), `kolm-audit-ep-${tag}-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const tenantId = `t_audit_ep_${tag}`;
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: tenantId, name: `audit-ep-${tag}`, email: `audit-ep-${tag}@example.com`, plan: 'enterprise', quota: 200_000_000, seats: 1, created_at: new Date().toISOString() },
  ]), 'utf8');

  const apiKey = `ks_audit_ep_${tag}_key_dddddddddddddddddddddddddddd`;
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: `apik_audit_ep_${tag}`, tenant_id: tenantId, hash: keyHash, label: `audit-ep-${tag}`, kind: 'user', created_at: new Date().toISOString(), revoked_at: null },
  ]), 'utf8');

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      DEFAULT_TENANT: `audit-ep-${tag}`,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForHealth(b);
  return { proc, base: b, apiKey, scratchDir };
}

// ===========================================================================
// CONFIG A — signer ENABLED (server mints + caches a key under KOLM_DATA_DIR).
// ===========================================================================
let A = null;
const authA = (extra = {}) => ({ Authorization: `Bearer ${A.apiKey}`, ...extra });

// Create a session and (optionally) ingest the fixture. Returns the session id.
async function newSessionA({ ingest = true } = {}) {
  const r = await fetch(A.base + '/v1/audit/sessions', {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ subject: 'error-path session', source: 'litellm' }),
  });
  assert.equal(r.status, 201, 'session created');
  const id = (await r.json()).audit.id;
  if (ingest) {
    const logs = fs.readFileSync(FIXTURE, 'utf8');
    const ir = await fetch(`${A.base}/v1/audit/sessions/${id}/ingest`, {
      method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ logs }),
    });
    assert.equal(ir.status, 200, 'fixture ingested');
  }
  return id;
}

test('setup A — boot server with a signer enabled', async () => {
  A = await bootServer({}, 'a');
});

test('run with sign:false returns an unsigned 200 (no signature minted)', async () => {
  const id = await newSessionA();
  const r = await fetch(`${A.base}/v1/audit/sessions/${id}/run`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sign: false }),
  });
  assert.equal(r.status, 200, 'run succeeds without signing');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, false, 'no signature was produced');
  assert.equal(j.report_id, null, 'no report id when unsigned');
  assert.equal(j.key_fingerprint, null, 'no fingerprint when unsigned');
  assert.ok(j.summary, 'the analysis summary is still returned');

  // And the stored session reflects "complete, but no fetchable report".
  const sr = await fetch(`${A.base}/v1/audit/sessions/${id}`, { headers: authA() });
  const sj = await sr.json();
  assert.equal(sj.audit.status, 'complete', 'session is marked complete');
  assert.equal(sj.audit.has_report, false, 'no report stored for an unsigned run');

  // Fetching the (absent) report is a clean 409, not a 500.
  const rep = await fetch(`${A.base}/v1/audit/sessions/${id}/report`, { headers: authA() });
  assert.equal(rep.status, 409, 'no report to fetch after an unsigned run');
  assert.equal((await rep.json()).error, 'report_not_ready');
});

test('scan with sign:false returns 200 with report:null but still persists', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${A.base}/v1/audit/scan`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs, subject: 'unsigned scan', sign: false }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, false, 'unsigned');
  assert.equal(j.report, null, 'no envelope when unsigned');
  assert.equal(j.report_id, null);
  assert.ok(j.id, 'session still persisted by default');
  assert.ok(j.summary, 'summary present');
});

test('scan with persist:false returns the report inline but stores no session', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${A.base}/v1/audit/scan`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs, subject: 'ephemeral scan', persist: false }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true, 'signer enabled → signed');
  assert.equal(j.id, null, 'persist:false → nothing stored, no id');
  assert.ok(j.report, 'the signed envelope is still returned inline');
  assert.equal(j.report.schema, 'kolm-audit-report-1');
});

test('GET report before run returns 409 report_not_ready', async () => {
  const id = await newSessionA(); // ingested, but NOT run
  const r = await fetch(`${A.base}/v1/audit/sessions/${id}/report`, { headers: authA() });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'report_not_ready');
});

test('ingest over the per-session record cap returns 413 too_many_records', async () => {
  const id = await newSessionA({ ingest: false });
  // 20001 minimal records in one call (cap is 20000). Each ~9 bytes serialized,
  // so the whole array stays well under the 4mb express body limit.
  const many = Array.from({ length: 20001 }, (_, i) => ({ i }));
  const r = await fetch(`${A.base}/v1/audit/sessions/${id}/ingest`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: many }),
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'too_many_records');
});

test('scan over the record cap returns 413 too_many_records', async () => {
  const many = Array.from({ length: 20001 }, (_, i) => ({ i }));
  const r = await fetch(`${A.base}/v1/audit/scan`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: many }),
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'too_many_records');
});

test('ingest over the per-session byte cap returns 413 session_too_large', async () => {
  // Few records, each carrying a multi-MB blob, so the byte ceiling (24 MiB)
  // is reached long before the 20k record ceiling. Each request stays under the
  // 4mb express body limit; we loop until the cap fires (defensive bound on the
  // iteration count so a regression can't spin forever).
  const id = await newSessionA({ ingest: false });
  const BLOB = 3_400_000; // ~3.4 MiB per record; ~8 of these crosses 24 MiB
  let hit = null;
  for (let i = 0; i < 12; i++) {
    const record = { request_id: `big${i}`, model: 'openai/gpt-4o', blob: 'a'.repeat(BLOB) };
    const r = await fetch(`${A.base}/v1/audit/sessions/${id}/ingest`, {
      method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ logs: record }),
    });
    if (r.status === 200) continue;
    hit = { status: r.status, body: await r.json() };
    break;
  }
  assert.ok(hit, 'the byte cap eventually fires');
  assert.equal(hit.status, 413, 'byte cap is a 413');
  assert.equal(hit.body.error, 'session_too_large');
});

test('unknown ?format= falls back to the JSON envelope (graceful, not an error)', async () => {
  const id = await newSessionA();
  const run = await fetch(`${A.base}/v1/audit/sessions/${id}/run`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }), body: '{}',
  });
  assert.equal(run.status, 200);

  const r = await fetch(`${A.base}/v1/audit/sessions/${id}/report?format=totally-unknown`, { headers: authA() });
  assert.equal(r.status, 200, 'an unrecognized format is served as JSON, not rejected');
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  const env = await r.json();
  assert.equal(env.schema, 'kolm-audit-report-1', 'the default deliverable is the JSON envelope');
});

test('report responses carry a download Content-Disposition (json + pdf)', async () => {
  const id = await newSessionA();
  await fetch(`${A.base}/v1/audit/sessions/${id}/run`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }), body: '{}',
  });

  const j = await fetch(`${A.base}/v1/audit/sessions/${id}/report?format=json`, { headers: authA() });
  assert.equal(j.status, 200);
  assert.match(j.headers.get('content-disposition') || '', /attachment; filename=".*\.json"/, 'json downloads as *.json');

  const p = await fetch(`${A.base}/v1/audit/sessions/${id}/report?format=pdf`, { headers: authA() });
  assert.equal(p.status, 200);
  assert.match(p.headers.get('content-disposition') || '', /attachment; filename=".*\.pdf"/, 'pdf downloads as *.pdf');
});

test('pathological-but-parseable logs still 200 (runAudit never-throw contract)', async () => {
  // runAudit is designed never to throw; the 422 audit_failed branch exists as a
  // guard, but a hostile-yet-parseable export must be ABSORBED, not surfaced as a
  // 422/500. Feed a spread of degenerate record shapes and assert a clean 200.
  const weird = [
    {},
    { messages: null },
    { request_id: 123, model: 456, user: ['not', 'a', 'string'] },
    { nested: { a: { b: { c: { d: { e: 1 } } } } } },
    { messages: [{ role: 'user', content: 'x'.repeat(40000) }] },
    { tools: 'not-an-array', timestamp: 'not-a-date', latency_ms: 'NaN' },
    { '🙂': '🚀', unicode: 'naïve café — 日本語' },
  ];
  const r = await fetch(`${A.base}/v1/audit/scan`, {
    method: 'POST', headers: authA({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: weird, subject: 'pathological', persist: false }),
  });
  assert.equal(r.status, 200, 'degenerate logs are absorbed, not turned into a 422/500');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.summary, 'an analysis summary is still produced');
});

test('teardown A', async () => {
  await killAndWait(A.proc);
  rmSyncBestEffort(A.scratchDir);
});

// ===========================================================================
// CONFIG B — signer DISABLED (KOLM_ED25519_DISABLE=1). The product must FAIL
// CLOSED on any path that promises a signature, and say so cleanly.
// ===========================================================================
let B = null;
const authB = (extra = {}) => ({ Authorization: `Bearer ${B.apiKey}`, ...extra });

async function newSessionB() {
  const r = await fetch(B.base + '/v1/audit/sessions', {
    method: 'POST', headers: authB({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ subject: 'no-signer session' }),
  });
  assert.equal(r.status, 201);
  const id = (await r.json()).audit.id;
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const ir = await fetch(`${B.base}/v1/audit/sessions/${id}/ingest`, {
    method: 'POST', headers: authB({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs }),
  });
  assert.equal(ir.status, 200);
  return id;
}

test('setup B — boot server with KOLM_ED25519_DISABLE=1', async () => {
  B = await bootServer({ KOLM_ED25519_DISABLE: '1' }, 'b');
});

test('run requiring a signature returns 503 no_signer_configured', async () => {
  const id = await newSessionB();
  const r = await fetch(`${B.base}/v1/audit/sessions/${id}/run`, {
    method: 'POST', headers: authB({ 'Content-Type': 'application/json' }), body: '{}',
  });
  assert.equal(r.status, 503, 'fail closed — no signer, no signed report');
  assert.equal((await r.json()).error, 'no_signer_configured');
});

test('scan requiring a signature returns 503 no_signer_configured', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${B.base}/v1/audit/scan`, {
    method: 'POST', headers: authB({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs, subject: 'no-signer scan' }),
  });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'no_signer_configured');
});

test('GET /v1/audit/issuer-key returns 503 no_issuer_key when no signer exists', async () => {
  const r = await fetch(`${B.base}/v1/audit/issuer-key`);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'no_issuer_key');
});

test('with no signer, sign:false paths still succeed (no signature required)', async () => {
  // The disable flag must not break the explicitly-unsigned flow — only the
  // paths that promise a signature fail closed.
  const id = await newSessionB();
  const run = await fetch(`${B.base}/v1/audit/sessions/${id}/run`, {
    method: 'POST', headers: authB({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sign: false }),
  });
  assert.equal(run.status, 200, 'unsigned run works even with the signer disabled');
  assert.equal((await run.json()).signed, false);

  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const scan = await fetch(`${B.base}/v1/audit/scan`, {
    method: 'POST', headers: authB({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs, subject: 'unsigned no-signer scan', sign: false, persist: false }),
  });
  assert.equal(scan.status, 200, 'unsigned scan works even with the signer disabled');
  assert.equal((await scan.json()).signed, false);
});

test('teardown B', async () => {
  await killAndWait(B.proc);
  rmSyncBestEffort(B.scratchDir);
});
