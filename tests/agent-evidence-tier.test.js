// Agent Security-Review - evidence tiers inside the signed report envelope.
//
// The independence question ("who says these logs are real?") is answered by
// grading evidence quality INSIDE the signed object:
//   A  events captured by kolm's own gateway at runtime  (kolm-gateway-capture)
//   B  vendor logs whose hash chain verified             (vendor-logs-hash-verified)
//   C  vendor logs without cryptographic continuity      (vendor-logs-asserted)
//
// Proves: grade selection from source + tamper_evident, the Tier-A capture-row
// parser, that evidence_tier is signature-covered (mutating the grade breaks
// the Ed25519 signature), that resignAsTier carries it across the paid
// re-sign, that a legacy envelope without the field still verifies AND renders
// ("not graded"), and the render-order/print rules.
//
// Pure in-process - no spawned server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { runAudit, computeEvidenceTier, EVIDENCE_TIER_METHODS } from '../src/audit-orchestrator.js';
import { ingestForAudit, eventsFromCaptureRow, KOLM_CAPTURE_SOURCE } from '../src/audit-ingest.js';
import {
  buildReportEnvelope,
  buildAndSignReport,
  signReport,
  verifyReport,
  resignAsTier,
  renderReportHtml,
  renderReportPdf,
  coerceEvidenceTier,
} from '../src/attestation-report-builder.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function vendorAudit() {
  // The committed dogfood fixture: a vendor export with NO hash chain -> C.
  return runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
}

function chainedAudit() {
  // A vendor export whose hash chain verifies end to end -> B.
  const rows = [
    { request_id: 'r1', timestamp: '2026-06-01T00:00:00Z', model: 'openai/gpt-4o', user: 'agent-one', hash: 'h1', messages: [{ role: 'user', content: 'first' }] },
    { request_id: 'r2', timestamp: '2026-06-01T00:01:00Z', model: 'openai/gpt-4o', user: 'agent-one', hash: 'h2', prev_hash: 'h1', messages: [{ role: 'user', content: 'second' }] },
  ];
  return runAudit(rows.map((r) => JSON.stringify(r)).join('\n'), { source: 'litellm' });
}

function captureRows() {
  // The two observation-row shapes the kolm gateway stores: a cap_ text row
  // (prompt/response/tool_calls) and an rcpt_ row carrying a signed receipt.
  return [
    {
      id: 'cap_aaa111', tenant: 'acme', tenant_id: 't_acme',
      model: 'openai/gpt-4o', prompt: 'What is the return window?',
      response: 'Thirty days from delivery.',
      tool_calls: [{ name: 'lookup_policy', arguments: '{"topic":"returns"}' }],
      corpus_namespace: 'default', created_at: '2026-06-01T00:00:00Z',
    },
    {
      id: 'rcpt_bbb222', tenant: 'acme', receipt_id: 'rcpt_bbb222',
      ts: 1769904000000, model: 'gpt-4o',
      input_hash: 'sha256:' + 'a'.repeat(32), output_hash: 'sha256:' + 'b'.repeat(32),
      receipt: {
        receipt_id: 'rcpt_bbb222', timestamp: 1769904000000, model: 'gpt-4o',
        signing_key_id: 'key_live_1',
        input_hash: 'sha256:' + 'a'.repeat(32), output_hash: 'sha256:' + 'b'.repeat(32),
        signature_ed25519: { alg: 'ed25519', signature: 'c2lnbmVkLWF0LWNhcHR1cmU' },
      },
    },
  ];
}

function captureAudit() {
  return runAudit(captureRows().map((r) => JSON.stringify(r)).join('\n'), { source: KOLM_CAPTURE_SOURCE });
}

function bufferSink() {
  const chunks = [];
  const w = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  w.collected = () => Buffer.concat(chunks);
  return w;
}

// ---------------------------------------------------------------------------
// grade selection - A from capture source, B from a verified chain, C default.
// ---------------------------------------------------------------------------
test('a vendor export without hashes grades C (vendor-logs-asserted)', () => {
  const audit = vendorAudit();
  const et = audit.evidence_tier;
  assert.ok(et && typeof et === 'object', 'runAudit attaches evidence_tier');
  assert.equal(et.grade, 'C');
  assert.equal(et.method, EVIDENCE_TIER_METHODS.C);
  assert.equal(et.method, 'vendor-logs-asserted');
  assert.ok(Array.isArray(et.basis) && et.basis.length >= 1, 'basis lines present');
  assert.ok(et.basis.some((b) => /no hash chain/i.test(b)), 'C basis explains the missing chain');
});

test('a vendor export whose hash chain verifies grades B (vendor-logs-hash-verified)', () => {
  const audit = chainedAudit();
  assert.equal(audit.summary.tamper_evident, true, 'fixture precondition: the chain verifies');
  const et = audit.evidence_tier;
  assert.equal(et.grade, 'B');
  assert.equal(et.method, 'vendor-logs-hash-verified');
  assert.ok(et.basis.some((b) => /hash chain: \d+ chained, 0 broken/.test(b)), 'B basis carries the chain counts');
});

test('gateway captures grade A (kolm-gateway-capture) with receipt counts in the basis', () => {
  const audit = captureAudit();
  assert.equal(audit.source, KOLM_CAPTURE_SOURCE);
  assert.equal(audit.ingest.records, 2, 'both capture rows ingested');
  const et = audit.evidence_tier;
  assert.equal(et.grade, 'A');
  assert.equal(et.method, 'kolm-gateway-capture');
  assert.ok(et.basis.some((b) => /gateway captures: 2/.test(b)), 'A basis counts the captures');
  assert.ok(et.basis.includes('gateway receipts: 1 signed at capture'), 'signed-at-capture receipts are counted');
});

test('computeEvidenceTier never throws on garbage and stays C', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { source: 7, summary: null }]) {
    let et;
    assert.doesNotThrow(() => { et = computeEvidenceTier(bad); });
    assert.equal(et.grade, 'C');
    assert.equal(et.method, 'vendor-logs-asserted');
  }
});

// ---------------------------------------------------------------------------
// the capture-row parser (Tier-A bridge ingest).
// ---------------------------------------------------------------------------
test('eventsFromCaptureRow handles both observation-row shapes', () => {
  const seen = new Set();
  const [capRow, rcptRow] = captureRows();

  const a = eventsFromCaptureRow(capRow, 0, seen);
  assert.equal(a.error, null);
  const toolEvents = a.events.filter((e) => e.meta.kind === 'tool_call');
  const modelEvents = a.events.filter((e) => e.meta.kind === 'model_call');
  assert.equal(toolEvents.length, 1, 'cap_ row tool_calls become tool events');
  assert.equal(toolEvents[0].action.tool, 'lookup_policy');
  assert.equal(modelEvents.length, 1, 'one model event per capture row');
  assert.equal(modelEvents[0].action.host, 'api.openai.com', 'host derived from the model slug');
  assert.equal(modelEvents[0].meta.capture_id, 'cap_aaa111');

  const b = eventsFromCaptureRow(rcptRow, 1, seen);
  assert.equal(b.error, null);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].meta.kind, 'model_call');
  assert.equal(b.events[0].meta.receipt_signed, true, 'a signed receipt is recorded on meta');
  assert.equal(b.events[0].meta.receipt_id, 'rcpt_bbb222');
  assert.equal(b.events[0].meta.input_hash, 'sha256:' + 'a'.repeat(32));
});

test('a contentless capture row is a clean error, not a phantom event', () => {
  const r = eventsFromCaptureRow({ id: 'cap_empty', tenant: 'acme' }, 0, new Set());
  assert.equal(r.events.length, 0);
  assert.match(r.error, /no auditable action/);
  const viaIngest = ingestForAudit('{"id":"cap_empty","tenant":"acme"}', { source: KOLM_CAPTURE_SOURCE });
  assert.equal(viaIngest.events.length, 0);
  assert.equal(viaIngest.errors.length, 1);
});

// ---------------------------------------------------------------------------
// the signed envelope carries the tier - and the signature covers it.
// ---------------------------------------------------------------------------
test('every envelope carries evidence_tier with the {grade, method, basis} shape', () => {
  for (const audit of [vendorAudit(), chainedAudit(), captureAudit()]) {
    const env = buildReportEnvelope(audit, { subject: 'Shape Co' });
    const et = env.evidence_tier;
    assert.ok(et && typeof et === 'object', 'evidence_tier present in the envelope');
    assert.ok(['A', 'B', 'C'].includes(et.grade));
    assert.equal(typeof et.method, 'string');
    assert.ok(Array.isArray(et.basis));
    assert.deepEqual(et, audit.evidence_tier, 'envelope mirrors the orchestrator grade');
  }
});

test('mutating the evidence grade after signing breaks the signature', () => {
  const { envelope } = buildAndSignReport(vendorAudit(), { subject: 'Tamper Co' });
  assert.equal(envelope.evidence_tier.grade, 'C');
  assert.equal(verifyReport(envelope).ok, true, 'untouched report verifies');
  envelope.evidence_tier.grade = 'A'; // the classic upgrade-the-evidence tamper
  assert.equal(verifyReport(envelope).ok, false, 'upgraded grade does not verify');
  envelope.evidence_tier.grade = 'C';
  assert.equal(verifyReport(envelope).ok, true, 'restored grade verifies again');
  envelope.evidence_tier.basis.push('forged basis line');
  assert.equal(verifyReport(envelope).ok, false, 'an added basis line breaks the signature too');
});

test('resignAsTier preserves evidence_tier across the paid re-sign', () => {
  const { envelope } = buildAndSignReport(captureAudit(), { subject: 'Upgrade Co' });
  assert.equal(envelope.tier, 'scan');
  assert.equal(envelope.evidence_tier.grade, 'A');
  const upgraded = resignAsTier(envelope, 'report');
  assert.equal(upgraded.tier, 'report');
  assert.equal(upgraded.watermark, false);
  assert.deepEqual(upgraded.evidence_tier, envelope.evidence_tier, 'tier block carried verbatim');
  assert.equal(verifyReport(upgraded).ok, true, 're-signed report verifies');
});

// ---------------------------------------------------------------------------
// legacy envelopes (issued before tiered evidence) keep working.
// ---------------------------------------------------------------------------
test('a legacy envelope without evidence_tier still signs, verifies, and renders', async () => {
  const env = buildReportEnvelope(vendorAudit(), { subject: 'Legacy Co' });
  delete env.evidence_tier; // simulate a pre-tier envelope
  signReport(env);
  assert.equal(verifyReport(env).ok, true, 'legacy envelope verifies');

  const html = renderReportHtml(env);
  assert.ok(html.includes('Evidence tier: not graded (issued before tiered evidence)'), 'legacy HTML says not graded');
  assert.ok(!html.includes('EVIDENCE TIER A'), 'no invented grade');

  const sink = bufferSink();
  try {
    await renderReportPdf(env, sink);
  } catch (e) {
    if (e && e.code === 'PDFKIT_UNAVAILABLE') return; // guarded path
    throw e;
  }
  assert.equal(sink.collected().slice(0, 5).toString('latin1'), '%PDF-', 'legacy PDF renders');
});

test('coerceEvidenceTier validates shape and falls back conservatively', () => {
  const good = coerceEvidenceTier({ grade: 'b', method: '', basis: ['x', 7, ''] }, null);
  assert.equal(good.grade, 'B', 'grade is upcased');
  assert.equal(good.method, 'vendor-logs-hash-verified', 'empty method backfilled by grade');
  assert.deepEqual(good.basis, ['x'], 'non-string / empty basis entries dropped');
  const fallback = coerceEvidenceTier({ grade: 'Z' }, { source: 'litellm', summary: {} });
  assert.equal(fallback.grade, 'C', 'an unknown grade falls back, never passes through');
  const capture = coerceEvidenceTier(null, { source: 'kolm-capture', summary: {} });
  assert.equal(capture.grade, 'A');
});

// ---------------------------------------------------------------------------
// renderings - tier banner, scope-first ordering, print rules.
// ---------------------------------------------------------------------------
test('HTML carries the tier banner with the exact grade wording', () => {
  const c = renderReportHtml(buildAndSignReport(vendorAudit(), { subject: 'C Co' }).envelope);
  assert.ok(c.includes('EVIDENCE TIER C - vendor logs as provided'));
  const b = renderReportHtml(buildAndSignReport(chainedAudit(), { subject: 'B Co' }).envelope);
  assert.ok(b.includes('EVIDENCE TIER B - vendor logs, hash chain verified'));
  const a = renderReportHtml(buildAndSignReport(captureAudit(), { subject: 'A Co' }).envelope);
  assert.ok(a.includes('EVIDENCE TIER A - captured by kolm gateway at runtime'));
  assert.ok(a.includes('gateway receipts: 1 signed at capture'), 'basis lines render in the banner');
});

test('HTML states scope BEFORE any findings (scope-first rule) and has a print block', () => {
  const html = renderReportHtml(buildAndSignReport(vendorAudit(), { subject: 'Order Co' }).envelope);
  const scopeAt = html.indexOf('Scope &amp; limitations');
  assert.ok(scopeAt > -1, 'scope section present');
  assert.ok(scopeAt < html.indexOf('<h2>Control status</h2>'), 'scope precedes control status');
  assert.ok(scopeAt < html.indexOf('<h2>Findings</h2>'), 'scope precedes findings');
  assert.ok(html.includes('@media print'), 'print stylesheet present');
  assert.ok(html.includes('break-inside:avoid'), 'findings/sections avoid page breaks in print');
});

test('PDF renders the tier banner and scope-first without throwing', async () => {
  const { envelope } = buildAndSignReport(captureAudit(), { subject: 'PDF Tier Co' });
  const sink = bufferSink();
  try {
    await renderReportPdf(envelope, sink);
  } catch (e) {
    if (e && e.code === 'PDFKIT_UNAVAILABLE') return; // guarded path
    throw e;
  }
  const buf = sink.collected();
  assert.ok(buf.length > 800, 'PDF has real content');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
});

// ---------------------------------------------------------------------------
// brand constraint - the new strings stay clean.
// ---------------------------------------------------------------------------
test('tier strings never use the banned word', () => {
  for (const audit of [vendorAudit(), chainedAudit(), captureAudit()]) {
    const { envelope } = buildAndSignReport(audit, { subject: 'Brand Co' });
    const blob = (JSON.stringify(envelope.evidence_tier) + renderReportHtml(envelope)).toLowerCase();
    assert.ok(!blob.includes('honest'), 'no banned word in tier strings or renders');
  }
});
