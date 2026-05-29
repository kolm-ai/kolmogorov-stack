// Wave 559: generated CLI docs must not leak source metadata or mojibake.
//
// The CLI reference is generated from public/docs/cli/*.md. A regression in
// the minimal Markdown renderer rendered YAML frontmatter as visible body copy
// and reintroduced a corrupted separator in titles. This locks the generator
// to production-facing output instead of source-file artifacts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI_DIR = path.join(ROOT, 'public', 'docs', 'cli');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W559 #1 - generated CLI pages strip frontmatter and corrupted separators', () => {
  const pages = fs.readdirSync(CLI_DIR)
    .filter((name) => name.endsWith('.html'))
    .map((name) => ({ name, html: fs.readFileSync(path.join(CLI_DIR, name), 'utf8') }))
    .filter((page) => page.html.includes('data-w401f="cli-verb"'));

  assert.ok(pages.length >= 40, 'expected the generated CLI reference set');

  for (const { name, html } of pages) {
    assert.doesNotMatch(html, /<p>\s*---\s*title:/i, `${name} must not render YAML frontmatter`);
    assert.doesNotMatch(html, /\bdescription:\s+/i, `${name} must not render frontmatter fields as body copy`);
    assert.doesNotMatch(html, /繚/, `${name} must not expose corrupted title separators`);
    assert.doesNotMatch(html, /KOLM_NAV_BEGIN \(W221\) --><!-- KOLM_NAV_END \(W221\)/, `${name} must not emit an empty nav marker`);
    assert.match(html, /<title>kolm [^<]+ \| CLI reference \| kolm\.ai<\/title>/, `${name} title must use the canonical CLI title shape`);
    assert.match(html, /<a class="nav-top" href="\/about"/, `${name} must emit the canonical nav block`);
    assert.match(html, /<h1>kolm /, `${name} must keep the command H1`);
  }
});

test('W559 #2 - generated CLI renderer preserves user-facing Markdown structure', () => {
  const capture = read('public/docs/cli/capture.html');

  assert.match(capture, /<blockquote><p>Drop-in proxy for OpenAI, Anthropic, and OpenRouter\./);
  assert.match(capture, /<div class="table-wrap"><table>/);
  assert.match(capture, /<th>Flag<\/th>/);
  assert.match(capture, /<td><code>--provider &lt;p&gt;<\/code><\/td>/);
  assert.doesNotMatch(capture, /<p>\| Flag \| Default \| Description \|/);
});
