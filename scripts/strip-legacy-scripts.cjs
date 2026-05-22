#!/usr/bin/env node
// Strips legacy <script src="..."> tags from every page that ALSO loads
// /ks.css. The ks-nav is pure HTML/CSS; the legacy nav.js / w605.js /
// kolm-svg.js scripts walk dead markup and inject dead surface-guard CSS.
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

const LEGACY = ['nav.js', 'w605.js', 'kolm-svg.js', 'w604.js'];
const scriptRe = new RegExp(
  `\\s*<script[^>]+src=\"\\/(?:${LEGACY.map(n => n.replace(/\./g, '\\.')).join('|')})\"[^>]*>\\s*<\\/script>\\s*`,
  'g'
);

let changed = 0, skipped = 0, no_ks = 0;
for (const f of walk(root)) {
  const before = fs.readFileSync(f, 'utf8');
  if (!/href="\/ks\.css"/.test(before)) { no_ks++; continue; }
  const after = before.replace(scriptRe, '\n');
  if (after !== before) { fs.writeFileSync(f, after); changed++; }
  else skipped++;
}
console.log(`strip-legacy-scripts: changed=${changed} skipped=${skipped} no_ks=${no_ks}`);
