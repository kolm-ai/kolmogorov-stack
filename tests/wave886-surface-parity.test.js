// W886 - Surface parity lock-in.
//
// After the W866-W869 forge/studio/persona buildout, the website must surface
// the new pages. This wave pins that the public/ tree carries the surfaces
// the website promises (forge, merge, hardware, studio, studio subpages)
// AND that the service worker has been bumped to invalidate the prior cache.
//
// W604 anti-brittleness: cache-version + sw-slug checks use regex + numeric
// thresholds, NEVER explicit version strings or explicit slug arrays.
//
// Items pinned:
//   1) public/studio.html resolves (Studio landing)
//   2) public/studio/compile.html resolves (compile wizard)
//   3) public/studio/jobs.html resolves (jobs tracker)
//   4) public/forge.html resolves
//   5) public/merge.html resolves
//   6) public/hardware.html resolves
//   7) sw.js CACHE_VERSION is a number and >= 95 (post-W868 floor)
//   8) sw.js CACHE slug carries wave867 OR wave868 OR wave869 token (regex)
//   9) Family lock — at least one prior wave8xx test file exists

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = __dirname;
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const SW_JS = path.join(PUBLIC_DIR, 'sw.js');

function assertHtmlPage(rel, minBytes = 500) {
  const p = path.join(PUBLIC_DIR, rel);
  assert.ok(fs.existsSync(p), `${rel} must exist at ${p}`);
  const stat = fs.statSync(p);
  assert.ok(stat.size > minBytes,
    `${rel} must be >${minBytes} bytes (not a stub); got ${stat.size}`);
  const txt = fs.readFileSync(p, 'utf8');
  assert.ok(/<html[\s>]/i.test(txt) || /<!DOCTYPE\s+html/i.test(txt),
    `${rel} must look like an HTML document (<html> or <!DOCTYPE html>)`);
}

// ----------------------------------------------------------------------------
// 1-3) Studio surfaces
// ----------------------------------------------------------------------------
test('W886 #1 - public/studio.html resolves', () => {
  assertHtmlPage('studio.html');
});

test('W886 #2 - public/studio/compile.html resolves', () => {
  assertHtmlPage(path.join('studio', 'compile.html'));
});

test('W886 #3 - public/studio/jobs.html resolves', () => {
  assertHtmlPage(path.join('studio', 'jobs.html'));
});

// ----------------------------------------------------------------------------
// 4-6) Forge / Merge / Hardware copy pages (W869 Phase F)
// ----------------------------------------------------------------------------
test('W886 #4 - public/forge.html resolves', () => {
  assertHtmlPage('forge.html');
});

test('W886 #5 - public/merge.html resolves', () => {
  assertHtmlPage('merge.html');
});

test('W886 #6 - public/hardware.html resolves', () => {
  assertHtmlPage('hardware.html');
});

// ----------------------------------------------------------------------------
// 7) sw.js CACHE_VERSION numeric + >= 95 (post-W868 floor)
// ----------------------------------------------------------------------------
test('W886 #7 - sw.js CACHE_VERSION is a number and >= 95', () => {
  const sw = fs.readFileSync(SW_JS, 'utf8');
  const m = sw.match(/const\s+CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(m, `sw.js must declare CACHE_VERSION = <number>`);
  const v = Number(m[1]);
  assert.ok(v >= 95,
    `CACHE_VERSION must be >= 95 (post-W868 floor); got ${v}`);
});

// ----------------------------------------------------------------------------
// 8) sw.js CACHE slug carries wave867/868/869 token
// ----------------------------------------------------------------------------
test('W886 #8 - sw.js CACHE slug carries wave867 OR wave868 OR wave869 token', () => {
  const sw = fs.readFileSync(SW_JS, 'utf8');
  assert.ok(/wave86[789]\b/.test(sw),
    `sw.js CACHE slug must include at least one of wave867/wave868/wave869`);
});

// ----------------------------------------------------------------------------
// 9) Family lock (W604): regex + threshold, never explicit array.
// ----------------------------------------------------------------------------
test('W886 #9 - W604 family pattern: at least one prior wave8xx test file exists', () => {
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
