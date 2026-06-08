// Agent Security-Review audit — permission analyzer lock-in tests.
//
// Pins src/permission-analyzer.js: that least-privilege analysis surfaces the
// posture problems that stall deals — wildcard grants, over-permission,
// shared credentials, undeclared/high-privilege actions, sensitive egress —
// and stays silent (a positive finding) on a clean surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/audit-event.js';
import { analyzePermissions } from '../src/permission-analyzer.js';

function toolEvent({ key_id = 'k1', agent = 'agentA', tool, granted, egress = false, sensitive = false }) {
  return normalizeEvent({
    namespace: 'audit',
    actor: { key_id, agent },
    action: { type: 'tool', tool },
    scopes: { granted, used: ['tool:' + tool.toLowerCase()] },
    data: { egress, has_sensitive: sensitive },
    meta: { kind: 'tool_call' },
  });
}

function has(findings, id) {
  return findings.some((f) => f.id === id);
}
function get(findings, id) {
  return findings.find((f) => f.id === id);
}

test('analyzePermissions never throws on empty / bad input', () => {
  for (const bad of [undefined, null, 'x', 42, [], [null, 5]]) {
    const r = analyzePermissions(bad);
    assert.ok(Array.isArray(r.findings), 'findings is an array');
    assert.ok(r.summary, 'summary present');
  }
});

test('wildcard grant produces a critical finding', () => {
  const events = [toolEvent({ tool: 'read_doc', granted: ['*', 'tool:read_doc'] })];
  const { findings } = analyzePermissions(events);
  const f = get(findings, 'wildcard-grant');
  assert.ok(f, 'wildcard-grant present');
  assert.equal(f.severity, 'critical');
  assert.equal(f.pillar, 'permission');
});

test('over-permission flags granted-but-unused tools', () => {
  const events = [toolEvent({ tool: 'read_doc', granted: ['tool:read_doc', 'tool:list_files', 'tool:fetch_url'] })];
  const { findings, actors } = analyzePermissions(events);
  const f = get(findings, 'over-permission');
  assert.ok(f, 'over-permission present');
  assert.equal(f.severity, 'high', '2 of 3 unused (>50%) is high');
  assert.equal(f.metric.granted, 3);
  assert.equal(f.metric.used, 1);
  assert.equal(f.metric.unused, 2);
  assert.equal(actors[0].unused_tools, 2);
});

test('shared credential across agents is flagged high', () => {
  const events = [
    toolEvent({ key_id: 'shared', agent: 'svc-a', tool: 'read_doc', granted: ['tool:read_doc'] }),
    toolEvent({ key_id: 'shared', agent: 'svc-b', tool: 'read_doc', granted: ['tool:read_doc'] }),
  ];
  const { findings, summary } = analyzePermissions(events);
  const f = get(findings, 'shared-credential');
  assert.ok(f, 'shared-credential present');
  assert.equal(f.severity, 'high');
  assert.equal(summary.shared_keys, 1);
});

test('undeclared tool call (escalation) is flagged when grants are known', () => {
  // granted only read_doc, but the agent used delete_record.
  const ev = normalizeEvent({
    namespace: 'audit',
    actor: { key_id: 'k1', agent: 'agentA' },
    action: { type: 'tool', tool: 'delete_record' },
    scopes: { granted: ['tool:read_doc'], used: ['tool:delete_record'] },
    meta: { kind: 'tool_call' },
  });
  const { findings } = analyzePermissions([ev]);
  assert.ok(has(findings, 'undeclared-tool-call'), 'undeclared-tool-call present');
  // delete_record is destructive → also a tier-4 high-privilege finding
  assert.ok(has(findings, 'high-privilege-action'), 'high-privilege-action present');
});

test('no declared grants but tools used → cannot prove least privilege', () => {
  const ev = normalizeEvent({
    namespace: 'audit',
    actor: { key_id: 'k1', agent: 'agentA' },
    action: { type: 'tool', tool: 'read_doc' },
    scopes: { granted: null, used: ['tool:read_doc'] },
    meta: { kind: 'tool_call' },
  });
  const { findings } = analyzePermissions([ev]);
  assert.ok(has(findings, 'no-declared-grants'), 'no-declared-grants present');
});

test('sensitive data leaving the boundary is flagged', () => {
  const ev = toolEvent({ tool: 'send_email', granted: ['tool:send_email'], egress: true, sensitive: true });
  const { findings } = analyzePermissions([ev]);
  assert.ok(has(findings, 'sensitive-egress'), 'sensitive-egress present');
});

test('a clean least-privilege surface yields the positive finding only', () => {
  // granted exactly equals used, no wildcard, single agent per key, read-only.
  const events = [toolEvent({ tool: 'read_doc', granted: ['tool:read_doc'] })];
  const { findings } = analyzePermissions(events);
  assert.equal(findings.length, 1, 'only one finding');
  assert.equal(findings[0].id, 'least-privilege-clean');
  assert.equal(findings[0].severity, 'info');
});

// Regression: events built through the documented canonical constructor
// normalizeEvent (which sets action.tool + scopes.used but NOT the
// source-specific meta.kind) were read as 0 tools used → a perfectly
// least-privilege agent reported 100% over-permissioned. Used-tool detection
// must key off the typed action / scopes.used, not the undocumented meta tag.
test('canonically-constructed tool events (no meta.kind) are not falsely over-permissioned', () => {
  const ev = normalizeEvent({
    namespace: 'audit',
    actor: { key_id: 'k1', agent: 'agentA' },
    action: { type: 'tool', tool: 'read_doc' },
    scopes: { granted: ['tool:read_doc'] }, // used is derived from the action
  });
  assert.equal(ev.meta.kind, undefined, 'canonical event carries no meta.kind');
  const { findings, actors } = analyzePermissions([ev]);
  assert.deepEqual(findings.map((f) => f.id), ['least-privilege-clean'], 'clean, not over-permission');
  assert.equal(actors[0].used_tools, 1, 'the exercised tool is counted');
});
