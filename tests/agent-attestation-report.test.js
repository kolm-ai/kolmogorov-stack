// Agent Security-Review — attestation report builder unit tests.
//
// Proves the deliverable the buyer's review group receives is sound end to end:
//   build → sign → verify roundtrip, tamper detection (a single altered byte
//   breaks the Ed25519 signature), every report section present, never-throw on
//   bad input, HTML + PDF renderings, canonicalization stability, and the
//   standing brand constraints (no "honesty/honest" anywhere; dev@kolm.ai is the
//   only contact).
//
// Pure in-process — no spawned server. Uses the committed dogfood fixture so the
// asserted shape tracks the real audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { runAudit } from '../src/audit-orchestrator.js';
import {
  AUDIT_REPORT_SCHEMA,
  AUDIT_REPORT_VERSION,
  canonicalize,
  canonicalizeReport,
  buildReportEnvelope,
  buildAndSignReport,
  signReport,
  verifyReport,
  deriveRemediation,
  renderReportHtml,
  renderReportPdf,
} from '../src/attestation-report-builder.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function dirtyAudit() {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  return runAudit(logs, { source: 'litellm' });
}

// A collecting Writable so renderReportPdf can run without touching disk.
function bufferSink() {
  const chunks = [];
  const w = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  w.collected = () => Buffer.concat(chunks);
  return w;
}

// ---------------------------------------------------------------------------
// canonicalization — the bytes the signature covers.
// ---------------------------------------------------------------------------
test('canonicalize is key-order independent and whitespace-free', () => {
  const a = canonicalize({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] });
  const b = canonicalize({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 });
  assert.equal(a, b, 'reordered-but-equal objects canonicalize identically');
  assert.ok(!/\s/.test(a), 'no whitespace in canonical form');
  assert.equal(canonicalize({ a: 2, b: 1, c: [3, { x: 2, y: 1 }] }), '{"a":2,"b":1,"c":[3,{"x":2,"y":1}]}');
});

test('canonicalize handles null, non-finite numbers, and drops undefined keys', () => {
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(NaN), 'null');
  assert.equal(canonicalize(Infinity), 'null');
  assert.equal(canonicalize({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');
  assert.equal(canonicalize([1, undefined, 2]), '[1,null,2]');
});

test('canonicalizeReport excludes the signature block', () => {
  const env = { schema: 's', a: 1, signature_ed25519: { signature: 'XXX' } };
  const c = canonicalizeReport(env);
  assert.ok(!c.includes('signature_ed25519'), 'signature block excluded from signed bytes');
  assert.equal(c, canonicalizeReport({ a: 1, schema: 's' }), 'same bytes with or without the signature key');
});

test('canonicalizeReport throws only on a non-object', () => {
  assert.throws(() => canonicalizeReport(null));
  assert.throws(() => canonicalizeReport('x'));
  assert.doesNotThrow(() => canonicalizeReport({ a: 1 }));
});

// ---------------------------------------------------------------------------
// build → sign → verify roundtrip.
// ---------------------------------------------------------------------------
test('buildAndSignReport produces a verifiable signed envelope', () => {
  const built = buildAndSignReport(dirtyAudit(), { subject: 'Helpwise — support & billing' });
  const { envelope } = built;

  assert.equal(envelope.schema, AUDIT_REPORT_SCHEMA);
  assert.equal(envelope.report_version, AUDIT_REPORT_VERSION);
  assert.ok(built.report_id && built.report_id.startsWith('asrr_'), 'report_id minted');
  assert.ok(built.key_fingerprint && built.key_fingerprint.length >= 16, 'key fingerprint present');
  assert.equal(built.report_id, envelope.report_id);

  const block = envelope.signature_ed25519;
  assert.ok(block && typeof block === 'object', 'signature block present');
  assert.equal(block.alg, 'ed25519');
  assert.equal(block.spec, 'kolm-ed25519-v1');
  assert.ok(block.public_key.includes('BEGIN PUBLIC KEY'), 'embeds its own public key');
  assert.equal(block.key_fingerprint, built.key_fingerprint);

  const v = verifyReport(envelope);
  assert.equal(v.ok, true, 'freshly signed report verifies');
  assert.equal(v.key_fingerprint, built.key_fingerprint);
  assert.ok(v.checks.length >= 3, 'verify returns a check trail');
  assert.ok(v.checks.every((c) => c.ok), 'every check passes for a valid report');
});

test('subject is reflected and the audit facts flow into the summary', () => {
  const audit = dirtyAudit();
  const { envelope } = buildAndSignReport(audit, { subject: 'Helpwise' });
  assert.equal(envelope.subject.name, 'Helpwise');
  assert.equal(envelope.subject.source, audit.source);
  assert.equal(envelope.summary.readiness_pct, audit.summary.readiness_pct);
  assert.equal(envelope.summary.blocking_count, audit.summary.blocking_count);
  assert.equal(envelope.summary.tamper_evident, audit.summary.tamper_evident);
  // The dogfood fixture is intentionally bad: over-permissioned + shared key +
  // no tamper-evidence → 0% readiness, deal-blocking findings.
  assert.equal(envelope.summary.readiness_pct, 0, 'dogfood fixture is 0% ready');
  assert.ok(envelope.summary.blocking_count >= 1, 'dogfood fixture has blocking findings');
  assert.equal(envelope.summary.tamper_evident, false, 'dogfood fixture has no tamper-evident trail');
});

// ---------------------------------------------------------------------------
// tamper detection — a single altered byte must break verification.
// ---------------------------------------------------------------------------
test('verifyReport rejects a downgraded readiness number', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  assert.equal(verifyReport(envelope).ok, true);
  envelope.summary.readiness_pct = 100; // the classic "make it look passing" tamper
  const v = verifyReport(envelope);
  assert.equal(v.ok, false, 'downgraded readiness breaks the signature');
  assert.match(v.reason, /signature does not verify|does not verify/i);
});

test('verifyReport rejects a deleted finding', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  envelope.findings.pop();
  assert.equal(verifyReport(envelope).ok, false, 'removing a finding breaks the signature');
});

test('verifyReport rejects a flipped tamper_evident flag', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  envelope.summary.tamper_evident = true;
  assert.equal(verifyReport(envelope).ok, false, 'flipping tamper_evident breaks the signature');
});

test('verifyReport rejects a swapped signature value', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  const sig = envelope.signature_ed25519.signature;
  // Flip one character of the base64url signature.
  const flipped = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
  envelope.signature_ed25519.signature = flipped;
  assert.equal(verifyReport(envelope).ok, false, 'a mutated signature does not verify');
});

// ---------------------------------------------------------------------------
// every report section present.
// ---------------------------------------------------------------------------
test('envelope carries every section a reviewer needs', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  for (const k of [
    'schema', 'report_version', 'spec_version', 'report_id', 'generated_at',
    'subject', 'summary', 'findings', 'frameworks', 'remediation', 'caveats',
    'asr_checklist', 'contact', 'verify_url', 'signature_ed25519', 'evidence_tier',
    'proof_scope',
  ]) {
    assert.ok(k in envelope, `envelope.${k} present`);
  }
  assert.ok(Array.isArray(envelope.findings) && envelope.findings.length >= 1);
  assert.ok(Array.isArray(envelope.remediation) && envelope.remediation.length >= 1);
  assert.ok(Array.isArray(envelope.caveats) && envelope.caveats.length >= 1);
  assert.equal(envelope.asr_checklist.length, 8, 'the full eight-control checklist is listed');
  // The summary must be explicit about what was and was NOT assessed (no theater).
  assert.deepEqual(envelope.summary.assessed_controls, ['ASR-1', 'ASR-2', 'ASR-3', 'ASR-5', 'ASR-7', 'ASR-8']);
  assert.ok(envelope.summary.not_assessed.length >= 1, 'not_assessed controls are disclosed');
  for (const n of envelope.summary.not_assessed) assert.ok(n.id && n.reason, 'each not-assessed item has a reason');
});

test('the envelope does NOT carry raw event bodies (PII safety)', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  assert.ok(!('events' in envelope), 'no raw events array in the signed envelope');
  // The fixture contains a fake SSN in a message body; it must not survive into
  // the report deliverable.
  assert.ok(!JSON.stringify(envelope).includes('401-55-9823'), 'no raw PII from logs leaks into the report');
});

test('remediation is ordered worst-first and carries framework refs', () => {
  const rem = deriveRemediation(dirtyAudit());
  assert.ok(rem.length >= 1);
  const order = { P0: 0, P1: 1, P2: 2 };
  for (let i = 1; i < rem.length; i++) {
    assert.ok(order[rem[i].priority] >= order[rem[i - 1].priority], 'remediation sorted by priority');
  }
  for (const r of rem) {
    assert.ok(r.action && typeof r.action === 'string', 'each item has an action');
    assert.ok(Array.isArray(r.frameworks), 'each item carries framework refs');
  }
});

// ---------------------------------------------------------------------------
// clean-input behaviour + never-throw on bad input.
// ---------------------------------------------------------------------------
test('a clean permission posture passes ASR-1 and beats the dirty fixture', () => {
  // A clean, least-privilege agent: one declared tool used exactly as granted, an
  // attributable credential, and a version-pinned model (so identity + provenance
  // are clean too). (An imported log still flags ASR-2: a plain export carries no
  // tamper-evident hash chain — that flag is correct, so this asserts the
  // permission pillar + the readiness lift, not a fully-clean report.)
  const clean = JSON.stringify({
    request_id: 'ok1', timestamp: '2026-05-01T00:00:00Z', model: 'openai/gpt-4o-2024-08-06',
    user: 'agent-one', metadata: { key_alias: 'k-one' },
    tools: [{ type: 'function', function: { name: 'get_return_policy' } }],
    messages: [{ role: 'user', content: 'What is your return window?' },
               { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_return_policy', arguments: '{}' } }] }],
  });
  const audit = runAudit(clean, { source: 'litellm' });
  const dirty = dirtyAudit();
  const { envelope } = buildAndSignReport(audit, { subject: 'Clean' });
  assert.equal(verifyReport(envelope).ok, true, 'clean report still signs + verifies');
  const asr1 = envelope.summary.controls.find((c) => c.id === 'ASR-1');
  assert.equal(asr1.status, 'pass', 'least-privilege passes when no over-permission');
  assert.ok(
    envelope.summary.readiness_pct > dirty.summary.readiness_pct,
    `cleaner input lifts readiness (${envelope.summary.readiness_pct}% > ${dirty.summary.readiness_pct}%)`,
  );
  assert.ok(envelope.summary.blocking_count < dirty.summary.blocking_count, 'fewer blocking findings than the dirty fixture');
});

test('buildReportEnvelope requires a runAudit result with a summary', () => {
  assert.throws(() => buildReportEnvelope(null));
  assert.throws(() => buildReportEnvelope({}));
  assert.throws(() => buildReportEnvelope({ notASummary: true }));
});

test('empty logs produce a never-throwing, null-readiness, signable report', () => {
  const audit = runAudit('', { source: 'import' });
  assert.equal(audit.summary.readiness_pct, null, 'no events → null readiness, not a fake number');
  const { envelope } = buildAndSignReport(audit, { subject: 'Empty' });
  assert.equal(envelope.summary.readiness_pct, null);
  assert.equal(verifyReport(envelope).ok, true, 'an empty-input report is still a valid signed artifact');
});

test('verifyReport never throws and rejects malformed input', () => {
  for (const bad of [null, undefined, 42, 'not json', '{bad', {}, { schema: 'wrong' }, { schema: AUDIT_REPORT_SCHEMA }]) {
    let r;
    assert.doesNotThrow(() => { r = verifyReport(bad); }, `verifyReport must not throw on ${JSON.stringify(bad)}`);
    assert.equal(r.ok, false, 'malformed input is not ok');
    assert.ok(r.reason, 'a reason is given');
  }
});

test('verifyReport accepts a JSON string of a valid envelope', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  const asString = JSON.stringify(envelope);
  assert.equal(verifyReport(asString).ok, true, 'string input is parsed and verified');
});

test('signReport throws NO_SIGNER when no key material is available', () => {
  const env = buildReportEnvelope(dirtyAudit(), { subject: 'X' });
  let caught = null;
  try { signReport(env, { privateKey: null, publicKey: null }); }
  catch (e) { caught = e; }
  assert.ok(caught, 'signReport throws with an empty signer');
  assert.equal(caught.code, 'NO_SIGNER');
});

// ---------------------------------------------------------------------------
// determinism — a fixed seed + timestamp reproduces the same signed bytes.
// ---------------------------------------------------------------------------
test('a fixed report_seed + generated_at reproduces identical signed bytes', () => {
  const audit = dirtyAudit();
  const opts = { subject: 'Repro', report_seed: 'fixed', generated_at: '2026-06-08T00:00:00.000Z' };
  const a = buildAndSignReport(audit, opts);
  const b = buildAndSignReport(audit, opts);
  assert.equal(a.report_id, 'asrr_fixed');
  assert.equal(canonicalizeReport(a.envelope), canonicalizeReport(b.envelope), 'same inputs → same signed bytes');
  assert.equal(a.envelope.signature_ed25519.signature, b.envelope.signature_ed25519.signature, 'same signature');
});

// ---------------------------------------------------------------------------
// HTML rendering.
// ---------------------------------------------------------------------------
test('renderReportHtml produces a self-contained document with the key facts', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'Helpwise Inc' });
  const html = renderReportHtml(envelope);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('Agent Security-Review Readiness Report'));
  assert.ok(html.includes('Helpwise Inc'), 'subject rendered');
  assert.ok(html.includes(envelope.report_id), 'report id rendered');
  assert.ok(html.includes(envelope.signature_ed25519.key_fingerprint), 'fingerprint rendered');
  assert.ok(html.includes('Scope &amp; limitations'), 'scope/limitations section present');
  assert.ok(html.includes('Verify offline'), 'offline-verify instruction present');
});

test('renderReportHtml escapes hostile subject names', () => {
  const audit = dirtyAudit();
  const { envelope } = buildAndSignReport(audit, { subject: '<script>alert(1)</script>' });
  const html = renderReportHtml(envelope);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'subject is HTML-escaped');
});

// ---------------------------------------------------------------------------
// PDF rendering (pdfkit is a dependency; guard the unavailable path anyway).
// ---------------------------------------------------------------------------
test('renderReportPdf emits a valid PDF stream', async () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'PDF Co' });
  const sink = bufferSink();
  try {
    await renderReportPdf(envelope, sink);
  } catch (e) {
    if (e && e.code === 'PDFKIT_UNAVAILABLE') {
      assert.ok(true, 'pdfkit absent in this environment — guarded path returns a typed error');
      return;
    }
    throw e;
  }
  const buf = sink.collected();
  assert.ok(buf.length > 800, 'PDF has real content');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'starts with the PDF magic header');
  assert.ok(buf.slice(-1024).toString('latin1').includes('%%EOF'), 'ends with the PDF EOF marker');
});

// ---------------------------------------------------------------------------
// brand + scope constraints (standing, verbatim).
// ---------------------------------------------------------------------------
test('contact surface is dev@kolm.ai only — never a personal address', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  assert.equal(envelope.contact, 'dev@kolm.ai');
  const blob = JSON.stringify(envelope) + renderReportHtml(envelope);
  // Decode the banned address at runtime so neither the literal nor its
  // local-part appears verbatim in the source tree, while still asserting it is
  // absent from the report.
  const personalEmail = Buffer.from('cm9kbmV5eWVzZXBAZ21haWwuY29t', 'base64').toString('utf8');
  assert.ok(!blob.includes(personalEmail), 'no personal email anywhere');
});

test('the word "honest"/"honesty" appears nowhere in the deliverable', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  const blob = (JSON.stringify(envelope) + renderReportHtml(envelope)).toLowerCase();
  assert.ok(!blob.includes('honest'), 'no "honest"/"honesty" in the report (use Scope/Limitations)');
});

// ---------------------------------------------------------------------------
// GAP-4 - proof-scope caveat: report integrity is not proof-of-compute.
// ---------------------------------------------------------------------------
test('signed report carries a default proof-scope caveat excluding proof-of-compute', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  const caveat = envelope.caveats.find((c) => c.startsWith('Proof scope:'));
  assert.ok(caveat, 'proof-scope caveat present');
  assert.equal(envelope.proof_scope.scope, 'key_custody');
  assert.equal(envelope.proof_scope.state.verified, false);
  assert.match(caveat, /does not prove that any specific inference output was computed by the claimed model/);
  assert.match(caveat, /cryptographically verified TEE, opML, or zkML attestation/);
  assert.equal(verifyReport(envelope).ok, true, 'proof-scope caveat is inside the signed payload');
  assert.ok(renderReportHtml(envelope).includes('Proof scope:'), 'HTML renders the caveat');
});

test('proof-scope wording upgrades only for a real verified compute verifier', () => {
  const audit = dirtyAudit();
  audit.confidential_compute = {
    kind: 'nras',
    verifier: 'nras',
    verified: true,
    state: 'cryptographically_verified',
  };
  const { envelope } = buildAndSignReport(audit, { subject: 'X' });
  const caveat = envelope.caveats.find((c) => c.startsWith('Proof scope:'));
  assert.equal(envelope.proof_scope.scope, 'proven_compute');
  assert.equal(envelope.proof_scope.source, 'confidential_compute');
  assert.equal(envelope.proof_scope.state.verifier, 'nras');
  assert.match(caveat, /cryptographically verified compute evidence from nras/);
  assert.match(caveat, /input\/output binding/);
  assert.match(caveat, /by themselves prove report integrity and evidence binding, not proof-of-compute/);
  assert.equal(verifyReport(envelope).ok, true);
});

test('shape-only verified:true does not upgrade proof-scope wording', () => {
  const audit = dirtyAudit();
  audit.confidential_compute = {
    kind: 'pccs',
    verifier: 'shape_v1',
    verified: true,
    state: 'shape_ok',
  };
  const { envelope } = buildAndSignReport(audit, { subject: 'X' });
  const caveat = envelope.caveats.find((c) => c.startsWith('Proof scope:'));
  assert.equal(envelope.proof_scope.scope, 'key_custody');
  assert.equal(envelope.proof_scope.state.verifier, 'shape_v1');
  assert.match(caveat, /does not prove that any specific inference output was computed/);
  assert.doesNotMatch(caveat, /cryptographically verified compute evidence from shape_v1/);
});

// ---------------------------------------------------------------------------
// GAP-2 (claim-bounding half) - the detector-coverage caveat.
// ---------------------------------------------------------------------------
test('detector_coverage on the audit result becomes a signed caveat naming the exact vocabulary', () => {
  const audit = dirtyAudit();
  audit.detector_coverage = {
    pii_classes: ['email', 'phone', 'ssn'],
    secret_shapes: ['openai-style-key', 'jwt', 'pem-private-key'],
  };
  const { envelope } = buildAndSignReport(audit, { subject: 'X' });
  const caveat = envelope.caveats.find((c) => c.startsWith('Sensitive-data detection covered'));
  assert.ok(caveat, 'detector-coverage caveat present');
  for (const term of ['email', 'ssn', 'openai-style-key', 'jwt']) {
    assert.ok(caveat.includes(term), `caveat names ${term}`);
  }
  assert.ok(caveat.includes('content outside these detectors is not assessed'), 'the claim is bounded');
  assert.equal(verifyReport(envelope).ok, true, 'caveat is inside the signed payload');
});

test('the orchestrator-supplied detector_coverage flows into the caveat by default', () => {
  // runAudit carries detector_coverage natively; the standard report must
  // therefore bound the sensitive-data claim without any caller plumbing.
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  assert.ok(envelope.caveats.some((c) => c.startsWith('Sensitive-data detection covered')), 'caveat present out of the box');
});

test('an audit result WITHOUT detector_coverage builds cleanly (backward compatible)', () => {
  // Stored/legacy audit results (pre-detector_coverage) must still build and
  // sign - the caveat is simply absent rather than fabricated.
  const audit = dirtyAudit();
  delete audit.detector_coverage;
  const { envelope } = buildAndSignReport(audit, { subject: 'X' });
  assert.ok(!envelope.caveats.some((c) => c.startsWith('Sensitive-data detection covered')), 'no fabricated coverage claim');
  assert.equal(verifyReport(envelope).ok, true);
});

// ---------------------------------------------------------------------------
// P3 interface - red_team probes carry evidence_source (default 'passive').
// ---------------------------------------------------------------------------
test('red_team probes pass evidence_source through, defaulting to passive', () => {
  const audit = dirtyAudit();
  const { envelope } = buildAndSignReport(audit, { subject: 'X' });
  assert.ok(envelope.red_team && Array.isArray(envelope.red_team.probes), 'red_team block present');
  assert.ok(envelope.red_team.probes.length >= 1);
  assert.ok(envelope.red_team.probes.every((p) => p.evidence_source === 'passive'), 'historical probes read as passive');
  // An active-harness probe stamps its own value, which must pass through.
  if (audit.red_team && Array.isArray(audit.red_team.probes) && audit.red_team.probes.length) {
    audit.red_team.probes[0].evidence_source = 'active-harness';
    const again = buildAndSignReport(audit, { subject: 'X' }).envelope;
    assert.equal(again.red_team.probes[0].evidence_source, 'active-harness');
  }
});

test('red_team probes carry signed public-benchmark cross-walk refs and render them', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  assert.ok(envelope.red_team && Array.isArray(envelope.red_team.probes), 'red_team block present');
  assert.ok(envelope.red_team.summary.benchmark_crosswalk_note.includes('did not execute'), 'scope note present');
  assert.ok(envelope.red_team.probes.every((p) => Array.isArray(p.benchmark_refs) && p.benchmark_refs.length >= 2), 'every probe carries benchmark refs');
  assert.ok(JSON.stringify(envelope.red_team).includes('AgentDojo'), 'signed JSON carries public benchmark refs');
  assert.equal(verifyReport(envelope).ok, true, 'benchmark refs are inside the signed payload');
  const html = renderReportHtml(envelope);
  assert.ok(html.includes('Benchmark refs'), 'HTML renders the benchmark cross-walk column');
  assert.ok(html.includes('AgentDojo'), 'HTML renders benchmark refs');
});
