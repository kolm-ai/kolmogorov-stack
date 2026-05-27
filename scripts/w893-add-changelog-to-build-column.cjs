// W893-Part1.4 — add a Changelog link to the Build column of every public/*.html
// footer. Inserted AFTER "FAQ" per the W893 plan.
//
// Idempotent: any file that already mentions href="/changelog" in the Build column
// is skipped.
//
// Run: node scripts/w893-add-changelog-to-build-column.cjs

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const PATTERNS = [
  // Canonical multi-line column: FAQ is the last anchor before the closing tag.
  {
    find: '<a href="/blog">Blog</a>\n        <a href="/faq">FAQ</a>',
    replace: '<a href="/blog">Blog</a>\n        <a href="/faq">FAQ</a>\n        <a href="/changelog">Changelog</a>',
  },
  // Files that never picked up Blog (skip-list / off-pattern): inject after FAQ directly.
  {
    find: '<a href="/benchmarks">Benchmarks</a>\n        <a href="/faq">FAQ</a>',
    replace: '<a href="/benchmarks">Benchmarks</a>\n        <a href="/faq">FAQ</a>\n        <a href="/changelog">Changelog</a>',
  },
  // Inline single-line variant.
  {
    find: '<a href="/blog">Blog</a><a href="/faq">FAQ</a>',
    replace: '<a href="/blog">Blog</a><a href="/faq">FAQ</a><a href="/changelog">Changelog</a>',
  },
  {
    find: '<a href="/benchmarks">Benchmarks</a><a href="/faq">FAQ</a>',
    replace: '<a href="/benchmarks">Benchmarks</a><a href="/faq">FAQ</a><a href="/changelog">Changelog</a>',
  },
  // <li>-wrapped variant.
  {
    find: '<li><a href="/blog">Blog</a></li><li><a href="/faq">FAQ</a></li>',
    replace: '<li><a href="/blog">Blog</a></li><li><a href="/faq">FAQ</a></li><li><a href="/changelog">Changelog</a></li>',
  },
  {
    find: '<li><a href="/benchmarks">Benchmarks</a></li><li><a href="/faq">FAQ</a></li>',
    replace: '<li><a href="/benchmarks">Benchmarks</a></li><li><a href="/faq">FAQ</a></li><li><a href="/changelog">Changelog</a></li>',
  },
];

let scanned = 0;
let changed = 0;
let skipped = 0;
let nopattern = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
    } else if (ent.isFile() && ent.name.endsWith('.html')) {
      scanned += 1;
      let raw = fs.readFileSync(p, 'utf-8');

      const hasBuildCol = raw.includes('>Build</h4>') || raw.includes('"/benchmarks">Benchmarks</a>');
      if (!hasBuildCol) {
        continue;
      }

      // If Changelog already exists in the Build column window, skip.
      const buildIdx = raw.indexOf('>Build</h4>');
      if (buildIdx >= 0) {
        const window = raw.slice(buildIdx, buildIdx + 800);
        if (window.includes('href="/changelog"')) {
          skipped += 1;
          continue;
        }
      }

      let matched = false;
      for (const { find, replace } of PATTERNS) {
        if (raw.includes(find)) {
          raw = raw.split(find).join(replace);
          matched = true;
        }
      }

      // Fallback: if no fixed pattern hit but the Build column has a FAQ anchor
      // and no Changelog anchor, inject Changelog right after the first FAQ anchor
      // within the Build-col window.
      if (!matched) {
        const buildIdx2 = raw.indexOf('>Build</h4>');
        if (buildIdx2 >= 0) {
          const windowEnd = raw.indexOf('</div>', buildIdx2);
          if (windowEnd > buildIdx2) {
            const before = raw.slice(0, buildIdx2);
            const win    = raw.slice(buildIdx2, windowEnd);
            const after  = raw.slice(windowEnd);
            const faqAnchor = '<a href="/faq">FAQ</a>';
            if (win.includes(faqAnchor) && !win.includes('href="/changelog"')) {
              const lines = win.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(faqAnchor)) {
                  const indent = (lines[i].match(/^(\s*)/) || ['',''])[1];
                  lines.splice(i + 1, 0, `${indent}<a href="/changelog">Changelog</a>`);
                  break;
                }
              }
              raw = before + lines.join('\n') + after;
              matched = true;
            } else if (!win.includes('href="/changelog"')) {
              // Last-resort append at end of Build column window.
              const updated = win.replace(
                /(<\/h4>[\s\S]*?)(\n\s*$)/,
                (_, body, tail) => `${body}<a href="/changelog">Changelog</a>${tail}`,
              );
              if (updated !== win) {
                raw = before + updated + after;
                matched = true;
              } else {
                const m = win.match(/<\/h4>([\s\S]*)$/);
                if (m && !m[1].includes('href="/changelog"')) {
                  const newWin = win.replace(/<\/h4>([\s\S]*)$/, `</h4>$1<a href="/changelog">Changelog</a>`);
                  raw = before + newWin + after;
                  matched = true;
                }
              }
            }
          }
        }
      }
      if (!matched) {
        nopattern += 1;
        continue;
      }
      fs.writeFileSync(p, raw);
      changed += 1;
    }
  }
}

walk(PUBLIC_DIR);
console.log(`scanned:        ${scanned}`);
console.log(`changed:        ${changed}`);
console.log(`skipped (had):  ${skipped}`);
console.log(`no pattern:     ${nopattern}`);
