// probe-verify.mjs — measure the §04 verify split layout to diagnose the ledger collapse
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
function resolveFile(u) { let p = decodeURIComponent(u.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = resolveFile(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
// settle widget
await page.evaluate(() => new Promise((resolve) => {
  const w = [...document.querySelectorAll('.vw[data-verify-widget]')];
  if (!w.length) return resolve();
  const done = () => w.every((x) => x.querySelector('.vw__status.is-ok, .vw__status.is-bad, .seal.is-sealed, .seal.is-void'));
  const t0 = Date.now(); const iv = setInterval(() => { if (done() || Date.now() - t0 > 7000) { clearInterval(iv); resolve(); } }, 120);
}));
const data = await page.evaluate(() => {
  const sec = document.querySelector('#verify');
  const split = sec.querySelector('.split');
  const kids = [...split.children];
  const cs = getComputedStyle(split);
  const ledger = sec.querySelector('.ledger');
  const li = ledger ? ledger.querySelector('li') : null;
  return {
    splitTemplate: cs.gridTemplateColumns,
    splitWidth: split.getBoundingClientRect().width,
    leftWidth: kids[0]?.getBoundingClientRect().width,
    rightWidth: kids[1]?.getBoundingClientRect().width,
    ledgerWidth: ledger?.getBoundingClientRect().width,
    liWidth: li?.getBoundingClientRect().width,
    liTemplate: li ? getComputedStyle(li).gridTemplateColumns : null,
    vwWidth: sec.querySelector('.vw')?.getBoundingClientRect().width,
    vwScrollWidth: sec.querySelector('.vw')?.scrollWidth,
  };
});
console.log(JSON.stringify(data, null, 2));
await browser.close(); server.close();
