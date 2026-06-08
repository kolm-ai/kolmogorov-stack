// Agent Security-Review PAID LOOP tests - watermark/tier, $750 fulfillment,
// Trust-link resolution, Continuous subscription + re-attestation.
//
// Module-level integration against an isolated JSON store (no spawned server):
// the env is set before any store-touching import via dynamic import. Covers the
// invariants the paid loop depends on:
//   * the free scan / default build is watermarked (the give-away is closed),
//     and the signature COVERS the watermark (tamper-evident);
//   * resignAsTier upgrades to an unwatermarked report that still verifies and
//     keeps the same report_id;
//   * the ASR client_reference_id encode/decode roundtrip (Payment-Link path);
//   * fulfillReportPurchase is idempotent and mints a stable public slug;
//   * resolveTrust serves audit + subscription slugs; a stable subscription slug
//     follows re-attestation; a double tick never double-signs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-asr-test-'));
process.env.KOLM_DATA_DIR = dir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';

const { insert, findOne, update } = await import('../src/store.js');
const { runAudit } = await import('../src/audit-orchestrator.js');
const { buildAndSignReport, resignAsTier, verifyReport, renderReportHtml } = await import('../src/attestation-report-builder.js');
const { ASR_PRODUCTS, encodeAsrRef, parseAsrRef, asrBillingReady } = await import('../src/asr-billing.js');
const { fulfillReportPurchase, activateSubscription, setSubscriptionStatus, runDueReattestations, forceReattest, resolveTrust } = await import('../src/asr-fulfillment.js');

const LOGS = [
  { ts: '2026-06-01T00:00:00Z', agent: 'a1', tool: 'http.get', action: 'call', actor: 'a1', event_id: 'e1' },
  { ts: '2026-06-01T00:00:01Z', agent: 'a1', tool: 'db.delete', action: 'call', actor: 'a1', event_id: 'e2', grants: ['*'] },
].map((r) => JSON.stringify(r)).join('\n');

test('free scan / default build is watermarked, and the signature covers the watermark', () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Acme', tier: 'scan' });
  assert.equal(scan.envelope.tier, 'scan');
  assert.equal(scan.envelope.watermark, true);
  assert.equal(verifyReport(scan.envelope).ok, true, 'watermarked report still verifies');
  // default (no tier) is also watermarked - the give-away is closed
  const dflt = buildAndSignReport(audit, { subject: 'Acme' });
  assert.equal(dflt.envelope.watermark, true);
  // HTML shows the preview banner + wm body class
  const html = renderReportHtml(scan.envelope);
  assert.match(html, /UNPAID PREVIEW/);
  assert.match(html, /body class="wm"/);
});

test('resignAsTier upgrades to an unwatermarked report that still verifies', () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Acme', tier: 'scan' });
  const paid = resignAsTier(scan.envelope, 'report');
  assert.equal(paid.tier, 'report');
  assert.equal(paid.watermark, false);
  assert.equal(verifyReport(paid).ok, true);
  assert.equal(paid.report_id, scan.envelope.report_id, 'report_id preserved across upgrade');
  assert.doesNotMatch(renderReportHtml(paid), /UNPAID PREVIEW/);
  // input is not mutated
  assert.equal(scan.envelope.watermark, true);
});

test('ASR ref encode/decode roundtrip (Payment-Link binding)', () => {
  assert.equal(encodeAsrRef({ product: 'report', audit_id: 'audses_abc' }), 'asrrep_audses_abc');
  assert.deepEqual(parseAsrRef('asrrep_audses_abc'), { product: 'report', kind: 'one_time', audit_id: 'audses_abc' });
  assert.equal(encodeAsrRef({ product: 'starter', tenant_id: 'tenant_xyz' }), 'asrsub_starter_tenant_xyz');
  assert.deepEqual(parseAsrRef('asrsub_growth_tenant_xyz'), { product: 'growth', kind: 'subscription', tenant_id: 'tenant_xyz' });
  assert.equal(parseAsrRef('cs_live_unrelated'), null, 'non-ASR ref returns null (falls through to gateway plan)');
  // product catalog amounts match the locked pricing
  assert.equal(ASR_PRODUCTS.report.amount_cents, 75000);
  assert.equal(ASR_PRODUCTS.starter.amount_cents, 29900);
  assert.equal(ASR_PRODUCTS.growth.amount_cents, 99900);
});

test('asrBillingReady reports unconfigured cleanly (no Stripe envs in test)', () => {
  const r = asrBillingReady();
  assert.equal(r.ready, false);
  assert.ok(Array.isArray(r.missing) && r.missing.length >= 1);
  assert.equal(r.products.report, false);
});

test('$750 fulfillment: paid + slug + unwatermarked, idempotent, resolves at Trust link', () => {
  const TENANT = 'tenant_fulfill';
  const audit = runAudit(LOGS, { source: 'import' });
  const scan = buildAndSignReport(audit, { subject: 'Acme agents', tier: 'scan' });
  const AUDIT_ID = 'audses_fulfilltest';
  insert('agent_audits', {
    id: AUDIT_ID, tenant_id: TENANT, subject: 'Acme agents', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  });

  const fr = fulfillReportPurchase({ audit_id: AUDIT_ID, stripe_session_id: 'cs_1' });
  assert.ok(fr.ok);
  const row = findOne('agent_audits', (r) => r.id === AUDIT_ID);
  assert.equal(row.paid, true);
  assert.equal(row.tier, 'report');
  assert.equal(row.public, true);
  assert.ok(row.public_slug && row.public_slug.length >= 16);
  assert.equal(row.report.watermark, false, 'stored report is now unwatermarked');
  assert.equal(verifyReport(row.report).ok, true);

  // idempotent (webhook retry)
  const fr2 = fulfillReportPurchase({ audit_id: AUDIT_ID, stripe_session_id: 'cs_1' });
  assert.ok(fr2.ok && fr2.already);
  assert.equal(findOne('agent_audits', (r) => r.id === AUDIT_ID).public_slug, row.public_slug, 'slug stable on retry');

  // resolves at the Trust link
  const t = resolveTrust(row.public_slug);
  assert.ok(t && t.envelope && t.envelope.watermark === false);
  assert.equal(t.lapsed, false);
  assert.equal(resolveTrust('no_such_slug'), null);
});

test('Continuous: subscribe, re-attest on tick, stable slug follows fresh report, no double-sign', () => {
  const TENANT = 'tenant_cont';
  const audit = runAudit(LOGS, { source: 'import' });
  const scan = buildAndSignReport(audit, { subject: 'Beta fleet', tier: 'scan' });
  const AID = 'audses_conttest';
  insert('agent_audits', {
    id: AID, tenant_id: TENANT, subject: 'Beta fleet', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  });
  // promote to paid so it can seed the subscription
  fulfillReportPurchase({ audit_id: AID, stripe_session_id: 'cs_seed' });

  const ac = activateSubscription({ product: 'starter', tenant_id: TENANT, stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1' });
  assert.ok(ac.ok && ac.sub.public_slug);
  assert.equal(ac.sub.latest_audit_id, AID, 'seeded latest_audit_id');
  const subSlug = ac.sub.public_slug;
  assert.equal(resolveTrust(subSlug).kind, 'continuous');

  // make it due, then tick
  update('asr_subscriptions', (s) => s.id === ac.sub.id, { next_run_at: '2020-01-01T00:00:00Z' });
  const tick = runDueReattestations({});
  assert.ok(tick.ran >= 1, 'tick re-attested at least one');
  const subAfter = findOne('asr_subscriptions', (s) => s.id === ac.sub.id);
  assert.notEqual(subAfter.latest_audit_id, AID, 'latest_audit_id advanced');
  const fresh = findOne('agent_audits', (r) => r.id === subAfter.latest_audit_id);
  assert.equal(fresh.report.tier, 'report');
  assert.equal(verifyReport(fresh.report).ok, true);
  assert.equal(resolveTrust(subSlug).report_id, fresh.report_id, 'stable slug now serves the fresh report');

  // a second immediate tick is a no-op (claim pushed next_run forward)
  assert.equal(runDueReattestations({}).ran, 0);

  // lapsed subscription still resolves (with lapsed flag)
  setSubscriptionStatus({ stripe_subscription_id: 'sub_1', status: 'cancelled' });
  const lap = resolveTrust(subSlug);
  assert.ok(lap && lap.lapsed === true, 'lapsed subscription serves last report with lapsed flag');

  // deploy-hook force path
  setSubscriptionStatus({ stripe_subscription_id: 'sub_1', status: 'active' });
  assert.ok(forceReattest({ tenant_id: TENANT }).ok);
});

test('cleanup', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
