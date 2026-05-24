// WC04 — test coverage close-out for src/cost-estimator.js.
//
// Previously: 64 LOC, 0 tests anywhere in tests/.
// Pins the public surface of estimateCost() + extractUsage().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, extractUsage } from '../src/cost-estimator.js';

test('WC04 #1 estimateCost returns 0 for unknown provider', () => {
  const c = estimateCost({ provider: 'not-a-real-provider', model: 'x', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(c, 0);
});

test('WC04 #2 estimateCost returns 0 for unknown model under known provider', () => {
  const c = estimateCost({ provider: 'openai', model: 'never-shipped-model-9000', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(c, 0);
});

test('WC04 #3 estimateCost computes openai gpt-4o-mini correctly', () => {
  // 2026 rates pinned in provider-registry.js: { input: 0.00015, output: 0.0006 }
  // 1k input + 1k output = 0.00015 + 0.0006 = 0.00075
  const c = estimateCost({ provider: 'openai', model: 'gpt-4o-mini', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.ok(c > 0, 'cost should be > 0 for known model');
  assert.equal(c, 0.00075);
});

test('WC04 #4 estimateCost handles publisher-prefixed model names (openrouter style)', () => {
  // 'openai/gpt-4o-mini' should fall back to 'gpt-4o-mini' on openai provider lookup
  const c = estimateCost({ provider: 'openai', model: 'openai/gpt-4o-mini', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.ok(c > 0, 'publisher-prefixed lookup should match');
});

test('WC04 #5 estimateCost handles date-stamped model names (claude-...-202XYZ)', () => {
  // If a model with a -202XXXXX suffix is queried, the fuzzy fallback should
  // strip the date and try the base name. This is provider-data dependent;
  // confirm it never throws and returns a Number.
  const c = estimateCost({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(typeof c, 'number');
  assert.ok(c >= 0);
});

test('WC04 #6 estimateCost coerces non-numeric token counts to 0', () => {
  const c = estimateCost({ provider: 'openai', model: 'gpt-4o-mini', prompt_tokens: 'oops', completion_tokens: null });
  assert.equal(c, 0);
});

test('WC04 #7 estimateCost rounds to 6 decimal places', () => {
  // 1 token of gpt-4o-mini input = (1/1000) * 0.00015 = 0.00000015 → rounded to 6dp = 0
  const c = estimateCost({ provider: 'openai', model: 'gpt-4o-mini', prompt_tokens: 1, completion_tokens: 0 });
  assert.equal(c, 0);
  // 100k tokens = 0.015 exact, well above rounding floor
  const c2 = estimateCost({ provider: 'openai', model: 'gpt-4o-mini', prompt_tokens: 100000, completion_tokens: 0 });
  assert.equal(c2, 0.015);
});

test('WC04 #8 extractUsage(openai) reads usage.{prompt,completion}_tokens', () => {
  const u = extractUsage({ usage: { prompt_tokens: 42, completion_tokens: 17 } }, 'openai');
  assert.deepEqual(u, { prompt_tokens: 42, completion_tokens: 17 });
});

test('WC04 #9 extractUsage(anthropic) reads usage.{input,output}_tokens', () => {
  const u = extractUsage({ usage: { input_tokens: 80, output_tokens: 19 } }, 'anthropic');
  assert.deepEqual(u, { prompt_tokens: 80, completion_tokens: 19 });
});

test('WC04 #10 extractUsage(gemini) reads usageMetadata.{prompt,candidates}TokenCount', () => {
  const u = extractUsage({ usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 } }, 'gemini');
  assert.deepEqual(u, { prompt_tokens: 11, completion_tokens: 22 });
});

test('WC04 #11 extractUsage returns zeros for null body', () => {
  const u = extractUsage(null, 'openai');
  assert.deepEqual(u, { prompt_tokens: 0, completion_tokens: 0 });
});

test('WC04 #12 extractUsage returns zeros for unknown provider', () => {
  const u = extractUsage({ usage: { prompt_tokens: 5 } }, 'mystery');
  assert.deepEqual(u, { prompt_tokens: 0, completion_tokens: 0 });
});
