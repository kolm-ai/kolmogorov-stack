// render-audit-shots.mjs — full-page screenshots of every page at desktop (1440)
// AND mobile (390) widths, into tmp/audit-shots/. Names: <slug>.desktop.png /
// <slug>.mobile.png. Also emits a manifest.json mapping route -> {html, desktop,
// mobile, pageerr, console, failedReq, hiddenReveal}. Static-server pattern reused
// from render-spot.mjs so it runs against the local working tree (pre-deploy truth).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'audit-shots');
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

const ROUTES = [
  '/', '/404', '/acceptable-use', '/baa', '/careers', '/changelog', '/checks',
  '/contact', '/docs', '/dpa', '/enterprise', '/how-it-works', '/platform',
  '/pricing', '/privacy', '/report', '/research', '/security', '/security/threat-model',
  '/sla', '/solutions/ai-vendors', '/solutions/enterprise-buyers', '/status',
  '/subprocessors', '/terms', '/transparency-log', '/trust', '/verify',
];

function slug(route) { return (route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '_')); }
function htmlPath(route) {
  const f = resolveFile(route === '/' ? '/index.html' : route);
  return f ? path.relative(ROOT, f).replace(/\\/g, '/') : null;
}

const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 1024 }, { name: 'mobile', width: 390, height: 844 }];
const manifest = [];
let browser, bad = 0;
try {
  browser = await chromium.launch();
  for (const route of ROUTES) {
    const rec = { route, slug: slug(route), html: htmlPath(route), shots: {}, pageerr: 0, console: 0, failedReq: 0, hiddenReveal: 0 };
    for (const vp of VIEWPORTS) {
      const errors = [], consoleErrors = [], failed = [];
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(base)) failed.push(`${u} :: ${r.failure()?.errorText}`); });
      await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 });
      // let any live verify widget settle to its real PASS/VOID state before the shot
      await page.evaluate(() => new Promise((resolve) => {
        const widgets = [...document.querySelectorAll('.vw[data-verify-widget]')];
        if (!widgets.length) return resolve();
        const done = () => widgets.every((w) => w.querySelector('.vw__status.is-ok, .vw__status.is-bad, .seal.is-sealed, .seal.is-void'));
        const t0 = Date.now();
        const iv = setInterval(() => { if (done() || Date.now() - t0 > 7000) { clearInterval(iv); resolve(); } }, 120);
      }));
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); } window.scrollTo(0, 0); });
      await new Promise((r) => setTimeout(r, 200));
      // Capture the FULLY-REVEALED design (reveal timing is verified separately by
      // live-check). Force the fail-open path so no scroll-armed section is blank.
      const hidden = await page.evaluate(() => { let n = 0; document.querySelectorAll('.reveal').forEach((el) => { if (parseFloat(getComputedStyle(el).opacity) < 0.5) n++; }); return n; });
      await page.addStyleTag({ content: '.reveal{opacity:1 !important; transform:none !important; filter:none !important;} .js-reveal .reveal{opacity:1 !important;}' });
      await page.evaluate(() => document.documentElement.classList.remove('js-reveal'));
      await new Promise((r) => setTimeout(r, 150));
      const out = path.join(OUT, `${rec.slug}.${vp.name}.png`);
      await page.screenshot({ path: out, fullPage: true });
      rec.shots[vp.name] = path.relative(ROOT, out).replace(/\\/g, '/');
      rec.pageerr += errors.length; rec.console += consoleErrors.length; rec.failedReq += failed.length; rec.hiddenReveal = Math.max(rec.hiddenReveal, hidden);
      if (errors.length || consoleErrors.length || failed.length || hidden > 0) { bad++; }
      await page.close();
    }
    manifest.push(rec);
    console.log(`shot ${rec.slug}  err=${rec.pageerr} con=${rec.console} fail=${rec.failedReq} hidden=${rec.hiddenReveal}`);
  }
} finally { if (browser) await browser.close(); server.close(); }
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nrendered ${manifest.length} routes x ${VIEWPORTS.length} viewports -> ${path.relative(ROOT, OUT)}`);
console.log(bad ? `NOTE: ${bad} render(s) had runtime issues (see per-row)` : 'all renders clean');
