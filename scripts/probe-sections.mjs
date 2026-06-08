// Capture crisp 2x clips of each flagship section for aesthetic critique.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'sections');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };
function rf(u) { let p = decodeURIComponent(u.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = rf(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => { const s = document.querySelector('.hero .vw__status'); return s && !/loading|verifying/i.test(s.textContent); }, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(500);
const targets = [
  ['hero', '.hero'],
  ['s01-stall', '#problem'],
  ['s02-how', '#how'],
  ['s03-report', '#report'],
  ['s04-verify', '#verify'],
  ['s05-trust', '#trust'],
  ['s06-pricing', '#pricing'],
  ['cta-final', '.cta-final'],
  ['footer', 'footer'],
];
for (const [name, sel] of targets) {
  const elh = await page.$(sel);
  if (!elh) { console.log('missing', sel); continue; }
  await elh.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await elh.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('shot', name);
}
await browser.close(); server.close();
