// Quick element-level screenshot for visual verification.
// Usage: node scripts/screenshot-element.mjs <url> <selector> <outpath>
import { chromium } from 'playwright';

const url = process.argv[2];
const selector = process.argv[3];
const outpath = process.argv[4];
if (!url || !selector || !outpath) {
  console.error('usage: node scripts/screenshot-element.mjs <url> <selector> <outpath>');
  process.exit(2);
}
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(400);
const el = await page.locator(selector).first();
await el.scrollIntoViewIfNeeded();
await el.screenshot({ path: outpath });
console.log('wrote', outpath);
await browser.close();
