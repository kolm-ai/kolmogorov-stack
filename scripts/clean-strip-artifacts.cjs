#!/usr/bin/env node
/**
 * Second pass over the dead-link strip output: removes the structural
 * debris the first pass left behind (empty <li></li>, trailing punctuation
 * before </span>, double commas, empty footer <a> slots, broken bullets).
 *
 * Idempotent. Walks public/ HTML files only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

let touched = 0;
for (const file of walk(ROOT)) {
  let s = fs.readFileSync(file, 'utf8');
  const orig = s;

  // 1. empty <li></li> (with optional whitespace inside)
  s = s.replace(/^[ \t]*<li>\s*<\/li>\r?\n/gm, '');

  // 2. double commas like ",," (sometimes ", ," or ",  ,") that appear when a
  //    middle <a> in a separator-list was stripped to nothing
  s = s.replace(/,(\s*),(?!,)/g, ',');

  // 3. trailing "&middot;</span>" or ",</span>" or " &middot; </span>"
  s = s.replace(/(\s*&middot;\s*)+<\/span>/g, '</span>');
  s = s.replace(/,(\s*)<\/span>/g, '</span>');

  // 4. Tidy footer column "<a>...</a>\n        \n        <a>" patterns where
  //    the strip left a blank line between two surviving <a>s.
  s = s.replace(/(<a [^>]+>[^<]*<\/a>)\n(\s*)\n(\s*<a )/g, '$1\n$3');

  // 5. Sentence-join bug: ".covers" / "..covers" — only fixable case-by-case;
  //    we patch the one known instance: api.html "semantics.covers"
  s = s.replace(/HTTP semantics\.\s*covers the operator action for each\./g,
                'Status codes follow standard HTTP semantics.');

  // 6. how-it-works.html broken bullet "<li>- how the compiler fails closed</li>"
  s = s.replace(/<li>\s*-\s*how the compiler fails closed<\/li>\r?\n/g, '');

  // 7. Em-dash audit list with comma-comma artifact: ", ," -> ","
  s = s.replace(/,\s*,/g, ',');

  if (s !== orig) {
    fs.writeFileSync(file, s);
    touched++;
    console.log('cleaned', path.relative(ROOT, file));
  }
}

console.log(`\ntouched ${touched} files`);
