// Docs family de-jargon: "Wrapper"->"gateway", "surface"->"interface/tools" in
// docs body + the docs generators. Plus a cobalt .brand-eyebrow rule so docs
// eyebrows match the spine. Targeted product-jargon phrases only (not bare "wrapper").
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const REPLACEMENTS = [
  ['Wrapper gateway', 'Gateway'],
  ['Wrapper docs', 'Gateway docs'],
  ['The Wrapper', 'The gateway'],
  ['the Wrapper', 'the gateway'],
  ['The wrapper', 'The gateway'],
  ['the wrapper', 'the gateway'],
  ['>Wrapper<', '>Gateway<'],
  ['Forge surface', 'compile and distill tools'],
  ['the Forge', 'the compiler'],
  ['OpenAI-compatible surface', 'OpenAI-compatible interface'],
  ['Three surfaces', 'Three ways in'],
  ['three surfaces', 'three ways in'],
  ['tool surface', 'tool interface'],
  ['MCP tool surface', 'MCP tools'],
];

let files = 0, hits = 0;
function processFile(full) {
  let s;
  try { s = fs.readFileSync(full, 'utf8'); } catch { return; }
  let out = s, n = 0;
  for (const [from, to] of REPLACEMENTS) {
    if (out.includes(from)) { n += out.split(from).length - 1; out = out.split(from).join(to); }
  }
  if (n > 0 && out !== s) { fs.writeFileSync(full, out); files++; hits += n; }
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['_archive', '_generations'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.html')) processFile(full);
  }
}
walk(path.join(ROOT, 'public', 'docs'));
for (const g of ['wave887-docs-generator.cjs', 'build-docs-w374.cjs', 'build-wrapper-docs-capture-receipts.cjs', 'build-wrapper-docs-gateway-routing.cjs', 'write-missing-cli-docs.cjs', 'write-extra-cli-docs.cjs', 'build-cli-docs.cjs']) {
  const p = path.join(ROOT, 'scripts', g);
  if (fs.existsSync(p)) processFile(p);
}

// Cobalt docs eyebrow (was grey/inherited).
const shell = path.join(ROOT, 'public', 'docs-shell.css');
if (fs.existsSync(shell)) {
  let css = fs.readFileSync(shell, 'utf8');
  if (!css.includes('/* w929 cobalt eyebrow */')) {
    css += '\n/* w929 cobalt eyebrow */\n.brand-eyebrow, .docs-eyebrow, .doc-kicker { color: #2563eb !important; }\n';
    fs.writeFileSync(shell, css);
    console.log('docs-shell.css: cobalt brand-eyebrow rule appended');
  }
}
console.log(`docs de-jargon: ${files} files, ${hits} replacements`);
