// OFFER #9 - Fix Verification Re-Test unit tests.
//
// runFixRetest({ priorAudit, newLogs, focusFindingIds }) re-runs runAudit over a
// fresh log window and classifies each prior finding against the new window:
//   - present in prior + ABSENT in new  -> resolved
//   - present in prior + still present  -> still_open
//   - NEW high/critical in new          -> regressed
// It links both report ids and embeds the full computeAuditDelta. These lock that
// contract, plus: it never throws on garbage, the focus filter scopes the verdict
// to named finding ids, and an empty/unanalyzable new window never silently
// "resolves" a prior finding.
//
// Pure in-process - no store, no server, no signing (runFixRetest reuses the
// PURE audit-delta projection over report envelopes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runAudit } from '../src/audit-orchestrator.js';
import { buildReportEnvelope } from '../src/attestation-report-builder.js';
import { runFixRetest } from '../src/fix-retest.js';

// A clean, least-privilege agent: one declared tool used as granted, attributable
// credential, version-pinned model -> ASR-1 passes, no deal-blocking findings.
const CLEAN = JSON.stringify({
  request_id: 'ok1', timestamp: '2026-05-01T00:00:00Z', model: 'openai/gpt-4o-2024-08-06',
  user: 'agent-one', metadata: { key_alias: 'k-one' },
  tools: [{ type: 'function', function: { name: 'get_return_policy' } }],
  messages: [
    { role: 'user', content: 'What is your return window?' },
    { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_return_policy', arguments: '{}' } }] },
  ],
});

// The committed dogfood fixture: over-permissioned + shared-credential + no
// tamper-evidence -> ASR-1 blocking, deal-blocking findings present.
const DIRTY = fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'agent-audit', 'litellm-export.jsonl'), 'utf8');

function envOf(logs, opts = {}) {
  return buildReportEnvelope(runAudit(logs, { source: opts.source || 'test' }),
    { subject: opts.subject || 'Subject', report_seed: opts.seed, generated_at: opts.at });
}

const dirtyEnv = envOf(DIRTY, { source: 'litellm', subject: 'Dirty', seed: 'dirty', at: '2026-06-01T00:00:00.000Z' });

test('a prior finding ABSENT in the new window is resolved (fix verified)', () => {
  // Prior = dirty (has deal-blocking findings); new window = the remediated clean
  // agent. Every prior finding disappears -> resolved, none still_open.
  const out = runFixRetest({ priorAudit: dirtyEnv, newLogs: CLEAN });

  assert.equal(out.prior_id, dirtyEnv.report_id, 'links the prior report id');
  assert.ok(typeof out.new_id === 'string' && out.new_id, 'mints + links a new report id');

  // The dirty ASR-1 over-permission findings disappear against the clean window
  // (resolved); a finding the clean agent ALSO has (e.g. ASR-2 no-tamper-evidence)
  // correctly stays still_open - the non-inflation discipline: only findings that
  // genuinely disappeared are called resolved.
  assert.ok(out.resolved.length >= 1, 'at least one prior finding resolved');
  const asr1Resolved = out.resolved.some((f) => f.asr === 'ASR-1');
  assert.ok(asr1Resolved, 'the ASR-1 over-permission finding is resolved against the clean window');
  // Resolved entries are compact, evidence-free projections.
  for (const f of out.resolved) {
    assert.ok('id' in f && 'severity' in f && 'title' in f && 'asr' in f, 'compact projection');
    assert.ok(!('evidence' in f) && !('detail' in f), 'no raw evidence/detail leaked');
  }
  // The full delta is embedded for a follow-on report / Continuous tick.
  assert.ok(out.delta && typeof out.delta === 'object', 'delta embedded');
  assert.equal(out.delta.from.report_id, dirtyEnv.report_id);
  assert.ok(out.delta.findings_resolved.length >= 1, 'delta agrees: findings resolved');
});

test('a prior finding STILL PRESENT in the new window is still_open (fix not verified)', () => {
  // Prior = dirty; new window = the SAME dirty export -> nothing changed.
  const out = runFixRetest({ priorAudit: dirtyEnv, newLogs: DIRTY });
  assert.ok(out.still_open.length >= 1, 'the unresolved finding is still_open');
  assert.equal(out.resolved.length, 0, 'nothing is falsely reported resolved');
  assert.equal(out.regressed.length, 0, 'an identical re-run does not regress');
});

test('a NEW high/critical finding in the new window is reported as regressed', () => {
  // Prior = clean (no deal-blockers); new window = dirty -> a new high/critical
  // finding appears. It must surface as a regression.
  const cleanEnv = envOf(CLEAN, { source: 'litellm', subject: 'Clean', seed: 'clean', at: '2026-06-01T00:00:00.000Z' });
  const out = runFixRetest({ priorAudit: cleanEnv, newLogs: DIRTY });

  assert.ok(out.regressed.length >= 1, 'a new high/critical finding regressed');
  for (const f of out.regressed) {
    assert.ok(['high', 'critical'].includes(f.severity), `regression is a deal-blocking severity (${f.severity})`);
    assert.ok('id' in f && 'severity' in f && 'title' in f && 'asr' in f, 'compact projection');
  }
  // The delta agrees the new severe findings were added.
  assert.ok(out.delta.findings_added.some((f) => f.severity === 'high' || f.severity === 'critical'),
    'delta records the severe additions');
});

test('focusFindingIds scopes the verdict to the named finding ids', () => {
  // All prior findings resolve against a clean window, but focusing on one id
  // restricts resolved/still_open to that id only.
  const all = runFixRetest({ priorAudit: dirtyEnv, newLogs: CLEAN });
  assert.ok(all.resolved.length >= 1, 'baseline has resolved findings to focus on');
  const focusId = (all.resolved.find((f) => f.asr === 'ASR-1') || all.resolved[0]).id;

  const focused = runFixRetest({ priorAudit: dirtyEnv, newLogs: CLEAN, focusFindingIds: [focusId] });
  assert.ok(focused.resolved.every((f) => f.id === focusId), 'only the focused id appears in resolved');
  assert.ok(focused.still_open.every((f) => f.id === focusId), 'only the focused id appears in still_open');
  assert.ok(focused.resolved.length >= 1, 'the focused finding is reported');
  // A focus id that matches no prior finding yields an empty resolved/still_open.
  const none = runFixRetest({ priorAudit: dirtyEnv, newLogs: CLEAN, focusFindingIds: ['ASR-DOES-NOT-EXIST'] });
  assert.equal(none.resolved.length, 0);
  assert.equal(none.still_open.length, 0);
});

test('an empty new window never silently resolves a prior finding', () => {
  // A blank window is analyzable (an empty audit), but it has no findings. A prior
  // finding must NOT be reported resolved off an empty window with no evidence of
  // a fix - it stays still_open (non-inflation: no resolution claim we cannot back).
  const out = runFixRetest({ priorAudit: dirtyEnv, newLogs: '' });
  assert.equal(out.resolved.length, 0, 'no finding resolved against an empty window');
  assert.ok(out.still_open.length >= 1, 'prior findings stay still_open');
});

test('runFixRetest never throws on malformed / missing input', () => {
  for (const args of [undefined, {}, { priorAudit: null, newLogs: null },
    { priorAudit: 'nope', newLogs: 42 }, { priorAudit: {}, newLogs: {} },
    { priorAudit: dirtyEnv }, { newLogs: CLEAN }]) {
    let out;
    assert.doesNotThrow(() => { out = runFixRetest(args); }, `must not throw on ${JSON.stringify(args)}`);
    assert.ok(out && typeof out === 'object', 'returns an object');
    for (const k of ['prior_id', 'new_id', 'resolved', 'still_open', 'regressed', 'delta']) {
      assert.ok(k in out, `result.${k} present`);
    }
    assert.ok(Array.isArray(out.resolved) && Array.isArray(out.still_open) && Array.isArray(out.regressed));
    assert.ok(out.delta && typeof out.delta === 'object', 'delta is always a well-formed object');
  }
});

test('accepts a raw runAudit() result as priorAudit (not just an envelope)', () => {
  // The orchestrator result (no report_id, findings under controls) is lifted into
  // a comparable envelope so the delta still works.
  const rawPrior = runAudit(DIRTY, { source: 'litellm' });
  const out = runFixRetest({ priorAudit: rawPrior, newLogs: CLEAN });
  assert.ok(typeof out.new_id === 'string' && out.new_id, 'new report id minted');
  assert.ok(out.resolved.length >= 1, 'prior findings from a raw result resolve against a clean window');
});
