// Agent Security-Review REVENUE GATE regression tests (G1, BLOCKER-coupled).
//
// Pins the entitlement contract that the paid loop depends on for revenue:
//
//   * an UNPAID tenant (no paid report, no active subscription) is NOT entitled,
//     so its scan envelope is the watermarked SUMMARY tier - readiness rollup
//     only, with NO findings detail and NO frameworks/remediation/evidence_tier;
//   * a PAID tenant (an audit row flipped to paid + tier:'report') IS entitled,
//     and the report tier carries the full envelope (detailed findings, frameworks);
//   * a Continuous SUBSCRIBER (an active asr_subscriptions row) IS entitled, so it
//     can fetch + export the full deliverable;
//   * the reduction happens BEFORE signing, so the SCAN-tier envelope still passes
//     verifyReport (the signature covers exactly the reduced payload a buyer gets),
//     and a paid report tampered back to the full shape does NOT verify.
//
// Module-level integration against an isolated JSON store (the established
// asr-paid-loop.test.js pattern): the store env is set before any store-touching
// import. tenantHasReportEntitlement is the exact gate src/audit-routes.js calls
// to decide summary-vs-report and 403-vs-deliverable, so testing it locks the gate
// without re-spawning the HTTP surface (which agent-audit-routes.test.js covers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-asr-gate-test-'));
process.env.KOLM_DATA_DIR = dir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';

const { insert } = await import('../src/store.js');
const { runAudit } = await import('../src/audit-orchestrator.js');
const { buildAndSignReport, resignAsTier, verifyReport, stripWirePayload } = await import('../src/attestation-report-builder.js');
const { tenantHasReportEntitlement } = await import('../src/audit-routes.js');

// The dogfood litellm fixture produces blocking findings WITH detail (over-
// permissioned keys, missing audit trail, etc.), so the full report has real
// detail + frameworks to withhold from the scan tier. The minimal hand-rolled
// log set above did not (its findings are all info-tier control notes), which
// would not exercise the reduction this gate locks.
const LOGS = fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'agent-audit', 'litellm-export.jsonl'), 'utf8');

test('UNPAID: the scan tier is summary-only - no findings detail, no frameworks, watermarked, still verifies', () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Acme', tier: 'scan' });
  const env = scan.envelope;

  // The summary rollup IS present (the verdict band reads it).
  assert.equal(env.tier, 'scan');
  assert.equal(env.watermark, true);
  assert.ok(env.summary, 'summary rollup present');
  assert.equal(typeof env.summary.readiness_pct, 'number', 'readiness_pct present');
  assert.equal(typeof env.summary.blocking_count, 'number', 'blocking_count present');

  // The paid-only sections are WITHHELD from the scan envelope.
  assert.ok(!('frameworks' in env), 'no frameworks block in the scan tier');
  assert.ok(!('remediation' in env), 'no remediation roadmap in the scan tier');
  assert.ok(!('evidence_tier' in env), 'no evidence_tier in the scan tier');
  assert.ok(!('asr_checklist' in env), 'no asr_checklist body in the scan tier');

  // findings collapse to severity+title STUBS - no detail, frameworks, or evidence
  // per finding. A buyer cannot read the actual finding bodies from a free scan.
  assert.ok(Array.isArray(env.findings), 'findings present as stubs');
  for (const f of env.findings) {
    const keys = Object.keys(f).sort();
    assert.deepEqual(keys, ['severity', 'title'], 'a scan finding is a bare severity+title stub');
    assert.ok(!('detail' in f) && !('description' in f) && !('frameworks' in f) && !('evidence' in f),
      'no finding detail leaks through the stub');
  }

  // The reduction happened BEFORE signing: the scan envelope verifies as-is.
  assert.equal(verifyReport(env).ok, true, 'the SCAN (reduced) envelope verifies - signature covers the reduced payload');

  // PAYWALL LOCK (councils CRITICAL): the in-memory scan envelope DOES stash the
  // report-tier sections under the detached _full_payload carry-over (so the paid
  // upgrade can restore them), but that field is SERVER-SIDE ONLY and must be
  // stripped before the envelope reaches any HTTP client. Pin both halves of the
  // contract: the carry-over exists in-process, and stripWirePayload() removes it
  // (and nothing reachable from the stripped wire form leaks full finding detail).
  assert.ok('_full_payload' in env, 'in-memory scan envelope holds the detached carry-over for the paid upgrade');
  const wire = stripWirePayload(env);
  assert.ok(!('_full_payload' in wire), 'stripWirePayload removes the carry-over from the wire form');
  assert.ok(!('frameworks' in wire) && !('remediation' in wire) && !('evidence_tier' in wire),
    'the wire form carries no paid-tier sections');
  for (const f of (wire.findings || [])) {
    assert.ok(!('detail' in f) && !('evidence' in f), 'no finding detail on the wire form');
  }
  // The wire form must still verify (stripping a non-signature-covered field is safe).
  assert.equal(verifyReport(wire).ok, true, 'the wire-stripped scan envelope still verifies');
});

test('PAID: the report tier carries the full envelope (detailed findings + frameworks) and verifies', () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Acme', tier: 'scan' });
  const paid = resignAsTier(scan.envelope, 'report');

  assert.equal(paid.tier, 'report');
  assert.equal(paid.watermark, false, 'the paid report is not watermarked');
  assert.ok('frameworks' in paid, 'the report tier restores the frameworks block');
  assert.ok(Array.isArray(paid.findings) && paid.findings.length >= 1, 'detailed findings present');
  // Detailed findings are richer than the scan stubs (they carry an id/severity at
  // minimum, not just severity+title).
  assert.ok(paid.findings.some((f) => Object.keys(f).length > 2), 'a report finding carries detail beyond severity+title');
  assert.equal(verifyReport(paid).ok, true, 'the full report verifies');

  // Tampering the scan envelope back to the report shape (forging entitlement)
  // must NOT verify - the signature covered the reduced payload.
  const forged = JSON.parse(JSON.stringify(scan.envelope));
  forged.tier = 'report';
  forged.watermark = false;
  assert.equal(verifyReport(forged).ok, false, 'flipping tier/watermark on a signed scan breaks the signature');
});

test('GATE: an UNPAID tenant (no paid report, no subscription) is NOT entitled', async () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Unpaid', tier: 'scan' });
  const TENANT = 'tenant_gate_unpaid';
  const auditRow = {
    id: 'audses_gate_unpaid', tenant_id: TENANT, subject: 'Unpaid', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    paid: false, tier: 'scan',
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  };
  insert('agent_audits', auditRow);
  assert.equal(await tenantHasReportEntitlement(TENANT, auditRow), false, 'unpaid + no sub => not entitled');
  // A missing tenant id never accidentally entitles.
  assert.equal(await tenantHasReportEntitlement(null, auditRow), false);
});

test('GATE: a tenant with a PAID (tier:report) audit IS entitled', async () => {
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Paid', tier: 'scan' });
  const paid = resignAsTier(scan.envelope, 'report');
  const TENANT = 'tenant_gate_paid';
  const auditRow = {
    id: 'audses_gate_paid', tenant_id: TENANT, subject: 'Paid', source: 'import',
    status: 'complete', logs: LOGS, record_count: 2,
    report: paid, report_id: scan.report_id, summary: audit.summary,
    paid: true, tier: 'report', public: true, public_slug: 'slugpaidgate0000',
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  };
  insert('agent_audits', auditRow);
  assert.equal(await tenantHasReportEntitlement(TENANT, auditRow), true, 'paid + tier:report => entitled');
});

test('GATE: a Continuous subscriber (active subscription) IS entitled to fetch + export', async () => {
  const TENANT = 'tenant_gate_sub';
  insert('asr_subscriptions', {
    id: 'asrsub_gate', tenant_id: TENANT, product_key: 'starter',
    status: 'active', cadence: 'weekly', public_slug: 'slugsubgate00000',
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  });
  // Even with an UNPAID scan audit row, the active subscription entitles the tenant.
  const audit = runAudit(LOGS, { source: 'test' });
  const scan = buildAndSignReport(audit, { subject: 'Sub', tier: 'scan' });
  const auditRow = {
    id: 'audses_gate_sub', tenant_id: TENANT, subject: 'Sub', source: 'import',
    status: 'complete', report: scan.envelope, report_id: scan.report_id, summary: audit.summary,
    paid: false, tier: 'scan',
    created_at: '2026-06-01T00:00:02Z', updated_at: '2026-06-01T00:00:02Z',
  };
  insert('agent_audits', auditRow);
  assert.equal(await tenantHasReportEntitlement(TENANT, auditRow), true, 'active subscription => entitled');

  // A CANCELLED subscription does NOT entitle.
  const TENANT2 = 'tenant_gate_sub_cancelled';
  insert('asr_subscriptions', {
    id: 'asrsub_gate_cancelled', tenant_id: TENANT2, product_key: 'starter',
    status: 'cancelled', cadence: 'weekly', public_slug: 'slugsubcanc00000',
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  });
  assert.equal(await tenantHasReportEntitlement(TENANT2, null), false, 'a cancelled subscription does not entitle');
});

test('cleanup', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
