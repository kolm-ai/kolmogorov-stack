// src/questionnaire-autofill.js
//
// S8 buyer-side security-questionnaire autofill.
//
// The buyer's reviewer arrives with a standard questionnaire (SIG Lite, CSA
// CAIQ, an EU AI Act Art.10/12/14 checklist, or the generic battery an
// enterprise hands an AI-agent vendor). This module PRE-FILLS that questionnaire
// from a SIGNED kolm Agent Security-Review report, so the reviewer reuses the
// signed evidence instead of re-interviewing the vendor by email.
//
// Each questionnaire question is mapped to the relevant ASR control(s). The
// answer is DERIVED from the report - never asserted beyond what the report
// supports:
//
//   a control that PASSED      -> 'yes'      (cite the clean control)
//   a control with ATTENTION   -> 'partial'  (cite the medium/low finding)
//   a control that is BLOCKING  -> 'no'       (cite the deal-blocking finding)
//   a control NOT assessed / UNTESTED in this run -> 'n/a' (cite the reason)
//
// A question mapped to several controls rolls up worst-first: any blocking ->
// 'no'; else any attention -> 'partial'; else all-pass with full coverage ->
// 'yes'; a clean-but-partial-coverage set is reported 'partial', never inflated
// to a 'yes' the report does not support.
//
// ASR-4 (injection) is read from the report's red_team battery and ASR-6
// (evidence) from the report's own Ed25519 signature + detached evidence, since
// those two controls live outside summary.controls by design.
//
// Pure + never-throws. autofillQuestionnaire(report,{template}) returns a plain
// object; toQuestionnaireCsv(result) returns ASCII CSV for procurement ingest.
// The signed report itself is not modified.

import { ASR_CONTROLS } from './control-mapper.js';

export const QUESTIONNAIRE_AUTOFILL_VERSION = 'asr-questionnaire/0.1';

// ---------------------------------------------------------------------------
// ASCII discipline. Report findings can carry arbitrary text; the autofill
// output must stay ASCII (locale-proof, no em/en dashes) so it survives CSV
// ingest into any procurement tool. Normalize, fold smart punctuation and the
// dash family to plain ASCII, then drop anything still non-ASCII.
// ---------------------------------------------------------------------------
function ascii(value) {
  let s = String(value == null ? '' : value);
  try { s = s.normalize('NFKD'); } catch { /* normalize is best-effort */ }
  return s
    .replace(/[\u2010-\u2015\u2212]/g, '-') // hyphen/figure/en/em dash, minus -> '-'
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

// Canonical ASR control name, for synthesized controls (ASR-4/ASR-6) and as a
// fallback when a report row omits its name.
const ASR_NAME = (() => {
  const m = Object.create(null);
  try { for (const a of ASR_CONTROLS) m[a.id] = a.name; } catch { /* frozen list */ }
  return m;
})();
function asrName(id) { return ASR_NAME[id] || id; }

// ---------------------------------------------------------------------------
// Built-in templates. Each question maps to one or more ASR control ids; the
// answer + evidence are derived from the report against those controls. Text is
// representative of each standard's intent (not a verbatim copy of any
// copyrighted instrument) and is kept ASCII.
// ---------------------------------------------------------------------------
const TEMPLATES = Object.freeze({
  'generic-ai-vendor': {
    id: 'generic-ai-vendor',
    name: 'Generic AI-agent vendor questionnaire',
    description: 'The questions an enterprise asks an AI-agent vendor: least privilege, audit trail, egress and redaction, injection testing, model provenance, agent identity, and delegation.',
    questions: [
      { id: 'gen-least-privilege', text: 'Are agent credentials scoped to least privilege, with no shared keys across isolation boundaries?', asr: ['ASR-1'] },
      { id: 'gen-agent-identity', text: 'Is every agent action attributable to a distinct, declared agent identity?', asr: ['ASR-1'] },
      { id: 'gen-audit-trail', text: 'Do you keep an append-only activity log of every agent action with a stated retention policy?', asr: ['ASR-2'] },
      { id: 'gen-tamper-evidence', text: 'Is the agent audit trail tamper-evident (hash-chained) so modification is detectable?', asr: ['ASR-2'] },
      { id: 'gen-egress-redaction', text: 'Are data egress destinations enumerated and sensitive fields redacted before they leave the boundary?', asr: ['ASR-3'] },
      { id: 'gen-injection-testing', text: 'Do you test agents against direct and indirect prompt injection and report the results?', asr: ['ASR-4'] },
      { id: 'gen-model-provenance', text: 'Are model versions and the MCP/vendor surface pinned and enumerated?', asr: ['ASR-5'] },
      { id: 'gen-evidence-verifiable', text: 'Is your agent security evidence cryptographically signed and verifiable offline?', asr: ['ASR-6'] },
      { id: 'gen-memory-retrieval', text: 'Are retrieval sources enumerated and trusted, and are memory writes attributable?', asr: ['ASR-7'] },
      { id: 'gen-delegation', text: "Is every multi-agent handoff attributable and attenuated to a subset of the delegating agent's authority?", asr: ['ASR-8'] },
    ],
  },
  'sig-lite': {
    id: 'sig-lite',
    name: 'SIG Lite (representative subset)',
    description: 'A SIG-Lite-style subset spanning access control, logging and monitoring, data security, threat and vulnerability management, and supply chain.',
    questions: [
      { id: 'sig-ac-01', text: 'Is logical access to systems and tools restricted on a least-privilege basis?', asr: ['ASR-1'] },
      { id: 'sig-ac-02', text: 'Is each service or agent identity assigned a unique credential, with no shared keys across boundaries?', asr: ['ASR-1'] },
      { id: 'sig-log-01', text: 'Are security-relevant events logged with enough detail to establish who did what and when?', asr: ['ASR-2'] },
      { id: 'sig-log-02', text: 'Are audit logs protected against unauthorized modification (tamper-evident)?', asr: ['ASR-2'] },
      { id: 'sig-log-03', text: 'Are audit logs retained in line with a documented retention policy?', asr: ['ASR-2'] },
      { id: 'sig-ds-01', text: 'Is sensitive data identified and protected against unauthorized egress to third parties?', asr: ['ASR-3'] },
      { id: 'sig-tv-01', text: 'Do you perform adversarial testing of the application, including prompt injection?', asr: ['ASR-4'] },
      { id: 'sig-sc-01', text: 'Are third-party and model dependencies inventoried and version-controlled?', asr: ['ASR-5'] },
    ],
  },
  caiq: {
    id: 'caiq',
    name: 'CSA CAIQ (representative subset)',
    description: 'A CAIQ-style subset across the IAM, AIS, LOG, DSP, and STA domains.',
    questions: [
      { id: 'IAM-01', text: 'Are user and service entitlements granted on a least-privilege basis?', asr: ['ASR-1'] },
      { id: 'IAM-02', text: 'Are credentials unique per identity and not shared across isolation boundaries?', asr: ['ASR-1'] },
      { id: 'AIS-01', text: 'Is the application tested against injection and abuse, including prompt injection?', asr: ['ASR-4'] },
      { id: 'LOG-01', text: 'Are audit logs generated for access and privileged actions?', asr: ['ASR-2'] },
      { id: 'LOG-02', text: 'Are audit logs immutable or tamper-evident?', asr: ['ASR-2'] },
      { id: 'LOG-03', text: 'Is logged evidence retained and independently verifiable?', asr: ['ASR-2', 'ASR-6'] },
      { id: 'DSP-01', text: 'Is sensitive data redacted or controlled before egress to third parties?', asr: ['ASR-3'] },
      { id: 'STA-01', text: 'Is the supply chain of models, MCP servers, and dependencies inventoried and pinned?', asr: ['ASR-5'] },
    ],
  },
  'eu-ai-act': {
    id: 'eu-ai-act',
    name: 'EU AI Act Art.10 / Art.12 / Art.14 checklist',
    description: 'Data governance (Art.10), record-keeping and automatic logging (Art.12), and human oversight (Art.14) for a high-risk AI system.',
    questions: [
      { id: 'art10-data-governance', text: 'Art.10: Are data inputs governed, with egress controls applied to sensitive fields?', asr: ['ASR-3'] },
      { id: 'art10-retrieval', text: 'Art.10: Are retrieval and memory sources enumerated and trusted?', asr: ['ASR-7'] },
      { id: 'art12-record-keeping', text: 'Art.12: Does the system automatically record events over its operation (logging)?', asr: ['ASR-2'] },
      { id: 'art12-log-integrity', text: 'Art.12: Are the automatically generated records tamper-evident, retained, and verifiable?', asr: ['ASR-2', 'ASR-6'] },
      { id: 'art14-human-oversight', text: 'Art.14: Are high-privilege or destructive agent actions gated for human oversight?', asr: ['ASR-1'] },
      { id: 'art14-delegation-oversight', text: 'Art.14: Is each multi-agent delegation attributable and attenuated so a human can oversee it?', asr: ['ASR-8'] },
    ],
  },
});

// Public list of available templates (id + metadata + question count).
export const QUESTIONNAIRE_TEMPLATES = Object.freeze(
  Object.values(TEMPLATES).map((t) => Object.freeze({
    id: t.id,
    name: t.name,
    description: t.description,
    question_count: t.questions.length,
  })),
);

const DEFAULT_TEMPLATE = 'generic-ai-vendor';

// ---------------------------------------------------------------------------
// Report access. Accepts an envelope object, a JSON string, or the
// { envelope } wrapper resolveTrust() returns. Returns a plain object (possibly
// empty) so every downstream read is guarded.
// ---------------------------------------------------------------------------
function asReport(input) {
  let r = input;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { return {}; }
  }
  if (!r || typeof r !== 'object') return {};
  // Unwrap the resolveTrust shape if a caller passed the wrapper.
  if (r.envelope && typeof r.envelope === 'object' && !r.summary && !r.findings) r = r.envelope;
  return r;
}

// ---------------------------------------------------------------------------
// Control resolution. Returns { asrId, name, status, findings[], note } where
// status is one of: pass | attention | blocking | untested. ASR-4 and ASR-6 are
// synthesized from the red_team block and the signature respectively, since they
// do not appear in summary.controls.
// ---------------------------------------------------------------------------
const VALID_STATUS = new Set(['pass', 'attention', 'blocking', 'untested']);

function findingsForAsr(report, asrId) {
  const list = Array.isArray(report.findings) ? report.findings : [];
  return list.filter((f) => f && f.asr && f.asr.id === asrId);
}

function resolveInjection(report) {
  const name = asrName('ASR-4');
  const rt = report.red_team && typeof report.red_team === 'object' ? report.red_team : null;
  if (!rt || rt.score == null) {
    return { asrId: 'ASR-4', name, status: 'untested', findings: [], note: 'No red-team injection battery result is present in this report.' };
  }
  const probes = Array.isArray(rt.probes) ? rt.probes : [];
  const sum = rt.summary && typeof rt.summary === 'object' ? rt.summary : {};
  const exposed = Number.isFinite(sum.exposed) ? sum.exposed : probes.filter((p) => p && p.status === 'exposed').length;
  const resisted = Number.isFinite(sum.resisted) ? sum.resisted : probes.filter((p) => p && p.status === 'resisted').length;
  const untested = Number.isFinite(sum.untested) ? sum.untested : probes.filter((p) => p && p.status === 'untested').length;
  const tested = Number.isFinite(sum.tested) ? sum.tested : (exposed + resisted);
  let status;
  if (exposed > 0) status = 'blocking';
  else if (resisted > 0 || tested > 0) status = 'pass';
  else status = 'untested';
  const findings = probes
    .filter((p) => p && p.status === 'exposed')
    .map((p) => ({ title: p.title || p.id, severity: p.severity || 'high', frameworks: Array.isArray(p.frameworks) ? p.frameworks : [] }));
  const note = `Red-team resistance score ${rt.score}/100: ${resisted} resisted, ${exposed} exposed, ${untested} untested.`;
  return { asrId: 'ASR-4', name, status, findings, note };
}

function resolveEvidence(report) {
  const name = asrName('ASR-6');
  const sig = report.signature_ed25519 && typeof report.signature_ed25519 === 'object' ? report.signature_ed25519 : null;
  if (!sig) {
    return { asrId: 'ASR-6', name, status: 'untested', findings: [], note: 'This report carries no Ed25519 signature.' };
  }
  const bits = [`signed Ed25519 (${sig.key_fingerprint || 'embedded public key'})`, 'verifiable offline with no kolm account'];
  if (report.evidence_digest && report.evidence_digest.value) bits.push('bound to a sha256 input-evidence digest');
  if (report.timestamp_evidence && report.timestamp_evidence.status === 'timestamped') bits.push('RFC 3161 trusted timestamp attached');
  if (report.log_checkpoint && typeof report.log_checkpoint === 'object') bits.push('included in an append-only transparency log');
  return { asrId: 'ASR-6', name, status: 'pass', findings: [], note: bits.join('; ') + '.' };
}

function resolveControl(report, asrId) {
  if (asrId === 'ASR-4') return resolveInjection(report);
  if (asrId === 'ASR-6') return resolveEvidence(report);
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const rows = Array.isArray(summary.controls) ? summary.controls : [];
  const row = rows.find((c) => c && c.id === asrId);
  const name = (row && row.name) || asrName(asrId);
  if (!row) {
    const na = (Array.isArray(summary.not_assessed) ? summary.not_assessed : []).find((n) => n && n.id === asrId);
    return { asrId, name, status: 'untested', findings: [], note: na ? na.reason : 'This control was not assessed in this run.' };
  }
  const status = VALID_STATUS.has(row.status) ? row.status : 'untested';
  return { asrId, name, status, findings: findingsForAsr(report, asrId), note: null };
}

// ---------------------------------------------------------------------------
// Answer + evidence derivation for one question.
// ---------------------------------------------------------------------------
function rollupAnswer(resolved) {
  const statuses = resolved.map((r) => r.status);
  const assessed = statuses.filter((s) => s === 'pass' || s === 'attention' || s === 'blocking');
  if (resolved.length === 0 || assessed.length === 0) return 'n/a';
  if (statuses.includes('blocking')) return 'no';
  if (statuses.includes('attention')) return 'partial';
  // Only passes (and possibly untested controls) remain.
  const untested = statuses.filter((s) => s === 'untested').length;
  return untested > 0 ? 'partial' : 'yes';
}

function confidenceFor(answer) {
  if (answer === 'yes' || answer === 'no') return 'high';
  if (answer === 'partial') return 'medium';
  return 'low';
}

function evidenceFor(resolved) {
  const out = [];
  for (const r of resolved) {
    if (r.status === 'pass') {
      out.push({
        asr: r.asrId,
        control: ascii(r.name),
        detail: ascii(`${r.asrId} ${r.name}: PASS in the signed report${r.note ? ` (${r.note})` : '; no blocking or attention findings in this control'}.`),
      });
    } else if (r.status === 'attention' || r.status === 'blocking') {
      const fs = r.findings && r.findings.length
        ? r.findings
        : [{ title: `${r.name} finding`, severity: r.status === 'blocking' ? 'high' : 'medium', frameworks: [] }];
      for (const f of fs) {
        const fw = Array.isArray(f.frameworks) && f.frameworks.length ? ` Maps to ${f.frameworks.join(', ')}.` : '';
        out.push({
          asr: r.asrId,
          control: ascii(r.name),
          detail: ascii(`${f.title} (${f.severity || 'finding'}).${fw}`),
        });
      }
    } else {
      out.push({
        asr: r.asrId,
        control: ascii(r.name),
        detail: ascii(`${r.asrId} ${r.name}: not assessed in this run${r.note ? ` (${r.note})` : ''}.`),
      });
    }
  }
  return out;
}

function answerQuestion(report, q) {
  const asrIds = Array.isArray(q.asr) ? q.asr : (q.asr ? [q.asr] : []);
  const resolved = asrIds.map((id) => resolveControl(report, id));
  const answer = rollupAnswer(resolved);
  let evidence = evidenceFor(resolved);
  if (evidence.length === 0) {
    evidence = [{ asr: null, control: null, detail: ascii(q.na_note || 'No mapped control in this report covers this question.') }];
  }
  return {
    question_id: q.id,
    question: ascii(q.text),
    answer,
    evidence,
    confidence: confidenceFor(answer),
  };
}

// ---------------------------------------------------------------------------
// autofillQuestionnaire - the primary export. Pure, never throws.
// ---------------------------------------------------------------------------
export function autofillQuestionnaire(report, opts = {}) {
  let templateId = opts && typeof opts === 'object' && opts.template ? String(opts.template) : DEFAULT_TEMPLATE;
  let tmpl = TEMPLATES[templateId];
  const rep = asReport(report);
  const summary = rep.summary && typeof rep.summary === 'object' ? rep.summary : {};
  const readiness = Number.isFinite(summary.readiness_pct) ? summary.readiness_pct : null;
  const generated_from = {
    report_id: typeof rep.report_id === 'string' ? rep.report_id : null,
    readiness_pct: readiness,
  };
  if (!tmpl) {
    return {
      template: templateId,
      generated_from,
      answers: [],
      error: 'unknown_template',
      available_templates: QUESTIONNAIRE_TEMPLATES.map((t) => t.id),
    };
  }
  let answers = [];
  try { answers = tmpl.questions.map((q) => answerQuestion(rep, q)); }
  catch { answers = []; }
  return { template: tmpl.id, generated_from, answers };
}

// ---------------------------------------------------------------------------
// CSV export for procurement ingest. ASCII, RFC-4180-style escaping, never
// throws. One row per answer; evidence details are folded into a single field.
// ---------------------------------------------------------------------------
const CSV_HEADER = ['template', 'report_id', 'question_id', 'question', 'answer', 'confidence', 'asr', 'evidence'];

function csvField(value) {
  const s = ascii(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toQuestionnaireCsv(result) {
  try {
    const r = result && typeof result === 'object' ? result : {};
    const answers = Array.isArray(r.answers) ? r.answers : [];
    const template = r.template || '';
    const reportId = (r.generated_from && r.generated_from.report_id) || '';
    const lines = [CSV_HEADER.map(csvField).join(',')];
    for (const a of answers) {
      if (!a || typeof a !== 'object') continue;
      const ev = Array.isArray(a.evidence) ? a.evidence : [];
      const asr = ev.map((e) => (e && e.asr) || '').filter(Boolean).join(' ');
      const evidence = ev.map((e) => (e && e.detail) || '').filter(Boolean).join(' | ');
      lines.push([template, reportId, a.question_id, a.question, a.answer, a.confidence, asr, evidence].map(csvField).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  } catch {
    return CSV_HEADER.join(',') + '\r\n';
  }
}

export default autofillQuestionnaire;
