// W923 nav de-jargon codemod.
// Kills the "Wrapper"/"Studio" internal-noun jargon from NAV + FOOTER across the
// whole site (the #1 SOTA-audit finding). Surgical: only rewrites the nav anchor
// whose visible label is exactly "Wrapper"/"Studio" and the footer column headers
// — never body copy ("wrapper tax" editorial), never /wrapper links with other
// labels (those pages still exist and stay reachable). nav.js included.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'public');

// [from, to] — exact, label-bound replacements.
const REPLACEMENTS = [
  ['href="/wrapper">Wrapper<', 'href="/product">Product<'],
  ['href="/studio">Studio<', 'href="/proof">Proof<'],
  ["href='/wrapper'>Wrapper<", "href='/product'>Product<"],
  ["href='/studio'>Studio<", "href='/proof'>Proof<"],
  ['<h4>Wrapper</h4>', '<h4>Product</h4>'],
  ['<h4>Studio</h4>', '<h4>Build</h4>'],
];

let filesChanged = 0, totalHits = 0;
const SKIP = new Set(['_archive', '_generations', 'node_modules', '.git']);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(html|js)$/.test(entry.name)) continue;
    // Skip nav.js's data files etc. — only nav.js itself among .js.
    if (entry.name.endsWith('.js') && entry.name !== 'nav.js') continue;
    let s;
    try { s = fs.readFileSync(full, 'utf8'); } catch { continue; }
    let hits = 0, out = s;
    for (const [from, to] of REPLACEMENTS) {
      if (out.includes(from)) {
        const n = out.split(from).length - 1;
        hits += n;
        out = out.split(from).join(to);
      }
    }
    if (hits > 0) { fs.writeFileSync(full, out); filesChanged++; totalHits += hits; }
  }
}

walk(ROOT);
console.log(`nav de-jargon: ${filesChanged} files changed, ${totalHits} anchor/header replacements`);
