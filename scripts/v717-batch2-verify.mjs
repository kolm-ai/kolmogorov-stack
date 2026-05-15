#!/usr/bin/env node
// Verify v7.17 frontier patterns on second-batch pages
// (defense, edge, legal, enterprise, faq, how-it-works, compare).

import { chromium } from 'playwright';

const URL = process.env.URL || 'https://kolm.ai';
const pages = [
  { path: '/defense',      expect: 'disconnected AI' },
  { path: '/edge',         expect: 'one file' },
  { path: '/legal',        expect: 'privilege intact' },
  { path: '/enterprise',   expect: 'founder-direct' },
  { path: '/faq',          expect: 'direct answers' },
  { path: '/how-it-works', expect: '8 stages' },
  { path: '/compare',      expect: 'positioning' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let pass = 0, fail = 0;

for (const p of pages) {
  const page = await ctx.newPage();
  const url = `${URL}${p.path}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(500);
    const probe = await page.evaluate(() => {
      const eb = document.querySelector('.hero-eyebrow');
      const fb = document.querySelector('.frontier-bg');
      const tone = document.querySelector('h1 .tone');
      const h1 = document.querySelector('h1');
      const h1Size = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
      return {
        hasEyebrow: !!eb,
        eyebrowText: eb ? eb.textContent.trim().slice(0, 80) : '',
        hasFrontierBg: !!fb,
        hasTone: !!tone,
        h1Size,
      };
    });
    const ok = probe.hasEyebrow && probe.hasFrontierBg && probe.hasTone;
    const status = ok ? 'PASS' : 'FAIL';
    if (ok) pass++; else fail++;
    console.log(`${status} ${p.path.padEnd(15)} | eyebrow:${probe.hasEyebrow ? 'Y' : 'N'} | frontier-bg:${probe.hasFrontierBg ? 'Y' : 'N'} | tone:${probe.hasTone ? 'Y' : 'N'} | h1=${probe.h1Size.toFixed(0)}px`);
    if (!ok) console.log(`     eyebrow text: "${probe.eyebrowText}"`);
  } catch (e) {
    console.log(`FAIL ${p.path.padEnd(15)} | ${e.message.slice(0, 80)}`);
    fail++;
  } finally {
    await page.close();
  }
}
await browser.close();
console.log(`\n${pass}/${pass + fail} pages have v7.17 pattern`);
process.exit(fail > 0 ? 1 : 0);
