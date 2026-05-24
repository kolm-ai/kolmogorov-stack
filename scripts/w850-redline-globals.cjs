#!/usr/bin/env node
/* W850 redline sweep — globals.
   Touches every public/**.html for two surgical changes:
     1. Strip the "Not Kolm therapeutics, Kolm band, ..." brand-anchor span.
        Replace with a one-line minimal brand-anchor (just kolm.ai) so any
        crawler still has the canonical brand string but the SEO disambiguation
        wall is gone. User: "delete the text."
     2. Swap og-card.svg → brand-hero.png on og:image / twitter:image meta
        tags. PNG renders on Slack/LinkedIn; SVG does not.
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

let scanned = 0;
let brandTouched = 0;
let ogTouched = 0;

const BRAND_RE_FULL = /<span class="brand-anchor"[^>]*>kolm\.ai[^<]*Petter Kolm\.<\/span>\s*\n?/g;
const BRAND_RE_LOOSE = /<span class="brand-anchor"[^>]*>kolm\.ai[^<]*<\/span>\s*\n?/g;
const DISAMBIG_RE = /<span class="brand-disambig"[^>]*>Not Kolm[^<]*<\/span>\s*\n?/g;
// articles/kolm-ai-vs-kolm-therapeutics.html is INTENTIONAL content explaining
// the brand disambiguation — leave that file alone.
const SKIP_FILES = new Set([
  path.join(ROOT, 'articles', 'kolm-ai-vs-kolm-therapeutics.html'),
]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.name.endsWith('.html')) continue;
    if (SKIP_FILES.has(p)) continue;
    scanned++;
    const before = fs.readFileSync(p, 'utf8');
    let after = before;

    // (1a) brand-anchor: strip the full disambiguation span entirely.
    const beforeBrand = after;
    after = after.replace(BRAND_RE_FULL, '');
    if (after === beforeBrand) {
      after = after.replace(BRAND_RE_LOOSE, '');
    }
    // (1b) brand-disambig: separate class used on later-added pages.
    after = after.replace(DISAMBIG_RE, '');
    // (1c) sr-only paragraph variant (university / compliance pages).
    after = after.replace(/<p class="sr-only">Not Kolm[^<]*<\/p>\s*\n?/g, '');
    if (after !== beforeBrand) brandTouched++;

    // (2) og:image / twitter:image: SVG -> PNG.
    const beforeOg = after;
    after = after.replace(/og-card\.svg/g, 'brand-hero.png');
    if (after !== beforeOg) ogTouched++;

    if (after !== before) fs.writeFileSync(p, after);
  }
}

walk(ROOT);
console.log('W850 redline-globals complete');
console.log(`  scanned:        ${scanned}`);
console.log(`  brand stripped: ${brandTouched}`);
console.log(`  og PNG swap:    ${ogTouched}`);
