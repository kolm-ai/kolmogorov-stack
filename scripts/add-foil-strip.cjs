#!/usr/bin/env node
// add-foil-strip.cjs — give every secondary page the same holographic security
// thread the flagship has: a 3px foil bar as the first body child, above the
// sticky nav. Deterministic, idempotent (skips any page that already has one),
// and structure-preserving (only the <body> open tag is touched).
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');

const FILES = [
  '404.html', 'acceptable-use.html', 'baa.html', 'careers.html', 'changelog.html',
  'checks.html', 'contact.html', 'docs.html', 'dpa.html', 'enterprise.html',
  'how-it-works.html', 'platform.html', 'pricing.html', 'privacy.html', 'report.html',
  'research.html', 'security.html', 'security/threat-model.html', 'sla.html',
  'solutions/ai-vendors.html', 'solutions/enterprise-buyers.html', 'status.html',
  'subprocessors.html', 'terms.html', 'transparency-log.html', 'trust.html', 'verify.html',
];

const STRIP = '<!-- the holographic security thread: the top edge of the instrument -->\n<hr class="foil-strip" aria-hidden="true">\n';
const BODY_OPEN = /(<body[^>]*>)\r?\n/;

let changed = 0, skipped = 0, missing = 0;
const log = [];
for (const rel of FILES) {
  const file = path.join(pub, rel);
  if (!fs.existsSync(file)) { log.push(`MISSING ${rel}`); missing++; continue; }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('foil-strip')) { log.push(`skip    ${rel} (already has strip)`); skipped++; continue; }
  if (!BODY_OPEN.test(src)) { log.push(`NOBODY  ${rel} (no <body> open matched)`); missing++; continue; }
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const block = STRIP.replace(/\n/g, eol);
  src = src.replace(BODY_OPEN, (m, open) => `${open}${eol}${block}${eol}`);
  fs.writeFileSync(file, src);
  log.push(`ok      ${rel}`);
  changed++;
}
console.log(log.join('\n'));
console.log(`\nfoil-strip: ${changed} added, ${skipped} skipped, ${missing} missing/no-body`);
process.exit(missing ? 1 : 0);
