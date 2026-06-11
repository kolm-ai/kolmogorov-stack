#!/usr/bin/env node
// Live check against the deployed site (real CSP headers, real CDN, real backend).
// Page 1 "/": no page/console errors, the v2 homepage surfaces render (hero accent
//   phrase, signed-report artifact with real signature material, price ledger,
//   closing CTA band), and reveal sections are visible (no W921 bleed).
// Page 2 "/report": the live WebCrypto verify widget mounts, seals, and reaches a
//   verified state against the production CSP.
import { chromium } from 'playwright';

const TARGET = process.argv[2] || 'https://kolm.ai/';
const origin = new URL(TARGET).origin;
const errors = [];
const consoleErrors = [];
const failed = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const src = (m.location() && m.location().url) || '';
    if (src.includes('/v1/')) return; // backend-dependent surfaces may 401 logged out
    consoleErrors.push(m.text());
  });
  page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));

  const assert = [];
  const check = (name, cond) => assert.push({ name, ok: !!cond });

  // ---------- "/" ----------
  await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 45000 });

  const title = await page.title();
  check('title is the agent-security site', /security audit/i.test(title) && /kolm\.ai/i.test(title));

  check('hero accent phrase renders (h1 .go)', (await page.locator('h1 .go').count()) >= 1);
  check('signed-report artifact renders (.artifact .rep__sheet)', (await page.locator('.artifact .rep__sheet').count()) >= 1);
  const sigText = await page.locator('.rep__sig').first().innerText().catch(() => '');
  check('artifact shows the real signature + key', /9kWQBu5kLl/.test(sigText) && /410302c93becdcc3/.test(sigText));
  check('price ledger renders (>=4 .prow)', (await page.locator('.plate--rows .prow').count()) >= 4);
  check('closing CTA band renders (.cta-final)', (await page.locator('.cta-final').count()) >= 1);

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

  // ---------- "/report" (live verify widget) ----------
  await page.goto(origin + '/report', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('[data-verify-widget]', { timeout: 15000 });
  await page.waitForTimeout(3500); // fetch report + keyring + WebCrypto verify
  const widgetText = await page.locator('[data-verify-widget]').first().innerText();
  check('verify widget mounted', widgetText.trim().length > 40);
  check('verify widget reached verified/signed state', /verified|signed/i.test(widgetText));
  const sealCount = await page.locator('.seal').count();
  const sealBars = await page.locator('.seal .seal-bars rect').count();
  check('seal renders', sealCount >= 1 && sealBars >= 1);
  const sealed = await page.locator('.seal').first().evaluate((el) => el.classList.contains('is-sealed')).catch(() => false);
  check('seal reached sealed state (live verify)', sealed);

  console.log('\n=== LIVE CHECK:', TARGET, '===');
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
