#!/usr/bin/env node
/* W850: mechanically purge every warm (cream/beige/brown/sienna)
   color literal across CSS, HTML, and JS in /public, swapping each
   for its cool-slate analogue. Surgical: only touches color literals,
   never structural CSS. Leaves anything not in the SWAPS table alone.

   Cool-slate target palette:
     paper / surface-0       #f3f5f7
     surface-1               #e8ebef
     surface-2               #dde1e7
     surface-3               #cbd0d6
     ink-1 (cream→slate)     #e6e9ee
     ink-2                   #c1c7cf
     ink-3                   #828892 / #8a929c
     ink-4                   #b6bcc4 / #525a64
     dark canvas             #0e1116 / #161a20 / #1c2128
     near-ink accent         #1f2937
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

// Order matters: longer / more-specific patterns first so we don't half-replace.
const SWAPS = [
  // ───────── HEX (warm cream / beige / paper surfaces) ─────────
  [/#f7f4ec/gi, '#f3f5f7'],   // paper canvas
  [/#f5efe2/gi, '#eef1f5'],   // light cream surface
  [/#f1ede2/gi, '#e8ebef'],   // cream surface-1
  [/#efece4/gi, '#e8ebef'],   // cream surface-1 variant
  [/#f4d8a8/gi, '#cbd0d6'],   // tan
  [/#ede7d6/gi, '#dde1e7'],   // light warm beige
  [/#e8e3d6/gi, '#e6e9ee'],   // warm cream (the dominant ink+accent value)
  [/#ece7dc/gi, '#e6e9ee'],   // cream variant
  [/#ead8b8/gi, '#e6e9ee'],   // warm gold
  [/#e6e3db/gi, '#dde1e7'],
  [/#e2dccb/gi, '#dde1e7'],
  [/#d8d2c1/gi, '#dde1e7'],
  [/#d4ccba/gi, '#cbd0d6'],
  [/#cbc4b5/gi, '#c1c7cf'],
  [/#bdb3a1/gi, '#b6bcc4'],   // warm ink-4
  [/#b5bdb1/gi, '#aab0b8'],   // recipe ink-mute
  [/#a8a298/gi, '#c1c7cf'],
  [/#8a8276/gi, '#828892'],
  [/#787268/gi, '#6a727c'],
  [/#737c73/gi, '#6a727c'],   // recipe ink-faint
  [/#5a5a55/gi, '#56606c'],   // eyebrow grey
  [/#48433d/gi, '#525a64'],
  [/#4a4641/gi, '#44494f'],
  [/#3a2a1f/gi, '#252b34'],
  [/#2a241b/gi, '#1c2128'],
  [/#1a1612/gi, '#161a20'],   // warm espresso dark
  [/#14110d/gi, '#0e1116'],
  [/#0e1014/gi, '#0e1116'],   // ks dark canvas
  [/#0c0e10/gi, '#0c0f14'],
  [/#070a0c/gi, '#0a0d12'],

  // ───────── HEX (sienna / orange / amber / burnt — anti-orange) ─────────
  [/#c2410c/gi, '#1f2937'],
  [/#ff7a3d/gi, '#9aa6b8'],
  [/#fff5e6/gi, '#eef1f5'],
  [/#f97316/gi, '#7fa1c4'],
  [/#fb923c/gi, '#9aa6b8'],
  [/#fdba74/gi, '#cbd0d6'],
  [/#fed7aa/gi, '#dde1e7'],
  [/#ffedd5/gi, '#e8ebef'],
  [/#ea580c/gi, '#1f2937'],
  [/#9a3412/gi, '#1f2937'],
  [/#7c2d12/gi, '#1f2937'],

  // ───────── HEX (warm status / pos / warn / err / accent variants) ─────────
  [/#6fbf85/gi, '#7fb38a'],
  [/#c0bcb3/gi, '#b8b094'],
  [/#c97070/gi, '#b86a72'],

  // ───────── HEX (warm amber / gold "warn" — W899 anti-warn-amber) ─────────
  [/#f0b86b/gi, '#a8b3c2'],   // warm gold warn → cool steel
  [/#d6a65a/gi, '#a8b3c2'],   // warm gold variant → cool steel
  [/#d6cfb8/gi, '#d5d9e0'],   // warm beige border → cool slate
  [/#f0ecdd/gi, '#eef0f3'],   // warm cream card → cool slate
  [/#c9c2b2/gi, '#b8c0ca'],   // warm beige accent-strong → cool steel
  [/#b8b099/gi, '#a8b3c2'],   // warm tan ink-mute → cool steel
  [/#6a6354/gi, '#6b7585'],   // warm brown faint → cool slate faint
  [/#5eead4/gi, '#7fa1c4'],   // mint accent → cool blue (W898 left a few)

  // ───────── RGBA — warm amber/gold (W899) ─────────
  [/rgba\(\s*214\s*,\s*166\s*,\s*90/g, 'rgba(168, 179, 194'],
  [/rgba\(\s*240\s*,\s*184\s*,\s*107/g, 'rgba(168, 179, 194'],
  [/rgba\(\s*214\s*,\s*207\s*,\s*184/g, 'rgba(213, 217, 224'],

  // ───────── HEX (second-tier off-whites and warm cards) ─────────
  [/#fbf8f0/gi, '#eef1f5'],   // warm off-white card
  [/#fdfcf8/gi, '#f3f5f7'],   // warm off-white bg
  [/#fafaf6/gi, '#f6f8fa'],   // warm legal card
  [/#faf9f7/gi, '#f3f5f7'],   // warm paper variant
  [/#fafaf5/gi, '#f6f8fa'],
  [/#fcfbf7/gi, '#f6f8fa'],

  // ───────── HEX (amber / yellow status — anti-warn-orange) ─────────
  [/#fcd34d/gi, '#cbd0d6'],
  [/#fde68a/gi, '#dde1e7'],
  [/#fbbf24/gi, '#9aa6b8'],
  [/#f59e0b/gi, '#56606c'],
  [/#d97706/gi, '#525a64'],
  [/#b45309/gi, '#56606c'],
  [/#92400e/gi, '#252b34'],
  [/#78350f/gi, '#252b34'],
  [/#451a03/gi, '#181c22'],
  [/#fff7ed/gi, '#eef1f5'],

  // ───────── RGBA (amber backgrounds) ─────────
  [/rgba\(\s*245\s*,\s*158\s*,\s*11/g, 'rgba(150, 158, 170'],
  [/rgba\(\s*251\s*,\s*191\s*,\s*36/g, 'rgba(154, 166, 184'],
  [/rgba\(\s*252\s*,\s*211\s*,\s*77/g, 'rgba(203, 208, 214'],
  [/rgba\(\s*253\s*,\s*230\s*,\s*138/g, 'rgba(221, 225, 231'],
  [/rgba\(\s*217\s*,\s*119\s*,\s*6/g, 'rgba(82, 90, 100'],
  [/rgba\(\s*180\s*,\s*83\s*,\s*9/g, 'rgba(86, 96, 108'],

  // ───────── RGBA — warm cream ink ─────────
  // canonical 232,227,214 (and spacing variants)
  [/rgba\(\s*232\s*,\s*227\s*,\s*214/g, 'rgba(230, 233, 238'],
  // 231,229,228 (warmest grey)
  [/rgba\(\s*231\s*,\s*229\s*,\s*228/g, 'rgba(230, 233, 238'],
  // 236,231,220 (cream variant)
  [/rgba\(\s*236\s*,\s*231\s*,\s*220/g, 'rgba(230, 233, 238'],
  // 245,239,226 (warm light)
  [/rgba\(\s*245\s*,\s*239\s*,\s*226/g, 'rgba(238, 241, 245'],
  // 234,216,184 (warm gold)
  [/rgba\(\s*234\s*,\s*216\s*,\s*184/g, 'rgba(230, 233, 238'],
  // 247,244,236 (paper) → already swapped via hex but rgba form:
  [/rgba\(\s*247\s*,\s*244\s*,\s*236/g, 'rgba(243, 245, 247'],
  // 28,27,26 (warmest pseudo-black) → cool 28,30,34
  [/rgba\(\s*28\s*,\s*27\s*,\s*26/g, 'rgba(28, 30, 34'],

  // ───────── RGBA — orange/sienna ─────────
  [/rgba\(\s*194\s*,\s*65\s*,\s*12/g, 'rgba(31, 41, 55'],
  [/rgba\(\s*255\s*,\s*122\s*,\s*61/g, 'rgba(154, 166, 184'],
  [/rgba\(\s*249\s*,\s*115\s*,\s*22/g, 'rgba(127, 161, 196'],
  [/rgba\(\s*251\s*,\s*146\s*,\s*60/g, 'rgba(154, 166, 184'],
  [/rgba\(\s*253\s*,\s*186\s*,\s*116/g, 'rgba(203, 208, 214'],
  [/rgba\(\s*234\s*,\s*88\s*,\s*12/g, 'rgba(31, 41, 55'],
];

const EXTS = new Set(['.css', '.html', '.htm', '.js', '.cjs', '.mjs', '.svg']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.w850-shots']);

let scanned = 0;
let touched = 0;
let bytesChanged = 0;
const perFile = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    const ext = path.extname(entry.name).toLowerCase();
    if (!EXTS.has(ext)) continue;
    scanned++;
    const before = fs.readFileSync(p, 'utf8');
    let after = before;
    let hits = 0;
    for (const [re, to] of SWAPS) {
      const m = after.match(re);
      if (m) { hits += m.length; after = after.replace(re, to); }
    }
    if (after !== before) {
      fs.writeFileSync(p, after);
      touched++;
      bytesChanged += Math.abs(after.length - before.length);
      perFile.push({ file: path.relative(ROOT, p), hits });
    }
  }
}

walk(ROOT);

perFile.sort((a, b) => b.hits - a.hits);
console.log('W850 warm-purge complete');
console.log(`  scanned: ${scanned}`);
console.log(`  touched: ${touched}`);
console.log(`  bytes Δ: ${bytesChanged}`);
console.log('  top files:');
for (const r of perFile.slice(0, 15)) {
  console.log(`    ${r.hits.toString().padStart(5)}  ${r.file}`);
}
