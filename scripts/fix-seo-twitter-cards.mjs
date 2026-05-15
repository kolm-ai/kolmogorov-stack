#!/usr/bin/env node
/**
 * Ensure every public HTML page has a complete Twitter card + og:url.
 * If twitter:title/description/image are missing, derive them from og:* and inject
 * immediately after the og:image meta tag. If og:url is missing, derive from canonical.
 *
 * Idempotent. Skips already-complete pages and gated app pages.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const SKIP_BASENAMES = new Set([
  'dashboard.html', 'account.html', 'captures.html', 'compile.html',
  'audit-log.html', 'playground.html', 'teams.html', 'teams-accept.html',
  'tunnels.html', 'byoc.html', 'airgap.html', '404.html', 'signup.html', 'signin.html',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (extname(entry) === '.html') out.push(p);
  }
  return out;
}

function getMeta(html, attr, val) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${val}["'][^>]*>`, 'i');
  return html.match(re)?.[0] || null;
}

function metaContent(metaTag) {
  return metaTag?.match(/content=["']([^"']+)["']/i)?.[1] || null;
}

function canonical(html) {
  return html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] || null;
}

let touched = 0, skipped = 0, noOg = 0;
const files = walk(ROOT);
for (const file of files) {
  const base = file.split(/[\\/]/).pop();
  if (SKIP_BASENAMES.has(base)) { skipped++; continue; }

  let html = readFileSync(file, 'utf8');
  const ogTitle = getMeta(html, 'property', 'og:title');
  const ogDesc = getMeta(html, 'property', 'og:description');
  const ogImage = getMeta(html, 'property', 'og:image');
  if (!ogTitle || !ogDesc || !ogImage) { noOg++; continue; }

  const ogTitleVal = metaContent(ogTitle);
  const ogDescVal = metaContent(ogDesc);
  const ogImageVal = metaContent(ogImage);
  const canon = canonical(html);

  const inserts = [];

  const ogUrl = getMeta(html, 'property', 'og:url');
  if (!ogUrl && canon) {
    inserts.push(`<meta property="og:url" content="${canon}">`);
  }

  const twTitle = getMeta(html, 'name', 'twitter:title');
  if (!twTitle) inserts.push(`<meta name="twitter:title" content="${ogTitleVal}">`);

  const twDesc = getMeta(html, 'name', 'twitter:description');
  if (!twDesc) inserts.push(`<meta name="twitter:description" content="${ogDescVal}">`);

  const twImage = getMeta(html, 'name', 'twitter:image');
  if (!twImage) inserts.push(`<meta name="twitter:image" content="${ogImageVal}">`);

  const twCard = getMeta(html, 'name', 'twitter:card');
  if (!twCard) inserts.push(`<meta name="twitter:card" content="summary_large_image">`);

  if (inserts.length === 0) { skipped++; continue; }

  const block = inserts.join('\n');
  const after = html.replace(ogImage, ogImage + '\n' + block);
  if (after === html) { skipped++; continue; }
  writeFileSync(file, after);
  touched++;
  console.log(`  + ${relative(ROOT, file)} (${inserts.length} tag${inserts.length === 1 ? '' : 's'})`);
}
console.log(`seo-twitter: touched=${touched} skipped=${skipped} no-og=${noOg} total=${files.length}`);
