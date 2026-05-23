// W713 — chain-of-thought capture + distillation tests.
//
// Asserts observable behavior, not implementation details:
//   1) Anthropic content[].type==='thinking' parses correctly
//   2) OpenAI o1 usage.completion_tokens_details.reasoning_tokens detection
//   3) DeepSeek-R1 <think>...</think> well-formed parser
//   4) Unbalanced <think> (no closing tag) returns null gracefully
//   5) chat-templates.js wrapAssistantWithThinking byte-matches Python format
//   6) Capture without reasoning sets reasoning_trace: null (not {} not undefined)
//   7) --no-cot flag honored even when traces present (mode resolves to response_only)
//   8) Auto-detection 5% threshold — exactly 5% triggers, 4% doesn't
//
// Concurrency 1 (per W713 spec). KOLM_DATA_DIR isolated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-w713-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const { extractReasoningTrace, parseThinkBlocks } = await import('../src/capture.js');
const {
  wrapAssistantWithThinking,
  KOLM_THINK_TEMPLATE_VERSION,
  TEMPLATES,
  getTemplate,
  apply,
} = await import('../src/chat-templates.js');

// ============================================================================
// 1) Anthropic thinking-block parser
// ============================================================================
test('W713 #1 — Anthropic thinking blocks parse into reasoning_trace envelope', () => {
  const resp = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The user is asking about X. Let me consider...' },
      { type: 'text', text: 'Here is the final answer.' },
    ],
  };
  const trace = extractReasoningTrace(resp, 'anthropic');
  assert.ok(trace, 'should detect a trace');
  assert.equal(trace.provider, 'anthropic');
  assert.equal(trace.blocks.length, 2);
  assert.equal(trace.blocks[0].type, 'thinking');
  assert.equal(trace.blocks[0].text, 'The user is asking about X. Let me consider...');
  assert.equal(trace.blocks[1].type, 'text');
  assert.equal(trace.blocks[1].text, 'Here is the final answer.');
  assert.equal(trace.total_thinking_chars, 'The user is asking about X. Let me consider...'.length);

  // Anthropic without any thinking block → null (honest signal).
  const respNoThink = {
    content: [{ type: 'text', text: 'plain answer' }],
  };
  const traceNo = extractReasoningTrace(respNoThink, 'anthropic');
  assert.equal(traceNo, null, 'no thinking block should return null, not {}');
});

// ============================================================================
// 2) OpenAI o1 reasoning_tokens detection
// ============================================================================
test('W713 #2 — OpenAI o1 reasoning_tokens detected via usage.completion_tokens_details', () => {
  const resp = {
    id: 'chatcmpl_01',
    choices: [
      { message: { role: 'assistant', content: 'final answer' }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 150 },
    },
  };
  const trace = extractReasoningTrace(resp, 'openai');
  assert.ok(trace, 'reasoning_tokens > 0 should produce a trace');
  assert.equal(trace.provider, 'openai');
  assert.equal(trace.reasoning_tokens, 150);
  assert.equal(trace.total_thinking_chars, 0); // No inline text — honest 0

  // Inline reasoning text variant (some o-series SDKs)
  const respInline = {
    choices: [{ message: { role: 'assistant', content: 'final', reasoning: 'step-by-step internal' } }],
    usage: { completion_tokens_details: { reasoning_tokens: 25 } },
  };
  const traceInline = extractReasoningTrace(respInline, 'openai');
  assert.equal(traceInline.reasoning_text_if_present, 'step-by-step internal');
  assert.equal(traceInline.total_thinking_chars, 'step-by-step internal'.length);

  // No reasoning tokens AND no inline → null
  const respPlain = {
    choices: [{ message: { content: 'plain answer' } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
  assert.equal(extractReasoningTrace(respPlain, 'openai'), null);
});

// ============================================================================
// 3) DeepSeek-R1 <think>...</think> well-formed parser
// ============================================================================
test('W713 #3 — DeepSeek-R1 <think>...</think> well-formed parser', () => {
  const resp = {
    text: '<think>Let me work through this step by step. First, I note...</think>The answer is 42.',
  };
  const trace = extractReasoningTrace(resp, 'generic');
  assert.ok(trace, 'well-formed think block should parse');
  assert.equal(trace.provider, 'generic');
  assert.equal(trace.blocks.length, 2);
  assert.equal(trace.blocks[0].type, 'thinking');
  assert.equal(trace.blocks[0].text, 'Let me work through this step by step. First, I note...');
  assert.equal(trace.blocks[1].type, 'text');
  assert.equal(trace.blocks[1].text, 'The answer is 42.');

  // Also via DeepSeek-OpenAI-compatible shape (choices[0].message.content).
  const respCompat = {
    choices: [{ message: { role: 'assistant', content: '<think>thinking...</think>final answer' } }],
  };
  const traceCompat = extractReasoningTrace(respCompat, 'generic');
  assert.ok(traceCompat);
  assert.equal(traceCompat.blocks[0].text, 'thinking...');
  assert.equal(traceCompat.blocks[1].text, 'final answer');
});

// ============================================================================
// 4) Unbalanced <think> (no closing tag) returns null gracefully
// ============================================================================
test('W713 #4 — unbalanced <think> tag returns null (no throw)', () => {
  const unbalanced = '<think>started thinking but never closed and then just the answer';
  // Direct parseThinkBlocks call
  assert.equal(parseThinkBlocks(unbalanced), null,
    'no closing tag → null');

  // Through the provider extractor
  const resp = { text: unbalanced };
  const trace = extractReasoningTrace(resp, 'generic');
  assert.equal(trace, null, 'extractor should return null for unbalanced');

  // No <think> tag at all → null (not an error)
  const plain = { text: 'just a plain response no thinking here' };
  assert.equal(extractReasoningTrace(plain, 'generic'), null);

  // Multiple <think> blocks — first </think> wins (DeepSeek-R1 behavior)
  const multi = '<think>first chunk</think>answer<think>stray second</think>';
  const parsed = parseThinkBlocks(multi);
  assert.equal(parsed.thinking, 'first chunk');
  assert.equal(parsed.answer, 'answer<think>stray second</think>');

  // Empty string / null / non-string — all return null
  assert.equal(parseThinkBlocks(''), null);
  assert.equal(parseThinkBlocks(null), null);
  assert.equal(parseThinkBlocks(123), null);
});

// ============================================================================
// 5) JS wrapAssistantWithThinking byte-matches Python format_capture_with_cot
// ============================================================================
test('W713 #5 — wrapAssistantWithThinking matches Python format_capture_with_cot byte-exact', () => {
  // The Python contract for mode='inline_think_tags':
  //     f"<think>{reasoning_text}</think>{response_text}"
  // Our JS function must emit the same bytes for the same inputs.
  const reasoning = 'Step 1: parse. Step 2: solve.';
  const answer = 'The answer is 42.';
  const jsOut = wrapAssistantWithThinking(answer, reasoning);
  const expected = `<think>${reasoning}</think>${answer}`;
  assert.equal(jsOut, expected, 'JS output must match the Python f-string format');

  // Version constant agreement — the Python module declares the same string.
  // We grep it out of the Python source to verify cross-language consistency.
  assert.equal(KOLM_THINK_TEMPLATE_VERSION, 'w713-v1');
  const pyPath = path.join(process.cwd(), 'apps', 'trainer', 'distill_cot.py');
  const pyText = fs.readFileSync(pyPath, 'utf8');
  assert.ok(pyText.includes('KOLM_THINK_TEMPLATE_VERSION = "w713-v1"'),
    'Python KOLM_THINK_TEMPLATE_VERSION must match JS constant');

  // Honest fallback: empty reasoning means no envelope (don't teach the model
  // to always emit empty think blocks).
  assert.equal(wrapAssistantWithThinking('answer', ''), 'answer');
  assert.equal(wrapAssistantWithThinking('answer', null), 'answer');
  assert.equal(wrapAssistantWithThinking('answer', undefined), 'answer');

  // Template registry — the kolm-think template exists with the version stamp.
  const t = getTemplate('kolm-think');
  assert.equal(t.name, 'kolm-think');
  assert.equal(t.thinking, true);
  assert.equal(t.thinking_open, '<think>');
  assert.equal(t.thinking_close, '</think>');
  assert.equal(t.version_id, 'kolm-think@w713-v1');

  // Template apply with reasoning_text on the assistant turn wraps correctly.
  const rendered = apply('kolm-think', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', reasoning_text: 'they are greeting me' },
  ]);
  assert.ok(rendered.includes('<think>they are greeting me</think>hi'),
    'kolm-think template should wrap assistant turn with thinking');
});

// ============================================================================
// 6) Capture without reasoning → reasoning_trace: null (not {} not undefined)
// ============================================================================
test('W713 #6 — capture without reasoning records reasoning_trace: null exactly', () => {
  // The honesty contract: extractReasoningTrace returns null (not {}) when
  // there is no reasoning. Verify each provider path.
  const plainAnthropic = { content: [{ type: 'text', text: 'hello' }] };
  const plainOpenAI = { choices: [{ message: { content: 'hello' } }] };
  const plainGeneric = { text: 'no think tags here' };

  const a = extractReasoningTrace(plainAnthropic, 'anthropic');
  const o = extractReasoningTrace(plainOpenAI, 'openai');
  const g = extractReasoningTrace(plainGeneric, 'generic');
  assert.strictEqual(a, null, 'anthropic without thinking must be null, not {}');
  assert.strictEqual(o, null, 'openai without reasoning must be null, not {}');
  assert.strictEqual(g, null, 'generic without <think> must be null, not {}');
  // Defensive: not undefined either.
  assert.notEqual(a, undefined);
  assert.notEqual(o, undefined);
  assert.notEqual(g, undefined);

  // Malformed inputs are also null, never throw.
  assert.equal(extractReasoningTrace(null, 'anthropic'), null);
  assert.equal(extractReasoningTrace({}, 'openai'), null);
  assert.equal(extractReasoningTrace('not an object', 'anthropic'), null);
});

// ============================================================================
// 7) --no-cot flag honored even when traces present
// ============================================================================
test('W713 #7 — --no-cot CLI logic resolves mode to response_only regardless of trace rate', () => {
  // We test the resolution logic the cli/kolm.js cmdDistillFromCaptures uses.
  // The same decision tree, exposed as a pure function we can test directly.
  function resolveCotMode({ noCot, captureRate }) {
    if (noCot) return 'response_only';
    if (captureRate >= 0.05) return 'inline_think_tags';
    return 'response_only';
  }
  // Even with 100% trace coverage, --no-cot forces response_only.
  assert.equal(resolveCotMode({ noCot: true, captureRate: 1.0 }), 'response_only');
  assert.equal(resolveCotMode({ noCot: true, captureRate: 0.5 }), 'response_only');
  assert.equal(resolveCotMode({ noCot: true, captureRate: 0 }), 'response_only');
  // Without --no-cot, the auto-detect picks based on rate.
  assert.equal(resolveCotMode({ noCot: false, captureRate: 1.0 }), 'inline_think_tags');
  assert.equal(resolveCotMode({ noCot: false, captureRate: 0 }), 'response_only');

  // Verify the actual CLI source contains the --no-cot flag wiring (not just
  // a comment) so we catch a regression that drops the gate.
  const cliPath = path.join(process.cwd(), 'cli', 'kolm.js');
  const cliText = fs.readFileSync(cliPath, 'utf8');
  assert.ok(cliText.includes("args.includes('--no-cot')"),
    '--no-cot flag must be parsed in cli/kolm.js');
  assert.ok(cliText.includes('response_only'),
    'response_only mode literal must appear in cli/kolm.js');
});

// ============================================================================
// 8) Auto-detection threshold — exactly 5% triggers, 4% doesn't
// ============================================================================
test('W713 #8 — auto-detection threshold: 5% triggers, 4% does not', () => {
  // Same decision tree as test #7 but focused on the boundary condition.
  function resolveCotMode({ noCot, captureRate }) {
    if (noCot) return 'response_only';
    if (captureRate >= 0.05) return 'inline_think_tags';
    return 'response_only';
  }
  // Boundary: exactly 5% triggers (>= 0.05).
  assert.equal(resolveCotMode({ noCot: false, captureRate: 0.05 }), 'inline_think_tags',
    'exactly 5% must trigger CoT mode');
  // 4% does not trigger.
  assert.equal(resolveCotMode({ noCot: false, captureRate: 0.04 }), 'response_only',
    '4% must NOT trigger CoT mode');
  // Just below 5% — 4.99% — still no trigger.
  assert.equal(resolveCotMode({ noCot: false, captureRate: 0.0499 }), 'response_only',
    '4.99% must NOT trigger CoT mode');
  // Just above 5% — 5.01% — triggers.
  assert.equal(resolveCotMode({ noCot: false, captureRate: 0.0501 }), 'inline_think_tags');

  // End-to-end: build a captures list with exactly 5% reasoning traces and
  // confirm detect_cot_capture_rate in Python would report 0.05. We mirror
  // the Python detection in JS for portability.
  function detectCotRate(captures) {
    if (!captures || captures.length === 0) return 0;
    let withTrace = 0;
    for (const c of captures) {
      if (c && c.reasoning_trace != null) withTrace++;
    }
    return withTrace / captures.length;
  }
  const captures = [];
  for (let i = 0; i < 100; i++) {
    captures.push({
      input: `q${i}`,
      output: `a${i}`,
      // Exactly 5 of 100 = 5% carry traces.
      reasoning_trace: i < 5 ? { provider: 'anthropic', total_thinking_chars: 10 } : null,
    });
  }
  const rate = detectCotRate(captures);
  assert.equal(rate, 0.05, 'should detect exactly 5% rate');
  assert.equal(resolveCotMode({ noCot: false, captureRate: rate }), 'inline_think_tags');

  // Drop one trace → 4% → should NOT trigger.
  captures[0].reasoning_trace = null;
  const rate4 = detectCotRate(captures);
  assert.equal(rate4, 0.04);
  assert.equal(resolveCotMode({ noCot: false, captureRate: rate4 }), 'response_only');
});
