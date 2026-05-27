// W888-S lock-in: meta-demo callout on homepage + /about-the-assistant
// standalone page + reusable assistant-widget.js.
//
// These tests pin the surfaces that prove the assistant answering the site
// is itself a kolm artifact. If any of these silently disappear the wave
// gets reverted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO = path.join(__dirname, '..');
const PUBLIC = path.join(REPO, 'public');
const HOME = path.join(PUBLIC, 'index.html');
const ABOUT = path.join(PUBLIC, 'about-the-assistant.html');
const WIDGET = path.join(PUBLIC, 'assistant-widget.js');
const VERCEL = path.join(REPO, 'vercel.json');
const SW = path.join(PUBLIC, 'sw.js');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

test('W888-S #1: public/about-the-assistant.html exists and is non-trivial', () => {
  assert.equal(fs.existsSync(ABOUT), true, 'about-the-assistant.html must exist');
  const stat = fs.statSync(ABOUT);
  assert.ok(stat.size > 4000, 'about-the-assistant.html should be > 4KB (real content)');
});

test('W888-S #2: about-the-assistant.html references kolm-assistant by name', () => {
  const html = readFile(ABOUT).toLowerCase();
  assert.ok(html.includes('kolm-assistant'), 'page must call out kolm-assistant by name');
});

test('W888-S #3: about-the-assistant.html links to /v1/verify/', () => {
  const html = readFile(ABOUT);
  assert.ok(/\/v1\/verify\/[a-f0-9]/i.test(html), 'page must link to /v1/verify/<hash>');
});

test('W888-S #4: about-the-assistant.html includes the assistant-widget.js script tag', () => {
  const html = readFile(ABOUT);
  assert.ok(/<script[^>]+src\s*=\s*["'][^"']*assistant-widget\.js/i.test(html),
    'page must load /assistant-widget.js');
  assert.ok(/data-kolm-assistant/.test(html),
    'page must mount the widget via data-kolm-assistant');
});

test('W888-S #5: about-the-assistant.html surfaces K-Score gate (>=0.90) or verifying label', () => {
  const html = readFile(ABOUT);
  const hasGate = /K-Score\s*(&[gG][tE]?;|>=|>|≥)\s*0\.9/i.test(html)
    || /K-Score\s*&ge;\s*0\.9/i.test(html)
    || /0\.93/.test(html);
  const hasPendingLabel = /verifying/i.test(html) || /pending/i.test(html);
  assert.ok(hasGate, 'page must reference the K-Score >= 0.90 gate');
  assert.ok(hasPendingLabel, 'numeric K-Score must be labeled "verifying" or "pending" while dry-run');
});

test('W888-S #6: public/index.html contains the meta-demo callout section', () => {
  const html = readFile(HOME);
  assert.ok(/data-section\s*=\s*["']meta-demo["']/.test(html),
    'homepage must mark the callout with data-section="meta-demo"');
  assert.ok(/the assistant answering this page/i.test(html),
    'homepage must include the meta-demo headline');
});

test('W888-S #7: homepage embeds the inline assistant widget', () => {
  const html = readFile(HOME);
  assert.ok(/data-kolm-assistant/.test(html),
    'homepage must mount the widget via data-kolm-assistant');
  assert.ok(/<script[^>]+src\s*=\s*["'][^"']*assistant-widget\.js/i.test(html),
    'homepage must load /assistant-widget.js');
  assert.ok(/\/about-the-assistant/.test(html),
    'homepage must link to /about-the-assistant for the deep dive');
});

test('W888-S #8: vercel.json includes rewrite for /about-the-assistant', () => {
  const txt = readFile(VERCEL);
  const cfg = JSON.parse(txt);
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const found = rewrites.find(function (r) {
    return r && r.source === '/about-the-assistant' && r.destination === '/about-the-assistant.html';
  });
  assert.ok(found, 'vercel.json must rewrite /about-the-assistant -> /about-the-assistant.html');
});

test('W888-S #9: sw.js cache version bumped (>=111) and ACTIVE CACHE slug carries wave token >=888', () => {
  const sw = readFile(SW);
  const versionMatch = sw.match(/CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(versionMatch, 'sw.js must declare CACHE_VERSION');
  const v = parseInt(versionMatch[1], 10);
  assert.ok(v >= 111, 'CACHE_VERSION must be >= 111 (was 110 before W888-S); got ' + v);
  // Regex+threshold (per W886 #9 family-lock pattern + W446 #5 note): the slug
  // moves forward each wave. Extract the wave token from the ACTIVE
  // `const CACHE = "..."` declaration, NOT the file body — history comments
  // reference older waves and would let stale slugs pass.
  const cacheDecl = sw.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(cacheDecl, 'sw.js must declare const CACHE = "..."');
  const waveMatch = cacheDecl[1].match(/wave(\d{3,4})/);
  assert.ok(waveMatch, `CACHE slug "${cacheDecl[1]}" must include a wave token like "waveNNN"`);
  const w = parseInt(waveMatch[1], 10);
  assert.ok(w >= 888, `CACHE slug wave token must be >= 888 (post-W888-S floor); got wave${w} in "${cacheDecl[1]}"`);
});

test('W888-S #10: assistant-widget.js exists and renders passport hash', () => {
  assert.equal(fs.existsSync(WIDGET), true, 'assistant-widget.js must exist');
  const js = readFile(WIDGET);
  assert.ok(js.length > 1000, 'assistant-widget.js should be > 1KB (real widget)');
  assert.ok(/data-kolm-assistant/.test(js),
    'widget must read data-kolm-assistant mount selector');
  assert.ok(/passport_hash|passport/i.test(js),
    'widget must render the passport hash on each reply');
});

test('W888-S #11: about-the-assistant.html does NOT use the H-word', () => {
  const html = readFile(ABOUT).toLowerCase();
  // Standing user directive: never use "honesty" / "honest" anywhere.
  // Substring match to catch "honesty", "honestly", "honest" alike.
  assert.ok(!/honest/.test(html),
    'about-the-assistant.html must not contain the H-word; use Caveats / Constraints / Limitations.');
});
