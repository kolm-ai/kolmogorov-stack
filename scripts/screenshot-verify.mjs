// Screenshot kolm.ai post-deploy and check for the specific founder concerns:
//   1. White-highlight cutoff on top/left of homepage (must be gone)
//   2. Hero "moustache" chips (must be gone)
//   3. Apple-grade spacing (visual review)
//   4. Mobile rendering OK
//
// Outputs: tmp/sshot-{viewport}-{theme}.png for human review.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const URL = process.env.URL || 'https://kolm.ai/';
const OUT_DIR = process.env.OUT_DIR || 'tmp/sshots';

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'tablet-820',   width: 820,  height: 1180 },
  { name: 'mobile-390',   width: 390,  height: 844 },
];

const THEMES = ['dark', 'light'];

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const report = [];

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      const page = await ctx.newPage();

      await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
      // Set theme explicitly via the localStorage flag the site reads on boot.
      await page.evaluate((t) => {
        try { localStorage.setItem('kolm-theme', t); } catch (_) {}
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      await page.waitForTimeout(400);

      const path = `${OUT_DIR}/sshot-${vp.name}-${theme}.png`;
      await page.screenshot({ path, fullPage: false });

      // Check for forbidden text content (the moustache chips)
      const html = await page.content();
      const forbidden = [
        'hero-chips',
        '0 bytes leave the device at runtime',
        '4 min</b> prompt to compiled',
      ];
      const hits = forbidden.filter(s => html.includes(s));

      // Probe the cutoff: read computed style of .home-hero::before pseudo
      const probe = await page.evaluate(() => {
        const h = document.querySelector('.home-hero');
        if (!h) return { found: false };
        const before = window.getComputedStyle(h, '::before');
        return {
          found: true,
          beforeContent: before.content,
          beforeBg: before.background,
        };
      });

      report.push({ viewport: vp.name, theme, path, forbidden_hits: hits, probe });

      await ctx.close();
    }
  }

  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

run().catch(e => { console.error(e); process.exit(1); });
