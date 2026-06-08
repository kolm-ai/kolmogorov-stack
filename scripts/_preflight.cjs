#!/usr/bin/env node
// Pre-deploy gate: scans everything that will actually ship (public/) for
// forbidden content + broken internal links. Read-only. Non-zero exit on any blocker.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
const files = walk(PUB);
const textFiles = files.filter(f => /\.(html|js|css|json|txt|xml|svg)$/i.test(f));
const htmlFiles = files.filter(f => f.endsWith('.html'));

// Forbidden EXACT substrings (case-sensitive unless noted).
const FORBIDDEN = [
  'pip install kolm', '.kolm bundle', '3B INT4', 'Arweave', 'On-chain',
  'Air-gap mode', 'WASM runtime', 'kolm WASM', 'EU AI Act compliant',
  'Type I evidence available now', 'SOC 2 Type II evidence',
  'Your data never moves', 'data never moves', 'inside your VPC',
  'BAA boundary', 'PHI never leaves', 'HIPAA-ready', 'Mobile SDK',
  // Personal email is itself a banned substring — decoded at runtime so neither
  // the literal nor its local-part appears verbatim anywhere in the tree, yet the
  // scan still bans it.
  Buffer.from('cm9kbmV5eWVzZXBAZ21haWwuY29t', 'base64').toString('utf8'), 'AIUC-1',
];
const blockers = [];
const warnings = [];

for (const rel of textFiles) {
  const txt = fs.readFileSync(path.join(PUB, rel), 'utf8');
  for (const sub of FORBIDDEN) {
    if (txt.includes(sub)) blockers.push(`FORBIDDEN "${sub}" in public/${rel}`);
  }
  // "honest"/"honesty" — whole-word, case-insensitive.
  const m = txt.match(/\bhonest(?:y|ly)?\b/i);
  if (m) blockers.push(`BANNED WORD "${m[0]}" in public/${rel}`);
}

// Contact email: dev@kolm.ai should be the only contact mailto.
const mailtos = new Set();
for (const rel of htmlFiles) {
  const txt = fs.readFileSync(path.join(PUB, rel), 'utf8');
  for (const mm of txt.matchAll(/mailto:([^"'\s>]+)/gi)) mailtos.add(mm[1].toLowerCase());
}
for (const e of mailtos) {
  if (e !== 'dev@kolm.ai' && !e.startsWith('dev@kolm.ai')) warnings.push(`non-canonical mailto: ${e}`);
}

// Broken internal links: extract href/src that are local clean URLs and verify
// they resolve to a live file (clean URL -> .html, or a real asset).
const liveClean = new Set(htmlFiles.map(f => {
  let u = '/' + f.replace(/\.html$/, '');
  u = u.replace(/\/index$/, '');
  if (u === '') u = '/';
  return u;
}));
const liveAssets = new Set(files.map(f => '/' + f));
function resolves(href) {
  let h = href.split(/[?#]/)[0];
  if (!h || h === '/') return true;
  if (/^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(href)) return true;
  if (!h.startsWith('/')) return true; // relative/anchor — skip (rare in this site)
  if (liveAssets.has(h)) return true;
  if (h.endsWith('/')) h = h.slice(0, -1);
  if (liveClean.has(h)) return true;
  if (liveAssets.has(h + '.html')) return true;
  return false;
}
const broken = new Map(); // href -> [pages]
for (const rel of htmlFiles) {
  const txt = fs.readFileSync(path.join(PUB, rel), 'utf8');
  for (const mm of txt.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const href = mm[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(href)) continue;
    if (!href.startsWith('/')) continue;
    if (!resolves(href)) {
      if (!broken.has(href)) broken.set(href, []);
      broken.get(href).push(rel);
    }
  }
}
for (const [href, pages] of broken) {
  blockers.push(`BROKEN LINK ${href} (in ${[...new Set(pages)].slice(0, 3).join(', ')}${pages.length > 3 ? '…' : ''})`);
}

console.log(`scanned: ${textFiles.length} text files, ${htmlFiles.length} html pages`);
console.log(`mailtos found: ${[...mailtos].join(', ') || '(none)'}`);
console.log(`\nWARNINGS (${warnings.length}):`);
for (const w of warnings) console.log('  ⚠ ' + w);
console.log(`\nBLOCKERS (${blockers.length}):`);
for (const b of blockers) console.log('  ✖ ' + b);
if (blockers.length) { console.log('\nPRE-FLIGHT: FAIL'); process.exit(1); }
console.log('\nPRE-FLIGHT: PASS — no forbidden content, no broken internal links.');
