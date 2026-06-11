// P4 GAP-6 - OpenAI Agents SDK trace connector lock-in tests.
//
// Pins src/connectors/openai-agents.js: trace / trace.span exports with
// span_data.type of generation (model event), function (tool event with
// arg-derived egress), handoff (explicit delegation edge the delegation
// analyzer reads via meta.to_agent / target_agent), guardrail (a runtime
// control the red-team runtime-guardrails-absent probe recognizes), and agent
// spans naming the actor + declared tool surface for their descendants. Plus:
// detection wins over langsmith, JSONL / {data:[...]} wrappers, and
// never-throws on garbage.
//
// Run: node --test tests/connector-openai-agents.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDelegation } from '../src/delegation-analyzer.js';
import { runRedTeam } from '../src/red-team.js';
import * as agents from '../src/connectors/openai-agents.js';
import { detectConnector, normalizeWith, normalizeAuto, SOURCES } from '../src/connectors/index.js';

/* --------------------------- representative fixtures --------------------------- */

// A two-agent workflow: triage agent runs a guardrail, a generation and a
// PII-bearing send_email function call, then hands off to a refund agent that
// acts under its own span - the canonical multi-agent trace.
const TRACE = [
  { object: 'trace', id: 'trace_1', workflow_name: 'support-flow', group_id: 'thread-42' },
  { object: 'trace.span', id: 'span_triage', trace_id: 'trace_1', parent_id: null, started_at: '2026-06-11T10:00:00Z',
    span_data: { type: 'agent', name: 'Triage Agent', tools: ['lookup_order', 'send_email'], handoffs: ['Refund Agent'] } },
  { object: 'trace.span', id: 'span_guard', trace_id: 'trace_1', parent_id: 'span_triage', started_at: '2026-06-11T10:00:01Z',
    span_data: { type: 'guardrail', name: 'pii_check', triggered: false } },
  { object: 'trace.span', id: 'span_gen', trace_id: 'trace_1', parent_id: 'span_triage', started_at: '2026-06-11T10:00:02Z',
    span_data: { type: 'generation', model: 'gpt-4o',
      input: [{ role: 'user', content: 'email maria her order confirmation' }],
      output: [{ role: 'assistant', content: 'sending to maria@example.com, SSN 401-55-9823' }] } },
  { object: 'trace.span', id: 'span_fn', trace_id: 'trace_1', parent_id: 'span_triage', started_at: '2026-06-11T10:00:03Z',
    span_data: { type: 'function', name: 'send_email', input: '{"to":"smtp.example.com","body":"SSN 401-55-9823"}', output: 'sent' } },
  { object: 'trace.span', id: 'span_handoff', trace_id: 'trace_1', parent_id: 'span_triage', started_at: '2026-06-11T10:00:04Z',
    span_data: { type: 'handoff', from_agent: 'Triage Agent', to_agent: 'Refund Agent' } },
  { object: 'trace.span', id: 'span_refund_agent', trace_id: 'trace_1', parent_id: 'span_handoff', started_at: '2026-06-11T10:00:05Z',
    span_data: { type: 'agent', name: 'Refund Agent', tools: ['issue_refund'] } },
  { object: 'trace.span', id: 'span_refund_fn', trace_id: 'trace_1', parent_id: 'span_refund_agent', started_at: '2026-06-11T10:00:06Z',
    span_data: { type: 'function', name: 'issue_refund', input: '{"order":"o-9","amount":120}', output: 'ok' } },
];

/* ----------------------------------- tests ------------------------------------ */

test('openai-agents: generation span -> model event with provider host + sensitivity scan', () => {
  const events = agents.normalize(TRACE);
  const model = events.find((e) => e.action.type === 'model');
  assert.ok(model, 'generation span produces a model event');
  assert.equal(model.meta.model, 'gpt-4o');
  assert.equal(model.action.host, 'api.openai.com', 'generations default to the provider host');
  assert.equal(model.data.egress, true);
  assert.equal(model.data.has_sensitive, true, 'PII in the output text is scanned');
  assert.equal(model.meta.source, 'openai-agents');
  assert.equal(model.meta.trace_id, 'trace_1');
  assert.equal(model.meta.thread_id, 'thread-42', 'group_id lands as thread_id (cross-credential correlation)');
  assert.equal(model.meta.workflow, 'support-flow');
  assert.equal(model.actor.agent, 'Triage Agent', 'nearest ancestor agent span names the actor');
});

test('openai-agents: function span -> tool event with arg-derived egress + granted surface', () => {
  const events = agents.normalize(TRACE);
  const email = events.find((e) => e.action.tool === 'send_email');
  assert.ok(email, 'function span produces a tool event');
  assert.equal(email.action.type, 'tool');
  assert.equal(email.action.host, 'smtp.example.com', 'destination host derived from URL-bearing arguments');
  assert.equal(email.data.egress, true);
  assert.equal(email.data.has_sensitive, true);
  assert.deepEqual(email.scopes.used, ['tool:send_email']);
  assert.deepEqual(email.scopes.granted, ['tool:lookup_order', 'tool:send_email'], 'agent span tools[] declare the granted surface');
  assert.equal(email.actor.agent, 'Triage Agent');

  const refund = events.find((e) => e.action.tool === 'issue_refund');
  assert.ok(refund, 'second agent function call present');
  assert.equal(refund.actor.agent, 'Refund Agent', 'parent_id chaining attributes the descendant span');
  assert.deepEqual(refund.scopes.granted, ['tool:issue_refund']);
});

test('openai-agents: handoff span reaches analyzeDelegation as an explicit edge', () => {
  const events = agents.normalize(TRACE);
  const handoff = events.find((e) => e.action.tool === 'handoff');
  assert.ok(handoff, 'handoff span produces a tool event');
  assert.equal(handoff.meta.to_agent, 'Refund Agent');
  assert.equal(handoff.meta.target_agent, 'Refund Agent', 'TARGET_KEYS-readable field set');
  assert.equal(handoff.actor.agent, 'Triage Agent', 'from_agent names the delegating side');

  const d = analyzeDelegation(events);
  assert.equal(d.summary.detected, true, 'delegation is detected, not untested');
  const edge = d.delegations.find((x) => x.type === 'explicit' && x.via === 'handoff');
  assert.ok(edge, 'an explicit handoff edge is recorded');
  assert.equal(edge.parent, 'Triage Agent');
  assert.equal(edge.child, 'Refund Agent');
});

test('openai-agents: guardrail span is a control step the red-team battery recognizes', () => {
  const events = agents.normalize(TRACE);
  const guard = events.find((e) => e.meta.kind === 'guardrail');
  assert.ok(guard, 'guardrail span produces an event');
  assert.ok(/guardrail/.test(guard.action.tool), `tool name carries the guardrail token (${guard.action.tool})`);
  assert.equal(guard.meta.triggered, false);

  // The battery sees the control: high-privilege actions follow a guardrail
  // step in chain order, so runtime-guardrails-absent must not say exposed.
  const rt = runRedTeam(events);
  const probe = rt.probes.find((p) => p.id === 'runtime-guardrails-absent');
  assert.ok(probe, 'runtime-guardrails-absent probe present');
  assert.equal(probe.status, 'resisted', 'guardrail precedes the data-leaving action in the chain');
});

test('openai-agents: detection - registry picks openai-agents, not langsmith/otel', () => {
  assert.ok(SOURCES.includes('openai-agents'), 'openai-agents is registered');
  assert.equal(detectConnector(TRACE), 'openai-agents');
  assert.equal(detectConnector(TRACE.map((r) => JSON.stringify(r)).join('\n')), 'openai-agents', 'JSONL detects');
  assert.equal(detectConnector({ data: TRACE }), 'openai-agents', '{data:[...]} page detects');
  const auto = normalizeAuto(TRACE);
  assert.equal(auto.source, 'openai-agents');
  assert.ok(auto.events.length >= 4, 'normalizeAuto routes to the openai-agents connector');
  assert.ok(normalizeWith('openai-agents', TRACE).length >= 4);
});

test('openai-agents: wrappers and shape tolerance', () => {
  // {data:[...]} page and JSONL normalize identically to the array.
  const fromArray = agents.normalize(TRACE).length;
  assert.equal(agents.normalize({ data: TRACE }).length, fromArray);
  assert.equal(agents.normalize(TRACE.map((r) => JSON.stringify(r)).join('\n')).length, fromArray);

  // Spans without an enclosing trace row still normalize (no thread/workflow).
  const bare = agents.normalize([
    { object: 'trace.span', id: 's1', trace_id: 't9', span_data: { type: 'function', name: 'Lookup_Order', input: '{}' } },
  ]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].action.tool, 'lookup_order', 'tool lowercased');
  assert.equal(bare[0].meta.trace_id, 't9');
});

test('openai-agents: never throws and returns [] on garbage', () => {
  const garbage = [undefined, null, 42, true, '', 'not json', '{bad', '[1,2,', [], [null], [42], {}, { random: 1 },
    [{ object: 'trace' }], [{ span_data: null }], [{ span_data: { type: 'mystery' } }]];
  for (const g of garbage) {
    const out = agents.normalize(g);
    assert.ok(Array.isArray(out), `normalize returns an array for ${JSON.stringify(g)}`);
  }
});
