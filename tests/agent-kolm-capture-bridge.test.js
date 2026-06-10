// Agent Security-Review - the Tier-A capture bridge over HTTP (spawned server).
//
// POST /v1/audit/scan and /v1/audit/import with { "source": "kolm-capture" }
// audit the CALLING tenant's own stored gateway captures (the rows the kolm
// gateway recorded at runtime) instead of a vendor export, and the resulting
// signed report carries evidence grade A. Locks down:
//
//   - tenant fencing: only the authed tenant's captures are loaded; a foreign
//     tenant's rows never leak into the audit (record counts prove it);
//   - the empty case: a tenant with no captures gets a clean 409 no_captures;
//   - source reservation: 'kolm-capture' cannot be claimed with caller logs
//     (scan/import 400) or via sessions (400 source_reserved), so vendor logs
//     can never masquerade as first-party capture;
//   - the grade-A envelope verifies through the public verify route.
//
// Signing is REAL here: KOLM_ED25519_KEY_STORE points at the scratch home, so
// the server mints its own key and the returned envelopes carry signatures.

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

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: retry
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

const KEY_A = 'ks_g_a_' + 'a'.repeat(40);
const KEY_B = 'ks_g_b_' + 'b'.repeat(40);

let serverProc = null;
let base = null;
let scratchDir = null;

function authed(key, body) {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('setup - boot server with seeded gateway observations for tenant A', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-capbridge-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  const keyStore = path.join(scratchDir, 'keys');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(keyStore, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: 't_cap_a', name: 'cap-a', email: 'a@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
    { id: 't_cap_b', name: 'cap-b', email: 'b@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const h = (k) => crypto.createHash('sha256').update(k).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_cap_a', tenant_id: 't_cap_a', hash: h(KEY_A), label: 'a', kind: 'user', created_at: now, revoked_at: null },
    { id: 'apik_cap_b', tenant_id: 't_cap_b', hash: h(KEY_B), label: 'b', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  // Three observation rows: a cap_ text row + an rcpt_ receipt row for tenant A
  // (the two shapes the gateway records), and a third tenant's row that must
  // NEVER appear in A's audit. The receipt row carries only the tenant NAME -
  // exactly how src/router.js inserts gateway receipts.
  fs.writeFileSync(path.join(dataDir, 'observations.json'), JSON.stringify([
    {
      id: 'cap_a1', tenant: 'cap-a', tenant_id: 't_cap_a',
      model: 'openai/gpt-4o', prompt: 'Where is order 4412?',
      response: 'Order 4412 shipped yesterday.',
      tool_calls: [{ name: 'lookup_order', arguments: '{"order_id":"4412"}' }],
      corpus_namespace: 'default', created_at: now,
    },
    {
      id: 'rcpt_a2', tenant: 'cap-a', receipt_id: 'rcpt_a2',
      ts: Date.now(), model: 'gpt-4o',
      input_hash: 'sha256:' + 'c'.repeat(32), output_hash: 'sha256:' + 'd'.repeat(32),
      receipt: {
        receipt_id: 'rcpt_a2', timestamp: Date.now(), model: 'gpt-4o',
        signing_key_id: 'key_live_2',
        input_hash: 'sha256:' + 'c'.repeat(32), output_hash: 'sha256:' + 'd'.repeat(32),
        signature_ed25519: { alg: 'ed25519', signature: 'Z2F0ZXdheS1zaWduZWQ' },
      },
    },
    {
      id: 'cap_v1', tenant: 'victim-co', tenant_id: 't_victim',
      model: 'openai/gpt-4o', prompt: 'victim secret prompt',
      response: 'victim secret response', corpus_namespace: 'default', created_at: now,
    },
  ]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: home,
      KOLM_ED25519_KEY_STORE: keyStore,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1', DEFAULT_TENANT: 'cap-a',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

// ---------------------------------------------------------------------------
// the happy path - tenant A audits its own captures, grade A.
// ---------------------------------------------------------------------------

let reportA = null; // the signed envelope from the scan, re-checked via /verify

test('scan with source kolm-capture audits ONLY the calling tenant captures and grades A', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, authed(KEY_A, { source: 'kolm-capture', subject: 'Cap A fleet' }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true, 'the bridge report is signed');
  assert.equal(j.ingest.records, 2, 'exactly tenant A\'s two rows - the victim row is fenced out');
  assert.ok(j.evidence_tier, 'evidence_tier surfaced on the response');
  assert.equal(j.evidence_tier.grade, 'A');
  assert.equal(j.evidence_tier.method, 'kolm-gateway-capture');
  assert.ok(j.evidence_tier.basis.includes('gateway receipts: 1 signed at capture'), 'signed receipt counted in the basis');
  assert.ok(j.report && typeof j.report === 'object', 'envelope returned inline');
  assert.deepEqual(j.report.evidence_tier, j.evidence_tier, 'the grade is INSIDE the signed envelope');
  assert.equal(j.report.subject.source, 'kolm-capture');
  const blob = JSON.stringify(j.report);
  assert.ok(!blob.includes('victim secret'), 'no foreign tenant content anywhere in the deliverable');
  reportA = j.report;
});

test('the grade-A envelope verifies through the public verify route', async () => {
  assert.ok(reportA, 'scan produced an envelope');
  const r = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: reportA }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verify.ok, true, 'signature (covering evidence_tier) verifies');
});

test('import with source kolm-capture takes the same bridge and grades A', async () => {
  const r = await fetch(`${base}/v1/audit/import`, authed(KEY_A, { source: 'kolm-capture', subject: 'Cap A import' }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.ingest.records, 2, 'same tenant fence on the import path');
  assert.equal(j.evidence_tier.grade, 'A');
  assert.equal(j.report.evidence_tier.method, 'kolm-gateway-capture');
});

// ---------------------------------------------------------------------------
// the empty case + tenant fencing.
// ---------------------------------------------------------------------------

test('a tenant with no captures gets a clean 409 no_captures, never a crash', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, authed(KEY_B, { source: 'kolm-capture' }));
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'no_captures');
});

// ---------------------------------------------------------------------------
// source reservation - vendor logs can never claim grade A.
// ---------------------------------------------------------------------------

test('scan rejects kolm-capture WITH caller-supplied logs (400 logs_not_allowed)', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, authed(KEY_A, {
    source: 'kolm-capture',
    logs: '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"forged"}]}',
  }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'logs_not_allowed');
});

test('import rejects a kolm-capture source_label on vendor logs (400 source_label_reserved)', async () => {
  const r = await fetch(`${base}/v1/audit/import`, authed(KEY_A, {
    source: 'inline', source_label: 'kolm-capture',
    logs: '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"forged"}]}',
  }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'source_label_reserved');
});

test('sessions cannot claim the reserved source (400 source_reserved)', async () => {
  const r = await fetch(`${base}/v1/audit/sessions`, authed(KEY_A, { subject: 'Sneaky', source: 'kolm-capture' }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'source_reserved');
});

// ---------------------------------------------------------------------------
// Reserved-source NORMALIZATION attack. The grade-bearing source is stamped as
// slice(0,64) then re-trimmed downstream, so a 65-char value like
// "kolm-capture" + 52 spaces + "X" slices off the "X", trims the padding, and
// collapses back to exactly "kolm-capture" - forging a grade-A capture
// attestation over attacker-supplied VENDOR logs. The guard must test the same
// normalized form (slice(0,64) then trim) it stamps, so every entry point
// rejects the padded value instead of grading it A.
// ---------------------------------------------------------------------------

const PADDED_CAPTURE = 'kolm-capture' + ' '.repeat(52) + 'X'; // 65 chars -> slices to "kolm-capture"+52sp -> trims to "kolm-capture"

test('scan: padded reserved source + vendor logs is rejected, never graded A', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, authed(KEY_A, {
    source: PADDED_CAPTURE,
    logs: '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"forged"}]}',
  }));
  assert.equal(r.status, 400, 'the padded value normalizes to kolm-capture and is caught by the bridge guard');
  const j = await r.json();
  assert.equal(j.error, 'logs_not_allowed', 'reserved source recognized; vendor logs forbidden on the capture bridge');
});

test('import: padded reserved source_label on vendor logs is rejected (400 source_label_reserved)', async () => {
  const r = await fetch(`${base}/v1/audit/import`, authed(KEY_A, {
    source: 'inline', source_label: PADDED_CAPTURE,
    logs: '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"forged"}]}',
  }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'source_label_reserved');
});

test('sessions: padded reserved source is rejected (400 source_reserved)', async () => {
  const r = await fetch(`${base}/v1/audit/sessions`, authed(KEY_A, { subject: 'Sneaky', source: PADDED_CAPTURE }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'source_reserved');
});

test('scan: leading-whitespace reserved source + vendor logs is rejected too', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, authed(KEY_A, {
    source: '   kolm-capture',
    logs: '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"forged"}]}',
  }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'logs_not_allowed');
});

test('teardown', async () => {
  if (serverProc) await killAndWait(serverProc);
  if (scratchDir) rmSyncBestEffort(scratchDir);
});
