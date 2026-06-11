// Agent Security-Review audit - multi-agent delegation analyzer lock-in tests.
//
// Pins src/delegation-analyzer.js (ASR-8). Proves it detects both explicit
// spawn / delegate handoffs and implicit multi-agent sessions under one
// credential, classifies each hop by the same tier grammar the rest of the
// engine uses (classifyScopeTier), and - the load-bearing property - never
// scores absence-of-delegation as clean: an export with no handoff is marked
// untested, a clean export is the positive finding, and every problem hop
// (escalation / unattenuated / opaque) is surfaced with its severity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/audit-event.js';
import { analyzeDelegation } from '../src/delegation-analyzer.js';

function ev({ key_id = 'k1', agent, tool, namespace = 'audit', meta = {}, used }) {
  return normalizeEvent({
    namespace,
    actor: { key_id, agent },
    action: { type: 'tool', tool },
    scopes: used ? { used } : { used: ['tool:' + tool.toLowerCase()] },
    meta: { kind: 'tool_call', ...meta },
  });
}

const has = (findings, id) => findings.some((f) => f.id === id);
const get = (findings, id) => findings.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// contract: never throws, empty / bad input is empty-but-valid.
// ---------------------------------------------------------------------------
test('analyzeDelegation never throws on empty / bad input', () => {
  for (const bad of [undefined, null, 'x', 42, {}, [], [null, 5, 'nope']]) {
    const r = analyzeDelegation(bad);
    assert.ok(Array.isArray(r.findings), 'findings is an array');
    assert.ok(Array.isArray(r.delegations), 'delegations is an array');
    assert.ok(r.agent_graph && Array.isArray(r.agent_graph.nodes) && Array.isArray(r.agent_graph.edges), 'agent_graph shaped');
    assert.ok(r.summary && typeof r.summary === 'object', 'summary present');
  }
});

test('empty events -> delegation-untested (never scored clean)', () => {
  const r = analyzeDelegation([]);
  assert.equal(r.delegations.length, 0);
  assert.equal(r.summary.detected, false);
  assert.deepEqual(r.findings.map((f) => f.id), ['delegation-untested']);
  assert.equal(r.findings[0].severity, 'info');
  assert.equal(r.findings[0].pillar, 'delegation');
  assert.ok(typeof r.summary.note === 'string' && /untested/i.test(r.summary.note));
});

test('a single agent with no handoff is untested, not clean', () => {
  const r = analyzeDelegation([ev({ agent: 'solo', tool: 'read_doc' })]);
  assert.equal(r.summary.detected, false);
  assert.ok(has(r.findings, 'delegation-untested'));
  assert.ok(!has(r.findings, 'delegation-attenuated'));
});

// ---------------------------------------------------------------------------
// implicit delegation: two agents under one credential.
// ---------------------------------------------------------------------------
test('privilege escalation via implicit delegation -> high', () => {
  // agentA (reads, tier 1) and agentB (deletes, tier 4) share key k1.
  const events = [
    ev({ key_id: 'k1', agent: 'planner', tool: 'read_doc' }),
    ev({ key_id: 'k1', agent: 'worker', tool: 'delete_record' }),
  ];
  const { findings, delegations, summary } = analyzeDelegation(events);
  const f = get(findings, 'delegation-privilege-escalation');
  assert.ok(f, 'escalation finding present');
  assert.equal(f.severity, 'high');
  assert.equal(f.pillar, 'delegation');
  assert.equal(f.analyzer, 'delegation');
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0].parent, 'planner');
  assert.equal(delegations[0].child, 'worker');
  assert.equal(delegations[0].type, 'implicit');
  assert.equal(delegations[0].classification, 'privilege-escalation');
  assert.equal(f.metric.parent_tier, 1);
  assert.equal(f.metric.child_tier, 4);
  assert.equal(summary.escalations, 1);
  assert.ok(!has(findings, 'delegation-attenuated'), 'no positive when a problem exists');
  assert.ok(f.evidence.length >= 1, 'escalation carries evidence ids');
});

test('unattenuated delegation (full inheritance, same scope) -> medium', () => {
  const events = [
    ev({ key_id: 'k2', agent: 'lead', tool: 'list_files' }),
    ev({ key_id: 'k2', agent: 'helper', tool: 'list_files' }),
  ];
  const { findings, delegations, summary } = analyzeDelegation(events);
  const f = get(findings, 'unattenuated-delegation');
  assert.ok(f, 'unattenuated finding present');
  assert.equal(f.severity, 'medium');
  assert.equal(f.pillar, 'delegation');
  assert.equal(delegations[0].classification, 'unattenuated');
  assert.equal(summary.unattenuated, 1);
  assert.ok(!has(findings, 'delegation-privilege-escalation'));
  assert.ok(!has(findings, 'delegation-attenuated'));
});

test('clean attenuated delegation (sub-agent strictly narrower) -> positive info', () => {
  // parent uses two read tools; child uses a strict subset (one of them).
  const events = [
    ev({ key_id: 'k3', agent: 'parent', tool: 'read_doc' }),
    ev({ key_id: 'k3', agent: 'parent', tool: 'list_files' }),
    ev({ key_id: 'k3', agent: 'child', tool: 'read_doc' }),
  ];
  const { findings, delegations, summary } = analyzeDelegation(events);
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0].classification, 'attenuated');
  assert.deepEqual(findings.map((f) => f.id), ['delegation-attenuated']);
  assert.equal(findings[0].severity, 'info');
  assert.equal(summary.attenuated, 1);
  assert.equal(summary.detected, true);
});

// ---------------------------------------------------------------------------
// explicit delegation: spawn / delegate tool calls.
// ---------------------------------------------------------------------------
test('explicit spawn with named sub-agent that escalates -> high, via tool name', () => {
  const events = [
    ev({ key_id: 'k4', agent: 'orchestrator', tool: 'spawn_agent', meta: { target_agent: 'runner' } }),
    ev({ key_id: 'k4', agent: 'runner', tool: 'wire_transfer' }),
  ];
  const { findings, delegations } = analyzeDelegation(events);
  const f = get(findings, 'delegation-privilege-escalation');
  assert.ok(f, 'escalation present');
  assert.equal(f.severity, 'high');
  assert.equal(delegations.length, 1, 'explicit edge is not double-counted as implicit');
  assert.equal(delegations[0].type, 'explicit');
  assert.equal(delegations[0].via, 'spawn_agent');
  assert.equal(delegations[0].parent, 'orchestrator');
  assert.equal(delegations[0].child, 'runner');
});

test('explicit delegate handoff with unrecorded sub-agent identity -> opaque medium', () => {
  const events = [
    ev({ key_id: 'k5', agent: 'orchestrator', tool: 'delegate_task' }), // no target in meta
  ];
  const { findings, delegations, summary } = analyzeDelegation(events);
  const f = get(findings, 'opaque-delegation-hop');
  assert.ok(f, 'opaque finding present');
  assert.equal(f.severity, 'medium');
  assert.equal(delegations[0].classification, 'opaque');
  assert.equal(delegations[0].observed_child, false);
  assert.equal(delegations[0].child, '(unknown)');
  assert.equal(summary.opaque, 1);
  assert.ok(!has(findings, 'delegation-attenuated'));
});

test('explicit spawn naming a sub-agent that never acts -> opaque (unattributable hop)', () => {
  const events = [
    ev({ key_id: 'k6', agent: 'orchestrator', tool: 'handoff', meta: { target_agent: 'ghost' } }),
  ];
  const { findings, delegations } = analyzeDelegation(events);
  assert.ok(has(findings, 'opaque-delegation-hop'));
  assert.equal(delegations[0].classification, 'opaque');
  assert.equal(delegations[0].child, 'ghost');
  assert.equal(delegations[0].observed_child, false);
});

// ---------------------------------------------------------------------------
// agent graph + determinism.
// ---------------------------------------------------------------------------
test('agent_graph exposes nodes (agents) and edges (delegations) for the passport', () => {
  const events = [
    ev({ key_id: 'k7', agent: 'planner', tool: 'read_doc' }),
    ev({ key_id: 'k7', agent: 'worker', tool: 'delete_record' }),
  ];
  const { agent_graph } = analyzeDelegation(events);
  const ids = agent_graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['planner', 'worker']);
  assert.equal(agent_graph.edges.length, 1);
  assert.deepEqual(
    { from: agent_graph.edges[0].from, to: agent_graph.edges[0].to, classification: agent_graph.edges[0].classification },
    { from: 'planner', to: 'worker', classification: 'privilege-escalation' },
  );
  const worker = agent_graph.nodes.find((n) => n.id === 'worker');
  assert.equal(worker.max_tier, 4);
});

test('opaque hop adds an (unknown) node to the graph', () => {
  const { agent_graph } = analyzeDelegation([
    ev({ key_id: 'k8', agent: 'orchestrator', tool: 'dispatch' }),
  ]);
  assert.ok(agent_graph.nodes.some((n) => n.id === '(unknown)' && n.unknown === true));
});

test('analyzeDelegation is deterministic: same events -> identical result', () => {
  const events = [
    ev({ key_id: 'k9', agent: 'a', tool: 'read_doc' }),
    ev({ key_id: 'k9', agent: 'b', tool: 'update_record' }),
    ev({ key_id: 'ka', agent: 'c', tool: 'spawn_agent', meta: { target_agent: 'd' } }),
    ev({ key_id: 'ka', agent: 'd', tool: 'read_doc' }),
  ];
  const a = analyzeDelegation(events);
  const b = analyzeDelegation(events);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// cross-credential delegation (GAP-4): per-agent scoped keys must not make the
// delegation invisible to the next audit.
// ---------------------------------------------------------------------------
test('explicit spawn naming an agent observed under ANOTHER key -> evaluable cross-credential edge', () => {
  // Parent (key kA) spawns 'worker'; worker acts under its own scoped key kB -
  // exactly the remediation every delegation finding recommends. Before GAP-4
  // this was an opaque hop (or vanished entirely); now it is classified.
  const events = [
    ev({ key_id: 'kA', agent: 'parent', tool: 'read_doc' }),
    ev({ key_id: 'kA', agent: 'parent', tool: 'spawn_agent', meta: { target_agent: 'worker' } }),
    ev({ key_id: 'kB', agent: 'worker', tool: 'delete_record' }),
  ];
  const { findings, delegations, summary } = analyzeDelegation(events);
  assert.equal(delegations.length, 1, 'one edge across the credential boundary');
  const d = delegations[0];
  assert.equal(d.type, 'explicit');
  assert.equal(d.cross_credential, true, 'edge marked cross-credential');
  assert.equal(d.parent, 'parent');
  assert.equal(d.child, 'worker');
  assert.equal(d.observed_child, true, 'NOT an opaque hop - the child profile is resolved');
  assert.equal(d.classification, 'privilege-escalation');
  assert.deepEqual(d.child_sessions, ['key::kB'], 'records where the child was observed');
  const f = get(findings, 'delegation-privilege-escalation');
  assert.ok(f, 'escalation still surfaced across keys');
  assert.equal(f.metric.cross_credential, true);
  assert.equal(summary.cross_credential, 1);
  assert.ok(!has(findings, 'opaque-delegation-hop'), 'no longer degraded to opaque');
  assert.ok(!has(findings, 'delegation-untested'), 'and certainly not untested');
});

test('shared thread_id across two keys -> implicit cross-credential edge via thread-correlation', () => {
  const events = [
    ev({ key_id: 'kc1', agent: 'router', tool: 'read_doc', meta: { thread_id: 'th-9' } }),
    ev({ key_id: 'kc2', agent: 'executor', tool: 'delete_record', meta: { thread_id: 'th-9' } }),
  ];
  const { findings, delegations, summary } = analyzeDelegation(events);
  assert.equal(delegations.length, 1, 'thread correlation builds the edge the key boundary hid');
  const d = delegations[0];
  assert.equal(d.type, 'implicit');
  assert.equal(d.via, 'thread-correlation');
  assert.equal(d.session, 'thread::th-9');
  assert.equal(d.cross_credential, true);
  assert.equal(d.classification, 'privilege-escalation');
  assert.equal(summary.cross_credential, 1);
  assert.equal(summary.detected, true);
  assert.ok(has(findings, 'delegation-privilege-escalation'));
});

test('per-agent-key remediation no longer collapses to untested (the GAP-4 regression)', () => {
  // The exact post-remediation fleet: each agent on its own scoped key, work
  // correlated only by thread. The old analyzer reported delegation-untested.
  const events = [
    ev({ key_id: 'key-planner', agent: 'planner', tool: 'read_doc', meta: { thread_id: 'job-1' } }),
    ev({ key_id: 'key-planner', agent: 'planner', tool: 'list_files', meta: { thread_id: 'job-1' } }),
    ev({ key_id: 'key-worker', agent: 'worker', tool: 'read_doc', meta: { thread_id: 'job-1' } }),
  ];
  const { findings, summary } = analyzeDelegation(events);
  assert.equal(summary.detected, true, 'delegation still detected after the recommended key split');
  assert.ok(!has(findings, 'delegation-untested'));
  // And a properly attenuated child stays the positive finding.
  assert.ok(has(findings, 'delegation-attenuated'), 'strict-subset child across keys reads as attenuated');
});

test('thread correlation dedupes against an explicit cross-credential edge', () => {
  const events = [
    ev({ key_id: 'kA', agent: 'parent', tool: 'read_doc', meta: { thread_id: 'th-x' } }),
    ev({ key_id: 'kA', agent: 'parent', tool: 'spawn_agent', meta: { target_agent: 'worker', thread_id: 'th-x' } }),
    ev({ key_id: 'kB', agent: 'worker', tool: 'delete_record', meta: { thread_id: 'th-x' } }),
  ];
  const { delegations, summary } = analyzeDelegation(events);
  assert.equal(delegations.length, 1, 'one edge, not an explicit + thread duplicate');
  assert.equal(delegations[0].type, 'explicit', 'the explicit edge wins');
  assert.equal(summary.cross_credential, 1);
});

test('agents sharing a thread under the SAME key do not double-count via thread correlation', () => {
  const events = [
    ev({ key_id: 'k1', agent: 'planner', tool: 'read_doc', meta: { thread_id: 'th-same' } }),
    ev({ key_id: 'k1', agent: 'worker', tool: 'delete_record', meta: { thread_id: 'th-same' } }),
  ];
  const { delegations } = analyzeDelegation(events);
  assert.equal(delegations.length, 1, 'pass-2b implicit edge only');
  assert.equal(delegations[0].via, 'implicit');
  assert.equal(delegations[0].cross_credential, undefined);
});

test('summary counts reconcile with the delegation classifications', () => {
  const events = [
    ev({ key_id: 'kb', agent: 'p1', tool: 'read_doc' }),
    ev({ key_id: 'kb', agent: 'c1', tool: 'delete_record' }),      // escalation
    ev({ key_id: 'kc', agent: 'p2', tool: 'list_files' }),
    ev({ key_id: 'kc', agent: 'c2', tool: 'list_files' }),         // unattenuated
    ev({ key_id: 'kd', agent: 'orch', tool: 'delegate_task' }),    // opaque
  ];
  const { delegations, summary } = analyzeDelegation(events);
  assert.equal(summary.delegations, delegations.length);
  assert.equal(summary.escalations + summary.unattenuated + summary.opaque + summary.attenuated, delegations.length);
  assert.equal(summary.escalations, 1);
  assert.equal(summary.unattenuated, 1);
  assert.equal(summary.opaque, 1);
  assert.equal(summary.detected, true);
});
