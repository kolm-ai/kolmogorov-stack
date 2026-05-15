#!/usr/bin/env node
// Final v7.17 sitewide verification: 24 page types, brutalist + frontier pattern.
// Probes h1 size, .hero-eyebrow presence, .frontier-bg presence, drift animation.

import { chromium } from 'playwright';

const URL = process.env.URL || 'https://kolm.ai';
const pages = [
  // Tier 1 — most-visited
  { path: '/',             expect: { eyebrow: false, frontier: true } }, // homepage uses .home-hero-centered, has own backdrop
  { path: '/pricing',      expect: { eyebrow: true, frontier: true } },
  { path: '/docs',         expect: { eyebrow: false, frontier: false } }, // docs has its own shell
  { path: '/api',          expect: { eyebrow: true, frontier: false } },  // api uses .api-hero, has own ::before
  { path: '/spec',         expect: { eyebrow: true, frontier: false } },  // spec uses main ::before
  // Tier 2 — buyer pages
  { path: '/use-cases',    expect: { eyebrow: true, frontier: true } },
  { path: '/healthcare',   expect: { eyebrow: true, frontier: false } },  // own backdrop
  { path: '/finance',      expect: { eyebrow: true, frontier: false } },  // own backdrop
  { path: '/quickstart',   expect: { eyebrow: true, frontier: true } },
  { path: '/trust',        expect: { eyebrow: true, frontier: true } },
  { path: '/security',     expect: { eyebrow: true, frontier: true } },
  { path: '/privacy',      expect: { eyebrow: true, frontier: true } },
  { path: '/whitepaper',   expect: { eyebrow: true, frontier: true } },
  { path: '/changelog',    expect: { eyebrow: true, frontier: true } },
  { path: '/defense',      expect: { eyebrow: true, frontier: true } },
  { path: '/edge',         expect: { eyebrow: true, frontier: true } },
  { path: '/legal',        expect: { eyebrow: true, frontier: true } },
  { path: '/enterprise',   expect: { eyebrow: true, frontier: true } },
  { path: '/faq',          expect: { eyebrow: true, frontier: true } },
  { path: '/how-it-works', expect: { eyebrow: true, frontier: true } },
  { path: '/compare',      expect: { eyebrow: true, frontier: true } },
  { path: '/baa',          expect: { eyebrow: true, frontier: true } },
  { path: '/vs-fine-tune', expect: { eyebrow: true, frontier: true } },
  { path: '/vs-rag',       expect: { eyebrow: true, frontier: true } },
  { path: '/roi',          expect: { eyebrow: true, frontier: true } },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let pass = 0, fail = 0;

for (const p of pages) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${URL}${p.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => {
      const eb = document.querySelector('.hero-eyebrow');
      const fb = document.querySelector('.frontier-bg');
      const h1 = document.querySelector('h1');
      const h1Size = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
      const driftPresent = Array.from(document.styleSheets).some(s => {
        try { return Array.from(s.cssRules || []).some(r => (r.cssText || '').includes('frontier-drift')); }
        catch { return false; }
      });
      return { hasEyebrow: !!eb, hasFrontierBg: !!fb, h1Size, driftPresent };
    });
    const eyebrowOk = !p.expect.eyebrow || probe.hasEyebrow;
    const frontierOk = !p.expect.frontier || probe.hasFrontierBg;
    const h1Ok = probe.h1Size >= 44;
    const ok = eyebrowOk && frontierOk && h1Ok;
    if (ok) pass++; else fail++;
    const driftIcon = probe.driftPresent ? 'drift' : '----';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${p.path.padEnd(15)} eb:${probe.hasEyebrow ? 'Y' : '.'} fbg:${probe.hasFrontierBg ? 'Y' : '.'} h1:${probe.h1Size.toFixed(0)}px ${driftIcon}`);
  } catch (e) {
    console.log(`FAIL ${p.path.padEnd(15)} | ${e.message.slice(0, 80)}`);
    fail++;
  } finally {
    await page.close();
  }
}
await browser.close();
console.log(`\n${pass}/${pages.length} pages passed v7.17 sitewide verify`);
process.exit(fail > 0 ? 1 : 0);
