#!/usr/bin/env node
// Render check for the kolm.ai Evidence Room (v2) homepage + live verify widget.
// Serves public/ statically (correct MIME types + clean-URL -> .html + ES modules).
// Page 1 "/": asserts the v2 homepage surfaces — hero with accent phrase, the
//   signed-report artifact (sheet, severity bar, signature footer with the real
//   key material), idx section rhythm, the raised proof panel, the price ledger,
//   the closing CTA band, and full reveal coverage (W921: armed + .in + opaque).
// Page 2 "/report": the live verify widget (moved off the homepage by design) —
//   mounts, verifies the sample via WebCrypto, seals, surfaces demo provenance,
//   and tamper flips the seal to VOID.
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
  // API-backed surfaces fetch /v1/* on load; answer with the unauthenticated
  // response so pages render their real logged-out state instead of a 404.
  if (req.url.startsWith('/v1/')) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end('{"ok":false,"error":"unauthorized"}');
    return;
  }
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
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const src = (m.location() && m.location().url) || '';
    if (src.includes('/v1/')) return; // expected logged-out 401s
    consoleErrors.push(m.text());
  });
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith(base)) failed.push(`${u} :: ${r.failure()?.errorText}`);
  });

  const assert = [];
  const check = (name, cond) => assert.push({ name, ok: !!cond });

  // ---------- Page 1: the v2 homepage ----------
  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });

  // hero: accent phrase + mono proof line
  check('hero h1 has accent phrase (h1 .go)', (await page.locator('h1 .go').count()) >= 1);
  check('hero proof line present (.hero__proof)', (await page.locator('.hero__proof').count()) >= 1);

  // the signed-report artifact is the hero exhibit
  check('artifact plinth present (.artifact)', (await page.locator('.artifact').count()) >= 1);
  check('report sheet renders (.rep__sheet)', (await page.locator('.artifact .rep__sheet').count()) >= 1);
  check('severity bar renders (.sev__bar)', (await page.locator('.artifact .sev__bar').count()) >= 1);
  const sigText = await page.locator('.rep__sig').first().innerText().catch(() => '');
  check('signature footer shows the real signature', /9kWQBu5kLl/.test(sigText));
  check('signature footer shows the signing key', /410302c93becdcc3/.test(sigText));

  // section rhythm + the six-beat structure
  check('section indices present (>=4 .idx)', (await page.locator('.idx').count()) >= 4);
  check('raised proof panel present (.section--ink)', (await page.locator('.section--ink').count()) >= 1);
  check('price ledger present (.plate--rows with >=4 .prow)', (await page.locator('.plate--rows .prow').count()) >= 4);
  check('closing CTA band present (.cta-final)', (await page.locator('.cta-final').count()) >= 1);

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
  await page.screenshot({ path: path.join(OUT, 'home-hero.png'), clip: { x: 0, y: 0, width: 1440, height: 1024 } });
  await page.locator('.artifact').first().screenshot({ path: path.join(OUT, 'home-artifact.png') }).catch(() => {});

  // ---------- Page 2: the live verify widget on /report ----------
  await page.goto(base + '/report', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-verify-widget]', { timeout: 10000 });
  // give the widget time to fetch the sample + keyring and run WebCrypto verify
  await page.waitForTimeout(2500);

  const widget = page.locator('[data-verify-widget]').first();
  const widgetText = await widget.innerText();
  check('verify widget mounted with content', widgetText.trim().length > 40);
  check('verify widget shows a verified/signed status', /verified|signed|void/i.test(widgetText));
  // the live demo uses the demo issuer key — must surface as demo, not production
  check('demo provenance surfaced (not shown as production)', /demo|sample|unknown/i.test(widgetText));

  const sealCount = await page.locator('[data-verify-widget] .seal, .seal').count();
  const sealBars = await page.locator('.seal .seal-bars rect').count();
  check('seal element present', sealCount >= 1);
  check('seal has bar geometry (>=1 rect)', sealBars >= 1);
  const sealedClass = await page.locator('.seal').first().evaluate((el) => el.classList.contains('is-sealed')).catch(() => false);
  check('seal is in sealed state (after live verify)', sealedClass);

  await widget.screenshot({ path: path.join(OUT, 'report-widget.png') }).catch(() => {});

  // tamper -> VOID
  const tamperBtn = page.locator('[data-verify-widget] button', { hasText: /inflate|tamper/i }).first();
  const hasTamper = await tamperBtn.count();
  check('tamper control present', hasTamper >= 1);
  if (hasTamper) {
    await tamperBtn.click();
    await page.waitForTimeout(1500);
    const afterText = await widget.innerText();
    const sealVoid = await page.locator('.seal.is-void').count();
    check('after tamper: seal shows VOID state', sealVoid >= 1);
    check('after tamper: widget reports rejected/void', /void|reject|fail|invalid|broke|tamper/i.test(afterText));
    await page.screenshot({ path: path.join(OUT, 'report-after-tamper.png'), fullPage: false });
  }

  // report
  console.log('\n=== RENDER CHECK: kolm.ai v2 homepage + live widget ===');
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
