import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = 'tmp/compare-pi';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

// Capture both at desktop 1440 and mobile 390 dark + light
const targets = [
  { name: 'primeintellect', url: 'https://www.primeintellect.ai' },
  { name: 'kolm', url: 'https://kolm.ai' },
];

for (const { name, url } of targets) {
  for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        deviceScaleFactor: 1,
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        const file = `${OUT}/${name}_${vp.w}_${theme}.png`;
        await page.screenshot({ path: file, fullPage: true });
        const probe = await page.evaluate(() => ({
          h: document.documentElement.scrollHeight,
          h1: (document.querySelector('h1')?.textContent || '').trim().slice(0, 80),
          headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 8).map(h => `${h.tagName} ${h.textContent.trim().slice(0, 50)}`),
          accents: getComputedStyle(document.body).backgroundColor,
          fonts: getComputedStyle(document.body).fontFamily,
          sections: [...document.querySelectorAll('section, .section, main > div')].length,
        }));
        console.log(`${name} ${vp.w} ${theme}: h=${probe.h} h1="${probe.h1}" sections=${probe.sections} font=${probe.fonts.slice(0, 40)}`);
      } catch (e) {
        console.log(`${name} ${vp.w} ${theme}: ERR ${e.message}`);
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log('\nWritten to', OUT);
