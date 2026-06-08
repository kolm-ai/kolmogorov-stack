#!/usr/bin/env node
// normalize-heads.cjs — bring every secondary page's <head> onto the Obsidian
// Foil / mono-forward system, deterministically. The flagship index.html is
// already authored by hand; this only touches the other pages.
//
//   1. font preloads  Geist/GeistMono  ->  Spline Sans Mono 400/600
//   2. theme-color    #0B0E12          ->  #0C0D10
//   3. remove the inline pre-paint theme bootstrap (<script>…kolm-2026-theme…</script>)
//   4. remove the nav theme-toggle <button class="theme-toggle">…</button>
//
// Dash glyphs (titles/meta/body) are handled separately by the editorial pass.
const fs = require('fs');
const path = require('path');

const pubDir = path.join(__dirname, '..', 'public');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name.endsWith('.html')) files.push(p);
  }
})(pubDir);

const BOOTSTRAP = /[ \t]*<script>(?:(?!<\/script>)[\s\S])*?kolm-2026-theme(?:(?!<\/script>)[\s\S])*?<\/script>\s*\r?\n/;
const TOGGLE = /[ \t]*<button class="theme-toggle"[\s\S]*?<\/button>\s*\r?\n/;

let changed = 0;
const report = [];
for (const file of files) {
  if (path.basename(file) === 'index.html' && path.dirname(file) === pubDir) continue; // flagship: hand-authored
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  const hits = [];

  if (src.includes('/fonts/Geist.woff2')) { src = src.split('/fonts/Geist.woff2').join('/fonts/SplineSansMono-400.woff2'); hits.push('preload:400'); }
  if (src.includes('/fonts/GeistMono.woff2')) { src = src.split('/fonts/GeistMono.woff2').join('/fonts/SplineSansMono-600.woff2'); hits.push('preload:600'); }
  if (src.includes('content="#0B0E12"')) { src = src.split('content="#0B0E12"').join('content="#0C0D10"'); hits.push('theme-color'); }
  if (BOOTSTRAP.test(src)) { src = src.replace(BOOTSTRAP, ''); hits.push('bootstrap'); }
  if (TOGGLE.test(src)) { src = src.replace(TOGGLE, ''); hits.push('toggle'); }

  if (src !== before) {
    fs.writeFileSync(file, src);
    changed++;
    report.push(path.relative(pubDir, file) + '  [' + hits.join(', ') + ']');
  } else {
    report.push(path.relative(pubDir, file) + '  (no change)');
  }
}

console.log(report.join('\n'));
console.log('\nnormalized', changed, 'of', files.length, 'pages');
