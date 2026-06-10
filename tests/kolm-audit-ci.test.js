// tests/kolm-audit-ci.test.js
//
// Unit coverage for the pure pieces of scripts/kolm-audit-ci.mjs: gate-mode
// parsing, the delta gate decision, the legacy absolute gate, prior-session
// selection over the GET /v1/audit/reports listing shape, the PR comment
// renderer, and PR-context detection. The script guards its main() behind an
// is-entrypoint check, so importing it here runs no side effects.
//
// Delta payloads are fabricated to the exact contract locked by
// tests/agent-audit-delta-badge-routes.test.js:
//   { readiness_change, regressed, controls_changed:[{id,from_status,to_status}],
//     findings_added:[{id,severity,title,asr}], findings_resolved:[...] }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_MARKER,
  GATE_MODES,
  parseGateMode,
  parseCliArgs,
  evaluateDeltaGate,
  evaluateAbsoluteGate,
  selectPriorSession,
  renderPrComment,
  detectPrNumber,
} from '../scripts/kolm-audit-ci.mjs';

function mkDelta(over = {}) {
  return {
    from: { report_id: 'asrr_prior', readiness_pct: 60, generated_at: '2026-06-01T00:00:00Z' },
    to: { report_id: 'asrr_cur', readiness_pct: 66, generated_at: '2026-06-09T00:00:00Z' },
    readiness_change: 6,
    controls_changed: [],
    findings_added: [],
    findings_resolved: [],
    regressed: false,
    summary: 'Readiness 60% -> 66% (+6). 0 control(s) changed, 0 finding(s) added, 0 resolved. No regression versus the prior attestation.',
    ...over,
  };
}

/* ------------------------------ parseGateMode ------------------------------ */

test('parseGateMode: the three modes, the legacy aliases, and rejection', () => {
  assert.equal(parseGateMode('report-only'), 'report-only');
  assert.equal(parseGateMode('fail-on-new-high'), 'fail-on-new-high');
  assert.equal(parseGateMode('fail-on-regression'), 'fail-on-regression');
  assert.equal(parseGateMode(''), 'legacy', 'empty string is the backward-compatible legacy gate');
  assert.equal(parseGateMode(undefined), 'legacy', 'unset is the backward-compatible legacy gate');
  assert.equal(parseGateMode('absolute'), 'legacy', 'absolute is an alias for legacy');
  assert.equal(parseGateMode('  Report-Only  '), 'report-only', 'trimmed + case-insensitive');
  assert.equal(parseGateMode('bogus'), null, 'an unknown mode is a config error, not a silent default');
  assert.ok(GATE_MODES.includes('legacy'));
});

/* ------------------------------- parseCliArgs ------------------------------ */

test('parseCliArgs: logs path, --gate-mode=<v>, --gate-mode <v>, --fail-open', () => {
  assert.deepEqual(
    parseCliArgs(['./agent-traces', '--gate-mode=fail-on-new-high', '--fail-open']),
    { logsPath: './agent-traces', gateMode: 'fail-on-new-high', failOpen: true },
  );
  assert.deepEqual(
    parseCliArgs(['--gate-mode', 'report-only', './logs.jsonl']),
    { logsPath: './logs.jsonl', gateMode: 'report-only', failOpen: false },
  );
  assert.deepEqual(parseCliArgs([]), { logsPath: '', gateMode: null, failOpen: false });
});

/* ----------------------------- evaluateDeltaGate --------------------------- */

test('report-only never fails, even on a regressed delta with a new critical', () => {
  const delta = mkDelta({
    readiness_change: -20,
    regressed: true,
    controls_changed: [{ id: 'ASR-1', from_status: 'pass', to_status: 'blocking' }],
    findings_added: [{ id: 'f1', severity: 'critical', title: 't', asr: 'ASR-1' }],
  });
  const r = evaluateDeltaGate('report-only', delta);
  assert.equal(r.failed, false);
  assert.equal(r.reasons.length, 0);
});

test('fail-on-new-high: fails on a new high finding', () => {
  const r = evaluateDeltaGate('fail-on-new-high', mkDelta({
    findings_added: [{ id: 'f1', severity: 'high', title: 't', asr: 'ASR-3' }],
  }));
  assert.equal(r.failed, true);
  assert.ok(r.reasons.some((x) => x.includes('high or critical')));
});

test('fail-on-new-high: fails on a new critical finding', () => {
  const r = evaluateDeltaGate('fail-on-new-high', mkDelta({
    findings_added: [{ id: 'f1', severity: 'critical', title: 't', asr: 'ASR-3' }],
  }));
  assert.equal(r.failed, true);
});

test('fail-on-new-high: fails when a control newly enters blocking', () => {
  const r = evaluateDeltaGate('fail-on-new-high', mkDelta({
    controls_changed: [{ id: 'ASR-2', from_status: 'attention', to_status: 'blocking' }],
  }));
  assert.equal(r.failed, true);
  assert.ok(r.reasons.some((x) => x.includes('ASR-2')));
});

test('fail-on-new-high: passes on medium findings, a worsened-but-not-blocking control, and a readiness drop', () => {
  const r = evaluateDeltaGate('fail-on-new-high', mkDelta({
    readiness_change: -10,
    regressed: true,
    controls_changed: [{ id: 'ASR-4', from_status: 'pass', to_status: 'attention' }],
    findings_added: [{ id: 'f2', severity: 'medium', title: 't', asr: 'ASR-4' }],
  }));
  assert.equal(r.failed, false, 'fail-on-new-high gates ONLY on new high/critical or newly-blocking');
});

test('fail-on-regression: fails when the delta is marked regressed', () => {
  const r = evaluateDeltaGate('fail-on-regression', mkDelta({ readiness_change: -3, regressed: true }));
  assert.equal(r.failed, true);
});

test('fail-on-regression: fails on a worsened control even without the regressed flag', () => {
  const r = evaluateDeltaGate('fail-on-regression', mkDelta({
    regressed: false,
    controls_changed: [{ id: 'ASR-5', from_status: 'pass', to_status: 'attention' }],
  }));
  assert.equal(r.failed, true);
  assert.ok(r.reasons.some((x) => x.includes('pass -> attention')));
});

test('fail-on-regression: fails on a new high finding', () => {
  const r = evaluateDeltaGate('fail-on-regression', mkDelta({
    findings_added: [{ id: 'f3', severity: 'high', title: 't', asr: 'ASR-6' }],
  }));
  assert.equal(r.failed, true);
});

test('fail-on-regression: a pure improvement passes (untested -> pass is not a regression)', () => {
  const r = evaluateDeltaGate('fail-on-regression', mkDelta({
    readiness_change: 12,
    controls_changed: [
      { id: 'ASR-1', from_status: 'blocking', to_status: 'attention' },
      { id: 'ASR-7', from_status: 'untested', to_status: 'pass' },
    ],
    findings_resolved: [{ id: 'old', severity: 'high', title: 't', asr: 'ASR-1' }],
  }));
  assert.equal(r.failed, false);
});

test('a null delta (baseline) never fails the delta gate in any mode', () => {
  for (const mode of GATE_MODES) {
    assert.equal(evaluateDeltaGate(mode, null).failed, false, mode);
  }
});

/* ---------------------------- evaluateAbsoluteGate -------------------------- */

test('legacy absolute gate: readiness below the floor, null readiness, blocking findings', () => {
  assert.equal(evaluateAbsoluteGate({ readiness: 70, blockingCount: 0, minReadiness: 80, failOnBlocking: true }).failed, true);
  assert.equal(evaluateAbsoluteGate({ readiness: null, blockingCount: 0, minReadiness: 80, failOnBlocking: true }).failed, true);
  assert.equal(evaluateAbsoluteGate({ readiness: 90, blockingCount: 2, minReadiness: 80, failOnBlocking: true }).failed, true);
  assert.equal(evaluateAbsoluteGate({ readiness: 90, blockingCount: 2, minReadiness: 80, failOnBlocking: false }).failed, false);
  assert.equal(evaluateAbsoluteGate({ readiness: 85, blockingCount: 0, minReadiness: 80, failOnBlocking: true }).failed, false);
});

/* ----------------------------- selectPriorSession --------------------------- */

const LISTING = [
  { id: 'audses_cur', report_id: 'asrr_cur', subject: 'Agent fleet', created_at: '2026-06-09T12:00:00Z' },
  { id: 'audses_other', report_id: 'asrr_other', subject: 'Another fleet', created_at: '2026-06-08T00:00:00Z' },
  { id: 'audses_p2', report_id: 'asrr_p2', subject: 'Agent fleet', created_at: '2026-06-07T00:00:00Z' },
  { id: 'audses_p1', report_id: 'asrr_p1', subject: 'Agent fleet', created_at: '2026-06-01T00:00:00Z' },
];

test('selectPriorSession: most recent same-subject row, excluding the current scan', () => {
  const prior = selectPriorSession(LISTING, { subject: 'Agent fleet', currentId: 'audses_cur', currentReportId: 'asrr_cur' });
  assert.ok(prior);
  assert.equal(prior.id, 'audses_p2', 'most recent prior for the subject, not the foreign subject');
});

test('selectPriorSession: null when the subject has no prior report (baseline)', () => {
  const prior = selectPriorSession(LISTING, { subject: 'Brand new fleet', currentId: 'audses_cur' });
  assert.equal(prior, null);
});

test('selectPriorSession: excludes the current run by report id when the session id is unknown', () => {
  const prior = selectPriorSession(
    [{ id: 'audses_x', report_id: 'asrr_cur', subject: 'Agent fleet', created_at: '2026-06-09T12:00:00Z' }],
    { subject: 'Agent fleet', currentId: null, currentReportId: 'asrr_cur' },
  );
  assert.equal(prior, null);
});

test('selectPriorSession: tolerates a malformed listing', () => {
  assert.equal(selectPriorSession(null, { subject: 'x' }), null);
  assert.equal(selectPriorSession([null, {}, { id: 'a' }], { subject: 'x' }), null);
});

/* ------------------------------ renderPrComment ----------------------------- */

const SUMMARY = {
  readiness_pct: 66,
  blocking_count: 0,
  controls: [
    { id: 'ASR-1', name: 'Least privilege', status: 'attention' },
    { id: 'ASR-2', name: 'Audit trail', status: 'pass' },
    { id: 'ASR-3', name: 'Data egress', status: 'pass' },
    { id: 'ASR-4', name: 'Injection posture', status: 'pass' },
    { id: 'ASR-5', name: 'Model provenance', status: 'pass' },
    { id: 'ASR-6', name: 'Identity', status: 'pass' },
    { id: 'ASR-7', name: 'Retrieval integrity', status: 'pass' },
    { id: 'ASR-8', name: 'Delegation', status: 'pass' },
  ],
};

test('renderPrComment: marker, header with controls + readiness direction, changed-control rows', () => {
  const md = renderPrComment({
    summary: SUMMARY,
    delta: mkDelta({
      readiness_change: 6,
      controls_changed: [{ id: 'ASR-1', from_status: 'blocking', to_status: 'attention' }],
      findings_added: [{ id: 'f9', severity: 'high', title: 'PRIVATE-TITLE-MUST-NOT-APPEAR', asr: 'ASR-1' }],
      findings_resolved: [
        { id: 'r1', severity: 'high', title: 'PRIVATE-RESOLVED-TITLE', asr: 'ASR-1' },
        { id: 'r2', severity: 'low', title: 'PRIVATE-RESOLVED-TITLE-2', asr: 'ASR-2' },
      ],
    }),
    baseline: false,
    gateMode: 'fail-on-new-high',
    passed: false,
    reportId: 'asrr_cur',
    signed: true,
    sessionId: 'audses_cur',
    apiUrl: 'https://kolm.ai',
    verifyUrl: 'https://kolm.ai/verify',
    trustUrl: 'https://kolm.ai/v1/trust/sometrustslug00001',
  });
  assert.ok(md.startsWith(COMMENT_MARKER), 'the upsert marker leads the comment');
  assert.ok(md.includes('kolm agent audit: 7/8 controls pass (readiness +6 vs last signed report)'), 'header line');
  assert.ok(md.includes('| ASR-1 | Least privilege | blocking -> attention |'), 'one line per changed control');
  assert.ok(md.includes('1 new finding(s) (1 high or critical), 2 resolved.'), 'counts line with zero detail');
  assert.ok(md.includes('Gate mode: fail-on-new-high - failed.'), 'verdict line');
  assert.ok(md.includes('https://kolm.ai/dashboard'), 'dashboard link');
  assert.ok(md.includes('https://kolm.ai/v1/trust/sometrustslug00001'), 'public trust link when a slug is known');
  assert.ok(md.includes('signed report asrr_cur - verify offline at https://kolm.ai/verify'), 'footer');
});

test('renderPrComment: NEVER leaks finding titles or descriptions', () => {
  const md = renderPrComment({
    summary: SUMMARY,
    delta: mkDelta({
      findings_added: [{ id: 'f9', severity: 'high', title: 'PRIVATE-TITLE-MUST-NOT-APPEAR', asr: 'ASR-1', description: 'PRIVATE-DESCRIPTION' }],
      findings_resolved: [{ id: 'r1', severity: 'low', title: 'PRIVATE-RESOLVED-TITLE', asr: 'ASR-2' }],
    }),
    baseline: false, gateMode: 'report-only', passed: true,
    reportId: 'asrr_cur', signed: true, sessionId: 'audses_cur',
    apiUrl: 'https://kolm.ai', verifyUrl: 'https://kolm.ai/verify',
  });
  assert.ok(!md.includes('PRIVATE-TITLE-MUST-NOT-APPEAR'), 'added finding titles stay private');
  assert.ok(!md.includes('PRIVATE-DESCRIPTION'), 'finding descriptions stay private');
  assert.ok(!md.includes('PRIVATE-RESOLVED-TITLE'), 'resolved finding titles stay private');
  assert.ok(!md.includes('f9') && !md.includes('r1'), 'finding ids stay private; only counts ship');
});

test('renderPrComment: baseline variant announces the baseline and skips the table', () => {
  const md = renderPrComment({
    summary: SUMMARY, delta: null, baseline: true,
    gateMode: 'fail-on-new-high', passed: true,
    reportId: 'asrr_first', signed: true, sessionId: 'audses_first',
    apiUrl: 'https://kolm.ai', verifyUrl: 'https://kolm.ai/verify',
  });
  assert.ok(md.includes('baseline established'), 'header carries the baseline note');
  assert.ok(md.includes('Baseline established.'), 'body explains what happens next');
  assert.ok(!md.includes('| Control |'), 'no delta table on a baseline run');
  assert.ok(md.includes('Gate mode: fail-on-new-high - passed.'));
});

test('renderPrComment: unsigned preview footer and delta-unavailable note', () => {
  const md = renderPrComment({
    summary: SUMMARY, delta: null, baseline: false,
    gateMode: 'report-only', passed: true,
    reportId: null, signed: false, sessionId: 'audses_x',
    apiUrl: 'https://kolm.ai', verifyUrl: 'https://kolm.ai/verify',
  });
  assert.ok(md.includes('unsigned scan preview'), 'unsigned footer');
  assert.ok(md.includes('could not be computed'), 'unavailability is stated, not hidden');
});

test('renderPrComment: output is ASCII-only and escapes pipes in names', () => {
  const md = renderPrComment({
    summary: { readiness_pct: 50, controls: [{ id: 'ASR-1', name: 'Least | privilege', status: 'pass' }] },
    delta: mkDelta({ controls_changed: [{ id: 'ASR-1', from_status: 'pass', to_status: 'attention' }] }),
    baseline: false, gateMode: 'fail-on-regression', passed: false,
    reportId: 'asrr_cur', signed: true, sessionId: 'audses_cur',
    apiUrl: 'https://kolm.ai', verifyUrl: 'https://kolm.ai/verify',
  });
  for (let i = 0; i < md.length; i++) {
    assert.ok(md.charCodeAt(i) <= 0x7e || md[i] === '\n', `non-ASCII char at index ${i}: ${md.codePointAt(i)}`);
  }
  assert.ok(md.includes('Least \\| privilege'), 'pipe in a control name cannot break the table');
});

/* ------------------------------- detectPrNumber ----------------------------- */

test('detectPrNumber: event payload wins, GITHUB_REF is the fallback, else null', () => {
  const read = () => JSON.stringify({ action: 'synchronize', pull_request: { number: 7 } });
  assert.equal(detectPrNumber({ GITHUB_EVENT_PATH: 'evt.json' }, read), 7);

  const readPush = () => JSON.stringify({ ref: 'refs/heads/main' });
  assert.equal(detectPrNumber({ GITHUB_EVENT_PATH: 'evt.json', GITHUB_REF: 'refs/pull/42/merge' }, readPush), 42);

  assert.equal(detectPrNumber({ GITHUB_REF: 'refs/pull/42/merge' }, readPush), 42);
  assert.equal(detectPrNumber({ GITHUB_REF: 'refs/heads/main' }, readPush), null);
  assert.equal(detectPrNumber({}, readPush), null);
});
