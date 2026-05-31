// Final jargon sweep across live surfaces: the remaining product-jargon PHRASES
// (not standalone product names on /wrapper /studio, not historical blog/feed).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const REPLACEMENTS = [
  ['Wrap any model API', 'Route any model API'],
  ['Wrap any model', 'Route any model'],
  ['browser face of the kolm compiler', 'no-code browser studio for the kolm compiler'],
  ['Browser face of the kolm compiler', 'No-code browser studio for the kolm compiler'],
  ['browser face', 'browser studio'],
  ['Browser face', 'Browser studio'],
  ['Pick the surface that fits the moment', 'Pick the path that fits the moment'],
  ['pick the surface that fits how you work', 'pick the path that fits how you work'],
  ['pick the surface', 'pick the path'],
  ['Same compiler, three surfaces', 'Same compiler, three ways in'],
  ['three surfaces', 'three ways in'],
  ['Three surfaces', 'Three ways in'],
  ['Surface 1', 'Path 1'], ['Surface 2', 'Path 2'], ['Surface 3', 'Path 3'],
  ['surface 1', 'path 1'], ['surface 2', 'path 2'], ['surface 3', 'path 3'],
  ['The Wrapper', 'The gateway'],
  ['the Wrapper', 'the gateway'],
  ['The wrapper', 'The gateway'],
  ['the wrapper', 'the gateway'],
  ['>Wrapper<', '>Gateway<'],
];

const SKIP_FILE = (name, rel) => /\/blog\//.test(rel) || name === 'feed.xml';
let files = 0, hits = 0;
function processFile(full, rel) {
  let s; try { s = fs.readFileSync(full, 'utf8'); } catch { return; }
  let out = s, n = 0;
  for (const [from, to] of REPLACEMENTS) { if (out.includes(from)) { n += out.split(from).length - 1; out = out.split(from).join(to); } }
  if (n > 0 && out !== s) { fs.writeFileSync(full, out); files++; hits += n; }
}
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['_archive', '_generations'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = full.replace(/\\/g, '/');
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(html|md)$/.test(e.name)) continue;
    if (SKIP_FILE(e.name, rel)) continue;
    processFile(full, rel);
  }
}
walk(path.join(ROOT, 'public'));
for (const g of ['build-account-pages.cjs', 'wave887-docs-generator.cjs']) {
  const p = path.join(ROOT, 'scripts', g);
  if (fs.existsSync(p)) processFile(p, g);
}
console.log(`final jargon sweep: ${files} files, ${hits} replacements`);
