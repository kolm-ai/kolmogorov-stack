import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = 'tmp/v717-final';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

const pages = [
  { name: 'home', url: 'https://kolm.ai/' },
  { name: 'pricing', url: 'https://kolm.ai/pricing' },
  { name: 'spec', url: 'https://kolm.ai/spec' },
  { name: 'api', url: 'https://kolm.ai/api' },
  { name: 'docs', url: 'https://kolm.ai/docs' },
  { name: 'use-cases', url: 'https://kolm.ai/use-cases' },
  { name: 'healthcare', url: 'https://kolm.ai/healthcare' },
  { name: 'finance', url: 'https://kolm.ai/finance' },
];

for (const { name, url } of pages) {
  for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      const file = `${OUT}/${name}_${vp.w}.png`;
      await page.screenshot({ path: file, fullPage: false });
      const probe = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const h1Style = h1 ? getComputedStyle(h1) : null;
        const eyebrow = document.querySelector('.hero-eyebrow, .eyebrow, .pill');
        return {
          h1Text: (h1?.textContent || '').trim().slice(0, 80),
          h1Size: h1Style?.fontSize,
          h1Weight: h1Style?.fontWeight,
          h1LineHeight: h1Style?.lineHeight,
          hasFrontierUtil: !!document.querySelector('.hero-eyebrow .he-dot, .btn.electric, .frontier-bg, .tickertape'),
          eyebrowText: (eyebrow?.textContent || '').trim().slice(0, 60),
          docHeight: document.documentElement.scrollHeight,
        };
      });
      console.log(`${name} ${vp.w}: h1=${probe.h1Size}/${probe.h1Weight} "${probe.h1Text.slice(0,40)}" eyebrow="${probe.eyebrowText}" util=${probe.hasFrontierUtil} h=${probe.docHeight}`);
    } catch (e) {
      console.log(`${name} ${vp.w}: ERR ${e.message}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log('\nWritten to', OUT);
