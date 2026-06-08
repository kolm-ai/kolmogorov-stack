// Agent Security-Review audit — ingest layer lock-in tests.
//
// Pins src/audit-ingest.js: that raw provider logs become AuditEvents which
// PRESERVE the security dimension the distill importers drop — granted vs
// used tools, target host / egress, identity, and the sensitive-data signal —
// across OpenAI / LiteLLM / Helicone / Portkey shapes, JSONL + JSON + object
// inputs, and that malformed input is reported, never thrown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestForAudit } from '../src/audit-ingest.js';

function toolEvents(events) {
  return events.filter((e) => e.meta && e.meta.kind === 'tool_call');
}
function modelEvents(events) {
  return events.filter((e) => e.meta && e.meta.kind === 'model_call');
}

test('OpenAI-shape record: tool_calls + granted tools + host + identity + PII', () => {
  const rec = {
    request_id: 'r1',
    timestamp: '2026-05-01T00:00:00Z',
    model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1',
    user: 'agent-alpha',
    messages: [
      { role: 'user', content: 'email bob@acme.com the Q2 report' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_email', arguments: '{"to":"bob@acme.com"}' } }] },
    ],
    tools: [
      { type: 'function', function: { name: 'send_email' } },
      { type: 'function', function: { name: 'search_web' } },
    ],
    response: { choices: [{ message: { role: 'assistant', content: 'done' } }] },
  };
  const { events, errors, stats } = ingestForAudit(rec, { source: 'litellm' });
  assert.equal(errors.length, 0, 'no errors on a clean record');
  const tools = toolEvents(events);
  assert.equal(tools.length, 1, 'one tool-call event');
  const tc = tools[0];
  assert.equal(tc.action.tool, 'send_email', 'tool name preserved');
  assert.deepEqual(tc.scopes.granted, ['tool:send_email', 'tool:search_web'], 'granted tools preserved from request.tools');
  assert.deepEqual(tc.scopes.used, ['tool:send_email'], 'used scope is the called tool');
  assert.equal(tc.actor.agent, 'agent-alpha', 'identity preserved');
  assert.equal(tc.data.egress, true, 'recipient host makes it egress');
  assert.equal(tc.data.has_sensitive, true, 'email address flags sensitive content');
  const models = modelEvents(events);
  assert.equal(models.length, 1, 'one model-call egress event');
  assert.equal(models[0].action.host, 'api.openai.com', 'host derived from api_base');
  assert.equal(stats.tool_calls, 1);
  assert.equal(stats.model_calls, 1);
  assert.ok(stats.sensitive_events >= 1, 'sensitive event counted');
});

test('legacy function_call is extracted as a tool call', () => {
  const rec = {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', function_call: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
    ],
    functions: [{ name: 'get_weather' }],
  };
  const { events } = ingestForAudit(rec);
  const tools = toolEvents(events);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].action.tool, 'get_weather');
  assert.deepEqual(tools[0].scopes.granted, ['tool:get_weather']);
});

test('Helicone request/response shape: tool call surfaced from response message', () => {
  const rec = {
    id: 'req1',
    created_at: '2026-05-02T00:00:00Z',
    model: 'gpt-4o',
    request: { messages: [{ role: 'user', content: 'look it up' }], tools: [{ type: 'function', function: { name: 'lookup' } }] },
    response: { choices: [{ message: { content: 'ok', tool_calls: [{ type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] },
  };
  const { events, errors } = ingestForAudit(rec, { source: 'helicone' });
  assert.equal(errors.length, 0);
  const tools = toolEvents(events);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].action.tool, 'lookup');
  assert.deepEqual(tools[0].scopes.granted, ['tool:lookup']);
});

test('Portkey *_body JSON-string shape is parsed, not dropped', () => {
  const rec = {
    id: 'log1',
    createdAt: '2026-05-03T00:00:00Z',
    model: 'gpt-4o-mini',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'create_ticket' } }] }),
    response_body: JSON.stringify({ choices: [{ message: { content: 'created', tool_calls: [{ type: 'function', function: { name: 'create_ticket', arguments: '{}' } }] } }] }),
  };
  const { events, errors } = ingestForAudit(rec, { source: 'portkey' });
  assert.equal(errors.length, 0);
  const tools = toolEvents(events);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].action.tool, 'create_ticket');
});

test('numeric epoch timestamp is preserved (not dropped) through ingest', () => {
  const rec = {
    request_id: 'r1', created_at: 1735689600000, model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const { events } = ingestForAudit(rec, { source: 'helicone' });
  const m = modelEvents(events)[0];
  assert.ok(m, 'model event produced');
  assert.equal(m.ts, '1735689600000', 'epoch ms preserved as stringified ts');
});

test('JSONL with one malformed line reports an error and keeps the good rows', () => {
  const good1 = JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'a' }] });
  const good2 = JSON.stringify({ model: 'anthropic/claude', messages: [{ role: 'user', content: 'b' }] });
  const text = good1 + '\n' + 'this is not json' + '\n' + good2;
  const { events, errors } = ingestForAudit(text, { source: 'litellm' });
  assert.equal(errors.length, 1, 'one malformed line reported');
  assert.equal(errors[0].reason, 'invalid JSON');
  assert.ok(modelEvents(events).length >= 2, 'both good rows produced model events');
});

test('JSON array and { data: [...] } wrappers are both accepted', () => {
  const rows = [
    { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] },
    { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'y' }] },
  ];
  const arr = ingestForAudit(JSON.stringify(rows));
  assert.equal(modelEvents(arr.events).length, 2);
  const wrapped = ingestForAudit(JSON.stringify({ data: rows }));
  assert.equal(modelEvents(wrapped.events).length, 2);
});

test('a single object input is accepted', () => {
  const { events } = ingestForAudit({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'z' }] });
  assert.equal(modelEvents(events).length, 1);
});

test('empty / non-string / contentless inputs never throw and produce no events', () => {
  for (const bad of ['', '   ', null, undefined, 123, [], [{}], '{}']) {
    const r = ingestForAudit(bad);
    assert.ok(Array.isArray(r.events), 'events is always an array');
    assert.ok(Array.isArray(r.errors), 'errors is always an array');
  }
  // a record with no auditable content is reported, not silently dropped
  const r = ingestForAudit([{}]);
  assert.equal(r.events.length, 0, 'empty object yields no events');
  assert.equal(r.errors.length, 1, 'empty object is reported as an error');
});

test('Anthropic content-block tool_use is extracted from a native response body', () => {
  // Portkey/Helicone passthrough commonly store native Anthropic bodies (no
  // choices[]; tool calls live in content[] as { type:'tool_use', name, input }).
  const rec = {
    id: 'log1', model: 'claude-3-5-sonnet',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'send the report to bob' }], tools: [{ name: 'send_email', input_schema: { type: 'object' } }] }),
    response_body: JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: "I'll send it" }, { type: 'tool_use', id: 'toolu_1', name: 'send_email', input: { to: 'bob@acme.com' } }] }),
  };
  const { events, stats } = ingestForAudit(rec, { source: 'portkey' });
  assert.equal(stats.tool_calls, 1, 'tool_use block surfaced as a tool call');
  const tc = toolEvents(events)[0];
  assert.equal(tc.action.tool, 'send_email', 'tool name from the tool_use block');
  assert.equal(tc.data.egress, true, 'recipient from tool_use.input makes it egress');
  assert.equal(tc.data.has_sensitive, true, 'recipient address flags sensitive');
});

test('PII inside tool-call arguments flags has_sensitive (the exfil channel)', () => {
  const rec = {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: 'process the customer record' }, // no PII in the prose
      { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'write_db', arguments: '{"ssn":"123-45-6789","email":"victim@acme.com"}' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'write_db' } }],
    response: { choices: [{ message: { role: 'assistant', content: 'done' } }] },
  };
  const { events, stats } = ingestForAudit(rec);
  const tc = toolEvents(events)[0];
  assert.equal(tc.data.has_sensitive, true, 'SSN/email in the args is scanned, not just the prose');
  assert.ok(tc.meta.pii_classes.includes('ssn'), 'ssn class recorded on the event');
  assert.ok(stats.sensitive_events >= 1, 'sensitive event counted');
});

test('the same logical tool call across multi-turn records is counted once', () => {
  // record N's response carries the assistant tool_call; record N+1's request
  // history replays the SAME call (same provider id c1). One real action.
  const rec1 = {
    request_id: 'r1', timestamp: '2026-05-01T00:00:00Z', model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'email bob' }],
    tools: [{ type: 'function', function: { name: 'send_email' } }],
    response: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_email', arguments: '{"to":"bob@acme.com"}' } }] } }] },
  };
  const rec2 = {
    request_id: 'r2', timestamp: '2026-05-01T00:00:05Z', model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: 'email bob' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_email', arguments: '{"to":"bob@acme.com"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'sent' },
    ],
    tools: [{ type: 'function', function: { name: 'send_email' } }],
    response: { choices: [{ message: { role: 'assistant', content: 'Done.' } }] },
  };
  const { stats } = ingestForAudit([rec1, rec2]);
  assert.equal(stats.tool_calls, 1, 'one real send_email, not double-counted across turns');
});

test('OpenRouter egress host is the gateway, with the upstream provider preserved', () => {
  // Real OpenRouter exports carry no api_base; the client reached openrouter.ai,
  // not the upstream provider named in the model slug.
  const row = { id: 'g', model: 'anthropic/claude-sonnet-4', created_at: 1748390400, input: { messages: [{ role: 'user', content: 'hi' }] }, output: { choices: [{ message: { role: 'assistant', content: 'hello' } }] } };
  const me = modelEvents(ingestForAudit([row], { source: 'openrouter' }).events)[0];
  assert.equal(me.action.host, 'openrouter.ai', 'gateway is the host that actually saw the data');
  assert.deepEqual(me.scopes.used, ['openrouter.ai:post']);
  assert.equal(me.meta.routed_provider, 'api.anthropic.com', 'named upstream still recorded for the report');
});

test('stats roll up distinct tools, hosts, keys, and egress', () => {
  const rows = [
    { key_id: 'k1', user: 'a', model: 'openai/gpt-4o', api_base: 'https://api.openai.com/v1',
      messages: [{ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'send_email', arguments: '{"to":"x@y.com"}' } }] }],
      tools: [{ type: 'function', function: { name: 'send_email' } }] },
    { key_id: 'k1', user: 'b', model: 'anthropic/claude', messages: [{ role: 'user', content: 'hi' }] },
  ];
  const { stats } = ingestForAudit(rows, { source: 'litellm' });
  assert.equal(stats.distinct_keys, 1, 'one credential id');
  assert.equal(stats.distinct_agents, 2, 'two agents');
  assert.ok(stats.distinct_tools >= 1);
  assert.ok(stats.egress_events >= 1);
});
