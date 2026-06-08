#!/usr/bin/env node
// Render check for the Signet homepage redesign.
// Serves public/ statically (correct MIME types + clean-URL -> .html + ES modules),
// loads "/", captures console + pageerror, then asserts the live surfaces:
//   1. the seal SVG renders in the hero exhibit plate (static, sealed)
//   2. the verify widget mounts, runs report-mode verify, shows a status pill
//   3. tamper ("Inflate the score") flips the seal to VOID and the pill to rejected
// Exits non-zero on any page error or failed assertion. Writes screenshots to tmp/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p = p + 'index.html';
  let abs = path.join(PUB, p);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const idx = path.join(abs, 'index.html');
    if (fs.existsSync(idx)) return idx;
  }
  if (fs.existsSync(abs + '.html')) return abs + '.html';
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url === '/' ? '/index.html' : req.url);
  if (!file) {
    res.statusCode = 404;
    res.end('not found: ' + req.url);
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const base = `http://127.0.0.1:${port}`;

const errors = [];
const consoleErrors = [];
const failed = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith(base)) failed.push(`${u} :: ${r.failure()?.errorText}`);
  });

  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });

  const assert = [];
  const check = (name, cond) => assert.push({ name, ok: !!cond });

  // 1. hero seal renders. The hero exhibit IS the live verifier now (not a static
  // decorative seal), so the seal mounts immediately but only flips to is-sealed
  // once the async WebCrypto verify of the signed report resolves a tick later.
  const heroSeal = await page.locator('.seal').first();
  const heroSealCount = await page.locator('.seal').count();
  const sealBars = await page.locator('.seal .seal-bars rect').count();
  check('hero seal element present', heroSealCount >= 1);
  check('seal has bar geometry (>=1 rect)', sealBars >= 1);

  // 2. verify widget mounted + report run produced a status pill
  await page.waitForSelector('[data-verify-widget]', { timeout: 10000 });
  // give the widget time to fetch report + keyring + run WebCrypto verify
  await page.waitForTimeout(2500);
  // now that the live verify has resolved, the hero seal must read SEALED (PASS)
  const heroSealedClass = await heroSeal.evaluate((el) => el.classList.contains('is-sealed')).catch(() => false);
  check('hero seal is in sealed state (after live verify)', heroSealedClass);
  const widgetText = await page.locator('[data-verify-widget]').first().innerText();
  const pillText = await page.locator('[data-verify-widget] .vw__pill, [data-verify-widget] [class*="pill"]').first().innerText().catch(() => '');
  check('verify widget mounted with content', widgetText.trim().length > 40);
  check('verify widget shows a verified/signed status', /verified|signed|void/i.test(widgetText));
  // the live demo uses the demo issuer key — must surface as demo, not production
  check('demo provenance surfaced (not shown as production)', /demo|sample|unknown/i.test(widgetText));

  // scroll through the page slowly to trigger the real IntersectionObserver reveal
  // (fine steps + enough dwell for the async callback), then confirm every section
  // both got the .in class (observer fired) and is fully opaque (no W921 bleed).
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.35);
    for (let y = 0; y <= document.body.scrollHeight + window.innerHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 220));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900); // let the 600ms opacity transitions settle
  const revealTotal = await page.locator('.reveal').count();
  const revealShown = await page.locator('.reveal.in').count();
  const armed = await page.evaluate(() => document.documentElement.hasAttribute('data-reveal-armed'));
  const anyHidden = await page.evaluate(() =>
    [...document.querySelectorAll('.reveal')].filter((el) => getComputedStyle(el).opacity === '0').length);
  check('reveal sections present', revealTotal >= 1);
  check('reveal observer armed (animation active, not failsafe-stripped)', armed);
  check('every reveal section fired its animation (.in coverage)', revealShown === revealTotal);
  check('all reveal sections fully visible after scroll (no bleed)', anyHidden === 0);

  await page.screenshot({ path: path.join(OUT, 'home-full.png'), fullPage: true });
  await page.locator('#verify, .vault').first().screenshot({ path: path.join(OUT, 'home-verify-vault.png') }).catch(() => {});
  // capture above-the-fold hero crop for tight aesthetic review
  await page.screenshot({ path: path.join(OUT, 'home-hero.png'), clip: { x: 0, y: 0, width: 1440, height: 1024 } });

  // 3. tamper -> VOID
  const tamperBtn = page.locator('[data-verify-widget] button', { hasText: /inflate|tamper/i }).first();
  const hasTamper = await tamperBtn.count();
  check('tamper control present', hasTamper >= 1);
  if (hasTamper) {
    await tamperBtn.click();
    await page.waitForTimeout(1500);
    const afterText = await page.locator('[data-verify-widget]').first().innerText();
    const sealVoid = await page.locator('[data-verify-widget] .seal.is-void, .seal.is-void').count();
    check('after tamper: seal shows VOID state', sealVoid >= 1);
    check('after tamper: widget reports rejected/void', /void|reject|fail|invalid|broke/i.test(afterText));
    await page.screenshot({ path: path.join(OUT, 'home-after-tamper.png'), fullPage: false });
  }

  // report
  console.log('\n=== RENDER CHECK: Signet homepage ===');
  for (const a of assert) console.log(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}`);
  console.log(`\npage errors: ${errors.length}`);
  for (const e of errors) console.log('  ✖ ' + e);
  console.log(`console.error: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 10)) console.log('  ⚠ ' + e);
  console.log(`failed requests: ${failed.length}`);
  for (const f of failed.slice(0, 10)) console.log('  ✖ ' + f);

  const allOk = assert.every((a) => a.ok) && errors.length === 0;
  console.log(`\nRESULT: ${allOk ? 'PASS' : 'FAIL'}`);
  await browser.close();
  server.close();
  process.exit(allOk ? 0 : 1);
} catch (e) {
  console.error('render check crashed:', e);
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.exit(2);
}
