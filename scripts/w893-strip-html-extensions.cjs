// W893-Part1.3 — strip .html extensions from internal hrefs on public/ pages.
//
// Targets only the canonical product surface paths per the plan:
//   /product.html, /use-cases.html, /pricing.html, /download.html, /signup.html
//
// Vercel rewrites already serve both forms; this is purely a cleanliness pass
// so source HTML carries the extensionless form everywhere.
//
// Skips:
//   - Anything inside <code>...</code> or <pre>...</pre> (code samples)
//   - Anything under public/blog/ (blog post bodies may quote literal URLs)
//   - public/changelog.html (historical change records may quote literal URLs)
//
// Idempotent.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SKIP_DIRS = new Set([
  path.join(PUBLIC_DIR, 'blog'),
]);
const SKIP_FILES = new Set([
  path.join(PUBLIC_DIR, 'changelog.html'),
]);

// Map of literal href substring → replacement. Anchor + query are preserved
// because the substring sits before the # or ? if present.
const REPLACEMENTS = [
  ['href="/product.html"',      'href="/product"'],
  ['href="/use-cases.html"',    'href="/use-cases"'],
  ['href="/pricing.html"',      'href="/pricing"'],
  ['href="/download.html"',     'href="/download"'],
  ['href="/signup.html"',       'href="/signup"'],
  // With fragments — preserve fragment.
  ['href="/product.html#',      'href="/product#'],
  ['href="/use-cases.html#',    'href="/use-cases#'],
  ['href="/pricing.html#',      'href="/pricing#'],
  ['href="/download.html#',     'href="/download#'],
  ['href="/signup.html#',       'href="/signup#'],
  // With query.
  ['href="/product.html?',      'href="/product?'],
  ['href="/use-cases.html?',    'href="/use-cases?'],
  ['href="/pricing.html?',      'href="/pricing?'],
  ['href="/download.html?',     'href="/download?'],
  ['href="/signup.html?',       'href="/signup?'],
];

let scanned = 0;
let changed = 0;
let skipped = 0;
let touchedTotal = 0;

function isUnderSkipDir(p) {
  for (const d of SKIP_DIRS) {
    if (p.startsWith(d + path.sep) || p === d) return true;
  }
  return false;
}

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (isUnderSkipDir(p)) {
        // count files under skip dir for transparency
        continue;
      }
      walk(p);
    } else if (ent.isFile() && ent.name.endsWith('.html')) {
      scanned += 1;
      if (SKIP_FILES.has(p)) { skipped += 1; continue; }
      const raw = fs.readFileSync(p, 'utf-8');
      let next = raw;
      let touches = 0;
      for (const [find, repl] of REPLACEMENTS) {
        if (next.includes(find)) {
          const parts = next.split(find);
          touches += parts.length - 1;
          next = parts.join(repl);
        }
      }
      if (next !== raw) {
        fs.writeFileSync(p, next);
        changed += 1;
        touchedTotal += touches;
      }
    }
  }
}

walk(PUBLIC_DIR);
console.log(`scanned files:     ${scanned}`);
console.log(`changed files:     ${changed}`);
console.log(`skipped files:     ${skipped}`);
console.log(`total replacements:${touchedTotal}`);
