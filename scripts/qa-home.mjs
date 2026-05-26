import { chromium } from 'playwright';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto('https://kolm.ai/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

await page.screenshot({ path: 'audit-shots/scripts-qa/qa-home-full-dark.png', fullPage: true });

await b.close();
console.log('captured');
