// Sitewide audit: screenshot every URL in sitemap at mobile + desktop, probe
// for design issues, dump a JSON report. Run in parallel batches.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const BASE = process.env.URL || 'https://kolm.ai';
const OUT = 'tmp/sitewide-v7.15';
await mkdir(OUT + '/mobile', { recursive: true });
await mkdir(OUT + '/desktop', { recursive: true });

// Pull all URLs from sitemap
const sm = await readFile('public/sitemap.xml', 'utf8');
const URLS = [...sm.matchAll(/<loc>https:\/\/kolm\.ai([^<]*)<\/loc>/g)]
  .map((m) => m[1] || '/')
  .filter((u) => !u.endsWith('.xml')); // skip rss.xml etc.

console.log(`auditing ${URLS.length} URLs`);

const browser = await chromium.launch();

async function audit(viewport, label, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
  const page = await ctx.newPage();
  const results = [];
  for (const url of URLS) {
    const safe = url === '/' ? 'home' : url.replace(/^\//, '').replace(/\//g, '__');
    try {
      const resp = await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 25000 });
      const status = resp ? resp.status() : 0;
      await page.waitForTimeout(300);

      const probe = await page.evaluate(() => {
        const hero = document.querySelector('section.hero, .home-hero, .hero, main > section:first-child');
        const footer = document.querySelector('.site-footer, footer.site, footer.site-footer');
        const main = document.querySelector('main, .page-main, .docs-shell, .auth-main');
        const wrap = document.querySelector('.wrap, .wrap-wide');
        const ems = (document.body.innerHTML.match(/&mdash;|—/g) || []).length;
        const broken = [];
        // Check for visible horizontal overflow
        const docW = document.documentElement.scrollWidth;
        const winW = window.innerWidth;
        if (docW > winW + 2) broken.push(`hOverflow:${docW}>${winW}`);
        // Check for empty h1
        const h1 = document.querySelector('h1');
        if (!h1 || !h1.textContent.trim()) broken.push('no-h1');
        // Check for elements wider than viewport
        const oversize = [...document.querySelectorAll('section, .wrap, .card, .panel')]
          .filter((el) => el.getBoundingClientRect().width > winW + 2)
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}`);
        if (oversize.length) broken.push(`oversize:${oversize.join(',')}`);
        return {
          heroPresent: !!hero,
          footerPresent: !!footer,
          mainPresent: !!main,
          wrapPresent: !!wrap,
          pageH: document.documentElement.scrollHeight,
          h1: h1 ? h1.textContent.trim().slice(0, 60) : null,
          emDashes: ems,
          broken,
          title: document.title.slice(0, 60),
        };
      });

      const file = `${OUT}/${label}/${safe}.png`;
      await page.screenshot({ path: file, fullPage: true });
      results.push({ url, status, ...probe, file });
      if (probe.broken.length || probe.emDashes > 0 || status !== 200) {
        console.log(`  [${label}] ${url} status=${status} h1=${(probe.h1||'').slice(0,30)} emDash=${probe.emDashes} broken=${probe.broken.join('|')}`);
      }
    } catch (e) {
      results.push({ url, error: e.message });
      console.log(`  [${label}] ${url} ERR ${e.message}`);
    }
  }
  await ctx.close();
  return results;
}

console.log('\n=== MOBILE 390 dark ===');
const mob = await audit({ width: 390, height: 844 }, 'mobile', 'dark');
console.log('\n=== DESKTOP 1440 dark ===');
const desk = await audit({ width: 1440, height: 900 }, 'desktop', 'dark');

await writeFile(`${OUT}/report.json`, JSON.stringify({ mobile: mob, desktop: desk }, null, 2));
console.log(`\nwrote ${OUT}/report.json`);

// Summary table
console.log('\n=== SUMMARY ===');
const probs = [...mob.map((r) => ({ ...r, vp: 'M' })), ...desk.map((r) => ({ ...r, vp: 'D' }))]
  .filter((r) => r.error || (r.broken && r.broken.length) || r.emDashes > 0 || r.status !== 200);
console.log(`total problems: ${probs.length}`);
for (const p of probs.slice(0, 30)) {
  console.log(`  ${p.vp} ${p.url} ${p.status || 'ERR'} emDash=${p.emDashes || 0} broken=${(p.broken || []).join('|') || ''} ${p.error || ''}`);
}

await browser.close();
console.log('done');
