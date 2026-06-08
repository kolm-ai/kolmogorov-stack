#!/usr/bin/env node
// verify-editorial.cjs — gate the editorial pass across the 27 secondary pages.
// Checks: zero em/en dashes, zero forbidden substrings, no "honest(y)" word,
// eyebrow cleanup, structural landmarks intact, and size sanity vs baseline
// (so an agent can't have silently dropped content while de-dashing).
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');

// bytes captured AFTER head-normalization, BEFORE the editorial pass.
const BASELINE = {
  '404.html': 8014, 'acceptable-use.html': 8977, 'baa.html': 21397, 'careers.html': 8214,
  'changelog.html': 7280, 'checks.html': 10687, 'contact.html': 13915, 'docs.html': 10032,
  'dpa.html': 21981, 'enterprise.html': 9615, 'how-it-works.html': 11359, 'platform.html': 9324,
  'pricing.html': 16159, 'privacy.html': 23124, 'report.html': 12297, 'research.html': 10130,
  'security.html': 20554, 'security/threat-model.html': 9058, 'sla.html': 9198,
  'solutions/ai-vendors.html': 8836, 'solutions/enterprise-buyers.html': 8900, 'status.html': 13260,
  'subprocessors.html': 8128, 'terms.html': 33765, 'transparency-log.html': 9417,
  'trust.html': 11593, 'verify.html': 24928,
};

const FORBIDDEN = [
  'pip install kolm', '.kolm bundle', '3B INT4', 'Arweave', 'On-chain', 'Air-gap mode',
  'WASM runtime', 'kolm WASM', 'EU AI Act compliant', 'Type I evidence available now',
  'SOC 2 Type II evidence', 'Your data never moves', 'data never moves', 'inside your VPC',
  'BAA boundary', 'PHI never leaves', 'HIPAA-ready', 'Mobile SDK', 'AIUC-1',
];
const DASHES = /—|–|&mdash;|&ndash;/g;
const HONEST = /\bhonest(y|ly)?\b/i;

let fail = 0;
const lines = [];
function rel(p) { return path.relative(pub, p).replace(/\\/g, '/'); }

for (const r of Object.keys(BASELINE)) {
  const file = path.join(pub, r);
  if (!fs.existsSync(file)) { lines.push(`MISSING  ${r}`); fail++; continue; }
  const src = fs.readFileSync(file, 'utf8');
  const issues = [];

  const dn = (src.match(DASHES) || []).length;
  if (dn > 0) issues.push(`${dn} dash glyph(s)`);

  const eb = (src.match(/class="eyebrow"/g) || []).length;
  // eyebrows are allowed to survive (CSS floor styles them) but flag for review.

  for (const sub of FORBIDDEN) if (src.includes(sub)) issues.push(`FORBIDDEN "${sub}"`);
  if (HONEST.test(src)) issues.push('contains "honest(y)"');

  if (!/<footer/i.test(src)) issues.push('no <footer>');
  if (!/<(nav|header)/i.test(src)) issues.push('no nav/header');

  const bytes = Buffer.byteLength(src);
  const base = BASELINE[r];
  const pct = ((bytes - base) / base) * 100;
  if (pct < -18) issues.push(`shrank ${pct.toFixed(0)}% (${base}->${bytes}) — possible content loss`);

  const tag = issues.length ? 'FAIL ' : 'ok   ';
  if (issues.length) fail++;
  lines.push(`${tag}${r}  dashes=${dn} eyebrow=${eb} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%${issues.length ? '  :: ' + issues.join('; ') : ''}`);
}

console.log(lines.join('\n'));
console.log('\n' + (fail ? `VERIFY: FAIL (${fail} file(s))` : 'VERIFY: PASS — 27/27 clean'));
process.exit(fail ? 1 : 0);
