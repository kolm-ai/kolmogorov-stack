// Kill the off-brand green/teal/mint accents site-wide -> cobalt. kolm is cool-slate
// + ONE cobalt accent, never green. Targets inline --accent tokens + bare hex uses
// across public/ and the known page generators (so regen stays cobalt). Deterministic.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const COBALT = '#2563eb';
const COBALT_LIGHT = '#6f9bff';
const MAP = new Map([
  ['#059669', COBALT], ['#0a8862', COBALT], ['#0e7490', COBALT], ['#10b981', COBALT],
  ['#0f8f69', COBALT], ['#10846a', COBALT], ['#047857', COBALT], ['#0d9488', COBALT],
  ['#2bf5b3', COBALT_LIGHT], ['#7fe1c2', COBALT_LIGHT], ['#34d399', COBALT_LIGHT], ['#5eead4', COBALT_LIGHT],
]);
const HEXES = [...MAP.keys()];

const SKIP_DIRS = new Set(['_archive', '_generations', 'node_modules', '.git']);
let files = 0, hits = 0;

function processFile(full) {
  let s;
  try { s = fs.readFileSync(full, 'utf8'); } catch { return; }
  let out = s, n = 0;
  for (const from of HEXES) {
    const re = new RegExp(from, 'gi');
    out = out.replace(re, () => { n++; return MAP.get(from); });
  }
  if (n > 0 && out !== s) { fs.writeFileSync(full, out); files++; hits += n; }
}

function walk(dir, exts) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, exts); continue; }
    if (exts.some((x) => e.name.endsWith(x))) processFile(full);
  }
}

walk(path.join(ROOT, 'public'), ['.html', '.css', '.svg']);
// Only the known page generators (not all scripts — avoids CLI/test-fixture greens).
for (const g of ['build-docs-w374.cjs', 'wave887-docs-generator.cjs', 'build-marketplace-pages.cjs', 'build-api-ref.cjs', 'build-seo-pages.cjs', 'build-comparison-seo.cjs', 'build-account-pages.cjs']) {
  const p = path.join(ROOT, 'scripts', g);
  if (fs.existsSync(p)) processFile(p);
}
console.log(`green->cobalt: ${files} files, ${hits} hex replacements`);
