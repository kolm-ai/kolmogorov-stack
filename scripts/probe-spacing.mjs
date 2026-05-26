import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8787';
const browser = await chromium.launch();

const widths = [
  ['desktop', 1440, 900],
  ['tablet', 820, 1180],
  ['mobile', 414, 896],
];

for (const [name, w, h] of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `audit-shots/scripts-qa/qa-home-${name}-1.png`, fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `audit-shots/scripts-qa/qa-home-${name}-2.png`, fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `audit-shots/scripts-qa/qa-home-${name}-3.png`, fullPage: false });
  console.log(`captured ${name} @ ${w}x${h}`);
  await ctx.close();
}

await browser.close();
