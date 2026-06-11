// Wave ECON-2 - the public Trust link as the reviewer's WORKING surface, plus
// two pure-code economics fixes. Locks:
//
//   (a) GET /v1/trust/:slug (html) carries the route-level 'Reviewer tools'
//       toolbar with working links to the already-mounted procurement
//       endpoints (export drata/vanta, questionnaire CSV, badge.svg, delta,
//       /verify?trust=<slug>);
//   (b) with a prior signed report in the subscription lineage, the html
//       renders the 'What changed since the last attestation' drift section;
//       with no prior it renders cleanly WITHOUT it (delta is best-effort and
//       never blocks serving the report);
//   (c) the pending page no longer promises the first report arrives
//       'shortly' - it names the real trigger (first attestation cycle, or an
//       immediate scan / deploy-hook call);
//   (d) die-risk #7: activateSubscription schedules the FIRST attestation at
//       NOW (within 60s), not +1 week, so the in-process sweep picks it up on
//       its next tick;
//   (e) die-risk #1: fulfillReportPurchase appends exactly ONE
//       agent_audit.checkout_completed telemetry op, and a redelivered
//       (idempotent) call appends NONE - started-vs-paid conversion is
//       countable without double-counting webhook retries.
//
// Two harness halves in one file:
//   * (d)+(e) run module-level against an isolated JSON store (the
//     tests/asr-paid-loop.test.js pattern - env set BEFORE any store-touching
//     import via dynamic import);
//   * (a)+(b)+(c) run against a spawned server with a seeded store (the
//     tests/agent-audit-delta-badge-routes.test.js pattern). Seeded plain
//     envelopes are a faithful test of the route contract: the trust html
//     route reads signature-covered FIELDS and never re-verifies.

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

// ---------------------------------------------------------------------------
// Module-level half: isolated JSON store for the fulfillment-function locks.
// ---------------------------------------------------------------------------
const modDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-econ2-test-'));
process.env.KOLM_DATA_DIR = modDir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';

const { insert, find } = await import('../src/store.js');
const { runAudit } = await import('../src/audit-orchestrator.js');
const { buildAndSignReport } = await import('../src/attestation-report-builder.js');
const { fulfillReportPurchase, activateSubscription } = await import('../src/asr-fulfillment.js');

const LOGS = [
  { ts: '2026-06-01T00:00:00Z', agent: 'a1', tool: 'http.get', action: 'call', actor: 'a1', event_id: 'e1' },
  { ts: '2026-06-01T00:00:01Z', agent: 'a1', tool: 'db.delete', action: 'call', actor: 'a1', event_id: 'e2', grants: ['*'] },
].map((r) => JSON.stringify(r)).join('\n');

const completedOps = (match) => find('audit_events',
  (r) => r && r.op === 'agent_audit.checkout_completed' && r.payload && match(r.payload));

test('(d) die-risk #7: activateSubscription schedules the FIRST attestation now, not +1 week', () => {
  const before = Date.now();
  const ac = activateSubscription({ product: 'starter', tenant_id: 'tenant_econ2_d', stripe_subscription_id: 'sub_econ2_d' });
  assert.ok(ac.ok && !ac.already, 'fresh activation');
  assert.ok(ac.sub.next_run_at, 'next_run_at set');
  const t = new Date(ac.sub.next_run_at).getTime();
  assert.ok(Number.isFinite(t), 'next_run_at parses');
  assert.ok(Math.abs(t - before) < 60_000,
    `initial next_run_at is within 60s of now, not a week out (got ${ac.sub.next_run_at})`);
});

test('(d+) activation telemetry: one checkout_completed on activation, none on the idempotent re-activation', () => {
  const mine = () => completedOps((p) => p.tenant_id === 'tenant_econ2_d' && p.product === 'starter');
  assert.equal(mine().length, 1, 'exactly one op for the activation above');
  assert.ok(mine()[0].payload.subscription_id, 'payload carries the subscription id');
  const again = activateSubscription({ product: 'starter', tenant_id: 'tenant_econ2_d', stripe_subscription_id: 'sub_econ2_d' });
  assert.ok(again.ok && again.already, 'redelivered webhook hits the already path');
  assert.equal(mine().length, 1, 'a redelivered activation appends NO second telemetry op');
});

test('(e) die-risk #1: fulfillReportPurchase appends exactly one checkout_completed op; a redelivery appends none', () => {
  const TENANT = 'tenant_econ2_e';
  const AUDIT_ID = 'audses_econ2_e';
  const audit = runAudit(LOGS, { source: 'import' });
  const scan = buildAndSignReport(audit, { subject: 'Econ2 Co', tier: 'scan' });
  insert('agent_audits', {
    id: AUDIT_ID, tenant_id: TENANT, subject: 'Econ2 Co', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  });
  const mine = () => completedOps((p) => p.audit_id === AUDIT_ID);
  assert.equal(mine().length, 0, 'no op before fulfillment');

  const fr = fulfillReportPurchase({ audit_id: AUDIT_ID, stripe_session_id: 'cs_econ2_1' });
  assert.ok(fr.ok && !fr.already, 'first delivery fulfills');
  const ops = mine();
  assert.equal(ops.length, 1, 'exactly one agent_audit.checkout_completed op');
  assert.equal(ops[0].payload.product, 'report');
  assert.equal(ops[0].payload.tenant_id, TENANT);
  assert.equal(ops[0].tenant_id, TENANT, 'op row is tenant-fenced to the buyer');

  const fr2 = fulfillReportPurchase({ audit_id: AUDIT_ID, stripe_session_id: 'cs_econ2_1' });
  assert.ok(fr2.ok && fr2.already, 'redelivered webhook hits the already path');
  assert.equal(mine().length, 1, 'a redelivered event appends NO second op (no double-count)');
});

// ---------------------------------------------------------------------------
// HTTP half: spawned server, seeded store (delta-badge harness pattern).
// ---------------------------------------------------------------------------
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

const KEY_A = 'ks_e2_a_' + 'a'.repeat(40);
const SLUG_ONE = 'econ2trustslugone0001';    // paid one-time audit, NO prior
const SLUG_SUB = 'econ2trustslugsub0002';    // subscription with a 2-report lineage
const SLUG_PENDING = 'econ2trustslugpend03'; // subscription with no first report

let serverProc = null;
let base = null;
let scratchDir = null;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Prior (readiness 20, one blocking control, one open high finding) ->
// current (readiness 50, control healed, finding resolved): a real drift, so
// the rendered delta section has substance to assert on.
function reportPrior() {
  return {
    report_id: 'asrr_e2_prior', generated_at: isoDaysAgo(8),
    summary: { readiness_pct: 20, blocking_count: 1, controls: [
      { id: 'ASR-1', name: 'Least privilege', status: 'blocking', findings: 1 },
      { id: 'ASR-2', name: 'Audit trail', status: 'pass', findings: 0 },
    ] },
    findings: [{ id: 'priv-shared-key', severity: 'high', title: 'Shared credential across boundaries', asr: { id: 'ASR-1' } }],
  };
}
function reportCurrent(reportId) {
  return {
    report_id: reportId, generated_at: isoDaysAgo(1),
    summary: { readiness_pct: 50, blocking_count: 0, controls: [
      { id: 'ASR-1', name: 'Least privilege', status: 'attention', findings: 0 },
      { id: 'ASR-2', name: 'Audit trail', status: 'pass', findings: 0 },
    ] },
    findings: [],
  };
}

test('setup - boot server with a paid audit slug, a 2-report subscription lineage, and a pending subscription', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-econ2-http-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: 't_e2_a', name: 'e2-a', email: 'a@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const h = (k) => crypto.createHash('sha256').update(k).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_e2_a', tenant_id: 't_e2_a', hash: h(KEY_A), label: 'a', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  const prior = reportPrior();
  const curOne = reportCurrent('asrr_e2_one');
  const curSub = reportCurrent('asrr_e2_cur');
  fs.writeFileSync(path.join(dataDir, 'agent_audits.json'), JSON.stringify([
    // (a)+(b no-prior): a standalone paid one-time audit behind SLUG_ONE.
    { id: 'audses_e2_paid', tenant_id: 't_e2_a', subject: 'One Co', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: curOne, report_id: curOne.report_id, summary: curOne.summary, paid: true, public: true, public_slug: SLUG_ONE, tier: 'report', created_at: now, updated_at: now },
    // (b with-prior): the subscription lineage - seed (prior) + re-attestation (current).
    { id: 'audses_e2_seed', tenant_id: 't_e2_a', subject: 'Sub Co', source: 'litellm', status: 'complete', logs: '', record_count: 6, report: prior, report_id: prior.report_id, summary: prior.summary, paid: true, tier: 'report', created_at: isoDaysAgo(8), updated_at: isoDaysAgo(8) },
    { id: 'audses_e2_cur', tenant_id: 't_e2_a', subject: 'Sub Co', source: 'reattest', status: 'complete', logs: '', record_count: 6, report: curSub, report_id: curSub.report_id, summary: curSub.summary, paid: true, tier: 'report', subscription_id: 'asrsub_e2', created_at: isoDaysAgo(1), updated_at: isoDaysAgo(1) },
  ]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'asr_subscriptions.json'), JSON.stringify([
    { id: 'asrsub_e2', tenant_id: 't_e2_a', product_key: 'starter', status: 'active', cadence: 'weekly', stripe_subscription_id: 'sub_e2', stripe_customer_id: null, stripe_session_id: null, public_slug: SLUG_SUB, latest_audit_id: 'audses_e2_cur', source_audit_id: 'audses_e2_seed', next_run_at: '2099-01-01T00:00:00Z', last_run_at: isoDaysAgo(1), created_at: isoDaysAgo(8), updated_at: isoDaysAgo(1) },
    // (c): subscribed before any scan - no first report, valid link, pending page.
    { id: 'asrsub_e2_pend', tenant_id: 't_e2_a', product_key: 'starter', status: 'active', cadence: 'weekly', stripe_subscription_id: 'sub_e2p', stripe_customer_id: null, stripe_session_id: null, public_slug: SLUG_PENDING, latest_audit_id: null, source_audit_id: null, next_run_at: '2099-01-01T00:00:00Z', last_run_at: null, created_at: now, updated_at: now },
  ]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1', DEFAULT_TENANT: 'e2-a',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

test('(a) the Trust html carries the Reviewer tools toolbar with working endpoint links', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG_ONE}`); // public, no key
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text();
  assert.ok(html.includes('Reviewer tools'), 'toolbar label present');
  assert.ok(html.includes(`/v1/trust/${SLUG_ONE}/export?format=drata`), 'Drata export link');
  assert.ok(html.includes(`/v1/trust/${SLUG_ONE}/export?format=vanta`), 'Vanta export link');
  assert.ok(html.includes(`/v1/trust/${SLUG_ONE}/questionnaire?format=csv`), 'questionnaire CSV link');
  assert.ok(html.includes(`/v1/trust/${SLUG_ONE}/badge.svg`), 'badge link');
  assert.ok(html.includes(`/v1/trust/${SLUG_ONE}/delta`), 'drift JSON link');
  assert.ok(html.includes(`/verify?trust=${SLUG_ONE}`), 'verify link with the trust query param');
});

test('(a+) the toolbar links resolve: drata export + questionnaire csv + badge respond on the same slug', async () => {
  const ex = await fetch(`${base}/v1/trust/${SLUG_ONE}/export?format=drata`);
  assert.equal(ex.status, 200, 'drata export works off the toolbar link');
  const q = await fetch(`${base}/v1/trust/${SLUG_ONE}/questionnaire?format=csv`);
  assert.equal(q.status, 200, 'questionnaire CSV works off the toolbar link');
  const b = await fetch(`${base}/v1/trust/${SLUG_ONE}/badge.svg`);
  assert.equal(b.status, 200, 'badge works off the toolbar link');
});

test('(b) with a prior attestation in the lineage, the drift renders INSIDE the artifact', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG_SUB}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('What changed since the last attestation'), 'delta section rendered in the report html');
  assert.ok(html.includes('Reviewer tools'), 'toolbar present on the subscription slug too');
});

test('(b) with NO prior, the page renders cleanly without the drift section', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG_ONE}`);
  assert.equal(r.status, 200, 'delta resolution never blocks serving the report');
  const html = await r.text();
  assert.ok(!html.includes('What changed since the last attestation'), 'no invented drift on a first attestation');
});

test('(c) the pending page names the real trigger and never promises "shortly"', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG_PENDING}`);
  assert.equal(r.status, 200, 'a valid pending Continuous link is not a 404');
  const html = await r.text();
  assert.ok(!html.toLowerCase().includes('shortly'), 'no "shortly" promise anywhere on the pending page');
  assert.ok(html.includes('first attestation cycle'), 'states the first report generates on the first attestation cycle');
  assert.ok(html.includes('deploy-hook'), 'names the deploy-hook trigger');
  assert.ok(html.includes('Agent Exposure Scan'), 'names the immediate scan trigger');
});

test('the toolbar is Trust-route-only: the authed session report html has no Reviewer tools strip', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_e2_paid/report?format=html`, {
    headers: { Authorization: `Bearer ${KEY_A}` },
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(!html.includes('Reviewer tools'), 'session render never carries the route-level toolbar');
});

test('teardown', async () => {
  if (serverProc) await killAndWait(serverProc);
  if (scratchDir) rmSyncBestEffort(scratchDir);
  try { fs.rmSync(modDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
