#!/usr/bin/env node
// Font-bleed sweep — rewrites hardcoded text colors in CSS files so they
// flip with the theme.
//
// --ink-1 is #111111 in light mode and #e6e9ee in dark mode (see
// design-tokens.css). Every place that hardcodes one of those exact values
// for a text color is a bleed waiting to happen: the rule looks right in
// the mode it was authored for, then disappears when the theme flips.
//
// Replacements (only inside `color:` declarations):
//   color: #111  / #111111 / #000 / #000000  -> color: var(--ink-1)
//   color: #e6e9ee                            -> color: var(--ink-1)
//
// White (#fff / #ffffff) is intentionally NOT swapped here — it's often
// chosen for contrast against a fixed brand-colored background (button
// labels, announce bars). Those need a targeted look, not a sweep.
//
// Skips:
//   - any rule inside a [data-theme="..."] block (those are intentional)
//   - declarations that already use var(--...)
//   - fill: / stroke: / background: (only color: is the target)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'public');

function listCssFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip /public/docs/*.html etc. — only css files matter here
      listCssFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

// Replace `color: <hex>` outside of [data-theme=...] blocks.
// We walk character by character so we can skip past any block whose
// selector contains `[data-theme=`.
function rewriteCss(src) {
  let out = '';
  let i = 0;
  let depth = 0;
  let themedBlockDepth = -1; // depth at which a themed block opened, -1 if none
  let replacements = 0;

  // Scan selectors when depth==0 to decide if we're entering a themed block.
  // Simpler approach: maintain a stack of "is this block themed".
  const themedStack = [false]; // bottom = false (top-level rules)

  while (i < src.length) {
    const c = src[i];

    if (c === '{') {
      // Look back to grab the selector that just ended.
      const selStart = (() => {
        // Walk back to previous `}` or `;` or start
        for (let j = i - 1; j >= 0; j--) {
          const cj = src[j];
          if (cj === '}' || cj === ';') return j + 1;
        }
        return 0;
      })();
      const selector = src.slice(selStart, i);
      const themed = /\[data-theme=/i.test(selector);
      themedStack.push(themed || themedStack[themedStack.length - 1]);
      depth++;
      out += c;
      i++;
      continue;
    }
    if (c === '}') {
      themedStack.pop();
      depth--;
      out += c;
      i++;
      continue;
    }

    // Only attempt rewrites inside a non-themed block at depth >= 1
    if (depth >= 1 && !themedStack[themedStack.length - 1]) {
      const rest = src.slice(i);
      // Match `color: <value>;` where value is a hex we care about, possibly with !important
      const m = rest.match(/^color:\s*(#(?:111111|111|000000|000|e6e9ee|E6E9EE))(\s*!important)?\s*;/);
      if (m) {
        out += 'color: var(--ink-1)' + (m[2] || '') + ';';
        i += m[0].length;
        replacements++;
        continue;
      }
    }

    out += c;
    i++;
  }

  return { out, replacements };
}

function run() {
  const files = listCssFiles(ROOT);
  let totalReplacements = 0;
  const changed = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { out, replacements } = rewriteCss(src);
    if (replacements > 0) {
      fs.writeFileSync(f, out);
      totalReplacements += replacements;
      changed.push({ file: path.relative(ROOT, f), replacements });
    }
  }
  console.log(JSON.stringify({
    ok: true,
    files_scanned: files.length,
    files_changed: changed.length,
    total_replacements: totalReplacements,
    changed,
  }, null, 2));
}

if (require.main === module) run();
