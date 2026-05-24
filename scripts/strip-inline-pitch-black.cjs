#!/usr/bin/env node
// Strips the legacy inline pitch-black flash-prevention <style>...</style> from
// every page so warm-paper.css + design-tokens.css cascade decides the surface
// instead. Replaces with `color-scheme: light dark` on <html> via head meta-ish
// hint, since the original purpose was avoiding white-flash. Bootstrap IIFE
// (already present site-wide via scripts/fix-theme-bootstrap.cjs) reads saved
// theme and sets data-theme + colorScheme before paint — that handles flash.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');

// Match the exact form: <style>html,body{background:#08090c;color:#e8e3d6}html{color-scheme:dark}</style>
// and minor variants (whitespace around tags, missing trailing html{color-scheme:dark}, etc).
const RE = /<style>\s*html\s*,\s*body\s*\{[^}]*background\s*:\s*#08090c[^}]*\}(?:\s*html\s*\{[^}]*color-scheme\s*:\s*dark[^}]*\})?\s*<\/style>\s*\n?/i;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && entry.name.endsWith('.html')) yield p;
  }
}

let scanned = 0, stripped = 0;
for (const f of walk(ROOT)) {
  scanned++;
  const src = fs.readFileSync(f, 'utf8');
  if (!RE.test(src)) continue;
  const next = src.replace(RE, '');
  if (next !== src) {
    fs.writeFileSync(f, next);
    stripped++;
  }
}

console.log(JSON.stringify({ ok: true, scanned, stripped }));
