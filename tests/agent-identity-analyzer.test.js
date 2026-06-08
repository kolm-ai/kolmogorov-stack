// Agent Security-Review audit - agent identity analyzer lock-in tests.
//
// Pins src/agent-identity-analyzer.js: that the identity spine of the WEDGE
// proves WHO each agent is. It enumerates the distinct (agent, key_id)
// identities a log export contains and surfaces the attestation gaps a
// reviewer cannot sign over - unattributed actions, one credential asserting
// many agent names, a credential with no declared scope - while marking an
// absent signal as untested rather than scoring it clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/audit-event.js';
import { analyzeAgentIdentity } from '../src/agent-identity-analyzer.js';

function idEvent({ key_id = 'k1', agent = 'agentA', tool = 'read_doc', granted, ts, namespace = 'audit' }) {
  return normalizeEvent({
    namespace,
    ts,
    actor: { key_id, agent },
    action: { type: 'tool', tool },
    scopes: { granted, used: ['tool:' + tool.toLowerCase()] },
    meta: { kind: 'tool_call' },
  });
}

function has(findings, id) {
  return findings.some((f) => f.id === id);
}
function get(findings, id) {
  return findings.find((f) => f.id === id);
}

test('analyzeAgentIdentity never throws on empty / bad input', () => {
  for (const bad of [undefined, null, 'x', 42, {}, [], [null, 5]]) {
    const r = analyzeAgentIdentity(bad);
    assert.ok(Array.isArray(r.findings), 'findings is an array');
    assert.ok(Array.isArray(r.identities), 'identities is an array');
    assert.ok(r.summary, 'summary present');
  }
});

test('empty events yield an info untested result, never a clean pass', () => {
  const { findings, identities, summary } = analyzeAgentIdentity([]);
  assert.equal(findings.length, 1, 'one finding');
  assert.equal(findings[0].id, 'agent-identity-untested');
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].pillar, 'agent-identity');
  assert.equal(identities.length, 0);
  assert.equal(summary.attested, false, 'absent signal is not scored as attested');
  assert.equal(summary.by_severity.high, 0);
  assert.equal(summary.by_severity.critical, 0);
});

test('an action with no key_id and no agent is unattributed (high)', () => {
  const ev = normalizeEvent({
    namespace: 'audit',
    action: { type: 'tool', tool: 'read_doc' },
    scopes: { used: ['tool:read_doc'] },
    meta: { kind: 'tool_call' },
  });
  assert.equal(ev.actor.key_id, null, 'no key_id');
  assert.equal(ev.actor.agent, null, 'no agent');
  const { findings, identities, summary } = analyzeAgentIdentity([ev]);
  const f = get(findings, 'unattributed-agent-action');
  assert.ok(f, 'unattributed-agent-action present');
  assert.equal(f.severity, 'high');
  assert.equal(f.pillar, 'agent-identity');
  assert.equal(f.metric.unattributed_actions, 1);
  assert.equal(identities.length, 0, 'an unattributed action forms no identity');
  assert.equal(summary.unattributed_actions, 1);
  assert.equal(summary.attested, false);
});

test('one credential used by multiple agent names is ambiguous (medium)', () => {
  const events = [
    idEvent({ key_id: 'shared', agent: 'svc-a', granted: ['tool:read_doc'] }),
    idEvent({ key_id: 'shared', agent: 'svc-b', granted: ['tool:read_doc'] }),
  ];
  const { findings, identities, summary } = analyzeAgentIdentity(events);
  const f = get(findings, 'ambiguous-agent-identity');
  assert.ok(f, 'ambiguous-agent-identity present');
  assert.equal(f.severity, 'medium');
  assert.equal(f.pillar, 'agent-identity');
  assert.equal(f.metric.key_id, 'shared');
  assert.deepEqual(f.metric.agents, ['svc-a', 'svc-b']);
  assert.equal(summary.ambiguous_keys, 1);
  // The two (agent, key_id) pairs are two distinct identities.
  assert.equal(identities.length, 2);
  // It is an identity finding, NOT the permission analyzer's shared-credential.
  assert.equal(f.analyzer, 'agent-identity');
  assert.ok(!has(findings, 'shared-credential'), 'distinct from least-privilege shared-credential');
});

test('a credential with no declared scope anywhere is unverifiable (medium)', () => {
  // granted omitted -> scopes.granted normalizes to null (never declared).
  const ev = idEvent({ key_id: 'k1', agent: 'agentA', granted: undefined });
  assert.equal(ev.scopes.granted, null, 'no grant declared');
  const { findings } = analyzeAgentIdentity([ev]);
  const f = get(findings, 'unverifiable-agent-scope');
  assert.ok(f, 'unverifiable-agent-scope present');
  assert.equal(f.severity, 'medium');
  assert.equal(f.pillar, 'agent-identity');
  assert.equal(f.metric.key_id, 'k1');
  assert.ok(!has(findings, 'agent-identity-attested'), 'unscoped is not attested');
});

test('a clean, fully attributed, scoped identity set is attested (info)', () => {
  const events = [
    idEvent({ key_id: 'k1', agent: 'agentA', tool: 'read_doc', granted: ['tool:read_doc'] }),
    idEvent({ key_id: 'k2', agent: 'agentB', tool: 'list_files', granted: ['tool:list_files'] }),
  ];
  const { findings, identities, summary } = analyzeAgentIdentity(events);
  assert.equal(findings.length, 1, 'only the positive finding');
  assert.equal(findings[0].id, 'agent-identity-attested');
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].pillar, 'agent-identity');
  assert.equal(identities.length, 2);
  assert.equal(summary.attested, true);
  assert.equal(summary.attributed, 2);
  assert.equal(summary.partial, 0);
});

test('a partially attributed identity (key with no agent) is a gap, not attested', () => {
  // key_id present, agent absent, scope declared -> attributable but partial.
  const ev = idEvent({ key_id: 'k1', agent: null, granted: ['tool:read_doc'] });
  const { findings, identities, summary } = analyzeAgentIdentity([ev]);
  assert.ok(has(findings, 'agent-identity-partial'), 'agent-identity-partial present');
  assert.equal(get(findings, 'agent-identity-partial').severity, 'info');
  assert.ok(!has(findings, 'agent-identity-attested'), 'partial is not scored attested');
  assert.equal(identities[0].attribution, 'key-only');
  assert.equal(summary.attested, false);
  assert.equal(summary.partial, 1);
});

test('identities capture the facts a passport asserts', () => {
  const events = [
    idEvent({ key_id: 'k1', agent: 'agentA', tool: 'read_doc', granted: ['tool:read_doc', 'tool:list_files'], ts: '2026-06-01T10:00:00Z', namespace: 'ns-a' }),
    idEvent({ key_id: 'k1', agent: 'agentA', tool: 'list_files', granted: ['tool:list_files'], ts: '2026-06-01T12:00:00Z', namespace: 'ns-b' }),
  ];
  const { identities } = analyzeAgentIdentity(events);
  assert.equal(identities.length, 1, 'same (agent, key_id) pair is one identity');
  const i = identities[0];
  assert.equal(i.agent, 'agentA');
  assert.equal(i.key_id, 'k1');
  assert.equal(i.attribution, 'full');
  assert.deepEqual(i.scopes_granted, ['tool:list_files', 'tool:read_doc']);
  assert.deepEqual(i.scopes_used, ['tool:list_files', 'tool:read_doc']);
  assert.equal(i.tool_count, 2);
  assert.equal(i.events, 2);
  assert.equal(i.first_ts, '2026-06-01T10:00:00Z');
  assert.equal(i.last_ts, '2026-06-01T12:00:00Z');
  assert.deepEqual(i.namespaces, ['ns-a', 'ns-b']);
  assert.ok(Array.isArray(i.evidence) && i.evidence.length > 0, 'evidence ids captured');
});

test('the same agent under two distinct keys is two identities', () => {
  const events = [
    idEvent({ key_id: 'k1', agent: 'agentA', granted: ['tool:read_doc'] }),
    idEvent({ key_id: 'k2', agent: 'agentA', granted: ['tool:read_doc'] }),
  ];
  const { identities } = analyzeAgentIdentity(events);
  assert.equal(identities.length, 2, 'distinct credential bindings are distinct identities');
  assert.deepEqual(identities.map((i) => i.key_id).sort(), ['k1', 'k2']);
});

test('every finding carries the agent-identity pillar', () => {
  // Mixed surface: unattributed action + ambiguous key + unscoped identity.
  const events = [
    normalizeEvent({ namespace: 'audit', action: { type: 'tool', tool: 'read_doc' }, scopes: { used: ['tool:read_doc'] }, meta: { kind: 'tool_call' } }),
    idEvent({ key_id: 'shared', agent: 'svc-a', granted: ['tool:read_doc'] }),
    idEvent({ key_id: 'shared', agent: 'svc-b', granted: ['tool:read_doc'] }),
    idEvent({ key_id: 'k9', agent: 'agentZ', granted: undefined }),
  ];
  const { findings } = analyzeAgentIdentity(events);
  assert.ok(findings.length >= 3, 'multiple findings surfaced');
  for (const f of findings) {
    assert.equal(f.pillar, 'agent-identity', `${f.id} maps to the agent-identity pillar`);
    assert.equal(f.analyzer, 'agent-identity');
    assert.ok(Array.isArray(f.controls), 'controls slot present for the mapper');
  }
});
