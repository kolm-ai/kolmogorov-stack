// Agent Security-Review - report v2 (red_team envelope) tests.
//
// The signed report gained a NEW top-level field, `red_team` (the ASR-4
// injection battery). These tests lock the CRITICAL INVARIANT: adding it is
// signature-safe because the canonicalizer is a generic key-sort, and it does
// NOT change how any pre-existing field is canonicalized or signed. So:
//
//   * the envelope carries a well-formed red_team block (score + probes),
//   * build -> sign -> verify still passes (Node AND the browser verifier),
//   * Node and browser canonicalization stay byte-identical WITH the new field,
//   * the canonical bytes of every EXISTING field are unchanged - proven by
//     diffing a pre-red_team build against the post build with red_team stripped,
//   * red_team is inside the signed payload, so tampering a probe breaks verify,
//   * the block leaks no raw PII, and the HTML + PDF render the new section.
//
// Pure in-process; uses the committed dogfood fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { runAudit } from '../src/audit-orchestrator.js';
import {
  buildReportEnvelope,
  buildAndSignReport,
  verifyReport,
  canonicalizeReport as nodeCanonicalizeReport,
  renderReportHtml,
  renderReportPdf,
  buildRedTeamBlock,
} from '../src/attestation-report-builder.js';
import {
  verifyAuditReport,
  canonicalizeReport as browserCanonicalizeReport,
} from '../public/kolm-audit-verify.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function dirtyAudit() {
  return runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
}
const OPTS = { subject: 'Helpwise', report_seed: 'reportv2', generated_at: '2026-06-08T00:00:00.000Z' };

function bufferSink() {
  const chunks = [];
  const w = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  w.collected = () => Buffer.concat(chunks);
  return w;
}

// ---------------------------------------------------------------------------
// the envelope carries a well-formed red_team block.
// ---------------------------------------------------------------------------
test('envelope carries a well-formed red_team block (score + probes)', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  const rt = envelope.red_team;
  assert.ok(rt && typeof rt === 'object', 'red_team present');
  assert.equal(rt.domain, 'finance', 'finance suite for the fixture');
  assert.ok(rt.score === null || (Number.isInteger(rt.score) && rt.score >= 0 && rt.score <= 100));
  assert.ok(Array.isArray(rt.probes) && rt.probes.length >= 6, 'probe table present');
  for (const p of rt.probes) {
    assert.ok(p.id && p.category && p.severity && p.status && p.title, 'probe fields present');
    assert.ok(['resisted', 'exposed', 'untested'].includes(p.status));
    assert.ok(p.frameworks.some((f) => /OWASP/.test(f)) && p.frameworks.some((f) => /MITRE ATLAS/.test(f)), 'OWASP + ATLAS mapping survives into the envelope');
  }
  assert.ok(rt.summary && rt.summary.probes_total === rt.probes.length, 'summary counts present');
});

// ---------------------------------------------------------------------------
// build -> sign -> verify still passes, on BOTH verifiers, with canon parity.
// ---------------------------------------------------------------------------
test('a red_team report signs, verifies (Node + browser), and canonicalizes identically', async () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  assert.equal(verifyReport(envelope).ok, true, 'Node verifyReport passes with red_team in the payload');
  const br = await verifyAuditReport(envelope);
  assert.equal(br.ok, true, 'browser verifyAuditReport passes');
  assert.equal(nodeCanonicalizeReport(envelope), browserCanonicalizeReport(envelope), 'Node and browser canonicalization agree WITH red_team present');
});

// ---------------------------------------------------------------------------
// THE INVARIANT: existing-field canonicalization is byte-unchanged.
// ---------------------------------------------------------------------------
test('adding red_team does not change the canonical bytes of any existing field', () => {
  const audit = dirtyAudit();
  // Pre-red_team baseline (opt-out) vs the full build with red_team stripped.
  const baseline = buildReportEnvelope(audit, { ...OPTS, includeRedTeam: false });
  const full = buildReportEnvelope(audit, OPTS);
  assert.ok(!('red_team' in baseline), 'baseline has no red_team');
  assert.ok('red_team' in full, 'full build adds red_team');

  const stripped = { ...full };
  delete stripped.red_team;
  assert.equal(
    nodeCanonicalizeReport(baseline),
    nodeCanonicalizeReport(stripped),
    'every existing field canonicalizes to the exact same bytes as before red_team existed',
  );
  // And red_team genuinely contributed bytes (the field is not a no-op).
  assert.notEqual(nodeCanonicalizeReport(baseline), nodeCanonicalizeReport(full), 'red_team adds signed bytes');
  assert.ok(nodeCanonicalizeReport(full).includes('"red_team"'), 'red_team is part of the signed payload');
});

test('a fixed seed + generated_at reproduces identical signed bytes including red_team', () => {
  const audit = dirtyAudit();
  const a = buildAndSignReport(audit, OPTS);
  const b = buildAndSignReport(audit, OPTS);
  assert.equal(nodeCanonicalizeReport(a.envelope), nodeCanonicalizeReport(b.envelope), 'same inputs -> same signed bytes');
  assert.equal(a.envelope.signature_ed25519.signature, b.envelope.signature_ed25519.signature, 'same signature');
  assert.deepEqual(a.envelope.red_team, b.envelope.red_team, 'red_team block is reproducible');
});

// ---------------------------------------------------------------------------
// red_team is signature-covered - tampering a probe breaks verification.
// ---------------------------------------------------------------------------
test('tampering a probe status breaks the Ed25519 signature', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  assert.equal(verifyReport(envelope).ok, true);
  const exposed = envelope.red_team.probes.find((p) => p.status === 'exposed');
  assert.ok(exposed, 'fixture has an exposed probe to flip');
  exposed.status = 'resisted'; // the classic "make it look defended" tamper
  const v = verifyReport(envelope);
  assert.equal(v.ok, false, 'flipping a probe to resisted breaks the signature');
  assert.match(v.reason, /does not verify/i);
});

test('tampering the red_team score breaks the signature', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  envelope.red_team.score = 100;
  assert.equal(verifyReport(envelope).ok, false, 'a forged score does not verify');
});

// ---------------------------------------------------------------------------
// robustness - the builder derives red_team if a caller omits it; never leaks PII.
// ---------------------------------------------------------------------------
test('buildReportEnvelope derives red_team when the audit result lacks one', () => {
  const audit = dirtyAudit();
  delete audit.red_team; // a caller that bypassed the orchestrator wiring
  const envelope = buildReportEnvelope(audit, OPTS);
  assert.ok(envelope.red_team && Array.isArray(envelope.red_team.probes), 'red_team derived from events');
  assert.equal(envelope.red_team.domain, 'finance');
});

test('buildRedTeamBlock is null-safe and never leaks raw PII', () => {
  const block = buildRedTeamBlock({});
  assert.ok(block && Array.isArray(block.probes), 'empty audit -> valid block');
  assert.equal(block.score, null);
  // The fixture body carries a fake SSN; it must not survive into the block.
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  assert.ok(!JSON.stringify(envelope.red_team).includes('401-55-9823'), 'no raw PII in the red_team block');
});

// ---------------------------------------------------------------------------
// renderings carry the new section.
// ---------------------------------------------------------------------------
test('renderReportHtml renders the Red-Team Resistance section', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  const html = renderReportHtml(envelope);
  assert.ok(html.includes('Red-Team Resistance:'), 'red-team heading present');
  assert.ok(html.includes('red-team resistance'), 'headline stat present');
  assert.ok(/EXPOSED|RESISTED|UNTESTED/.test(html), 'probe status chips rendered');
  assert.ok(!html.toLowerCase().includes('honest'), 'no banned word');
  assert.ok(!html.includes('401-55-9823'), 'no PII leak into the HTML');
});

test('an empty-input report renders n/a for the red-team score and still verifies', () => {
  const audit = runAudit('', { source: 'import' });
  const { envelope } = buildAndSignReport(audit, { ...OPTS, subject: 'Empty' });
  assert.equal(envelope.red_team.score, null);
  assert.equal(verifyReport(envelope).ok, true, 'a null-score report is a valid signed artifact');
  const html = renderReportHtml(envelope);
  assert.ok(html.includes('Red-Team Resistance: n/a'), 'null score renders as n/a, not a fake number');
});

test('renderReportPdf emits a valid PDF with the red-team section', async () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), OPTS);
  const sink = bufferSink();
  try {
    await renderReportPdf(envelope, sink);
  } catch (e) {
    if (e && e.code === 'PDFKIT_UNAVAILABLE') { assert.ok(true, 'pdfkit absent - guarded path'); return; }
    throw e;
  }
  const buf = sink.collected();
  assert.ok(buf.length > 800, 'PDF has real content');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'PDF magic header');
  assert.ok(buf.slice(-1024).toString('latin1').includes('%%EOF'), 'PDF EOF marker');
});
