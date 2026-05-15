#!/usr/bin/env node
// Verify v7.17 frontier patterns (hero-eyebrow + frontier-bg + tone gradient)
// landed on the 6 newly-extended pages.

import { chromium } from 'playwright';

const URL = process.env.URL || 'https://kolm.ai';
const pages = [
  { path: '/quickstart', expect: 'Quickstart' },
  { path: '/trust',      expect: "verify, don't trust" },
  { path: '/security',   expect: 'signed bytes' },
  { path: '/privacy',    expect: 'data minimisation by design' },
  { path: '/whitepaper', expect: 'RS-1' },
  { path: '/changelog',  expect: 'receipts, not promises' },
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
      const toneFill = tone ? getComputedStyle(tone).webkitTextFillColor : '';
      return {
        hasEyebrow: !!eb,
        eyebrowText: eb ? eb.textContent.trim().slice(0, 80) : '',
        hasFrontierBg: !!fb,
        hasTone: !!tone,
        toneTransparent: toneFill.includes('rgba(0, 0, 0, 0)'),
        h1Size,
        h1Text: h1 ? h1.textContent.trim().slice(0, 60) : '',
      };
    });

    const ok = probe.hasEyebrow && probe.hasFrontierBg && probe.hasTone && probe.eyebrowText.includes(p.expect.slice(0, 12));
    const status = ok ? 'PASS' : 'FAIL';
    if (ok) pass++; else fail++;
    console.log(`${status} ${p.path.padEnd(14)} | eyebrow:${probe.hasEyebrow ? 'Y' : 'N'} | frontier-bg:${probe.hasFrontierBg ? 'Y' : 'N'} | tone:${probe.hasTone ? 'Y' : 'N'}${probe.toneTransparent ? '+grad' : ''} | h1=${probe.h1Size.toFixed(0)}px`);
    if (!ok) {
      console.log(`     expected to find "${p.expect.slice(0, 12)}" in eyebrow, got: "${probe.eyebrowText}"`);
    }
  } catch (e) {
    console.log(`FAIL ${p.path.padEnd(14)} | error: ${e.message.slice(0, 80)}`);
    fail++;
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`\n${pass}/${pass + fail} pages have v7.17 frontier pattern`);
process.exit(fail > 0 ? 1 : 0);
