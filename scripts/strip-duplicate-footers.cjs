#!/usr/bin/env node
// W609 migration auto-injected a <footer class="ks-footer"> ... </footer>
// block before </body> on every public HTML page. On pages that already had
// a manually-authored <footer class="ks-foot"> footer, this produced two
// visible footers stacked on top of each other. This script strips the
// auto-injected dupe wherever both are present, keeping the manually-
// authored richer footer (which has the canonical 5-column structure).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

// Match the auto-injected ks-footer block (multiline). Greedy enough to
// catch trailing whitespace, lazy enough to stop at the first </footer>.
const dupeRe = /\s*<footer[^>]*class="ks-footer"[^>]*>[\s\S]*?<\/footer>\s*/g;

let stripped = 0, untouched = 0;
for (const f of walk(root)) {
  const before = fs.readFileSync(f, 'utf8');
  const footRich = /<footer[^>]*class="ks-foot"/.test(before);
  const footAuto = /<footer[^>]*class="ks-footer"/.test(before);
  if (!(footRich && footAuto)) { untouched++; continue; }
  // Strip every ks-footer block; keep the ks-foot one. Idempotent.
  const after = before.replace(dupeRe, '\n');
  if (after !== before) { fs.writeFileSync(f, after); stripped++; }
  else untouched++;
}
console.log(`strip-duplicate-footers: stripped=${stripped} untouched=${untouched}`);
