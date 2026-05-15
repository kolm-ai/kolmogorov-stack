// Full-page screenshots of key funnel pages for completeness audit.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const BASE = process.env.URL || 'https://kolm.ai';
const OUT = 'tmp/sshots-v7.13';
await mkdir(OUT, { recursive: true });
const PAGES = ['/pricing', '/quickstart', '/docs', '/spec', '/security', '/api', '/cookbook', '/use-cases'];
const browser = await chromium.launch();
for (const path of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(500);
    const file = `${OUT}/page${path.replace(/\//g, '-')}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log('saved', path);
  } catch (e) {
    console.log('err', path, e.message);
  }
  await ctx.close();
}
await browser.close();
