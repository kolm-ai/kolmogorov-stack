import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };
function resolveFile(u) { let p = decodeURIComponent(u.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = resolveFile(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
await page.waitForTimeout(400);
const info = await page.evaluate(() => {
  const html = document.documentElement;
  const all = [...document.querySelectorAll('.reveal')];
  const stuck = all.filter((el) => parseFloat(getComputedStyle(el).opacity) < 0.5).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: el.className,
    hasIn: el.classList.contains('in'),
    top: Math.round(el.offsetTop),
    h: Math.round(el.offsetHeight),
    parentReveal: !!el.parentElement?.closest('.reveal'),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
  }));
  return {
    htmlClass: html.className,
    revealArmed: html.getAttribute('data-reveal-armed'),
    total: all.length,
    withIn: all.filter((el) => el.classList.contains('in')).length,
    stuckCount: stuck.length,
    stuck,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close(); server.close();
