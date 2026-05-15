// Quick verification: does the live site's theme toggle actually work?
// And does localStorage.setItem('theme','light') BEFORE page load actually flip the attribute?
import { chromium } from 'playwright';
const BASE = 'https://kolm.ai';

const run = async () => {
  const browser = await chromium.launch({ headless: true });

  // Path A: addInitScript to set localStorage BEFORE document scripts run
  let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light'); } catch {} });
  let page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const a = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.getItem('theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  console.log('Path A (addInitScript before goto):', JSON.stringify(a));
  await ctx.close();

  // Path B: navigate, then set localStorage, then reload
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const b = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.getItem('theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  console.log('Path B (navigate, set LS, reload):', JSON.stringify(b));
  await ctx.close();

  // Path C: find and click an actual theme toggle button on the page
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const beforeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  // try common selectors
  const sels = ['.theme-toggle', '#theme-toggle', '[data-theme-toggle]', 'button[aria-label*="theme" i]', 'button[title*="theme" i]', '.nav-theme'];
  let clicked = null;
  for (const s of sels) {
    const el = await page.$(s);
    if (el) { try { await el.click({ timeout: 1000 }); clicked = s; break; } catch {} }
  }
  await page.waitForTimeout(800);
  const c = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.getItem('theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  console.log(`Path C (clicked ${clicked || 'no toggle found'}):`, JSON.stringify({ before: beforeAttr, ...c }));

  // Path D: Inspect the boot script — what attribute does it look at?
  const bootSource = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent || '');
    const candidates = scripts.filter(s => /theme/i.test(s) && (/data-theme|localStorage/.test(s)) && s.length < 3000);
    return candidates.slice(0, 3);
  });
  console.log('Boot scripts referencing theme:');
  for (const s of bootSource) console.log('---\n' + s.slice(0, 800));

  await ctx.close();
  await browser.close();
};
run().catch(e => { console.error(e); process.exit(1); });
