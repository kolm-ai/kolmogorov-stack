#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'public');
const PORT = 8761;
const MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  let p = path.join(ROOT, url);
  if (!fs.existsSync(p) && !path.extname(p)) p += '.html';
  if (!fs.existsSync(p)) p = path.join(ROOT, 'index.html');
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIMES[ext] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log('static server on http://127.0.0.1:' + PORT);
});
