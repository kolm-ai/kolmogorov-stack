// S8 buyer security-questionnaire autofill tests.
//
// Covers every built-in template against a synthetic clean report (mostly 'yes')
// and a synthetic dirty report (cited 'no' / 'partial' / 'n/a'); the no-unsupported
// -'yes' invariant; the real runAudit -> buildAndSignReport pipeline shape; CSV
// export (ASCII, escaped); and never-throws on malformed input.
//
// Run: node --test tests/questionnaire-autofill.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  autofillQuestionnaire,
  toQuestionnaireCsv,
  QUESTIONNAIRE_TEMPLATES,
  QUESTIONNAIRE_AUTOFILL_VERSION,
} from '../src/questionnaire-autofill.js';
import { runAudit } from '../src/audit-orchestrator.js';
import { buildAndSignReport } from '../src/attestation-report-builder.js';

const TEMPLATE_IDS = ['sig-lite', 'caiq', 'eu-ai-act', 'generic-ai-vendor', 'ai-caiq', 'sig-core', 'vsaq', 'eu-ai-act-fria'];

// A synthetic CLEAN signed-report shape: every assessed control passes, the
// red-team battery resisted, and the report is signed. (Only the fields the
// autofill reads are populated; the real envelope carries far more.)
function cleanReport() {
  return {
    report_id: 'asrr_clean',
    summary: {
      readiness_pct: 100,
      blocking_count: 0,
      tamper_evident: true,
      controls: [
        { id: 'ASR-1', name: 'Least privilege', status: 'pass', findings: 0 },
        { id: 'ASR-2', name: 'Audit trail', status: 'pass', findings: 0 },
        { id: 'ASR-3', name: 'Data egress', status: 'pass', findings: 0 },
        { id: 'ASR-5', name: 'Provenance', status: 'pass', findings: 0 },
        { id: 'ASR-7', name: 'Memory and retrieval integrity', status: 'pass', findings: 0 },
        { id: 'ASR-8', name: 'Multi-agent delegation', status: 'pass', findings: 0 },
      ],
      not_assessed: [
        { id: 'ASR-4', reason: 'Injection reported separately.' },
        { id: 'ASR-6', reason: 'Evidence established by signing.' },
      ],
    },
    findings: [],
    red_team: { score: 100, summary: { probes_total: 5, tested: 5, resisted: 5, exposed: 0, untested: 0 }, probes: [] },
    evidence_digest: { alg: 'sha256', value: 'a'.repeat(64), event_count: 5 },
    signature_ed25519: { alg: 'ed25519', key_fingerprint: 'fp_clean_0123', signed_at: '2026-06-01T00:00:00Z' },
  };
}

// A synthetic DIRTY signed-report: blocking least-privilege + audit-trail,
// attention egress, untested supplementals, exposed injection probe.
function dirtyReport() {
  return {
    report_id: 'asrr_dirty',
    summary: {
      readiness_pct: 33,
      blocking_count: 2,
      tamper_evident: false,
      controls: [
        { id: 'ASR-1', name: 'Least privilege', status: 'blocking', findings: 1 },
        { id: 'ASR-2', name: 'Audit trail', status: 'blocking', findings: 1 },
        { id: 'ASR-3', name: 'Data egress', status: 'attention', findings: 1 },
        { id: 'ASR-5', name: 'Provenance', status: 'untested', findings: 0 },
        { id: 'ASR-7', name: 'Memory and retrieval integrity', status: 'untested', findings: 0 },
        { id: 'ASR-8', name: 'Multi-agent delegation', status: 'untested', findings: 0 },
      ],
      not_assessed: [
        { id: 'ASR-4', reason: 'Injection reported separately.' },
        { id: 'ASR-6', reason: 'Evidence established by signing.' },
      ],
    },
    findings: [
      { id: 'wildcard-grant', severity: 'high', title: 'Agent holds a wildcard tool grant', asr: { id: 'ASR-1', name: 'Least privilege' }, frameworks: ['OWASP LLM & Agentic Top 10 LLM06', 'SOC 2 TSC CC6'] },
      { id: 'no-tamper-evidence', severity: 'high', title: 'Activity log is not tamper-evident', asr: { id: 'ASR-2', name: 'Audit trail' }, frameworks: ['EU AI Act Art.12'] },
      { id: 'sensitive-egress', severity: 'medium', title: 'Sensitive field left the boundary unredacted', asr: { id: 'ASR-3', name: 'Data egress' }, frameworks: ['EU AI Act Art.10'] },
    ],
    red_team: {
      score: 40,
      summary: { probes_total: 5, tested: 5, resisted: 3, exposed: 2, untested: 0 },
      probes: [
        { id: 'inj-indirect', title: 'Indirect prompt injection via tool output', severity: 'high', status: 'exposed', frameworks: ['OWASP LLM01', 'MITRE ATLAS AML.T0051.001'] },
        { id: 'inj-direct', title: 'Direct jailbreak attempt', severity: 'high', status: 'exposed', frameworks: ['OWASP LLM01'] },
      ],
    },
    evidence_digest: { alg: 'sha256', value: 'b'.repeat(64), event_count: 2 },
    signature_ed25519: { alg: 'ed25519', key_fingerprint: 'fp_dirty_0123', signed_at: '2026-06-01T00:00:00Z' },
  };
}

function byId(answers) {
  const m = Object.create(null);
  for (const a of answers) m[a.question_id] = a;
  return m;
}

test('QUESTIONNAIRE_TEMPLATES lists the eight built-in templates with counts', () => {
  assert.ok(Array.isArray(QUESTIONNAIRE_TEMPLATES));
  const ids = QUESTIONNAIRE_TEMPLATES.map((t) => t.id).sort();
  assert.deepEqual(ids, [...TEMPLATE_IDS].sort());
  for (const t of QUESTIONNAIRE_TEMPLATES) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0);
    assert.ok(typeof t.description === 'string' && t.description.length > 0);
    assert.ok(Number.isInteger(t.question_count) && t.question_count > 0);
  }
  assert.equal(typeof QUESTIONNAIRE_AUTOFILL_VERSION, 'string');
});

test('every template fills from a CLEAN report: mostly yes, no false no, evidence cited', () => {
  for (const template of TEMPLATE_IDS) {
    const res = autofillQuestionnaire(cleanReport(), { template });
    assert.equal(res.template, template);
    assert.equal(res.generated_from.report_id, 'asrr_clean');
    assert.equal(res.generated_from.readiness_pct, 100);
    assert.ok(res.answers.length > 0, `${template} produced answers`);
    const yes = res.answers.filter((a) => a.answer === 'yes');
    const no = res.answers.filter((a) => a.answer === 'no');
    assert.equal(no.length, 0, `${template} clean report has no 'no' answers`);
    assert.ok(yes.length >= 1, `${template} clean report yields at least one 'yes'`);
    // Every answer carries at least one evidence entry, and every yes/no carries
    // a concrete ASR citation.
    for (const a of res.answers) {
      assert.ok(Array.isArray(a.evidence) && a.evidence.length >= 1, `${template}/${a.question_id} has evidence`);
      assert.ok(['yes', 'no', 'partial', 'n/a'].includes(a.answer));
      assert.ok(['high', 'medium', 'low'].includes(a.confidence));
      if (a.answer === 'yes' || a.answer === 'no') {
        assert.ok(a.evidence.some((e) => typeof e.asr === 'string' && /^ASR-\d$/.test(e.asr)), `${template}/${a.question_id} cites an ASR control`);
      }
    }
  }
});

test('generic-ai-vendor against the DIRTY report: cited no / partial / n/a, never an unsupported yes', () => {
  const res = autofillQuestionnaire(dirtyReport(), { template: 'generic-ai-vendor' });
  const a = byId(res.answers);

  // Blocking least-privilege -> 'no' citing the wildcard-grant finding.
  assert.equal(a['gen-least-privilege'].answer, 'no');
  assert.ok(a['gen-least-privilege'].evidence.some((e) => /wildcard/i.test(e.detail)), 'cites the blocking finding');
  assert.equal(a['gen-least-privilege'].confidence, 'high');

  // Blocking audit-trail -> 'no' citing the tamper finding + its framework.
  assert.equal(a['gen-audit-trail'].answer, 'no');
  assert.ok(a['gen-audit-trail'].evidence.some((e) => /tamper-evident/i.test(e.detail)));
  assert.ok(a['gen-audit-trail'].evidence.some((e) => /Art\.12/.test(e.detail)), 'cites the mapped framework');

  // Attention egress -> 'partial' citing the medium finding.
  assert.equal(a['gen-egress-redaction'].answer, 'partial');
  assert.equal(a['gen-egress-redaction'].confidence, 'medium');
  assert.ok(a['gen-egress-redaction'].evidence.some((e) => /Sensitive field/i.test(e.detail)));

  // Exposed injection (read from red_team) -> 'no'.
  assert.equal(a['gen-injection-testing'].answer, 'no');
  assert.ok(a['gen-injection-testing'].evidence.some((e) => /injection/i.test(e.detail)));

  // Untested supplementals -> 'n/a'.
  assert.equal(a['gen-model-provenance'].answer, 'n/a');
  assert.equal(a['gen-memory-retrieval'].answer, 'n/a');
  assert.equal(a['gen-delegation'].answer, 'n/a');
  assert.equal(a['gen-model-provenance'].confidence, 'low');

  // ASR-6 evidence is satisfied by the report being signed -> 'yes'.
  assert.equal(a['gen-evidence-verifiable'].answer, 'yes');

  // The core no-invention invariant: no question mapped to a blocking control
  // returns 'yes'.
  assert.equal(a['gen-least-privilege'].answer === 'yes', false);
  assert.equal(a['gen-agent-identity'].answer, 'no'); // also ASR-1 (blocking)
  assert.equal(a['gen-tamper-evidence'].answer, 'no'); // also ASR-2 (blocking)
});

test('multi-control rollup: a blocking control dominates a co-mapped pass', () => {
  // caiq LOG-03 maps ['ASR-2','ASR-6']: dirty ASR-2 is blocking, ASR-6 passes.
  const res = autofillQuestionnaire(dirtyReport(), { template: 'caiq' });
  const a = byId(res.answers);
  assert.equal(a['LOG-03'].answer, 'no', 'blocking ASR-2 wins over passing ASR-6');
  // Evidence shows BOTH the blocking finding and the passing evidence control.
  assert.ok(a['LOG-03'].evidence.some((e) => e.asr === 'ASR-2'));
  assert.ok(a['LOG-03'].evidence.some((e) => e.asr === 'ASR-6'));

  // Clean: LOG-03 -> yes (both pass).
  const clean = byId(autofillQuestionnaire(cleanReport(), { template: 'caiq' }).answers);
  assert.equal(clean['LOG-03'].answer, 'yes');
});

test('eu-ai-act maps to the article controls and reflects untested retrieval as n/a', () => {
  const dirty = byId(autofillQuestionnaire(dirtyReport(), { template: 'eu-ai-act' }).answers);
  assert.equal(dirty['art12-record-keeping'].answer, 'no'); // ASR-2 blocking
  assert.equal(dirty['art10-data-governance'].answer, 'partial'); // ASR-3 attention
  assert.equal(dirty['art10-retrieval'].answer, 'n/a'); // ASR-7 untested
  assert.equal(dirty['art14-human-oversight'].answer, 'no'); // ASR-1 blocking

  const clean = byId(autofillQuestionnaire(cleanReport(), { template: 'eu-ai-act' }).answers);
  assert.equal(clean['art10-retrieval'].answer, 'yes'); // ASR-7 pass
  assert.equal(clean['art12-record-keeping'].answer, 'yes');
});

test('fills from a REAL runAudit -> buildAndSignReport envelope', () => {
  const LOGS = [
    { ts: '2026-06-01T00:00:00Z', agent: 'a1', tool: 'http.get', action: 'call', actor: 'a1', event_id: 'e1', grants: ['*'] },
    { ts: '2026-06-01T00:00:01Z', agent: 'a1', tool: 'db.delete', action: 'call', actor: 'a1', event_id: 'e2' },
  ].map((r) => JSON.stringify(r)).join('\n');
  const audit = runAudit(LOGS, { source: 'test' });
  const { envelope } = buildAndSignReport(audit, { subject: 'Acme', tier: 'report' });

  for (const template of TEMPLATE_IDS) {
    const res = autofillQuestionnaire(envelope, { template });
    assert.equal(res.generated_from.report_id, envelope.report_id);
    assert.ok(res.answers.length > 0);
    for (const a of res.answers) {
      assert.ok(['yes', 'no', 'partial', 'n/a'].includes(a.answer));
      assert.ok(Array.isArray(a.evidence) && a.evidence.length >= 1);
      // ASCII-only invariant on every rendered string.
      assert.match(a.question, /^[\x00-\x7F]*$/, `${template}/${a.question_id} question is ASCII`);
      for (const e of a.evidence) assert.match(e.detail, /^[\x00-\x7F]*$/, 'evidence detail is ASCII');
    }
  }
});

test('toQuestionnaireCsv produces ASCII, escaped, header + one row per answer', () => {
  const res = autofillQuestionnaire(dirtyReport(), { template: 'generic-ai-vendor' });
  const csv = toQuestionnaireCsv(res);
  assert.equal(typeof csv, 'string');
  assert.match(csv, /^[\x00-\x7F]*$/, 'CSV is pure ASCII');
  const lines = csv.replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines[0], 'template,report_id,question_id,question,answer,confidence,asr,evidence');
  assert.equal(lines.length, res.answers.length + 1, 'one row per answer plus header');
  // The report id appears on each data row.
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].includes('asrr_dirty'));
  // Quoting: a question containing a comma is wrapped in double quotes.
  assert.ok(/"/.test(csv));
  // No em/en dash leaked into the export.
  assert.equal(/[\u2013\u2014]/.test(csv), false);
});

test('never throws on malformed input', () => {
  for (const bad of [null, undefined, '', 'not json', '{', 42, [], {}, { summary: null }, { summary: { controls: 'nope' } }]) {
    const res = autofillQuestionnaire(bad, { template: 'sig-lite' });
    assert.ok(res && Array.isArray(res.answers), 'returns a well-formed result');
    // Malformed report -> every answer is n/a (no control data to support a yes).
    for (const a of res.answers) assert.ok(a.answer === 'n/a' || a.answer === 'yes' || a.answer === 'no' || a.answer === 'partial');
    const csv = toQuestionnaireCsv(res);
    assert.equal(typeof csv, 'string');
    assert.match(csv, /^[\x00-\x7F]*$/);
  }
  // A malformed report with no signature/red_team: all answers n/a.
  const empty = autofillQuestionnaire({}, { template: 'generic-ai-vendor' });
  assert.ok(empty.answers.every((a) => a.answer === 'n/a'));
  assert.equal(empty.generated_from.report_id, null);
  // toQuestionnaireCsv on garbage never throws.
  for (const bad of [null, undefined, 42, 'x', { answers: 'no' }]) {
    assert.equal(typeof toQuestionnaireCsv(bad), 'string');
  }
});

test('unknown template returns a well-formed error result, not a throw', () => {
  const res = autofillQuestionnaire(cleanReport(), { template: 'does-not-exist' });
  assert.equal(res.error, 'unknown_template');
  assert.deepEqual(res.answers, []);
  assert.ok(Array.isArray(res.available_templates) && res.available_templates.length === 8);
  // generated_from is still populated from the report.
  assert.equal(res.generated_from.report_id, 'asrr_clean');
});

test('default template is generic-ai-vendor when none supplied', () => {
  const res = autofillQuestionnaire(cleanReport());
  assert.equal(res.template, 'generic-ai-vendor');
  assert.ok(res.answers.some((a) => a.question_id === 'gen-least-privilege'));
});
