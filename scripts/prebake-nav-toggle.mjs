#!/usr/bin/env node
// Inject <button class="nav-toggle">…</button> into every page's header
// actions container, BEFORE the theme-toggle button. Pre-baking eliminates
// the runtime DOM insertion that caused visible layout shift on navigation.
//
// Handles both header conventions:
//   newer: <header class="site-header"> + <div class="site-actions">
//   older: <header class="site">        + <div class="right">

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('public');
const BUTTON =
  '<button type="button" class="nav-toggle" aria-label="Toggle navigation" aria-expanded="false" aria-controls="site-nav">' +
  '<span></span><span></span><span></span>' +
  '</button>';

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip generated/binary directories
      if (ent.name === '_archive' || ent.name === 'img' || ent.name === '_generations') continue;
      walk(p, out);
    } else if (ent.isFile() && ent.name.endsWith('.html')) {
      out.push(p);
    }
  }
  return out;
}

let touched = 0;
let already = 0;
let skipped = 0;
const files = walk(ROOT, []);

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('class="nav-toggle"') || s.includes("class='nav-toggle'")) {
    already++;
    continue;
  }
  // Insert before the theme-toggle button if present, else before sign-in link.
  const themeTokIdx = s.indexOf('class="theme-toggle"');
  if (themeTokIdx >= 0) {
    // Walk back to find the <button> tag opening
    const before = s.lastIndexOf('<button', themeTokIdx);
    if (before >= 0) {
      s = s.slice(0, before) + BUTTON + s.slice(before);
      fs.writeFileSync(f, s);
      touched++;
      continue;
    }
  }
  // Fallback: insert before /signin anchor
  const signin = s.indexOf('href="/signin"');
  if (signin >= 0) {
    const before = s.lastIndexOf('<a', signin);
    if (before >= 0) {
      s = s.slice(0, before) + BUTTON + s.slice(before);
      fs.writeFileSync(f, s);
      touched++;
      continue;
    }
  }
  skipped++;
}

console.log(`touched=${touched}  already-ok=${already}  skipped=${skipped}`);
