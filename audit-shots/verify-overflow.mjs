// Verify: are wide tables contained in a scroll wrapper, or do they push body wider than viewport?
import { chromium } from 'playwright';
const BASE = 'https://kolm.ai';

const targets = [
  { path: '/pricing', sel: 'table' },
  { path: '/research', sel: 'table.research-table' },
  { path: '/compare', sel: 'table' },
];

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  for (const t of targets) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE + t.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const r = await page.evaluate((sel) => {
      const tbls = document.querySelectorAll(sel);
      const out = [];
      for (const tbl of tbls) {
        let p = tbl.parentElement;
        const wrappers = [];
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          wrappers.push({
            tag: p.tagName,
            cls: (p.className || '').toString().slice(0, 60),
            overflowX: cs.overflowX,
            overflowY: cs.overflowY,
            w: Math.round(p.getBoundingClientRect().width),
          });
          p = p.parentElement;
        }
        out.push({
          tableW: Math.round(tbl.getBoundingClientRect().width),
          tableScrollW: tbl.scrollWidth,
          ancestors: wrappers.slice(0, 6),
        });
      }
      return {
        bodyScrollW: document.documentElement.scrollWidth,
        viewportW: window.innerWidth,
        tables: out,
      };
    }, t.sel);
    console.log(`\n${t.path}  body.scrollW=${r.bodyScrollW}  viewport=${r.viewportW}`);
    for (const tb of r.tables) {
      console.log(`  table width=${tb.tableW} scrollW=${tb.tableScrollW}`);
      for (const w of tb.ancestors) {
        console.log(`    -> <${w.tag} class="${w.cls}"> ovx=${w.overflowX} ovy=${w.overflowY} w=${w.w}`);
      }
    }
    await ctx.close();
  }

  // also check uc-tab on home
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const tabs = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.uc-tab'));
    return t.map((el, i) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        i, text: (el.textContent || '').slice(0, 20),
        left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        mr: cs.marginRight, ml: cs.marginLeft, gap: getComputedStyle(el.parentElement).gap,
        parentCls: el.parentElement?.className,
      };
    });
  });
  console.log('\nuc-tab geometry on mobile-dark home:');
  for (const t of tabs) console.log(`  ${t.i} "${t.text}" L=${t.left} T=${t.top} W=${t.w} mr=${t.mr} parentGap=${t.gap} parent=${t.parentCls}`);
  await ctx.close();

  await browser.close();
};
run().catch(e => { console.error(e); process.exit(1); });
