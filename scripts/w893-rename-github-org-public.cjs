// W893-Part1.2 — rename sneaky-hippo → kolm-ai across LIVE public/ pages.
// Skips:
//   public/brand/github-org-decision.html  (page intentionally documents the rename matrix)
//   public/sdk/publication-audit-2026-05-26.md   (historical audit snapshot)
//   public/frontend-version.json   (historical changelog blob)
//
// Idempotent: re-runs are no-ops once the rename has happened.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SKIP = new Set([
  path.join(PUBLIC_DIR, 'brand', 'github-org-decision.html'),
  path.join(PUBLIC_DIR, 'sdk', 'publication-audit-2026-05-26.md'),
  path.join(PUBLIC_DIR, 'frontend-version.json'),
]);

let scanned = 0;
let changed = 0;
let skipped = 0;
let nopattern = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
    } else if (ent.isFile()) {
      scanned += 1;
      if (SKIP.has(p)) { skipped += 1; continue; }
      const raw = fs.readFileSync(p, 'utf-8');
      if (!raw.includes('sneaky-hippo')) { nopattern += 1; continue; }
      const next = raw.split('sneaky-hippo').join('kolm-ai');
      if (next === raw) { nopattern += 1; continue; }
      fs.writeFileSync(p, next);
      changed += 1;
    }
  }
}

walk(PUBLIC_DIR);
console.log(`scanned: ${scanned}`);
console.log(`changed: ${changed}`);
console.log(`skipped: ${skipped}`);
console.log(`no pattern: ${nopattern}`);
