// Agent Security-Review audit - GRC Evidence Pack (OFFER #6) tests.
//
// Pins src/oscal-export.js. Three properties matter for the deliverable:
//
//   (1) buildOscalAssessmentResults renders a valid OSCAL assessment-results
//       SKELETON: the documented metadata + import-ap + results[].findings[]
//       shape, every finding carries a target control-id + a related
//       observation, and the document is framed as assessment-results (NOT a
//       certification) in plain language.
//
//   (2) every BLOCKING finding (critical/high) appears in the remediation table
//       (no deal-blocker is silently dropped) and the OSCAL findings.
//
//   (3) DETERMINISTIC output: the same result + meta render byte-identical JSON
//       (no Date.now()/random leaks into the body), and a partial / hostile
//       result never throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAudit } from '../src/audit-orchestrator.js';
import {
  buildOscalAssessmentResults,
  buildRemediationTable,
  REMEDIATION_COLUMNS,
  OSCAL_EXPORT_VERSION,
} from '../src/oscal-export.js';

// The canonical "stalled deal" agent: shared over-permissioned key, PII emailed
// out, destructive actions, no tamper-evident trail. Guarantees blocking
// (critical/high) findings across ASR-1/2/3 so the remediation + OSCAL coverage
// assertions exercise real deal-blockers.
const BAD_LOG = [
  JSON.stringify({
    request_id: 'r1', timestamp: '2026-02-03T14:22:10Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'support-agent', metadata: { key_alias: 'shared' },
    tools: [
      { type: 'function', function: { name: 'get_order' } },
      { type: 'function', function: { name: 'send_email' } },
      { type: 'function', function: { name: 'delete_customer' } },
      { type: 'function', function: { name: 'export_customers' } },
      { type: 'function', function: { name: 'list_users' } },
      { type: 'function', function: { name: 'update_billing' } },
      { type: 'function', function: { name: 'refund_order' } },
    ],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_order', arguments: '{"order":"44219"}' } }] }],
  }),
  JSON.stringify({
    request_id: 'r2', timestamp: '2026-02-04T09:15:42Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'support-agent', metadata: { key_alias: 'shared' },
    tools: [
      { type: 'function', function: { name: 'get_order' } },
      { type: 'function', function: { name: 'send_email' } },
      { type: 'function', function: { name: 'delete_customer' } },
    ],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'send_email', arguments: '{"to":"maria@gmail.com","body":"SSN 401-55-9823"}' } }] }],
  }),
].join('\n');

function badResult() {
  return runAudit(BAD_LOG, { source: 'litellm' });
}

const META = {
  subject: 'Helpwise Inc.',
  report_id: 'asrr_test_0001',
  generated: '2026-06-11T00:00:00Z',
  verify_url: 'https://kolm.ai/verify',
  key_fingerprint: 'ab12cd34',
};

// ---------------------------------------------------------------------------
// (1) Valid OSCAL assessment-results skeleton shape.
// ---------------------------------------------------------------------------
test('buildOscalAssessmentResults renders a valid OSCAL assessment-results skeleton', () => {
  const doc = buildOscalAssessmentResults(badResult(), META);

  assert.equal(doc.schema, 'kolm-oscal-assessment-results');
  assert.equal(doc.export_version, OSCAL_EXPORT_VERSION);

  const ar = doc['assessment-results'];
  assert.ok(ar && typeof ar === 'object', 'assessment-results root present');
  assert.match(ar.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'root uuid is a v5-shaped UUID');

  // metadata skeleton
  const md = ar.metadata;
  assert.ok(md && typeof md === 'object', 'metadata present');
  assert.ok(md.title.includes('Helpwise Inc.'), 'metadata title carries the subject');
  assert.equal(md.published, META.generated, 'published echoes the caller timestamp');
  assert.equal(md['last-modified'], META.generated);
  assert.ok(typeof md['oscal-version'] === 'string' && md['oscal-version'].length, 'oscal-version present');

  // import-ap is REQUIRED by the assessment-results model.
  assert.ok(ar['import-ap'] && typeof ar['import-ap'].href === 'string', 'import-ap present');

  // results[] with findings[] and observations[].
  assert.ok(Array.isArray(ar.results) && ar.results.length === 1, 'exactly one result entry');
  const res = ar.results[0];
  assert.match(res.uuid, /^[0-9a-f-]{36}$/, 'result uuid');
  assert.ok(Array.isArray(res.findings) && res.findings.length > 0, 'findings present');
  assert.ok(Array.isArray(res.observations) && res.observations.length > 0, 'observations present');

  // Every finding carries a target control-id + a related observation that exists.
  const obsUuids = new Set(res.observations.map((o) => o.uuid));
  for (const f of res.findings) {
    assert.match(f.uuid, /^[0-9a-f-]{36}$/, 'finding uuid');
    assert.ok(f.target && typeof f.target['target-id'] === 'string' && f.target['target-id'].length, 'finding has a target control-id');
    assert.ok(f.target.status && typeof f.target.status.state === 'string', 'finding target carries a status state');
    const rel = (f['related-observations'] || []).map((x) => x['observation-uuid']);
    assert.ok(rel.length >= 1 && rel.every((u) => obsUuids.has(u)), 'finding links a real observation');
    // The crosswalk lives on the finding props as mapped-control entries.
    const props = f.props || [];
    assert.ok(props.some((p) => p.name === 'finding-id'), 'finding-id prop present');
    assert.ok(props.some((p) => p.name === 'severity'), 'severity prop present');
  }
});

test('OSCAL document is framed as assessment-results, NOT a certification', () => {
  const doc = buildOscalAssessmentResults(badResult(), META);
  const ar = doc['assessment-results'];
  const props = ar.metadata.props || [];
  const byName = Object.fromEntries(props.map((p) => [p.name, p.value]));

  assert.equal(byName['artifact-kind'], 'assessment-results');
  assert.equal(byName['not-a-certification'], 'true');
  assert.match(ar.metadata.remarks, /does not certify/i, 'metadata states it does not certify');

  // No finding ever asserts "certified" / "compliant" - the mapping disposition
  // on every finding is an explicit cross-reference, not a certification.
  for (const f of ar.results[0].findings) {
    const props2 = f.props || [];
    assert.ok(
      props2.some((p) => p.name === 'mapping-disposition' && p.value === 'cross-reference-not-certification'),
      'every finding declares cross-reference (not certification)',
    );
    assert.match(String(f.remarks || ''), /does not certify/i, 'finding remark restates the MAPS posture');
  }

  const full = JSON.stringify(doc).toLowerCase();
  assert.ok(!full.includes('certificate of compliance"'), 'no certificate-of-compliance claim');
  assert.ok(!full.includes('honest'), 'never the banned word');
  assert.ok(!full.includes('rodneyyesep'), 'no operator handle leaks');
  // No em/en dashes anywhere in the rendered artifact.
  assert.ok(!/[–—]/.test(JSON.stringify(doc)), 'no en/em dashes');
});

// ---------------------------------------------------------------------------
// (2) Every blocking finding appears in the remediation table + OSCAL findings.
// ---------------------------------------------------------------------------
test('every blocking finding appears in the remediation table', () => {
  const result = badResult();
  const table = buildRemediationTable(result);

  // Column contract is stable.
  assert.deepEqual(table.columns, [...REMEDIATION_COLUMNS]);

  // The orchestrator's authoritative blocking set (critical/high).
  const blockingIds = new Set((result.summary.blocking || []).map((b) => b.id));
  assert.ok(blockingIds.size > 0, 'the bad log produces blocking findings');

  const rowIds = new Set(table.rows.map((r) => r.finding_id));
  for (const id of blockingIds) {
    assert.ok(rowIds.has(id), `blocking finding ${id} appears in the remediation table`);
  }

  // Blocking rows are surfaced first and carry unfilled placeholders + an open
  // re-test status.
  const firstNonBlockingIdx = table.rows.findIndex((r) => !r.blocking);
  const lastBlockingIdx = (() => { let i = -1; table.rows.forEach((r, ix) => { if (r.blocking) i = ix; }); return i; })();
  if (firstNonBlockingIdx !== -1) {
    assert.ok(lastBlockingIdx < firstNonBlockingIdx, 'all blocking rows precede non-blocking rows');
  }
  for (const r of table.rows) {
    if (r.blocking) {
      assert.equal(r.owner, '', 'owner is an unfilled placeholder');
      assert.equal(r.due_date, '', 'due_date is an unfilled placeholder');
      assert.equal(r.retest_status, 'open', 'a live finding is open until re-tested');
      assert.ok(Array.isArray(r.mapped_controls) && r.mapped_controls.length > 0, 'a blocking finding maps to >=1 control');
    }
  }

  assert.equal(table.summary.owners_assigned, 0, 'no owner is auto-assigned');
  assert.equal(table.summary.due_dates_assigned, 0, 'no due-date is auto-assigned');
  assert.ok(table.summary.blocking > 0, 'summary counts the blocking rows');
});

test('blocking findings in the OSCAL doc carry not-satisfied target status', () => {
  const result = badResult();
  const doc = buildOscalAssessmentResults(result, META);
  const blockingIds = new Set((result.summary.blocking || []).map((b) => b.id));

  const byFindingId = new Map();
  for (const f of doc['assessment-results'].results[0].findings) {
    const idProp = (f.props || []).find((p) => p.name === 'finding-id');
    if (idProp) byFindingId.set(idProp.value, f);
  }
  for (const id of blockingIds) {
    const f = byFindingId.get(id);
    assert.ok(f, `blocking finding ${id} present in OSCAL findings`);
    assert.equal(f.target.status.state, 'not-satisfied', `${id} target is not-satisfied`);
    assert.ok((f.props || []).some((p) => p.name === 'blocking' && p.value === 'true'), `${id} flagged blocking`);
  }
});

// ---------------------------------------------------------------------------
// (3) Deterministic output + never-throw on partial/hostile input.
// ---------------------------------------------------------------------------
test('deterministic: same result + meta renders byte-identical OSCAL + table', () => {
  const result = badResult();
  const a = JSON.stringify(buildOscalAssessmentResults(result, META));
  const b = JSON.stringify(buildOscalAssessmentResults(result, META));
  assert.equal(a, b, 'OSCAL render is byte-identical across calls');

  // A fresh run of the same logs yields the same document (no run-time leakage).
  const c = JSON.stringify(buildOscalAssessmentResults(badResult(), META));
  assert.equal(a, c, 'OSCAL render is stable across independent audit runs');

  const t1 = JSON.stringify(buildRemediationTable(result));
  const t2 = JSON.stringify(buildRemediationTable(badResult()));
  assert.equal(t1, t2, 'remediation table is byte-identical across runs');

  // No wall-clock timestamp leaked: with no meta.generated the document falls
  // back to a fixed sentinel, so two no-meta renders are still identical.
  const n1 = JSON.stringify(buildOscalAssessmentResults(result));
  const n2 = JSON.stringify(buildOscalAssessmentResults(result));
  assert.equal(n1, n2, 'no-meta render is deterministic (fixed sentinel timestamp)');
});

test('never throws on a partial / hostile result', () => {
  for (const bad of [undefined, null, 42, '', 'x', [], {}, { findings: null }, { controls: { findings: [{}] } }, { findings: [{ severity: 'high' }] }]) {
    const doc = buildOscalAssessmentResults(bad, {});
    assert.equal(doc.schema, 'kolm-oscal-assessment-results');
    assert.ok(Array.isArray(doc['assessment-results'].results), 'results array even on junk input');
    const table = buildRemediationTable(bad);
    assert.ok(Array.isArray(table.rows), 'remediation rows array even on junk input');
    assert.deepEqual(table.columns, [...REMEDIATION_COLUMNS]);
  }
});

test('clean / informational findings get a not-applicable re-test status', () => {
  // A synthetic result with one info-level posture row and one high blocker.
  const result = {
    summary: { blocking: [{ id: 'x-high' }], blocking_count: 1, total_findings: 2 },
    controls: {
      findings: [
        { id: 'x-clean', severity: 'info', pillar: 'permission', title: 'Clean posture', detail: 'ok', asr: { id: 'ASR-1', name: 'Least privilege' }, controls: [{ framework: 'SOC 2 TSC', id: 'CC6', label: 'access' }] },
        { id: 'x-high', severity: 'high', pillar: 'permission', title: 'A blocker', detail: 'bad', asr: { id: 'ASR-1', name: 'Least privilege' }, controls: [{ framework: 'SOC 2 TSC', id: 'CC6', label: 'access' }] },
      ],
    },
  };
  const table = buildRemediationTable(result);
  const byId = Object.fromEntries(table.rows.map((r) => [r.finding_id, r]));
  assert.equal(byId['x-clean'].retest_status, 'not-applicable', 'info posture row is not-applicable');
  assert.equal(byId['x-high'].retest_status, 'open', 'a high finding is open');
  // Blocking surfaced first.
  assert.equal(table.rows[0].finding_id, 'x-high');
});
