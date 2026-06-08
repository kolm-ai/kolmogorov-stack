// render-review.mjs — authoritative per-page render check + full-page screenshot.
// Uses the CAREFUL scroll (0.35*vh steps, 220ms dwell) so IntersectionObserver
// reveals actually fire, then asserts no .reveal stuck invisible and captures
// page/console/request errors. Screenshots land in tmp/review/ for visual review.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'review');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
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
if (!PAGES.length) PAGES.push('/', '/how-it-works', '/checks', '/pricing', '/verify', '/trust', '/platform', '/enterprise', '/report', '/security', '/security/threat-model', '/contact', '/research', '/solutions/ai-vendors', '/solutions/enterprise-buyers', '/docs', '/privacy', '/terms', '/dpa', '/baa', '/sla', '/acceptable-use', '/subprocessors', '/transparency-log', '/status', '/changelog', '/careers', '/404');

let browser, bad = 0;
try {
  browser = await chromium.launch();
  for (const route of PAGES) {
    const errors = [], consoleErrors = [], failed = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(base)) failed.push(`${u} :: ${r.failure()?.errorText}`); });
    await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 });
    // CAREFUL scroll so reveals fire
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.35);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 220)); }
      window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 320));
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 120));
    });
    const rv = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.reveal')];
      let hidden = 0; all.forEach((el) => { if (parseFloat(getComputedStyle(el).opacity) < 0.5) hidden++; });
      const ink = document.querySelectorAll('.section--ink').length;
      const cta = document.querySelectorAll('.cta-final').length;
      const idx = document.querySelectorAll('.idx').length;
      return { total: all.length, hidden, ink, cta, idx };
    });
    const name = route.replace(/\//g, '_').replace(/^_/, '') || 'home';
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    const issues = [];
    if (errors.length) issues.push(`pageerr=${errors.length}`);
    if (consoleErrors.length) issues.push(`console=${consoleErrors.length}`);
    if (failed.length) issues.push(`failedReq=${failed.length}`);
    if (rv.hidden > 0) issues.push(`revealHidden=${rv.hidden}/${rv.total}`);
    if (issues.length) bad++;
    console.log(`${issues.length ? 'FAIL ' : 'ok   '}${route.padEnd(34)} reveal=${rv.total} ink=${rv.ink} cta=${rv.cta} idx=${rv.idx}${issues.length ? '  :: ' + issues.join(' ') : ''}`);
    if (errors.length) console.log('   pageerrors: ' + errors.slice(0, 3).join(' | '));
    if (consoleErrors.length) console.log('   console: ' + consoleErrors.slice(0, 3).join(' | '));
    if (failed.length) console.log('   failed: ' + failed.slice(0, 4).join(' | '));
    await page.close();
  }
} finally { if (browser) await browser.close(); server.close(); }
console.log('\n' + (bad ? `REVIEW: ${bad} page(s) with issues` : 'REVIEW: PASS — all pages clean, reveals fire'));
process.exit(bad ? 1 : 0);
