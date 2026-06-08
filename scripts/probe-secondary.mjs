// Render every secondary page: full-page 1440 screenshot + error/chrome report.
// reducedMotion so reveals are visible in the shot; verifies nav+footer present.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'secondary');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
function resolveFile(u) { let p = decodeURIComponent(u.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { const i = path.join(abs, 'index.html'); if (fs.existsSync(i)) return i; } if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = resolveFile(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const PAGES = ['/how-it-works', '/platform', '/checks', '/report', '/verify', '/pricing', '/trust', '/security', '/security/threat-model', '/enterprise', '/solutions/ai-vendors', '/solutions/enterprise-buyers', '/research', '/docs', '/changelog', '/status', '/transparency-log', '/contact', '/careers', '/privacy', '/terms', '/dpa', '/baa', '/sla', '/subprocessors', '/acceptable-use', '/404'];
const browser = await chromium.launch();
let bad = 0;
const rows = [];
for (const route of PAGES) {
  const errors = [], consoleErrors = [], failed = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, reducedMotion: 'reduce' });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(base)) failed.push(`${u.replace(base, '')} ${r.failure()?.errorText}`); });
  let status = 0;
  try { const resp = await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 }); status = resp?.status() || 0; } catch (e) { errors.push('goto: ' + e.message); }
  await page.waitForTimeout(300);
  const chrome = await page.evaluate(() => ({
    nav: !!document.querySelector('header.nav'),
    toggle: !!document.querySelector('.nav__toggle'),
    cta: !!document.querySelector('.nav__cta'),
    footer: !!document.querySelector('footer'),
    h1: (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
    mainChars: (document.querySelector('main')?.textContent || document.body.textContent || '').replace(/\s+/g, ' ').trim().length,
    h2count: document.querySelectorAll('h2').length,
  }));
  const name = route.replace(/\//g, '_').replace(/^_/, '') || 'home';
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  const issues = [];
  if (!chrome.nav) issues.push('NO-NAV');
  if (!chrome.toggle) issues.push('NO-TOGGLE');
  if (!chrome.cta) issues.push('NO-CTA');
  if (!chrome.footer) issues.push('NO-FOOTER');
  if (errors.length) issues.push(`pageerr=${errors.length}`);
  if (consoleErrors.length) issues.push(`console=${consoleErrors.length}`);
  if (failed.length) issues.push(`failed=${failed.length}`);
  if (issues.length) bad++;
  rows.push(`${issues.length ? 'FAIL ' : 'ok   '}${route.padEnd(34)} h1="${chrome.h1}" h2s=${chrome.h2count} chars=${chrome.mainChars}${issues.length ? '  :: ' + issues.join(' ') : ''}`);
  if (errors.length) rows.push('       perr: ' + errors.slice(0, 2).join(' | '));
  if (consoleErrors.length) rows.push('       cerr: ' + consoleErrors.slice(0, 2).join(' | '));
  if (failed.length) rows.push('       freq: ' + failed.slice(0, 3).join(' | '));
  await page.close();
}
await browser.close(); server.close();
console.log(rows.join('\n'));
console.log(`\n${bad ? `SECONDARY: ${bad} page(s) with issues` : 'SECONDARY: all chrome present, no errors'}`);
