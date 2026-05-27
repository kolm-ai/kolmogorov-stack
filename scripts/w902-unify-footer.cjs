#!/usr/bin/env node
// W902-C1: Replace legacy <footer class="ks-footer"> blocks with the canonical
// <footer class="ks-foot"> template from index.html for visual unification.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CANONICAL = indexHtml.match(/<footer class="ks-foot">[\s\S]*?<\/footer>/);
if (!CANONICAL) {
  console.error('FATAL: could not find canonical ks-foot in index.html');
  process.exit(1);
}
const REPLACEMENT = CANONICAL[0];

const LEGACY_RE = /<footer class="ks-footer">[\s\S]*?<\/footer>/g;

let touched = 0, untouched = 0;
const files = walk(ROOT);
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  if (!LEGACY_RE.test(before)) { untouched++; LEGACY_RE.lastIndex = 0; continue; }
  LEGACY_RE.lastIndex = 0;
  const after = before.replace(LEGACY_RE, REPLACEMENT);
  if (after === before) { untouched++; continue; }
  fs.writeFileSync(file, after);
  touched++;
}
console.log(`w902-unify-footer: touched=${touched} untouched=${untouched} total=${files.length}`);
