#!/usr/bin/env node
/* brand-bars-swap.cjs - 2026-05-24
 *
 * Walks public/**\/*.html and replaces the inside of every
 * <a class="ks-nav__brand">...</a> with the three-bars SVG mark
 * (descending h=20/14/8) followed by the kolm.ai wordmark.
 *
 * Idempotent — skips files where the bars SVG is already present.
 *
 * Run: node scripts/brand-bars-swap.cjs [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DRY = process.argv.includes('--dry-run');

const MARK_SVG =
  '<span class="ks-nav__mark" aria-hidden="true">' +
  '<svg viewBox="0 0 32 32" fill="none" role="img" aria-label="kolm">' +
  '<rect x="4" y="6" width="4.5" height="20" rx="0.4"/>' +
  '<rect x="13" y="9" width="4.5" height="14" rx="0.4"/>' +
  '<rect x="22" y="12" width="4.5" height="8" rx="0.4"/>' +
  '</svg></span>';

const WORDMARK = '<span>kolm<b>.ai</b></span>';
const INNER = MARK_SVG + WORDMARK;

// <a ... class="ks-nav__brand"...>...</a>  (class can be alone or in a list)
const BRAND_RE = /(<a [^>]*class="(?:[^"]*\s)?ks-nav__brand(?:\s[^"]*)?"[^>]*>)([\s\S]*?)(<\/a>)/g;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function transform(src) {
  let count = 0;
  const out = src.replace(BRAND_RE, (whole, open, inner, close) => {
    if (/<svg [^>]*viewBox="0 0 32 32"[\s\S]*?<rect [^>]*x="22" [^>]*y="12"/.test(inner)) return whole;
    count++;
    return open + INNER + close;
  });
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
      hits.push(`${count.toString().padStart(3)}  ${path.relative(ROOT, f)}`);
    }
  }
  hits.sort();
  for (const h of hits.slice(0, 15)) console.log(h);
  if (hits.length > 15) console.log(`... and ${hits.length - 15} more`);
  const verb = DRY ? '[dry-run] would update' : 'updated';
  console.log(`\nbrand-bars-swap: ${verb} ${touched} files, ${total} brand blocks.`);
}

main();
