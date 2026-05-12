import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:8787/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
const data = await page.evaluate(() => {
  const mains = Array.from(document.querySelectorAll('main'));
  return mains.map(m => ({ cls: m.className, padTop: getComputedStyle(m).paddingTop }));
});
console.log(JSON.stringify(data, null, 2));
await b.close();
