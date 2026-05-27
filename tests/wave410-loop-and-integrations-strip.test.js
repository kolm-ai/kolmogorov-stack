// W410 — additive homepage sections (loop + integrations grid) that surface
// the W409 capability set without touching the hero. User mandate: hero stays,
// add sections as you see fit, finish product 100% code-wise.
//
// Tests assert behavior (markers + outbound link targets), not exact copy, so
// future copy edits don't cascade-break the build (W211 lesson).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

test('W410 #1 - loop section is present after the W404 numbers strip', () => {
  const numIdx = INDEX.indexOf('data-w404="numbers-strip"');
  const loopIdx = INDEX.indexOf('data-w410="loop-strip"');
  assert.ok(numIdx > 0, 'W404 numbers strip must still be present');
  assert.ok(loopIdx > 0, 'W410 loop strip must be present');
  assert.ok(loopIdx > numIdx, 'loop strip must land below the numbers strip');
});

test('W410 #2 - loop section names all 8 canonical steps', () => {
  const STEPS = ['capture', 'opportunity', 'dataset', 'label', 'bakeoff', 'compile', 'verify', 'run'];
  for (const s of STEPS) {
    assert.match(INDEX, new RegExp(`data-w410-step=["']${s}["']`),
      `loop must include step "${s}"`);
  }
});

test('W410 #3 - each step links to the corresponding account / docs surface', () => {
  // Behavior: at minimum, the loop must link out to a public surface the
  // step describes so a reader can act on it without hitting the auth wall.
  // W902-C4 swapped /account/* targets for /docs/* (public) — keep accepting
  // either family so this lock doesn't break the next time the surfaces move.
  const REQUIRED = [
    '/captures',
    /\/(docs\/distill\.html|account\/opportunities)/,
    /\/(docs\/datasets\.html|account\/datasets)/,
    /\/(docs\/distillation\.html|account\/labeling)/,
    /\/(docs\/evals\.html|account\/bakeoffs)/,
    /\/(docs\/compile\/formats\.html|account\/builds)/,
    '/docs/verify',
    '/runtimes',
  ];
  // Scope: only the loop section body.
  const loopOpen = INDEX.indexOf('data-w410="loop-strip"');
  const loopClose = INDEX.indexOf('</section>', loopOpen);
  const body = INDEX.slice(loopOpen, loopClose);
  for (const href of REQUIRED) {
    if (href instanceof RegExp) {
      const matchRe = new RegExp(`href=["']${href.source}["']`);
      assert.match(body, matchRe, `loop must link to one of ${href.source}`);
    } else {
      assert.match(body, new RegExp(`href=["']${href.replace(/\//g, '\\/')}["']`),
        `loop must link to ${href}`);
    }
  }
});

test('W410 #4 - integrations grid is present after the loop section', () => {
  const loopIdx = INDEX.indexOf('data-w410="loop-strip"');
  const intIdx = INDEX.indexOf('data-w410="integrations-strip"');
  assert.ok(intIdx > 0, 'integrations strip must be present');
  assert.ok(intIdx > loopIdx, 'integrations must land below the loop');
});

test('W410 #5 - integrations grid links to all 9 W409z recipes', () => {
  const SLUGS = [
    'openai-sdk', 'anthropic-sdk', 'openrouter', 'langchain',
    'vercel-ai-sdk', 'litellm', 'cursor-claude-code',
    'docker-compose', 'env-vars',
  ];
  const intOpen = INDEX.indexOf('data-w410="integrations-strip"');
  const intClose = INDEX.indexOf('</section>', intOpen);
  const body = INDEX.slice(intOpen, intClose);
  for (const slug of SLUGS) {
    assert.match(body, new RegExp(`href=["']\\/integrations\\/${slug}["']`),
      `integrations grid must link to /integrations/${slug}`);
  }
});

test('W410 #6 - integrations grid foot links to the hub page', () => {
  const intOpen = INDEX.indexOf('data-w410="integrations-strip"');
  const intClose = INDEX.indexOf('</section>', intOpen);
  const body = INDEX.slice(intOpen, intClose);
  assert.match(body, /href=["']\/integrations["']/, 'integrations hub link must be present');
});

test('W410 #7 - sw.js wave-floor >= 410', () => {
  const m = SW.match(/const\s+CACHE\s*=\s*'kolm-v\d+-2026-\d{2}-\d{2}-[^']*?wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 410, 'CACHE wave >= 410 (got ' + m[1] + ')');
});

test('W410 #8 - hero is unchanged: H1, h1-claim, hero-quant, hero-artifact all preserved', () => {
  // Behavior: the user explicitly said "dont change the website hero". This
  // test is the alarm if a future wave silently mutates the H1 contract.
  const heroIdx = INDEX.search(/<h1[\s>]/i);
  assert.ok(heroIdx > 0, 'h1 present');
  const hero = INDEX.slice(heroIdx, heroIdx + 4000);
  assert.match(hero, /class=["'][^"']*\bh1-claim\b/, 'h1-claim span preserved');
  assert.match(hero, /class=["'][^"']*\bhero-quant\b/, 'hero-quant strip preserved');
  assert.match(hero, /class=["'][^"']*\bhero-artifact\b/, 'hero-artifact strip preserved');
  // W260 framing anchor + W220 category claim spans preserved.
  assert.match(INDEX, /data-w260=["']framing-anchor["']/, 'W260 framing anchor preserved');
  assert.match(INDEX, /data-w220=["']category-claim["']/, 'W220 category claim preserved');
});

test('W410 #9 - W205 em-dash budget on index.html still <= 1', () => {
  // The new sections were authored em-dash free; this is the W205 lock.
  const raw = (INDEX.match(/—/g) || []).length;
  const ent = (INDEX.match(/&mdash;/g) || []).length;
  assert.ok(raw + ent <= 1, `index.html em-dash count ${raw + ent} > budget 1`);
});

test('W410 #10 - W410 sections do not introduce emoji glyphs', () => {
  const loopOpen = INDEX.indexOf('data-w410="loop-strip"');
  const intClose = INDEX.indexOf('</section>', INDEX.indexOf('data-w410="integrations-strip"'));
  const body = INDEX.slice(loopOpen, intClose);
  // Emoji block ranges: 1F300-1F6FF, 1F900-1F9FF, 2600-27BF.
  const emoji = body.match(/[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}]/u);
  assert.ok(!emoji, 'W410 sections must be emoji-free');
});
