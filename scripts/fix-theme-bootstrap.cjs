#!/usr/bin/env node
// W844: replace every "only restores light" theme bootstrap with one that
// handles both light and dark. Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const BAD_RE = /<script>\(function\(\)\{try\{var t=localStorage\.getItem\('kolm-theme'\);if\(t==='light'\)\{document\.documentElement\.setAttribute\('data-theme','light'\);document\.documentElement\.style\.background='#f7f4ec';document\.documentElement\.style\.colorScheme='light';\}\}catch\(e\)\{\}\}\)\(\);<\/script>/g;
const GOOD = "<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}}catch(e){}})();</script>";

let scanned = 0;
let touched = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.html')) continue;
    scanned++;
    const raw = fs.readFileSync(full, 'utf8');
    if (!BAD_RE.test(raw)) continue;
    const next = raw.replace(BAD_RE, GOOD);
    if (next !== raw) {
      fs.writeFileSync(full, next, 'utf8');
      touched++;
    }
  }
}

walk(ROOT);
console.log(JSON.stringify({ scanned, touched }, null, 2));
