#!/usr/bin/env node
// v7.18 substantive frontier verify. Probes:
// (1) cycle-word in H1, (2) hero-mesh procedural animation present,
// (3) brand-mark moment section with massive kolm. wordmark,
// (4) live registry feed fetched and rendered.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8787';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);

const probe = await page.evaluate(async () => {
  const cycleWord = document.querySelector('.home-hero-centered h1 .cw-cur');
  const heroMesh = document.querySelector('.hero-mesh');
  const heroMeshThird = document.querySelector('.hero-mesh .hm-third');
  const bmm = document.querySelector('.brand-mark-moment');
  const bmmMark = document.querySelector('.bmm-mark');
  const bmmMarkFontSize = bmmMark ? parseFloat(getComputedStyle(bmmMark).fontSize) : 0;
  const lr = document.querySelector('.live-registry');
  const lrGrid = document.querySelector('#lr-grid');
  const lrRows = lrGrid ? lrGrid.querySelectorAll('.lr-row') : [];
  const lrPulse = document.querySelector('.lr-pulse');
  const h1FontSize = parseFloat(getComputedStyle(document.querySelector('.home-hero-centered h1')).fontSize);
  const cwAnim = cycleWord ? getComputedStyle(cycleWord).animationName : '';
  const meshAnim = heroMeshThird ? getComputedStyle(heroMeshThird).animationName : '';
  return {
    hasCycleWord: !!cycleWord,
    cycleWordText: cycleWord ? cycleWord.textContent : '',
    cycleWordAnim: cwAnim,
    hasHeroMesh: !!heroMesh,
    meshAnim,
    hasBmm: !!bmm,
    bmmMarkText: bmmMark ? bmmMark.textContent : '',
    bmmMarkFontSize,
    hasLiveRegistry: !!lr,
    hasLrGrid: !!lrGrid,
    lrRowCount: lrRows.length,
    hasLrPulse: !!lrPulse,
    h1FontSize,
  };
});

// Wait an extra 2.2s and re-probe word-cycle text to see if it rotated
await page.waitForTimeout(2500);
const cycleAfter = await page.evaluate(() => {
  const cw = document.querySelector('.cw-cur');
  return cw ? cw.textContent : '';
});

// Wait for live registry fetch (give it 4s total)
await page.waitForTimeout(2000);
const lrAfter = await page.evaluate(() => {
  const rows = document.querySelectorAll('#lr-grid .lr-row');
  const names = Array.from(rows).map(r => r.querySelector('.lr-name')?.textContent || '');
  const kchips = Array.from(rows).map(r => r.querySelector('.lr-k')?.textContent || '');
  return { rowCount: rows.length, names, kchips };
});

await page.screenshot({ path: 'tmp/v718-hero.png', fullPage: false });
await page.evaluate(() => window.scrollTo({ top: document.querySelector('.brand-mark-moment')?.offsetTop || 1800 }));
await page.waitForTimeout(400);
await page.screenshot({ path: 'tmp/v718-brandmark.png', fullPage: false });
await page.evaluate(() => window.scrollTo({ top: document.querySelector('.live-registry')?.offsetTop - 80 || 1400 }));
await page.waitForTimeout(400);
await page.screenshot({ path: 'tmp/v718-liveregistry.png', fullPage: false });

console.log('--- probe ---');
console.log(JSON.stringify(probe, null, 2));
console.log('--- cycle word after 2.5s ---');
console.log('cycle text:', cycleAfter, '(initial was:', probe.cycleWordText + ')');
console.log('--- live registry after 4.5s ---');
console.log(JSON.stringify(lrAfter, null, 2));

if (errs.length) {
  console.log('--- page errors ---');
  errs.forEach(e => console.log(' ', e));
}

const checks = [
  ['cycle-word in H1', probe.hasCycleWord],
  ['cycle-word has animation', probe.cycleWordAnim === 'cw-slide'],
  ['hero-mesh exists', probe.hasHeroMesh],
  ['mesh third blob animated', probe.meshAnim === 'hm-drift-c'],
  ['brand-mark-moment exists', probe.hasBmm],
  ['kolm. wordmark text correct', probe.bmmMarkText === 'kolm.'],
  ['kolm. wordmark >= 140px', probe.bmmMarkFontSize >= 140],
  ['live-registry exists', probe.hasLiveRegistry],
  ['live-registry pulse animated', probe.hasLrPulse],
  ['live-registry has rows after fetch', lrAfter.rowCount >= 1],
  ['no JS errors', errs.length === 0],
];
let pass = 0, fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass}/${checks.length} checks passed`);

await browser.close();
process.exit(fail > 0 ? 1 : 0);
