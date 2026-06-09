// Agent Security-Review - S9 signed delta / drift unit tests.
//
// computeAuditDelta(prevReport, currReport) is the pure "what changed since last
// attestation" projection over two signed report envelopes. These lock its
// contract: a clean->dirty diff regresses (readiness down, a control worsens,
// findings appear); a dirty->clean diff improves (findings resolved); an
// identical pair is a clean no-op; it NEVER throws on garbage; and every string
// it emits is ASCII (a delta may be embedded in a signed report row, so it must
// stay locale-proof like the report builder's canonical payload).
//
// Pure in-process - no store, no server, no signing required (the delta reads
// only signature-covered summary / findings fields, which buildReportEnvelope
// already populates).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runAudit } from '../src/audit-orchestrator.js';
import { buildReportEnvelope } from '../src/attestation-report-builder.js';
import { computeAuditDelta } from '../src/audit-delta.js';

// A clean, least-privilege agent: one declared tool used exactly as granted, an
// attributable credential, a version-pinned model -> ASR-1 passes (readiness 67).
const CLEAN = JSON.stringify({
  request_id: 'ok1', timestamp: '2026-05-01T00:00:00Z', model: 'openai/gpt-4o-2024-08-06',
  user: 'agent-one', metadata: { key_alias: 'k-one' },
  tools: [{ type: 'function', function: { name: 'get_return_policy' } }],
  messages: [
    { role: 'user', content: 'What is your return window?' },
    { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_return_policy', arguments: '{}' } }] },
  ],
});

// The committed dogfood fixture: an over-permissioned + shared-credential + no-
// tamper-evidence export -> ASR-1 blocking, 0% readiness, deal-blocking findings.
const DIRTY = fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'agent-audit', 'litellm-export.jsonl'), 'utf8');

function envOf(logs, opts = {}) {
  return buildReportEnvelope(runAudit(logs, { source: opts.source || 'test' }), { subject: opts.subject || 'Subject', report_seed: opts.seed, generated_at: opts.at });
}

const cleanEnv = envOf(CLEAN, { source: 'litellm', subject: 'Clean', seed: 'clean', at: '2026-06-01T00:00:00.000Z' });
const dirtyEnv = envOf(DIRTY, { source: 'litellm', subject: 'Dirty', seed: 'dirty', at: '2026-06-08T00:00:00.000Z' });

test('clean -> dirty regresses: readiness down, ASR-1 worsens, findings added', () => {
  const d = computeAuditDelta(cleanEnv, dirtyEnv);

  assert.equal(d.from.report_id, cleanEnv.report_id);
  assert.equal(d.to.report_id, dirtyEnv.report_id);
  assert.equal(d.from.generated_at, cleanEnv.generated_at);
  assert.equal(d.to.generated_at, dirtyEnv.generated_at);

  assert.ok(typeof d.readiness_change === 'number', 'readiness change is numeric when both sides have a number');
  assert.ok(d.readiness_change < 0, `readiness dropped (${d.readiness_change})`);
  assert.equal(d.regressed, true, 'a posture that loses readiness + worsens a control regressed');

  const asr1 = d.controls_changed.find((c) => c.id === 'ASR-1');
  assert.ok(asr1, 'ASR-1 status transition is reported');
  assert.equal(asr1.from_status, 'pass');
  assert.ok(['attention', 'blocking'].includes(asr1.to_status), `ASR-1 worsened to ${asr1.to_status}`);

  assert.ok(Array.isArray(d.findings_added) && d.findings_added.length >= 1, 'findings appeared');
  for (const f of d.findings_added) {
    assert.ok('id' in f && 'severity' in f && 'title' in f && 'asr' in f, 'added finding is a compact projection');
  }
  // The compact projection must not leak raw evidence / detail bodies.
  for (const f of d.findings_added) {
    assert.ok(!('evidence' in f) && !('detail' in f), 'no raw evidence/detail in the delta finding');
  }
});

test('dirty -> clean improves: readiness up, findings resolved, no regression', () => {
  const d = computeAuditDelta(dirtyEnv, cleanEnv);
  assert.ok(d.readiness_change > 0, `readiness improved (${d.readiness_change})`);
  assert.equal(d.regressed, false, 'an improving posture does not regress');
  assert.ok(d.findings_resolved.length >= 1, 'the dirty findings are resolved');
  const asr1 = d.controls_changed.find((c) => c.id === 'ASR-1');
  assert.ok(asr1 && asr1.to_status === 'pass', 'ASR-1 recovers to pass');
});

test('identical report -> empty, non-regressing delta', () => {
  const d = computeAuditDelta(dirtyEnv, dirtyEnv);
  assert.equal(d.readiness_change, 0);
  assert.equal(d.controls_changed.length, 0);
  assert.equal(d.findings_added.length, 0);
  assert.equal(d.findings_resolved.length, 0);
  assert.equal(d.regressed, false);
});

test('summary is a single ASCII line with no em/en dashes', () => {
  for (const d of [computeAuditDelta(cleanEnv, dirtyEnv), computeAuditDelta(dirtyEnv, cleanEnv), computeAuditDelta(dirtyEnv, dirtyEnv)]) {
    assert.equal(typeof d.summary, 'string');
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x09\x0A\x0D\x20-\x7E]/.test(d.summary), `summary is pure ASCII: ${d.summary}`);
    assert.ok(!/[‒-―−]/.test(d.summary), 'no en/em dashes in the summary');
    assert.match(d.summary, /Readiness/);
  }
});

test('computeAuditDelta never throws on malformed / missing input', () => {
  for (const [a, b] of [[null, null], [undefined, undefined], ['x', 42], [{}, {}], [{ summary: 7 }, { findings: 'nope' }], [cleanEnv, null]]) {
    let d;
    assert.doesNotThrow(() => { d = computeAuditDelta(a, b); }, `must not throw on (${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.ok(d && typeof d === 'object', 'returns an object');
    for (const k of ['from', 'to', 'readiness_change', 'controls_changed', 'findings_added', 'findings_resolved', 'regressed', 'summary']) {
      assert.ok(k in d, `delta.${k} present`);
    }
    assert.ok(Array.isArray(d.controls_changed) && Array.isArray(d.findings_added) && Array.isArray(d.findings_resolved));
    assert.equal(typeof d.regressed, 'boolean');
  }
});

test('readiness_change is null when either side has no numeric readiness', () => {
  const emptyEnv = buildReportEnvelope(runAudit('', { source: 'import' }), { subject: 'Empty' });
  assert.equal(emptyEnv.summary.readiness_pct, null, 'empty input has null readiness');
  const d = computeAuditDelta(emptyEnv, dirtyEnv);
  assert.equal(d.readiness_change, null, 'no numeric delta when a side is null');
  // A null readiness change must not, by itself, claim a regression.
  assert.equal(typeof d.regressed, 'boolean');
});
