#!/usr/bin/env node
// W619 docs reorg: inject /docs-shell.css + /docs-shell.js into every
// HTML page under public/docs. Idempotent — re-runs are no-ops.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DOCS = path.join(ROOT, 'docs');

// Marker so we don't double-patch.
const MARKER = '<!-- ds-shell W619 -->';
const INJECT =
  MARKER + '\n' +
  '<link rel="stylesheet" href="/docs-shell.css">\n' +
  '<script defer src="/docs-shell.js"></script>\n';

function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

const files = walk(DOCS, []);
let patched = 0;
let skipped = 0;

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes(MARKER)) { skipped++; continue; }
  // Inject right after the ks.css link if present, otherwise before </head>.
  const ksRe = /<link[^>]*rel="stylesheet"[^>]*href="\/ks\.css"[^>]*>/i;
  if (ksRe.test(s)) {
    s = s.replace(ksRe, function (m) { return m + '\n' + INJECT; });
  } else if (/<\/head>/i.test(s)) {
    s = s.replace(/<\/head>/i, INJECT + '</head>');
  } else {
    continue;
  }
  fs.writeFileSync(f, s);
  patched++;
}

console.log('docs pages found:', files.length);
console.log('patched:', patched, 'already had shell (skipped):', skipped);
