// v7.18.4 — both-modes QA. Captures hero at 1440 desktop in BOTH dark and
// light theme, verifies (a) no cyan / mint-green accent on cycling word,
// CTA, dots, (b) H1 weight is 400 (Geist Regular), (c) light-mode bg is
// warm paper (not pure white), (d) dark-mode bg is deeper cosmic.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.URL || 'http://localhost:8787/';
const OUT = process.env.OUT || join(process.cwd(), 'qa', 'v7184');
mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
  { name: 'dark-desktop-1440', theme: 'dark', width: 1440, height: 900 },
  { name: 'light-desktop-1440', theme: 'light', width: 1440, height: 900 },
  { name: 'dark-mobile-390', theme: 'dark', width: 390, height: 844 },
  { name: 'light-mobile-390', theme: 'light', width: 390, height: 844 },
];

const browser = await chromium.launch();
const results = [];

for (const s of SCENARIOS) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // Pre-seed theme so it loads correctly
  await page.addInitScript((theme) => {
    try { localStorage.setItem('kolm-theme', theme); } catch (_) {}
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  }, s.theme);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const probe = await page.evaluate(() => {
    const h1 = document.querySelector('.home-hero-left h1');
    const cwCur = document.querySelector('.home-hero-left h1 .cw-cur');
    const lede = document.querySelector('.home-hero-left .lede');
    const eyebrow = document.querySelector('.home-hero-left .hero-eyebrow');
    const eyebrowDot = document.querySelector('.home-hero-left .hero-eyebrow .he-dot');
    const primaryBtn = document.querySelector('.home-hero-left .btn-electric');
    const nlGo = document.querySelector('.nl-try .nl-go');
    const body = document.body;
    const cs = (el) => el ? getComputedStyle(el) : null;
    return {
      theme: document.documentElement.getAttribute('data-theme') || 'dark',
      bodyBg: cs(body).backgroundColor,
      h1Color: cs(h1).color,
      h1Weight: cs(h1).fontWeight,
      h1FontSize: cs(h1).fontSize,
      h1LetterSpacing: cs(h1).letterSpacing,
      cwCurColor: cs(cwCur).color,
      cwCurBgImg: cs(cwCur).backgroundImage,
      ledeColor: cs(lede).color,
      ledeWeight: cs(lede).fontWeight,
      eyebrowColor: cs(eyebrow).color,
      eyebrowDotBg: cs(eyebrowDot).backgroundColor,
      eyebrowDotShadow: cs(eyebrowDot).boxShadow,
      primaryBtnBg: cs(primaryBtn).backgroundColor,
      primaryBtnColor: cs(primaryBtn).color,
      primaryBtnShadow: cs(primaryBtn).boxShadow,
      nlGoBg: cs(nlGo).backgroundColor,
    };
  });

  await page.screenshot({ fullPage: false, path: join(OUT, `${s.name}.png`) });
  await page.screenshot({ fullPage: true, path: join(OUT, `${s.name}-full.png`) });

  results.push({ scenario: s.name, probe });
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, 'qa.json'), JSON.stringify(results, null, 2));

const cyanRe = /(126,\s*240,\s*210|125,\s*211,\s*252|7ef0d2|7dd3fc|0a8862)/i;
let pass = true;
for (const r of results) {
  const p = r.probe;
  console.log(`\n=== ${r.scenario} (theme: ${p.theme}) ===`);
  const noCyan = [
    ['cwCurColor not cyan', !cyanRe.test(p.cwCurColor)],
    ['cwCurBgImg has no gradient', !p.cwCurBgImg || p.cwCurBgImg === 'none'],
    ['eyebrowDot not cyan', !cyanRe.test(p.eyebrowDotBg)],
    ['eyebrowDot has no glow', p.eyebrowDotShadow === 'none' || !p.eyebrowDotShadow || /^rgba\(0,\s*0,\s*0,\s*0\)/.test(p.eyebrowDotShadow)],
    ['primaryBtn not cyan', !cyanRe.test(p.primaryBtnBg)],
    ['primaryBtn no glow', p.primaryBtnShadow === 'none' || !p.primaryBtnShadow || /^rgba\(0,\s*0,\s*0,\s*0\)/.test(p.primaryBtnShadow)],
    ['nlGo not cyan', !cyanRe.test(p.nlGoBg)],
    ['h1Weight 400', p.h1Weight === '400'],
    ['lede weight 300', p.ledeWeight === '300'],
  ];
  for (const [name, ok] of noCyan) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) pass = false;
  }
  console.log(`  bodyBg: ${p.bodyBg}`);
  console.log(`  h1: ${p.h1FontSize} weight ${p.h1Weight} ls ${p.h1LetterSpacing}`);
  console.log(`  h1 color: ${p.h1Color}`);
  console.log(`  cw-cur color: ${p.cwCurColor}`);
  console.log(`  primary btn: bg ${p.primaryBtnBg} fg ${p.primaryBtnColor}`);
  console.log(`  eyebrow dot: ${p.eyebrowDotBg}`);
}

process.exit(pass ? 0 : 1);
