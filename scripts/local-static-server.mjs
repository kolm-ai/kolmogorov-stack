// Minimal static file server for screenshot verification of public/.
// Resolves /foo -> public/foo.html when foo.html exists.
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve('public');
const PORT = Number(process.env.PORT || 5179);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    let full = join(ROOT, p);
    // Vercel parity: prefer foo.html over foo/ even when both exist, EXCEPT
    // when the path already has a file extension (then exact match wins).
    const hasExt = /\.[a-z0-9]{1,6}$/i.test(p);
    if (!hasExt && existsSync(full + '.html')) full += '.html';
    if (!existsSync(full)) { res.writeHead(404); return res.end('404'); }
    const st = statSync(full);
    if (st.isDirectory()) {
      const idx = join(full, 'index.html');
      if (existsSync(idx)) full = idx;
      else { res.writeHead(404); return res.end('404'); }
    }
    const mime = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(readFileSync(full));
  } catch (e) {
    res.writeHead(500); res.end(String(e.message || e));
  }
});

server.listen(PORT, () => {
  console.log('local-static-server listening on http://localhost:' + PORT);
});
