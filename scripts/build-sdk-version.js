#!/usr/bin/env node
// Stamp a content-addressed version of /sdk.js so consumers can pin
// `/sdk-<sha>.js` for SRI and immutable caching. Re-run on every change
// to public/sdk.js. Output:
//   public/sdk-<sha>.js              — byte-identical copy of /sdk.js
//   public/sdk-versions.json         — manifest with sri hash + version
//   public/sdk-current.json          — points at current sha
//
// Usage: node scripts/build-sdk-version.js

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const src = path.join(publicDir, 'sdk.js');
if (!fs.existsSync(src)) {
  console.error('public/sdk.js missing'); process.exit(1);
}
const body = fs.readFileSync(src);
const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
const sri = 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');

const out = path.join(publicDir, `sdk-${sha}.js`);
fs.writeFileSync(out, body);

const manifestPath = path.join(publicDir, 'sdk-versions.json');
let manifest = { spec: 'rs-1', versions: [] };
if (fs.existsSync(manifestPath)) {
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
}
const existing = manifest.versions.find(v => v.sha === sha);
if (!existing) {
  manifest.versions.unshift({
    sha,
    sri,
    bytes: body.length,
    url: `/sdk-${sha}.js`,
    published_at: new Date().toISOString(),
  });
  manifest.versions = manifest.versions.slice(0, 30); // keep last 30
}
manifest.current = { sha, sri, url: `/sdk-${sha}.js`, bytes: body.length };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const currentPath = path.join(publicDir, 'sdk-current.json');
fs.writeFileSync(currentPath, JSON.stringify(manifest.current, null, 2));

console.log(`stamped sdk-${sha}.js (${body.length} B, ${sri})`);
