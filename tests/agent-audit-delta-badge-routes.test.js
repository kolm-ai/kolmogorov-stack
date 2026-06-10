// Agent Security-Review - new request-surface routes (spawned server).
//
// Locks down the two routes added in the audit-parity build that ship without
// other committed coverage:
//
//   POST /v1/audit/sessions/:id/delta?against=<id>  (AUTH, tenant-fenced)
//     - signed-report drift between two of the CALLER's own reports; a foreign
//       / unknown id is indistinguishable from absent (404), never a leak.
//   GET  /v1/trust/:slug/badge.svg                   (PUBLIC)
//     - embeddable readiness pill; an unknown slug serves the grey "n/a" badge,
//       it NEVER 500s and never needs a key.
//     - STATE-BEARING: a published report older than 30 days serves a grey
//       'stale (Month YYYY)' pill regardless of readiness; a report whose
//       issuer key is revoked in the key-revocation store serves a grey
//       'report revoked' pill that outranks both staleness and readiness.
//
// Signing stays disabled-by-seed: the delta route reads only signature-covered
// report FIELDS (summary + findings) and never re-verifies, so seeded plain
// envelopes are a faithful test of the route contract. The revoked-badge case
// seeds an envelope with a REAL Ed25519 public key (generated below) because
// the route recomputes the fingerprint from the embedded key, never trusting a
// claimed key_fingerprint field.
//
// All fixture dates are computed RELATIVE to now (days ago) so the fresh /
// stale assertions stay true forever instead of rotting past a fixed date.

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
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

const KEY_A = 'ks_g_a_' + 'a'.repeat(40);
const KEY_B = 'ks_g_b_' + 'b'.repeat(40);
const TRUST_SLUG = 'gbadgetrustslug00001';
const TRUST_SLUG_STALE = 'gbadgetrustslug00002';
const TRUST_SLUG_REVOKED = 'gbadgetrustslug00003';

let serverProc = null;
let base = null;
let scratchDir = null;

// Relative dates: the badge freshness window is 30 days, so "9 days ago" is
// always fresh and "45/60 days ago" is always stale - no fixed-date rot.
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// The English month-year the badge renders for a stale report, computed the
// same way the route does (UTC month of generated_at).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function monthYearOf(iso) {
  const d = new Date(iso);
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

// Two reports for tenant A: prior (R1, readiness 20, ASR-1 blocking, one open
// high finding) and current (R2, readiness 50, ASR-1 healed, finding resolved).
function reportPrior() {
  return {
    report_id: 'asrr_g_prior', generated_at: isoDaysAgo(40),
    summary: { readiness_pct: 20, blocking_count: 1, controls: [
      { id: 'ASR-1', name: 'Least privilege', status: 'blocking', findings: 1 },
      { id: 'ASR-2', name: 'Audit trail', status: 'pass', findings: 0 },
    ] },
    findings: [{ id: 'priv-shared-key', severity: 'high', title: 'Shared credential across boundaries', asr: { id: 'ASR-1' } }],
  };
}
function reportCurrent() {
  return {
    report_id: 'asrr_g_cur', generated_at: isoDaysAgo(9),
    summary: { readiness_pct: 50, blocking_count: 0, controls: [
      { id: 'ASR-1', name: 'Least privilege', status: 'attention', findings: 0 },
      { id: 'ASR-2', name: 'Audit trail', status: 'pass', findings: 0 },
    ] },
    findings: [],
  };
}

// A high-readiness report OLDER than the 30-day badge window: were it fresh it
// would render the green (>=80) bucket, so this fixture proves staleness
// outranks readiness on the badge.
const STALE_GENERATED_AT = isoDaysAgo(45);
function reportStale() {
  return {
    report_id: 'asrr_g_stale', generated_at: STALE_GENERATED_AT,
    summary: { readiness_pct: 92, blocking_count: 0, controls: [] },
    findings: [],
  };
}

// A report "signed" by a key we revoke in the seeded key-revocation store. It
// is ALSO older than 30 days and high-readiness, so the revoked badge winning
// proves revocation outranks both staleness and readiness. The route recomputes
// the fingerprint from the embedded public key, so the key must be real.
const { publicKey: REVOKED_PUB_PEM } = (() => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
})();
// Same fingerprint derivation as src/ed25519.js keyFingerprint: first 32 hex
// chars of SHA-256 over the SPKI DER.
const REVOKED_FP = crypto.createHash('sha256')
  .update(crypto.createPublicKey(REVOKED_PUB_PEM).export({ type: 'spki', format: 'der' }))
  .digest('hex').slice(0, 32);
function reportRevoked() {
  return {
    report_id: 'asrr_g_revoked', generated_at: isoDaysAgo(60),
    summary: { readiness_pct: 92, blocking_count: 0, controls: [] },
    findings: [],
    signature_ed25519: { public_key: REVOKED_PUB_PEM, key_fingerprint: REVOKED_FP, sig: 'not-checked-by-the-badge' },
  };
}

test('setup - boot server with two tenants, two reports, and a published Trust slug', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-g-routes-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: 't_g_a', name: 'g-a', email: 'a@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
    { id: 't_g_b', name: 'g-b', email: 'b@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const h = (k) => crypto.createHash('sha256').update(k).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_g_a', tenant_id: 't_g_a', hash: h(KEY_A), label: 'a', kind: 'user', created_at: now, revoked_at: null },
    { id: 'apik_g_b', tenant_id: 't_g_b', hash: h(KEY_B), label: 'b', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  const prior = reportPrior();
  const cur = reportCurrent();
  const stale = reportStale();
  const revoked = reportRevoked();
  fs.writeFileSync(path.join(dataDir, 'agent_audits.json'), JSON.stringify([
    { id: 'audses_g_cur', tenant_id: 't_g_a', subject: 'G Cur', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: cur, report_id: cur.report_id, summary: cur.summary, created_at: now, updated_at: now },
    { id: 'audses_g_prior', tenant_id: 't_g_a', subject: 'G Prior', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: prior, report_id: prior.report_id, summary: prior.summary, created_at: now, updated_at: now },
    { id: 'audses_g_open', tenant_id: 't_g_a', subject: 'G Open', source: 'litellm', status: 'open', logs: '', record_count: 0, report: null, created_at: now, updated_at: now },
    { id: 'audses_g_b', tenant_id: 't_g_b', subject: 'B Report', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: cur, report_id: 'asrr_g_b', summary: cur.summary, created_at: now, updated_at: now },
    { id: 'audses_g_paid', tenant_id: 't_g_a', subject: 'Badge Co', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: cur, report_id: cur.report_id, summary: cur.summary, paid: true, public: true, public_slug: TRUST_SLUG, tier: 'report', created_at: now, updated_at: now },
    { id: 'audses_g_stale', tenant_id: 't_g_a', subject: 'Stale Co', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: stale, report_id: stale.report_id, summary: stale.summary, paid: true, public: true, public_slug: TRUST_SLUG_STALE, tier: 'report', created_at: now, updated_at: now },
    { id: 'audses_g_revoked', tenant_id: 't_g_a', subject: 'Revoked Co', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: revoked, report_id: revoked.report_id, summary: revoked.summary, paid: true, public: true, public_slug: TRUST_SLUG_REVOKED, tier: 'report', created_at: now, updated_at: now },
  ]), 'utf8');

  // Seed the key-revocation store the way src/key-revocation.js persists it:
  // one row per fingerprint in the global 'issuer_key_status' table (the JSON
  // store keeps each table as <table>.json under KOLM_DATA_DIR).
  fs.writeFileSync(path.join(dataDir, 'issuer_key_status.json'), JSON.stringify([
    {
      id: 'iks_' + REVOKED_FP.slice(0, 16) + '_test',
      fingerprint: REVOKED_FP,
      status: 'revoked',
      reason: 'test_revocation',
      revoked_at: now,
      rotated_at: null,
      next_rotation_at: null,
      created_at: now,
      updated_at: now,
      version: 'kolm-key-revocation-v1',
    },
  ]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1', DEFAULT_TENANT: 'g-a',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

// ---------------------------------------------------------------------------
// POST /v1/audit/sessions/:id/delta
// ---------------------------------------------------------------------------

test('delta requires auth (401 without a key)', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_g_cur/delta?against=audses_g_prior`, { method: 'POST' });
  assert.equal(r.status, 401, 'private delta route is not public');
});

test('delta without ?against returns 400', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_g_cur/delta`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY_A}` },
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'against_required');
});

test('delta between two owned reports returns the signed-field drift', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_g_cur/delta?against=audses_g_prior`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY_A}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.delta && typeof j.delta === 'object', 'delta present');
  // prior(20) -> current(50): readiness improved by 30, ASR-1 healed, finding resolved.
  assert.equal(j.delta.readiness_change, 30, 'readiness 20 -> 50 = +30');
  assert.equal(j.delta.regressed, false, 'an improvement is not a regression');
  assert.ok(j.delta.controls_changed.some((c) => c.id === 'ASR-1' && c.from_status === 'blocking' && c.to_status === 'attention'), 'ASR-1 transition captured');
  assert.ok(j.delta.findings_resolved.some((f) => f.id === 'priv-shared-key'), 'the prior high finding is resolved');
  assert.equal(j.delta.findings_added.length, 0, 'nothing new appeared');
});

test('delta is tenant-fenced: a foreign report id reads as absent (404), never a leak', async () => {
  // Tenant A asks to diff against tenant B's report id. It must be
  // indistinguishable from "does not exist" - 404, no detail about B.
  const r = await fetch(`${base}/v1/audit/sessions/audses_g_cur/delta?against=audses_g_b`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY_A}` },
  });
  assert.equal(r.status, 404, 'another tenant\'s report is not reachable');
  const j = await r.json();
  assert.equal(j.error, 'against_not_found');
});

test('delta against a report-less (open) session returns 409, not a half-delta', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_g_cur/delta?against=audses_g_open`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY_A}` },
  });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, 'against_report_not_ready');
});

// ---------------------------------------------------------------------------
// GET /v1/trust/:slug/badge.svg
// ---------------------------------------------------------------------------

test('badge for a published slug is PUBLIC SVG carrying the readiness', async () => {
  const r = await fetch(`${base}/v1/trust/${TRUST_SLUG}/badge.svg`); // no key
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /image\/svg\+xml/);
  // State-bearing image: short max-age so staleness / revocation propagate.
  assert.match(r.headers.get('cache-control') || '', /max-age=300/, 'badge caches for 5 minutes, not longer');
  const svg = await r.text();
  assert.ok(svg.startsWith('<svg'), 'real SVG document');
  assert.ok(svg.includes('agent security'), 'carries the readiness label');
  assert.ok(svg.includes('50% ready'), 'reflects the published report readiness');
  assert.ok(svg.includes('#b58900'), 'amber bucket for 50% (50 <= n < 80)');
});

test('badge for an unknown slug serves the grey unknown badge, never a 500', async () => {
  const r = await fetch(`${base}/v1/trust/no-such-slug-here/badge.svg`);
  assert.equal(r.status, 200, 'an unknown slug still resolves to a badge, not an error');
  assert.match(r.headers.get('content-type') || '', /image\/svg\+xml/);
  const svg = await r.text();
  assert.ok(svg.includes('unknown'), 'unknown -> unknown message');
  assert.ok(svg.includes('#9f9f9f'), 'unknown -> grey bucket');
});

test('badge for a report older than 30 days is grey "stale (Month YYYY)" regardless of readiness', async () => {
  const r = await fetch(`${base}/v1/trust/${TRUST_SLUG_STALE}/badge.svg`); // no key
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /image\/svg\+xml/);
  const svg = await r.text();
  // readiness 92 would be green if fresh - staleness must outrank the bucket.
  assert.ok(svg.includes('stale ('), 'carries the stale marker');
  assert.ok(svg.includes(monthYearOf(STALE_GENERATED_AT)), 'names the month-year the report was generated');
  assert.ok(svg.includes('#9f9f9f'), 'stale -> grey, not a readiness colour');
  assert.ok(!svg.includes('#2e7d32'), 'a 45-day-old 92% report never serves the green pill');
  assert.ok(!svg.includes('92% ready'), 'the readiness number is withheld on a stale badge');
});

test('badge for a report signed by a revoked issuer key is "report revoked" and outranks staleness + readiness', async () => {
  const r = await fetch(`${base}/v1/trust/${TRUST_SLUG_REVOKED}/badge.svg`); // no key
  assert.equal(r.status, 200, 'the revocation check never turns the badge route into a 500');
  assert.match(r.headers.get('content-type') || '', /image\/svg\+xml/);
  const svg = await r.text();
  assert.ok(svg.includes('report revoked'), 'carries the revoked marker');
  assert.ok(svg.includes('#9f9f9f'), 'revoked -> the existing grey/neutral palette, no new alarm red');
  // The fixture is ALSO 60 days old and 92% ready: revoked must win over both.
  assert.ok(!svg.includes('stale ('), 'revocation outranks staleness');
  assert.ok(!svg.includes('92% ready'), 'revocation outranks readiness');
  assert.ok(!svg.includes('#2e7d32'), 'never green for a revoked report');
});

test('teardown', async () => {
  if (serverProc) await killAndWait(serverProc);
  if (scratchDir) rmSyncBestEffort(scratchDir);
});
