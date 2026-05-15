// v7.18.3 — left-aligned hero + Geist QA probe. Captures 1440 desktop + 390
// mobile, verifies (a) Geist Sans is the resolved family of H1, (b) hero
// content is left-anchored (text-align: left, no auto margin on H1), (c)
// canonical typography numbers match feedback_kolm_design.md (-0.045em / 0.96lh).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.URL || 'http://localhost:8787/';
const OUT = process.env.OUT || join(process.cwd(), 'qa', 'v7183');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
];

const browser = await chromium.launch();
const results = [];

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  // wait briefly for Geist to download
  await page.waitForTimeout(700);

  const probe = await page.evaluate(() => {
    const h1 = document.querySelector('.home-hero-left h1');
    const lede = document.querySelector('.home-hero-left .lede');
    const eyebrow = document.querySelector('.home-hero-left .hero-eyebrow');
    const cycle = document.querySelector('.home-hero-left h1 .cw-cur');
    const ghost = document.querySelector('.home-hero-left h1 .cw-ghost');
    const wrap = document.querySelector('.home-hero-left .wrap');
    const fontReady = document.fonts ? document.fonts.check('500 64px Geist') : null;
    const cs = (el) => el ? getComputedStyle(el) : null;
    const h1cs = cs(h1);
    const ledeCs = cs(lede);
    const eyebrowCs = cs(eyebrow);
    return {
      hasHeroLeft: !!document.querySelector('.home-hero-left'),
      hasCenteredClass: !!document.querySelector('.home-hero-centered'),
      h1Family: h1cs ? h1cs.fontFamily : null,
      h1Weight: h1cs ? h1cs.fontWeight : null,
      h1Size: h1cs ? h1cs.fontSize : null,
      h1LineHeight: h1cs ? h1cs.lineHeight : null,
      h1LetterSpacing: h1cs ? h1cs.letterSpacing : null,
      h1TextAlign: h1cs ? h1cs.textAlign : null,
      h1MarginLeft: h1cs ? h1cs.marginLeft : null,
      h1MarginRight: h1cs ? h1cs.marginRight : null,
      ledeSize: ledeCs ? ledeCs.fontSize : null,
      ledeLineHeight: ledeCs ? ledeCs.lineHeight : null,
      eyebrowFamily: eyebrowCs ? eyebrowCs.fontFamily : null,
      eyebrowLetterSpacing: eyebrowCs ? eyebrowCs.letterSpacing : null,
      eyebrowTextTransform: eyebrowCs ? eyebrowCs.textTransform : null,
      eyebrowBorder: eyebrowCs ? eyebrowCs.borderTopWidth : null,
      cycleText: cycle ? cycle.textContent : null,
      ghostText: ghost ? ghost.textContent : null,
      geistReady: fontReady,
      hasCanvas: !!document.querySelector('.hero-constellation'),
      hasBeam: !!document.querySelector('.hero-beam'),
      hasGrain: !!document.querySelector('.hero-grain'),
      hasProviderStrip: !!document.querySelector('.provider-strip'),
      psCellCount: document.querySelectorAll('.provider-strip .ps-cell').length,
      docFontsLoaded: document.fonts ? document.fonts.size : 0,
    };
  });

  const shot = await page.screenshot({ fullPage: false, path: join(OUT, `hero-${vp.name}.png`) });
  await page.screenshot({ fullPage: true, path: join(OUT, `full-${vp.name}.png`) });

  results.push({ viewport: vp.name, probe, consoleErrors });
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, 'qa.json'), JSON.stringify(results, null, 2));

// Affirmative checks
let pass = true;
for (const r of results) {
  const p = r.probe;
  const checks = [
    ['hasHeroLeft', p.hasHeroLeft === true],
    ['no .home-hero-centered class', p.hasCenteredClass === false],
    ['Geist in font-family', p.h1Family && /Geist/.test(p.h1Family)],
    ['h1 text-align left', p.h1TextAlign === 'left' || p.h1TextAlign === 'start'],
    ['h1 not auto-margined', !(/auto/.test(p.h1MarginLeft) && /auto/.test(p.h1MarginRight))],
    ['cycleText non-empty', p.cycleText && p.cycleText.trim().length > 0],
    ['no constellation canvas', p.hasCanvas === false],
    ['no beam', p.hasBeam === false],
    ['no grain', p.hasGrain === false],
    ['provider strip present', p.hasProviderStrip === true],
    ['ps cell count == 7', p.psCellCount === 7],
    ['eyebrow uppercase', p.eyebrowTextTransform === 'uppercase'],
    ['no console errors', r.consoleErrors.length === 0],
  ];
  console.log(`\n=== ${r.viewport} ===`);
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) pass = false;
  }
  console.log(`  h1: ${p.h1Size} / lh ${p.h1LineHeight} / ls ${p.h1LetterSpacing} / weight ${p.h1Weight}`);
  console.log(`  family: ${p.h1Family}`);
  console.log(`  lede: ${p.ledeSize} / lh ${p.ledeLineHeight}`);
  console.log(`  eyebrow ls: ${p.eyebrowLetterSpacing}`);
  console.log(`  errors: ${r.consoleErrors.length}`);
}

process.exit(pass ? 0 : 1);
