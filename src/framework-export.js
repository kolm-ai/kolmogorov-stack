// src/framework-export.js
//
// Agent Security-Review audit - procurement export formatters.
//
// The signed report envelope (src/attestation-report-builder.js) already maps
// every finding to the frameworks an enterprise buyer's review group cites
// (SOC 2 TSC / ISO/IEC 42001 / NIST AI RMF / EU AI Act / OWASP LLM & Agentic /
// MITRE ATLAS, plus kolm's ASR spine). This module turns that ONE signed
// artifact into the file formats a procurement / GRC team actually ingests:
//
//   toCSV(envelope)                      findings x controls, RFC 4180
//   toExcelXml(envelope)                 SpreadsheetML 2003 .xls (no npm deps):
//                                        Summary + Findings + Framework Crosswalk
//   toDrata(envelope)                    Drata-shaped control-evidence JSON
//   toVanta(envelope)                    Vanta-shaped control-evidence JSON
//   toExecutiveSummaryMarkdown(envelope) crisp one-page exec summary
//   toFrameworkCrosswalk(envelope)       control-by-control crosswalk (Markdown)
//
// Every formatter is a PURE function that NEVER throws (a malformed or partial
// envelope yields a valid, possibly-empty artifact rather than an exception) and
// returns { filename, contentType, body }. None of them re-sign, re-canonicalize,
// or mutate the envelope - they are read-only views over the already-signed
// payload, so the cryptographic invariant in attestation-report-builder.js is
// untouched. The verification metadata (key fingerprint + offline verify URL) is
// carried into every export so an importer can always trace an artifact back to
// the signed source.

// ---------------------------------------------------------------------------
// Defensive accessors - a formatter must survive a partial / hostile envelope.
// ---------------------------------------------------------------------------
function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
function arr(x) { return Array.isArray(x) ? x : []; }
function str(x) { return x == null ? '' : String(x); }

// The six buyer frameworks (full names exactly as control-mapper.js emits them)
// plus a short column label for the crosswalk matrix. ASR is the row spine, not
// a column here.
const FRAMEWORK_COLUMNS = [
  { name: 'SOC 2 TSC', short: 'SOC 2 TSC' },
  { name: 'ISO/IEC 42001', short: 'ISO/IEC 42001' },
  { name: 'NIST AI RMF', short: 'NIST AI RMF' },
  { name: 'EU AI Act', short: 'EU AI Act' },
  { name: 'OWASP LLM & Agentic Top 10', short: 'OWASP LLM & Agentic' },
  { name: 'MITRE ATLAS', short: 'MITRE ATLAS' },
];

const CONTACT_EMAIL = 'dev@kolm.ai';

function baseName(envelope) {
  const id = str(obj(envelope).report_id) || 'agent-security-report';
  return id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'agent-security-report';
}

// A finding's framework references are flat strings "FRAMEWORK NAME CONTROLID"
// (built by frameworksOf as `${framework} ${id}`). Framework names contain
// spaces but control ids never do, so the last space splits them cleanly.
function splitFwRef(ref) {
  const s = str(ref).trim();
  if (!s) return null;
  const i = s.lastIndexOf(' ');
  if (i < 0) return { framework: s, id: '' };
  return { framework: s.slice(0, i), id: s.slice(i + 1) };
}

// finding_id -> { priority, action } from the report's remediation roadmap.
function remediationIndex(envelope) {
  const m = new Map();
  for (const r of arr(obj(envelope).remediation)) {
    const rr = obj(r);
    if (rr.finding_id != null) m.set(str(rr.finding_id), { priority: str(rr.priority), action: str(rr.action) });
  }
  return m;
}

// (framework, controlId) -> human label, sourced from the per-framework rollup.
function controlLabelIndex(envelope) {
  const m = new Map();
  for (const fw of arr(obj(envelope).frameworks)) {
    const f = obj(fw);
    for (const c of arr(f.controls)) {
      const cc = obj(c);
      m.set(str(f.framework) + ' ' + str(cc.id), str(cc.label));
    }
  }
  return m;
}

// status from a worst-severity string (framework controls only carry severity).
function statusFromSeverity(sev) {
  const s = str(sev).toLowerCase();
  if (s === 'critical' || s === 'high') return 'fail';
  if (s === 'medium' || s === 'low') return 'attention';
  return 'pass';
}

// ASR control status (pass|attention|blocking) -> the export's status vocab.
function statusFromAsr(status) {
  const s = str(status).toLowerCase();
  if (s === 'blocking') return 'fail';
  if (s === 'attention') return 'attention';
  if (s === 'pass') return 'pass';
  return 'pass';
}

// ===========================================================================
// 1) CSV - findings x controls, RFC 4180.
// ===========================================================================

// RFC 4180 field: quote when it contains comma, quote, CR or LF; double inner
// quotes. Records are CRLF-separated.
function csvField(v) {
  const s = str(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(cells) { return cells.map(csvField).join(','); }

const CSV_HEADER = [
  'report_id', 'subject', 'generated_at', 'tier',
  'finding_id', 'severity', 'pillar', 'asr_id', 'asr_name',
  'title', 'detail', 'framework', 'control_id', 'control_label',
  'remediation_priority', 'remediation_action',
  'verify_url', 'key_fingerprint',
];

export function toCSV(envelope) {
  const e = obj(envelope);
  const summary = obj(e.summary);
  const rem = remediationIndex(e);
  const labels = controlLabelIndex(e);
  const sig = obj(e.signature_ed25519);
  const reportId = str(e.report_id);
  const subject = str(obj(e.subject).name);
  const generated = str(e.generated_at);
  const tier = str(e.tier);
  const verifyUrl = str(e.verify_url);
  const fp = str(sig.key_fingerprint);

  const rows = [csvRow(CSV_HEADER)];

  // One row per (finding x mapped control). A finding with no framework refs
  // still emits a single row so it is never silently dropped.
  for (const f0 of arr(e.findings)) {
    const f = obj(f0);
    const asr = obj(f.asr);
    const r = rem.get(str(f.id)) || {};
    const refs = arr(f.frameworks).map(splitFwRef).filter(Boolean);
    const base = [
      reportId, subject, generated, tier,
      str(f.id), str(f.severity), str(f.pillar), str(asr.id), str(asr.name),
      str(f.title), str(f.detail),
    ];
    if (refs.length === 0) {
      rows.push(csvRow([...base, '', '', '', str(r.priority), str(r.action), verifyUrl, fp]));
      continue;
    }
    for (const ref of refs) {
      const label = labels.get(ref.framework + ' ' + ref.id) || '';
      rows.push(csvRow([...base, ref.framework, ref.id, label, str(r.priority), str(r.action), verifyUrl, fp]));
    }
  }

  // A clean report (no findings) still emits the header + a single posture row so
  // the file is never empty and the readiness/scope are captured.
  if (arr(e.findings).length === 0) {
    rows.push(csvRow([
      reportId, subject, generated, tier,
      '(none)', 'info', '', '', '',
      `No deal-blocking or attention findings; readiness ${summary.readiness_pct == null ? 'n/a' : summary.readiness_pct + '%'}`,
      '', '', '', '', '', '', verifyUrl, fp,
    ]));
  }

  return {
    filename: `${baseName(e)}-findings.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: rows.join('\r\n'),
  };
}

// ===========================================================================
// 2) SpreadsheetML 2003 (.xls) - Summary + Findings + Framework Crosswalk.
//    A real, openable Excel workbook built as XML, no npm dependency.
// ===========================================================================

// Illegal-in-XML-1.0 control chars (everything 0x00-0x1F except tab/LF/CR) are
// stripped so a hostile log value can never produce a non-well-formed workbook.
const XML_BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
function xmlEsc(v) {
  return str(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(XML_BAD_CHARS, ' ');
}

function strCell(v, styleId) {
  const s = styleId ? ` ss:StyleID="${styleId}"` : '';
  return `<Cell${s}><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`;
}
function numCell(v, styleId) {
  const n = Number(v);
  if (!Number.isFinite(n)) return strCell(v == null ? '' : v, styleId);
  const s = styleId ? ` ss:StyleID="${styleId}"` : '';
  return `<Cell${s}><Data ss:Type="Number">${n}</Data></Cell>`;
}
function row(cells) { return `<Row>${cells.join('')}</Row>`; }

function worksheet(name, rows) {
  return `<Worksheet ss:Name="${xmlEsc(name)}"><Table>${rows.join('')}</Table></Worksheet>`;
}

export function toExcelXml(envelope) {
  const e = obj(envelope);
  const summary = obj(e.summary);
  const sig = obj(e.signature_ed25519);
  const rem = remediationIndex(e);
  const subjectName = str(obj(e.subject).name);

  // --- Summary sheet ---
  const sumRows = [];
  sumRows.push(row([strCell('Agent Security-Review - Readiness Evidence', 'title')]));
  const kv = (k, v, style) => row([strCell(k, 'key'), (style ? strCell(v, style) : strCell(v))]);
  sumRows.push(kv('Subject', subjectName));
  sumRows.push(kv('Report ID', str(e.report_id)));
  sumRows.push(kv('Generated', str(e.generated_at)));
  sumRows.push(kv('Tier', str(e.tier) + (e.watermark === true ? ' (UNPAID PREVIEW - watermarked)' : '')));
  sumRows.push(kv('Report schema', `${str(e.schema)} ${str(e.report_version)}`));
  sumRows.push(row([]));
  sumRows.push(row([strCell('Metric', 'hdr'), strCell('Value', 'hdr')]));
  sumRows.push(row([strCell('Readiness (assessed controls)'), summary.readiness_pct == null ? strCell('n/a') : strCell(summary.readiness_pct + '%')]));
  sumRows.push(row([strCell('Deal-blocking findings'), numCell(summary.blocking_count ?? 0)]));
  sumRows.push(row([strCell('Total findings'), numCell(summary.total_findings ?? arr(e.findings).length)]));
  sumRows.push(row([strCell('Tamper-evident trail'), strCell(summary.tamper_evident ? 'Yes' : 'No')]));
  sumRows.push(row([strCell('Assessed controls'), strCell(arr(summary.assessed_controls).join(', '))]));
  sumRows.push(row([]));
  sumRows.push(row([strCell('Control', 'hdr'), strCell('Name', 'hdr'), strCell('Status', 'hdr'), strCell('Findings', 'hdr')]));
  for (const c0 of arr(summary.controls)) {
    const c = obj(c0);
    const stStyle = c.status === 'blocking' ? 'bad' : c.status === 'attention' ? 'warn' : 'ok';
    sumRows.push(row([strCell(c.id), strCell(c.name), strCell(str(c.status).toUpperCase(), stStyle), numCell(c.findings ?? 0)]));
  }
  for (const n0 of arr(summary.not_assessed)) {
    const n = obj(n0);
    sumRows.push(row([strCell(n.id), strCell(n.reason), strCell('NOT ASSESSED', 'muted'), numCell(0)]));
  }
  sumRows.push(row([]));
  sumRows.push(row([strCell('Signature (Ed25519)', 'hdr'), strCell('', 'hdr')]));
  sumRows.push(kv('Key fingerprint', str(sig.key_fingerprint)));
  sumRows.push(kv('Signed at', str(sig.signed_at)));
  sumRows.push(kv('Verify offline', str(e.verify_url)));
  sumRows.push(kv('Contact', str(e.contact) || CONTACT_EMAIL));

  // --- Findings sheet ---
  const findRows = [];
  findRows.push(row([
    strCell('Finding ID', 'hdr'), strCell('Severity', 'hdr'), strCell('Pillar', 'hdr'),
    strCell('ASR', 'hdr'), strCell('Title', 'hdr'), strCell('Detail', 'hdr'),
    strCell('Frameworks', 'hdr'), strCell('Remediation priority', 'hdr'), strCell('Remediation action', 'hdr'),
  ]));
  const findings = arr(e.findings);
  if (findings.length === 0) {
    findRows.push(row([strCell('(none)'), strCell('info'), strCell(''), strCell(''), strCell('No deal-blocking or attention findings in the assessed controls.'), strCell(''), strCell(''), strCell(''), strCell('')]));
  }
  for (const f0 of findings) {
    const f = obj(f0);
    const asr = obj(f.asr);
    const r = rem.get(str(f.id)) || {};
    const sevStyle = (f.severity === 'critical' || f.severity === 'high') ? 'bad' : f.severity === 'medium' ? 'warn' : 'muted';
    findRows.push(row([
      strCell(f.id), strCell(str(f.severity).toUpperCase(), sevStyle), strCell(f.pillar),
      strCell(asr.id ? `${asr.id} ${asr.name || ''}`.trim() : ''),
      strCell(f.title), strCell(f.detail),
      strCell(arr(f.frameworks).join(' | ')), strCell(r.priority), strCell(r.action),
    ]));
  }

  // --- Framework Crosswalk sheet (one row per implicated framework control) ---
  const cwRows = [];
  cwRows.push(row([
    strCell('Framework', 'hdr'), strCell('Control', 'hdr'), strCell('Covers', 'hdr'),
    strCell('Findings', 'hdr'), strCell('Worst severity', 'hdr'),
  ]));
  let anyControl = false;
  for (const fw0 of arr(e.frameworks)) {
    const fw = obj(fw0);
    for (const c0 of arr(fw.controls)) {
      anyControl = true;
      const c = obj(c0);
      const sevStyle = (c.max_severity === 'critical' || c.max_severity === 'high') ? 'bad' : c.max_severity === 'medium' ? 'warn' : 'muted';
      cwRows.push(row([strCell(fw.framework), strCell(c.id), strCell(c.label), numCell(c.findings ?? 0), strCell(str(c.max_severity).toUpperCase(), sevStyle)]));
    }
  }
  if (!anyControl) {
    cwRows.push(row([strCell('(none)'), strCell(''), strCell('No framework controls were implicated by findings in this run.'), numCell(0), strCell('')]));
  }

  const styles = `<Styles>
 <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>
 <Style ss:ID="title"><Font ss:Bold="1" ss:Size="15" ss:Color="#0B0E14"/></Style>
 <Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F2937" ss:Pattern="Solid"/></Style>
 <Style ss:ID="key"><Font ss:Bold="1" ss:Color="#374151"/></Style>
 <Style ss:ID="ok"><Font ss:Bold="1" ss:Color="#166534"/></Style>
 <Style ss:ID="warn"><Font ss:Bold="1" ss:Color="#0E7490"/></Style>
 <Style ss:ID="bad"><Font ss:Bold="1" ss:Color="#991B1B"/></Style>
 <Style ss:ID="muted"><Font ss:Color="#5B6472"/></Style>
</Styles>`;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
${styles}
${worksheet('Summary', sumRows)}
${worksheet('Findings', findRows)}
${worksheet('Framework Crosswalk', cwRows)}
</Workbook>`;

  return {
    filename: `${baseName(e)}.xls`,
    contentType: 'application/vnd.ms-excel',
    body,
  };
}

// ===========================================================================
// Shared control-evidence model for the GRC (Drata / Vanta) imports.
//
// Builds ONE list of per-control evidence records from the three sources the
// signed report carries: the ASR spine (with real pass/attention/blocking
// status, including PASS controls), the not-assessed ASR controls (explicit
// scope, no theater), and every implicated framework control from the rollup.
// Drata and Vanta each re-key this list into their own evidence vocabulary.
// ===========================================================================
function controlEvidenceRecords(envelope) {
  const e = obj(envelope);
  const summary = obj(e.summary);
  const records = [];

  // findings grouped by ASR id, and by framework ref, so each evidence record
  // can cite the concrete findings behind it.
  const byAsr = new Map();
  const byFwRef = new Map();
  for (const f0 of arr(e.findings)) {
    const f = obj(f0);
    const lite = { id: str(f.id), severity: str(f.severity), title: str(f.title) };
    const aid = obj(f.asr).id;
    if (aid) { if (!byAsr.has(aid)) byAsr.set(aid, []); byAsr.get(aid).push(lite); }
    for (const ref of arr(f.frameworks)) {
      if (!byFwRef.has(ref)) byFwRef.set(ref, []);
      byFwRef.get(ref).push(lite);
    }
  }

  // 1) ASR spine - the kolm Agent Security Readiness controls actually assessed.
  for (const c0 of arr(summary.controls)) {
    const c = obj(c0);
    records.push({
      framework: 'ASR (kolm Agent Security Readiness)',
      controlId: str(c.id),
      controlName: str(c.name),
      status: statusFromAsr(c.status),
      severity: c.status === 'blocking' ? 'high' : c.status === 'attention' ? 'medium' : null,
      findingsCount: c.findings ?? 0,
      findings: byAsr.get(str(c.id)) || [],
    });
  }
  // 2) ASR controls NOT assessed in this run - disclosed with their reason.
  for (const n0 of arr(summary.not_assessed)) {
    const n = obj(n0);
    records.push({
      framework: 'ASR (kolm Agent Security Readiness)',
      controlId: str(n.id),
      controlName: str(n.reason),
      status: 'not_assessed',
      severity: null,
      findingsCount: 0,
      findings: [],
    });
  }
  // 3) Every implicated framework control (SOC2 / ISO / NIST / EU / OWASP / MITRE).
  for (const fw0 of arr(e.frameworks)) {
    const fw = obj(fw0);
    for (const c0 of arr(fw.controls)) {
      const c = obj(c0);
      records.push({
        framework: str(fw.framework),
        controlId: str(c.id),
        controlName: str(c.label),
        status: statusFromSeverity(c.max_severity),
        severity: str(c.max_severity) || null,
        findingsCount: c.findings ?? 0,
        findings: byFwRef.get(`${str(fw.framework)} ${str(c.id)}`) || [],
      });
    }
  }
  return records;
}

function evidenceSource(envelope) {
  const e = obj(envelope);
  return {
    vendor: 'kolm.ai',
    product: 'Agent Security-Review',
    report_id: str(e.report_id),
    report_schema: str(e.schema),
    report_version: str(e.report_version),
    spec_version: str(e.spec_version),
    generated_at: str(e.generated_at),
    subject: str(obj(e.subject).name),
    tier: str(e.tier),
    watermark: e.watermark === true,
  };
}

function evidenceVerification(envelope) {
  const e = obj(envelope);
  const sig = obj(e.signature_ed25519);
  return {
    algorithm: str(sig.alg) || 'ed25519',
    spec: str(sig.spec) || 'kolm-ed25519-v1',
    key_fingerprint: str(sig.key_fingerprint),
    signed_at: str(sig.signed_at),
    verify_url: str(e.verify_url),
    offline_verifiable: true,
    instructions: 'Re-verify the source report by pasting its signed JSON at the verify_url (browser, no upload) or POSTing it to /v1/audit/report/verify. A trusted verdict requires BOTH a valid Ed25519 signature and a recognized issuer key.',
  };
}

function evidenceSummary(envelope) {
  const s = obj(obj(envelope).summary);
  return {
    readiness_pct: s.readiness_pct ?? null,
    blocking_count: s.blocking_count ?? 0,
    total_findings: s.total_findings ?? arr(obj(envelope).findings).length,
    tamper_evident: s.tamper_evident === true,
    by_severity: obj(s.by_severity),
  };
}

// ===========================================================================
// 3a) Drata - control-evidence import payload.
// ===========================================================================
const DRATA_STATUS = { pass: 'PASSED', attention: 'NEEDS_ATTENTION', fail: 'FAILED', not_assessed: 'NOT_ASSESSED' };

export function toDrata(envelope) {
  const e = obj(envelope);
  const generated = str(e.generated_at);
  const verifyUrl = str(e.verify_url);
  const evidence = controlEvidenceRecords(e).map((rec) => ({
    name: `Agent Security-Review - ${rec.framework} ${rec.controlId}`.trim(),
    framework: rec.framework,
    control: rec.controlId,
    controlName: rec.controlName,
    status: DRATA_STATUS[rec.status] || 'NOT_ASSESSED',
    severity: rec.severity,
    evidenceType: 'automated',
    collectedAt: generated,
    sourceUrl: verifyUrl,
    description: `${rec.controlName || rec.controlId} - ${rec.findingsCount} finding(s) from the kolm signed Agent Security-Review report.`,
    findings: rec.findings,
  }));

  const payload = {
    $schema: 'kolm-control-evidence/1',
    format: 'drata-external-evidence',
    source: evidenceSource(e),
    verification: evidenceVerification(e),
    summary: evidenceSummary(e),
    evidence,
    caveats: arr(e.caveats).map(str),
    mapping_note: 'Generic control-evidence shaped for Drata External Evidence. Each "evidence" item attaches to the named framework "control" with the mapped "status" (PASSED / NEEDS_ATTENTION / FAILED / NOT_ASSESSED). Import via Drata\'s External Evidence API/UI or attach by control code; see docs/exports.md.',
  };
  return {
    filename: `${baseName(e)}-drata.json`,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload, null, 2),
  };
}

// ===========================================================================
// 3b) Vanta - control-evidence import payload.
// ===========================================================================
const VANTA_STATUS = { pass: 'OK', attention: 'NEEDS_ATTENTION', fail: 'FAILING', not_assessed: 'NOT_ASSESSED' };

export function toVanta(envelope) {
  const e = obj(envelope);
  const generated = str(e.generated_at);
  const verifyUrl = str(e.verify_url);
  const controls = controlEvidenceRecords(e).map((rec) => ({
    framework: rec.framework,
    controlId: rec.controlId,
    controlName: rec.controlName,
    status: VANTA_STATUS[rec.status] || 'NOT_ASSESSED',
    severity: rec.severity,
    findingsCount: rec.findingsCount,
    findings: rec.findings,
    evidenceUrl: verifyUrl,
    collectedAt: generated,
  }));

  const payload = {
    $schema: 'kolm-control-evidence/1',
    format: 'vanta-custom-evidence',
    source: evidenceSource(e),
    verification: evidenceVerification(e),
    summary: evidenceSummary(e),
    controls,
    caveats: arr(e.caveats).map(str),
    mapping_note: 'Generic control-evidence shaped for Vanta custom/external evidence. Each "controls" entry carries a framework, controlId, mapped "status" (OK / NEEDS_ATTENTION / FAILING / NOT_ASSESSED) and the findings behind it. Import via Vanta\'s custom-evidence/Integrations API or attach to a control; see docs/exports.md.',
  };
  return {
    filename: `${baseName(e)}-vanta.json`,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload, null, 2),
  };
}

// ===========================================================================
// 4) Executive summary - a crisp one-page Markdown brief.
// ===========================================================================

// Markdown table cell: collapse newlines, escape the pipe so the column never
// breaks. (Plain prose elsewhere needs no escaping.)
function mdCell(v) { return str(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'); }

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function toExecutiveSummaryMarkdown(envelope) {
  const e = obj(envelope);
  const s = obj(e.summary);
  const subject = str(obj(e.subject).name) || 'Agent fleet';
  const readiness = s.readiness_pct == null ? 'n/a' : `${s.readiness_pct}%`;
  const blocking = s.blocking_count ?? 0;
  const total = s.total_findings ?? arr(e.findings).length;
  const tamper = s.tamper_evident ? 'Yes' : 'No';
  const frameworksList = arr(e.frameworks).map((f) => str(obj(f).framework)).filter(Boolean);
  const sig = obj(e.signature_ed25519);

  const lines = [];
  lines.push('# Agent Security-Review - Executive Summary');
  lines.push('');
  lines.push(`**Subject:** ${mdCell(subject)}  `);
  lines.push(`**Report:** \`${str(e.report_id)}\`  `);
  lines.push(`**Generated:** ${str(e.generated_at)}  `);
  lines.push(`**Tier:** ${str(e.tier) || 'scan'}${e.watermark === true ? ' (UNPAID PREVIEW - watermarked, not for distribution)' : ''}`);
  lines.push('');

  lines.push('## Verdict');
  const verdict = blocking > 0
    ? `${blocking} deal-blocking finding(s) must be remediated before this agent posture clears a security review. Readiness is ${readiness} across the assessed controls.`
    : (s.readiness_pct === 100
      ? `No deal-blocking or attention findings in the assessed controls - readiness ${readiness}.`
      : `No deal-blocking findings; readiness is ${readiness} across the assessed controls, with attention items below.`);
  lines.push(verdict);
  lines.push('');
  lines.push('Assessed controls: ASR-1 Least privilege, ASR-2 Audit trail, ASR-3 Data egress. The readiness percentage is a graduated rollup over the assessed controls only (pass = 1, attention = 0.5, blocking = 0); it is not a certification.');
  lines.push('');

  lines.push('## At a glance');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Readiness (assessed controls) | ${mdCell(readiness)} |`);
  lines.push(`| Deal-blocking findings | ${mdCell(blocking)} |`);
  lines.push(`| Total findings | ${mdCell(total)} |`);
  lines.push(`| Tamper-evident trail | ${mdCell(tamper)} |`);
  lines.push(`| Frameworks referenced | ${mdCell(frameworksList.join(', ') || 'none')} |`);
  lines.push('');

  lines.push('## Control status');
  lines.push('| Control | Name | Status | Findings |');
  lines.push('| --- | --- | --- | --- |');
  for (const c0 of arr(s.controls)) {
    const c = obj(c0);
    lines.push(`| ${mdCell(c.id)} | ${mdCell(c.name)} | ${mdCell(str(c.status).toUpperCase())} | ${mdCell(c.findings ?? 0)} |`);
  }
  const notAssessed = arr(s.not_assessed);
  if (notAssessed.length) {
    lines.push('');
    lines.push('Not assessed this run:');
    for (const n0 of notAssessed) {
      const n = obj(n0);
      lines.push(`- **${mdCell(n.id)}** - ${mdCell(n.reason)}`);
    }
  }
  lines.push('');

  lines.push('## Top findings');
  const topFindings = arr(e.findings)
    .slice()
    .sort((a, b) => (SEV_RANK[str(obj(a).severity)] ?? 9) - (SEV_RANK[str(obj(b).severity)] ?? 9))
    .slice(0, 5);
  if (topFindings.length === 0) {
    lines.push('_No deal-blocking or attention findings in the assessed controls._');
  } else {
    for (const f0 of topFindings) {
      const f = obj(f0);
      const fw = arr(f.frameworks).join(' / ') || 'no framework mapping';
      lines.push(`1. **[${str(f.severity).toUpperCase()}] ${mdCell(f.title)}** - ${mdCell(fw)}`);
    }
  }
  lines.push('');

  lines.push('## Priority remediation');
  const rem = arr(e.remediation).slice(0, 5);
  if (rem.length === 0) {
    lines.push('_No remediation items._');
  } else {
    for (const r0 of rem) {
      const r = obj(r0);
      lines.push(`- **${mdCell(r.priority)}** ${mdCell(r.title)} - ${mdCell(r.action)}`);
    }
  }
  lines.push('');

  lines.push('## Scope & limitations');
  for (const c of arr(e.caveats)) lines.push(`- ${mdCell(c)}`);
  lines.push('');

  lines.push('## Verification');
  lines.push(`Signed Ed25519 (\`${str(sig.key_fingerprint) || '-'}\`), signed at ${str(sig.signed_at) || '-'}. Verify offline at ${str(e.verify_url) || '-'} - the signature is checked in the browser with no upload and no account. A trusted verdict requires both a valid signature and a recognized issuer key.`);
  lines.push('');
  lines.push(`_kolm.ai - Agent Security Evidence · ${str(e.contact) || CONTACT_EMAIL}_`);
  lines.push('');

  return {
    filename: `${baseName(e)}-executive-summary.md`,
    contentType: 'text/markdown; charset=utf-8',
    body: lines.join('\n'),
  };
}

// ===========================================================================
// 5) Framework crosswalk - a control-by-control matrix (Markdown).
//
//   Part 1: ASR control -> framework controls matrix (one row per ASR control,
//           one column per buyer framework, cells list the implicated controls).
//   Part 2: per-framework control detail (every implicated control + coverage).
// ===========================================================================
export function toFrameworkCrosswalk(envelope) {
  const e = obj(envelope);
  const s = obj(e.summary);
  const subject = str(obj(e.subject).name) || 'Agent fleet';

  // ASR id -> status string for the matrix.
  const asrStatus = new Map();
  for (const c0 of arr(s.controls)) { const c = obj(c0); asrStatus.set(str(c.id), str(c.status).toUpperCase()); }
  for (const n0 of arr(s.not_assessed)) { const n = obj(n0); if (!asrStatus.has(str(n.id))) asrStatus.set(str(n.id), 'not assessed'); }
  const asrFindings = new Map();
  for (const c0 of arr(s.controls)) { const c = obj(c0); asrFindings.set(str(c.id), c.findings ?? 0); }

  // For each ASR control, the set of framework control ids per framework,
  // derived from the findings that map to that ASR control.
  // asrId -> Map(frameworkName -> Set(controlId))
  const asrMatrix = new Map();
  for (const f0 of arr(e.findings)) {
    const f = obj(f0);
    const aid = obj(f.asr).id;
    if (!aid) continue;
    if (!asrMatrix.has(aid)) asrMatrix.set(aid, new Map());
    const fwMap = asrMatrix.get(aid);
    for (const ref of arr(f.frameworks)) {
      const parsed = splitFwRef(ref);
      if (!parsed) continue;
      if (!fwMap.has(parsed.framework)) fwMap.set(parsed.framework, new Set());
      if (parsed.id) fwMap.get(parsed.framework).add(parsed.id);
    }
  }

  // The full ASR spine (all six) from the checklist, so clean + not-assessed
  // controls still appear as rows.
  const asrRows = arr(e.asr_checklist).length
    ? arr(e.asr_checklist).map((a) => ({ id: str(obj(a).id), name: str(obj(a).name) }))
    : [...asrStatus.keys()].map((id) => ({ id, name: '' }));

  const lines = [];
  lines.push(`# Framework Crosswalk - ${mdCell(subject)}`);
  lines.push('');
  lines.push(`\`${str(e.report_id)}\` · generated ${str(e.generated_at)} · kolm.ai Agent Security-Review`);
  lines.push('');
  lines.push('Maps each kolm ASR control to the framework controls an enterprise reviewer cites, then lists every framework control implicated by this audit\'s findings. Cells show the controls implicated **by findings in this run**; a blank cell means no finding touched that framework for that control.');
  lines.push('');

  // --- Part 1: ASR -> framework matrix ---
  lines.push('## ASR control coverage');
  lines.push(`| ASR control | Status | Findings | ${FRAMEWORK_COLUMNS.map((c) => mdCell(c.short)).join(' | ')} |`);
  lines.push(`| --- | --- | --- | ${FRAMEWORK_COLUMNS.map(() => '---').join(' | ')} |`);
  for (const a of asrRows) {
    const status = asrStatus.get(a.id) || 'not assessed';
    const findings = asrFindings.get(a.id);
    const fwMap = asrMatrix.get(a.id) || new Map();
    const cells = FRAMEWORK_COLUMNS.map((col) => {
      const set = fwMap.get(col.name);
      return set && set.size ? mdCell([...set].sort().join(', ')) : '';
    });
    const label = `${a.id}${a.name ? ' ' + a.name : ''}`;
    lines.push(`| ${mdCell(label)} | ${mdCell(status)} | ${mdCell(findings == null ? '-' : findings)} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // --- Part 2: per-framework control detail ---
  lines.push('## Framework control detail');
  lines.push('| Framework | Control | Covers | Findings | Worst severity |');
  lines.push('| --- | --- | --- | --- | --- |');
  let any = false;
  for (const fw0 of arr(e.frameworks)) {
    const fw = obj(fw0);
    for (const c0 of arr(fw.controls)) {
      any = true;
      const c = obj(c0);
      lines.push(`| ${mdCell(fw.framework)} | ${mdCell(c.id)} | ${mdCell(c.label)} | ${mdCell(c.findings ?? 0)} | ${mdCell(str(c.max_severity).toUpperCase())} |`);
    }
  }
  if (!any) lines.push('| _(none)_ | | No framework controls were implicated by findings in this run. | 0 | |');
  lines.push('');
  lines.push(`Verify the signed source report offline at ${str(e.verify_url) || '-'}. Questions: ${str(e.contact) || CONTACT_EMAIL}.`);
  lines.push('');

  return {
    filename: `${baseName(e)}-framework-crosswalk.md`,
    contentType: 'text/markdown; charset=utf-8',
    body: lines.join('\n'),
  };
}

// A registry the route layer can dispatch over (format string -> formatter).
export const EXPORTERS = Object.freeze({
  csv: toCSV,
  xlsx: toExcelXml,
  drata: toDrata,
  vanta: toVanta,
  exec: toExecutiveSummaryMarkdown,
  crosswalk: toFrameworkCrosswalk,
});

export const EXPORT_FORMATS = Object.freeze(Object.keys(EXPORTERS));

export default EXPORTERS;
