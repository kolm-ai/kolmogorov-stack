// Wave 550 - legacy capture helpers know OpenRouter is OpenAI-compatible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCompletionText,
  extractPromptForCapture,
  modelFromBody,
  pickOpenRouterUpstream,
} from '../src/capture.js';

test('W550 #2 - capture helper treats OpenRouter chat payloads as OpenAI-compatible', () => {
  const body = {
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'system', content: 'classify logs' },
      { role: 'user', content: [{ type: 'text', text: 'error: disk full' }] },
    ],
  };
  assert.match(extractPromptForCapture(body, 'openrouter'), /system: classify logs/);
  assert.match(extractPromptForCapture(body, 'openrouter'), /user: error: disk full/);
  assert.equal(modelFromBody(body, 'openrouter'), 'openai/gpt-4o-mini');
  assert.equal(
    extractCompletionText({ choices: [{ message: { content: 'ticket_required' } }] }, 'openrouter'),
    'ticket_required',
  );
});

test('W550 #3 - OpenRouter upstream helper defaults to official API path and honors env override', () => {
  const old = process.env.OPENROUTER_UPSTREAM_URL;
  try {
    delete process.env.OPENROUTER_UPSTREAM_URL;
    assert.equal(pickOpenRouterUpstream(), 'https://openrouter.ai/api/v1/chat/completions');
    process.env.OPENROUTER_UPSTREAM_URL = 'http://127.0.0.1:9999/custom';
    assert.equal(pickOpenRouterUpstream(), 'http://127.0.0.1:9999/custom');
  } finally {
    if (old == null) delete process.env.OPENROUTER_UPSTREAM_URL;
    else process.env.OPENROUTER_UPSTREAM_URL = old;
  }
});
