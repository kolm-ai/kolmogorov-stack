#!/usr/bin/env node
/* W936 Phase D — site-wide brand + nav alignment to "The AI control plane for
 * teams". Patches BOTH built public/ pages AND the generators (so regeneration
 * matches, no revert). String-level + idempotent. Does NOT touch technical doc
 * prose about the compiler/distill (a real capability) — only the brand tagline,
 * footer, and the nav anchor. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let total = 0; const touched = new Set();

function walk(dir, filter) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walk(p, filter)); else if (filter(p)) o.push(p); } return o; }

const TAGLINE = 'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.';
const FOOTER_VARIANTS = [
  'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.',
  'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.',
  'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.',
  'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.',
  'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.',
  'The AI control plane for teams. Capture, own, and govern your company’s AI in one place.',
];
const PAIRS = [
  // nav anchor (built pages already done; this catches generators + any stragglers)
  ['<a href="/solutions/teams">For teams</a>', '<a href="/solutions/teams">For teams</a>'],
  ['<li><a href="/solutions/teams">For teams</a></li>', '<li><a href="/solutions/teams">For teams</a></li>'],
  // footer taglines -> control-plane
  ...FOOTER_VARIANTS.map((v) => [v, TAGLINE]),
];

function patch(f) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { return; }
  const before = s; let n = 0;
  for (const [a, b] of PAIRS) { if (s.includes(a)) { const c = s.split(a).length - 1; n += c; s = s.split(a).join(b); } }
  if (s !== before) { fs.writeFileSync(f, s); total += n; touched.add(f); }
}

for (const f of walk(path.join(ROOT, 'public'), (p) => p.endsWith('.html'))) patch(f);
for (const f of walk(path.join(ROOT, 'scripts'), (p) => /\.(c?js|mjs)$/.test(p))) patch(f);

console.log(`Phase D brand codemod: ${total} replacements across ${touched.size} files.`);
console.log('control-plane footer taglines now:', (() => { let c = 0; for (const f of walk(path.join(ROOT, 'public'), (p) => p.endsWith('.html'))) { try { if (fs.readFileSync(f, 'utf8').includes(TAGLINE)) c++; } catch {} } return c; })());
