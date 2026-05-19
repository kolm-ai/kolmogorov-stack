// Batch screenshot tool for the W387 redesign audit. Shoots above-the-fold (hero)
// + full-page versions of the highest-traffic surfaces so we can triage what
// needs the most work.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const ROOT = process.env.SITE_BASE || 'https://kolm.ai';
const OUT_DIR = process.env.OUT_DIR || 'tmp/redesign-shots';
const PAGES = (process.env.PAGES || '/,/pricing,/captures,/quickstart,/healthcare,/docs,/account,/marketplace').split(',');

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage();

for (const p of PAGES) {
  const slug = p === '/' ? 'home' : p.replace(/^\//,'').replace(/\//g,'_');
  const url = `${ROOT}${p}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT_DIR}/hero-${slug}.png`, fullPage: false });
    console.log(`saved hero-${slug}.png`);
  } catch (e) {
    console.error(`fail ${slug}: ${e.message}`);
  }
}

await browser.close();
