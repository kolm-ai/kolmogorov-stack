// Minimal static file server for previewing the 2026 rebuild staging pages.
// Serves public/ over HTTP so ES-module imports (/kolm-verify.js) resolve.
// Read-only, localhost, no backend — purely for visual review.
//   node scripts/preview-static.mjs        → http://localhost:4500/index-2026.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PREVIEW_PORT || 4500);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

// Resolve a clean URL to a file, PREFERRING the *-2026.html staging version when
// it exists so the rebuild previews cohesively under its final clean URLs
// (/platform, /how-it-works, /solutions/ai-vendors). Falls back to the live page.
// At atomic-swap time, *-2026.html → *.html and these same URLs keep working with
// no link rewriting.
function resolve(urlPath) {
  if (urlPath === '/' || urlPath === '') return path.join(ROOT, 'index-2026.html');
  const ext = path.extname(urlPath);
  const cands = [];
  if (ext === '.html') {
    cands.push(urlPath.replace(/\.html$/, '-2026.html'), urlPath);
  } else if (!ext) {
    cands.push(urlPath + '-2026.html', urlPath + '.html', path.join(urlPath, 'index-2026.html'), path.join(urlPath, 'index.html'));
  } else {
    cands.push(urlPath);
  }
  for (const c of cands) {
    const fp = path.normalize(path.join(ROOT, c));
    if (fp.startsWith(ROOT) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = resolve(urlPath);
  if (!filePath) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404: ' + urlPath); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404: ' + urlPath); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`preview server → http://localhost:${PORT}/`);
  console.log(`  homepage:  http://localhost:${PORT}/index-2026.html`);
  console.log(`  verifier:  http://localhost:${PORT}/verify-2026.html`);
});
