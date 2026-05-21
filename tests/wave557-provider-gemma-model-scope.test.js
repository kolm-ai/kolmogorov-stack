// @public-routes-only
// Wave 557 - close the "lost scope" gaps called out after W556:
// Gemma provenance, Gemini/OpenRouter as first-class OpenAI-compatible
// provider choices, and model recommendation API coverage for post-auth UX.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { handleChatCompletion, handleListModels } from '../src/completions-api.js';
import { buildRouter } from '../src/router.js';

test('W557 #1 - hosted completion wrapper supports OpenRouter and Gemini provider prefixes', async () => {
  const oldFetch = globalThis.fetch;
  const oldOpenRouter = process.env.OPENROUTER_API_KEY;
  const oldOpenRouterBase = process.env.OPENROUTER_BASE_URL;
  const oldGemini = process.env.GEMINI_API_KEY;
  const oldGeminiBase = process.env.GEMINI_OPENAI_BASE_URL;
  const calls = [];

  process.env.OPENROUTER_API_KEY = 'or_test_key';
  process.env.OPENROUTER_BASE_URL = 'https://openrouter.test/api/v1';
  process.env.GEMINI_API_KEY = 'gm_test_key';
  process.env.GEMINI_OPENAI_BASE_URL = 'https://gemini.test/v1beta/openai';

  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), auth: init.headers.authorization, body });
    return new Response(JSON.stringify({
      id: 'cmpl_provider',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: `${body.model} ok` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const openrouter = await handleChatCompletion({
      model: 'openrouter:anthropic/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(openrouter.upstream.vendor, 'openrouter');
    assert.equal(openrouter.upstream.model, 'anthropic/claude-sonnet-4-6');
    assert.equal(openrouter.model, 'openrouter:anthropic/claude-sonnet-4-6');

    const gemini = await handleChatCompletion({
      model: 'gemini:gemini-2.5-flash',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(gemini.upstream.vendor, 'gemini');
    assert.equal(gemini.upstream.model, 'gemini-2.5-flash');
    assert.equal(gemini.model, 'gemini:gemini-2.5-flash');

    assert.deepEqual(calls.map((c) => c.url), [
      'https://openrouter.test/api/v1/chat/completions',
      'https://gemini.test/v1beta/openai/chat/completions',
    ]);
    assert.deepEqual(calls.map((c) => c.auth), ['Bearer or_test_key', 'Bearer gm_test_key']);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldOpenRouter == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldOpenRouter;
    if (oldOpenRouterBase == null) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = oldOpenRouterBase;
    if (oldGemini == null) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
    if (oldGeminiBase == null) delete process.env.GEMINI_OPENAI_BASE_URL; else process.env.GEMINI_OPENAI_BASE_URL = oldGeminiBase;
  }
});

test('W557 #2 - model discovery advertises OpenAI, Claude, OpenRouter, and Gemini choices', async () => {
  const out = await handleListModels();
  const ids = new Set(out.data.map((row) => row.id));
  for (const id of [
    'openai:gpt-5',
    'anthropic:claude-sonnet-4-6',
    'openrouter:anthropic/claude-sonnet-4-6',
    'openrouter:google/gemini-2.5-flash',
    'gemini:gemini-2.5-flash',
    'gemini:gemini-2.5-pro',
  ]) {
    assert.ok(ids.has(id), `missing provider model ${id}`);
  }
});

test('W557 #3 - Gemma catalog carries official on-device and medical context metadata', async () => {
  const M = await import('../src/models.js');
  const e2b = M.info('google/gemma-3n-E2B-it');
  const e4b = M.info('google/gemma-3n-E4B-it');
  const med = M.info('google/medgemma-4b-it');
  const emb = M.info('google/embeddinggemma-300m');
  assert.equal(e2b.context_tokens, 32768);
  assert.equal(e4b.context_tokens, 32768);
  assert.deepEqual(e2b.modalities, ['text', 'image', 'audio', 'video']);
  assert.ok(e2b.architecture_features.includes('PLE caching'));
  assert.match(e4b.official_source_url, /gemma-3n/);
  assert.equal(med.context_tokens, 131072);
  assert.equal(med.output_tokens, 8192);
  assert.match(med.official_source_url, /medgemma\/model-card/);
  assert.match(emb.official_source_url, /embeddinggemma/);
});

test('W557 #4 - public model recommendation API backs the account model picker', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const { port } = server.address();

  const rec = await fetch(`http://127.0.0.1:${port}/v1/models/recommend?use=mobile&device=iphone-15-pro`);
  assert.equal(rec.status, 200);
  const recBody = await rec.json();
  assert.equal(recBody.ok, true);
  assert.ok(
    recBody.recommendation.pick === 'google/gemma-3n-E2B-it' || recBody.recommendation.pick === 'google/gemma-3n-E4B-it',
    `expected Gemma 3n for phone, got ${recBody.recommendation.pick}`,
  );

  const info = await fetch(`http://127.0.0.1:${port}/v1/models/info/google/gemma-3n-E2B-it`);
  assert.equal(info.status, 200);
  const infoBody = await info.json();
  assert.equal(infoBody.ok, true);
  assert.equal(infoBody.model.id, 'google/gemma-3n-E2B-it');
  assert.deepEqual(infoBody.model.modalities, ['text', 'image', 'audio', 'video']);
});
