// Agent Security-Review audit — control mapper lock-in tests.
//
// Pins src/control-mapper.js: that analyzer findings map to the EXACT control
// ids the live site publishes on /checks and /research (ASR-1..8, OWASP LLMxx
// / named ASI01-ASI10, MITRE ATLAS AML.Txxxx, NIST AI RMF, EU AI Act Art.x,
// SOC 2 TSC, ISO/IEC 42001, CSA AICM, NIST COSAiS), with a pillar fallback,
// a per-framework rollup and a run-independent catalog crosswalk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFinding, mapControls, ASR_CONTROLS, asrCrosswalk } from '../src/control-mapper.js';

function ctrlIds(controls, framework) {
  return controls.filter((c) => c.framework === framework).map((c) => c.id);
}

test('ASR_CONTROLS publishes the full eight-control checklist', () => {
  assert.equal(ASR_CONTROLS.length, 8);
  assert.deepEqual(ASR_CONTROLS.map((a) => a.id), ['ASR-1', 'ASR-2', 'ASR-3', 'ASR-4', 'ASR-5', 'ASR-6', 'ASR-7', 'ASR-8']);
});

test('mapFinding maps a wildcard-grant to ASR-1 and buyer frameworks', () => {
  const m = mapFinding({ id: 'wildcard-grant', pillar: 'permission', severity: 'critical' });
  assert.equal(m.asr.id, 'ASR-1');
  const owasp = ctrlIds(m.controls, 'OWASP LLM & Agentic Top 10');
  assert.ok(owasp.includes('ASI02'), 'OWASP ASI02 (tool misuse) present');
  assert.ok(owasp.includes('ASI03'), 'OWASP ASI03 (identity & privilege abuse) present');
  assert.ok(!owasp.includes('ASI'), 'no bare un-numbered ASI reference');
  assert.ok(ctrlIds(m.controls, 'NIST AI RMF').includes('MANAGE-1'), 'NIST MANAGE-1 present');
  assert.ok(ctrlIds(m.controls, 'EU AI Act').includes('Art.14'), 'EU Art.14 present');
  assert.ok(ctrlIds(m.controls, 'SOC 2 TSC').includes('CC6'), 'SOC 2 CC6 present');
  assert.ok(ctrlIds(m.controls, 'CSA AICM').includes('IAM-05'), 'CSA AICM IAM-05 present');
});

test('mapFinding maps an audit-trail gap to ASR-2 / Art.12 / CC7', () => {
  const m = mapFinding({ id: 'no-tamper-evidence', pillar: 'audit-trail', severity: 'high' });
  assert.equal(m.asr.id, 'ASR-2');
  assert.ok(ctrlIds(m.controls, 'EU AI Act').includes('Art.12'), 'EU Art.12 present');
  assert.ok(ctrlIds(m.controls, 'SOC 2 TSC').includes('CC7'), 'SOC 2 CC7 present');
});

test('mapFinding maps sensitive egress to ASR-3 / LLM02 / Art.10', () => {
  const m = mapFinding({ id: 'sensitive-egress', pillar: 'data-egress', severity: 'high' });
  assert.equal(m.asr.id, 'ASR-3');
  assert.ok(ctrlIds(m.controls, 'OWASP LLM & Agentic Top 10').includes('LLM02'));
  assert.ok(ctrlIds(m.controls, 'EU AI Act').includes('Art.10'));
});

test('an unknown finding id falls back to its pillar mapping', () => {
  const m = mapFinding({ id: 'some-future-finding', pillar: 'data-egress', severity: 'medium' });
  assert.equal(m.asr.id, 'ASR-3', 'pillar fallback resolves ASR');
  assert.ok(m.controls.length > 0, 'pillar fallback yields controls');
});

test('mapFinding never throws on bad input', () => {
  for (const bad of [undefined, null, 42, {}, { id: 'x' }]) {
    const m = mapFinding(bad);
    assert.ok('controls' in m, 'controls key always present');
    assert.ok(Array.isArray(m.controls));
  }
});

test('mapControls rolls up findings per framework and per ASR control', () => {
  const findings = [
    { id: 'wildcard-grant', pillar: 'permission', severity: 'critical' },
    { id: 'over-permission', pillar: 'permission', severity: 'high' },
    { id: 'no-tamper-evidence', pillar: 'audit-trail', severity: 'high' },
    { id: 'sensitive-egress', pillar: 'data-egress', severity: 'high' },
  ];
  const out = mapControls(findings);
  assert.equal(out.findings.length, 4, 'all findings mapped');
  assert.equal(out.asr.length, 8, 'all eight ASR controls reported');

  const eu = out.frameworks.find((f) => f.framework === 'EU AI Act');
  assert.ok(eu, 'EU AI Act framework present in rollup');
  assert.ok(eu.controls.some((c) => c.id === 'Art.12'), 'Art.12 implicated');
  // wildcard-grant (critical) maps to EU Art.14, so the framework's worst rolls up to critical
  assert.equal(eu.worst_severity, 'critical', 'worst severity rolled up to the most severe finding');

  const asr1 = out.asr.find((a) => a.id === 'ASR-1');
  assert.ok(asr1.findings >= 2, 'ASR-1 has the permission findings');
  assert.ok(out.summary.frameworks_touched >= 4, 'multiple frameworks touched');
});

test('mapControls never throws on bad input', () => {
  for (const bad of [undefined, null, 'x', 42, [null, 5]]) {
    const out = mapControls(bad);
    assert.ok(Array.isArray(out.findings));
    assert.equal(out.asr.length, 8, 'ASR list always complete');
  }
});

// ---------------------------------------------------------------------------
// Crosswalk depth: named ASI ids, AICM / COSAiS rows, no blank ASR rows, and
// every control id space-free (the export layer splits "FRAMEWORK ID" refs on
// the LAST space, so an id with a space would corrupt every export).
// ---------------------------------------------------------------------------

test('asrCrosswalk emits >=1 framework row for ALL eight ASR controls (no blank rows)', () => {
  const cw = asrCrosswalk();
  assert.equal(cw.length, 8, 'one crosswalk row per ASR control');
  assert.deepEqual(cw.map((r) => r.id), ASR_CONTROLS.map((a) => a.id), 'rows follow the checklist order');
  for (const row of cw) {
    assert.ok(Array.isArray(row.controls) && row.controls.length >= 1, `${row.id} carries at least one framework control`);
  }
  // ASR-4 (red-team battery) and ASR-6 (signed evidence) are the two controls
  // with no analyzer findings; the catalog row is what keeps them non-blank.
  const asr4 = cw.find((r) => r.id === 'ASR-4');
  assert.ok(asr4.controls.some((c) => c.framework === 'OWASP LLM & Agentic Top 10' && c.id === 'ASI01'), 'ASR-4 maps to OWASP ASI01');
  assert.ok(asr4.controls.some((c) => c.framework === 'CSA AICM' && c.id === 'MDS-06'), 'ASR-4 maps to CSA AICM MDS-06');
  assert.ok(asr4.controls.some((c) => c.framework === 'NIST AI RMF'), 'ASR-4 maps to NIST AI RMF');
  const asr6 = cw.find((r) => r.id === 'ASR-6');
  assert.ok(asr6.controls.some((c) => c.framework === 'CSA AICM' && c.id === 'A&A-02'), 'ASR-6 maps to CSA AICM A&A-02');
  assert.ok(asr6.controls.some((c) => c.framework === 'EU AI Act' && c.id === 'Art.11'), 'ASR-6 maps to EU Art.11');
  assert.ok(asr6.controls.some((c) => c.framework === 'NIST SP 800-53' && c.id === 'AU-10'), 'ASR-6 maps to 800-53 AU-10 (non-repudiation)');
});

test('every control id in the whole crosswalk table is space-free', () => {
  for (const row of asrCrosswalk()) {
    for (const ctrl of row.controls) {
      assert.match(ctrl.id, /^\S+$/, `${row.id} -> ${ctrl.framework} "${ctrl.id}" must have no whitespace (refs split on the last space)`);
      assert.ok(ctrl.framework && ctrl.label, `${row.id} -> ${ctrl.id} carries framework + label`);
    }
  }
});

test('OWASP ASI references are the named ASI01-ASI10 ids, never a bare ASI', () => {
  const seen = new Set();
  for (const row of asrCrosswalk()) {
    for (const ctrl of row.controls) {
      if (ctrl.framework === 'OWASP LLM & Agentic Top 10' && ctrl.id.startsWith('ASI')) {
        assert.match(ctrl.id, /^ASI(0[1-9]|10)$/, `${row.id} ASI ref "${ctrl.id}" is a named id`);
        seen.add(ctrl.id);
      }
    }
  }
  assert.ok(seen.size >= 5, `at least five distinct named ASI threats are mapped (got ${[...seen].sort().join(', ')})`);
});

test('CSA AICM and NIST COSAiS rows are present with verified / draft-marked ids', () => {
  const all = asrCrosswalk().flatMap((r) => r.controls);
  const aicm = all.filter((c) => c.framework === 'CSA AICM');
  assert.ok(aicm.length >= 5, 'CSA AICM mapped across the catalog');
  for (const c of aicm) assert.match(c.id, /^[A-Z&]+-\d{2}$/, `AICM id "${c.id}" is a published domain-control token`);
  const cosais = all.filter((c) => c.framework === 'NIST COSAiS');
  assert.ok(cosais.length >= 3, 'NIST COSAiS overlays mapped');
  for (const c of cosais) {
    assert.match(c.id, /^\S+-Overlay$/, `COSAiS id "${c.id}" cites an overlay use case`);
    assert.ok(c.label.includes('(draft mapping)'), `COSAiS label "${c.label}" is marked a draft mapping (no final ids published)`);
  }
});

test('a finding with pillar "evidence" maps to ASR-6 (the signed-report controls)', () => {
  const m = mapFinding({ id: 'future-evidence-finding', pillar: 'evidence', severity: 'info' });
  assert.equal(m.asr.id, 'ASR-6');
  assert.ok(ctrlIds(m.controls, 'CSA AICM').includes('A&A-02'), 'AICM A&A-02 present');
  assert.ok(ctrlIds(m.controls, 'EU AI Act').includes('Art.12'), 'EU Art.12 present');
});
