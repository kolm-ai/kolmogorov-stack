// W682-AUDIT screenshot driver — feeds the visual audit half of KOLM_ULTRA_PLAN_2026_05_24.md.
// Hits the LIVE deploy (kolm.ai by default) so we see what users actually see, not file:// HTML.
// Captures both above-the-fold viewport AND full-page so we can grade hero density and page flow.
// Output: %TEMP%\kolm-screenshots-<ts>\ + manifest.json. Exit 0 even if individual pages fail.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PAGES = [
  '/',
  '/k-score',
  '/security',
  '/pricing',
  '/quickstart',
  '/docs',
  '/use-cases',
  '/compare',
  '/runtimes',
  '/marketplace',
  '/spec/kolm-format-v1',
  '/for/healthcare',
  '/for/fintech',
  '/integrations',
  '/changelog',
  '/enterprise',
];

const OUT_DIR = path.join(process.env.TEMP || '/tmp', 'kolm-screenshots-' + Date.now());
const BASE = process.env.KOLM_BASE_URL || 'https://kolm.ai';

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: 'kolm-ultra-audit/1.0 (+screenshots)',
  });
  const results = [];
  for (const route of PAGES) {
    const url = BASE + route;
    const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '__').replace(/[^a-z0-9_]/gi, '_');
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
      const status = resp ? resp.status() : 0;
      await page.waitForTimeout(700);
      const viewportPath = path.join(OUT_DIR, slug + '__viewport.png');
      const fullPath = path.join(OUT_DIR, slug + '__full.png');
      await page.screenshot({ path: viewportPath, fullPage: false });
      await page.screenshot({ path: fullPath, fullPage: true });
      const stats = fs.statSync(fullPath);
      results.push({ route, url, status, viewport: viewportPath, full: fullPath, full_bytes: stats.size });
      console.log(`OK ${status} ${route} (${(stats.size / 1024).toFixed(0)}KB)`);
    } catch (e) {
      results.push({ route, url, error: e.message });
      console.log(`ERR ${route} ${e.message}`);
    } finally {
      await page.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ base: BASE, out_dir: OUT_DIR, count: PAGES.length, results }, null, 2));
  console.log('DONE manifest:', path.join(OUT_DIR, 'manifest.json'));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
