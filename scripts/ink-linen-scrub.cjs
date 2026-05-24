#!/usr/bin/env node
/* ink-linen-scrub.cjs — 2026-05-24
 *
 * W837 hotfix: gut the legacy W836 burnt-cream + mint + clay palette
 * out of every CSS and HTML file under public/. Replaces hex codes
 * with their Ink & Linen W837 equivalents. Idempotent.
 *
 * Mappings (legacy -> Ink & Linen):
 *   #faf2e1 (W836 burnt cream)        -> #e8e3d6 (warm bone, dark-mode fg)
 *   #fbfaf6 (W836 paper light)        -> #f4f0e8 (linen, light-mode bg)
 *   #faf9f7 (W836 paper alt)          -> #f4f0e8
 *   #7ef0d2 (legacy mint)             -> #7d96c0 (silvery navy)
 *   #10b981 (clay green)              -> #1d2d44 (deep navy)
 *   #d97706 (amber/orange-brown)      -> #8b6914 (deep sepia)
 *   rgb(126, 240, 210) mint           -> rgb(125, 150, 192) navy
 *   rgb(16, 185, 129) clay            -> rgb(29, 45, 68) navy
 *
 * Run: node scripts/ink-linen-scrub.cjs [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DRY = process.argv.includes('--dry-run');

const SUBS = [
  // Hex (case-insensitive via separate paired entries)
  [/#faf2e1/gi, '#e8e3d6'],
  [/#fbfaf6/gi, '#f4f0e8'],
  [/#faf9f7/gi, '#f4f0e8'],
  [/#7ef0d2/gi, '#7d96c0'],
  [/#10b981/gi, '#1d2d44'],
  [/#d97706/gi, '#8b6914'],
  // rgb / rgba
  [/rgb\(\s*126\s*,\s*240\s*,\s*210\s*\)/gi, 'rgb(125, 150, 192)'],
  [/rgba\(\s*126\s*,\s*240\s*,\s*210\s*,/gi, 'rgba(125, 150, 192,'],
  [/rgb\(\s*16\s*,\s*185\s*,\s*129\s*\)/gi, 'rgb(29, 45, 68)'],
  [/rgba\(\s*16\s*,\s*185\s*,\s*129\s*,/gi, 'rgba(29, 45, 68,'],
  // Orange-tinted shadows / glows
  [/rgba\(\s*255\s*,\s*177\s*,\s*85\s*,/gi, 'rgba(139, 105, 20,'],
  [/rgba\(\s*176\s*,\s*124\s*,\s*245\s*,/gi, 'rgba(125, 150, 192,'],
];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && (ent.name.endsWith('.css') || ent.name.endsWith('.html') || ent.name.endsWith('.svg'))) out.push(p);
  }
  return out;
}

function transform(src) {
  let out = src;
  let count = 0;
  for (const [re, replacement] of SUBS) {
    out = out.replace(re, () => { count++; return replacement; });
  }
  return { out, count };
}

function main() {
  const files = walk(ROOT);
  let touched = 0;
  let total = 0;
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { out, count } = transform(src);
    if (count > 0) {
      if (!DRY) fs.writeFileSync(f, out, 'utf8');
      touched++;
      total += count;
      hits.push(`${count.toString().padStart(4)}  ${path.relative(ROOT, f)}`);
    }
  }
  hits.sort().reverse();
  for (const h of hits.slice(0, 25)) console.log(h);
  if (hits.length > 25) console.log(`... and ${hits.length - 25} more`);
  const verb = DRY ? '[dry-run] would update' : 'updated';
  console.log(`\nink-linen-scrub: ${verb} ${touched} files, ${total} substitutions.`);
}

main();
