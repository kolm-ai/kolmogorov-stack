#!/usr/bin/env node
// Structural verification: every public HTML page must have ks.css, body.ks,
// ks-nav header, ks-footer, and an h1. Redirect stubs are skipped.
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

const REQ = [
  { id: 'ks_css', re: /href="\/ks\.css"/, label: '/ks.css <link>' },
  { id: 'body_ks', re: /<body[^>]*class="[^"]*\bks\b/, label: 'body class="ks"' },
  { id: 'ks_nav', re: /class="ks-nav"/, label: '.ks-nav element' },
  { id: 'ks_footer', re: /class="ks-footer"|class="ks-foot"/, label: '.ks-footer or .ks-foot element' },
  { id: 'h1', re: /<h1[\s>]/, label: '<h1>' },
];

// Only flag colored-pictograph emoji here. Dingbats (✓ ✗ →) are legitimate
// ASCII-like glyphs used inside terminal-style <pre> blocks; the stricter
// wave205 lock-in covers the 10 hero marketing pages separately.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}]/u;

const findings = [];
let scanned = 0;
let skipped_redirects = 0;

for (const f of walk(root)) {
  const raw = fs.readFileSync(f, 'utf8');
  const isRedirect = /<meta[^>]*http-equiv="refresh"/i.test(raw) && raw.length < 2500;
  if (isRedirect) { skipped_redirects++; continue; }
  scanned++;
  const rel = path.relative(root, f).replace(/\\/g, '/');
  const missing = REQ.filter(r => !r.re.test(raw)).map(r => r.id);
  const hasEmoji = EMOJI.test(raw);
  if (missing.length || hasEmoji) {
    findings.push({ rel, missing, hasEmoji });
  }
}

console.log(`audit-page-structure: scanned=${scanned} skipped_redirects=${skipped_redirects} findings=${findings.length}`);
for (const f of findings.slice(0, 50)) {
  const issues = [];
  if (f.missing.length) issues.push('missing: ' + f.missing.join(','));
  if (f.hasEmoji) issues.push('contains_emoji');
  console.log(`  ${f.rel}  [${issues.join(' | ')}]`);
}
if (findings.length > 50) console.log(`  ... and ${findings.length - 50} more`);

process.exit(findings.length === 0 ? 0 : 1);
