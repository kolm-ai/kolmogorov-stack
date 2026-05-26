import { chromium } from 'playwright';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto('https://kolm.ai/solutions', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

await page.screenshot({ path: 'audit-shots/scripts-qa/qa-solutions-fold-dark.png', fullPage: false });
await page.screenshot({ path: 'audit-shots/scripts-qa/qa-solutions-full-dark.png', fullPage: true });

await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  try { localStorage.setItem('kolm-theme', 'light'); } catch {} // deliberate: cleanup
});
await page.waitForTimeout(800);

await page.screenshot({ path: 'audit-shots/scripts-qa/qa-solutions-fold-light.png', fullPage: false });
await page.screenshot({ path: 'audit-shots/scripts-qa/qa-solutions-full-light.png', fullPage: true });

await b.close();
console.log('captured');
