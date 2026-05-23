// Site-wide visual review: top-nav + key surfaces, desktop + mobile, dark theme.
// Triggers scroll-arm (W625) before fullPage capture so .fr-reveal sections render.
import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.URL || 'https://kolm.ai';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join('tmp-screenshots', `site-review-${STAMP}`);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const ROUTES = (process.env.ROUTES ? process.env.ROUTES.split(',') : [
  '/',
  '/pricing',
  '/product',
  '/quickstart',
  '/docs',
  '/api',
  '/compile',
  '/distill',
  '/capture',
  '/run',
  '/runtimes',
  '/integrations',
  '/changelog',
  '/use-cases',
  '/healthcare',
  '/finance',
  '/legal',
  '/defense',
  '/enterprise',
  '/security',
  '/k-score',
  '/benchmarks',
  '/trust',
  '/baa',
  '/soc2',
  '/manifesto',
  '/research',
  '/signup',
  '/login',
  '/faq',
]);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const safeName = (route) => route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '_');

const browser = await chromium.launch();
const ctx = await browser.newContext({ colorScheme: 'dark' });
const results = [];
for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const url = BASE + route;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      // Trigger W625 scroll-arm + force fr-in on every .fr-reveal so fullPage capture
      // shows the same content a scrolled-through user would see.
      await page.evaluate(() => {
        window.dispatchEvent(new Event('scroll'));
        document.querySelectorAll('.fr-reveal').forEach((el) => el.classList.add('fr-in'));
      });
      // Networkidle after the arm so any deferred image loads finish.
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      const file = join(OUT, `${safeName(route)}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const dim = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      results.push({ route, viewport: vp.name, file, w: dim.w, h: dim.h, ok: true });
      console.log(`ok  ${vp.name.padEnd(7)} ${route.padEnd(20)} ${dim.w}x${dim.h} -> ${file}`);
    } catch (e) {
      results.push({ route, viewport: vp.name, ok: false, error: String(e.message || e) });
      console.log(`err ${vp.name.padEnd(7)} ${route.padEnd(20)} -> ${e.message}`);
    }
    await page.close();
  }
}
await ctx.close();
await browser.close();
writeFileSync(join(OUT, 'INDEX.json'), JSON.stringify({ base: BASE, stamp: STAMP, results }, null, 2));
console.log('out:', OUT);
console.log(`total: ${results.length}, ok: ${results.filter(r => r.ok).length}, err: ${results.filter(r => !r.ok).length}`);
