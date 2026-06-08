#!/usr/bin/env node
/* gate-constraints.cjs — site-wide hard-constraint + design-hand consistency gate.
 *
 * HARD FAILS (block deploy): forbidden substrings, em/en dashes, the word
 * "honest"/"honesty", personal-identity leaks, any contact email other than
 * dev@kolm.ai, missing shell-asset refs, missing fail-open reveal script,
 * a drifted primary nav, a missing/garbled footer, an undefined CSS var.
 *
 * ADVISORY (report, do not block): missing ledger beat (.section--ink),
 * missing final CTA (.cta-final), missing idx markers, missing scope line.
 *
 * Reads every *.html under public/ (recursively). No deps.
 */
const fs = require('fs');
const path = require('path');

const PUB = path.resolve(__dirname, '..', 'public');

// --- forbidden case-sensitive substrings (from the plan's hard constraints) ---
const FORBIDDEN = [
  'pip install kolm', '.kolm bundle', '3B INT4', 'Arweave', 'On-chain',
  'Air-gap mode', 'WASM runtime', 'kolm WASM', 'EU AI Act compliant',
  'Type I evidence available now', 'SOC 2 Type II evidence', 'Your data never moves',
  'data never moves', 'inside your VPC', 'BAA boundary', 'PHI never leaves',
  'HIPAA-ready', 'Mobile SDK', 'AIUC-1',
];

// canonical primary nav (href -> label). Every page's <header class="nav"> must
// carry exactly these five primary links in order.
const NAV = [
  ['/how-it-works', 'How it works'],
  ['/checks', 'What we test'],
  ['/pricing', 'Pricing'],
  ['/trust', 'Trust'],
  ['/docs', 'Docs'],
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const files = walk(PUB).sort();
let hardFails = 0, advisories = 0;
const report = [];

for (const file of files) {
  const rel = path.relative(PUB, file).replace(/\\/g, '/');
  const html = fs.readFileSync(file, 'utf8');
  const hard = [], adv = [];

  // 1. forbidden substrings (case-sensitive)
  for (const s of FORBIDDEN) if (html.includes(s)) hard.push(`forbidden substring "${s}"`);

  // 2. em / en dashes (and the figure-dash + horizontal-bar variants)
  const dashes = (html.match(/[‒–—―]/g) || []);
  if (dashes.length) {
    // show a little context for the first one
    const i = html.search(/[‒–—―]/);
    const ctx = html.slice(Math.max(0, i - 30), i + 30).replace(/\s+/g, ' ');
    hard.push(`${dashes.length} em/en dash(es) — first near: …${ctx}…`);
  }

  // 3. the word honest / honesty (case-insensitive, word-ish)
  const honest = html.match(/honest(y|ly)?/i);
  if (honest) hard.push(`banned word "${honest[0]}"`);

  // 4. personal-identity leaks
  if (/rodneyyesep/i.test(html)) hard.push('personal-identity leak "rodneyyesep"');

  // 5. contact email: any mailto whose ADDRESS is not dev@kolm.ai. A ?subject=/
  //    &body= query after the address is fine (good UX), so strip it first.
  const mailtos = [...html.matchAll(/mailto:([^"'\s>?]+)/g)].map((m) => m[1].toLowerCase());
  for (const m of mailtos) if (m !== 'dev@kolm.ai') hard.push(`non-canonical contact email "${m}"`);

  // 6. shell-asset refs (the design system must be loaded)
  if (!/\/kolm-2026\.css/.test(html)) hard.push('missing kolm-2026.css link');
  if (!/\/kolm-2026\.js/.test(html)) hard.push('missing kolm-2026.js script');

  // 7. fail-open reveal script (the W921 lesson — armed before first paint)
  if (!/js-reveal/.test(html) || !/data-reveal-armed/.test(html)) hard.push('missing fail-open reveal script');

  // 8. primary nav: each canonical link present, in order
  const navMatch = html.match(/<nav class="nav__links"[\s\S]*?<\/nav>/);
  if (!navMatch) hard.push('missing primary nav block');
  else {
    const nav = navMatch[0];
    let lastIdx = -1, drift = false;
    for (const [href, label] of NAV) {
      const re = new RegExp(`<a href="${href.replace(/\//g, '\\/')}">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/a>`);
      const m = nav.search(re);
      if (m === -1) { hard.push(`nav missing link ${href} (${label})`); drift = true; }
      else if (m < lastIdx) { drift = true; }
      else lastIdx = m;
    }
    if (drift) hard.push('nav links drifted from canonical order/set');
  }

  // 9. footer present + canonical contact line
  if (!/<footer class="foot">/.test(html)) hard.push('missing canonical footer');

  // 10. undefined CSS var sentinel (caught terms.html earlier: var(--surface-1))
  const badVar = html.match(/var\(--surface-1\)/);
  if (badVar) hard.push('undefined CSS var(--surface-1)');

  // --- advisory (design-hand completeness; legal/secondary pages may skip) ---
  if (!/section--ink/.test(html)) adv.push('no dark ledger beat (.section--ink)');
  if (!/cta-final/.test(html)) adv.push('no final CTA (.cta-final)');
  if (!/class="idx"/.test(html)) adv.push('no idx section markers');

  if (hard.length) hardFails += hard.length;
  if (adv.length) advisories += adv.length;
  report.push({ rel, hard, adv });
}

// --- print ---
for (const r of report) {
  if (!r.hard.length && !r.adv.length) { console.log(`  ok    ${r.rel}`); continue; }
  const tag = r.hard.length ? 'FAIL ' : 'adv  ';
  console.log(`  ${tag} ${r.rel}`);
  for (const h of r.hard) console.log(`         ✗ ${h}`);
  for (const a of r.adv) console.log(`         · ${a}`);
}

console.log(`\n${files.length} pages · ${hardFails} hard fail(s) · ${advisories} advisory note(s)`);
if (hardFails) { console.log('GATE: FAIL — hard constraints violated'); process.exit(1); }
console.log('GATE: PASS — no hard-constraint violations' + (advisories ? ' (advisories are non-blocking)' : ''));
process.exit(0);
