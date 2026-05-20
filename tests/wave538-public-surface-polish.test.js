// Wave 538 - public surface finish lock-ins.
//
// These assertions catch the production-copy failures that make the site feel
// unfinished even when routes and tests pass: mojibake separators, visible
// "not wired" language, and SEO pages without core metadata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.md',
  '.json',
  '.txt',
  '.js',
  '.css',
  '.svg',
  '.webmanifest',
]);

const PUBLIC_COPY_ANTI_PATTERNS = [
  /not yet wired/i,
  /not implemented/i,
  /stub covers/i,
  /coming soon/i,
  /under construction/i,
  /lorem ipsum/i,
  /not ready/i,
  /unimplemented/i,
  /not wired/i,
  /not shipped/i,
  /not active/i,
  /docs pending/i,
  /undocumented route/i,
  /inline docs pending/i,
  /documentation is still pending/i,
  /current stage/i,
  /not planned/i,
  /no hosted endpoint/i,
  /disabled until/i,
];

function walkFiles(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['tmp', 'tmp-screenshots', 'node_modules', '.git'].includes(entry.name)) {
        walkFiles(file, predicate, out);
      }
    } else if (!predicate || predicate(file)) {
      out.push(file);
    }
  }
  return out;
}

function read(relOrAbs) {
  return fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8');
}

function publicTextFiles() {
  return walkFiles(PUBLIC, (file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function publicHtmlFiles() {
  return walkFiles(PUBLIC, (file) => path.extname(file).toLowerCase() === '.html');
}

test('W538 #1 - public text has no mojibake or replacement glyphs', () => {
  for (const file of publicTextFiles()) {
    const rel = path.relative(ROOT, file);
    const text = read(file);
    assert.doesNotMatch(text, /\u7e5a/, `${rel} must not contain the old mojibake separator`);
    assert.doesNotMatch(text, /\ufffd/, `${rel} must not contain Unicode replacement glyphs`);
  }
});

test('W538 #2 - public pages avoid unfinished product-language markers', () => {
  for (const file of publicTextFiles()) {
    const rel = path.relative(ROOT, file);
    const text = read(file);
    for (const pattern of PUBLIC_COPY_ANTI_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${rel} exposes rough copy: ${pattern}`);
    }
  }
});

test('W538 #3 - every public HTML page has crawlable title and description', () => {
  for (const file of publicHtmlFiles()) {
    const rel = path.relative(ROOT, file);
    const text = read(file);
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || '';
    const description = text.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1]?.trim() || '';

    assert.ok(title, `${rel} needs a title`);
    assert.ok(description, `${rel} needs a meta description`);
    assert.ok(title.length >= 12, `${rel} title is too short: ${title}`);
    assert.ok(title.length <= 78, `${rel} title is too long: ${title.length}`);
    assert.ok(description.length >= 50, `${rel} description is too short`);
    assert.ok(description.length <= 220, `${rel} description is too long: ${description.length}`);
  }
});

test('W538 #4 - core growth pages expose one clear h1', () => {
  for (const rel of [
    'public/index.html',
    'public/capture.html',
    'public/distill.html',
    'public/compile.html',
    'public/pricing.html',
    'public/docs.html',
    'public/account/overview.html',
  ]) {
    const text = read(rel);
    const count = [...text.matchAll(/<h1\b/gi)].length;
    assert.equal(count, 1, `${rel} should expose exactly one h1`);
  }
});

test('W538 #5 - site-wide finish layer remains loaded on core pages', () => {
  for (const rel of [
    'public/index.html',
    'public/capture.html',
    'public/distill.html',
    'public/compile.html',
    'public/pricing.html',
    'public/docs.html',
  ]) {
    assert.match(read(rel), /href="\/surface-polish\.css"/, `${rel} must load surface-polish.css`);
  }
});

test('W538 #6 - pages with main landmarks expose a working skip link', () => {
  for (const file of publicHtmlFiles()) {
    const rel = path.relative(ROOT, file);
    const text = read(file);
    const mainId = text.match(/<main\b[^>]*\bid=(['"])([^'"]+)\1/i)?.[2];
    if (!mainId) continue;
    assert.match(text, new RegExp(`href=(['"])#${mainId}\\1`, 'i'), `${rel} needs a skip link to #${mainId}`);
  }
});
