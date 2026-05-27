// W893-Part1 — add a Blog link to the Build column of every public/*.html
// footer that uses the canonical ks-foot__col / ks-footer__grid pattern.
// Inserted between "Benchmarks" and "FAQ" per the W893 plan.
//
// Idempotent: any file that already mentions href="/blog" in the Build column
// is skipped.
//
// Run: node scripts/w893-add-blog-to-build-column.cjs

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// Known patterns the footer has accumulated across pages.
const PATTERNS = [
  {
    find: '<a href="/benchmarks">Benchmarks</a>\n        <a href="/faq">FAQ</a>',
    replace: '<a href="/benchmarks">Benchmarks</a>\n        <a href="/blog">Blog</a>\n        <a href="/faq">FAQ</a>',
  },
  {
    find: '<a href="/benchmarks">Benchmarks</a><a href="/faq">FAQ</a>',
    replace: '<a href="/benchmarks">Benchmarks</a><a href="/blog">Blog</a><a href="/faq">FAQ</a>',
  },
  {
    find: '<li><a href="/benchmarks">Benchmarks</a></li><li><a href="/faq">FAQ</a></li>',
    replace: '<li><a href="/benchmarks">Benchmarks</a></li><li><a href="/blog">Blog</a></li><li><a href="/faq">FAQ</a></li>',
  },
  // hidden compare anchor sits between the two visible lines on ~50 pages.
  {
    find: '<a href="/benchmarks">Benchmarks</a><a href="/compare" hidden aria-hidden="true">compare</a>\n        <a href="/faq">FAQ</a>',
    replace: '<a href="/benchmarks">Benchmarks</a><a href="/compare" hidden aria-hidden="true">compare</a>\n        <a href="/blog">Blog</a>\n        <a href="/faq">FAQ</a>',
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

      // Only touch files that have a Build column footer pattern.
      const hasBuildCol = raw.includes('>Build</h4>') || raw.includes('"/benchmarks">Benchmarks</a>');
      if (!hasBuildCol) {
        continue;
      }

      // If a Blog link already exists in the Build column area, skip.
      // Detect "Build column nearby" by searching the Build heading and looking
      // ~600 chars ahead for /blog.
      const buildIdx = raw.indexOf('>Build</h4>');
      if (buildIdx >= 0) {
        const window = raw.slice(buildIdx, buildIdx + 700);
        if (window.includes('href="/blog"')) {
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
      // Fallback: if no fixed pattern hit but the Build column still has
      // a Benchmarks link and no Blog link, inject Blog right after the
      // first Benchmarks anchor within the Build-col window.
      if (!matched) {
        const buildIdx2 = raw.indexOf('>Build</h4>');
        if (buildIdx2 >= 0) {
          const windowEnd = raw.indexOf('</div>', buildIdx2);
          if (windowEnd > buildIdx2) {
            const before = raw.slice(0, buildIdx2);
            const win    = raw.slice(buildIdx2, windowEnd);
            const after  = raw.slice(windowEnd);
            const benchAnchor = '<a href="/benchmarks">Benchmarks</a>';
            const faqAnchor = '<a href="/faq">FAQ</a>';
            if (win.includes(benchAnchor) && !win.includes('href="/blog"')) {
              // detect indent from the line containing benchAnchor
              const lines = win.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(benchAnchor)) {
                  const indent = (lines[i].match(/^(\s*)/) || ['',''])[1];
                  lines.splice(i + 1, 0, `${indent}<a href="/blog">Blog</a>`);
                  break;
                }
              }
              raw = before + lines.join('\n') + after;
              matched = true;
            } else if (win.includes(faqAnchor) && !win.includes('href="/blog"')) {
              // no Benchmarks, but there's a FAQ — inject Blog right before FAQ
              const lines = win.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(faqAnchor)) {
                  const indent = (lines[i].match(/^(\s*)/) || ['',''])[1];
                  lines.splice(i, 0, `${indent}<a href="/blog">Blog</a>`);
                  break;
                }
              }
              raw = before + lines.join('\n') + after;
              matched = true;
            } else if (!win.includes('href="/blog"')) {
              // last resort: append Blog at end of Build column window
              const updated = win.replace(
                /(<\/h4>[\s\S]*?)(\n\s*$)/,
                (_, body, tail) => `${body}<a href="/blog">Blog</a>${tail}`,
              );
              if (updated !== win) {
                raw = before + updated + after;
                matched = true;
              } else {
                // inline single-line build col (e.g., <h4>Build</h4><a...><a...>)
                const m = win.match(/<\/h4>([\s\S]*)$/);
                if (m && !m[1].includes('href="/blog"')) {
                  const newWin = win.replace(/<\/h4>([\s\S]*)$/, `</h4>$1<a href="/blog">Blog</a>`);
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
