// W221 (extended by W399) — single source of truth for the site nav.
//
// Idempotent: writes the canonical block between HTML-comment delimiters so
// re-runs are safe. The marker tag stays "(W221)" so the wave221 test still
// finds the block; W399 expands the BODY of the block to add per-top-item
// mega-menus while keeping exactly five TOP-LEVEL labels in canonical order:
//
//     Product · Models · Docs · Pricing · Enterprise
//
// Each top label is an <a class="nav-top">; below it sits a <div class="mega-menu">
// with grouped columns of deep links. The desktop CSS opens the mega-menu on
// :hover and :focus-within; the mobile CSS stacks everything inline inside the
// hamburger panel. ALL paths point at pages that exist in public/ (verified).
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
  { href: '/product',    label: 'Product',    slug: 'product' },
  { href: '/models',     label: 'Models',     slug: 'models' },
  { href: '/docs',       label: 'Docs',       slug: 'docs' },
  { href: '/pricing',    label: 'Pricing',    slug: 'pricing' },
  { href: '/enterprise', label: 'Enterprise', slug: 'enterprise' },
];

// Per-top-item mega-menu structure. Columns appear left-to-right; links inside
// each column appear top-to-bottom. Anchors are confined to pages that exist.
const MEGA = {
  product: [
    { heading: 'Get started', links: [
      { href: '/product',                  label: 'Product overview' },
      { href: '/what-is-an-ai-compiler',   label: 'What is an AI compiler?' },
      { href: '/quickstart',               label: 'Quickstart' },
      { href: '/tui',                      label: 'Terminal UI' },
      { href: '/foundations',              label: 'Foundations' },
    ]},
    { heading: 'Why kolm', links: [
      { href: '/drift',                    label: 'Drift report' },
      { href: '/k-score',                  label: 'K-Score explained' },
      { href: '/kscore-leaderboard',       label: 'Leaderboard' },
      { href: '/how-vs-diy',               label: 'vs DIY' },
      { href: '/how-vs-hyperscaler',       label: 'vs Hyperscaler' },
      { href: '/how-vs-openpipe',          label: 'vs OpenPipe' },
      { href: '/how-vs-predibase',         label: 'vs Predibase' },
      { href: '/how-vs-lorax',             label: 'vs LoRAX' },
    ]},
    { heading: 'Use cases', links: [
      { href: '/use-cases',                label: 'All use cases' },
      { href: '/healthcare',               label: 'Healthcare (PHI)' },
      { href: '/legal',                    label: 'Legal (privilege)' },
      { href: '/finance',                  label: 'Finance (SR 11-7)' },
      { href: '/defense',                  label: 'Defense (air-gap)' },
    ]},
    { heading: 'Reference', links: [
      { href: '/integrations',             label: 'Integrations' },
      { href: '/marketplace',              label: 'Marketplace' },
      { href: '/docs/cookbook',            label: 'Cookbook' },
      { href: '/articles',                 label: 'Articles' },
      { href: '/press',                    label: 'Press' },
      { href: '/whitepaper',               label: 'Whitepaper' },
    ]},
  ],
  models: [
    { heading: 'Catalog', links: [
      { href: '/models',                   label: 'Frontier catalog' },
      { href: '/runtimes',                 label: 'Runtimes' },
      { href: '/docs/devices',             label: 'Supported devices' },
    ]},
    { heading: 'Hardware', links: [
      { href: '/models#frontier',          label: 'Hardware tiers' },
      { href: '/runtimes',                 label: 'Source-built llama.cpp' },
    ]},
    { heading: 'Inference', links: [
      { href: '/docs/runtime',             label: 'Runtime guide' },
      { href: '/docs/distill',             label: 'Distillation' },
      { href: '/docs/optimizer',           label: 'Optimizer' },
      { href: '/docs/evals',               label: 'Evals' },
    ]},
  ],
  docs: [
    { heading: 'Quickstarts', links: [
      { href: '/quickstart',               label: 'Overview' },
      { href: '/quickstart/cli',           label: 'CLI quickstart' },
      { href: '/quickstart/api',           label: 'API quickstart' },
      { href: '/quickstart/sdk',           label: 'SDK quickstart' },
      { href: '/quickstart/embed',         label: 'Embed quickstart' },
      { href: '/quickstart/nl',            label: 'Natural language' },
    ]},
    { heading: 'Reference', links: [
      { href: '/docs/api',                 label: 'API reference' },
      { href: '/docs/cli',                 label: 'CLI reference' },
      { href: '/docs/connectors',          label: 'Connectors' },
      { href: '/docs/rs-1',                label: 'Receipts spec (RS-1)' },
    ]},
    { heading: 'Concepts', links: [
      { href: '/docs/distill',             label: 'Distillation' },
      { href: '/docs/runtime',             label: 'Runtime' },
      { href: '/docs/evals',               label: 'Evals' },
      { href: '/docs/privacy',             label: 'Privacy membrane' },
      { href: '/docs/storage',             label: 'Storage' },
      { href: '/docs/datasets',            label: 'Datasets' },
    ]},
    { heading: 'Help', links: [
      { href: '/docs',                     label: 'Docs home' },
      { href: '/faq',                      label: 'FAQ' },
      { href: '/changelog',                label: 'Changelog' },
      { href: '/research',                 label: 'Research' },
      { href: '/training',                 label: 'Training' },
    ]},
  ],
  pricing: [
    { heading: 'Pricing', links: [
      { href: '/pricing',                  label: 'Plans' },
      { href: '/pricing#roi',              label: 'ROI calculator' },
      { href: '/baa',                      label: 'BAA / SLA' },
      { href: '/enterprise',               label: 'Enterprise' },
    ]},
  ],
  enterprise: [
    { heading: 'Solutions', links: [
      { href: '/enterprise',               label: 'Enterprise overview' },
      { href: '/healthcare',               label: 'Healthcare' },
      { href: '/legal',                    label: 'Legal' },
      { href: '/finance',                  label: 'Finance' },
      { href: '/defense',                  label: 'Defense' },
    ]},
    { heading: 'Deployment', links: [
      { href: '/byoc',                     label: 'BYOC' },
      { href: '/airgap',                   label: 'Air-gap' },
      { href: '/tunnels',                  label: 'Tunnels' },
      { href: '/self-host',                label: 'Self-host' },
    ]},
    { heading: 'Trust', links: [
      { href: '/trust',                    label: 'Trust center' },
      { href: '/security',                 label: 'Security' },
      { href: '/compliance',               label: 'Compliance' },
      { href: '/compliance-packs',         label: 'Compliance packs' },
      { href: '/soc2',                     label: 'SOC 2' },
      { href: '/hipaa-mapping',            label: 'HIPAA mapping' },
      { href: '/slsa',                     label: 'SLSA' },
      { href: '/sbom',                     label: 'SBOM' },
      { href: '/subprocessors',            label: 'Subprocessors' },
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
      missing++;
      continue;
    }
    skipped++;
  }
}

walk(ROOT);
console.log(`nav inject (W221): ${touched} touched, ${already} idempotent-noop, ${missing} have site-header but no site-nav, ${skipped} legacy (no site-header).`);
