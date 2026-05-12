import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const PAGES = [
  ['/', 'home'],
  ['/pricing', 'pricing'],
  ['/use-cases', 'solutions'],
  ['/docs', 'docs (devs)'],
  ['/dashboard', 'dashboard'],
  ['/signup', 'signup'],
  ['/account', 'account'],
];

for (const [url, label] of PAGES) {
  try {
    await page.goto('http://localhost:8787' + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const data = await page.evaluate(() => {
      const h = document.querySelector('header.site-header, header.site');
      const hRect = h ? h.getBoundingClientRect() : null;
      const m = document.querySelector('main');
      const firstSection = document.querySelector('main > section, body > section.hero, main.page-main, main.auth-main, main.docs-shell');
      const fRect = firstSection ? firstSection.getBoundingClientRect() : null;
      const className = firstSection ? firstSection.className : '(none)';
      // Top padding of first content
      const cs = firstSection ? getComputedStyle(firstSection) : null;
      const padTop = cs ? cs.paddingTop : 'n/a';
      return { headerBottom: hRect ? hRect.bottom : null, firstTop: fRect ? fRect.top : null, padTop, className };
    });
    const gap = data.firstTop !== null && data.headerBottom !== null ? Math.round(data.firstTop - data.headerBottom) : 'n/a';
    console.log(`[${label.padEnd(14)}] header-bottom=${data.headerBottom} first-top=${data.firstTop} gap=${gap}px padTop=${data.padTop} class=${data.className}`);
  } catch (e) {
    console.log(`[${label.padEnd(14)}] ERROR ${e.message}`);
  }
}

await b.close();
