// S10 onramp connectors - lock-in tests.
//
// Pins src/connectors/{datadog,langsmith,otel}.js + the registry. Each connector
// turns a representative platform export into canonical AuditEvents
// (src/audit-event.js shape) that:
//   1. carry the right security dimensions (identity, tool, egress, sensitive),
//   2. are consumed end to end by runAudit (the events are self-ingesting), so
//      the deal-blocking findings a buyer cares about surface, and
//   3. are also read directly by the analyzers (the documented AuditEvent
//      consumer) to the same effect.
// Plus: detect the source, route via the registry, and never throw on garbage.
//
// Run: node --test tests/connectors.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit } from '../src/audit-orchestrator.js';
import { analyzePermissions } from '../src/permission-analyzer.js';
import { analyzeAuditTrail } from '../src/audit-trail-analyzer.js';
import * as datadog from '../src/connectors/datadog.js';
import * as langsmith from '../src/connectors/langsmith.js';
import * as otel from '../src/connectors/otel.js';
import { connectors, SOURCES, detectConnector, normalizeWith, normalizeAuto } from '../src/connectors/index.js';

/* --------------------------- representative fixtures --------------------------- */

// Datadog LLM Observability: an over-permissioned shared agent that emails PII
// out with no tamper-evident trail - the canonical stalled-deal agent.
const DATADOG = [
  {
    trace_id: 't1', span_id: 's1', name: 'support-llm', start_ns: 1.770e18, ml_app: 'support-bot',
    tags: ['env:prod', 'agent:support-bot', 'api_key_id:ak_shared'],
    meta: {
      kind: 'llm',
      metadata: { model_name: 'gpt-4o', model_provider: 'openai' },
      input: {
        messages: [{ role: 'user', content: 'email maria the confirmation' }],
        tools: [
          { type: 'function', function: { name: 'get_order' } },
          { type: 'function', function: { name: 'send_email' } },
          { type: 'function', function: { name: 'delete_customer' } },
          { type: 'function', function: { name: 'export_customers' } },
        ],
      },
      output: {
        messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'send_email', arguments: '{"to":"smtp.example.com","body":"SSN 401-55-9823"}' } }] }],
      },
    },
  },
  {
    trace_id: 't1', span_id: 's2', name: 'send_email', start_ns: 1.7701e18, ml_app: 'support-bot',
    tags: ['agent:support-bot', 'api_key_id:ak_shared'],
    meta: { kind: 'tool', input: { value: '{"to":"smtp.example.com","body":"SSN 401-55-9823"}' } },
  },
];

// LangSmith run tree: an llm run that fires send_email, plus a separate tool run
// under the SAME api key by a DIFFERENT agent (shared-credential).
const LANGSMITH = [{
  id: 'r-root', name: 'AgentExecutor', run_type: 'chain', start_time: '2026-02-03T14:22:10Z',
  session_name: 'support', extra: { metadata: { user_id: 'support-bot', api_key_id: 'ls_shared' } },
  child_runs: [
    {
      id: 'r-llm', name: 'ChatOpenAI', run_type: 'llm', start_time: '2026-02-03T14:22:11Z', trace_id: 'tr1',
      extra: {
        metadata: { ls_model_name: 'gpt-4o', ls_provider: 'openai', user_id: 'support-bot', api_key_id: 'ls_shared' },
        invocation_params: {
          model: 'gpt-4o',
          tools: [
            { type: 'function', function: { name: 'get_order' } },
            { type: 'function', function: { name: 'send_email' } },
            { type: 'function', function: { name: 'delete_customer' } },
          ],
        },
      },
      inputs: { messages: [{ role: 'user', content: 'email the customer' }] },
      outputs: { generations: [[{ message: { tool_calls: [{ name: 'send_email', args: { to: 'smtp.example.com', body: 'SSN 401-55-9823' }, id: 'c1' }] } }]] },
    },
    {
      id: 'r-tool', name: 'charge_card', run_type: 'tool', start_time: '2026-02-03T14:22:12Z',
      extra: { metadata: { user_id: 'billing-bot', api_key_id: 'ls_shared' } },
      inputs: { url: 'api.stripe.com', acct: '7782' }, outputs: { ok: true },
    },
  ],
}];

// OpenTelemetry OTLP/JSON: a gen_ai chat span, an http POST span, and an
// execute_tool span - the three shapes an OTel-instrumented agent emits.
const OTEL = {
  resourceSpans: [{
    resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'support-bot' } },
      { key: 'enduser.id', value: { stringValue: 'support-bot' } },
    ] },
    scopeSpans: [{
      spans: [
        {
          name: 'chat gpt-4o', spanId: 'a1', traceId: 'b1', startTimeUnixNano: '1770000000000000000',
          attributes: [
            { key: 'gen_ai.system', value: { stringValue: 'openai' } },
            { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
            { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
            { key: 'gen_ai.completion', value: { stringValue: 'sending email with SSN 401-55-9823' } },
          ],
        },
        {
          name: 'POST api.stripe.com', spanId: 'a2', traceId: 'b1', startTimeUnixNano: '1770000001000000000',
          attributes: [
            { key: 'http.request.method', value: { stringValue: 'POST' } },
            { key: 'url.full', value: { stringValue: 'https://api.stripe.com/v1/charges' } },
            { key: 'server.address', value: { stringValue: 'api.stripe.com' } },
            { key: 'http.response.status_code', value: { intValue: '200' } },
          ],
        },
        {
          name: 'execute_tool send_email', spanId: 'a3', traceId: 'b1', startTimeUnixNano: '1770000002000000000',
          attributes: [
            { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
            { key: 'gen_ai.tool.name', value: { stringValue: 'send_email' } },
            { key: 'server.address', value: { stringValue: 'smtp.example.com' } },
            { key: 'gen_ai.tool.call.arguments', value: { stringValue: '{"to":"x","body":"SSN 401-55-9823"}' } },
          ],
        },
      ],
    }],
  }],
};

/* ------------------------------- shape helpers -------------------------------- */

function assertCanonical(ev, source) {
  assert.equal(typeof ev.id, 'string');
  assert.ok(ev.id.length > 0, 'event has a stable id');
  assert.equal(ev.namespace, source, 'namespace is the source');
  assert.ok(ev.actor && typeof ev.actor === 'object', 'actor block');
  assert.ok('key_id' in ev.actor && 'agent' in ev.actor, 'actor.key_id + actor.agent');
  assert.ok(ev.action && ['tool', 'api', 'model', 'unknown'].includes(ev.action.type), 'action.type is canonical');
  assert.ok(ev.scopes && Array.isArray(ev.scopes.used), 'scopes.used array');
  assert.ok('granted' in ev.scopes, 'scopes.granted present (may be null)');
  assert.ok(ev.data && typeof ev.data.has_sensitive === 'boolean' && typeof ev.data.egress === 'boolean', 'data flags are booleans');
  assert.ok(ev.meta && typeof ev.meta === 'object', 'meta passthrough');
}

function realFindingIds(auditResult) {
  return auditResult.findings.filter((f) => f.severity !== 'info').map((f) => f.id);
}

/* ----------------------------------- tests ------------------------------------ */

test('registry exposes the seven connectors', () => {
  assert.deepEqual([...SOURCES].sort(), ['datadog', 'langfuse', 'langsmith', 'mcp', 'openai-agents', 'openinference', 'otel']);
  for (const s of SOURCES) assert.equal(typeof connectors[s].normalize, 'function');
});

test('datadog: spans normalize to canonical AuditEvents and surface deal-blockers', () => {
  const events = datadog.normalize(DATADOG);
  assert.ok(events.length >= 2, 'at least the llm + tool spans produce events');
  for (const ev of events) assertCanonical(ev, 'datadog');

  // The send_email action is captured with its egress host + sensitive content.
  const email = events.find((e) => e.action.tool === 'send_email');
  assert.ok(email, 'send_email tool event present');
  assert.equal(email.action.host, 'smtp.example.com', 'egress host extracted from tool args');
  assert.equal(email.data.egress, true);
  assert.equal(email.data.has_sensitive, true, 'PII in the email body is detected');
  assert.equal(email.actor.key_id, 'ak_shared');
  assert.equal(email.actor.agent, 'support-bot');

  // Model provenance is carried.
  const model = events.find((e) => e.action.type === 'model');
  assert.ok(model && model.meta.model === 'gpt-4o', 'model recorded for provenance');

  // runAudit consumes the events end to end (self-ingesting) and the blockers land.
  const r = runAudit(events, { source: 'datadog' });
  assert.ok(r.ingest.events > 0, 'events ingest');
  assert.equal(r.summary.readiness_pct, 0, 'an over-permissioned, leaking agent collapses readiness');
  const blocking = r.summary.blocking.map((b) => b.id);
  for (const id of ['high-privilege-action', 'sensitive-egress', 'no-tamper-evidence']) {
    assert.ok(blocking.includes(id), `datadog audit blocks on ${id}`);
  }

  // The analyzers (the documented AuditEvent consumer) surface findings directly too.
  assert.ok(analyzePermissions(events).findings.some((f) => f.id === 'sensitive-egress'));
  assert.ok(analyzeAuditTrail(events).findings.some((f) => f.id === 'no-tamper-evidence'));
});

test('langsmith: run tree normalizes and surfaces a shared credential across agents', () => {
  const events = langsmith.normalize(LANGSMITH);
  assert.ok(events.length >= 2, 'llm + tool runs produce events');
  for (const ev of events) assertCanonical(ev, 'langsmith');

  // The send_email tool call extracted from the llm run output.
  const email = events.find((e) => e.action.tool === 'send_email');
  assert.ok(email, 'send_email tool call lifted from generations');
  assert.equal(email.action.host, 'smtp.example.com');
  assert.equal(email.data.has_sensitive, true);

  // The standalone tool run by a different agent on the same key.
  const charge = events.find((e) => e.action.tool === 'charge_card');
  assert.ok(charge, 'charge_card tool run present');
  assert.equal(charge.actor.agent, 'billing-bot');
  assert.equal(charge.actor.key_id, 'ls_shared');

  const r = runAudit(events, { source: 'langsmith' });
  const real = realFindingIds(r);
  assert.ok(real.includes('shared-credential'), 'one key across two agents is flagged');
  assert.ok(real.includes('sensitive-egress'), 'PII egress is flagged');
  assert.equal(r.summary.readiness_pct, 0);
});

test('otel: gen_ai + http spans normalize across OTLP and surface egress', () => {
  const events = otel.normalize(OTEL);
  assert.ok(events.length >= 3, 'chat + http + execute_tool spans produce events');
  for (const ev of events) assertCanonical(ev, 'otel');

  const model = events.find((e) => e.action.type === 'model');
  assert.ok(model && model.action.host === 'api.openai.com', 'gen_ai model egress host from gen_ai.system');
  assert.equal(model.meta.model, 'gpt-4o');

  const http = events.find((e) => e.action.type === 'api');
  assert.ok(http, 'http span -> api event');
  assert.equal(http.action.host, 'api.stripe.com');
  assert.equal(http.action.method, 'post');
  assert.equal(http.action.endpoint, '/v1/charges');

  const tool = events.find((e) => e.action.tool === 'send_email');
  assert.ok(tool, 'execute_tool span -> tool event');
  assert.equal(tool.action.host, 'smtp.example.com');
  assert.equal(tool.data.has_sensitive, true);

  const r = runAudit(events, { source: 'otel' });
  assert.ok(r.ingest.events > 0);
  assert.ok(realFindingIds(r).includes('sensitive-egress'), 'otel audit flags PII egress');
});

test('detectConnector identifies each platform and rejects noise', () => {
  assert.equal(detectConnector(DATADOG), 'datadog');
  assert.equal(detectConnector(LANGSMITH), 'langsmith');
  assert.equal(detectConnector(OTEL), 'otel');
  // JSONL strings detect too.
  assert.equal(detectConnector(LANGSMITH.map((r) => JSON.stringify(r)).join('\n')), 'langsmith');
  for (const noise of [undefined, null, 42, '', 'not json', '{bad', [], {}, [{ foo: 1 }]]) {
    assert.equal(detectConnector(noise), null, `no false-positive detect on ${JSON.stringify(noise)}`);
  }
});

test('detection matrix: mcp + openai-agents samples are not claimed by otel/langsmith', () => {
  // An MCP JSON-RPC log: id-bearing rows that would otherwise read as loose
  // spans to the OTLP sniff must land on the mcp connector.
  const mcpLog = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read_file' }] } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } },
    { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hello' }] } },
  ];
  assert.equal(detectConnector(mcpLog), 'mcp');
  assert.equal(detectConnector([{ schema: 'mcp-tool-call-1', tool: 'send_email', call_id: 'mtc_1' }]), 'mcp');
  assert.equal(detectConnector([{ schema: 'mcp-tool-call-2', tool: 'send_email', call_id: 'mtc_2' }]), 'mcp');
  assert.equal(detectConnector([{ schema: 'mcp-tool-call-3', tool: 'send_email', call_id: 'mtc_3' }]), 'mcp');

  // OpenAI Agents SDK rows have no run_type / dotted_order; they must be
  // claimed by openai-agents BEFORE langsmith's looser sniff gets a look.
  const agentsTrace = [
    { object: 'trace', id: 'trace_1', workflow_name: 'support', group_id: 'grp_1' },
    { object: 'trace.span', id: 'span_1', trace_id: 'trace_1', span_data: { type: 'generation', model: 'gpt-4o', input: [], output: [] } },
    { object: 'trace.span', id: 'span_2', trace_id: 'trace_1', span_data: { type: 'function', name: 'send_email', input: '{}' } },
  ];
  assert.equal(detectConnector(agentsTrace), 'openai-agents');
  assert.equal(detectConnector(agentsTrace.map((r) => JSON.stringify(r)).join('\n')), 'openai-agents');
  // A bare span_data row (no object field) still detects.
  assert.equal(detectConnector([{ span_data: { type: 'handoff', from_agent: 'a', to_agent: 'b' }, trace_id: 't' }]), 'openai-agents');

  // And every existing sample still detects identically alongside the new pair.
  assert.equal(detectConnector(DATADOG), 'datadog');
  assert.equal(detectConnector(LANGSMITH), 'langsmith');
  assert.equal(detectConnector(OTEL), 'otel');
});

test('normalizeWith + normalizeAuto route correctly', () => {
  assert.ok(normalizeWith('datadog', DATADOG).length > 0);
  assert.deepEqual(normalizeWith('nope', DATADOG), [], 'unknown source -> []');
  const auto = normalizeAuto(OTEL);
  assert.equal(auto.source, 'otel');
  assert.ok(auto.events.length >= 3);
  assert.deepEqual(normalizeAuto('not a trace'), { source: null, events: [] });
});

test('connectors never throw and return [] on malformed / unknown input', () => {
  const garbage = [undefined, null, 42, true, '', 'not json', '{bad', '[1,2,', [], [null], [42], {}, { random: 1 }, [{ no: 'shape' }]];
  for (const c of [datadog, langsmith, otel]) {
    for (const g of garbage) {
      const out = c.normalize(g);
      assert.ok(Array.isArray(out), `normalize returns an array for ${JSON.stringify(g)}`);
    }
  }
  // And the registry stays defensive too.
  for (const g of garbage) {
    assert.ok(Array.isArray(normalizeWith('datadog', g)));
    assert.equal(typeof (normalizeAuto(g).source) === 'string' || normalizeAuto(g).source === null, true);
  }
});

test('a clean least-privilege OTel trace does NOT manufacture blockers', () => {
  // One agent, one key, a single read-only tool that matches its grant, all
  // hash-chained: the audit must not invent deal-blockers from a healthy trace.
  const clean = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'enduser.id', value: { stringValue: 'reader' } }] },
      scopeSpans: [{ spans: [{
        name: 'execute_tool read_doc', spanId: 'c1', traceId: 'z1', startTimeUnixNano: '1770000000000000000',
        attributes: [
          { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
          { key: 'gen_ai.tool.name', value: { stringValue: 'read_doc' } },
          { key: 'kolm.hash', value: { stringValue: 'h1' } },
        ],
      }] }],
    }],
  };
  const events = otel.normalize(clean);
  assert.ok(events.length >= 1);
  const r = runAudit(events, { source: 'otel' });
  assert.equal(r.summary.blocking.length, 0, 'no fabricated blockers on a clean read-only trace');
});
