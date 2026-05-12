import { chromium } from 'playwright';
const b = await chromium.launch();
const widths = [[1440,'desktop'],[820,'tablet'],[414,'mobile']];
for (const [w, label] of widths) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    const h = document.querySelector('.hero');
    const cs = h ? getComputedStyle(h) : null;
    return cs ? { padding: cs.padding, padTop: cs.paddingTop, padBot: cs.paddingBottom } : null;
  });
  console.log(`${label.padEnd(8)} ${w}px hero padding=${data.padding}`);
  await ctx.close();
}
await b.close();
