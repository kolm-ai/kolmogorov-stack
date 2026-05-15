import { chromium } from 'playwright';
const BASE = 'https://kolm.ai';

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  for (const p of ['/leaderboard', '/solutions', '/', '/pricing']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('kolm-theme', 'light'); } catch {} });
    const page = await ctx.newPage();
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const data = await page.evaluate(() => {
      const f = document.querySelector('footer') || document.querySelector('.site-footer') || document.querySelector('[role="contentinfo"]');
      if (!f) return null;
      const cs = getComputedStyle(f);
      return {
        themeAttr: document.documentElement.getAttribute('data-theme'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        footerBg: cs.backgroundColor,
        footerColor: cs.color,
        tag: f.tagName + '.' + (f.className || '').toString().slice(0, 40),
      };
    });
    console.log(`${p}  ${JSON.stringify(data)}`);
    await ctx.close();
  }
  await browser.close();
};
run().catch(e => { console.error(e); process.exit(1); });
