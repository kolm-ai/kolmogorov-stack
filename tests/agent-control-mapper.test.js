// Agent Security-Review audit — control mapper lock-in tests.
//
// Pins src/control-mapper.js: that analyzer findings map to the EXACT control
// ids the live site publishes on /checks and /research (ASR-1..6, OWASP LLMxx
// / ASI, MITRE ATLAS AML.Txxxx, NIST AI RMF, EU AI Act Art.x, SOC 2 TSC,
// ISO/IEC 42001), with a pillar fallback and a per-framework rollup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFinding, mapControls, ASR_CONTROLS } from '../src/control-mapper.js';

function ctrlIds(controls, framework) {
  return controls.filter((c) => c.framework === framework).map((c) => c.id);
}

test('ASR_CONTROLS publishes exactly the six site controls', () => {
  assert.equal(ASR_CONTROLS.length, 6);
  assert.deepEqual(ASR_CONTROLS.map((a) => a.id), ['ASR-1', 'ASR-2', 'ASR-3', 'ASR-4', 'ASR-5', 'ASR-6']);
});

test('mapFinding maps a wildcard-grant to ASR-1 and buyer frameworks', () => {
  const m = mapFinding({ id: 'wildcard-grant', pillar: 'permission', severity: 'critical' });
  assert.equal(m.asr.id, 'ASR-1');
  assert.ok(ctrlIds(m.controls, 'OWASP LLM & Agentic Top 10').includes('ASI'), 'OWASP ASI present');
  assert.ok(ctrlIds(m.controls, 'NIST AI RMF').includes('MANAGE-1'), 'NIST MANAGE-1 present');
  assert.ok(ctrlIds(m.controls, 'EU AI Act').includes('Art.14'), 'EU Art.14 present');
  assert.ok(ctrlIds(m.controls, 'SOC 2 TSC').includes('CC6'), 'SOC 2 CC6 present');
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
  assert.equal(out.asr.length, 6, 'all six ASR controls reported');

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
    assert.equal(out.asr.length, 6, 'ASR list always complete');
  }
});
