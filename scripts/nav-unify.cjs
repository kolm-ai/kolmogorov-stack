#!/usr/bin/env node
/* nav-unify.cjs - 2026-05-24
 *
 * Walks public/**\/*.html and unifies all nav variants to the canonical
 * 5-item nav already shipped on 547 pages:
 * Wrapper / Studio / Pricing / Docs / GitHub.
 *
 * Handles three known shapes:
 *   1. <nav class="ks-nav__links">    -> bare <a>s
 *   2. <ul class="ks-nav__list">       -> <li><a></li>s
 *   3. <div class="ks-nav__sheet">     -> bare <a>s (mobile drawer)
 *
 * Run: node scripts/nav-unify.cjs [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DRY = process.argv.includes('--dry-run');

const CANONICAL = [
  { href: '/wrapper', label: 'Wrapper', rel: '' },
  { href: '/studio',  label: 'Studio',  rel: '' },
  { href: '/pricing', label: 'Pricing', rel: '' },
  { href: '/docs',    label: 'Docs',    rel: '' },
  { href: 'https://github.com/kolm-ai/kolm', label: 'GitHub', rel: ' rel="noopener"' },
];

function aTag({ href, label, rel }) {
  return `<a href="${href}"${rel}>${label}</a>`;
}

function liATag(spec) {
  return `<li>${aTag(spec)}</li>`;
}

// 1) <nav class="ks-nav__links" ...>...</nav>  -> bare <a>s
const NAV_LINKS_RE = /<nav class="ks-nav__links"([^>]*)>([\s\S]*?)<\/nav>/g;
// 2) <ul class="ks-nav__list">...</ul>          -> <li><a></li>s
const NAV_LIST_RE  = /<ul class="ks-nav__list"([^>]*)>([\s\S]*?)<\/ul>/g;
// 3) <div class="ks-nav__sheet" ...>...</div>  -> bare <a>s + trailing Sign in/Get started CTAs preserved
const NAV_SHEET_RE = /<div class="ks-nav__sheet"([^>]*)>([\s\S]*?)<\/div>/g;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function indentFor(inner, fallback) {
  const m = inner.match(/^(\s*)</);
  return m ? m[1] : fallback;
}

function tailFor(inner, fallback) {
  const m = inner.match(/(\s*)$/);
  return m ? m[1] : fallback;
}

function isCanonicalLinks(inner) {
  return inner.includes('href="/wrapper"') && inner.includes('href="/studio"') &&
         inner.includes('href="/pricing"') && inner.includes('href="/docs"') &&
         !inner.includes('href="/gateway"') && !inner.includes('href="/product"') &&
         !inner.includes('href="/use-cases"') && !inner.includes('href="/marketplace"');
}

function rebuildLinks(attrs, inner) {
  const lead = indentFor(inner, '\n        ');
  const tail = tailFor(inner, '\n      ');
  const body = CANONICAL.map((s) => lead + aTag(s)).join('');
  return `<nav class="ks-nav__links"${attrs}>${body}${tail}</nav>`;
}

function rebuildList(attrs, inner) {
  const lead = indentFor(inner, '\n      ');
  const tail = tailFor(inner, '\n    ');
  const body = CANONICAL.map((s) => lead + liATag(s)).join('');
  return `<ul class="ks-nav__list"${attrs}>${body}${tail}</ul>`;
}

function rebuildSheet(attrs, inner) {
  // Preserve "Sign in" / "Get started" CTAs from existing sheet if present.
  const signIn  = /<a href="\/signup\?intent=login"[^>]*>[^<]+<\/a>/.exec(inner);
  const getStarted = /<a href="\/signup"(?![?])[^>]*>[^<]+<\/a>/.exec(inner);
  const signInTag  = signIn ? signIn[0] : '<a href="/signup?intent=login">Sign in</a>';
  const getStartedTag = getStarted ? getStarted[0] : '<a href="/signup">Get started &rarr;</a>';
  const sep = inner.includes('\n') ? '\n    ' : '';
  const items = CANONICAL.map((s) => aTag(s));
  const body = (sep ? sep : '') + items.concat([signInTag, getStartedTag]).join(sep);
  return `<div class="ks-nav__sheet"${attrs}>${body}${sep ? '\n  ' : ''}</div>`;
}

function transform(src) {
  let count = 0;
  let out = src.replace(NAV_LINKS_RE, (whole, attrs, inner) => {
    if (isCanonicalLinks(inner)) return whole;
    count++;
    return rebuildLinks(attrs, inner);
  });
  out = out.replace(NAV_LIST_RE, (whole, attrs, inner) => {
    if (isCanonicalLinks(inner)) return whole;
    count++;
    return rebuildList(attrs, inner);
  });
  out = out.replace(NAV_SHEET_RE, (whole, attrs, inner) => {
    if (isCanonicalLinks(inner)) return whole;
    count++;
    return rebuildSheet(attrs, inner);
  });
  return { out, count };
}

function main() {
  const files = walk(ROOT);
  let touched = 0;
  let total = 0;
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { out, count } = transform(src);
    if (count > 0) {
      if (!DRY) fs.writeFileSync(f, out, 'utf8');
      touched++;
      total += count;
      hits.push(`${count.toString().padStart(3)}  ${path.relative(ROOT, f)}`);
    }
  }
  hits.sort();
  for (const h of hits.slice(0, 20)) console.log(h);
  if (hits.length > 20) console.log(`... and ${hits.length - 20} more`);
  const verb = DRY ? '[dry-run] would update' : 'updated';
  console.log(`\nnav-unify: ${verb} ${touched} files, ${total} navs.`);
}

main();
