import { chromium } from 'playwright';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('https://kolm.ai/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Full page screenshot to find the white line
await page.screenshot({ path: 'scripts/qa-home-full-dark.png', fullPage: true });

// Above-fold
await page.screenshot({ path: 'scripts/qa-home-fold-dark.png', fullPage: false });

// Light theme
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  try { localStorage.setItem('kolm_theme', 'light'); } catch {}
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'scripts/qa-home-full-light.png', fullPage: true });
await page.screenshot({ path: 'scripts/qa-home-fold-light.png', fullPage: false });

// Also probe the access-anywhere section specifically
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
});
await page.waitForTimeout(400);
const aa = await page.$('section.access-anywhere');
if (aa) {
  await aa.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await aa.screenshot({ path: 'scripts/qa-home-aa-dark.png' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(400);
  await aa.screenshot({ path: 'scripts/qa-home-aa-light.png' });
}

await b.close();
console.log('captured');
