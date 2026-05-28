// W918 P2.3 - Agent trajectory parser lock-in tests.
//
// Covers the six behavioral guarantees src/distill/agent-trajectory.js makes
// to src/distill/collect.js: shape roundtrip for both OpenAI and Anthropic
// tool-call formats, malformed input is skipped rather than thrown, stable
// canonicalization across key order, MCP-prefix stripping in tool names, and
// mixed conversation row counting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTrajectory,
  canonicalizeArgs,
  normalizeToolName,
} from '../src/distill/agent-trajectory.js';

test('W918-P2.3.a OpenAI tool_calls roundtrip yields one row with stable args_normalized', () => {
  const messages = [
    { role: 'user', content: 'Look up the weather in Tokyo.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ city: 'Tokyo', units: 'celsius' }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'get_weather',
      content: '{"temp":14,"sky":"clear"}',
    },
  ];

  const out = parseTrajectory(messages);
  assert.equal(out.parseErrors.length, 0);
  assert.equal(out.rows.length, 1);

  const row = out.rows[0];
  assert.equal(row.kind, 'agent_turn');
  assert.equal(row.teacher_source, 'openai');
  assert.equal(row.user_input, 'Look up the weather in Tokyo.');
  assert.equal(row.tool_calls.length, 1);
  assert.equal(row.tool_calls[0].name, 'get_weather');
  assert.equal(
    row.tool_calls[0].args_normalized,
    '{"city":"Tokyo","units":"celsius"}',
    'args_normalized must have sorted keys for byte-equal council compare',
  );
  assert.equal(row.tool_results.length, 1);
  assert.equal(row.tool_results[0].name, 'get_weather');
});

test('W918-P2.3.b Anthropic tool_use roundtrip yields one row with teacher_source=anthropic', () => {
  const messages = [
    { role: 'user', content: 'Search the repo for "kolm"' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will search now.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'mcp__github__search_code',
          input: { query: 'kolm', repo: 'sneaky-hippo/kolmogorov-stack' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: 'Found 412 hits.',
          is_error: false,
        },
      ],
    },
  ];

  const out = parseTrajectory(messages);
  assert.equal(out.parseErrors.length, 0);
  assert.equal(out.rows.length, 1);

  const row = out.rows[0];
  assert.equal(row.teacher_source, 'anthropic');
  assert.equal(row.assistant_text, 'I will search now.');
  assert.equal(row.tool_calls.length, 1);
  assert.equal(row.tool_calls[0].name, 'search_code', 'mcp__github__ prefix must be stripped');
  assert.equal(row.tool_results.length, 1);
  assert.equal(row.tool_results[0].ok, true);
  assert.equal(row.tool_results[0].result_excerpt, 'Found 412 hits.');
});

test('W918-P2.3.c Malformed row is skipped without throwing', () => {
  let out;
  assert.doesNotThrow(() => {
    out = parseTrajectory('not-json-at-all\n{"broken":');
  });
  assert.ok(out);
  assert.equal(out.rows.length, 0);
  assert.ok(out.skipped >= 1, 'skipped count should track malformed lines');
  assert.ok(out.parseErrors.length >= 1, 'parseErrors should explain at least one failure');

  // A non-string, non-object input must also not throw.
  const out2 = parseTrajectory(42);
  assert.equal(out2.rows.length, 0);
  assert.ok(out2.parseErrors.length >= 1);
});

test('W918-P2.3.d canonicalizeArgs is order-independent', () => {
  const a = canonicalizeArgs({ b: 2, a: 1 });
  const b = canonicalizeArgs({ a: 1, b: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":1,"b":2}');

  // Nested objects also sort.
  const c = canonicalizeArgs({ z: { y: 2, x: 1 }, a: [3, 2, 1] });
  const d = canonicalizeArgs({ a: [3, 2, 1], z: { x: 1, y: 2 } });
  assert.equal(c, d);

  // String input that happens to be JSON is normalized too.
  const e = canonicalizeArgs('{"b":2,"a":1}');
  assert.equal(e, '{"a":1,"b":2}');
});

test('W918-P2.3.e normalizeToolName strips mcp prefix and lowercases', () => {
  assert.equal(normalizeToolName('mcp__github__create_issue'), 'create_issue');
  assert.equal(normalizeToolName('mcp__slack__send_message'), 'send_message');
  assert.equal(normalizeToolName('functions.search_web'), 'search_web');
  assert.equal(normalizeToolName('GitHub-API.CreateIssue'), 'createissue');
  assert.equal(normalizeToolName('plain_tool'), 'plain_tool');
  assert.equal(normalizeToolName(''), '');
  assert.equal(normalizeToolName(null), '');
});

test('W918-P2.3.f Mixed chat + tool_use yields one row per assistant turn', () => {
  const messages = [
    { role: 'user', content: 'Hi.' },
    { role: 'assistant', content: 'Hello, how can I help?' },
    { role: 'user', content: 'List my repos.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool_use',
          id: 'toolu_42',
          name: 'list_repos',
          input: { owner: 'me' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_42', content: 'repo-a, repo-b' },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'You have repo-a and repo-b.' }],
    },
  ];

  const out = parseTrajectory(messages);
  assert.equal(out.parseErrors.length, 0);
  assert.equal(out.rows.length, 3, 'expect three assistant turns');

  // Chat-only turns have empty tool_calls.
  assert.equal(out.rows[0].tool_calls.length, 0);
  assert.equal(out.rows[0].assistant_text, 'Hello, how can I help?');

  // Middle turn has the tool call.
  assert.equal(out.rows[1].tool_calls.length, 1);
  assert.equal(out.rows[1].tool_calls[0].name, 'list_repos');
  assert.equal(out.rows[1].tool_results.length, 1);

  // Final turn is chat-only again.
  assert.equal(out.rows[2].tool_calls.length, 0);
  assert.equal(out.rows[2].assistant_text, 'You have repo-a and repo-b.');

  // Idempotency: re-feeding the rows back through is a no-op.
  const second = parseTrajectory(out.rows);
  assert.deepEqual(second.rows, out.rows);
});
