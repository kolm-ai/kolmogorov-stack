// Render key pages from local public/ for visual design review (light + dark).
// Serves public/ with clean-URL + .html fallback, then screenshots via chromium.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const PUB = path.resolve('public');
const OUTDIR = path.resolve('tmp-shots');
await mkdir(OUTDIR, { recursive: true });

const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.xml':'application/xml' };
function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  let f = path.join(PUB, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  if (fs.existsSync(f + '.html')) return f + '.html';
  if (fs.existsSync(f) && fs.statSync(f).isDirectory() && fs.existsSync(path.join(f, 'index.html'))) return path.join(f, 'index.html');
  return null;
}
const server = http.createServer((req, res) => {
  const f = resolveFile(req.url);
  if (!f) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;

const PAGES = (process.env.PAGES || '/,/proof,/product,/solutions,/pricing,/docs/gateway/overview,/compile/claude-opus-4-to-gguf-q4_k_m').split(',');
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const VW = Number(process.env.VW || 1440), VH = Number(process.env.VH || 900);
const FULL = process.env.FULL === '1';

const browser = await chromium.launch();
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('kolm-theme', t); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  for (const p of PAGES) {
    const slug = (p === '/' ? 'home' : p.replace(/^\//,'').replace(/\//g,'_')) + `__${VW}__${theme}`;
    try {
      await page.goto(base + p, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUTDIR, slug + '.png'), fullPage: FULL });
      console.log('shot', slug);
    } catch (e) { console.log('FAIL', p, theme, String(e.message).slice(0,80)); }
  }
  await ctx.close();
}
await browser.close();
server.close();
console.log('done ->', OUTDIR);
