#!/usr/bin/env node
// unify-chrome.cjs — make the shared chrome byte-identical across every page.
// Extracts the CANONICAL nav <header class="nav">…</header>, the footer block
// (the foil-line hr + <footer class="foot">…</footer>), and the theme-color meta
// straight from the flagship public/index.html at runtime, then stamps them onto
// the 26 secondary pages. Deterministic, no LLM. Content between nav and footer
// (each page's <main>) is never touched. Run --write to apply (default = dry).
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const WRITE = process.argv.includes('--write');

const flagship = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function extract(re, src, label) {
  const m = src.match(re);
  if (!m) { throw new Error(`could not extract ${label} from index.html`); }
  return m[0];
}
const NAV = extract(/<header class="nav">[\s\S]*?<\/header>/, flagship, 'nav');
const FOOT = extract(/(?:<hr class="foil-line"[^>]*>\s*)?<footer class="foot">[\s\S]*<\/footer>/, flagship, 'footer');
const THEME = extract(/<meta name="theme-color" content="[^"]*">/, flagship, 'theme-color');

// the 26 secondary pages (everything render-audit-shots renders except home)
const PAGES = [
  '404.html', 'acceptable-use.html', 'baa.html', 'careers.html', 'changelog.html',
  'checks.html', 'contact.html', 'docs.html', 'dpa.html', 'enterprise.html',
  'how-it-works.html', 'platform.html', 'pricing.html', 'privacy.html', 'report.html',
  'research.html', 'security.html', 'security/threat-model.html', 'sla.html',
  'solutions/ai-vendors.html', 'solutions/enterprise-buyers.html', 'status.html',
  'subprocessors.html', 'terms.html', 'transparency-log.html', 'trust.html', 'verify.html',
];

const NAV_RE = /<header class="nav">[\s\S]*?<\/header>/;
const FOOT_RE = /(?:<hr class="foil-line"[^>]*>\s*)?<footer[\s\S]*<\/footer>/;
const THEME_RE = /<meta name="theme-color" content="[^"]*">/;

let changed = 0, untouched = 0, problems = 0;
const rows = [];
for (const rel of PAGES) {
  const file = path.join(pub, rel);
  if (!fs.existsSync(file)) { rows.push(`MISSING  ${rel}`); problems++; continue; }
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  const notes = [];

  if (NAV_RE.test(src)) { src = src.replace(NAV_RE, NAV); } else { notes.push('no-nav'); problems++; }
  if (FOOT_RE.test(src)) { src = src.replace(FOOT_RE, FOOT); } else { notes.push('no-footer'); problems++; }
  if (THEME_RE.test(src)) { src = src.replace(THEME_RE, THEME); } else { notes.push('no-theme'); }

  const diff = before !== src;
  if (diff) changed++; else untouched++;
  if (WRITE && diff) fs.writeFileSync(file, src);
  rows.push(`${diff ? (WRITE ? 'wrote ' : 'would ') : 'same  '}${rel}${notes.length ? '  :: ' + notes.join(', ') : ''}`);
}

console.log(rows.join('\n'));
console.log(`\n${WRITE ? 'APPLIED' : 'DRY RUN'}: ${changed} changed, ${untouched} already-canonical, ${problems} problem(s)`);
console.log(`nav ${NAV.length}b · footer ${FOOT.length}b · theme "${THEME.match(/content="([^"]*)"/)[1]}"`);
process.exit(problems ? 1 : 0);
