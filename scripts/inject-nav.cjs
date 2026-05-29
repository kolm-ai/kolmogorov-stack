// W221 (extended by W399) — single source of truth for the site nav.
//
// Idempotent: writes the canonical block between HTML-comment delimiters so
// re-runs are safe. The marker tag stays "(W221)" so the wave221 test still
// finds the block; W399 expands the BODY of the block to add per-top-item
// mega-menus while keeping exactly five TOP-LEVEL labels in canonical order:
//
//     Product · Models · Docs · Pricing · Enterprise
//
// Each top label is an <a class="nav-top"> so W221 static invariants can
// identify the five top-level anchors even when the mega-menu contains deep
// links. Below each anchor sits a <div class="mega-menu"> with grouped columns
// of deep links. The desktop CSS opens the mega-menu on :hover and
// :focus-within; the mobile CSS stacks everything inline inside the hamburger
// panel. ALL paths point at pages that exist in public/ (verified).
//
// Run: node scripts/inject-nav.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SKIP_DIRS = new Set(['_archive', '_generations']);
const BEGIN = '<!-- KOLM_NAV_BEGIN (W221) -->';
const END = '<!-- KOLM_NAV_END (W221) -->';

// Five top-level items. Order is the W221 #1 + #3 contract. Slug is used for
// nav-item--<slug> classnames so CSS can size individual menus.
const NAV_ITEMS = [
  { href: '/about',      label: 'Product',    slug: 'product' },
  { href: '/models',     label: 'Models',     slug: 'models' },
  { href: '/docs',       label: 'Docs',       slug: 'docs' },
  { href: '/pricing',    label: 'Pricing',    slug: 'pricing' },
  { href: '/enterprise', label: 'Enterprise', slug: 'enterprise' },
];

// Per-top-item mega-menu structure. Columns appear left-to-right; links inside
// each column appear top-to-bottom. Anchors are confined to pages that exist.
const MEGA = {
  product: [
    { heading: 'Start', links: [
      { href: '/about',                    label: 'Overview' },
      { href: '/quickstart',               label: 'Quickstart' },
      { href: '/capture',                  label: 'Gateway' },
    ]},
    { heading: 'Build', links: [
      { href: '/training',                 label: 'Training loop' },
      { href: '/distill',                  label: 'Distill' },
      { href: '/compile',                  label: 'Compile' },
    ]},
    { heading: 'Run', links: [
      { href: '/runtimes',                 label: 'Runtimes' },
      { href: '/docs/devices',             label: 'Devices' },
      { href: '/trust',                    label: 'Verify' },
    ]},
  ],
  models: [
    { heading: 'Choose', links: [
      { href: '/models',                   label: 'Model catalog' },
      { href: '/build-your-own',           label: 'Build your own' },
      { href: '/docs/runtime',             label: 'Runtime targets' },
    ]},
    { heading: 'Deploy', links: [
      { href: '/compute',                  label: 'Compute' },
      { href: '/runtimes',                 label: 'Mobile and edge' },
    ]},
  ],
  docs: [
    { heading: 'Start', links: [
      { href: '/capture',                  label: 'API gateway' },
      { href: '/docs/cli',                 label: 'CLI' },
      { href: '/docs/sdk',                 label: 'SDKs' },
    ]},
    { heading: 'Reference', links: [
      { href: '/docs',                     label: 'Docs home' },
      { href: '/docs/api',                 label: 'API reference' },
      { href: '/api',                      label: 'HTTP routes' },
    ]},
    { heading: 'Operate', links: [
      { href: '/integrations',             label: 'Integrations' },
      { href: '/docs/privacy',             label: 'Privacy membrane' },
      { href: '/docs/datasets',            label: 'Datasets' },
      { href: '/docs/distillation',        label: 'Distillation' },
      { href: '/docs/verify',              label: 'Verification' },
    ]},
  ],
  pricing: [
    { heading: 'Buy', links: [
      { href: '/pricing',                  label: 'Plans' },
      { href: '/pricing#roi',              label: 'ROI calculator' },
      { href: '/nonprofits',               label: 'Nonprofits' },
    ]},
  ],
  enterprise: [
    { heading: 'Deploy', links: [
      { href: '/enterprise',               label: 'Enterprise overview' },
      { href: '/self-host',                label: 'Self-host' },
      { href: '/airgap',                   label: 'Air-gap' },
    ]},
    { heading: 'Trust', links: [
      { href: '/trust',                    label: 'Trust center' },
      { href: '/security',                 label: 'Security' },
      { href: '/compliance',               label: 'Compliance' },
      { href: '/baa',                      label: 'BAA' },
    ]},
  ],
};

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function renderMega(slug) {
  const cols = MEGA[slug] || [];
  if (!cols.length) return '';
  const colHtml = cols.map(col => {
    const linkHtml = col.links.map(l =>
      `          <a href="${escAttr(l.href)}">${escText(l.label)}</a>`
    ).join('\n');
    return [
      '        <div class="mega-col">',
      `          <p class="mega-h">${escText(col.heading)}</p>`,
      linkHtml,
      '        </div>',
    ].join('\n');
  }).join('\n');
  return [
    `      <div class="mega-menu" role="menu" aria-label="${escAttr(slug)} menu">`,
    colHtml,
    '      </div>',
  ].join('\n');
}

function canonicalBlock() {
  const items = NAV_ITEMS.map(it => {
    const has = (MEGA[it.slug] || []).length > 0;
    const wrapClass = has ? `nav-item nav-item--${it.slug} has-mega` : `nav-item nav-item--${it.slug}`;
    const ariaPop = has ? ' aria-haspopup="true" aria-expanded="false"' : '';
    const top = `      <a class="nav-top" href="${it.href}"${ariaPop}>${escText(it.label)}</a>`;
    const mega = has ? '\n' + renderMega(it.slug) : '';
    return [
      `    <div class="${wrapClass}">`,
      top + mega,
      '    </div>',
    ].join('\n');
  }).join('\n');
  return [
    `    ${BEGIN}`,
    '    <nav class="site-nav" aria-label="Primary">',
    items,
    '    </nav>',
    `    ${END}`,
  ].join('\n');
}

// Match either:
//   (a) a previously-injected block delimited by BEGIN/END
//   (b) the legacy `<nav class="site-nav"...>...</nav>` block (one-shot upgrade)
const LEGACY_RE = /(?:[ \t]*)<nav class="site-nav"[^>]*>[\s\S]*?<\/nav>(?:\s*<!--[^>]*-->)?/;
const MARKED_RE = new RegExp(
  '(?:[ \\t]*)' +
  BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
  '[\\s\\S]*?' +
  END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
);

let touched = 0, already = 0, skipped = 0, missing = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.html')) continue;
    let s;
    try { s = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const block = canonicalBlock();
    if (MARKED_RE.test(s)) {
      const replaced = s.replace(MARKED_RE, block);
      if (replaced === s) { already++; continue; }
      fs.writeFileSync(full, replaced);
      touched++;
      continue;
    }
    if (LEGACY_RE.test(s)) {
      const replaced = s.replace(LEGACY_RE, block);
      fs.writeFileSync(full, replaced);
      touched++;
      continue;
    }
    if (/<header[^>]*class="site-header/.test(s)) {
      const headerInsert = /(<header[^>]*class="[^"]*\bsite-header\b[^"]*"[^>]*>\s*<div[^>]*class="[^"]*\bwrap\b[^"]*"[^>]*>[\s\S]*?<a[^>]*class="[^"]*(?:\bbrand\b|\blogo\b|\bkolm-mark\b)[^"]*"[\s\S]*?<\/a>)/;
      if (headerInsert.test(s)) {
        const replaced = s.replace(headerInsert, `$1\n${block}`);
        fs.writeFileSync(full, replaced);
        touched++;
        continue;
      }
      missing++;
      continue;
    }
    skipped++;
  }
}

function main() {
  walk(ROOT);
  console.log(`nav inject (W221): ${touched} touched, ${already} idempotent-noop, ${missing} have site-header but no site-nav, ${skipped} legacy (no site-header).`);
}

module.exports = { canonicalBlock, BEGIN, END };

if (require.main === module) main();
