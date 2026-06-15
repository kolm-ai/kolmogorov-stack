// AUTH/COMPILER (Path to 100%) — fal-ai/any-llm as the Claude teacher.
//
// synthesis.js now does real LLM-authored synthesis on a FAL_KEY alone (fal
// serves Claude via fal-ai/any-llm), not just a direct ANTHROPIC_API_KEY. fal's
// responses are chattier — they wrap the function in prose — so extractGenerator
// balance-matches the `function generate(){...}` and drops the surrounding text.
// This pins that extraction (the live fal round-trip is verified separately).

import { test } from 'node:test';
import assert from 'node:assert';
import { extractGenerator } from '../src/synthesis.js';

test('fal teacher: extracts the function from a prose-wrapped response', () => {
  const raw = 'Here is the function that classifies the logs:\n\nfunction generate(input, lib) {\n  return input.startsWith("ERROR");\n}\n\nThis handles all the positive cases.';
  const src = extractGenerator(raw);
  assert.ok(src.startsWith('function generate'), 'starts at the function');
  assert.ok(src.trim().endsWith('}'), 'ends at the matching brace, no trailing prose');
  assert.ok(!/Here is|This handles/.test(src), 'prose stripped');
  // It parses as valid JS.
  assert.doesNotThrow(() => new Function('return (' + src + ')')());
});

test('fal teacher: handles markdown fences', () => {
  const src = extractGenerator('```js\nfunction generate(i, lib) { return i.length; }\n```');
  assert.ok(src.startsWith('function generate') && src.endsWith('}'));
});

test('fal teacher: balances nested braces', () => {
  const raw = 'function generate(input, lib) {\n  if (input) { return { ok: true }; }\n  return { ok: false };\n}\nNote: done.';
  const src = extractGenerator(raw);
  assert.ok(src.endsWith('}\n}') || src.endsWith('}'), 'matches the outer brace');
  assert.ok(!/Note:/.test(src), 'trailing note dropped');
  assert.doesNotThrow(() => new Function('return (' + src + ')')());
});

test('fal teacher: no function present returns the cleaned text', () => {
  assert.strictEqual(extractGenerator('```\njust some text\n```').trim(), 'just some text');
});
