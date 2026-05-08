const fs = require('fs');
const path = require('path');

const dead = ['/architecture','/launch','/motion','/manual','/failure-modes','/troubleshooting','/glossary','/onboarding'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
}

const files = [];
walk('public', files);

let touched = 0;
for (const f of files) {
  const orig = fs.readFileSync(f, 'utf8');
  let s = orig;
  for (const d of dead) {
    const esc = d.replace(/[-/]/g, '\\$&');
    const re = new RegExp('[\\t ]*<a\\s[^>]*href="' + esc + '"[^>]*>[^<]*<\\/a>[ \\t]*\\n?', 'g');
    s = s.replace(re, '');
  }
  if (s !== orig) {
    fs.writeFileSync(f, s);
    touched++;
  }
}
console.log('touched', touched, 'files');
