#!/usr/bin/env node
/**
 * Sweep every HTML page in /public and ensure the primary nav contains a
 * /research link in the canonical position between /docs and /pricing.
 *
 * Idempotent: pages that already have the link are skipped.
 * Touches both modern (.site-nav) and legacy (.left nav) header shapes.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (extname(entry) === '.html') out.push(p);
  }
  return out;
}

const MODERN_PRICING = /<a href="\/pricing">(\s*)Pricing<\/a>/;
const LEGACY_PRICING = /<a href="\/pricing">(\s*)Pricing<\/a>/;
const RESEARCH = /href="\/research"/;

let touched = 0, skipped = 0, noNav = 0;
const files = walk(ROOT);
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  if (!before.includes('<nav') || !before.includes('href="/pricing"')) { noNav++; continue; }
  if (RESEARCH.test(before)) { skipped++; continue; }

  // Both header shapes use the same `<a href="/pricing">Pricing</a>` line.
  // Insert the Research link immediately before it, preserving indentation.
  const lines = before.split('\n');
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)<a href="\/pricing">Pricing<\/a>\s*$/);
    if (m) {
      lines.splice(i, 0, `${m[1]}<a href="/research">Research</a>`);
      inserted = true;
      break;
    }
  }
  if (!inserted) { skipped++; continue; }

  writeFileSync(file, lines.join('\n'));
  touched++;
}
console.log(`fix-nav-research: touched=${touched} skipped=${skipped} no-nav=${noNav} total=${files.length}`);
