#!/usr/bin/env node
// Snapshot the live kolm.ai site BEFORE deploying the W610 rebuild.
// Mirrors path structure under archive/prod-snapshot-<date>/ so the new
// rebuild can be diff'd against what was live (especially /product which
// the user singled out as detailed and worth learning from).
const fs = require('fs');
const path = require('path');
const https = require('https');

const STAMP = '2026-05-22';
const ROOT = path.resolve(__dirname, '..', 'archive', `prod-snapshot-${STAMP}`);
fs.mkdirSync(ROOT, { recursive: true });

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'user-agent': 'kolm-prod-archive/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    }).on('error', (e) => resolve({ status: 0, body: '', error: String(e) }));
  });
}

function pathForUrl(u) {
  const url = new URL(u);
  let p = url.pathname;
  if (p === '/' || p === '') p = '/index.html';
  else if (p.endsWith('/')) p = p + 'index.html';
  else if (!p.match(/\.[a-z0-9]{1,8}$/i)) p = p + '.html';
  return path.join(ROOT, p.replace(/^\//, ''));
}

async function main() {
  const smRes = await get('https://kolm.ai/sitemap.xml');
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), smRes.body);
  const urls = [...new Set((smRes.body.match(/https:\/\/kolm\.ai\/[^<\s]*/g) || []))];
  console.log(`archive-prod: ${urls.length} URLs from sitemap`);

  const manifest = { snapshot_at: new Date().toISOString(), source: 'https://kolm.ai/sitemap.xml', urls: urls.length, entries: [] };

  const conc = 12;
  let i = 0, done = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const u = urls[idx];
      const out = pathForUrl(u);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        const r = await get(u);
        if (r.status === 200 && r.body) {
          fs.writeFileSync(out, r.body);
          manifest.entries.push({ url: u, status: r.status, size: r.body.length, path: path.relative(ROOT, out) });
        } else {
          manifest.entries.push({ url: u, status: r.status, size: 0, path: null, error: r.error });
        }
      } catch (e) {
        manifest.entries.push({ url: u, status: 0, size: 0, path: null, error: String(e) });
      }
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${urls.length} fetched`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));

  manifest.entries.sort((a, b) => a.url.localeCompare(b.url));
  fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const ok = manifest.entries.filter((e) => e.status === 200).length;
  const totalSize = manifest.entries.reduce((s, e) => s + (e.size || 0), 0);
  console.log(`archive-prod: done. ${ok}/${urls.length} ok, ${(totalSize / 1024 / 1024).toFixed(1)} MB written under ${ROOT}`);
}
main();
