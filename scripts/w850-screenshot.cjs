#!/usr/bin/env node
/* W850: headless screenshots of the static public/ surfaces using
   file:// URLs. No backend required. Captures both light + dark themes
   so the W850 palette swap can be eyeballed before push. */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', 'public');
const OUT = path.join(__dirname, '..', '.w850-shots');
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  ['index.html',              'home'],
  ['wrapper.html',            'wrapper'],
  ['studio.html',             'studio'],
  ['pricing.html',            'pricing'],
  ['docs.html',               'docs'],
  ['account/overview.html',   'account-overview'],
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  for (const [rel, slug] of PAGES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.log('SKIP missing:', rel);
      continue;
    }
    const url = 'http://127.0.0.1:8761/' + rel.replace(/\\/g, '/');
    for (const theme of ['light', 'dark']) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.evaluate((t) => {
        try { localStorage.setItem('kolm-theme', t); } catch(e) {} // deliberate: cleanup
        document.documentElement.setAttribute('data-theme', t);
        document.documentElement.style.colorScheme = t;
      }, theme);
      await page.waitForTimeout(200);
      const file = path.join(OUT, `${slug}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log('shot:', path.relative(process.cwd(), file));
    }
  }
  await browser.close();
})();
