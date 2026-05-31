#!/usr/bin/env node
/* W936 Phase D deep pass — re-point the docs tree + families' positioning + jargon
 * to "The AI control plane for teams". Patches built pages AND generators (no regen
 * needed). Conservative on "wrapper": only clear PROSE patterns, never the real
 * `kolm wrapper` command, wrapper-cli.js, or test/code refs. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function walk(dir, filter) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walk(p, filter)); else if (filter(p)) o.push(p); } return o; }

// PROSE re-point pairs (order matters; longer/more-specific first).
const PAIRS = [
  // stale taglines / brand
  ['Compile any AI model. Run it anywhere.', 'The AI control plane for teams. Capture, own, and govern your company’s AI.'],
  ['Own your AI. Run it anywhere.', 'The AI control plane for teams.'],
  ['the open-source AI compiler', 'the AI control plane for teams'],
  ['The open-source AI compiler', 'The AI control plane for teams'],
  // wrapper (product noun) -> gateway, clear prose forms only
  ['Wrapper / Gateway', 'Gateway'],
  ['One wrapper. Eleven providers. Every call signed.', 'One gateway. Every provider. Every call captured and signed.'],
  ['One wrapper.', 'One gateway.'],
  ['the Wrapper', 'the gateway'],
  ['the wrapper', 'the gateway'],
  ['your wrapper grows', 'your gateway grows'],
  ['your wrapper', 'your gateway'],
  ['a thin wrapper', 'a thin gateway'],
  ['wrapper tax', 'gateway overhead'],
  ['Wrapper tax', 'Gateway overhead'],
  // nav/link: the product /wrapper page is the gateway/capture surface
  ['<a href="/wrapper">Overview</a>', '<a href="/capture">Gateway</a>'],
  ['href="/wrapper"', 'href="/capture"'],
];

// Files in scope: the generated families + hand-authored families + their generators.
// EXCLUDE: anything matching the real command / code (we only touch html + the
// page-generator string templates, never src/*.js or cli/*.js).
const htmlTargets = [
  ...walk(path.join(ROOT, 'public', 'docs'), (p) => p.endsWith('.html')),
  ...walk(path.join(ROOT, 'public', 'compile'), (p) => p.endsWith('.html')),
  ...walk(path.join(ROOT, 'public', 'marketplace'), (p) => p.endsWith('.html')),
  ...walk(path.join(ROOT, 'public', 'integrations'), (p) => p.endsWith('.html')),
  ...walk(path.join(ROOT, 'public', 'research'), (p) => p.endsWith('.html')),
  ...walk(path.join(ROOT, 'public', 'cookbook'), (p) => p.endsWith('.html')),
  ...walk(path.join(ROOT, 'public', 'blog'), (p) => p.endsWith('.html')),
];
const genTargets = ['wave887-docs-generator.cjs', 'build-docs-w374.cjs', 'build-seo-pages.cjs', 'build-marketplace-pages.cjs', 'build-comparison-seo.cjs', 'build-wrapper-docs-gateway-routing.cjs', 'build-wrapper-docs-capture-receipts.cjs']
  .map((f) => path.join(ROOT, 'scripts', f)).filter((f) => fs.existsSync(f));

let total = 0, files = 0;
for (const f of [...htmlTargets, ...genTargets]) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const before = s; let n = 0;
  for (const [a, b] of PAIRS) { if (s.includes(a)) { n += s.split(a).length - 1; s = s.split(a).join(b); } }
  if (s !== before) { fs.writeFileSync(f, s); total += n; files++; }
}
console.log(`Phase D deep re-point: ${total} replacements across ${files} files.`);
// residual visible "wrapper" as a standalone product noun (sanity, excl. command/code)
let resid = 0;
for (const f of htmlTargets) { try { const m = fs.readFileSync(f, 'utf8').match(/\bthe wrapper\b|\bWrapper\b(?! up)/g); if (m) resid += m.length; } catch {} }
console.log('residual prose "wrapper"/"Wrapper" (excl. command):', resid);
