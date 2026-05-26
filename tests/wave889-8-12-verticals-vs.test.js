// W889-8.1 + W889-8.2 — 10 vertical landing pages + 5 /vs/ competitor pages.
//
// Lock-in invariants. All assertions are file-content checks against the repo
// (no server boot). Run with:
//
//   node --test --test-concurrency=1 tests/wave889-8-12-verticals-vs.test.js
//
//   #1  All 10 vertical pages exist at public/{vertical}.html.
//   #2  All 5 /vs/ pages exist at public/vs/{competitor}.html.
//   #3  Every vertical page links to /account/signup?industry=<vertical> and
//       /book-demo?industry=<vertical>.
//   #4  Every vertical page contains the distill / run / verify trio.
//   #5  Every vertical page references the example receipt CID
//       rcpt_01KYC1ZVTGDCW3FX06JQSC.
//   #6  No vertical or /vs/ page uses the banned words "honest" / "honesty"
//       anywhere.
//   #7  Every /vs/ page contains a comparison table with at least 8 dimension
//       rows (<tr> with class="dim" or td.dim).
//   #8  Every /vs/ page contains at least 3 "kolm wins" claim cards
//       (.v-claim).
//   #9  Every /vs/ page links to /account/signup and /book-demo with the
//       vs-<competitor> ref tag.
//   #10 vercel.json carries rewrites for every new vertical + every new /vs/
//       page. /account/signup also resolves.
//   #11 public/sw.js carries the wave889-verticals-vs cache slug and
//       CACHE_VERSION has been bumped past 113.
//   #12 Shared layout file public/wave889-vertical.css exists and every page
//       in 8.1 + 8.2 links to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const VERTICALS = [
  'healthcare',
  'finance',
  'legal',
  'defense',
  'government',
  'insurance',
  'education',
  'customer-support',
  'code-gen',
  'eu-sovereign'
];

const VS_PAGES = [
  'openai',
  'together',
  'fireworks',
  'openpipe',
  'self-built'
];

const RECEIPT_CID = 'rcpt_01KYC1ZVTGDCW3FX06JQSC';

test('W889-8.1 #1 — all 10 vertical pages exist', () => {
  for (const v of VERTICALS) {
    const p = path.join(ROOT, 'public', `${v}.html`);
    assert.ok(fs.existsSync(p), `missing public/${v}.html`);
  }
});

test('W889-8.2 #2 — all 5 /vs/ pages exist', () => {
  for (const c of VS_PAGES) {
    const p = path.join(ROOT, 'public', 'vs', `${c}.html`);
    assert.ok(fs.existsSync(p), `missing public/vs/${c}.html`);
  }
});

test('W889-8.1 #3 — every vertical links to /account/signup + /book-demo with industry=<v>', () => {
  for (const v of VERTICALS) {
    const html = readFile(`public/${v}.html`);
    assert.ok(
      html.includes(`/account/signup?industry=${v}`),
      `${v}.html missing /account/signup?industry=${v}`
    );
    assert.ok(
      html.includes(`/book-demo?industry=${v}`),
      `${v}.html missing /book-demo?industry=${v}`
    );
  }
});

test('W889-8.1 #4 — every vertical contains distill / run / verify trio', () => {
  for (const v of VERTICALS) {
    const html = readFile(`public/${v}.html`).toLowerCase();
    assert.ok(html.includes('kolm distill'),  `${v}.html missing "kolm distill"`);
    assert.ok(html.includes('kolm run'),      `${v}.html missing "kolm run"`);
    assert.ok(html.includes('kolm verify'),   `${v}.html missing "kolm verify"`);
  }
});

test('W889-8.1 #5 — every vertical references the example receipt CID', () => {
  for (const v of VERTICALS) {
    const html = readFile(`public/${v}.html`);
    assert.ok(
      html.includes(RECEIPT_CID),
      `${v}.html missing example receipt ${RECEIPT_CID}`
    );
  }
});

test('W889-8.1+8.2 #6 — no banned words on any 8.1 / 8.2 page', () => {
  const BANNED = /\b(honest|honesty|honestly)\b/i;
  for (const v of VERTICALS) {
    const html = readFile(`public/${v}.html`);
    assert.ok(!BANNED.test(html), `${v}.html contains a banned word (honest/honesty)`);
  }
  for (const c of VS_PAGES) {
    const html = readFile(`public/vs/${c}.html`);
    assert.ok(!BANNED.test(html), `vs/${c}.html contains a banned word (honest/honesty)`);
  }
});

test('W889-8.2 #7 — every /vs/ page has >= 8 dimension rows in compare table', () => {
  for (const c of VS_PAGES) {
    const html = readFile(`public/vs/${c}.html`);
    const dimMatches = html.match(/<td[^>]*class=["']dim["']/g) || [];
    assert.ok(
      dimMatches.length >= 8,
      `vs/${c}.html only has ${dimMatches.length} td.dim rows (need >= 8)`
    );
  }
});

test('W889-8.2 #8 — every /vs/ page has >= 3 .v-claim cards', () => {
  for (const c of VS_PAGES) {
    const html = readFile(`public/vs/${c}.html`);
    const claimMatches = html.match(/class=["']v-claim["']/g) || [];
    assert.ok(
      claimMatches.length >= 3,
      `vs/${c}.html only has ${claimMatches.length} .v-claim cards (need >= 3)`
    );
  }
});

test('W889-8.2 #9 — every /vs/ page links signup + book-demo with vs-<competitor> ref', () => {
  for (const c of VS_PAGES) {
    const html = readFile(`public/vs/${c}.html`);
    assert.ok(
      html.includes(`/account/signup?ref=vs-${c}`),
      `vs/${c}.html missing /account/signup?ref=vs-${c}`
    );
    assert.ok(
      html.includes(`/book-demo?ref=vs-${c}`),
      `vs/${c}.html missing /book-demo?ref=vs-${c}`
    );
  }
});

test('W889-8.x #10 — vercel.json carries rewrites for new pages + /account/signup', () => {
  const vercel = readFile('vercel.json');
  const required = [
    '"/government"', '"/education"', '"/customer-support"',
    '"/code-gen"', '"/eu-sovereign"',
    '"/vs/openai"', '"/vs/fireworks"', '"/vs/openpipe"', '"/vs/self-built"',
    '"/account/signup"'
  ];
  for (const r of required) {
    assert.ok(vercel.includes(r), `vercel.json missing rewrite source ${r}`);
  }
});

test('W889-8.x #11 — sw.js carries wave889-verticals-vs slug + CACHE_VERSION > 113', () => {
  const sw = readFile('public/sw.js');
  assert.ok(
    sw.includes('wave889-verticals-vs'),
    'sw.js missing wave889-verticals-vs cache slug'
  );
  const m = sw.match(/const\s+CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(m, 'sw.js missing CACHE_VERSION constant');
  assert.ok(
    Number(m[1]) > 113,
    `sw.js CACHE_VERSION = ${m[1]} (must be > 113)`
  );
});

test('W889-8.x #12 — shared wave889-vertical.css exists + every 8.1/8.2 page links it', () => {
  const cssPath = path.join(ROOT, 'public', 'wave889-vertical.css');
  assert.ok(fs.existsSync(cssPath), 'public/wave889-vertical.css missing');

  const LINK = /<link[^>]+href=["']\/wave889-vertical\.css["']/;
  for (const v of VERTICALS) {
    const html = readFile(`public/${v}.html`);
    assert.ok(LINK.test(html), `${v}.html missing link to /wave889-vertical.css`);
  }
  for (const c of VS_PAGES) {
    const html = readFile(`public/vs/${c}.html`);
    assert.ok(LINK.test(html), `vs/${c}.html missing link to /wave889-vertical.css`);
  }
});
