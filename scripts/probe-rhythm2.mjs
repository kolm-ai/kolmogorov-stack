import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
for (const url of ['/dashboard', '/account', '/captures', '/audit-log']) {
  await page.goto('http://localhost:8787' + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    const m = document.querySelector('main');
    const cs = m ? getComputedStyle(m) : null;
    return { cls: m ? m.className : '(none)', padTop: cs ? cs.paddingTop : 'n/a' };
  });
  console.log(url.padEnd(14) + ' main.class=' + data.cls + ' padTop=' + data.padTop);
}
await b.close();
