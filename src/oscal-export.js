// src/oscal-export.js
//
// Agent Security-Review audit - GRC Evidence Pack (OFFER #6).
//
// Renders a deterministic audit result (from runAudit in
// src/audit-orchestrator.js) into the two artifacts a buyer's GRC team ingests:
//
//   buildOscalAssessmentResults(result, meta)
//       A NIST OSCAL assessment-results JSON document: metadata + results[]
//       with findings[] (each carrying its target control-ids + observations),
//       mapped from result.controls + result.findings through the existing
//       src/control-mapper.js crosswalk. This is an ASSESSMENT-RESULTS export,
//       NOT a certification: kolm MAPS a finding to the controls a reviewer
//       cites; it never asserts the subject is compliant with or certified
//       against any framework. Every props/remark says so in plain language.
//
//   buildRemediationTable(result)
//       A POA&M-style remediation table: one row per finding, carrying
//       finding -> severity -> mapped controls -> owner placeholder -> due-date
//       placeholder -> re-test status. The placeholders are unfilled on purpose
//       (kolm states what the code observed; the owner/schedule are the buyer's
//       to assign), so a control the logs never exercised is reported 'untested',
//       never silently passed.
//
// Both functions are PURE and NEVER throw (a partial / hostile result yields a
// valid, possibly-empty document rather than an exception) and are
// deterministic: the same result + meta always renders byte-identical output,
// with no Date.now()/random in the body. The only non-determinism a caller can
// introduce is meta.generated (an explicit timestamp the caller controls); when
// omitted it is rendered as a stable fixed sentinel so the document is still
// reproducible. No re-ingest: every field is derived from the supplied result.
//
// kolm MAPS to standards, never certifies - claim only what the code observed.

import crypto from 'node:crypto';
import { mapFinding } from './control-mapper.js';

export const OSCAL_EXPORT_VERSION = 'asr-oscal-export/0.1';

// The OSCAL assessment-results model version this document targets. NIST
// publishes the model under the 1.x line; the document declares the version it
// was shaped against so an importer can pin its parser.
const OSCAL_VERSION = '1.1.2';

// A fixed, reproducible sentinel timestamp used when the caller supplies no
// explicit meta.generated. Keeping it constant (not Date.now()) is what makes
// the document deterministic - two renders of the same result are byte-equal.
const FIXED_GENERATED = '1970-01-01T00:00:00Z';

const CONTACT_EMAIL = 'dev@kolm.ai';

// kolm's standing posture string, embedded so every consumer reads the same
// MAPS-not-certifies framing directly off the artifact.
const MAPS_NOTICE =
  'kolm maps each finding to the controls a reviewer cites; it does not certify '
  + 'compliance with, or conformance to, any framework. This is an '
  + 'assessment-results export, not a certificate of compliance.';

// The contractual scope statement, verbatim. Embedded so the OSCAL document and
// the remediation table both carry the exact assessed-scope language.
const SCOPE_LINE =
  'Scope is contractual. Permission posture, redaction and audit-trail '
  + 'integrity are assessed. Injection is tested and reported, not warranted.';

// ---------------------------------------------------------------------------
// Defensive accessors - every render must survive a partial / hostile result.
// ---------------------------------------------------------------------------
function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
function arr(x) { return Array.isArray(x) ? x : []; }
function str(x) { return x == null ? '' : String(x); }

// A stable, deterministic UUID derived from a seed string (RFC 4122 v5-style:
// namespaced SHA-1, version/variant bits set). OSCAL ids must be UUIDs; deriving
// them from the report id + a role keeps the document reproducible (no random
// uuid) while staying schema-valid. Never throws.
const _UUID_NS = 'kolm-asr-oscal';
function detUuid(seed) {
  let hex;
  try {
    hex = crypto.createHash('sha1').update(_UUID_NS + '|' + str(seed)).digest('hex');
  } catch {
    // Last-resort deterministic fallback so the function never throws.
    hex = '00000000000000000000000000000000000000000';
  }
  const b = hex.slice(0, 32).padEnd(32, '0').split('');
  // version 5
  b[12] = '5';
  // variant 10xx -> 8,9,a,b
  const v = parseInt(b[16], 16);
  b[16] = ((v & 0x3) | 0x8).toString(16);
  const s = b.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// The mapped findings: prefer result.controls.findings (already crosswalked by
// mapControls), and fall back to mapping result.findings through mapFinding so
// the export still works on a result that carries only raw findings. Each mapped
// finding exposes { id, severity, pillar, title, detail, asr:{id,name},
// controls:[{framework,id,label}] }. Never throws.
function mappedFindings(result) {
  const r = obj(result);
  const pre = arr(obj(r.controls).findings);
  if (pre.length) return pre.map(obj);
  return arr(r.findings).map((f) => {
    try { return obj(mapFinding(f)); } catch { return obj(f); }
  });
}

// Severity -> whether the finding blocks a clean attestation. The orchestrator
// treats critical/high as deal-blocking (summary.blocking), so the remediation
// table and the OSCAL finding props use the same line.
function isBlocking(sev) {
  const s = str(sev).toLowerCase();
  return s === 'critical' || s === 'high';
}

// The flat list of control reference strings ("FRAMEWORK NAME CONTROLID") a
// finding maps to, deduped + stably sorted so the output is deterministic.
function controlRefs(mf) {
  const seen = new Set();
  const out = [];
  for (const c of arr(mf.controls)) {
    const cc = obj(c);
    const fw = str(cc.framework);
    const id = str(cc.id);
    if (!fw && !id) continue;
    const ref = (fw + ' ' + id).trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ framework: fw, id, label: str(cc.label), ref });
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));
  return out;
}

// ---------------------------------------------------------------------------
// buildOscalAssessmentResults(result, meta) -> OSCAL assessment-results JSON.
//
// meta (all optional):
//   subject        the assessed subject's display name
//   report_id      the signed report id (seeds deterministic uuids + links)
//   generated      an explicit ISO timestamp (else a fixed sentinel)
//   verify_url     the offline verify URL for the signed source report
//   key_fingerprint the signing key fingerprint, carried as a prop
// ---------------------------------------------------------------------------
export function buildOscalAssessmentResults(result, meta = {}) {
  const r = obj(result);
  const m = obj(meta);
  const summary = obj(r.summary);

  const subjectName = str(m.subject) || str(obj(r.subject).name) || 'Agent fleet';
  const reportId = str(m.report_id) || str(r.report_id) || 'agent-security-report';
  const generated = str(m.generated) || FIXED_GENERATED;
  const evTier = obj(r.evidence_tier);

  const findings = mappedFindings(r);

  // Collect the union of control refs across all findings so the document's
  // metadata can list which controls were touched (deterministic, sorted).
  const allRefs = new Map();
  for (const mf of findings) {
    for (const ref of controlRefs(mf)) {
      if (!allRefs.has(ref.ref)) allRefs.set(ref.ref, ref);
    }
  }

  // One OSCAL observation + finding per audit finding. The observation records
  // WHAT was seen (the detail); the finding ties it to the target control-ids.
  const observations = [];
  const oscalFindings = [];
  for (const mf of findings) {
    const fid = str(mf.id) || 'finding';
    const sev = str(mf.severity).toLowerCase() || 'info';
    const title = str(mf.title) || fid;
    const detail = str(mf.detail);
    const asr = obj(mf.asr);
    const refs = controlRefs(mf);

    const obsUuid = detUuid(reportId + '|obs|' + fid);
    const fndUuid = detUuid(reportId + '|fnd|' + fid);

    observations.push({
      uuid: obsUuid,
      title: `Observation: ${title}`,
      description: detail || title,
      methods: ['EXAMINE'],
      // What the audit looked at: the agent activity logs, graded by evidence
      // tier so the observation is never stronger than the input that produced it.
      props: compact([
        prop('finding-id', fid),
        prop('pillar', str(mf.pillar)),
        prop('severity', sev),
        asr.id ? prop('asr-control', `${asr.id} ${str(asr.name)}`.trim()) : null,
        evTier.grade ? prop('evidence-grade', str(evTier.grade)) : null,
      ]),
      'collected': generated,
    });

    // target -> the control-ids this finding maps to. OSCAL's finding.target uses
    // an objective-id; we carry the mapped controls as related-controls props so
    // an importer reads every framework cross-reference off one finding object.
    oscalFindings.push({
      uuid: fndUuid,
      title,
      description: detail || title,
      // The mapped controls, as explicit target control-ids. This is the
      // crosswalk: a finding cross-references these controls; it does not assert
      // compliance with them.
      target: {
        type: 'objective-id',
        'target-id': asr.id ? str(asr.id) : (refs[0] ? refs[0].ref : fid),
        title: asr.id ? `${str(asr.id)} ${str(asr.name)}`.trim() : 'Mapped controls',
        status: { state: isBlocking(sev) ? 'not-satisfied' : 'satisfied' },
      },
      props: compact([
        prop('finding-id', fid),
        prop('severity', sev),
        prop('blocking', isBlocking(sev) ? 'true' : 'false'),
        prop('mapping-disposition', 'cross-reference-not-certification'),
        ...refs.map((ref) => prop('mapped-control', ref.ref, ref.label)),
      ]),
      'related-observations': [{ 'observation-uuid': obsUuid }],
      remarks: MAPS_NOTICE,
    });
  }

  // Assessment-results requires at least one result entry; emit exactly one that
  // bundles every observation + finding from this audit.
  const resultEntry = {
    uuid: detUuid(reportId + '|result'),
    title: 'Agent Security-Review assessment results',
    description:
      `Deterministic assessment of "${subjectName}" agent activity logs. ${SCOPE_LINE} ${MAPS_NOTICE}`,
    start: generated,
    props: compact([
      summary.readiness_pct == null ? null : prop('readiness-pct', String(summary.readiness_pct)),
      prop('blocking-count', String(summary.blocking_count == null ? 0 : summary.blocking_count)),
      prop('total-findings', String(summary.total_findings == null ? findings.length : summary.total_findings)),
      evTier.grade ? prop('evidence-grade', str(evTier.grade)) : null,
    ]),
    observations,
    findings: oscalFindings,
  };

  return {
    // The schema marker mirrors the rest of the export surface so a consumer can
    // tell at a glance this is a kolm assessment-results artifact, not a cert.
    schema: 'kolm-oscal-assessment-results',
    export_version: OSCAL_EXPORT_VERSION,
    'assessment-results': {
      uuid: detUuid(reportId + '|assessment-results'),
      metadata: {
        title: `Agent Security-Review - Assessment Results (${subjectName})`,
        published: generated,
        'last-modified': generated,
        version: str(r.spec_version) || OSCAL_EXPORT_VERSION,
        'oscal-version': OSCAL_VERSION,
        // Plain-language framing carried INSIDE the metadata so the
        // not-a-certification posture travels with the document.
        remarks: `${MAPS_NOTICE} ${SCOPE_LINE} Source report: ${reportId}.`,
        props: compact([
          prop('artifact-kind', 'assessment-results'),
          prop('not-a-certification', 'true'),
          prop('source-report-id', reportId),
          m.verify_url ? prop('verify-url', str(m.verify_url)) : null,
          m.key_fingerprint ? prop('key-fingerprint', str(m.key_fingerprint)) : null,
          ...[...allRefs.values()].map((ref) => prop('control-touched', ref.ref, ref.label)),
        ]),
      },
      // import-ap is REQUIRED by the OSCAL assessment-results model: a pointer to
      // the assessment plan. kolm runs a deterministic, plan-free battery, so the
      // pointer names the spec the battery implements rather than a separate plan
      // document.
      'import-ap': {
        href: `#${str(r.spec_version) || OSCAL_EXPORT_VERSION}`,
        remarks: 'Deterministic Agent Security-Review battery; no separate assessment plan document.',
      },
      results: [resultEntry],
    },
  };
}

// An OSCAL prop object. `class` carries an optional human label.
function prop(name, value, klass) {
  const p = { name: str(name), value: str(value) };
  if (klass != null && str(klass) !== '') p.class = str(klass);
  return p;
}

// Drop null/undefined entries so optional props never emit holes in an array.
function compact(list) {
  return arr(list).filter((x) => x != null);
}

// ---------------------------------------------------------------------------
// buildRemediationTable(result) -> POA&M-style remediation table.
//
// Returns { columns, rows, summary }:
//   columns  the ordered column keys (stable header for any renderer)
//   rows[]   one row per finding:
//              finding_id, title, severity, blocking,
//              mapped_controls (the crosswalk refs), asr,
//              owner (placeholder - the buyer assigns),
//              due_date (placeholder - the buyer schedules),
//              retest_status ('open' for a live finding; 'not-applicable'
//                             for a clean/informational posture row)
//   summary  counts so a renderer can headline open vs blocking items.
//
// Deterministic: rows preserve the result's finding order, with blocking items
// surfaced first (stable sort) so the highest-priority remediation reads at the
// top without reordering equal-severity items. Never throws.
// ---------------------------------------------------------------------------
export const REMEDIATION_COLUMNS = Object.freeze([
  'finding_id', 'title', 'severity', 'blocking',
  'mapped_controls', 'asr', 'owner', 'due_date', 'retest_status',
]);

export function buildRemediationTable(result) {
  const r = obj(result);
  const findings = mappedFindings(r);

  const rows = findings.map((mf, idx) => {
    const sev = str(mf.severity).toLowerCase() || 'info';
    const blocking = isBlocking(sev);
    const asr = obj(mf.asr);
    const refs = controlRefs(mf);
    // An informational / clean posture finding (info severity, e.g. the
    // *-clean or *-enumerated rows) carries no remediation action: its re-test
    // status is 'not-applicable', never a fabricated 'pass'. Everything with a
    // real severity is an open remediation item until the buyer closes it.
    const retest = sev === 'info' ? 'not-applicable' : 'open';
    return {
      finding_id: str(mf.id) || `finding-${idx + 1}`,
      title: str(mf.title) || str(mf.id) || `finding-${idx + 1}`,
      severity: sev,
      blocking,
      mapped_controls: refs.map((ref) => ref.ref),
      asr: asr.id ? { id: str(asr.id), name: str(asr.name) } : null,
      // Placeholders: kolm reports what the code observed; the owner and the
      // remediation deadline are the buyer's to assign. Left empty on purpose,
      // never auto-filled with an invented owner or date.
      owner: '',
      due_date: '',
      retest_status: retest,
      // Stable original index so equal-severity items keep input order.
      _i: idx,
    };
  });

  // Blocking first, then by descending severity, then original order. Stable.
  const SEV_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  rows.sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    const sd = (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0);
    if (sd !== 0) return sd;
    return a._i - b._i;
  });
  for (const row of rows) delete row._i;

  const blockingRows = rows.filter((x) => x.blocking);
  const openRows = rows.filter((x) => x.retest_status === 'open');

  return {
    schema: 'kolm-remediation-poam',
    export_version: OSCAL_EXPORT_VERSION,
    notice: MAPS_NOTICE,
    scope: SCOPE_LINE,
    contact: CONTACT_EMAIL,
    columns: [...REMEDIATION_COLUMNS],
    rows,
    summary: {
      total: rows.length,
      blocking: blockingRows.length,
      open: openRows.length,
      // Placeholders are unassigned across the board until the buyer fills them.
      owners_assigned: 0,
      due_dates_assigned: 0,
    },
  };
}

export default { buildOscalAssessmentResults, buildRemediationTable };
