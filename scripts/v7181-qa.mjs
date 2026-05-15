#!/usr/bin/env node
/* v7.18.1 QA — verify cinematic hero backdrop is incredible, not half-ass.
 * Captures: 1440 desktop hero, 1440 desktop fullpage, 390 mobile hero, 390 mobile fullpage,
 * and 3 hero stills over time so we can verify constellation animation evolves.
 */
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

  // Hero stills t0, t+1.4s, t+3.0s (catches mid word-cycle + constellation drift)
  await page.screenshot({ path: `tmp/v7181-${name}-hero-t0.png`, fullPage: false });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `tmp/v7181-${name}-hero-t1.png`, fullPage: false });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `tmp/v7181-${name}-hero-t2.png`, fullPage: false });

  // Full page for context
  await page.screenshot({ path: `tmp/v7181-${name}-full.png`, fullPage: true });

  // Probe critical layers
  const probe = await page.evaluate(() => {
    const canvas = document.querySelector('.home-hero-centered .hero-constellation');
    const beam = document.querySelector('.home-hero-centered .hero-beam');
    const grain = document.querySelector('.home-hero-centered .hero-grain');
    const cw = document.querySelector('.home-hero-centered h1 .cw-cur');
    const heroBgCss = beam ? getComputedStyle(beam) : null;
    return {
      hasCanvas: !!canvas,
      canvasW: canvas ? canvas.width : 0,
      canvasH: canvas ? canvas.height : 0,
      canvasOpacity: canvas ? parseFloat(getComputedStyle(canvas).opacity) : 0,
      hasBeam: !!beam,
      beamAnim: heroBgCss ? heroBgCss.animationName : '',
      hasGrain: !!grain,
      grainAnim: grain ? getComputedStyle(grain).animationName : '',
      cycleWord: cw ? cw.textContent : '',
      cycleHasFadeClass: cw ? cw.classList.contains('cw-fade') : false,
      cycleTransition: cw ? getComputedStyle(cw).transitionProperty : '',
    };
  });

  await ctx.close();
  return { probe, errs };
}

console.log('--- 1440 desktop ---');
const d = await shoot(1440, 900, '1440');
console.log(JSON.stringify(d.probe, null, 2));
if (d.errs.length) { console.log('errs:'); d.errs.forEach(e => console.log('  ' + e)); }

console.log('--- 390 mobile ---');
const m = await shoot(390, 844, '390');
console.log(JSON.stringify(m.probe, null, 2));
if (m.errs.length) { console.log('errs:'); m.errs.forEach(e => console.log('  ' + e)); }

await browser.close();

// Pixel diff between t0 and t1 to confirm constellation is actually animating
import('child_process').then(async cp => {
  // Use a simple file-size + bytes diff sniff; full pixel diff requires pixelmatch.
  const fs = await import('fs');
  function bytes(p) { try { return fs.statSync(p).size; } catch { return 0; } }
  const a = bytes('tmp/v7181-1440-hero-t0.png');
  const b = bytes('tmp/v7181-1440-hero-t1.png');
  const c = bytes('tmp/v7181-1440-hero-t2.png');
  console.log('\nframe sizes:', { t0: a, t1: b, t2: c });
  console.log('frames differ? t0!=t1:', a !== b, 't1!=t2:', b !== c);
});

console.log('\ndone. screenshots in tmp/v7181-*');
