import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto((process.env.URL || 'http://localhost:8787') + '/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: 'tmp/v718-hero-2x.png', fullPage: false });
// Wait until first word-cycle rotation
await page.waitForTimeout(3300);
await page.screenshot({ path: 'tmp/v718-hero-after-cycle.png', fullPage: false });
// And another rotation
await page.waitForTimeout(3300);
await page.screenshot({ path: 'tmp/v718-hero-after-cycle2.png', fullPage: false });
await browser.close();
console.log('saved 3 hero screenshots');
