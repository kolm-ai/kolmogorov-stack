// reattestation-signer-wiring - prove the scheduled tick route and the manual
// deploy-hook route thread an EXPLICIT signer into runDueReattestations /
// forceReattest, mirroring how the Stripe webhook now wires the signer
// (audit-routes.js around the /v1/audit/continuous/tick + /deploy-hook handlers).
//
// We drive the REAL route handlers (via audit-routes.register onto a minimal
// fake router) with mock req/res, then assert:
//   * the cron-secret / 403 gating is unchanged;
//   * a due subscription is actually re-attested through the route;
//   * the fresh report is signed by the SAME key loadOrCreateDefaultSigner()
//     returns - i.e. the explicit signer was threaded, not some other path;
//   * the deploy-hook 409 'no active subscription' path is preserved;
//   * the deploy-hook force path re-attests for an active subscription.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-reattest-wire-'));
process.env.KOLM_DATA_DIR = dir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
process.env.KOLM_CRON_SECRET = 'test-cron-secret';

const { insert, findOne, update } = await import('../src/store.js');
const { runAudit } = await import('../src/audit-orchestrator.js');
const { buildAndSignReport, verifyReport } = await import('../src/attestation-report-builder.js');
const { fulfillReportPurchase, activateSubscription, setSubscriptionStatus } = await import('../src/asr-fulfillment.js');
const { loadOrCreateDefaultSigner } = await import('../src/ed25519.js');
const { register } = await import('../src/audit-routes.js');

const LOGS = [
  { ts: '2026-06-01T00:00:00Z', agent: 'a1', tool: 'http.get', action: 'call', actor: 'a1', event_id: 'e1' },
  { ts: '2026-06-01T00:00:01Z', agent: 'a1', tool: 'db.delete', action: 'call', actor: 'a1', event_id: 'e2', grants: ['*'] },
].map((r) => JSON.stringify(r)).join('\n');

const _norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

// Minimal router: capture POST handlers by path so we can invoke the real ones.
function makeRouter() {
  const routes = { get: {}, post: {} };
  return {
    get(p, h) { routes.get[p] = h; },
    post(p, h) { routes.post[p] = h; },
    _post(p) { return routes.post[p]; },
  };
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const router = makeRouter();
register(router, {});

const tickHandler = router._post('/v1/audit/continuous/tick');
const hookHandler = router._post('/v1/audit/continuous/deploy-hook');

test('routes are registered (handlers resolved)', () => {
  assert.equal(typeof tickHandler, 'function');
  assert.equal(typeof hookHandler, 'function');
});

test('tick: wrong cron secret -> 403, gating untouched', async () => {
  const res = mockRes();
  await tickHandler({ headers: { 'x-kolm-cron-secret': 'wrong' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'forbidden');
});

test('tick route threads the explicit signer: fresh report signed by loadOrCreateDefaultSigner key', async () => {
  const TENANT = 'tenant_tick_wire';
  const audit = runAudit(LOGS, { source: 'import' });
  const scan = buildAndSignReport(audit, { subject: 'Tick fleet', tier: 'scan' });
  const AID = 'audses_tickwire';
  insert('agent_audits', {
    id: AID, tenant_id: TENANT, subject: 'Tick fleet', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  });
  fulfillReportPurchase({ audit_id: AID, stripe_session_id: 'cs_tick' });
  const ac = activateSubscription({ product: 'starter', tenant_id: TENANT, stripe_subscription_id: 'sub_tick', stripe_customer_id: 'cus_tick' });
  assert.ok(ac.ok);
  // make it due
  update('asr_subscriptions', (s) => s.id === ac.sub.id, { next_run_at: '2020-01-01T00:00:00Z' });

  const res = mockRes();
  await tickHandler({ headers: { 'x-kolm-cron-secret': 'test-cron-secret' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.ran >= 1, 'tick re-attested at least one subscription via the route');

  const subAfter = findOne('asr_subscriptions', (s) => s.id === ac.sub.id);
  assert.notEqual(subAfter.latest_audit_id, AID, 'latest_audit_id advanced');
  const fresh = findOne('agent_audits', (r) => r.id === subAfter.latest_audit_id);
  assert.equal(verifyReport(fresh.report).ok, true, 'fresh report verifies');

  // PROOF of wiring: the fresh report's embedded public key equals the key
  // loadOrCreateDefaultSigner() returns - the explicit signer was threaded.
  const expectedPub = _norm(loadOrCreateDefaultSigner().publicKey);
  const env = fresh.report;
  const embeddedPub = _norm(env && env.signature_ed25519 && env.signature_ed25519.public_key);
  assert.ok(embeddedPub.length > 0, 'fresh report carries an embedded public key');
  assert.equal(embeddedPub, expectedPub, 'fresh report signed by the default signer key (explicit signer threaded)');
});

test('deploy-hook: 409 no_active_subscription path preserved', async () => {
  const res = mockRes();
  await hookHandler({ tenant_record: { id: 'tenant_no_sub' }, headers: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'no_active_subscription');
});

test('deploy-hook: force re-attest for an active subscription via the route', async () => {
  const TENANT = 'tenant_hook_wire';
  const audit = runAudit(LOGS, { source: 'import' });
  const scan = buildAndSignReport(audit, { subject: 'Hook fleet', tier: 'scan' });
  const AID = 'audses_hookwire';
  insert('agent_audits', {
    id: AID, tenant_id: TENANT, subject: 'Hook fleet', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  });
  fulfillReportPurchase({ audit_id: AID, stripe_session_id: 'cs_hook' });
  const ac = activateSubscription({ product: 'growth', tenant_id: TENANT, stripe_subscription_id: 'sub_hook', stripe_customer_id: 'cus_hook' });
  assert.ok(ac.ok);
  setSubscriptionStatus({ stripe_subscription_id: 'sub_hook', status: 'active' });

  const res = mockRes();
  await hookHandler({ tenant_record: { id: TENANT }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.ran >= 1, 'deploy-hook forced at least one re-attestation');
});

test('cleanup', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
