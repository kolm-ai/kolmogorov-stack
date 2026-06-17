import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const OVERVIEW = readFileSync(path.join(REPO, 'public', 'account', 'overview.html'), 'utf8');

test('C12 account overview key input keeps valid ASCII HTML attributes', () => {
  assert.match(
    OVERVIEW,
    /<input id="keyInput"[^>]*placeholder="ks_\.\.\."[^>]*autocomplete="off"[^>]*aria-describedby="keyHelp">/,
  );
  assert.doesNotMatch(OVERVIEW, /placeholder="ks_\u2026"/);
});

test('C12 account overview loading banner is well-formed in static and JS paths', () => {
  assert.match(OVERVIEW, /<div id="content"><div class="banner">Loading your workspace\.\.\.<\/div><\/div>/);
  assert.match(
    OVERVIEW,
    /content'\)\.innerHTML = '<div class="banner">Loading your workspace\.\.\.<\/div>';/,
  );
  assert.doesNotMatch(OVERVIEW, /Loading your workspace\u2026/);
  assert.doesNotMatch(OVERVIEW, /Loading your workspace\?\?\/div>/);
});

test('C12 account overview remains wired to live workspace data and proof surfaces', () => {
  assert.match(OVERVIEW, /fetch\('\/v1\/account\/compiler-overview'/);
  assert.match(OVERVIEW, /\/v1\/product\/graph/);
  assert.match(OVERVIEW, /\/product-readiness-closeout\.json/);
  assert.match(OVERVIEW, /\/v1\/receipts\/verify/);
  assert.match(OVERVIEW, /Evidence archive/);
});

test('C12 account overview has no non-ASCII UI bytes', () => {
  for (let i = 0; i < OVERVIEW.length; i++) {
    const code = OVERVIEW.charCodeAt(i);
    assert.ok(code <= 0x7f, 'non-ASCII char at offset ' + i + ' U+' + code.toString(16).toUpperCase());
  }
});
