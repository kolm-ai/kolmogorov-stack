#!/usr/bin/env node
/* W850: swap warm theme-color metas to cool slate across all public/*.html.
   Touches only the two specific theme-color hex values, nothing else. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SWAPS = [
  // warm cream paper → cool slate paper
  [/#f7f4ec/g, '#f3f5f7'],
  // warm espresso dark → cool slate dark
  [/#1a1612/g, '#0e1116'],
];

let touched = 0;
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.name.endsWith('.html')) continue;
    scanned++;
    const before = fs.readFileSync(p, 'utf8');
    let after = before;
    for (const [re, to] of SWAPS) after = after.replace(re, to);
    if (after !== before) {
      fs.writeFileSync(p, after);
      touched++;
    }
  }
}

walk(ROOT);
console.log(`W850 slate-theme-color: scanned=${scanned} touched=${touched}`);
