#!/usr/bin/env node
// Rewrites the primary nav on every ks.css page so that
// "Product / Models" -> "Wrapper / Studio".
// Idempotent: matches the legacy list/sheet patterns by exact text.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

const files = walk(root);
let changed = 0;
let skipped = 0;

// Patterns to swap — only fires on pages that have the legacy Product/Models nav.
const swaps = [
  {
    // ks-nav__list line, with or without aria-current="page" on Product
    from: /<li><a href="\/product"(?:\s+aria-current="page")?>Product<\/a><\/li>\s*<li><a href="\/models">Models<\/a><\/li>/g,
    to:   '<li><a href="/product">Product</a></li>\n      <li><a href="/solutions/teams">For teams</a></li>',
  },
  {
    // ks-nav__sheet (mobile) pattern
    from: /<a href="\/product">Product<\/a>\s*<a href="\/models">Models<\/a>/g,
    to:   '<a href="/product">Product</a><a href="/solutions/teams">For teams</a>',
  },
];

for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  if (!before.includes('ks.css') && !before.includes('ks-nav')) { skipped++; continue; }
  let after = before;
  for (const s of swaps) after = after.replace(s.from, s.to);
  if (after !== before) {
    fs.writeFileSync(f, after);
    changed++;
    process.stdout.write(`  fixed: ${path.relative(root, f)}\n`);
  } else {
    skipped++;
  }
}

console.log(`\nrewrite-nav-ks: changed=${changed} skipped=${skipped} total=${files.length}`);
