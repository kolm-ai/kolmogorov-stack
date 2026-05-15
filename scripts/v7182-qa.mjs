#!/usr/bin/env node
/* v7.18.2 QA — verify SOTA-clean hero: no constellation, no ticker, no
 * sections 02/03 (electric-callout + kscore-viz). Provider strip is the
 * new SOTA-clean caption + display-weight names. */
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.URL || 'http://localhost:8787';
fs.mkdirSync('tmp', { recursive: true });
const browser = await chromium.launch();

async function shoot(width, height, name) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(URL + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);

  await page.screenshot({ path: `tmp/v7182-${name}-hero.png`, fullPage: false });
  await page.screenshot({ path: `tmp/v7182-${name}-full.png`, fullPage: true });

  const probe = await page.evaluate(() => {
    const hero = document.querySelector('.home-hero-centered');
    const heroBg = document.querySelector('.home-hero-centered .hero-grid-bg');
    const ps = document.querySelector('.provider-strip');
    const psCaption = document.querySelector('.provider-strip .ps-caption');
    const psCells = document.querySelectorAll('.provider-strip .ps-cell');
    const cw = document.querySelector('.home-hero-centered h1 .cw-cur');
    const ghost = document.querySelector('.home-hero-centered h1 .cw-ghost');
    return {
      hasCanvas: !!document.querySelector('.home-hero-centered .hero-constellation'),
      hasBeam: !!document.querySelector('.home-hero-centered .hero-beam'),
      hasGrain: !!document.querySelector('.home-hero-centered .hero-grain'),
      hasHeroSupported: !!document.querySelector('.home-hero-centered .hero-supported'),
      hasTicker: !!document.querySelector('.ticker'),
      hasElectricCallout: !!document.querySelector('.electric-callout'),
      hasKscoreViz: !!document.querySelector('.kscore-viz'),
      hasProviderStrip: !!ps,
      psCaption: psCaption ? psCaption.textContent.trim() : null,
      psCellCount: psCells.length,
      psCellNames: Array.from(psCells).map(c => c.textContent.trim()),
      h1Text: document.querySelector('.home-hero-centered h1') ? document.querySelector('.home-hero-centered h1').innerText : '',
      cycleWord: cw ? cw.textContent : '',
      ghostWord: ghost ? ghost.textContent : '',
      heroBgImg: heroBg ? getComputedStyle(heroBg).backgroundImage.length : 0,
      heroBgSize: heroBg ? getComputedStyle(heroBg).backgroundSize : '',
      sectionCount: document.querySelectorAll('main > section').length,
    };
  });

  await ctx.close();
  return { probe, errs };
}

console.log('--- 1440 desktop ---');
const d = await shoot(1440, 900, '1440');
console.log(JSON.stringify(d.probe, null, 2));
if (d.errs.length) { console.log('errs:'); d.errs.forEach(e => console.log('  ' + e)); }

console.log('\n--- 390 mobile ---');
const m = await shoot(390, 844, '390');
console.log(JSON.stringify(m.probe, null, 2));
if (m.errs.length) { console.log('errs:'); m.errs.forEach(e => console.log('  ' + e)); }

await browser.close();

const fail = [];
if (d.probe.hasCanvas) fail.push('hero-constellation should be removed');
if (d.probe.hasBeam) fail.push('hero-beam should be removed');
if (d.probe.hasGrain) fail.push('hero-grain should be removed');
if (d.probe.hasHeroSupported) fail.push('in-hero supported row should be removed');
if (d.probe.hasTicker) fail.push('ticker should be removed');
if (d.probe.hasElectricCallout) fail.push('section 02 (electric-callout) should be removed');
if (d.probe.hasKscoreViz) fail.push('section 03 (kscore-viz) should be removed');
if (!d.probe.hasProviderStrip) fail.push('provider-strip missing');
if (d.probe.psCellCount !== 7) fail.push(`expected 7 provider cells, got ${d.probe.psCellCount}`);

console.log('\n--- verdict ---');
if (fail.length) { console.log('FAIL:'); fail.forEach(f => console.log('  ' + f)); process.exit(1); }
else { console.log('PASS — v7.18.2 SOTA-clean hero verified'); }
