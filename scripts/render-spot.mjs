// render-spot.mjs — screenshot a set of secondary pages and report page/console
// errors + failed requests. Reuses the static-server pattern from render-check-home.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'spot');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p = p + 'index.html';
  let abs = path.join(PUB, p);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { const idx = path.join(abs, 'index.html'); if (fs.existsSync(idx)) return idx; }
  if (fs.existsSync(abs + '.html')) return abs + '.html';
  return null;
}
const server = http.createServer((req, res) => {
  const file = resolveFile(req.url === '/' ? '/index.html' : req.url);
  if (!file) { res.statusCode = 404; res.end('not found: ' + req.url); return; }
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;

const PAGES = process.argv.slice(2);
if (!PAGES.length) PAGES.push('/how-it-works', '/pricing', '/verify', '/security', '/privacy', '/checks', '/contact', '/research');

let browser, bad = 0;
try {
  browser = await chromium.launch();
  for (const route of PAGES) {
    const errors = [], consoleErrors = [], failed = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(base)) failed.push(`${u} :: ${r.failure()?.errorText}`); });
    await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 });
    // scroll to fire reveals
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
    await new Promise((r) => setTimeout(r, 250));
    // any reveal sections stuck invisible? (W921 bleed guard)
    const hidden = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('.reveal').forEach((el) => { const s = getComputedStyle(el); if (parseFloat(s.opacity) < 0.5) n++; });
      return n;
    });
    const eyebrowVisible = await page.evaluate(() => document.querySelectorAll('.eyebrow').length);
    const name = route.replace(/\//g, '_').replace(/^_/, '') || 'home';
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    const issues = [];
    if (errors.length) issues.push(`pageerr=${errors.length}`);
    if (consoleErrors.length) issues.push(`console=${consoleErrors.length}`);
    if (failed.length) issues.push(`failedReq=${failed.length}`);
    if (hidden > 0) issues.push(`hiddenReveal=${hidden}`);
    if (issues.length) bad++;
    console.log(`${issues.length ? 'FAIL ' : 'ok   '}${route}  revealHidden=${hidden} eyebrowEls=${eyebrowVisible}${issues.length ? '  :: ' + issues.join(' ') : ''}`);
    if (errors.length) console.log('   pageerrors: ' + errors.join(' | '));
    if (consoleErrors.length) console.log('   console: ' + consoleErrors.slice(0, 4).join(' | '));
    if (failed.length) console.log('   failed: ' + failed.slice(0, 6).join(' | '));
    await page.close();
  }
} finally { if (browser) await browser.close(); server.close(); }
console.log('\n' + (bad ? `SPOT: ${bad} page(s) with issues` : 'SPOT: PASS — all pages clean'));
process.exit(bad ? 1 : 0);
