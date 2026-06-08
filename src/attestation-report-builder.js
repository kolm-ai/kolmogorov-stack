// Agent Security-Review audit - attestation report builder.
//
// Turns a deterministic runAudit() result (src/audit-orchestrator.js) into the
// deliverable the buyer's review group actually receives:
//
//   1. A SIGNED, offline-verifiable JSON envelope (Ed25519 - src/ed25519.js).
//      The signature covers the whole report minus its own signature block, so a
//      single altered byte (a downgraded readiness number, a deleted finding)
//      breaks verification. The buyer verifies it with only the embedded public
//      key - no kolm server, no shared secret, no account (public/kolm-audit-
//      verify.js does exactly this in the browser).
//
//   2. Human-readable renderings of that same signed envelope: an HTML report
//      and a PDF (lazy pdfkit, mirroring src/assurance-case-pdf.js).
//
// The canonicalization here (canonicalizeReport) is deliberately simple and
// self-describing - recursive key-sorted JSON with no whitespace - so the
// browser verifier can reproduce the exact signed bytes without importing this
// module. Keep the two byte-identical.
//
// Scope discipline (no theater): the envelope carries the orchestrator's
// graduated readiness rollup verbatim, including which controls were assessed
// (ASR-1/2/3) and which were NOT (ASR-4/5/6, with reasons). The caveats section
// states the limits in plain terms. This report maps findings to the frameworks
// a reviewer cites; it is not a certification.

import {
  loadOrCreateDefaultSigner,
  buildSignatureBlock,
  verifySignatureBlock,
} from './ed25519.js';
import { ASR_CONTROLS } from './control-mapper.js';
import { runRedTeam } from './red-team.js';

// Versioned so a re-attestation is a comparable delta and a signed report
// records exactly which builder shape produced it.
export const AUDIT_REPORT_SCHEMA = 'kolm-audit-report-1';
export const AUDIT_REPORT_VERSION = 'asr-report/0.1';

// The single contact surface for the report. dev@kolm.ai is the only address.
const CONTACT_EMAIL = 'dev@kolm.ai';

// ---------------------------------------------------------------------------
// Canonicalization - the exact bytes the Ed25519 signature covers.
//
// Recursive, key-sorted, whitespace-free JSON. Sorting keys makes the output
// independent of property insertion order, so the Node signer and the browser
// verifier produce identical bytes without sharing a field list. `undefined`
// values are dropped (matching JSON.stringify). The signature_ed25519 block is
// excluded because a signature cannot cover itself.
// ---------------------------------------------------------------------------
export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  // undefined / function / symbol - never part of a well-formed envelope.
  return 'null';
}

export function canonicalizeReport(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('canonicalizeReport: envelope must be an object');
  }
  const { signature_ed25519, ...rest } = envelope;
  return canonicalize(rest);
}

// ---------------------------------------------------------------------------
// Report-id minting. Sortable-ish (time-prefixed) and grep-friendly.
// ---------------------------------------------------------------------------
function newReportId(seed) {
  // Deterministic when a seed is supplied (tests / reproducible builds);
  // otherwise time + the audit's own shape make it unique enough without
  // pulling in crypto.randomBytes (kept dependency-light + offline-safe).
  if (seed) return `asrr_${String(seed).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
  const ts = Date.now().toString(36);
  return `asrr_${ts}`;
}

// ---------------------------------------------------------------------------
// Remediation roadmap.
//
// One actionable item per blocking/attention control finding, ordered worst-
// first, each carrying the buyer's framework references so the roadmap reads
// against the same controls the report cites.
// ---------------------------------------------------------------------------
const REMEDIATION_HINTS = {
  'over-permission': 'Scope each agent credential to only the tools it calls; remove the unused grants.',
  'wildcard-grant': 'Replace the wildcard grant with an explicit allow-list of the tools the agent needs.',
  'shared-credential': 'Issue a distinct, scoped key per agent; stop sharing one key across isolation boundaries.',
  'high-privilege-action': 'Gate destructive / financial tool calls behind human approval or a separate narrowly-scoped credential.',
  'undeclared-tool-call': 'Declare every tool the agent can call and deny calls to undeclared tools at the gateway.',
  'no-declared-grants': 'Declare each agent permission scope explicitly so held-vs-used can be assessed.',
  'sensitive-egress': 'Redact sensitive fields before they leave the boundary and enumerate every egress destination.',
  'no-tamper-evidence': 'Emit an append-only, hash-chained activity log so the audit trail is tamper-evident.',
  'broken-hash-chain': 'Repair the audit-log hash chain and investigate the break before relying on the trail.',
  'partial-tamper-evidence': 'Extend hash-chaining to cover the full trail, not a subset of events.',
  'incomplete-timestamps': 'Stamp every event with a reliable timestamp.',
  'unattributed-events': 'Attribute every event to an actor (agent / user / key).',
  'missing-action-detail': 'Record the action or tool for every event.',
  'duplicate-event-ids': 'Make event ids unique so the trail is unambiguous.',
  'retention-unverifiable': 'Set and document a retention window that meets the buyer requirement (e.g. EU AI Act Art.12).',
  'short-retention-window': 'Extend and document the retention window to meet the buyer requirement (e.g. EU AI Act Art.12).',
};

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function priorityFor(severity) {
  if (severity === 'critical' || severity === 'high') return 'P0';
  if (severity === 'medium') return 'P1';
  return 'P2';
}

function frameworksOf(finding) {
  return Array.isArray(finding.controls)
    ? finding.controls.map((c) => `${c.framework} ${c.id}`)
    : [];
}

export function deriveRemediation(auditResult) {
  const mapped = (auditResult && auditResult.controls && Array.isArray(auditResult.controls.findings))
    ? auditResult.controls.findings
    : [];
  const items = mapped
    .filter((f) => f && f.severity && f.severity !== 'info')
    .map((f) => ({
      priority: priorityFor(f.severity),
      severity: f.severity,
      finding_id: f.id,
      title: f.title || f.id,
      action: REMEDIATION_HINTS[f.id] || `Remediate: ${f.title || f.id}.`,
      asr: f.asr ? f.asr.id : null,
      frameworks: frameworksOf(f),
    }));
  items.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  return items;
}

// ---------------------------------------------------------------------------
// The caveats - what the report does and does NOT claim. Stated plainly so a
// reviewer is never misled. (No theater; this is the anti-theater section.)
// ---------------------------------------------------------------------------
function buildCaveats(summary) {
  const assessed = (summary.assessed_controls || []).join(', ');
  return [
    `This report assesses ${assessed || 'the deterministic controls'} from the supplied logs. The controls listed under "Not assessed" were not evaluated in this run. Each carries its reason.`,
    'Findings reflect only the activity present in the supplied export. The absence of a finding is not proof that the underlying risk is absent.',
    'The readiness percentage is a graduated rollup over the assessed controls only (pass = 1, attention = 0.5, blocking = 0). It is not a certification or an attestation of compliance.',
    'Framework references map each finding to the control an enterprise reviewer cites; they do not assert certification against that framework.',
  ];
}

// ---------------------------------------------------------------------------
// Red-team block - the ASR-4 injection-resistance evidence for the signed
// envelope. Reads the orchestrator's red_team result (src/red-team.js); if a
// caller built the audit without one, it is derived deterministically from the
// same events, so the deliverable is always self-consistent. The block carries
// only the score, the per-status counts, and the probe table (opaque event-id
// evidence, never raw log bodies), so adding it to the envelope cannot leak PII.
// ---------------------------------------------------------------------------
export function buildRedTeamBlock(auditResult) {
  const rt = auditResult && auditResult.red_team && typeof auditResult.red_team === 'object'
    ? auditResult.red_team
    : runRedTeam(Array.isArray(auditResult && auditResult.events) ? auditResult.events : []);
  const sum = rt.summary || {};
  const probes = Array.isArray(rt.probes) ? rt.probes : [];
  return {
    spec_version: rt.spec_version || null,
    domain: rt.domain || sum.domain || 'generic',
    score: rt.red_team_score == null ? null : rt.red_team_score,
    summary: {
      probes_total: sum.probes_total ?? probes.length,
      tested: sum.tested ?? 0,
      resisted: sum.resisted ?? 0,
      exposed: sum.exposed ?? 0,
      untested: sum.untested ?? 0,
      note: sum.note,
    },
    probes: probes.map((p) => ({
      id: p.id,
      category: p.category,
      severity: p.severity,
      status: p.status,
      title: p.title || p.id,
      detail: p.detail || null,
      frameworks: Array.isArray(p.frameworks) ? p.frameworks.slice(0, 8) : [],
      evidence: Array.isArray(p.evidence) ? p.evidence.slice(0, 6) : [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Build the unsigned report envelope from a runAudit() result.
//
// Deliberately excludes the raw `events` array: the report carries findings,
// the readiness rollup, framework coverage, and a remediation roadmap - not the
// (potentially sensitive) raw log bodies. The signature still covers everything
// in the envelope, so the deliverable is tamper-evident end to end.
// ---------------------------------------------------------------------------
export function buildReportEnvelope(auditResult, opts = {}) {
  if (!auditResult || typeof auditResult !== 'object' || !auditResult.summary) {
    throw new Error('buildReportEnvelope: a runAudit() result with a summary is required');
  }
  const options = opts && typeof opts === 'object' ? opts : {};
  const s = auditResult.summary;

  const subjectName = String(options.subject || options.name || 'Agent fleet').slice(0, 200);
  const generatedAt = options.generated_at || new Date().toISOString();

  // Tier + watermark. The free Scan returns a watermarked PREVIEW envelope; the
  // paid Signed Readiness Report re-signs the SAME audit with tier:'report' and
  // no watermark. Both fields sit in the signed payload (canonicalizeReport
  // covers every key but signature_ed25519), so the watermark is tamper-evident:
  // a buyer cannot strip "UNPAID PREVIEW" without breaking the Ed25519 signature.
  const tier = options.tier === 'report' ? 'report' : 'scan';
  const watermark = options.watermark != null ? !!options.watermark : (tier !== 'report');

  // Curated, framework-mapped findings (drop the all-clear "info" sentinels so
  // a clean report reads as clean, not as a list of non-findings).
  const mapped = (auditResult.controls && Array.isArray(auditResult.controls.findings))
    ? auditResult.controls.findings
    : [];
  const findings = mapped
    .filter((f) => f && f.severity && f.severity !== 'info')
    .map((f) => ({
      id: f.id,
      severity: f.severity,
      pillar: f.pillar || null,
      title: f.title || f.id,
      detail: f.detail || null,
      asr: f.asr ? { id: f.asr.id, name: f.asr.name } : null,
      frameworks: frameworksOf(f),
      evidence: Array.isArray(f.evidence) ? f.evidence.slice(0, 8) : [],
    }))
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

  // Per-framework coverage from the control map (sorted, framework-keyed).
  const frameworks = (auditResult.controls && Array.isArray(auditResult.controls.frameworks))
    ? auditResult.controls.frameworks.map((fw) => ({
        framework: fw.framework,
        controls_touched: fw.controls_touched,
        findings: fw.findings,
        worst_severity: fw.worst_severity,
        controls: (fw.controls || []).map((c) => ({ id: c.id, label: c.label, findings: c.findings, max_severity: c.max_severity })),
      }))
    : [];

  const verifyUrl = (options.verify_url
    || `${(process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '')}/verify`);

  const envelope = {
    schema: AUDIT_REPORT_SCHEMA,
    report_version: AUDIT_REPORT_VERSION,
    spec_version: auditResult.spec_version || null,
    report_id: options.report_id || newReportId(options.report_seed),
    generated_at: generatedAt,
    tier,
    watermark,
    subject: {
      name: subjectName,
      source: auditResult.source || null,
      records: auditResult.ingest ? (auditResult.ingest.records ?? null) : null,
      events: auditResult.ingest ? (auditResult.ingest.events ?? null) : null,
    },
    summary: {
      readiness_pct: s.readiness_pct ?? null,
      total_findings: s.total_findings ?? findings.length,
      by_severity: s.by_severity || {},
      tamper_evident: s.tamper_evident === true,
      assessed_controls: s.assessed_controls || [],
      controls: (s.controls || []).map((c) => ({
        id: c.id, name: c.name, status: c.status, findings: c.findings, by_severity: c.by_severity || {},
      })),
      not_assessed: (s.not_assessed || []).map((n) => ({ id: n.id, reason: n.reason })),
      blocking_count: s.blocking_count ?? (Array.isArray(s.blocking) ? s.blocking.length : 0),
    },
    findings,
    frameworks,
    remediation: deriveRemediation(auditResult),
    caveats: buildCaveats(s),
    asr_checklist: ASR_CONTROLS.map((a) => ({ id: a.id, name: a.name, requires: a.requires })),
    contact: CONTACT_EMAIL,
    verify_url: verifyUrl,
  };
  if (s.note) envelope.summary.note = s.note;

  // ASR-4 red-team resistance. A NEW top-level field: the canonicalizer is a
  // generic key-sort, so adding it is signature-safe and does not change how any
  // existing field is canonicalized. Gated by opts.includeRedTeam (default on)
  // so a caller can build the pre-red_team baseline for a canonicalization diff.
  if (options.includeRedTeam !== false) {
    envelope.red_team = buildRedTeamBlock(auditResult);
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// Sign an envelope in place (returns the same object with signature_ed25519).
// ---------------------------------------------------------------------------
export function signReport(envelope, signer) {
  const s = signer || loadOrCreateDefaultSigner();
  if (!s || !s.privateKey || !s.publicKey) {
    const err = new Error('signReport: no Ed25519 signer available (set KOLM_ED25519_PRIVATE_KEY or allow a cached key)');
    err.code = 'NO_SIGNER';
    throw err;
  }
  const canonical = canonicalizeReport(envelope);
  envelope.signature_ed25519 = buildSignatureBlock({
    privateKey: s.privateKey,
    publicKey: s.publicKey,
    key_fingerprint: s.key_fingerprint,
    payloadCanonical: canonical,
    signed_at: envelope.generated_at,
  });
  return envelope;
}

// ---------------------------------------------------------------------------
// Build + sign in one call. Convenience for the route + CLI layers.
// Returns { envelope, report_id, key_fingerprint, signed_at }.
// ---------------------------------------------------------------------------
export function buildAndSignReport(auditResult, opts = {}) {
  const envelope = buildReportEnvelope(auditResult, opts);
  signReport(envelope, opts.signer);
  return {
    envelope,
    report_id: envelope.report_id,
    key_fingerprint: envelope.signature_ed25519.key_fingerprint,
    signed_at: envelope.signature_ed25519.signed_at,
  };
}

// ---------------------------------------------------------------------------
// Re-sign an existing signed envelope at a different tier (the paid upgrade).
//
// The free Scan stores a watermarked tier:'scan' envelope. When the buyer pays
// for the Signed Readiness Report, we do NOT re-run the (deterministic) audit -
// we flip tier->'report' + watermark->false on the stored envelope and re-sign.
// generated_at is preserved (it records when the audit ran), so signReport keeps
// signed_at == generated_at and verifyReport still passes. Returns a NEW object;
// the input is not mutated. Throws NO_SIGNER if no signer is available.
// ---------------------------------------------------------------------------
export function resignAsTier(envelope, tier, signer) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('resignAsTier: a signed envelope object is required');
  }
  const { signature_ed25519, ...rest } = envelope;
  const next = { ...rest };
  next.tier = tier === 'report' ? 'report' : 'scan';
  next.watermark = next.tier !== 'report';
  signReport(next, signer);
  return next;
}

// ---------------------------------------------------------------------------
// Verify a signed report envelope. Pure, offline, never throws.
// Returns { ok, reason?, key_fingerprint?, checks: [...] }.
// ---------------------------------------------------------------------------
export function verifyReport(envelope) {
  const checks = [];
  let report = envelope;
  if (typeof report === 'string') {
    try { report = JSON.parse(report); }
    catch (e) { return { ok: false, reason: 'input is not valid JSON: ' + e.message, checks }; }
  }
  if (!report || typeof report !== 'object') {
    return { ok: false, reason: 'report must be a JSON object', checks };
  }
  if (report.schema && report.schema !== AUDIT_REPORT_SCHEMA) {
    return { ok: false, reason: `unexpected schema: ${report.schema}`, checks };
  }
  checks.push({ name: 'schema', ok: true, detail: report.schema || '(none)' });

  const block = report.signature_ed25519;
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: 'report has no signature_ed25519 block', checks };
  }
  checks.push({ name: 'signature block present', ok: true, detail: `alg=${block.alg || '?'} spec=${block.spec || '?'}` });

  let canonical;
  try { canonical = canonicalizeReport(report); }
  catch (e) { return { ok: false, reason: 'cannot canonicalize report: ' + e.message, checks }; }
  checks.push({ name: 'canonical payload rebuilt', ok: true, detail: `${canonical.length} bytes` });

  const v = verifySignatureBlock(block, canonical);
  checks.push({ name: 'Ed25519 signature valid', ok: v.ok, detail: v.ok ? 'signature matches payload' : (v.reason || 'does not verify') });
  if (!v.ok) return { ok: false, reason: v.reason || 'signature does not verify', key_fingerprint: v.key_fingerprint, checks };

  // signed_at lives inside the signature block, which the signature itself does
  // NOT cover (a signature cannot sign itself). generated_at, by contrast, is in
  // the signed payload. signReport sets the two equal, so a mismatch means the
  // displayed timestamp was altered after signing - surface it rather than show
  // a clean pass with a forged date. String() so a non-string never throws.
  if (block.signed_at != null && report.generated_at != null
      && String(block.signed_at) !== String(report.generated_at)) {
    checks.push({ name: 'signed_at matches signed generated_at', ok: false, detail: `block.signed_at=${String(block.signed_at)} ≠ generated_at=${String(report.generated_at)}` });
    return { ok: false, reason: 'signed_at does not match the signed generated_at (timestamp altered after signing)', key_fingerprint: v.key_fingerprint, checks };
  }
  checks.push({ name: 'signed_at matches signed generated_at', ok: true, detail: String(report.generated_at || '(none)') });

  return { ok: true, key_fingerprint: v.key_fingerprint, checks };
}

// ===========================================================================
// Human-readable renderings of the SAME signed envelope.
// ===========================================================================

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_LABEL = { pass: 'PASS', attention: 'ATTENTION', blocking: 'BLOCKING' };
const STATUS_COLOR = { pass: '#166534', attention: '#0e7490', blocking: '#991b1b' };

// renderReportHtml(envelope) -> string. Self-contained HTML document.
export function renderReportHtml(envelope) {
  const e = envelope || {};
  const s = e.summary || {};
  const readiness = s.readiness_pct == null ? 'n/a' : `${s.readiness_pct}%`;
  const sig = e.signature_ed25519 || {};
  const isWm = e.watermark === true;
  const wmBanner = isWm
    ? `<div class="wm-banner">UNPAID PREVIEW &middot; not for distribution. This free Scan snapshot is watermarked. Purchase the Signed Readiness Report to receive an unwatermarked, distributable copy plus a shareable verify link your reviewer can check. <span class="mono">${esc(e.contact || CONTACT_EMAIL)}</span></div>`
    : '';

  const controlRows = (s.controls || []).map((c) => `
    <tr>
      <td class="mono">${esc(c.id)}</td>
      <td>${esc(c.name)}</td>
      <td><span class="pill" style="background:${STATUS_COLOR[c.status] || '#555'}">${esc(STATUS_LABEL[c.status] || c.status)}</span></td>
      <td>${esc(c.findings)}</td>
    </tr>`).join('');

  const notAssessed = (s.not_assessed || []).map((n) => `
    <li><span class="mono">${esc(n.id)}</span> - ${esc(n.reason)}</li>`).join('');

  const findingRows = (e.findings || []).map((f) => `
    <div class="finding sev-${esc(f.severity)}">
      <div class="finding-head">
        <span class="sev">${esc((f.severity || '').toUpperCase())}</span>
        <span class="finding-title">${esc(f.title)}</span>
      </div>
      ${f.detail ? `<p class="finding-detail">${esc(f.detail)}</p>` : ''}
      <p class="finding-fw">${esc(f.asr ? f.asr.id + ' · ' : '')}${esc((f.frameworks || []).join(' · ') || 'no framework mapping')}</p>
    </div>`).join('');

  const remediation = (e.remediation || []).map((r) => `
    <tr>
      <td class="mono">${esc(r.priority)}</td>
      <td>${esc(r.title)}</td>
      <td>${esc(r.action)}</td>
      <td class="mono small">${esc((r.frameworks || []).join(', '))}</td>
    </tr>`).join('');

  const caveats = (e.caveats || []).map((c) => `<li>${esc(c)}</li>`).join('');

  // Red-team resistance section (ASR-4). score==null renders n/a (no fake number).
  const rt = e.red_team && typeof e.red_team === 'object' ? e.red_team : null;
  const rtSum = rt && rt.summary ? rt.summary : {};
  const rtScore = rt ? (rt.score == null ? 'n/a' : `${rt.score}/100`) : 'n/a';
  const RT_STATUS_LABEL = { resisted: 'RESISTED', exposed: 'EXPOSED', untested: 'UNTESTED' };
  const RT_STATUS_COLOR = { resisted: '#166534', exposed: '#991b1b', untested: '#5b6472' };
  const rtRows = rt ? (rt.probes || []).map((p) => `
    <tr>
      <td>${esc(p.title || p.id)}<div class="small" style="color:var(--muted)">${esc(p.category || '')}</div></td>
      <td><span class="sev" style="color:${_sevColor(p.severity)}">${esc((p.severity || '').toUpperCase())}</span></td>
      <td><span class="pill" style="background:${RT_STATUS_COLOR[p.status] || '#555'}">${esc(RT_STATUS_LABEL[p.status] || p.status)}</span></td>
      <td class="mono small">${esc((p.frameworks || []).join(' · '))}</td>
    </tr>`).join('') : '';
  const rtSection = rt ? `
  <h2>Red-Team Resistance: ${esc(rtScore)}</h2>
  <p class="sub small">Deterministic injection / agent-abuse battery (${esc(rt.domain || 'generic')} suite) over the ingested events. ${esc(rtSum.resisted ?? 0)} resisted, ${esc(rtSum.exposed ?? 0)} exposed, ${esc(rtSum.untested ?? 0)} untested of ${esc(rtSum.probes_total ?? 0)} probes. The score is a graduated rollup over the exercised probes only; untested probes are marked, never scored as a pass.</p>
  <table><thead><tr><th>Probe</th><th>Severity</th><th>Observed resistance</th><th>Mapped to</th></tr></thead>
  <tbody>${rtRows}</tbody></table>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Security-Review Readiness Report - ${esc(e.subject ? e.subject.name : '')}</title>
<style>
  :root{--ink:#0b0e14;--muted:#5b6472;--rule:#e3e7ee;--paper:#ffffff;--panel:#f7f9fc;}
  *{box-sizing:border-box}
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--paper);margin:0;padding:40px;max-width:920px;margin-inline:auto}
  h1{font-size:26px;margin:0 0 4px}
  h2{font-size:18px;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
  .sub{color:var(--muted);margin:0 0 24px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .small{font-size:12px}
  .headline{display:flex;gap:28px;align-items:baseline;background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:20px 24px;margin:0 0 8px}
  .headline .big{font-size:40px;font-weight:700}
  table{width:100%;border-collapse:collapse;margin:6px 0}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .pill{color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
  .finding{border:1px solid var(--rule);border-left-width:4px;border-radius:8px;padding:12px 14px;margin:10px 0}
  .finding.sev-critical,.finding.sev-high{border-left-color:#991b1b}
  .finding.sev-medium{border-left-color:#0e7490}
  .finding.sev-low{border-left-color:#5b6472}
  .finding-head{display:flex;gap:10px;align-items:baseline}
  .finding .sev{font-size:11px;font-weight:700;color:#991b1b}
  .finding.sev-medium .sev{color:#0e7490}
  .finding.sev-low .sev{color:#5b6472}
  .finding-title{font-weight:600}
  .finding-detail{margin:6px 0;color:#2a2f3a}
  .finding-fw{margin:4px 0 0;color:var(--muted);font-size:12px}
  .sigbox{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:16px 18px;font-size:13px}
  .sigbox .k{color:var(--muted)}
  ul{margin:6px 0;padding-left:20px}
  footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--rule);padding-top:14px}
  .wm-banner{background:#991b1b;color:#fff;border-radius:8px;padding:11px 16px;margin:0 0 22px;font-weight:600;font-size:13px;line-height:1.45}
  .wm-banner .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.9}
  body.wm::before{content:"PREVIEW";position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:165px;font-weight:800;color:rgba(153,27,27,.05);transform:rotate(-30deg);pointer-events:none;z-index:0;white-space:nowrap;letter-spacing:.06em}
  body.wm>*{position:relative;z-index:1}
</style></head>
<body class="${isWm ? 'wm' : ''}">
  <h1>Agent Security-Review Readiness Report</h1>
  <p class="sub">${esc(e.subject ? e.subject.name : '')} · generated ${esc(e.generated_at)} · <span class="mono">${esc(e.report_id)}</span></p>
  ${wmBanner}

  <div class="headline">
    <div><div class="big">${esc(readiness)}</div><div class="small">readiness (assessed controls)</div></div>
    <div><div class="big">${esc(s.blocking_count ?? 0)}</div><div class="small">deal-blocking findings</div></div>
    <div><div class="big">${esc(rtScore)}</div><div class="small">red-team resistance</div></div>
    <div><div class="big">${s.tamper_evident ? 'Yes' : 'No'}</div><div class="small">tamper-evident trail</div></div>
  </div>

  <h2>Control status</h2>
  <table><thead><tr><th>Control</th><th>Name</th><th>Status</th><th>Findings</th></tr></thead>
  <tbody>${controlRows}</tbody></table>
  <p class="small" style="color:var(--muted)">Not assessed in this run:</p>
  <ul class="small">${notAssessed}</ul>

  <h2>Findings</h2>
  ${findingRows || '<p class="sub">No deal-blocking or attention findings in the assessed controls.</p>'}
  ${rtSection}

  <h2>Remediation roadmap</h2>
  ${remediation ? `<table><thead><tr><th>Priority</th><th>Finding</th><th>Action</th><th>Frameworks</th></tr></thead><tbody>${remediation}</tbody></table>` : '<p class="sub">No remediation items.</p>'}

  <h2>Scope &amp; limitations</h2>
  <ul>${caveats}</ul>

  <h2>Signature</h2>
  <div class="sigbox">
    <div><span class="k">algorithm:</span> <span class="mono">${esc(sig.alg || ' - ')} (${esc(sig.spec || ' - ')})</span></div>
    <div><span class="k">key fingerprint:</span> <span class="mono">${esc(sig.key_fingerprint || ' - ')}</span></div>
    <div><span class="k">signed at:</span> <span class="mono">${esc(sig.signed_at || ' - ')}</span></div>
    <div style="margin-top:8px"><span class="k">Verify offline:</span> paste this report's JSON at <span class="mono">${esc(e.verify_url || '')}</span> - it checks the Ed25519 signature in your browser with no upload.</div>
  </div>

  <footer>kolm.ai - Agent Security Evidence · ${esc(e.schema)} ${esc(e.report_version)} · questions: ${esc(e.contact || CONTACT_EMAIL)}</footer>
</body></html>`;
}

// ---------------------------------------------------------------------------
// PDF rendering - mirrors src/assurance-case-pdf.js: lazy pdfkit, frozen
// palette (no warm colors), manual text-block layout with overflow checks,
// footer applied after content via bufferedPageRange/switchToPage.
// ---------------------------------------------------------------------------
export const PDF_COLOR = Object.freeze({
  ink: '#111111',
  muted: '#555555',
  rule: '#cccccc',
  ok: '#166534',
  warn: '#0e7490',
  bad: '#991b1b',
  info: '#1d4ed8',
});

function _statusColor(status) {
  if (status === 'pass') return PDF_COLOR.ok;
  if (status === 'attention') return PDF_COLOR.warn;
  if (status === 'blocking') return PDF_COLOR.bad;
  return PDF_COLOR.muted;
}

function _sevColor(sev) {
  if (sev === 'critical' || sev === 'high') return PDF_COLOR.bad;
  if (sev === 'medium') return PDF_COLOR.warn;
  if (sev === 'low') return PDF_COLOR.muted;
  return PDF_COLOR.muted;
}

export async function renderReportPdf(envelope, outputStream) {
  let PDFDocumentCtor;
  try {
    const mod = await import('pdfkit');
    PDFDocumentCtor = mod.default || mod;
  } catch (e) {
    const err = new Error(`pdfkit not installed - install via 'npm install pdfkit'. underlying: ${e.message}`);
    err.code = 'PDFKIT_UNAVAILABLE';
    throw err;
  }
  const e = envelope || {};
  const s = e.summary || {};
  const rt = e.red_team && typeof e.red_team === 'object' ? e.red_team : null;
  const rtSum = rt && rt.summary ? rt.summary : {};
  const rtScore = rt ? (rt.score == null ? 'n/a' : `${rt.score}/100`) : 'n/a';
  const RT_PDF_STATUS = { resisted: 'RESISTED', exposed: 'EXPOSED', untested: 'UNTESTED' };
  const _rtStatusColor = (st) => (st === 'resisted' ? PDF_COLOR.ok : st === 'exposed' ? PDF_COLOR.bad : PDF_COLOR.muted);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocumentCtor({ size: 'LETTER', margin: 54, info: {
      Title: 'Agent Security-Review Readiness Report',
      Author: 'kolm.ai',
      Subject: e.subject ? `Readiness report for ${e.subject.name}` : 'Agent Security-Review Readiness Report',
      Producer: 'kolm attestation-report-builder',
    } });
    doc.pipe(outputStream);
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const rule = () => {
      const y = doc.y + 2;
      doc.strokeColor(PDF_COLOR.rule).lineWidth(0.5)
        .moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke();
      doc.moveDown(0.6);
    };
    const heading = (t) => {
      if (doc.y > 660) doc.addPage();
      doc.fillColor(PDF_COLOR.ink).font('Helvetica-Bold').fontSize(15).text(t);
      doc.moveDown(0.3);
    };

    // --- Cover ---
    doc.fillColor(PDF_COLOR.ink).font('Helvetica-Bold').fontSize(24).text('Agent Security-Review');
    doc.text('Readiness Report');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).fillColor(PDF_COLOR.muted)
      .text(e.subject ? e.subject.name : '')
      .text(`generated: ${e.generated_at || 'unknown'}`)
      .text(`report id: ${e.report_id || 'unknown'}`)
      .text(`spec: ${e.spec_version || '?'} · report: ${e.report_version || '?'}`);
    if (e.watermark === true) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(PDF_COLOR.bad)
        .text('UNPAID PREVIEW - NOT FOR DISTRIBUTION', { width: contentWidth });
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
        .text('This free Scan snapshot is watermarked. Purchase the Signed Readiness Report for an unwatermarked, distributable copy and a shareable verify link your reviewer can check.', { width: contentWidth });
    }
    doc.moveDown(1);

    // Headline numbers.
    doc.font('Helvetica-Bold').fontSize(12).fillColor(PDF_COLOR.ink).text('Summary');
    doc.moveDown(0.2);
    const readiness = s.readiness_pct == null ? 'n/a' : `${s.readiness_pct}%`;
    doc.font('Helvetica').fontSize(11).fillColor(PDF_COLOR.ink)
      .text(`Readiness (assessed controls): ${readiness}`)
      .text(`Deal-blocking findings: ${s.blocking_count ?? 0}`)
      .text(`Red-team resistance: ${rtScore}`)
      .text(`Tamper-evident trail: ${s.tamper_evident ? 'yes' : 'no'}`)
      .text(`Total findings: ${s.total_findings ?? 0}`);
    doc.moveDown(0.8);
    rule();

    // --- Control status ---
    heading('Control status');
    for (const c of (s.controls || [])) {
      if (doc.y > 700) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLOR.ink)
        .text(`${c.id} - ${c.name}`, { continued: true });
      doc.font('Helvetica-Bold').fillColor(_statusColor(c.status))
        .text(`   ${(STATUS_LABEL[c.status] || c.status || '').toString()}`);
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
        .text(`${c.findings || 0} finding(s)`);
      doc.moveDown(0.4);
    }
    if ((s.not_assessed || []).length) {
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLOR.ink).text('Not assessed');
      for (const n of s.not_assessed) {
        if (doc.y > 720) doc.addPage();
        doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text(`${n.id} - ${n.reason}`, { width: contentWidth });
        doc.moveDown(0.2);
      }
    }
    doc.moveDown(0.4);
    rule();

    // --- Findings ---
    heading('Findings');
    const findings = e.findings || [];
    if (!findings.length) {
      doc.font('Helvetica').fontSize(10).fillColor(PDF_COLOR.muted).text('No deal-blocking or attention findings in the assessed controls.');
    }
    for (const f of findings) {
      if (doc.y > 680) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(_sevColor(f.severity))
        .text(`[${(f.severity || '').toUpperCase()}] `, { continued: true });
      doc.fillColor(PDF_COLOR.ink).text(f.title || f.id, { width: contentWidth });
      if (f.detail) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(f.detail, { width: contentWidth });
      doc.font('Helvetica').fontSize(8).fillColor(PDF_COLOR.muted)
        .text(`${f.asr ? f.asr.id + ' · ' : ''}${(f.frameworks || []).join(' · ') || 'no framework mapping'}`, { width: contentWidth });
      doc.moveDown(0.5);
    }
    doc.moveDown(0.2);
    rule();

    // --- Red-team resistance (ASR-4) ---
    if (rt) {
      heading(`Red-team resistance: ${rtScore}`);
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text(
        `Deterministic injection / agent-abuse battery (${rt.domain || 'generic'} suite) over the ingested events. ${rtSum.resisted ?? 0} resisted, ${rtSum.exposed ?? 0} exposed, ${rtSum.untested ?? 0} untested of ${rtSum.probes_total ?? 0} probes. The score is a graduated rollup over the exercised probes only; untested probes are marked, never scored as a pass.`,
        { width: contentWidth },
      );
      doc.moveDown(0.4);
      for (const p of (rt.probes || [])) {
        if (doc.y > 690) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10).fillColor(_sevColor(p.severity))
          .text(`[${(p.severity || '').toUpperCase()}] `, { continued: true });
        doc.fillColor(PDF_COLOR.ink).text(`${p.title || p.id}  `, { continued: true });
        doc.fillColor(_rtStatusColor(p.status)).text(RT_PDF_STATUS[p.status] || (p.status || '').toUpperCase());
        if (p.detail) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(p.detail, { width: contentWidth });
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text((p.frameworks || []).join(' · '), { width: contentWidth });
        doc.moveDown(0.4);
      }
      doc.moveDown(0.2);
      rule();
    }

    // --- Remediation ---
    heading('Remediation roadmap');
    const rem = e.remediation || [];
    if (!rem.length) doc.font('Helvetica').fontSize(10).fillColor(PDF_COLOR.muted).text('No remediation items.');
    for (const r of rem) {
      if (doc.y > 690) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLOR.ink).text(`${r.priority} - ${r.title}`, { width: contentWidth });
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(r.action, { width: contentWidth });
      if ((r.frameworks || []).length) {
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text((r.frameworks || []).join(', '), { width: contentWidth });
      }
      doc.moveDown(0.4);
    }
    doc.moveDown(0.2);
    rule();

    // --- Scope & limitations ---
    heading('Scope & limitations');
    for (const c of (e.caveats || [])) {
      if (doc.y > 710) doc.addPage();
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text('• ' + c, { width: contentWidth });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.2);
    rule();

    // --- Signature block ---
    heading('Signature');
    const sig = e.signature_ed25519 || {};
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink)
      .text(`algorithm: ${sig.alg || ' - '} (${sig.spec || ' - '})`)
      .text(`key fingerprint: ${sig.key_fingerprint || ' - '}`)
      .text(`signed at: ${sig.signed_at || ' - '}`);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
      .text(`Verify offline by pasting this report's JSON at ${e.verify_url || ''} - the Ed25519 signature is checked in the browser with no upload. Questions: ${e.contact || CONTACT_EMAIL}.`, { width: contentWidth });

    // --- Footer on every page ---
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (e.watermark === true) {
        doc.save();
        doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.font('Helvetica-Bold').fontSize(96).fillColor(PDF_COLOR.bad, 0.06)
          .text('PREVIEW', 0, doc.page.height / 2 - 60, { align: 'center', width: doc.page.width });
        doc.restore();
      }
      const bottom = doc.page.height - 36;
      doc.font('Helvetica').fontSize(8).fillColor(PDF_COLOR.muted).text(
        `kolm.ai - Agent Security Evidence - ${e.report_id || ''} - page ${i + 1 - range.start} of ${range.count}`,
        doc.page.margins.left, bottom,
        { align: 'center', width: contentWidth },
      );
    }

    doc.end();
  });
}

export default buildAndSignReport;
