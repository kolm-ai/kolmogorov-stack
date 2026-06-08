// render-hero.mjs — high-fidelity viewport (not full-page) captures of the flagship
// above-the-fold + the verify section, at desktop and mobile, for close self-review.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'audit-shots');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
function resolveFile(urlPath) { let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = resolveFile(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
// wait for every live verify widget to finish its real verification, so the shot
// shows the settled PASS/VOID state instead of a mid-stream "VERIFYING…".
async function settleWidgets(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const widgets = [...document.querySelectorAll('.vw[data-verify-widget]')];
    if (!widgets.length) return resolve();
    const done = () => widgets.every((w) => w.querySelector('.vw__status.is-ok, .vw__status.is-bad, .seal.is-sealed, .seal.is-void'));
    const t0 = Date.now();
    const iv = setInterval(() => { if (done() || Date.now() - t0 > 7000) { clearInterval(iv); resolve(); } }, 120);
  }));
  await page.waitForTimeout(250);
}
async function shot(name, vp, dsf, sel, fullPage) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: dsf });
  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await settleWidgets(page);
  await page.addStyleTag({ content: '.reveal{opacity:1 !important;transform:none !important;} .js-reveal .reveal{opacity:1 !important;}' });
  await page.evaluate(() => document.documentElement.classList.remove('js-reveal'));
  await new Promise((r) => setTimeout(r, 400));
  if (sel) { const el = await page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await new Promise((r) => setTimeout(r, 250)); } }
  const out = path.join(OUT, name);
  await page.screenshot({ path: out, fullPage: !!fullPage });
  await page.close();
  console.log('wrote', path.relative(ROOT, out));
}
await shot('home.hero.desktop.png', { w: 1440, h: 900 }, 2);
await shot('home.verify.desktop.png', { w: 1440, h: 900 }, 2, '#verify');
await shot('home.hero.mobile.png', { w: 390, h: 844 }, 3);
// regenerate the full-page critique shots with the widget settled
await shot('home.desktop.png', { w: 1440, h: 1024 }, 1, null, true);
await shot('home.mobile.png', { w: 390, h: 844 }, 1, null, true);
await browser.close(); server.close();
