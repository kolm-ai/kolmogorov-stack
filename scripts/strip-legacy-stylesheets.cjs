#!/usr/bin/env node
// Strips legacy <link rel="stylesheet"> tags from every page that ALSO loads
// /ks.css. The new design system is the sole source of truth; the legacy
// stylesheets create rule conflicts and inflate payloads.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

const LEGACY = [
  'styles.css',
  'brand-refresh.css',
  'surface-polish.css',
  'home-refresh.css',
  'w598.css',
  'w600-layout.css',
  'w605.css',
  'kolm-svg.css',
  'w604.css',
  'design-tokens.css',
  'fix.css',
];

const linkRe = new RegExp(
  `\\s*<link[^>]+href=\"\\/(?:${LEGACY.map(n => n.replace(/\./g, '\\.')).join('|')})\"[^>]*>\\s*`,
  'g'
);
const preloadRe = new RegExp(
  `\\s*<link[^>]+rel=\"preload\"[^>]+href=\"\\/(?:${LEGACY.map(n => n.replace(/\./g, '\\.')).join('|')})\"[^>]*>\\s*`,
  'g'
);

let changed = 0, skipped = 0, no_ks = 0;
for (const f of walk(root)) {
  const before = fs.readFileSync(f, 'utf8');
  if (!/href="\/ks\.css"/.test(before)) { no_ks++; continue; }
  let after = before.replace(linkRe, '\n').replace(preloadRe, '\n');
  if (after !== before) { fs.writeFileSync(f, after); changed++; }
  else skipped++;
}
console.log(`strip-legacy-stylesheets: changed=${changed} skipped=${skipped} no_ks=${no_ks}`);
