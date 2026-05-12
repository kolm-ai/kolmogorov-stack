import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 414, height: 896 } });
const page = await ctx.newPage();
for (const url of ['/', '/pricing', '/use-cases', '/docs', '/signup']) {
  await page.goto('http://localhost:8787' + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    const m = document.querySelector('main.page-main, main.auth-main, main.docs-shell');
    const hero = document.querySelector('section.hero');
    const o = hero || m;
    const cs = o ? getComputedStyle(o) : null;
    return { cls: o ? (o.className || o.tagName) : 'none', padTop: cs ? cs.paddingTop : 'n/a' };
  });
  console.log(url.padEnd(14) + ' mobile padTop=' + data.padTop + ' cls=' + data.cls);
}
await b.close();
