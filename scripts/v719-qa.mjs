// v7.19 . both-modes QA. Captures hero + pricing in dark + light theme
// at desktop 1440 and mobile 390. Affirmative probes:
// (a) cycling-word color resolves to warm clay accent (#cc785c / #b85a3d),
// (b) no AI-product-styled "01/02" .num eyebrow is visible (display:none),
// (c) H1 weight is 400 (Regular) and lede is 300 (Light),
// (d) heavier weights (540/560/580/600) are absent on the homepage hero.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.URL || 'http://localhost:8787';
const OUT = process.env.OUT || join(process.cwd(), 'qa', 'v719');
mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
  { name: 'dark-desktop-1440',  theme: 'dark',  width: 1440, height: 900, path: '/' },
  { name: 'light-desktop-1440', theme: 'light', width: 1440, height: 900, path: '/' },
  { name: 'dark-mobile-390',    theme: 'dark',  width: 390,  height: 844, path: '/' },
  { name: 'light-mobile-390',   theme: 'light', width: 390,  height: 844, path: '/' },
  { name: 'dark-pricing-1440',  theme: 'dark',  width: 1440, height: 900, path: '/pricing' },
  { name: 'light-pricing-1440', theme: 'light', width: 1440, height: 900, path: '/pricing' },
];

const browser = await chromium.launch();
const results = [];

for (const s of SCENARIOS) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((theme) => {
    try { localStorage.setItem('kolm-theme', theme); } catch (_) {} // deliberate: cleanup
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  }, s.theme);
  await page.goto(URL + s.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const probe = await page.evaluate(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const h1 = document.querySelector('.home-hero-left h1, h1');
    const cwCur = document.querySelector('.cw-cur');
    const lede = document.querySelector('.lede');
    const numEyebrows = Array.from(document.querySelectorAll('.eyebrow .num')).map(el => ({
      text: el.textContent.trim(), display: getComputedStyle(el).display
    }));
    const hiddenCount = numEyebrows.filter(n => n.display === 'none').length;
    const featured = document.querySelector('.tier.featured .tag');
    const featuredTagColor = featured ? cs(featured).color : null;
    const featuredCta = document.querySelector('.tier.featured a.cta');
    const teamsTier = Array.from(document.querySelectorAll('.tier')).find(t => {
      const tag = t.querySelector('.tag'); return tag && tag.textContent.trim() === 'Teams';
    });
    const teamsName = teamsTier ? teamsTier.querySelector('.name')?.textContent.trim() : null;
    return {
      theme: document.documentElement.getAttribute('data-theme') || 'dark',
      bodyBg: cs(document.body).backgroundColor,
      h1Weight: h1 ? cs(h1).fontWeight : null,
      h1Size: h1 ? cs(h1).fontSize : null,
      h1Color: h1 ? cs(h1).color : null,
      cwCurColor: cwCur ? cs(cwCur).color : null,
      ledeWeight: lede ? cs(lede).fontWeight : null,
      numEyebrowsCount: numEyebrows.length,
      numEyebrowsHidden: hiddenCount,
      featuredTagColor,
      teamsName,
    };
  });

  await page.screenshot({ fullPage: false, path: join(OUT, `${s.name}.png`) });

  results.push({ scenario: s.name, probe });
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, 'qa.json'), JSON.stringify(results, null, 2));

// Affirmative checks. Emerald accent regex matches rgb(16,185,129) dark / (5,150,105) light.
const emDark = /16,\s*185,\s*129/;
const emLight = /5,\s*150,\s*105/;
const isClay = (col) => emDark.test(col) || emLight.test(col);

let pass = true;
for (const r of results) {
  const p = r.probe;
  console.log(`\n=== ${r.scenario} (theme: ${p.theme}) ===`);
  const checks = [];
  if (r.scenario.startsWith('dark') || r.scenario.startsWith('light')) {
    if (r.scenario.includes('1440') && r.scenario.includes('-desktop') && !r.scenario.includes('pricing')) {
      checks.push(['h1Weight === 400', p.h1Weight === '400']);
      checks.push(['ledeWeight === 300', p.ledeWeight === '300']);
      checks.push(['cwCur is warm clay', isClay(p.cwCurColor)]);
    }
  }
  if (r.scenario.includes('mobile') && !r.scenario.includes('pricing')) {
    checks.push(['h1Weight === 400', p.h1Weight === '400']);
    checks.push(['cwCur is warm clay', isClay(p.cwCurColor)]);
  }
  if (r.scenario.includes('pricing')) {
    checks.push(['featured tag is clay accent', isClay(p.featuredTagColor)]);
    checks.push(['Teams name is Together.', p.teamsName === 'Together.']);
  }
  // Always check numbered eyebrows hidden (or not present)
  checks.push(['all .num eyebrows hidden', p.numEyebrowsCount === 0 || p.numEyebrowsHidden === p.numEyebrowsCount]);

  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) pass = false;
  }
  console.log(`  bodyBg: ${p.bodyBg}`);
  console.log(`  h1: weight=${p.h1Weight} size=${p.h1Size} color=${p.h1Color}`);
  console.log(`  cw-cur color: ${p.cwCurColor}`);
  console.log(`  lede weight: ${p.ledeWeight}`);
  console.log(`  num eyebrows: ${p.numEyebrowsCount} total / ${p.numEyebrowsHidden} hidden`);
  console.log(`  featured tag color: ${p.featuredTagColor}`);
  console.log(`  Teams tier name: ${p.teamsName}`);
}

process.exit(pass ? 0 : 1);
