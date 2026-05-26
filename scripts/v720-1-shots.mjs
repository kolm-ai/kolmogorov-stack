import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.URL || 'https://kolm.ai';
const OUT = process.env.OUT || join(process.cwd(), 'qa', 'v720_1');
mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
  { name: 'dark-desktop-1440',  theme: 'dark',  width: 1440, height: 900 },
  { name: 'light-desktop-1440', theme: 'light', width: 1440, height: 900 },
  { name: 'dark-mobile-390',    theme: 'dark',  width: 390,  height: 844 },
  { name: 'light-mobile-390',   theme: 'light', width: 390,  height: 844 },
];

const browser = await chromium.launch();
for (const s of SCENARIOS) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((theme) => {
    try { localStorage.setItem('kolm-theme', theme); } catch (_) {} // deliberate: cleanup
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  }, s.theme);
  await page.goto(URL + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ fullPage: true,  path: join(OUT, `${s.name}-full.png`) });
  await page.screenshot({ fullPage: false, path: join(OUT, `${s.name}-fold.png`) });
  const probe = await page.evaluate(() => ({
    hasTrainAny: !!document.querySelector('section.train-any'),
    hasLifecycle: !!document.querySelector('section.lifecycle'),
    hasAfterCompile: !!document.querySelector('section.after-compile') && getComputedStyle(document.querySelector('section.after-compile')).display !== 'none',
    pageH: document.documentElement.scrollHeight,
  }));
  console.log(s.name, JSON.stringify(probe));
  await ctx.close();
}
await browser.close();
