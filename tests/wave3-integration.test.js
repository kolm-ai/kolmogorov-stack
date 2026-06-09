// Agent Security-Review - Wave-3 integration tests.
//
// Locks the Wave-3 wiring that completes the "signed + timestamped + witnessed"
// story and the Trust Center / questionnaire surfaces:
//
//   1. CREDIBILITY WIRING
//      * signReport anchors EVERY signed report (free Scan AND paid Report) in the
//        append-only transparency log, in line, so a delivered report always
//        carries a log_checkpoint bound to the SIGNED digest. It is detached
//        evidence (excluded from the signed bytes), so it never breaks verify.
//      * the PAID report additionally carries an RFC 3161 trusted timestamp over
//        the same signed digest (offline-safe), and still verifies.
//      * attachPaidTimestamp: the self-issue path is deterministic + timestamped;
//        the external-TSA path degrades to status:'offline' with no TSA reachable;
//        neither breaks the Ed25519 signature.
//
//   2. TRUST CENTER (spawned server)
//      * GET /v1/trust/:slug serves the report AND records a (pseudonymous) view.
//      * GET /v1/trust/:slug/views is auth-gated + tenant-fenced (a non-owner 404s).
//      * POST /v1/trust/:slug/unlock is PUBLIC and mints an unlock token.
//
//   3. QUESTIONNAIRE
//      * autofill cites report evidence and never asserts an unsupported 'yes'.
//      * GET /v1/trust/:slug/questionnaire is PUBLIC (same capability as the
//        report); POST /v1/audit/sessions/:id/questionnaire is auth-gated.
//
// The in-process block runs against an isolated JSON store (env set before any
// store-touching import); the HTTP block boots a real server.js with a seeded
// tenant + a pre-published paid Trust Link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

// --- isolate the in-process JSON store + guarantee no external TSA network -----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wave3-test-'));
process.env.KOLM_DATA_DIR = dir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
delete process.env.KOLM_TSA_URL; // the paid path must use only the sync self baseline here

const { insert, findOne } = await import('../src/store.js');
const { runAudit } = await import('../src/audit-orchestrator.js');
const {
  buildAndSignReport, resignAsTier, verifyReport, canonicalizeReport,
} = await import('../src/attestation-report-builder.js');
const {
  fulfillReportPurchase, attachPaidTimestamp, resolveTrust,
} = await import('../src/asr-fulfillment.js');
const { autofillQuestionnaire, toQuestionnaireCsv } = await import('../src/questionnaire-autofill.js');
const { generateKeyPair, keyFingerprint } = await import('../src/ed25519.js');

function signerFrom(kp) {
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, key_fingerprint: keyFingerprint(kp.publicKey) };
}
function signedDigest(env) {
  return crypto.createHash('sha256').update(canonicalizeReport(env), 'utf8').digest('hex');
}

// A small synthetic export: a wildcard-granted destructive call (ASR-1 finding),
// no hash chain (ASR-2), and NO retrieval / delegation (ASR-7 / ASR-8 untested).
const LOGS = [
  { ts: '2026-06-01T00:00:00Z', agent: 'a1', tool: 'http.get', action: 'call', actor: 'a1', event_id: 'e1' },
  { ts: '2026-06-01T00:00:01Z', agent: 'a1', tool: 'db.delete', action: 'call', actor: 'a1', event_id: 'e2', grants: ['*'] },
].map((r) => JSON.stringify(r)).join('\n');

// ===========================================================================
// 1) CREDIBILITY WIRING (in-process)
// ===========================================================================
test('every signed report is anchored in the transparency log, bound to the signed digest', () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Acme', tier: 'scan', signer: signerFrom(generateKeyPair()) });
  const env = scan.envelope;

  // The free Scan carries a log_checkpoint even though it is a watermarked preview.
  assert.equal(env.tier, 'scan');
  assert.equal(env.watermark, true);
  assert.ok(env.log_checkpoint && typeof env.log_checkpoint === 'object', 'scan report carries a transparency-log checkpoint');
  assert.ok(/^[0-9a-f]{64}$/.test(env.log_checkpoint.root_hash), 'checkpoint has a well-formed Merkle root');
  assert.ok(Number.isFinite(Number(env.log_checkpoint.tree_size)) && Number(env.log_checkpoint.tree_size) >= 1, 'tree_size is a real count');

  // The checkpoint references the SIGNED report digest (sha256 of the canonical
  // signed bytes), so it is bound to this exact report.
  assert.equal(env.log_checkpoint.report_digest, signedDigest(env), 'checkpoint binds the signed report digest');

  // Detached evidence must NOT break the signature.
  assert.equal(verifyReport(env).ok, true, 'a report carrying a log_checkpoint still verifies');

  // verifyReport surfaces the checkpoint (parity with the browser verifier).
  const surfaced = verifyReport(env).checks.find((c) => c.name === 'transparency-log checkpoint present');
  assert.ok(surfaced && surfaced.ok === true, 'verifyReport surfaces the transparency-log checkpoint');
});

test('a fulfilled paid report additionally carries a trusted timestamp and still verifies', () => {
  const TENANT = 'tenant_wave3_paid';
  const audit = runAudit(LOGS, { source: 'import' });
  const signer = signerFrom(generateKeyPair());
  const scan = buildAndSignReport(audit, { subject: 'Acme agents', tier: 'scan', signer });
  const AUDIT_ID = 'audses_wave3paid';
  insert('agent_audits', {
    id: AUDIT_ID, tenant_id: TENANT, subject: 'Acme agents', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  });

  // The free scan stays un-timestamped (it must not block on a TSA at scan time).
  assert.ok(!('timestamp_evidence' in scan.envelope), 'the free scan is not timestamped');

  const fr = fulfillReportPurchase({ audit_id: AUDIT_ID, signer });
  assert.ok(fr.ok, 'fulfillment returns synchronously');
  assert.ok(!fr.timestamp, 'no async external-TSA upgrade fires without KOLM_TSA_URL (no dangling)');

  const row = findOne('agent_audits', (r) => r.id === AUDIT_ID);
  assert.equal(row.report.tier, 'report');
  assert.equal(row.report.watermark, false);

  const te = row.report.timestamp_evidence;
  assert.ok(te && typeof te === 'object', 'paid report carries timestamp_evidence');
  assert.ok(te.status === 'timestamped' || te.status === 'offline', 'timestamp status is timestamped or offline');
  assert.equal(String(te.message_imprint), signedDigest(row.report), 'timestamp binds the signed report digest');

  // Detached timestamp + checkpoint do not break the signature.
  assert.equal(verifyReport(row.report).ok, true, 'the paid, timestamped report still verifies');
  assert.ok(row.report.log_checkpoint && row.report.log_checkpoint.report_digest === signedDigest(row.report), 'paid report stays anchored in the transparency log');
});

test('attachPaidTimestamp: self-issue is timestamped; external-TSA degrades to offline; both keep verify green', async () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const signer = signerFrom(generateKeyPair());

  // Deterministic, offline self-issued RFC 3161 token.
  const a = buildAndSignReport(audit, { subject: 'self', tier: 'report', signer }).envelope;
  await attachPaidTimestamp(a, { selfIssueTimestamp: true });
  assert.ok(a.timestamp_evidence && a.timestamp_evidence.status === 'timestamped', 'self-issue yields a timestamped token');
  assert.equal(a.timestamp_evidence.source, 'self');
  assert.equal(String(a.timestamp_evidence.message_imprint), signedDigest(a));
  assert.equal(verifyReport(a).ok, true, 'self-timestamped report verifies');

  // External TSA unreachable -> graceful status:'offline', never a throw.
  const b = buildAndSignReport(audit, { subject: 'offline', tier: 'report', signer }).envelope;
  await attachPaidTimestamp(b, { tsaUrl: 'http://127.0.0.1:1/nope', timeoutMs: 400 });
  assert.ok(b.timestamp_evidence && typeof b.timestamp_evidence === 'object', 'offline path still attaches evidence');
  assert.equal(b.timestamp_evidence.status, 'offline', 'unreachable TSA degrades to offline');
  assert.equal(verifyReport(b).ok, true, 'an offline-timestamp report still verifies');
});

// ===========================================================================
// 3) QUESTIONNAIRE autofill (in-process, pure)
// ===========================================================================
test('questionnaire autofill cites report evidence and never asserts an unsupported yes', () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const report = buildAndSignReport(audit, { subject: 'Acme', tier: 'report', signer: signerFrom(generateKeyPair()) }).envelope;
  const result = autofillQuestionnaire(report, { template: 'generic-ai-vendor' });

  assert.equal(result.template, 'generic-ai-vendor');
  assert.equal(result.answers.length, 10, 'the generic template has 10 questions');

  for (const a of result.answers) {
    assert.ok(['yes', 'no', 'partial', 'n/a'].includes(a.answer), `answer is a known verdict (${a.answer})`);
    assert.ok(Array.isArray(a.evidence) && a.evidence.length >= 1, `every answer cites evidence (${a.question_id})`);
    if (a.answer === 'yes') {
      // A 'yes' must be backed by a cited PASS control - never invented.
      assert.ok(a.evidence.some((e) => e && e.asr), `a yes cites a control (${a.question_id})`);
      assert.ok(a.evidence.some((e) => e && /PASS/.test(String(e.detail))), `a yes is backed by a PASS in the report (${a.question_id})`);
    }
  }

  // ASR-6 (verifiable evidence) is a clean PASS on a signed report -> 'yes'.
  const ev = result.answers.find((a) => a.question_id === 'gen-evidence-verifiable');
  assert.equal(ev.answer, 'yes', 'a signed, verifiable report answers the evidence question yes');
  assert.ok(ev.evidence.some((e) => e && e.asr === 'ASR-6'));

  // No retrieval/memory and no delegation in this export -> ASR-7 / ASR-8 are
  // untested, so those questions are 'n/a', never an inflated pass.
  const mem = result.answers.find((a) => a.question_id === 'gen-memory-retrieval');
  assert.equal(mem.answer, 'n/a', 'an unassessed control answers n/a (not yes)');

  // CSV export is ASCII, header-first, never throws.
  const csv = toQuestionnaireCsv(result);
  assert.match(csv, /^template,report_id,question_id,question,answer,confidence,asr,evidence\r\n/);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x09\x0A\x0D\x20-\x7E]/.test(csv), 'questionnaire CSV is pure ASCII');
});

// ===========================================================================
// 2) TRUST CENTER + questionnaire routes (spawned server)
// ===========================================================================
const ROOT = path.resolve(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForHealth(b, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(b + '/health'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + b);
}

let serverProc = null;
let base = null;
let scratchDir = null;
const TENANT_A = 't_wave3_owner';
const TENANT_B = 't_wave3_other';
const KEY_A = 'ks_wave3_owner_key_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'ks_wave3_other_key_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const SLUG = 'wave3trustslug0001';

test('setup - boot server with a seeded tenant + a published paid Trust Link', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-wave3-srv-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: TENANT_A, name: 'owner', email: 'owner@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
    { id: TENANT_B, name: 'other', email: 'other@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const keyHash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_a', tenant_id: TENANT_A, hash: keyHash(KEY_A), label: 'owner', kind: 'user', created_at: now, revoked_at: null },
    { id: 'apik_b', tenant_id: TENANT_B, hash: keyHash(KEY_B), label: 'other', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  // Pre-publish a PAID, public Trust Link owned by TENANT_A. Built in-process
  // (its own keypair); the server only resolves + renders + logs views over it.
  const seedAudit = runAudit(LOGS, { source: 'import' });
  const seedSigner = signerFrom(generateKeyPair());
  const seedScan = buildAndSignReport(seedAudit, { subject: 'Beacon Robotics agents', tier: 'scan', signer: seedSigner });
  const seedReport = resignAsTier(seedScan.envelope, 'report', seedSigner);
  await attachPaidTimestamp(seedReport, { selfIssueTimestamp: true });
  fs.writeFileSync(path.join(dataDir, 'agent_audits.json'), JSON.stringify([{
    id: 'audses_wave3seed', tenant_id: TENANT_A, subject: 'Beacon Robotics agents', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: seedReport, report_id: seedReport.report_id, summary: seedAudit.summary,
    paid: true, tier: 'report', public: true, public_slug: SLUG,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  }]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
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
      KOLM_TSA_URL: '',
      DEFAULT_TENANT: 'owner',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

test('GET /v1/trust/:slug (PUBLIC) serves the report and records a view', async () => {
  // No Authorization header - the buyer has no kolm account; possession of the
  // slug is the grant.
  const r = await fetch(`${base}/v1/trust/${SLUG}`, { headers: { 'User-Agent': 'wave3-buyer/1.0', Referer: 'https://buyer.example.com/review' } });
  assert.equal(r.status, 200, 'public Trust Link reachable without a key');
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text();
  assert.ok(html.includes('Agent Security-Review Readiness Report'), 'renders the signed report');

  // JSON form resolves too.
  const j = await (await fetch(`${base}/v1/trust/${SLUG}?format=json`)).json();
  assert.equal(j.tier, 'report');
  assert.equal(j.watermark, false);

  // The owner can now see the view(s) we just generated.
  const v = await fetch(`${base}/v1/trust/${SLUG}/views`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert.equal(v.status, 200);
  const vj = await v.json();
  assert.equal(vj.ok, true);
  assert.ok(vj.summary.views >= 2, 'both views were recorded');
  assert.ok(vj.summary.unique_viewers >= 1, 'at least one distinct viewer');
  // The raw IP is never returned; only a hashed viewer id.
  assert.ok(vj.views.every((row) => !('ip' in row) && (row.viewer_hash == null || /^[0-9a-f]{64}$/.test(row.viewer_hash))), 'views expose only a hashed viewer id, never a raw IP');
});

test('GET /v1/trust/:slug/views is auth-gated and tenant-fenced', async () => {
  // No key -> 401 (the route is NOT in PUBLIC_API).
  const anon = await fetch(`${base}/v1/trust/${SLUG}/views`);
  assert.equal(anon.status, 401, 'views require auth');

  // A DIFFERENT tenant -> 404 (we never confirm another tenant's link exists).
  const other = await fetch(`${base}/v1/trust/${SLUG}/views`, { headers: { Authorization: `Bearer ${KEY_B}` } });
  assert.equal(other.status, 404, 'a non-owner cannot read another tenant views');

  // The owner -> 200.
  const owner = await fetch(`${base}/v1/trust/${SLUG}/views`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert.equal(owner.status, 200, 'the owner can read their own views');
});

test('GET /v1/trust/:slug/questionnaire (PUBLIC) returns cited answers + CSV', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG}/questionnaire?template=generic-ai-vendor`);
  assert.equal(r.status, 200, 'public questionnaire reachable without a key');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.template, 'generic-ai-vendor');
  assert.ok(Array.isArray(j.answers) && j.answers.length === 10);
  assert.ok(j.answers.every((a) => Array.isArray(a.evidence) && a.evidence.length >= 1), 'every answer cites evidence');
  assert.ok(j.answers.every((a) => a.answer !== 'yes' || a.evidence.some((e) => e && e.asr)), 'no yes without a cited control');

  const csv = await fetch(`${base}/v1/trust/${SLUG}/questionnaire?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  const body = await csv.text();
  assert.match(body, /^template,report_id,question_id,question,answer,confidence,asr,evidence\r\n/);
});

test('POST /v1/audit/sessions/:id/questionnaire is auth-gated + tenant-fenced', async () => {
  // Create a real session (scan persists one) as TENANT_A.
  const scan = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: LOGS, subject: 'session questionnaire', source: 'test' }),
  });
  const sj = await scan.json();
  assert.equal(sj.ok, true);
  assert.ok(sj.id, 'scan persisted a session');

  // No key -> 401.
  const anon = await fetch(`${base}/v1/audit/sessions/${sj.id}/questionnaire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401, 'session questionnaire requires auth');

  // A different tenant cannot reach this tenant's session.
  const other = await fetch(`${base}/v1/audit/sessions/${sj.id}/questionnaire`, { method: 'POST', headers: { Authorization: `Bearer ${KEY_B}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(other.status, 404, 'tenant-fenced: another tenant cannot generate over this session');

  // The owner gets the autofilled questionnaire.
  const owner = await fetch(`${base}/v1/audit/sessions/${sj.id}/questionnaire?template=sig-lite`, { method: 'POST', headers: { Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(owner.status, 200);
  const oj = await owner.json();
  assert.equal(oj.ok, true);
  assert.equal(oj.template, 'sig-lite');
  assert.ok(oj.answers.length >= 1);
});

test('POST /v1/trust/:slug/unlock is PUBLIC and mints an unlock token', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG}/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reviewer@buyer.example.com', accept_terms: true }),
  });
  assert.equal(r.status, 200, 'unlock is reachable without a key');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(typeof j.token === 'string' && j.token.startsWith('tul_'), 'an unlock token is minted');
});

test('teardown', async () => {
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
