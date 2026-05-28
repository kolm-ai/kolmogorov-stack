// W735 — Agent / Tool-Use distillation tests.
//
// Atomic items pinned (matches the W735 implementation):
//
//   1) TOOL_USE_VERSION + TOOL_RUNTIME_VERSION pinned to 'w735-v1'
//   2) parseToolCalls handles Anthropic shape (content[].type === 'tool_use')
//   3) parseToolCalls handles OpenAI shape (message.tool_calls[])
//   4) parseToolCalls handles generic shape (top-level function_call)
//   5) parseToolCalls returns parse_source:'none' on absence (never throws)
//   6) formatToolUseCapture emits ChatML+tool block when tool_calls present
//   7) formatToolUseCapture falls through to USER/ASSISTANT when absent
//   8) executeToolCall returns tool_not_found envelope for missing tool
//   9) executeToolCall handles registered tool happy path
//  10) accumulateAcceptanceMetrics returns null local_handling_rate when n<100
//  11) accumulateAcceptanceMetrics returns valid rate + CI when n>=100
//  12) public/docs/agents.html exists with brand-lock content
//  13) cli/kolm.js defines cmdW735ToolPatterns dispatcher exactly once
//  14) Family lock-in via regex wave(\d{3,4}) (no explicit-array per W604)
//
// W604 anti-brittleness: no explicit-array family checks. Assertions key on
// load-bearing tokens (version stamps, function names, file existence,
// regex on cli/kolm.js + docs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOOL_USE_VERSION,
  parseToolCalls,
  extractToolPatterns,
} from '../src/tool-use-capture.js';

import {
  formatToolUseCapture,
  validateToolSchema,
} from '../src/tool-training-format.js';

import {
  TOOL_RUNTIME_VERSION,
  registerTool,
  executeToolCall,
  accumulateAcceptanceMetrics,
} from '../src/tool-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'agents.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w735-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W735 #1 — TOOL_USE_VERSION + TOOL_RUNTIME_VERSION are "w735-v1"', () => {
  freshDir();
  assert.equal(TOOL_USE_VERSION, 'w735-v1',
    `expected version 'w735-v1'; got ${JSON.stringify(TOOL_USE_VERSION)}`);
  assert.equal(TOOL_RUNTIME_VERSION, 'w735-v1',
    `expected version 'w735-v1'; got ${JSON.stringify(TOOL_RUNTIME_VERSION)}`);
});

// =============================================================================
// 2) parseToolCalls handles Anthropic shape
// =============================================================================

test('W735 #2 — parseToolCalls handles Anthropic content[].type==="tool_use"', () => {
  freshDir();
  const body = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check the weather.' },
      { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'SF' } },
      { type: 'tool_use', id: 'toolu_02', name: 'get_time',    input: { tz: 'PST' } },
    ],
  };
  const out = parseToolCalls(body);
  assert.equal(out.parse_source, 'anthropic',
    `expected parse_source:'anthropic'; got ${out.parse_source}`);
  assert.equal(out.tool_calls.length, 2, 'must surface both tool_use entries');
  assert.equal(out.tool_calls[0].name, 'get_weather');
  assert.deepEqual(out.tool_calls[0].arguments, { city: 'SF' });
  assert.equal(out.tool_calls[0].id, 'toolu_01',
    'id from Anthropic tool_use block must survive');
  assert.equal(out.tool_calls[1].name, 'get_time');
});

// =============================================================================
// 3) parseToolCalls handles OpenAI shape
// =============================================================================

test('W735 #3 — parseToolCalls handles OpenAI message.tool_calls[]', () => {
  freshDir();
  const body = {
    id: 'chatcmpl-001',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_001',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC","units":"F"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  const out = parseToolCalls(body);
  assert.equal(out.parse_source, 'openai',
    `expected parse_source:'openai'; got ${out.parse_source}`);
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0].name, 'get_weather');
  // OpenAI wire format is JSON string — parser must deserialise it.
  assert.deepEqual(out.tool_calls[0].arguments, { city: 'NYC', units: 'F' },
    `expected parsed object; got ${JSON.stringify(out.tool_calls[0].arguments)}`);
  assert.equal(out.tool_calls[0].id, 'call_001');

  // Legacy single-call function_call shape under message.
  const legacy = {
    choices: [{
      message: {
        role: 'assistant',
        function_call: { name: 'lookup_id', arguments: '{"id":"abc"}' },
      },
    }],
  };
  const legacyOut = parseToolCalls(legacy);
  assert.equal(legacyOut.parse_source, 'openai',
    'legacy function_call under message must also resolve to openai');
  assert.equal(legacyOut.tool_calls.length, 1);
  assert.equal(legacyOut.tool_calls[0].name, 'lookup_id');
});

// =============================================================================
// 4) parseToolCalls handles generic shape (top-level function_call)
// =============================================================================

test('W735 #4 — parseToolCalls handles generic top-level function_call + tool_calls', () => {
  freshDir();
  const body1 = {
    function_call: { name: 'do_thing', arguments: '{"x":42}' },
  };
  const o1 = parseToolCalls(body1);
  assert.equal(o1.parse_source, 'generic',
    `top-level function_call must be 'generic'; got ${o1.parse_source}`);
  assert.equal(o1.tool_calls.length, 1);
  assert.equal(o1.tool_calls[0].name, 'do_thing');
  assert.deepEqual(o1.tool_calls[0].arguments, { x: 42 });

  // Top-level tool_calls array (Mistral / forked OpenAI-compatible APIs).
  const body2 = {
    tool_calls: [
      { id: 't1', function: { name: 'fetch_url', arguments: { url: 'http://x' } } },
    ],
  };
  const o2 = parseToolCalls(body2);
  assert.equal(o2.parse_source, 'generic');
  assert.equal(o2.tool_calls[0].name, 'fetch_url');
});

// =============================================================================
// 5) parseToolCalls returns none on absence (no throw)
// =============================================================================

test('W735 #5 — parseToolCalls returns parse_source:"none" on absence + never throws', () => {
  freshDir();
  // Plain text response — no tool shape anywhere.
  const o1 = parseToolCalls({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
  assert.equal(o1.parse_source, 'none');
  assert.deepEqual(o1.tool_calls, []);

  // Null/undefined/garbage — must not throw, must return empty envelope.
  assert.doesNotThrow(() => parseToolCalls(null));
  assert.doesNotThrow(() => parseToolCalls(undefined));
  assert.doesNotThrow(() => parseToolCalls('not json {{{'));
  assert.doesNotThrow(() => parseToolCalls(123));
  assert.doesNotThrow(() => parseToolCalls([1, 2, 3]));
  // Each pathological call must return parse_source:'none'.
  for (const bad of [null, undefined, 'garbage', 123, [], {}]) {
    const o = parseToolCalls(bad);
    assert.equal(o.parse_source, 'none',
      `bad input ${JSON.stringify(bad)} must yield parse_source:'none'; got ${o.parse_source}`);
    assert.ok(Array.isArray(o.tool_calls) && o.tool_calls.length === 0,
      `bad input must yield empty tool_calls; got ${JSON.stringify(o.tool_calls)}`);
  }

  // JSON-string body (some SDKs forward the wire body verbatim).
  const wired = JSON.stringify({
    content: [{ type: 'tool_use', name: 'foo', input: {} }],
  });
  const oWired = parseToolCalls(wired);
  assert.equal(oWired.parse_source, 'anthropic',
    'JSON-string body must still parse to anthropic when content[].tool_use is present');
  assert.equal(oWired.tool_calls[0].name, 'foo');
});

// =============================================================================
// 6) formatToolUseCapture emits ChatML+tool block when tool_calls present
// =============================================================================

test('W735 #6 — formatToolUseCapture emits ASSISTANT_TOOL_CALL + TOOL_RESULT lines for agent captures', () => {
  freshDir();
  const capture = {
    prompt: "What's the weather in SF?",
    response: 'The weather in San Francisco is 62 degrees and foggy.',
    tool_calls: [
      { name: 'get_weather', arguments: { city: 'SF' }, id: 'toolu_01' },
    ],
    tool_results: [
      { tool_call_id: 'toolu_01', output: { temp_f: 62, conditions: 'foggy' } },
    ],
  };
  const out = formatToolUseCapture(capture);
  assert.equal(typeof out, 'string', `must return string; got ${typeof out}`);
  // ChatML+tool block tags — load-bearing for the student.
  assert.ok(out.includes('ASSISTANT_TOOL_CALL:'),
    `output must include ASSISTANT_TOOL_CALL line; got:\n${out}`);
  assert.ok(out.includes('TOOL_RESULT:'),
    `output must include TOOL_RESULT line; got:\n${out}`);
  // The tool name + arguments must appear inside the call line.
  assert.ok(out.includes('"name":"get_weather"'),
    `must surface tool name in call JSON; got:\n${out}`);
  assert.ok(out.includes('"city":"SF"'),
    `must surface argument value in call JSON; got:\n${out}`);
  // The result payload must appear inside the result line.
  assert.ok(out.includes('"temp_f":62'),
    `must surface tool result value; got:\n${out}`);
  // USER / ASSISTANT framing lines.
  assert.ok(out.includes("USER: What's the weather in SF?"),
    `USER line must be present; got:\n${out}`);
  assert.ok(out.includes('ASSISTANT: The weather in San Francisco is 62 degrees and foggy.'),
    `final ASSISTANT line must be present; got:\n${out}`);
});

// =============================================================================
// 7) formatToolUseCapture falls through to USER/ASSISTANT when tool_calls absent
// =============================================================================

test('W735 #7 — formatToolUseCapture falls through to legacy USER/ASSISTANT format when no tool_calls', () => {
  freshDir();
  // No tool_calls field at all — legacy capture shape.
  const c1 = { prompt: 'hello', response: 'hi there' };
  const o1 = formatToolUseCapture(c1);
  assert.equal(o1, 'USER: hello\nASSISTANT: hi there',
    `legacy format must be USER:/ASSISTANT:; got ${JSON.stringify(o1)}`);
  assert.ok(!o1.includes('ASSISTANT_TOOL_CALL'),
    `legacy format MUST NOT inject ASSISTANT_TOOL_CALL lines; got ${o1}`);

  // Empty tool_calls array — still falls through.
  const c2 = { prompt: 'hello', response: 'hi', tool_calls: [] };
  const o2 = formatToolUseCapture(c2);
  assert.equal(o2, 'USER: hello\nASSISTANT: hi',
    `empty array must fall through to legacy format; got ${JSON.stringify(o2)}`);
});

// =============================================================================
// 8) executeToolCall returns tool_not_found envelope
// =============================================================================

test('W735 #8 — executeToolCall returns tool_not_found for unknown tool', async () => {
  freshDir();
  const tools = new Map();
  // No tools registered — every call must fail with tool_not_found.
  const out = await executeToolCall({
    tool_call: { name: 'missing_tool', arguments: {} },
    tool_registry: tools,
    auth_context: {},
  });
  assert.equal(out.ok, false, 'unknown tool must yield ok:false');
  assert.equal(out.error, 'tool_not_found',
    `expected error:'tool_not_found'; got ${JSON.stringify(out.error)}`);
  assert.ok(typeof out.detail === 'string' && out.detail.length > 0,
    'detail must be a non-empty string');

  // Invalid tool_call shape — must yield invalid_tool_call, never throw.
  const bad = await executeToolCall({
    tool_call: { name: '' },
    tool_registry: tools,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_tool_call');
});

// =============================================================================
// 9) executeToolCall handles registered tool happy path
// =============================================================================

test('W735 #9 — executeToolCall invokes registered handler + returns wrapped result', async () => {
  freshDir();
  const tools = new Map();
  registerTool(tools, {
    name: 'get_weather',
    handler: async ({ arguments: args, auth_context }) => {
      // The handler sees both the parsed arguments and the auth context.
      return {
        temp_f: 62,
        city: args.city,
        api_key_present: typeof auth_context.api_key === 'string',
      };
    },
    auth_schema: { required: ['api_key'] },
  });

  // Happy path — auth_context carries the required field.
  const ok = await executeToolCall({
    tool_call: { name: 'get_weather', arguments: { city: 'SF' } },
    tool_registry: tools,
    auth_context: { api_key: 'sk-test-xxx' },
  });
  assert.equal(ok.ok, true, `expected ok:true; got ${JSON.stringify(ok)}`);
  assert.equal(ok.result.temp_f, 62);
  assert.equal(ok.result.city, 'SF');
  assert.equal(ok.result.api_key_present, true,
    'handler must receive the auth_context');

  // Auth schema enforcement — missing required field yields auth_failed,
  // and the handler is NOT called.
  const noAuth = await executeToolCall({
    tool_call: { name: 'get_weather', arguments: { city: 'SF' } },
    tool_registry: tools,
    auth_context: {},
  });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.error, 'auth_failed',
    `missing auth must yield auth_failed; got ${JSON.stringify(noAuth)}`);

  // Handler exception path — wrapped as tool_threw, no propagation.
  registerTool(tools, {
    name: 'boom',
    handler: async () => { throw new Error('handler crashed'); },
  });
  const threw = await executeToolCall({
    tool_call: { name: 'boom', arguments: {} },
    tool_registry: tools,
    auth_context: {},
  });
  assert.equal(threw.ok, false);
  assert.equal(threw.error, 'tool_threw',
    `handler exception must yield tool_threw; got ${JSON.stringify(threw)}`);
  assert.ok(threw.detail.includes('handler crashed'),
    `tool_threw detail must include the original message; got ${threw.detail}`);
});

// =============================================================================
// 10) accumulateAcceptanceMetrics — null when sample_size < 100
// =============================================================================

test('W735 #10 — accumulateAcceptanceMetrics returns null local_handling_rate when n<100', () => {
  freshDir();
  // The honest insufficient-signal contract: below 100 captures, the
  // 90% acceptance rate cannot be claimed.
  const small = accumulateAcceptanceMetrics({
    sample_size: 4,
    n_handled_locally: 4,
    n_escalated_to_teacher: 0,
  });
  assert.equal(small.local_handling_rate, null,
    `n=4 must yield null local_handling_rate; got ${small.local_handling_rate}`);
  assert.equal(small.honest_acceptance, null,
    'honest_acceptance must mirror null when sample is insufficient');
  assert.equal(small.confidence_band_95, null,
    'confidence_band_95 must be null below n=30');
  assert.ok(typeof small.reason === 'string' && small.reason.includes('insufficient_signal'),
    `reason must be insufficient_signal_n<100; got ${small.reason}`);
  // Target is exposed verbatim — caller can decide how to compare.
  assert.equal(small.target, 0.90, 'target must be 0.90 (the W735-4 spec)');

  // Boundary check: n=99 still null.
  const just_below = accumulateAcceptanceMetrics({
    sample_size: 99,
    n_handled_locally: 99,
    n_escalated_to_teacher: 0,
  });
  assert.equal(just_below.local_handling_rate, null,
    'n=99 must STILL yield null — threshold is >=100, not >99');
});

// =============================================================================
// 11) accumulateAcceptanceMetrics — valid rate + CI when n >= 100
// =============================================================================

test('W735 #11 — accumulateAcceptanceMetrics returns valid rate + Wilson CI when n>=100', () => {
  freshDir();
  const big = accumulateAcceptanceMetrics({
    sample_size: 142,
    n_handled_locally: 128,
    n_escalated_to_teacher: 14,
  });
  assert.equal(typeof big.local_handling_rate, 'number',
    `n=142 must yield numeric rate; got ${big.local_handling_rate}`);
  // 128 / (128 + 14) = 0.901
  assert.ok(big.local_handling_rate > 0.89 && big.local_handling_rate < 0.92,
    `expected ~0.901 rate; got ${big.local_handling_rate}`);
  assert.equal(big.honest_acceptance, big.local_handling_rate,
    'honest_acceptance must equal local_handling_rate when sample is sufficient');
  // Wilson CI present + bounded in [0,1].
  assert.ok(big.confidence_band_95 != null, 'confidence_band_95 must be present at n=142');
  assert.ok(big.confidence_band_95.lo >= 0 && big.confidence_band_95.lo <= 1,
    `CI lo must be in [0,1]; got ${big.confidence_band_95.lo}`);
  assert.ok(big.confidence_band_95.hi >= 0 && big.confidence_band_95.hi <= 1,
    `CI hi must be in [0,1]; got ${big.confidence_band_95.hi}`);
  assert.ok(big.confidence_band_95.lo <= big.local_handling_rate
         && big.local_handling_rate <= big.confidence_band_95.hi,
    `rate must be inside its own CI; got lo=${big.confidence_band_95.lo} rate=${big.local_handling_rate} hi=${big.confidence_band_95.hi}`);
  // Should not be a 'reason' field when the rate is real.
  assert.equal(big.reason, undefined,
    `reason field must be absent when rate is real; got ${big.reason}`);
});

// =============================================================================
// 12) public/docs/agents.html exists with brand-lock content
// =============================================================================

test('W735 #12 — /docs/agents.html exists with brand-lock content', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock matches the W724/W730/W734 docs shell pattern.
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-foot',           // canonical footer class (W902 migrated ks-footer -> ks-foot)
    'tool-use',          // topic
    'ASSISTANT_TOOL_CALL',
    'TOOL_RESULT',
    'registerTool',      // runtime adapter helper
    'executeToolCall',
    'auth_schema',
    'local_handling_rate',
    'insufficient_signal', // honest acceptance contract
    'kolm tool',         // CLI surface
  ]) {
    assert.ok(html.includes(needle),
      `agents.html must mention "${needle}"`);
  }
});

// =============================================================================
// 13) cli/kolm.js defines cmdW735ToolPatterns dispatcher + routed via 'tool'
// =============================================================================

test('W735 #13 — cli/kolm.js defines cmdW735ToolPatterns dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named per the W724/W726/W727/W728/W729/W730/W731/W732/W733/W734
  // precedent so parallel wave agents can't collide on the symbol.
  const defs = cli.match(/async function cmdW735ToolPatterns\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW735ToolPatterns dispatcher definition; got ${defs.length}`);
  // Must be routed from a `case 'tool'` arm in main().
  assert.ok(/case\s+['"]tool['"]\s*:/.test(cli),
    `cmdW735ToolPatterns must be routed from case 'tool' in main()`);
  assert.ok(cli.includes('cmdW735ToolPatterns(rest)'),
    `cmdW735ToolPatterns must be invoked with the rest args`);
  // Honest fallback envelope — the load-bearing error code.
  assert.ok(cli.includes('no_captures_with_tools'),
    `cmdW735ToolPatterns must emit no_captures_with_tools envelope when local data is empty`);
});

// =============================================================================
// 14) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W735 #14 — wave735 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  // Walk the tests directory and count files matching wave(\d{3,4}). The
  // W604 anti-brittleness directive FORBIDS explicit-array family checks.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave-test files MUST exist (W735 itself +
  // siblings like W730/W731/W732/W733/W734). Threshold is forward-compat:
  // adding more wave tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 15) extractToolPatterns — clustering correctness sanity check
// =============================================================================

test('W735 #15 — extractToolPatterns clusters captures by tool name + computes share', () => {
  freshDir();
  const captures = [
    { corpus_namespace: 'ns1', tool_calls: [{ name: 'get_weather' }, { name: 'get_time' }] },
    { corpus_namespace: 'ns1', tool_calls: [{ name: 'get_weather' }] },
    { corpus_namespace: 'ns1', tool_calls: [{ name: 'send_email' }] },
    { corpus_namespace: 'ns2', tool_calls: [{ name: 'get_weather' }] }, // wrong ns — filtered out
    { corpus_namespace: 'ns1', tool_calls: [] },                          // no tools — counted but no bucket
    { corpus_namespace: 'ns1' },                                          // no tool_calls at all
  ];
  const out = extractToolPatterns(captures, { namespace: 'ns1', top_n: 5 });
  assert.equal(out.namespace, 'ns1');
  assert.equal(out.total_captures, 5, 'must count all ns1 captures (incl. zero-tool ones)');
  assert.equal(out.captures_with_tools, 3, 'must count only ns1 captures WITH tool_calls');
  assert.equal(out.unique_tool_count, 3, 'three distinct tool names: weather/time/email');
  // get_weather appears in 2 captures; share = 2/3 ≈ 0.667
  const weather = out.top.find((e) => e.name === 'get_weather');
  assert.ok(weather, 'get_weather must appear in top');
  assert.equal(weather.count, 2);
  assert.ok(Math.abs(weather.share - (2 / 3)) < 1e-9,
    `weather.share must be 2/3; got ${weather.share}`);
});

// =============================================================================
// 16) validateToolSchema — shape gating happy path + failure modes
// =============================================================================

test('W735 #16 — validateToolSchema accepts valid shape + rejects malformed shapes', () => {
  freshDir();
  const ok = validateToolSchema({
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  });
  assert.equal(ok.ok, true, `valid shape must return ok:true; got ${JSON.stringify(ok)}`);

  // Missing name.
  const noName = validateToolSchema({
    parameters: { type: 'object', properties: {} },
  });
  assert.equal(noName.ok, false);
  assert.ok(Array.isArray(noName.errors) && noName.errors.length > 0);

  // parameters.type !== 'object'.
  const badType = validateToolSchema({
    name: 'x',
    parameters: { type: 'string', properties: {} },
  });
  assert.equal(badType.ok, false);

  // Null / undefined / array — must return ok:false (never throw).
  for (const bad of [null, undefined, [], 'string']) {
    const o = validateToolSchema(bad);
    assert.equal(o.ok, false, `bad input ${JSON.stringify(bad)} must yield ok:false`);
  }
});
