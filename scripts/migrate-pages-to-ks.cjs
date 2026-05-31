#!/usr/bin/env node
// Migrates every legacy public/*.html (and subdir) to ks.css chrome:
//  - adds /ks.css link (last stylesheet, wins via order)
//  - adds class="ks" to <body>
//  - replaces the existing top-of-page nav/header with the unified ks-nav
//  - replaces the bottom footer with the unified ks-footer
//
// Idempotent: if a page already has /ks.css AND ks-nav-wrap, it is left alone.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');
const KOLM_GITHUB_URL = process.env.KOLM_GITHUB_URL || 'https://github.com/kolm-ai/kolm';

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

const ksNavBlock = `
<div class="ks-nav-wrap">
  <nav class="ks-nav" aria-label="Primary">
    <a href="/" class="ks-nav__brand"><span class="ks-nav__mark">k</span><span>kolm<b>.ai</b></span></a>
    <ul class="ks-nav__list">
      <li><a href="/product">Product</a></li>
      <li><a href="/solutions/teams">For teams</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="/docs">Docs</a></li>
      <li><a href="${KOLM_GITHUB_URL}" rel="noopener">GitHub</a></li>
    </ul>
    <div class="ks-nav__right">
      <a href="/signup?intent=login" class="ks-nav__signin">Sign in</a>
      <a href="/signup" class="ks-btn ks-btn--primary ks-btn--sm">Get started <span class="ks-btn-arrow">&rarr;</span></a>
      <button class="ks-nav__toggle" id="navToggle" aria-label="Open menu" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
    </div>
  </nav>
  <div class="ks-nav__sheet" id="navSheet">
    <a href="/product">Product</a><a href="/solutions/teams">For teams</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="${KOLM_GITHUB_URL}" rel="noopener">GitHub</a><a href="/signup?intent=login">Sign in</a><a href="/signup">Get started &rarr;</a>
  </div>
</div>
`;

const ksFooterBlock = `
<footer class="ks-footer">
  <div class="ks-wrap">
    <div class="ks-footer__grid">
      <div>
        <a href="/" class="ks-nav__brand"><span class="ks-nav__mark">k</span><span>kolm<b>.ai</b></span></a>
        <p class="ks-footer__tagline">Compile any AI model. Run it anywhere.</p>
      </div>
      <div>
        <h4>Product</h4>
        <ul><li><a href="/wrapper">Overview</a></li><li><a href="/capture">Capture</a></li><li><a href="/security">Security &amp; receipts</a></li><li><a href="/integrations">Integrations</a></li><li><a href="/docs/api">API reference</a></li></ul>
      </div>
      <div>
        <h4>Build</h4>
        <ul><li><a href="/studio">Overview</a></li><li><a href="/distill">Distill</a></li><li><a href="/compile">Compile</a></li><li><a href="/k-score">k-score</a></li><li><a href="/models">Models</a></li></ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul><li><a href="/pricing">Pricing</a></li><li><a href="/docs">Docs</a></li><li><a href="/manifesto">Manifesto</a></li><li><a href="/changelog">Changelog</a></li><li><a href="${KOLM_GITHUB_URL}" rel="noopener">GitHub</a></li></ul>
      </div>
    </div>
    <div class="ks-footer__bottom">
      <span>&copy; 2026 kolm.ai &middot; Apache-2.0 &middot; <a href="/legal">Legal</a> &middot; <a href="/security">Security</a></span>
    </div>
  </div>
</footer>
`;

let migrated = 0, alreadyOk = 0, skipped = 0, redirect = 0;
const skipPages = new Set([
  '404.html', // already ks
]);

function isRedirectStub(html) {
  // tiny meta-refresh redirect pages: leave alone.
  return /<meta\s+http-equiv="refresh"\s+content="0;/i.test(html) && html.length < 2500;
}

function addKsCssLink(html) {
  if (html.includes('href="/ks.css"')) return html;
  // append a ks.css link right before </head>
  const idx = html.search(/<\/head>/i);
  if (idx === -1) return html;
  const insert = '<link rel="stylesheet" href="/ks.css">\n';
  return html.slice(0, idx) + insert + html.slice(idx);
}

function addBodyKsClass(html) {
  if (/<body[^>]*\bclass="[^"]*\bks\b[^"]*"/.test(html)) return html;
  // body with existing class
  let out = html.replace(/<body([^>]*?)\sclass="([^"]*)"([^>]*)>/i, (_, a, c, b) => `<body${a} class="${c} ks"${b}>`);
  if (out !== html) return out;
  // body without class
  return html.replace(/<body([^>]*)>/i, '<body$1 class="ks">');
}

function stripLegacyNav(html) {
  let out = html;
  // Common legacy header patterns we want to strip:
  const patterns = [
    /<header[^>]*class="[^"]*site[^"]*"[\s\S]*?<\/header>/gi,
    /<header[^>]*class="[^"]*site-header[^"]*"[\s\S]*?<\/header>/gi,
    /<header[^>]*class="[^"]*main-header[^"]*"[\s\S]*?<\/header>/gi,
    /<header[^>]*class="[^"]*top-bar[^"]*"[\s\S]*?<\/header>/gi,
    /<header[^>]*id="site-header"[\s\S]*?<\/header>/gi,
    /<header[^>]*data-component="site-header"[\s\S]*?<\/header>/gi,
    /<nav[^>]*class="[^"]*top-nav[^"]*"[\s\S]*?<\/nav>/gi,
    /<nav[^>]*class="[^"]*main-nav[^"]*"[\s\S]*?<\/nav>/gi,
    /<nav[^>]*id="primary-nav"[\s\S]*?<\/nav>/gi,
  ];
  for (const p of patterns) out = out.replace(p, '');
  return out;
}

function stripLegacyFooter(html) {
  let out = html;
  const patterns = [
    /<footer[^>]*class="[^"]*site-footer[^"]*"[\s\S]*?<\/footer>/gi,
    /<footer[^>]*class="[^"]*footer[^"]*"[\s\S]*?<\/footer>/gi,
    /<footer[^>]*class="[^"]*site[^"]*"[\s\S]*?<\/footer>/gi,
    /<footer[^>]*id="site-footer"[\s\S]*?<\/footer>/gi,
  ];
  for (const p of patterns) out = out.replace(p, '');
  return out;
}

function injectKsNavAfterBody(html) {
  if (html.includes('ks-nav-wrap')) return html;
  return html.replace(/(<body[^>]*>)/i, `$1\n<a href="#main" class="ks-skip">Skip to content</a>\n${ksNavBlock}`);
}

function injectKsFooterBeforeBodyClose(html) {
  if (html.includes('ks-footer')) return html;
  return html.replace(/<\/body>/i, `${ksFooterBlock}\n</body>`);
}

const files = walk(root);
for (const f of files) {
  const rel = path.relative(root, f);
  const baseName = path.basename(f);
  if (skipPages.has(baseName)) { skipped++; continue; }

  let html = fs.readFileSync(f, 'utf8');
  if (isRedirectStub(html)) { redirect++; continue; }

  const hadKs = html.includes('href="/ks.css"');
  const hadKsNav = html.includes('ks-nav-wrap');
  const hadKsFooter = html.includes('ks-footer');

  let next = html;
  next = addKsCssLink(next);
  next = addBodyKsClass(next);
  if (!hadKsNav) {
    next = stripLegacyNav(next);
    next = injectKsNavAfterBody(next);
  }
  if (!hadKsFooter) {
    next = stripLegacyFooter(next);
    next = injectKsFooterBeforeBodyClose(next);
  }

  if (next !== html) {
    fs.writeFileSync(f, next);
    migrated++;
    if (migrated <= 30) process.stdout.write(`  migrated: ${rel}\n`);
  } else {
    alreadyOk++;
  }
}

console.log(`\nmigrate-pages-to-ks: migrated=${migrated} alreadyOk=${alreadyOk} skipped=${skipped} redirect-stubs=${redirect} total=${files.length}`);
