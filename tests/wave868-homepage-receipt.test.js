// W868 - Homepage section dedup + receipt focal lock-in.
//
// Pins the W868 changes to public/index.html:
//   - Cut the .kolm-deep outcome cards (3rd redundant pipeline explanation)
//   - Reframed the "how it works" section to "The receipt is the proof."
//   - Added receipt artifact as focal element with .home-receipts CSS
//
// W604 anti-brittleness: family lock uses regex + numeric threshold (never
// an explicit hard-coded sibling list).
//
// Items pinned:
//   1) public/index.html exists and is non-trivial
//   2) "The receipt is the proof." h2 appears exactly once
//   3) .home-receipts CSS class is defined
//   4) .home-receipts row markup exists (the receipt table itself, not just CSS)
//   5) sw.js slug carries "wave868" token (regex, not explicit slug)
//   6) Family lock — at least one prior wave8xx test file exists

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = __dirname;
const INDEX_HTML = path.join(REPO_ROOT, 'public', 'index.html');
const SW_JS = path.join(REPO_ROOT, 'public', 'sw.js');

function readIndex() {
  return fs.readFileSync(INDEX_HTML, 'utf8');
}

// ----------------------------------------------------------------------------
// 1) Homepage exists and is non-trivial
// ----------------------------------------------------------------------------
test('W868 #1 - public/index.html exists and is non-trivial (>10 KB)', () => {
  assert.ok(fs.existsSync(INDEX_HTML), `${INDEX_HTML} must exist`);
  const stat = fs.statSync(INDEX_HTML);
  assert.ok(stat.size > 10_000,
    `index.html must be >10 KB (homepage isn't a stub); got ${stat.size} bytes`);
});

// ----------------------------------------------------------------------------
// 2) "The receipt is the proof." heading
// ----------------------------------------------------------------------------
test('W868 #2 - "The receipt is the proof." h2 appears exactly once', () => {
  const html = readIndex();
  const matches = html.match(/The receipt is the proof\./g) || [];
  assert.equal(matches.length, 1,
    `"The receipt is the proof." must appear exactly once; got ${matches.length}`);
  // And it must live inside an h2 (the section header for W868 receipt focal).
  assert.ok(/<h2[^>]*>\s*The receipt is the proof\./.test(html),
    `"The receipt is the proof." must be wrapped in an h2 element`);
});

// ----------------------------------------------------------------------------
// 3) .home-receipts CSS class defined
// ----------------------------------------------------------------------------
test('W868 #3 - .home-receipts CSS class is defined', () => {
  const html = readIndex();
  assert.ok(/\.home-receipts\s*\{/.test(html),
    `.home-receipts CSS class must be defined in <style>`);
  // Sub-classes that prove the receipt grid is real, not vestigial.
  for (const cls of ['home-receipts__row', 'home-receipts__name', 'home-receipts__size']) {
    assert.ok(new RegExp(`\\.${cls}\\b`).test(html),
      `.${cls} CSS class must be defined`);
  }
});

// ----------------------------------------------------------------------------
// 4) Receipt artifact actually rendered (not just CSS)
// ----------------------------------------------------------------------------
test('W868 #4 - receipt artifact markup is rendered in HTML body', () => {
  const html = readIndex();
  // W846 receipt block: a JSON receipt printed inline with kolm-receipt-strip
  // class, so devs see what `kolm verify` actually prints.
  assert.ok(/class="kolm-receipt-strip[^"]*"/.test(html),
    `homepage must render the .kolm-receipt-strip artifact (W846 receipt focal)`);
  // The receipt JSON must include the audit-trail keys callers rely on.
  // W911 (commit 4e9627da) deliberately rewrote the receipt from a flat schema
  // to the canonical nested artifact-spec shape: the old top-level "signed_by"
  // string became a structured "signature" object (algo/key/value). Pin the
  // current signing-proof key, not the retired literal.
  for (const key of ['artifact', 'hash', 'k_score', 'signature']) {
    assert.ok(new RegExp(`"${key}"`).test(html),
      `inline receipt must show the "${key}" key (proof of audit-trail content)`);
  }
});

// ----------------------------------------------------------------------------
// 5) sw.js slug carries wave868 token (regex, not explicit slug)
// ----------------------------------------------------------------------------
test('W868 #5 - sw.js CACHE slug carries wave868-or-later token', () => {
  const sw = fs.readFileSync(SW_JS, 'utf8');
  // W604/W829 anti-brittleness: scan all wave tokens, assert max >= 868.
  // The literal `wave868` slug long since rolled forward (W911, W917, ...),
  // so a hard-coded token pin is stale by design — use regex + threshold.
  const waves = [...sw.matchAll(/wave(\d{3,4})/g)].map((m) => parseInt(m[1], 10));
  assert.ok(waves.length > 0, 'sw.js must carry at least one wave token');
  const maxWave = Math.max(...waves);
  assert.ok(maxWave >= 868,
    `sw.js CACHE wave must reach >= 868 (saw max wave${maxWave})`);
});

// ----------------------------------------------------------------------------
// 6) Family lock (W604): regex + threshold, never explicit array.
// ----------------------------------------------------------------------------
test('W868 #6 - W604 family pattern: at least one prior wave8xx test file exists', () => {
  const re = /^wave(\d{3,4}).*\.test\.js$/;
  const files = fs.readdirSync(TESTS_DIR);
  const wave8xx = files.filter((f) => {
    const m = f.match(re);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 800 && n <= 999;
  });
  assert.ok(wave8xx.length >= 1,
    `expected at least 1 wave8xx test file (regex+threshold per W604); found ${wave8xx.length}`);
});
