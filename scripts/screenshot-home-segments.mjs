// W627: viewport-sized scroll segments of the homepage at native resolution,
// so the visual audit isn't squashed into a 10kpx-tall thumbnail.
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.URL || 'http://localhost:5179';
const ROUTE = process.env.ROUTE || '/';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join('tmp-screenshots', `home-segments-${STAMP}`);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const VP = { width: 1440, height: 900 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ colorScheme: 'dark', viewport: VP });
const page = await ctx.newPage();
await page.goto(BASE + ROUTE, { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.evaluate(() => {
  window.dispatchEvent(new Event('scroll'));
  document.querySelectorAll('.fr-reveal').forEach((el) => el.classList.add('fr-in'));
});
await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(300);

const total = await page.evaluate(() => document.documentElement.scrollHeight);
const step = VP.height - 80;
let i = 0;
for (let y = 0; y < total; y += step) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(150);
  const file = join(OUT, `seg-${String(i).padStart(2, '0')}-y${y}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`seg ${i} y=${y} -> ${file}`);
  i++;
}
await browser.close();
console.log('out:', OUT);
console.log('total height:', total, 'segments:', i);
