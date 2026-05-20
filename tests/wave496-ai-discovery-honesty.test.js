// Wave 496 - AI discovery files must describe the current product, not old
// bundle, recall, or symmetric-integrity language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W496 #1 - llms.txt documents the gateway to local artifact loop', () => {
  const text = read('public/llms.txt');
  for (const required of [
    'OpenAI-compatible gateway',
    'local event lake',
    'reviewed',
    'train and eval datasets',
    'signed `.kolm` artifact',
    'runtime target catalog',
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('W496 #2 - AI discovery files do not revive cut product claims', () => {
  const files = [
    ['public/llms.txt', read('public/llms.txt')],
    ['public/.well-known/ai-context.json', read('public/.well-known/ai-context.json')],
  ];

  const forbidden = [
    /\bHMAC\b/i,
    /\bkolm\s+bundle\b/i,
    /\bruntime bundle\b/i,
    /\bmodel\.gguf\b/i,
    /\blora\.bin\b/i,
    /\bPHI never leaves\b/i,
    /\bdata never moves\b/i,
    /https:\/\/kolm\.ai\/(?:anatomy|serve|recall)\b/i,
  ];

  const hits = [];
  for (const [name, text] of files) {
    for (const rx of forbidden) {
      if (rx.test(text)) hits.push(`${name} :: ${rx}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('W496 #3 - ai-context.json is a valid current discovery contract', () => {
  const ctx = JSON.parse(read('public/.well-known/ai-context.json'));
  assert.equal(ctx.primaryUrl, 'https://kolm.ai');
  assert.equal(ctx.fileFormat, '.kolm');
  assert.match(ctx.description, /OpenAI-compatible gateway/i);
  assert.match(ctx.description, /local event lake/i);
  assert.match(ctx.description, /Ed25519 receipt evidence/i);
  assert.ok(ctx.endpoints.artifacts);
  assert.ok(ctx.endpoints.datasets);
  assert.ok(ctx.endpoints.marketplace);
  assert.ok(ctx.endpoints.models);
  assert.equal(ctx.endpoints.recall, undefined);
  assert.match(ctx.concepts['kolm-artifact'], /runtime target metadata/i);
  assert.doesNotMatch(ctx.concepts['kolm-artifact'], /runtime bundle/i);
});
