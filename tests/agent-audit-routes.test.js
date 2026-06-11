// Agent Security-Review — /v1/audit/* route tests (spawned server).
//
// Exercises the whole HTTP surface that turns the deterministic trinity into the
// signed deliverable, against a real server.js process with a seeded tenant +
// API key:
//
//   create session → ingest logs → run+sign → status → fetch report
//   (json/html/pdf) → PUBLIC verify (no key) → tamper → verify fails
//   → one-shot /scan → auth is enforced on the private routes.
//
// Signing is left ENABLED (no KOLM_ED25519_DISABLE) so server.js mints + caches
// a signing key under KOLM_DATA_DIR/keys and the report actually signs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';
import { generateKeyPair, buildSignatureBlock, keyFingerprint } from '../src/ed25519.js';
import { canonicalizeReport } from '../src/attestation-report-builder.js';

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

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

let serverProc = null;
let base = null;
let apiKey = null;
let scratchDir = null;

// Shared across the ordered tests below.
let sessionId = null;
let runSummary = null;
let fetchedEnvelope = null;

function auth(extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

test('setup — boot server with a seeded tenant + key', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-audit-routes-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const tenantId = 't_audit_routes';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: tenantId, name: 'audit-routes', email: 'audit-routes@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: new Date().toISOString() },
  ]), 'utf8');

  apiKey = 'ks_audit_routes_smoke_key_dddddddddddddddddddddddddddd';
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_audit_routes', tenant_id: tenantId, hash: keyHash, label: 'audit-routes', kind: 'user', created_at: new Date().toISOString(), revoked_at: null },
  ]), 'utf8');

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
      DEFAULT_TENANT: 'audit-routes',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

test('POST /v1/audit/sessions requires auth (401 without a key)', async () => {
  const r = await fetch(base + '/v1/audit/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  // The global auth middleware hard-rejects a non-public route before the
  // handler runs (the route is NOT in PUBLIC_API), so the body shape is the
  // middleware's, not the handler's — assert the 401 + that it is an error.
  assert.equal(r.status, 401, 'no key → 401');
  const j = await r.json().catch(() => ({}));
  assert.ok(j.ok === false || j.error || j.message, 'response signals an auth error');
});

test('POST /v1/audit/sessions creates an open session (201)', async () => {
  const r = await fetch(base + '/v1/audit/sessions', {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ subject: 'Helpwise — support & billing', source: 'litellm' }),
  });
  assert.equal(r.status, 201, 'session created');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.audit.id && j.audit.id.startsWith('audses_'), 'session id minted');
  assert.equal(j.audit.status, 'open');
  assert.equal(j.audit.subject, 'Helpwise — support & billing');
  assert.equal(j.audit.record_count, 0);
  sessionId = j.audit.id;
});

test('POST /v1/audit/sessions/:id/ingest accepts log records', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/ingest`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.accepted >= 5, 'all fixture records accepted');
  assert.equal(j.record_count, j.accepted, 'count reflects this ingest');
});

test('ingest accumulates across calls (JSONL text concatenation is valid)', async () => {
  // A second, single-record ingest must add to the running count rather than
  // overwrite — proving the text-accumulation strategy.
  const one = JSON.stringify({ request_id: 'extra1', timestamp: '2026-05-09T00:00:00Z', model: 'openai/gpt-4o', user: 'support-agent', messages: [{ role: 'user', content: 'hi' }] });
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/ingest`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: one }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.accepted, 1, 'one more record accepted');
  assert.ok(j.record_count >= 6, 'running count grows, not resets');
});

test('ingest with no parseable records returns 400', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/ingest`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: '   \n  \n' }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'no_records');
});

test('POST /v1/audit/sessions/:id/run produces a signed report', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/run`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: '{}',
  });
  assert.equal(r.status, 200, 'run succeeds (signer configured at boot)');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true, 'report is signed');
  assert.ok(j.report_id && j.report_id.startsWith('asrr_'));
  assert.ok(j.key_fingerprint, 'key fingerprint returned');
  assert.ok(j.summary, 'summary returned');
  assert.equal(j.summary.readiness_pct, 0, 'dogfood fixture is 0% ready');
  assert.ok(j.summary.blocking_count >= 1, 'blocking findings present');
  assert.ok(j.verify_url.endsWith('/verify'), 'verify url points at the public verifier');
  runSummary = j.summary;
});

test('GET /v1/audit/sessions/:id reports complete status + summary, no raw logs', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}`, { headers: auth() });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.audit.status, 'complete');
  assert.equal(j.audit.has_report, true);
  assert.ok(j.audit.report_id);
  assert.equal(j.audit.summary.blocking_count, runSummary.blocking_count);
  assert.ok(!('logs' in j.audit), 'status response never carries raw logs');
});

test('GET .../report?format=json returns the bare signed envelope', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/report?format=json`, { headers: auth() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  assert.match(r.headers.get('content-disposition') || '', /attachment; filename=/);
  const env = await r.json();
  // Bare envelope — NOT an {ok:true,...} API wrapper.
  assert.ok(!('ok' in env), 'report is the bare artifact, not an API envelope');
  assert.equal(env.schema, 'kolm-audit-report-1');
  assert.ok(env.signature_ed25519 && env.signature_ed25519.signature, 'carries its signature');
  assert.ok(env.signature_ed25519.public_key.includes('BEGIN PUBLIC KEY'), 'embeds its public key (offline-verifiable)');
  assert.ok(!('events' in env), 'no raw events in the deliverable');
  assert.ok(!JSON.stringify(env).includes('401-55-9823'), 'no raw PII from logs leaks');
  fetchedEnvelope = env;
});

test('GET .../report?format=html returns a rendered HTML document', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/report?format=html`, { headers: auth() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text();
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('Agent Security-Review Readiness Report'));
  assert.ok(html.includes('Scope &amp; limitations'));
  assert.ok(!html.toLowerCase().includes('honest'), 'no "honest"/"honesty" in the rendered report');
});

test('GET .../report?format=pdf streams a valid PDF', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/report?format=pdf`, { headers: auth() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/pdf/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 800, 'PDF has real content');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'PDF magic header');
});

test('POST /v1/audit/report/verify is PUBLIC and confirms a real report', async () => {
  // No Authorization header — a buyer's reviewer has no kolm account.
  const r = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: fetchedEnvelope }),
  });
  assert.equal(r.status, 200, 'public route reachable without a key');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.verify.ok, true, 'a genuine report verifies (tier 1)');
  assert.ok(j.verify.key_fingerprint, 'verifier reports the signing key fingerprint');
  // Tier 2 — the report was signed by the server's live signer, so it is a
  // recognized issuer and the combined verdict is trusted.
  assert.equal(j.issuer.recognized, true, 'embedded key is recognized (tier 2)');
  assert.equal(j.issuer.matches_live_signer, true, 'and it is the live signer key');
  assert.equal(j.trusted, true, 'combined verdict: trusted');
});

test('public verify accepts a bare envelope body too', async () => {
  const r = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fetchedEnvelope),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verify.ok, true, 'bare envelope (no {report:} wrapper) also verifies');
});

test('public verify REJECTS a tampered report (200 with verify.ok=false)', async () => {
  const tampered = JSON.parse(JSON.stringify(fetchedEnvelope));
  tampered.summary.readiness_pct = 100; // forge a passing grade
  const r = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: tampered }),
  });
  assert.equal(r.status, 200, 'HTTP is 200 — the verdict lives in verify.ok');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.verify.ok, false, 'a forged readiness number fails verification');
  assert.ok(j.verify.reason, 'a reason is given');
});

test('public verify catches a rogue-signed forgery: verify.ok=true but trusted=false', async () => {
  // The attack the issuer-provenance tier defends against: edit the headline a
  // buyer reads, then re-sign the edited bytes with a freshly-minted rogue key.
  // Tier 1 (signature integrity) PASSES — the bytes really are validly signed.
  // Tier 2 (issuer provenance) must catch it: the rogue key is not one we issue.
  const forged = JSON.parse(JSON.stringify(fetchedEnvelope));
  forged.summary.readiness_pct = 100;
  forged.summary.blocking_count = 0;
  forged.findings = [];
  const kp = generateKeyPair();
  delete forged.signature_ed25519;
  const canonical = canonicalizeReport(forged);
  forged.signature_ed25519 = buildSignatureBlock({
    privateKey: kp.privateKey, publicKey: kp.publicKey,
    key_fingerprint: keyFingerprint(kp.publicKey),
    payloadCanonical: canonical, signed_at: forged.generated_at,
  });

  const r = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: forged }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verify.ok, true, 'tier-1 cannot distinguish a rogue-signed report — it is validly signed');
  assert.equal(j.issuer.recognized, false, 'tier-2 catches it: the rogue key is not a recognized issuer');
  assert.equal(j.trusted, false, 'combined verdict: NOT trusted — this is the forgeable-verify fix');
});

test('public verify with a non-report body returns 400', async () => {
  const r = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'report_required');
});

test('ingest into a completed session is refused (409)', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionId}/ingest`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: '{"request_id":"late","model":"x"}' }),
  });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, 'session_closed');
});

test('GET report for an unknown session returns 404', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_doesnotexist/report`, { headers: auth() });
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'session_not_found');
});

test('POST /v1/audit/scan one-shot returns a signed report inline', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs, subject: 'One-shot scan', source: 'litellm' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true);
  assert.ok(j.report, 'full envelope returned inline');
  assert.equal(j.report.schema, 'kolm-audit-report-1');
  assert.ok(j.id, 'scan persists a session by default');
  assert.ok(j.summary.blocking_count >= 1);

  // The inline envelope must itself verify through the public route.
  const v = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: j.report }),
  });
  const vj = await v.json();
  assert.equal(vj.verify.ok, true, 'the one-shot report verifies');
});

test('POST /v1/audit/scan without logs returns 400', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: '{}',
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'logs_required');
});

test('GET /v1/audit/issuer-key is PUBLIC and advertises the live report-signing key', async () => {
  // No Authorization header — a buyer (or the /verify trusted-issuer keyring)
  // pins against this authoritative source instead of trusting whatever key a
  // pasted report embeds.
  const r = await fetch(`${base}/v1/audit/issuer-key`);
  assert.equal(r.status, 200, 'public route reachable without a key');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.alg, 'ed25519');
  assert.equal(j.spec, 'kolm-ed25519-v1');
  assert.ok(j.public_key.includes('BEGIN PUBLIC KEY'), 'returns a PEM public key');
  assert.ok(/^[0-9a-f]{32}$/.test(j.key_fingerprint), 'returns a 128-bit hex fingerprint');
  assert.ok(!j.public_key.includes('PRIVATE'), 'never leaks the private half');

  // The advertised key MUST be the one reports are actually signed with — else
  // pinning against it is meaningless. Compare to a fresh scan report's key.
  const scan = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: fs.readFileSync(FIXTURE, 'utf8'), subject: 'issuer-key check', persist: false }),
  });
  const sj = await scan.json();
  assert.equal(sj.signed, true);
  const norm = (s) => String(s).replace(/\s+/g, '');
  assert.equal(norm(sj.report.signature_ed25519.public_key), norm(j.public_key), 'issuer-key endpoint advertises the actual report-signing key');
  assert.equal(sj.report.signature_ed25519.key_fingerprint, j.key_fingerprint, 'fingerprints match too');
});

test('hostile retention_days values are clamped, never crash the scan', async () => {
  // _clampRetentionDays must absorb garbage (negative, absurdly large, non-finite,
  // wrong-typed) so it never reaches the analyzer as a poison value. Observable
  // contract: the scan still returns 200 with a signed report.
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  for (const retention_days of [-5, 0, 1e12, 9.99, 'garbage', null, true, NaN, Infinity]) {
    const r = await fetch(`${base}/v1/audit/scan`, {
      method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ logs, subject: 'retention clamp', persist: false, retention_days }),
    });
    assert.equal(r.status, 200, `retention_days=${String(retention_days)} → 200`);
    const j = await r.json();
    assert.equal(j.ok, true, `retention_days=${String(retention_days)} → ok`);
    assert.equal(j.signed, true, `retention_days=${String(retention_days)} → still signs`);
  }
});

test('scan accepts allowed_hosts and a coverage_declaration; both are bound into the signed report', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const coverage_declaration = {
    window_start: '2026-02-01T00:00:00Z',
    window_end: '2026-04-30T00:00:00Z',
    systems: ['litellm-gateway-prod'],
    expected_calls_per_day: 500,
    attestor: { name: 'A. Vendor', email: 'platform@example.com' },
  };
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      logs, subject: 'Declared scan', source: 'litellm', persist: false,
      allowed_hosts: ['api.openai.com', 'Internal.example.COM '], // mixed case + padding normalize
      coverage_declaration,
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.signed, true);
  const decl = j.report.coverage_declaration;
  assert.ok(decl, 'declaration bound inside the signed envelope');
  assert.equal(decl.version, 'asr-coverage-declaration/0.1');
  assert.equal(decl.attestor.name, 'A. Vendor');
  assert.ok(
    j.report.caveats.some((c) => c.includes('Coverage declared by A. Vendor')),
    'declaration caveat is in the signed caveats',
  );
  assert.ok(
    !j.report.caveats.some((c) => c.includes('No coverage declaration was supplied')),
    'the no-declaration caveat is replaced by the declaration',
  );

  // The envelope (declaration included) verifies through the public route, and
  // editing the declaration after the fact breaks the signature.
  const v = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: j.report }),
  });
  assert.equal((await v.json()).verify.ok, true, 'declared report verifies');
  const tampered = JSON.parse(JSON.stringify(j.report));
  tampered.coverage_declaration.window_end = '2027-12-31T00:00:00.000Z';
  const tv = await fetch(`${base}/v1/audit/report/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: tampered }),
  });
  assert.equal((await tv.json()).verify.ok, false, 'a widened declared window after signing fails verification');
});

test('a vendor-tier scan WITHOUT a declaration says so in the signed caveats', async () => {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs, subject: 'Undeclared scan', source: 'litellm', persist: false }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(
    j.report.caveats.some((c) => c.includes('No coverage declaration was supplied')),
    'absence of a declaration is stated on the record',
  );
});

test('session run accepts allowed_hosts + coverage_declaration through the same plumbing', async () => {
  // Fresh session (the shared one is complete).
  const cr = await fetch(base + '/v1/audit/sessions', {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ subject: 'Declared session', source: 'litellm' }),
  });
  assert.equal(cr.status, 201);
  const id = (await cr.json()).audit.id;
  const ir = await fetch(`${base}/v1/audit/sessions/${id}/ingest`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ logs: fs.readFileSync(FIXTURE, 'utf8') }),
  });
  assert.equal(ir.status, 200);
  const r = await fetch(`${base}/v1/audit/sessions/${id}/run`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      allowed_hosts: ['api.openai.com'],
      coverage_declaration: {
        window_start: '2026-02-01T00:00:00Z', window_end: '2026-04-30T00:00:00Z',
        systems: ['litellm-gateway-prod'], attestor: { name: 'A. Vendor' },
      },
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.signed, true);
  const rep = await fetch(`${base}/v1/audit/sessions/${id}/report?format=json`, { headers: auth() });
  const env = await rep.json();
  assert.ok(env.coverage_declaration, 'stored session report carries the declaration');
  assert.equal(env.coverage_declaration.attestor.name, 'A. Vendor');
});

test('teardown', async () => {
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
});
