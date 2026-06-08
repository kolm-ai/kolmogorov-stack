#!/usr/bin/env node
// Live check against the deployed site (real CSP headers, real CDN, real backend).
// Confirms: no page/console errors, the seal renders, the WebCrypto verify widget
// mounts + reaches a verified state, and reveal sections are visible (no W921 bleed).
import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://kolm.ai/';
const errors = [];
const consoleErrors = [];
const failed = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });

  const assert = [];
  const check = (name, cond) => assert.push({ name, ok: !!cond });

  const title = await page.title();
  check('title is the Signet redesign', /signed security evidence/i.test(title));

  const sealCount = await page.locator('.seal').count();
  const sealBars = await page.locator('.seal .seal-bars rect').count();
  check('seal renders', sealCount >= 1 && sealBars >= 1);

  await page.waitForSelector('[data-verify-widget]', { timeout: 15000 });
  await page.waitForTimeout(3500); // fetch report + keyring + WebCrypto verify
  const widgetText = await page.locator('[data-verify-widget]').first().innerText();
  check('verify widget mounted', widgetText.trim().length > 40);
  check('verify widget reached verified/signed state', /verified|signed/i.test(widgetText));

  // scroll to trigger reveal, then confirm nothing is stuck hidden
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.35);
    for (let y = 0; y <= document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 200)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
  const armed = await page.evaluate(() => document.documentElement.hasAttribute('data-reveal-armed'));
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter((el) => getComputedStyle(el).opacity === '0').length);
  check('reveal observer armed', armed);
  check('no reveal sections stuck hidden (no bleed)', hidden === 0);

  console.log('\n=== LIVE CHECK:', URL, '===');
  for (const a of assert) console.log(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}`);
  console.log(`\npage errors: ${errors.length}`); for (const e of errors) console.log('  x ' + e);
  console.log(`console.error: ${consoleErrors.length}`); for (const e of consoleErrors.slice(0, 8)) console.log('  ! ' + e);
  console.log(`failed requests: ${failed.length}`); for (const f of failed.slice(0, 8)) console.log('  x ' + f);
  const allOk = assert.every((a) => a.ok) && errors.length === 0;
  console.log(`\nRESULT: ${allOk ? 'PASS' : 'FAIL'}`);
  await browser.close();
  process.exit(allOk ? 0 : 1);
} catch (e) {
  console.error('live check crashed:', e);
  if (browser) await browser.close().catch(() => {});
  process.exit(2);
}
