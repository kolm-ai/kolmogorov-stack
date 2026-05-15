import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
await mkdir('tmp/side', { recursive: true });
const browser = await chromium.launch();
for (const { name, url } of [
  { name: 'pi', url: 'https://www.primeintellect.ai' },
  { name: 'kolm', url: 'https://kolm.ai' },
]) {
  for (const vp of [{ w: 1440, h: 900 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `tmp/side/${name}_${vp.w}.png`, fullPage: false });
    await ctx.close();
  }
}
await browser.close();
console.log('done');
