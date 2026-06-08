import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };
function rf(u) { let p = decodeURIComponent(u.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = rf(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
// scroll #verify section to center using native scrollIntoView (mimics a real anchor jump), dwell long
await page.evaluate(() => document.querySelector('#verify').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(1800);
const r = await page.evaluate(() => {
  const el = document.querySelector('#verify');
  const rect = el.getBoundingClientRect();
  return { hasIn: el.classList.contains('in'), opacity: getComputedStyle(el).opacity, top: Math.round(rect.top), bottom: Math.round(rect.bottom), vh: innerHeight, intersecting: rect.top < innerHeight && rect.bottom > 0 };
});
console.log('after scrollIntoView(#verify) + 1800ms:', JSON.stringify(r));
// Now a slow human-like scroll through the whole doc
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.evaluate(async () => { const step = 200; for (let y = 0; y <= document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))); } });
await page.waitForTimeout(600);
const after = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.reveal')];
  return { total: all.length, withIn: all.filter((e) => e.classList.contains('in')).length, stuck: all.filter((e) => parseFloat(getComputedStyle(e).opacity) < 0.5).length };
});
console.log('after slow scroll:', JSON.stringify(after));
await browser.close(); server.close();
