import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.URL || 'http://localhost:8787';
const OUT = join(process.cwd(), 'qa', 'v720');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    try { localStorage.setItem('kolm-theme', t); } catch (_) {}
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  }, theme);
  await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.screenshot({ fullPage: false, path: join(OUT, `dashboard-${theme}.png`) });
  const probe = await page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent.trim(),
    eyebrow: document.querySelector('.page-head .eyebrow')?.textContent.trim(),
    kinds: Array.from(document.querySelectorAll('.dc-kind')).map(b => b.getAttribute('data-kind')),
  }));
  console.log(`[${theme}]`, JSON.stringify(probe));
  await ctx.close();
}
await browser.close();
