// W893-0 — add a footer link to /spec/toml in the Studio column of every
// public/*.html footer. The link is placed AFTER "Models" so the Studio
// column reads: Overview → Distill → Compile → k-score → Models → Spec.
//
// Idempotent: if the link already exists in the file (any occurrence of the
// exact <a href="/spec/toml">…</a> in the Studio ul), the file is skipped.
//
// Run: node scripts/w893-add-spec-link-to-footers.cjs

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const TARGET_PATTERN = '<li><a href="/k-score">k-score</a></li><li><a href="/models">Models</a></li></ul>';
const REPLACEMENT = '<li><a href="/k-score">k-score</a></li><li><a href="/models">Models</a></li><li><a href="/spec/toml">.kolm spec</a></li></ul>';

let changed = 0;
let skipped = 0;
let scanned = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
    } else if (ent.isFile() && ent.name.endsWith('.html')) {
      scanned += 1;
      const raw = fs.readFileSync(p, 'utf-8');
      if (!raw.includes(TARGET_PATTERN)) {
        continue;
      }
      if (raw.includes('<a href="/spec/toml">')) {
        // already present (added by an earlier run or hand-edit)
        skipped += 1;
        continue;
      }
      const next = raw.split(TARGET_PATTERN).join(REPLACEMENT);
      fs.writeFileSync(p, next);
      changed += 1;
    }
  }
}

walk(PUBLIC_DIR);
console.log(`scanned: ${scanned}`);
console.log(`changed: ${changed}`);
console.log(`skipped (already had link): ${skipped}`);
