// W624 visual review — full-page captures of homepage + pricing at desktop + mobile (dark).
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.URL || 'https://kolm.ai';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join('tmp-screenshots', `w624-review-${STAMP}`);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const ROUTES = ['/', '/pricing'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ colorScheme: 'dark' });
for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const url = BASE + route;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(800);
      const safe = route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '_');
      const file = join(OUT, `${safe}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`ok  ${vp.name.padEnd(7)} ${url} -> ${file}`);
    } catch (e) {
      console.log(`err ${vp.name.padEnd(7)} ${url} -> ${e.message}`);
    }
    await page.close();
  }
}
await ctx.close();
await browser.close();
console.log('out:', OUT);
