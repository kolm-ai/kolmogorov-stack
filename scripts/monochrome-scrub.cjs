#!/usr/bin/env node
/* monochrome-scrub.cjs - 2026-05-24
 *
 * Pure monochrome editorial retune. Walks public/**\/*.{css,html,svg}
 * and replaces every leftover navy / sepia / sienna / silver-navy
 * with monochrome equivalents (ink + warm bone + mute gray).
 *
 * Mappings (chromatic -> monochrome):
 *   #1d2d44 (W837 navy)              -> #111111 (ink)
 *   #2a3e5c (navy hover)             -> #000000
 *   #29405f (navy alt hover)         -> #000000
 *   #0f1a2e (navy active)            -> #000000
 *   #5a6b85 (periwinkle)             -> #6b6b66 (mute)
 *   #7d96c0 (silver-navy dark mode)  -> #e8e3d6 (warm bone)
 *   #9eb4d8 (silver-navy hover)      -> #ffffff
 *   #8b6914 (sepia)                  -> #6b6b66 (mute gray)
 *   #b8a26b (sepia dark)             -> #c0bcb3 (warm pale)
 *   #d4a040 (amber dark mode)        -> #c0bcb3
 *   #2f4d72 (cyan-navy)              -> #3a3a38
 *   #3d5a3a (emerald)                -> #2d5a37 (muted forest)
 *   #8da992 (emerald-pale dark)      -> #8da992 (kept - status good)
 *   #d97706 (legacy amber)           -> #6b6b66
 *   #c2410c #9a3412 #fb923c #fdba74  (W834 orange family) -> #111111
 *   #faf2e1 (W836 burnt cream)       -> #f7f4ec (warm paper)
 *   #fbfaf6 #faf9f7 #f4f0e8          -> #f7f4ec
 *   #e8e3d6 -> #efece4 ONLY when in a surface context (skip - too aggressive)
 *   #16151a #161513                  -> #111111
 *
 * Plus the rgb()/rgba() variants for the most common.
 *
 * Run: node scripts/monochrome-scrub.cjs [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DRY = process.argv.includes('--dry-run');

const SUBS = [
  // ----- Navy family -> ink -----
  [/#1d2d44/gi, '#111111'],
  [/#2a3e5c/gi, '#000000'],
  [/#29405f/gi, '#000000'],
  [/#0f1a2e/gi, '#000000'],
  [/#5a6b85/gi, '#6b6b66'],
  // Silver-navy dark mode -> warm bone
  [/#7d96c0/gi, '#e8e3d6'],
  [/#9eb4d8/gi, '#ffffff'],
  // Cyan-navy
  [/#2f4d72/gi, '#3a3a38'],
  // ----- Sepia / amber family -> monochrome gray -----
  [/#8b6914/gi, '#6b6b66'],
  [/#b8a26b/gi, '#c0bcb3'],
  [/#d4a040/gi, '#c0bcb3'],
  [/#d97706/gi, '#6b6b66'],
  // ----- W834 burnt orange family -> ink -----
  [/#c2410c/gi, '#111111'],
  [/#9a3412/gi, '#000000'],
  [/#fb923c/gi, '#3a3a38'],
  [/#fdba74/gi, '#6b6b66'],
  // ----- Old W836 warm cream surfaces -> warm paper -----
  [/#faf2e1/gi, '#f7f4ec'],
  [/#fbfaf6/gi, '#f7f4ec'],
  [/#faf9f7/gi, '#f7f4ec'],
  [/#f4f0e8/gi, '#f7f4ec'],
  // ----- Old ink (#161513 / #16151a) -> standard ink -----
  [/#161513/gi, '#111111'],
  [/#16151a/gi, '#111111'],
  [/#22262e/gi, '#1f1f24'],
  // ----- rgb / rgba variants -----
  // navy (29,45,68) -> ink (17,17,17)
  [/rgb\(\s*29\s*,\s*45\s*,\s*68\s*\)/gi, 'rgb(17, 17, 17)'],
  [/rgba\(\s*29\s*,\s*45\s*,\s*68\s*,/gi, 'rgba(17, 17, 17,'],
  // silver-navy (125,150,192) -> warm bone (232,227,214)
  [/rgb\(\s*125\s*,\s*150\s*,\s*192\s*\)/gi, 'rgb(232, 227, 214)'],
  [/rgba\(\s*125\s*,\s*150\s*,\s*192\s*,/gi, 'rgba(232, 227, 214,'],
  // sepia (139,105,20) -> mute (107,107,102)
  [/rgb\(\s*139\s*,\s*105\s*,\s*20\s*\)/gi, 'rgb(107, 107, 102)'],
  [/rgba\(\s*139\s*,\s*105\s*,\s*20\s*,/gi, 'rgba(107, 107, 102,'],
  // mint legacy (126,240,210) and clay (16,185,129) - already scrubbed by W837-bleed-fix; re-apply for safety
  [/rgb\(\s*126\s*,\s*240\s*,\s*210\s*\)/gi, 'rgb(107, 107, 102)'],
  [/rgba\(\s*126\s*,\s*240\s*,\s*210\s*,/gi, 'rgba(107, 107, 102,'],
  [/rgb\(\s*16\s*,\s*185\s*,\s*129\s*\)/gi, 'rgb(45, 90, 55)'],
  [/rgba\(\s*16\s*,\s*185\s*,\s*129\s*,/gi, 'rgba(45, 90, 55,'],
  // orange-glow rgba shadows
  [/rgba\(\s*255\s*,\s*177\s*,\s*85\s*,/gi, 'rgba(17, 17, 17,'],
  [/rgba\(\s*176\s*,\s*124\s*,\s*245\s*,/gi, 'rgba(17, 17, 17,'],
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
  console.log(`\nmonochrome-scrub: ${verb} ${touched} files, ${total} substitutions.`);
}

main();
