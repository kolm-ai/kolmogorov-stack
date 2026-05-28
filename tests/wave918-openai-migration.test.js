// W918 P1.10 - OpenAI fine-tuning migration lock-in tests.
//
// Wave 1 Agent G structural lock-in. Sibling agents A/B/C/D/F are writing the
// underlying artifacts (importer module, migration page, blog post, compare
// row, index banner, vercel rewrite). These six assertions pin the contract
// surface they must satisfy. Some may fail until all peer agents land their
// files; that is the expected coordination signal.

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

test('W918-P1.10.a vercel.json rewrites /openai-migration to /openai-migration.html', () => {
  const cfg = JSON.parse(readUtf8('vercel.json'));
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const hit = rewrites.find(
    (r) => r && r.source === '/openai-migration' && r.destination === '/openai-migration.html',
  );
  assert.ok(
    hit,
    'vercel.json rewrites array must contain { source: "/openai-migration", destination: "/openai-migration.html" }',
  );
});

test('W918-P1.10.b blog post 2026-05-28-openai-finetuning-shutdown.html exists and is dated', () => {
  const rel = 'public/blog/2026-05-28-openai-finetuning-shutdown.html';
  assert.ok(
    fs.existsSync(path.join(repoRoot, rel)),
    `expected blog post at ${rel} to exist`,
  );
  const src = readUtf8(rel);
  assert.ok(src.includes('OpenAI'), `${rel} must mention "OpenAI" literally`);
  assert.ok(src.includes('2026-05-28'), `${rel} must carry the dated literal "2026-05-28"`);
});

test('W918-P1.10.c compare.html lists the OpenAI fine-tuning row with shutdown date', () => {
  const src = readUtf8('public/compare.html');
  assert.ok(
    src.includes('OpenAI fine-tuning'),
    'public/compare.html must contain the literal "OpenAI fine-tuning"',
  );
  assert.ok(
    src.includes('Jan 2027'),
    'public/compare.html must call out the "Jan 2027" shutdown date',
  );
});

test('W918-P1.10.d index.html shows the OpenAI migration banner with link', () => {
  const src = readUtf8('public/index.html');
  assert.ok(
    src.includes('OpenAI is closing fine-tuning'),
    'public/index.html must contain the migration banner copy "OpenAI is closing fine-tuning"',
  );
  assert.ok(
    src.includes('/openai-migration'),
    'public/index.html must link to /openai-migration from the banner',
  );
});

test('W918-P1.10.e src/importers/openai-finetune.js exports parse and parseFile functions', async () => {
  const mod = await import('../src/importers/openai-finetune.js');
  assert.equal(
    typeof mod.parse,
    'function',
    'src/importers/openai-finetune.js must export a parse function',
  );
  assert.equal(
    typeof mod.parseFile,
    'function',
    'src/importers/openai-finetune.js must export a parseFile function',
  );
});

test('W918-P1.10.f openai-migration.html exists with og:title, title, and canonical', () => {
  const rel = 'public/openai-migration.html';
  assert.ok(
    fs.existsSync(path.join(repoRoot, rel)),
    `expected landing page at ${rel} to exist`,
  );
  const src = readUtf8(rel);
  assert.ok(src.includes('og:title'), `${rel} must declare an og:title meta tag`);
  assert.ok(src.includes('<title>'), `${rel} must declare a <title> element`);
  assert.ok(
    src.includes('/openai-migration'),
    `${rel} must declare a canonical link pointing at /openai-migration`,
  );
});
