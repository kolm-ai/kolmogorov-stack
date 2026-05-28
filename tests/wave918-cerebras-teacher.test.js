// W918 P1.20 - Cerebras teacher land-grab lock-in tests.
//
// Wave 1 Agent G structural lock-in. Sibling agents O and P are writing the
// Cerebras client module, teacher-bridge whitelist entries, bench script,
// landing page, recipe doc, and .env.example key. These six assertions pin
// the contract surface they must satisfy. Some may fail until all peer
// agents land their files; that is the expected coordination signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readUtf8(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

test('W918-P1.20.a src/teachers/cerebras.js module exists on disk', () => {
  const rel = 'src/teachers/cerebras.js';
  assert.ok(
    fs.existsSync(path.join(repoRoot, rel)),
    `expected Cerebras teacher module at ${rel} to exist`,
  );
});

test('W918-P1.20.b src/teachers/cerebras.js exports a chat() function', async () => {
  const mod = await import('../src/teachers/cerebras.js');
  assert.equal(
    typeof mod.chat,
    'function',
    'src/teachers/cerebras.js must export a chat function',
  );
});

test('W918-P1.20.c src/teacher-bridge.mjs whitelists all three Cerebras model slugs', () => {
  const src = readUtf8('src/teacher-bridge.mjs');
  assert.ok(
    src.includes('cerebras:llama-3.3-70b'),
    'src/teacher-bridge.mjs must whitelist "cerebras:llama-3.3-70b"',
  );
  assert.ok(
    src.includes('cerebras:llama3.1-8b'),
    'src/teacher-bridge.mjs must whitelist "cerebras:llama3.1-8b"',
  );
  assert.ok(
    src.includes('cerebras:qwen-3-32b'),
    'src/teacher-bridge.mjs must whitelist "cerebras:qwen-3-32b"',
  );
});

test('W918-P1.20.d scripts/cerebras-bench.mjs bench script exists on disk', () => {
  const rel = 'scripts/cerebras-bench.mjs';
  assert.ok(
    fs.existsSync(path.join(repoRoot, rel)),
    `expected Cerebras bench script at ${rel} to exist`,
  );
});

test('W918-P1.20.e Cerebras landing page and council-distill recipe doc exist', () => {
  const landing = 'public/cerebras-teacher.html';
  const recipe = 'docs/recipes/cerebras-council-distill.md';
  assert.ok(
    fs.existsSync(path.join(repoRoot, landing)),
    `expected Cerebras landing page at ${landing} to exist`,
  );
  assert.ok(
    fs.existsSync(path.join(repoRoot, recipe)),
    `expected Cerebras council-distill recipe doc at ${recipe} to exist`,
  );
});

test('W918-P1.20.f .env.example surfaces the CEREBRAS_API_KEY variable', () => {
  const src = readUtf8('.env.example');
  assert.ok(
    src.includes('CEREBRAS_API_KEY'),
    '.env.example must contain the CEREBRAS_API_KEY environment variable',
  );
});
