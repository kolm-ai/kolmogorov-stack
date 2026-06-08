#!/usr/bin/env node
// One-off: remove the fabricated "Halborn pentest" + "SOC 2" links from the
// site-wide footer Trust column. Exact-string replace only; reports each file.
const fs = require('fs');
const path = require('path');
const PUB = path.resolve(__dirname, '..', 'public');

const DIRTY = '<div class="foot__col"><h4>Trust</h4><a href="/security">Security</a><a href="/security/halborn-2026-04">Halborn pentest</a><a href="/soc2">SOC 2</a><a href="/trust">Trust center</a></div>';
const CLEAN = '<div class="foot__col"><h4>Trust</h4><a href="/security">Security</a><a href="/trust">Trust center</a></div>';

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

let changed = 0;
for (const f of walk(PUB)) {
  const txt = fs.readFileSync(f, 'utf8');
  if (txt.includes(DIRTY)) {
    fs.writeFileSync(f, txt.split(DIRTY).join(CLEAN));
    console.log('fixed footer: ' + path.relative(PUB, f));
    changed++;
  }
}
console.log(`\n${changed} files updated.`);
