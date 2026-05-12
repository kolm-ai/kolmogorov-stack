// scripts/screenshot-audit.mjs
// Render kolm.ai pages in both themes at desktop + mobile widths.
// Save into tmp/aesthetic-audit/ so the artifacts can be inspected
// alongside CSS rules during the v7.11.3 elevation pass.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.URL || 'https://kolm.ai';
const OUT = path.resolve('tmp/aesthetic-audit');
fs.mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['/',           'home'],
  ['/pricing',    'pricing'],
  ['/quickstart', 'quickstart'],
  ['/anatomy',    'anatomy'],
  ['/api',        'api'],
  ['/docs',       'docs'],
  ['/dashboard',  'dashboard'],
];

const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { name: 'desk', width: 1440, height: 900 },
  { name: 'mob',  width: 390,  height: 844 },
];

(async () => {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    for (const theme of THEMES) {
      for (const [route, slug] of ROUTES) {
        const url = URL + route;
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          // Pre-baked theme toggle: set localStorage + data-theme before paint.
          await page.evaluate((t) => {
            try { localStorage.setItem('theme', t); } catch (e) {}
            document.documentElement.setAttribute('data-theme', t);
          }, theme);
          await page.waitForTimeout(420);
          // First-fold capture (clip to viewport size so the artifact is
          // about the chrome at hero/video, not full-page).
          const fold = path.join(OUT, `${slug}-${theme}-${vp.name}-fold.png`);
          await page.screenshot({ path: fold, fullPage: false });
          // Full-page capture for downstream shadow review.
          const full = path.join(OUT, `${slug}-${theme}-${vp.name}-full.png`);
          await page.screenshot({ path: full, fullPage: true });
          process.stdout.write(`saved ${slug} ${theme} ${vp.name}\n`);
        } catch (err) {
          process.stdout.write(`FAIL ${slug} ${theme} ${vp.name}: ${err.message}\n`);
        }
      }
    }
    await ctx.close();
  }
  await browser.close();
})();
