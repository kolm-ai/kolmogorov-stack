// Wave ECON-1 - verdict-first report rendering tests.
//
// The rendered report is the artifact a buyer actually holds. These tests lock
// the new render-only surfaces added to src/attestation-report-builder.js:
//
//   * renderReportHtml(envelope) single-arg behaviour is preserved (plus the
//     new sections), and the output stays ASCII-safe (no em / en dashes),
//   * paid-tier render with opts.trustSlug carries the one-click
//     /verify?trust=<slug> button and the verdict band,
//   * the scan tier keeps the live affordances LOCKED behind the $750 upgrade
//     (locked panel present; no verify button; watermark banner intact),
//   * opts.delta renders the "What changed since the last attestation" section
//     and omitting it removes the section entirely,
//   * deriveRemediation no longer emits "Remediate: <title>." filler for a
//     finding id without a standard hint,
//   * the render changes are signature-inert: sign -> verify round-trips pass
//     and rendering (with or without opts) never disturbs the canonical bytes.
//
// Pure in-process - no spawned server. Uses the committed dogfood fixture plus
// an in-memory Ed25519 signer, so nothing here touches the default key cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runAudit } from '../src/audit-orchestrator.js';
import { computeAuditDelta } from '../src/audit-delta.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  buildReportEnvelope,
  buildAndSignReport,
  signReport,
  verifyReport,
  canonicalizeReport,
  deriveRemediation,
  renderReportHtml,
  REMEDIATION_FALLBACK_ACTION,
} from '../src/attestation-report-builder.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

// En dash (U+2013) / em dash (U+2014), built from char codes so this test file
// itself stays pure ASCII while still asserting their absence in the output.
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

function dirtyAudit() {
  return runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
}

// In-memory Ed25519 signer - never the default key cache, never an env secret.
function memorySigner() {
  const kp = generateKeyPair();
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, key_fingerprint: keyFingerprint(kp.publicKey) };
}

const SIGNER = memorySigner();

function paidEnvelope(opts = {}) {
  return buildAndSignReport(dirtyAudit(), {
    subject: 'Helpwise Inc', tier: 'report', signer: SIGNER,
    report_seed: 'econ1-paid', generated_at: '2026-06-11T00:00:00.000Z', ...opts,
  }).envelope;
}

function scanEnvelope(opts = {}) {
  return buildAndSignReport(dirtyAudit(), {
    subject: 'Helpwise Inc', signer: SIGNER,
    report_seed: 'econ1-scan', generated_at: '2026-06-11T00:00:00.000Z', ...opts,
  }).envelope;
}

// ---------------------------------------------------------------------------
// (a) single-arg render works, new sections present, ASCII-safe punctuation.
// ---------------------------------------------------------------------------
test('renderReportHtml(env) single-arg works and contains no em/en dash characters', () => {
  const env = paidEnvelope();
  const html = renderReportHtml(env);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('Agent Security-Review Readiness Report'), 'title present');
  assert.ok(html.includes('Scope &amp; limitations'), 'caveats section present');
  assert.ok(html.includes('Verify offline'), 'offline-verify sigbox line unchanged');
  assert.ok(html.includes('For reviewers'), 'reviewer block present');
  assert.ok(html.includes('Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted.'), 'exact scope sentence verbatim');
  assert.ok(html.includes('evidence grade'), 'evidence-grade chip present');
  assert.ok(!DASHES.test(html), 'no em or en dash anywhere in the rendered report');
  assert.ok(!html.toLowerCase().includes('honest'), 'no banned word');
  assert.ok(!/certified|compliant/i.test(html), 'no certification claim');
});

test('caveats render AFTER the control-status section (placement only, strings intact)', () => {
  const env = paidEnvelope();
  const html = renderReportHtml(env);
  const controls = html.indexOf('<h2>Control status</h2>');
  const scope = html.indexOf('<h2>Scope &amp; limitations</h2>');
  const findings = html.indexOf('<h2>Findings</h2>');
  assert.ok(controls >= 0 && scope >= 0 && findings >= 0, 'all three sections present');
  assert.ok(controls < scope && scope < findings, 'order is Control status -> Scope & limitations -> Findings');
  for (const c of env.caveats) {
    assert.ok(html.includes(c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')), 'every caveat string survives byte-identical (escaped)');
  }
});

// ---------------------------------------------------------------------------
// (b) paid tier: one-click verify + verdict band.
// ---------------------------------------------------------------------------
test('paid-tier render with opts.trustSlug carries /verify?trust= and the verdict band', () => {
  const env = paidEnvelope();
  const html = renderReportHtml(env, { trustSlug: 'acme corp/slug' });
  assert.ok(html.includes('/verify?trust=' + encodeURIComponent('acme corp/slug')), 'trust slug is URI-encoded into the verify link');
  assert.ok(html.includes('Verify this report cryptographically'), 'one-click verify button text');
  // Dogfood fixture has deal-blocking findings + exposed probes -> red verdict.
  assert.ok(html.includes('class="verdict"'), 'verdict band rendered');
  assert.ok(html.includes('deal-blocking finding(s) open'), 'verdict names the open blockers');
  assert.ok(html.includes('Not procurement-ready on the assessed controls.'), 'verdict state sentence');
  assert.ok(html.includes('Assessed scope only; see Scope and limitations.'), 'scope qualifier appended');
  assert.ok(html.includes('#991b1b'), 'blocking verdict uses the red of the frozen palette');
});

test('paid tier without a trustSlug falls back to envelope.verify_url for the button', () => {
  const env = paidEnvelope();
  const html = renderReportHtml(env);
  assert.ok(env.verify_url, 'fixture envelope carries a verify_url');
  assert.ok(html.includes('Verify this report cryptographically'), 'button still rendered');
  assert.ok(!html.includes('/verify?trust='), 'no trust-param link without a slug');
});

test('a legacy envelope without summary.blocking_count omits the verdict band entirely', () => {
  const env = paidEnvelope();
  delete env.summary.blocking_count; // legacy shape - render-side only, no re-sign needed
  const html = renderReportHtml(env, { trustSlug: 'slug-1' });
  assert.ok(!html.includes('class="verdict"'), 'no invented verdict for a legacy envelope');
});

// ---------------------------------------------------------------------------
// (c) scan tier: watermark + locked panel, no live affordances.
// ---------------------------------------------------------------------------
test('scan-tier render keeps the watermark and locks the paid affordances at $750', () => {
  const env = scanEnvelope();
  // Even a (mis)wired trustSlug must not unlock the button on the scan tier.
  const html = renderReportHtml(env, { trustSlug: 'should-not-render' });
  assert.ok(html.includes('UNPAID PREVIEW'), 'wm-banner intact');
  assert.ok(html.includes('Verdict band, one-click cryptographic verification, the reviewer toolbar and the shareable Trust link are included in the Signed Readiness Report ($750).'), 'locked panel sentence verbatim with $750');
  assert.ok(!html.includes('/verify?trust='), 'no one-click verify link on the scan tier');
  assert.ok(!html.includes('Verify this report cryptographically'), 'no verify button on the scan tier');
  assert.ok(!html.includes('class="verdict"'), 'no live verdict band on the scan tier');
  assert.ok(html.includes('body class="wm"'), 'watermark body class unchanged');
});

// ---------------------------------------------------------------------------
// (d) delta section renders from opts.delta and is absent without it.
// ---------------------------------------------------------------------------
test('opts.delta renders the what-changed section; omitting it removes the section', () => {
  const audit = dirtyAudit();
  const prev = buildAndSignReport(audit, { subject: 'X', signer: SIGNER, report_seed: 'econ1-prev', generated_at: '2026-06-01T00:00:00.000Z' }).envelope;
  const curr = paidEnvelope();
  const delta = computeAuditDelta(prev, curr);
  const env = curr;

  const withDelta = renderReportHtml(env, { delta });
  assert.ok(withDelta.includes('What changed since the last attestation'), 'delta section heading rendered');
  assert.ok(withDelta.includes(delta.summary.replace(/->/g, '-&gt;')) || withDelta.includes('No regression versus the prior attestation.'), 'delta summary line surfaced');
  assert.ok(withDelta.includes('percentage point') || withDelta.includes('Readiness movement: <strong>n/a</strong>'), 'readiness movement rendered');
  assert.ok(withDelta.indexOf('What changed since the last attestation') < withDelta.indexOf('<h2>Findings</h2>'), 'delta sits immediately above Findings');

  const without = renderReportHtml(env);
  assert.ok(!without.includes('What changed since the last attestation'), 'section absent without opts.delta');
  const withNull = renderReportHtml(env, { delta: null });
  assert.ok(!withNull.includes('What changed since the last attestation'), 'explicit null also omits the section');
});

test('a regressed delta gets the red header strip; an improving one gets green', () => {
  const base = {
    from: { report_id: 'asrr_a', generated_at: '2026-06-01T00:00:00.000Z', readiness_pct: 50 },
    to: { report_id: 'asrr_b', generated_at: '2026-06-11T00:00:00.000Z', readiness_pct: 40 },
    readiness_change: -10,
    controls_changed: [{ id: 'ASR-1', from_status: 'pass', to_status: 'blocking' }],
    findings_added: [{ id: 'over-permission', severity: 'high', title: 'Over-permissioned agent' }],
    findings_resolved: [],
    regressed: true,
    summary: 'Readiness 50% -> 40% (-10). 1 control(s) changed, 1 finding(s) added, 0 resolved. Posture regressed since the prior attestation.',
  };
  const env = paidEnvelope();
  const red = renderReportHtml(env, { delta: base });
  assert.ok(red.includes('class="delta-head" style="background:#991b1b"'), 'regression strip is red');
  assert.ok(red.includes('ASR-1: pass -&gt; blocking'), 'control transition rendered with the ASCII arrow');
  assert.ok(red.includes('-10 percentage point(s)'), 'signed readiness movement');

  const green = renderReportHtml(env, {
    delta: { ...base, regressed: false, readiness_change: 12.5, findings_added: [], findings_resolved: base.findings_added, summary: 'Readiness 40% -> 52.5% (+12.5). 0 control(s) changed, 0 finding(s) added, 1 resolved. No regression versus the prior attestation.', controls_changed: [] },
  });
  assert.ok(green.includes('class="delta-head" style="background:#166534"'), 'improvement strip is green');
  assert.ok(green.includes('+12.5 percentage point(s)'), 'positive movement carries the plus sign');
});

// ---------------------------------------------------------------------------
// (e) remediation fallback - no more "Remediate: <title>." filler.
// ---------------------------------------------------------------------------
test('deriveRemediation no longer emits "Remediate:" filler for an unknown finding id', () => {
  const fake = {
    summary: {},
    controls: {
      findings: [{
        id: 'some-future-analyzer-finding',
        severity: 'high',
        title: 'A finding with no standard hint',
        detail: 'Three calls reached an unclassified surface.',
        controls: [],
      }],
    },
  };
  const rem = deriveRemediation(fake);
  assert.equal(rem.length, 1);
  assert.ok(!rem[0].action.startsWith('Remediate:'), 'filler action removed');
  assert.equal(rem[0].action, REMEDIATION_FALLBACK_ACTION, 'fallback is the specific no-pattern sentence');
});

test('known analyzer finding ids carry engineering-grade hints, not the fallback', () => {
  const ids = [
    'secret-egress', 'unapproved-egress-destination', 'undeclared-egress-surface',
    'unattributed-agent-action', 'ambiguous-agent-identity', 'unverifiable-agent-scope',
    'agent-identity-partial', 'unpinned-model-version', 'opaque-model-routing',
    'unpinned-mcp-server', 'model-egress-third-party', 'untrusted-retrieval-source',
    'unverified-memory-write', 'delegation-privilege-escalation', 'opaque-delegation-hop',
    'unattenuated-delegation',
  ];
  const fake = {
    summary: {},
    controls: { findings: ids.map((id) => ({ id, severity: 'medium', title: id, controls: [] })) },
  };
  const rem = deriveRemediation(fake);
  assert.equal(rem.length, ids.length);
  for (const r of rem) {
    assert.notEqual(r.action, REMEDIATION_FALLBACK_ACTION, `${r.finding_id} has a specific hint`);
    assert.ok(!r.action.startsWith('Remediate:'), `${r.finding_id} carries no filler`);
    assert.ok(r.action.length > 40, `${r.finding_id} hint is substantive`);
  }
});

test('the HTML remediation row surfaces the finding detail when the fallback fired', () => {
  const env = paidEnvelope();
  // Splice a synthetic no-hint remediation row + matching finding (render-side
  // only; we do not re-sign, rendering never checks the signature).
  env.findings = [...env.findings, {
    id: 'some-future-analyzer-finding', severity: 'high', pillar: null,
    title: 'A finding with no standard hint',
    detail: 'Three calls reached an unclassified surface; see events e1..e3.',
    asr: null, frameworks: [], evidence: [],
  }];
  env.remediation = [...env.remediation, {
    priority: 'P0', severity: 'high', finding_id: 'some-future-analyzer-finding',
    title: 'A finding with no standard hint', action: REMEDIATION_FALLBACK_ACTION,
    asr: null, frameworks: [],
  }];
  const html = renderReportHtml(env);
  assert.ok(html.includes(REMEDIATION_FALLBACK_ACTION), 'fallback sentence rendered');
  assert.ok(html.includes('Three calls reached an unclassified surface; see events e1..e3.'), 'finding detail excerpt rendered in the row');
});

// ---------------------------------------------------------------------------
// (f) signature inertness - sign -> verify round-trips before and after render.
// ---------------------------------------------------------------------------
test('signReport -> verifyReport round-trip passes and rendering never disturbs the signed bytes', () => {
  const audit = dirtyAudit();
  const envelope = buildReportEnvelope(audit, { subject: 'Roundtrip', tier: 'report', report_seed: 'econ1-rt', generated_at: '2026-06-11T00:00:00.000Z' });
  signReport(envelope, SIGNER);
  assert.equal(verifyReport(envelope).ok, true, 'fresh envelope verifies');

  const before = canonicalizeReport(envelope);
  renderReportHtml(envelope);
  renderReportHtml(envelope, { trustSlug: 'econ1-slug', delta: computeAuditDelta(envelope, envelope) });
  const after = canonicalizeReport(envelope);
  assert.equal(before, after, 'rendering (with or without opts) is byte-inert on the canonical payload');
  assert.equal(verifyReport(envelope).ok, true, 'envelope still verifies after rendering');
});

test('previously signed envelopes (built with the old builder shape) still verify and render', () => {
  // Simulate a legacy envelope: no evidence_tier, no red_team, no blocking_count.
  const env = paidEnvelope();
  const { signature_ed25519, ...rest } = env;
  void signature_ed25519;
  const legacy = JSON.parse(JSON.stringify(rest));
  delete legacy.evidence_tier;
  delete legacy.red_team;
  delete legacy.summary.blocking_count;
  signReport(legacy, SIGNER);
  assert.equal(verifyReport(legacy).ok, true, 'legacy-shaped envelope signs and verifies');
  const html = renderReportHtml(legacy, { trustSlug: 'legacy-slug' });
  assert.ok(html.includes('not graded'), 'legacy evidence tier renders the not-graded line');
  assert.ok(html.includes('>n/a</div><div class="small">evidence grade</div>'), 'grade chip renders n/a, never an invented grade');
  assert.ok(!html.includes('class="verdict"'), 'no invented verdict band');
  assert.ok(!DASHES.test(html), 'legacy render stays ASCII-safe');
});

// ---------------------------------------------------------------------------
// brand + palette discipline on the new surfaces.
// ---------------------------------------------------------------------------
test('the rendered report stays inside the frozen cool palette (no warm yellows/gold)', () => {
  const paid = renderReportHtml(paidEnvelope(), { trustSlug: 's' });
  const scan = renderReportHtml(scanEnvelope());
  for (const html of [paid, scan]) {
    assert.ok(!/#(f59e0b|fbbf24|eab308|fde047|d97706|b45309|ffd700|ffa500)/i.test(html), 'no warm yellow/gold/amber hex anywhere');
    assert.ok(!html.toLowerCase().includes('honest'), 'no banned word');
    assert.ok(html.includes('dev@kolm.ai'), 'dev@kolm.ai is the contact surface');
  }
});
