// W629: capture multiple routes at native resolution to audit pre-facelift state.
// Each route gets its own subdir of viewport-sized scroll segments.
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.URL || 'http://localhost:5179';
const ROUTES = (process.env.ROUTES || '/pricing,/product,/quickstart,/enterprise').split(',');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const ROOT = join('tmp-screenshots', `multi-${STAMP}`);
if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });

const VP = { width: 1440, height: 900 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ colorScheme: 'dark', viewport: VP });
const page = await ctx.newPage();

for (const route of ROUTES) {
  const slug = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  const OUT = join(ROOT, slug);
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  try {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('scroll'));
      document.querySelectorAll('.fr-reveal').forEach((el) => el.classList.add('fr-in'));
    });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);

    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const step = VP.height - 80;
    let i = 0;
    for (let y = 0; y < total; y += step) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(120);
      const file = join(OUT, `seg-${String(i).padStart(2, '0')}-y${y}.png`);
      await page.screenshot({ path: file, fullPage: false });
      i++;
    }
    console.log(`${route} -> ${OUT} (${i} segs, total=${total})`);
  } catch (e) {
    console.log(`${route} -> FAILED: ${e.message}`);
  }
}

await browser.close();
console.log('root:', ROOT);
